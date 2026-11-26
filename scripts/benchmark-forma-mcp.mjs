import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Use a separate socket slot so the live index is read without borrowing or stopping the watcher's models.
const slot = String(42000 + Math.floor(Math.random() * 10000));
const env = { ...process.env, FORMA_INDEX_EMBED_PORT: slot, FORMA_INDEX_CACHE_TRACE: '1' };
const transport = new StdioClientTransport({ command: process.execPath, args: ['mcp/forma-mcp/index.mjs'], env, stderr: 'pipe' });
const client = new Client({ name: 'forma-live-benchmark', version: '1' });
let trace = '';
transport.stderr?.on('data', chunk => { trace += chunk; });
let workerPid;
let modelPids = [];
const modelSnapshots = [];
const query = process.env.FORMA_BENCH_QUERY || 'Gamma Distribution Explorer';
const expected = process.env.FORMA_BENCH_EXPECT || (query === 'Gamma Distribution Explorer' ? 'gamma_distribution_adtech_bid_shading_explorer.html' : '');
if (!expected) throw new Error('Set FORMA_BENCH_EXPECT to an expected result path or title when providing FORMA_BENCH_QUERY');
const onlyChild = parent => {
  const pids = execFileSync('/usr/bin/pgrep', ['-P', String(parent)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  if (pids.length !== 1 || !/^\d+$/.test(pids[0])) throw new Error(`Expected one worker PID, got ${JSON.stringify(pids)}`);
  return Number(pids[0]);
};
try {
  await client.connect(transport);
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    const response = await client.callTool({ name: 'forma_search', arguments: { query, limit: 5 } });
    if (!response.structuredContent?.ok) throw new Error(JSON.stringify(response));
    const hits = response.structuredContent.hits;
    if (!hits.some(h => `${h.path ?? ''} ${h.title ?? ''}`.toLowerCase().includes(expected.toLowerCase()))) throw new Error(`Expected result ${expected} not found: ${JSON.stringify(hits)}`);
    if (!hits.some(h => h.matchType === 'reranked')) throw new Error('Expected a reranked result');
    const currentWorker = onlyChild(transport.pid);
    workerPid = currentWorker;
    const currentModels = execFileSync('/usr/bin/pgrep', ['-P', String(currentWorker)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
    modelSnapshots.push(currentModels);
    console.log(JSON.stringify({ run: i + 1, elapsedMs: Math.round(performance.now() - start), hits: hits.length, matchTypes: [...new Set(hits.map(h => h.matchType))] }));
  }
  if (modelSnapshots[0].length < 2 || modelSnapshots.some(pids => pids.join(',') !== modelSnapshots[0].join(','))) throw new Error(`Model processes were not reused: ${JSON.stringify(modelSnapshots)}`);
  const concurrent = await Promise.all(Array.from({ length: 3 }, () => client.callTool({ name: 'forma_search', arguments: { query: 'research report', kind: 'pdf', limit: 3 } })));
  if (concurrent.some(response => !response.structuredContent?.ok)) throw new Error('Concurrent searches failed');
  workerPid = onlyChild(transport.pid);
  const builds = (trace.match(/forma-vector-cache build/g) ?? []).length;
  const hits = (trace.match(/forma-vector-cache hit/g) ?? []).length;
  if (builds !== 2 || hits < 4) throw new Error(`Unexpected cache trace: ${JSON.stringify(trace)}`);
  console.log(JSON.stringify({ check: 'matrix reused and concurrent cold misses coalesced', builds, hits }));
  try { modelPids = execFileSync('/usr/bin/pgrep', ['-P', String(workerPid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number); } catch { /* No owned model process. */ }
} finally {
  await client.close();
  const isAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  if (workerPid) {
    for (let i = 0; i < 60 && [workerPid, ...modelPids].some(isAlive); i++) await new Promise(resolve => setTimeout(resolve, 100));
    if (isAlive(workerPid)) throw new Error(`Worker ${workerPid} survived disconnect`);
    if (modelPids.some(isAlive)) throw new Error('An owned model process survived disconnect');
  }
  for (const dir of ['forma-embed', 'forma-rerank']) {
    const socket = `/private/tmp/${dir}-${process.getuid()}/${slot}.sock`;
    try { execFileSync('/usr/sbin/lsof', ['-t', socket], { stdio: 'pipe' }); throw new Error(`Socket still in use: ${socket}`); }
    catch (error) { if (error.status !== 1) throw error; }
  }
  console.log(JSON.stringify({ check: 'worker and model processes and sockets closed', workerPid, modelPids, slot }));
}
