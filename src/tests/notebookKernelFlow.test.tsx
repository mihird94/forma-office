import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotebookData } from '../types/notebook';

const bridge = vi.hoisted(() => ({
  execute: vi.fn(), restart: vi.fn(), interrupt: vi.fn(),
  envs: vi.fn(),
}));
vi.mock('../storage/notebookStore', async (load) => ({
  ...(await load<typeof import('../storage/notebookStore')>()),
  isNativeKernelAvailable: () => true,
  listPythonEnvs: bridge.envs,
  executeKernelCode: bridge.execute,
  restartKernel: bridge.restart,
  interruptKernel: bridge.interrupt,
}));
import { NotebookApp } from '../components/notebook/NotebookApp';

const ok = { ok: true, execution_count: 1, elapsed_ms: 1, outputs: [], variables: [] };
const failed = { ...ok, ok: false, error: 'Interrupted', outputs: [{ output_type: 'error', ename: 'KeyboardInterrupt', evalue: 'Interrupted', traceback: [] }] };
const makeNotebook = (): NotebookData => ({ id: 'nb', title: 'Test', cells: [
  { id: 'a', cell_type: 'code', source: 'first', outputs: [] },
  { id: 'b', cell_type: 'code', source: 'second', outputs: [] },
], createdAt: 1, updatedAt: 1 });
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let notify: ReturnType<typeof vi.fn<(message: string) => void>>;
let latestNotebook: NotebookData;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  bridge.execute.mockReset(); bridge.restart.mockReset(); bridge.interrupt.mockReset(); bridge.envs.mockReset();
  bridge.envs.mockResolvedValue({ envs: [{ path: '/env/a', label: 'A' }, { path: '/env/b', label: 'B' }], activePath: '/env/a' });
  bridge.restart.mockResolvedValue(undefined); bridge.interrupt.mockResolvedValue(undefined);
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); notify = vi.fn<(message: string) => void>();
  function Harness() {
    const [nb, setNb] = useState(makeNotebook);
    return <NotebookApp notebook={nb} labFolder={null} onChangeNotebook={next => { latestNotebook = next; setNb(next); }} onImportNotebookFile={() => {}} onPickLabFolder={() => {}} onRefreshLabFolder={() => {}} onOpenFolderNotebook={() => {}} onCreateNotebookInDir={() => {}} onNotify={notify} />;
  }
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

function clickTitle(title: string) { (host.querySelector(`button[title="${title}"]`) as HTMLButtonElement).click(); }

describe('notebook kernel controls', () => {
  it('runs all cells in order and preserves both results', async () => {
    bridge.execute.mockResolvedValueOnce({ ...ok, execution_count: 1 }).mockResolvedValueOnce({ ...ok, execution_count: 2 });
    await act(async () => clickTitle('Run All Code Cells'));
    expect(bridge.execute.mock.calls.map(call => call[0])).toEqual(['first', 'second']);
    expect(latestNotebook.cells.map(cell => cell.execution_count)).toEqual([1, 2]);
    expect(notify).toHaveBeenCalledWith('Finished running all cells');
  });
  it('runs cells in order and stops after an execution failure', async () => {
    bridge.execute.mockResolvedValueOnce(failed).mockResolvedValue(ok);
    await act(async () => clickTitle('Run All Code Cells'));
    expect(bridge.execute).toHaveBeenCalledTimes(1);
    expect(bridge.execute.mock.calls[0][0]).toBe('first');
    expect(notify).toHaveBeenCalledWith('Run All stopped because a cell did not complete');
  });
  it('interrupts Run All without starting the next cell', async () => {
    let finish!: (value: typeof failed) => void;
    bridge.execute.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => clickTitle('Run All Code Cells'));
    await act(async () => clickTitle('Interrupt Kernel (SIGINT)'));
    expect(bridge.interrupt).toHaveBeenCalledOnce();
    await act(async () => finish(failed));
    expect(bridge.execute).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalledWith('Finished running all cells');
  });
  it('only changes the selected environment after a successful restart', async () => {
    const selector = host.querySelector('select[aria-label="Python Environment"]') as HTMLSelectElement;
    bridge.restart.mockRejectedValueOnce(new Error('Cannot start'));
    await act(async () => { selector.value = '/env/b'; selector.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(selector.value).toBe('/env/a');
    expect(notify).toHaveBeenCalledWith('Kernel restart failed: Cannot start');
    await act(async () => { selector.value = '/env/b'; selector.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(selector.value).toBe('/env/b');
  });
  it('cancels the remaining Run All cells when switching kernels', async () => {
    let finish!: (value: typeof failed) => void;
    bridge.execute.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => clickTitle('Run All Code Cells'));
    const selector = host.querySelector('select[aria-label="Python Environment"]') as HTMLSelectElement;
    await act(async () => { selector.value = '/env/b'; selector.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => finish(failed));
    expect(bridge.execute).toHaveBeenCalledTimes(1);
    expect(bridge.restart).toHaveBeenCalledWith('/env/b');
  });
});
