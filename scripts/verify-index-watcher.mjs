import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const support = join(homedir(), 'Library', 'Application Support', 'FormaOffice');
const binary = process.env.FORMA_INDEXER_BIN || join(support, 'bin', 'forma-indexer');
const scratch = await mkdtemp(join(tmpdir(), 'forma-watch-check-'));
const state = join(scratch, 'index');
const rootA = join(scratch, 'First Folder');
const rootB = join(scratch, 'Second Folder');
const late = join(rootB, 'Later Folder');
const server = createServer();
await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const env = {
  ...process.env, FORMA_INDEX_SUPPORT_DIR: state, FORMA_INDEX_EMBED_PORT: String(port),
  OLLAMA_HOST: 'http://127.0.0.1:1',
};
const execute = promisify(execFile);
const messages = [];
let watcher;
let exited;

async function run(...args) {
  const { stdout } = await execute(binary, [...args, '--json'], { env });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true, stdout);
  return result;
}

async function until(probe, description) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const result = await probe();
    if (result) return result;
    if (watcher && watcher.exitCode !== null) break;
    await delay(100);
  }
  assert.fail(`Timed out waiting for ${description}. Recent watcher messages ${JSON.stringify(messages.slice(-5))}`);
}

function startWatcher() {
  watcher = spawn(binary, ['watch', '--json'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  createInterface({ input: watcher.stdout }).on('line', line => messages.push(JSON.parse(line)));
  exited = new Promise(resolve => watcher.once('close', (code, signal) => resolve({ code, signal })));
}

async function stopWatcher() {
  if (!watcher) return;
  watcher.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 0, signal: null });
  watcher = undefined;
}

function query(statement) {
  return execFileSync('/usr/bin/sqlite3', ['-readonly', '-cmd', '.timeout 2000', '-json',
    join(state, 'semantic_index.sqlite'), statement], { encoding: 'utf8' }).trim();
}

function indexed() {
  return JSON.parse(query("SELECT title, path, updated_at FROM docs WHERE source='folder' ORDER BY rowid;") || '[]');
}

function hasText(word) {
  return query(`SELECT text FROM chunk_search WHERE chunk_search MATCH '${word}';`).length > 0;
}

async function fixture(directory, name, text, mtime) {
  const path = join(directory, name);
  await writeFile(path, text);
  if (mtime) await utimes(path, mtime, mtime);
  return path;
}

