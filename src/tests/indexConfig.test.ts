/** @vitest-environment node */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'vitest';

const execute = promisify(execFile);

describe.skipIf(process.platform !== 'darwin')('Forma indexed folder config', () => {
  it('initializes existing default roots and persists add, remove and preference updates', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'forma-index-config-test-'));
    try {
      const executable = join(scratch, 'test-config');
      const moduleCache = join(process.cwd(), 'node_modules', '.cache', 'forma-swift-tests');
      await mkdir(moduleCache, { recursive: true });
      await execute('swiftc', [
        '-module-cache-path', moduleCache,
        'macos/FormaIndexConfig.swift', 'macos/tests/FormaIndexConfigTests.swift', '-o', executable,
      ], { timeout: 120_000 });
      await execute(executable, [scratch]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 130_000);
});
