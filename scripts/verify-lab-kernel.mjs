import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const source = readFileSync('macos/FormaHost.swift', 'utf8');
const start = source.indexOf('final class PythonKernelManager:');
const end = source.indexOf('// MARK: - Per-Window Controller', start);
if (start < 0 || end < 0) throw new Error('Could not locate the native kernel manager');
const dir = mkdtempSync(join(tmpdir(), 'forma-kernel-test-'));
try {
  const manager = join(dir, 'PythonKernelManager.swift');
  const binary = join(dir, 'kernel-lifecycle-test');
  writeFileSync(manager, 'import Cocoa\nimport Darwin\n\n' + source.slice(start, end));
  copyFileSync('macos/forma_kernel.py', join(dir, 'forma_kernel.py'));
  execFileSync('swiftc', ['-parse-as-library', '-module-cache-path', join(tmpdir(), 'forma-lab-swift-cache'), manager, resolve('macos/tests/KernelLifecycleTests.swift'), '-o', binary], { stdio: 'inherit' });
  execFileSync(binary, [], { stdio: 'inherit', timeout: 90000 });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
