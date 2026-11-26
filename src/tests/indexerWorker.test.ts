/** @vitest-environment node */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
// @ts-expect-error The worker is a JavaScript module used directly by the MCP server.
import { IndexerWorker } from '../../mcp/forma-mcp/indexerWorker.mjs';

let scratch = '';
let worker: InstanceType<typeof IndexerWorker> | undefined;
afterEach(async () => {
  worker?.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  if (scratch) await rm(scratch, { recursive: true, force: true });
  delete process.env.FORMA_TEST_WORKER_LOG;
});

it('times out a stuck worker, resolves siblings and starts a fresh worker', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'forma-timeout-'));
  const binary = join(scratch, 'indexer');
  const log = join(scratch, 'requests');
  process.env.FORMA_TEST_WORKER_LOG = log;
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs'), readline = require('node:readline'), {spawn} = require('node:child_process');
console.log(JSON.stringify({ok:true,mode:'serve',protocol:1}));
readline.createInterface({input:process.stdin}).on('line', line => {
 const {id,args}=JSON.parse(line); fs.appendFileSync(process.env.FORMA_TEST_WORKER_LOG,args[0]+'\\n');
 if (args[0] === 'search') { const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'}); fs.appendFileSync(process.env.FORMA_TEST_WORKER_LOG, 'model '+child.pid+'\\n'); }
 if (args[0] === 'status') console.log(JSON.stringify({id,payload:{ok:true,pid:process.pid}}));
});
`);
  await chmod(binary, 0o755);
  worker = new IndexerWorker(binary, { timeouts: { search: 250, read: 1000, status: 1000 } });
  const old = await worker.request(['status']);
  const hung = worker.request(['search']);
  const sibling = worker.request(['read']);
  const [timedOut, interrupted] = await Promise.all([hung, sibling]);
  expect(timedOut).toMatchObject({ ok: false, error: 'Forma request timed out.' });
  expect(interrupted).toMatchObject({ ok: false, error: 'Forma indexer worker was reset.' });
  expect((await readFile(log, 'utf8'))).toContain('search\n');
  const model = Number((await readFile(log, 'utf8')).match(/model (\d+)/)?.[1]);
  expect(Number.isInteger(model) && model > 0).toBe(true);
  for (let i = 0; i < 50; i++) {
    try { process.kill(model, 0); } catch { break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  expect(() => process.kill(model, 0)).toThrow();
  const restarted = await worker.request(['status']);
  expect(restarted.ok).toBe(true);
  expect(restarted.pid).not.toBe(old.pid);
});

it('aborts an already received request without disturbing another request', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'forma-abort-'));
  const binary = join(scratch, 'indexer');
  const log = join(scratch, 'requests');
  process.env.FORMA_TEST_WORKER_LOG = log;
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs'), readline = require('node:readline');
console.log(JSON.stringify({ok:true,mode:'serve',protocol:1}));
readline.createInterface({input:process.stdin}).on('line', line => {
 const {id,args}=JSON.parse(line); fs.appendFileSync(process.env.FORMA_TEST_WORKER_LOG,args[0]+'\\n');
 if (args[0] === 'status') console.log(JSON.stringify({id,payload:{ok:true,pid:process.pid}}));
});
`);
  await chmod(binary, 0o755);
  worker = new IndexerWorker(binary, { timeouts: { search: 2000, status: 2000 } });
  const original = await worker.request(['status']);
  const controller = new AbortController();
  const pending = worker.request(['search'], controller.signal);
  for (let i = 0; i < 40; i++) {
    if ((await readFile(log, 'utf8')).includes('search\n')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(await readFile(log, 'utf8')).toContain('search\n');
  controller.abort();
  expect(await pending).toMatchObject({ ok: false, error: 'Forma request cancelled.' });
  expect(await worker.request(['status'])).toMatchObject({ ok: true, pid: original.pid });
});

it('replaces a worker with a broken input pipe', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'forma-pipe-'));
  const binary = join(scratch, 'indexer');
  await writeFile(binary, `#!/usr/bin/env node
const readline = require('node:readline');
console.log(JSON.stringify({ok:true,mode:'serve',protocol:1}));
readline.createInterface({input:process.stdin}).on('line', line => {
 const {id}=JSON.parse(line); console.log(JSON.stringify({id,payload:{ok:true,pid:process.pid}}));
});
`);
  await chmod(binary, 0o755);
  worker = new IndexerWorker(binary, { timeouts: { status: 1000 } });
  const first = await worker.request(['status']);
  worker.child.stdin.destroy();
  const second = await worker.request(['status']);
  expect(second.ok).toBe(true);
  expect(second.pid).not.toBe(first.pid);
});