try {
  await mkdir(rootA);
  await mkdir(late, { recursive: true });
  const initial = await run('folders', 'list');
  for (const path of initial.watchedFolders) await run('folders', 'remove', path);
  await run('folders', 'add', rootA);
  await run('folders', 'add', rootB);

  const recent = await fixture(rootA, 'recent-a.md', 'Initial embercheck title', 1_701_000_000);
  await fixture(rootB, 'recent-b.md', 'A second folder entry', 1_701_000_000);
  for (let i = 0; i < 32; i++) {
    await fixture(rootA, `older-${i}.md`, `Archive entry ${i} with a distinct number`, 1_700_000_000 - i);
  }
  startWatcher();
  await until(() => messages.some(result => result.watching), 'FSEvents stream');
  await until(() => indexed().length >= 2, 'first two indexed files');
  assert.deepEqual(indexed().slice(0, 2).map(row => row.title), ['recent-a.md', 'recent-b.md']);

  // Register a third folder while there is still work in the original first pass.
  const separate = join(scratch, 'Added While Syncing');
  await mkdir(separate);
  await fixture(separate, 'arrived.md', 'New folder arrived');
  await run('folders', 'add', separate);
  await until(() => indexed().some(row => row.title === 'arrived.md'), 'new root with active initial sync');
  const titles = indexed().map(row => row.title);
  const lastOld = titles.indexOf('older-31.md');
  assert.ok(lastOld === -1 || titles.indexOf('arrived.md') < lastOld, 'New folder waited for the archive backlog');
  const completed = await until(() => messages.find(result => result.mode === 'full' && result.lastFullSyncAt), 'completed initial scan');
  assert.equal(completed.backend, 'forma-embedded');
  assert.ok(messages.some(result => result.interrupted));
  const untouched = indexed().find(row => row.title === 'recent-b.md');
  console.log('Recent files across both roots indexed first, and a folder added mid-scan joined the queue');

  const pendingSave = await fixture(rootA, '.saving', 'An atomic edit with updatedwatchword');
  await rename(pendingSave, recent);
  await until(() => hasText('updatedwatchword'), 'edited file text');
  assert.equal(hasText('embercheck'), false);
  assert.deepEqual(indexed().find(row => row.title === untouched.title), untouched);
  assert.equal((await run('status')).lastFullSyncAt, completed.lastFullSyncAt);
  await until(() => messages.some(result => result.mode === 'changes' && result.indexedCount === 1 && result.totalScanned === 1),
    'a single file change in the indexer summary');

  // The FSEvents watcher must index agent-authored HTML regardless of the
  // system's preferred application for opening web pages or HTML files.
  const htmlPath = await fixture(rootA, 'agent-created.html', '<!doctype html><title>Agent HTML</title><h1>Agent document</h1><p>freshhtmlcanary</p>');
  await until(() => indexed().some(row => row.path.endsWith('/First Folder/agent-created.html')) && hasText('freshhtmlcanary'), 'new agent-created HTML file');
  await writeFile(htmlPath, '<!doctype html><title>Agent HTML</title><h1>Agent document</h1><p>revisedhtmlcanary</p>');
  await until(() => hasText('revisedhtmlcanary') && !hasText('freshhtmlcanary'), 'updated agent-created HTML file');
  console.log('Agent-created HTML indexed and updated without opening the file in Forma');

  const oldTree = join(rootA, 'Incoming');
  const newTree = join(rootA, 'Renamed');
  await mkdir(oldTree);
  await fixture(oldTree, 'inside.md', 'Subtree rename fixture');
  await until(() => indexed().some(row => row.path.endsWith('/Incoming/inside.md')), 'created subtree');
  await rename(oldTree, newTree);
  await until(() => indexed().some(row => row.path.endsWith('/Renamed/inside.md'))
    && !indexed().some(row => row.path.endsWith('/Incoming/inside.md')), 'renamed subtree and removed old paths');
  await rm(newTree, { recursive: true });
  await until(() => !indexed().some(row => row.title === 'inside.md'), 'deleted subtree');
  console.log('Atomic save, directory creation, rename and deletion updated the index without a full scan');

  // A nested root may keep its files when its independently watched parent is removed.
  await run('folders', 'add', late);
  await fixture(late, 'nested.md', 'Nested retained fixture');
  await until(() => indexed().some(row => row.title === 'nested.md'), 'nested watched folder');
  const hidden = join(late, '.hidden');
  const ignored = join(late, 'node_modules');
  await mkdir(hidden);
  await mkdir(ignored);
  await fixture(hidden, 'hidden.md', 'A hidden file excluded from indexing');
  await fixture(ignored, 'ignored.md', 'An ignored file excluded from indexing');
  await symlink(rootA, join(late, 'unwatched-alias'));
  const beforeRemoval = (await run('status')).lastFullSyncAt;
  await run('folders', 'remove', rootB);
  const afterRemoval = await until(() => messages.findLast(result => result.mode === 'full' && result.lastFullSyncAt > beforeRemoval),
    'reconciliation after removing a root');
  assert.ok((await run('request-sync')).queued);
  await until(() => messages.some(result => result.mode === 'full' && result.lastFullSyncAt > afterRemoval.lastFullSyncAt),
    'scheduled reconciliation request');
  assert.ok(indexed().some(row => row.title === 'nested.md'));
  assert.ok(!indexed().some(row => ['recent-b.md', 'hidden.md', 'ignored.md'].includes(row.title)
    || row.path.includes('/unwatched-alias/')));
  console.log('Removing a parent preserved the nested root and reconciliation excluded hidden paths, ignored folders and symlinks');

  await stopWatcher();
  await rm(recent);
  await fixture(late, 'offline.md', 'Offline catch up canary');
  await run('request-sync');
  startWatcher();
  await until(() => indexed().some(row => row.title === 'offline.md')
    && !indexed().some(row => row.title === 'recent-a.md'), 'offline changes recovered on startup');
  console.log('Startup reconciliation caught a file created and a file deleted while the watcher was offline');
} finally {
  try { await stopWatcher(); }
  finally { await rm(scratch, { recursive: true, force: true }); }
}
