import { spawn } from 'node:child_process';

const MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_TIMEOUTS = { search: 120_000, read: 120_000, status: 30_000, folders: 30_000, index: 1_800_000, sync: 1_800_000 };

export class IndexerWorker {
  constructor(binary, { timeouts = DEFAULT_TIMEOUTS } = {}) {
    this.binary = binary;
    this.child = null;
    this.starting = null;
    this.disabled = false;
    this.closing = false;
    this.pending = new Map();
    this.nextId = 0;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
  }

  async start() {
    if (this.disabled || this.closing) return false;
    if (this.starting) return this.starting;
    if (this.child) return true;
    this.starting = this.spawnWorker().finally(() => { this.starting = null; });
    return this.starting;
  }

  spawnWorker() {
    return new Promise(resolve => {
      // Give the worker and its model children their own process group so a crash
      // or forced shutdown cannot leave owned model servers behind.
      const child = spawn(this.binary, ['serve'], { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      this.child = child;
      let buffer = '';
      let ready = false;
      let settled = false;
      const handshake = setTimeout(() => failHandshake(), 2000);
      const settle = ok => {
        if (settled) return;
        settled = true;
        clearTimeout(handshake);
        resolve(ok);
      };
      const failHandshake = () => {
        this.disabled = true;
        if (this.child === child) this.child = null;
        child.kill();
        settle(false);
      };
      const failPending = () => {
        for (const [id, entry] of this.pending) {
          if (entry.child === child) {
            this.pending.delete(id);
            entry.finish({ ok: false, error: 'Forma indexer worker stopped.' });
          }
        }
      };
      child.on('error', () => { if (!ready) failHandshake(); else failPending(); });
      child.on('exit', () => {
        this.killGroup(child, 'SIGKILL');
        if (this.child === child) this.child = null;
        if (!ready) failHandshake();
        else failPending();
      });
      if (process.env.FORMA_INDEX_CACHE_TRACE === '1') child.stderr.pipe(process.stderr, { end: false });
      else child.stderr.resume();
      child.stdin.on('error', () => { /* exit handler resolves requests */ });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_BUFFER) {
          if (!ready) failHandshake();
          else { failPending(); child.kill(); }
          return;
        }
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          let message;
          try { message = JSON.parse(line); } catch { if (!ready) failHandshake(); else child.kill(); return; }
          if (!ready) {
            if (message?.ok !== true || message.mode !== 'serve' || message.protocol !== 1) { failHandshake(); return; }
            ready = true;
            settle(true);
          } else {
            const entry = this.pending.get(message?.id);
            if (entry && entry.child === child) {
              this.pending.delete(message.id);
              entry.finish(message.payload && typeof message.payload.ok === 'boolean' ? message.payload : { ok: false, error: 'Invalid forma-indexer response.' });
            }
          }
        }
      });
    });
  }

  killGroup(child, signal) {
    if (!child.pid) return;
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); } catch { /* already exited */ }
  }

  reset(child, timedOutId) {
    if (this.child === child) this.child = null;
    for (const [id, entry] of this.pending) {
      if (entry.child !== child) continue;
      this.pending.delete(id);
      entry.finish({ ok: false, error: id === timedOutId ? 'Forma request timed out.' : 'Forma indexer worker was reset.' });
    }
    if (child.exitCode === null) child.kill('SIGTERM');
    const kill = setTimeout(() => this.killGroup(child, 'SIGKILL'), 2000);
    kill.unref();
    child.once('exit', () => clearTimeout(kill));
  }

  async request(args, signal) {
    if (signal?.aborted) return { ok: false, error: 'Forma request cancelled.' };
    let abortStart;
    const cancelled = new Promise(resolve => {
      abortStart = () => resolve('cancelled');
      signal?.addEventListener('abort', abortStart, { once: true });
    });
    const started = await Promise.race([this.start(), cancelled]);
    signal?.removeEventListener('abort', abortStart);
    if (started === 'cancelled') return { ok: false, error: 'Forma request cancelled.' };
    if (!started) return null;
    if (signal?.aborted) return { ok: false, error: 'Forma request cancelled.' };
    const child = this.child;
    if (!child || !child.stdin.writable) {
      // A worker can exit between the handshake and the first write.
      if (child) this.reset(child);
      else this.child = null;
      if (!await this.start()) return null;
      if (!this.child?.stdin.writable) return { ok: false, error: 'Forma indexer worker stopped.' };
      return this.send(this.child, args, signal);
    }
    const response = await this.send(child, args, signal);
    if (!response.retryable || signal?.aborted || this.closing) return response;
    // EPIPE means this frame was not delivered. Retire the dead worker and
    // retry only that unsent frame once; never replay an in-flight request.
    this.reset(child);
    if (!await this.start() || !this.child?.stdin.writable) return { ok: false, error: 'Forma indexer worker stopped.' };
    return this.send(this.child, args, signal);
  }

  send(child, args, signal) {
    return new Promise(resolve => {
      const id = String(++this.nextId);
      let timer;
      const abort = () => {
        this.pending.delete(id);
        finish({ ok: false, error: 'Forma request cancelled.' });
      };
      const finish = payload => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolve(payload);
      };
      this.pending.set(id, { child, finish });
      timer = setTimeout(() => this.reset(child, id), this.timeouts[args[0]] ?? 120_000);
      timer.unref();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) return abort();
      child.stdin.write(JSON.stringify({ id, args: [...args, '--json'] }) + '\n', error => {
        if (error && this.pending.delete(id)) finish({ ok: false, error: 'Forma indexer worker stopped.', retryable: error.code === 'EPIPE' });
      });
    });
  }

  close() {
    if (this.closing) return;
    this.closing = true;
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    // The MCP SDK escalates to killing its server after four seconds on close.
    // Finish our own escalation first so worker-owned model children cannot be orphaned.
    const terminate = setTimeout(() => { if (child.exitCode === null) child.kill('SIGTERM'); }, 1500);
    const kill = setTimeout(() => { this.killGroup(child, 'SIGKILL'); }, 3000);
    terminate.unref(); kill.unref();
    child.once('exit', () => { clearTimeout(terminate); clearTimeout(kill); });
  }
}
