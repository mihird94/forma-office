import { afterEach, expect, it, vi } from 'vitest';
import { interruptKernel, restartKernel } from '../storage/notebookStore';

afterEach(() => { vi.unstubAllGlobals(); delete (window as unknown as { __formaKernelEvent?: unknown }).__formaKernelEvent; });

it('surfaces native kernel restart and interrupt failures', async () => {
  const postMessage = (message: { reqId: string }) => {
    queueMicrotask(() => {
      const callback = (window as unknown as { __formaKernelEvent: (event: unknown) => void }).__formaKernelEvent;
      callback({ reqId: message.reqId, ok: false, error: 'Native kernel failed' });
    });
  };
  vi.stubGlobal('webkit', { messageHandlers: { formaKernel: { postMessage } } });
  await expect(restartKernel('/bad/python')).rejects.toThrow('Native kernel failed');
  await expect(interruptKernel()).rejects.toThrow('Native kernel failed');
});
