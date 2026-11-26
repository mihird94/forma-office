import {
  CellTraceData,
  LabFolderWorkspace,
  LiveVariable,
  NotebookData,
  NotebookOutput,
  PythonEnvInfo,
  WorkspaceTreeNode,
} from '../types/notebook';
import { bytesToBase64 } from './workspaceStore';

export const NOTEBOOKS_KEY = 'forma_office_notebooks_v1';
export const LAB_FOLDER_KEY = 'forma_lab_folder_path_v1';

export function loadSavedLabFolderPath(): string | null {
  try {
    return localStorage.getItem(LAB_FOLDER_KEY) || null;
  } catch {
    return null;
  }
}

export function saveLabFolderPath(path: string | null): void {
  try {
    if (path) localStorage.setItem(LAB_FOLDER_KEY, path);
    else localStorage.removeItem(LAB_FOLDER_KEY);
  } catch {
    // ignore
  }
}

export function findFirstNotebookInTree(nodes: WorkspaceTreeNode[]): WorkspaceTreeNode | null {
  for (const n of nodes) {
    if (n.kind === 'file' && n.ext === 'ipynb') return n;
  }
  for (const n of nodes) {
    if (n.kind === 'dir' && n.children) {
      const found = findFirstNotebookInTree(n.children);
      if (found) return found;
    }
  }
  return null;
}

export function countNotebooksInTree(nodes: WorkspaceTreeNode[]): number {
  let total = 0;
  for (const n of nodes) {
    if (n.kind === 'file' && n.ext === 'ipynb') total += 1;
    else if (n.kind === 'dir' && n.children) total += countNotebooksInTree(n.children);
  }
  return total;
}

export function dirnamePath(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  const idx = filePath.lastIndexOf('/');
  return idx > 0 ? filePath.slice(0, idx) : undefined;
}

export function loadNotebooks(): NotebookData[] {
  try {
    const raw = localStorage.getItem(NOTEBOOKS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as NotebookData[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // ignore
  }
  return [];
}

export function saveNotebooks(notebooks: NotebookData[]): void {
  try {
    localStorage.setItem(NOTEBOOKS_KEY, JSON.stringify(notebooks));
  } catch {
    // quota fallback
  }
}

// MARK: - Native Swift Persistent Python Kernel Bridge

export interface KernelExecResponse {
  ok: boolean;
  execution_count: number;
  elapsed_ms: number;
  outputs: NotebookOutput[];
  variables: LiveVariable[];
  trace?: CellTraceData;
  error?: string;
}

interface NativeKernelBridge {
  formaKernel?: {
    postMessage: (payload: Record<string, unknown>) => void;
  };
}

const pendingResolvers = new Map<string, (payload: Record<string, unknown>) => void>();
const streamListeners = new Map<string, (name: 'stdout' | 'stderr', text: string) => void>();

function ensureCallbackHook(): void {
  const w = window as unknown as {
    __formaKernelEvent?: (payload: Record<string, unknown>) => void;
  };
  if (!w.__formaKernelEvent) {
    w.__formaKernelEvent = (payload: Record<string, unknown>) => {
      const reqId = typeof payload.reqId === 'string' ? payload.reqId : '';
      if (payload.type === 'stream_chunk') {
        const listener = streamListeners.get(reqId);
        if (listener) {
          const name = payload.name === 'stderr' ? 'stderr' : 'stdout';
          const text = typeof payload.text === 'string' ? payload.text : '';
          if (text) listener(name, text);
        }
        return;
      }
      streamListeners.delete(reqId);
      const resolver = pendingResolvers.get(reqId);
      if (resolver) {
        pendingResolvers.delete(reqId);
        resolver(payload);
      }
    };
  }
}

export function isNativeKernelAvailable(): boolean {
  const webkit = (window as unknown as { webkit?: { messageHandlers?: NativeKernelBridge } }).webkit;
  return Boolean(webkit?.messageHandlers?.formaKernel);
}

function sendKernelRequest(
  payload: Record<string, unknown>,
  timeoutMs = 120000,
  onStreamChunk?: (name: 'stdout' | 'stderr', text: string) => void
): Promise<Record<string, unknown>> {
  ensureCallbackHook();
  const webkit = (window as unknown as { webkit?: { messageHandlers?: NativeKernelBridge } }).webkit;
  const handler = webkit?.messageHandlers?.formaKernel;
  if (!handler) {
    return Promise.reject(new Error('Native Python kernel is only available inside Forma Lab.app'));
  }

  const reqId = `k_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingResolvers.delete(reqId);
      streamListeners.delete(reqId);
      if (payload.action === 'exec' || payload.action === 'trace' || payload.action === 'sql') {
        try {
          handler.postMessage({ action: 'interrupt', reqId: `int_${Date.now()}` });
        } catch {
          // ignore interrupt delivery failure on timed-out kernel
        }
      }
      reject(new Error('Kernel request timed out'));
    }, timeoutMs);

    if (onStreamChunk) {
      streamListeners.set(reqId, onStreamChunk);
    }

    pendingResolvers.set(reqId, (res) => {
      clearTimeout(timer);
      streamListeners.delete(reqId);
      resolve(res);
    });

    try {
      handler.postMessage({ ...payload, reqId });
    } catch (error) {
      clearTimeout(timer);
      pendingResolvers.delete(reqId);
      streamListeners.delete(reqId);
      reject(error);
    }
  });
}

export async function listPythonEnvs(): Promise<{ envs: PythonEnvInfo[]; activePath: string }> {
  const res = await sendKernelRequest({ action: 'listEnvs' }, 10000);
  return {
    envs: (res.envs as PythonEnvInfo[]) ?? [],
    activePath: (res.activePath as string) ?? '',
  };
}

export async function executeKernelCode(
  code: string,
  pythonPath?: string,
  cwd?: string,
  onStreamChunk?: (name: 'stdout' | 'stderr', text: string) => void
): Promise<KernelExecResponse> {
  const res = await sendKernelRequest({ action: 'exec', code, pythonPath, cwd }, 120000, onStreamChunk);
  return {
    ok: Boolean(res.ok),
    execution_count: typeof res.execution_count === 'number' ? res.execution_count : 1,
    elapsed_ms: typeof res.elapsed_ms === 'number' ? res.elapsed_ms : 0,
    outputs: (res.outputs as NotebookOutput[]) ?? [],
    variables: (res.variables as LiveVariable[]) ?? [],
    error: typeof res.error === 'string' ? res.error : undefined,
  };
}

export async function executeSqlCode(
  sql: string,
  pythonPath?: string,
  cwd?: string
): Promise<KernelExecResponse> {
  const res = await sendKernelRequest({ action: 'sql', code: sql, pythonPath, cwd });
  // Seamless fallback if host bridge routes SQL via %%sql magic on exec
  if (!res.ok && typeof res.error === 'string' && res.error.startsWith('Unknown kernel action')) {
    const magicCode = sql.trimStart().startsWith('%%sql') ? sql : `%%sql\n${sql}`;
    return executeKernelCode(magicCode, pythonPath, cwd);
  }
  return {
    ok: Boolean(res.ok),
    execution_count: typeof res.execution_count === 'number' ? res.execution_count : 1,
    elapsed_ms: typeof res.elapsed_ms === 'number' ? res.elapsed_ms : 0,
    outputs: (res.outputs as NotebookOutput[]) ?? [],
    variables: (res.variables as LiveVariable[]) ?? [],
    error: typeof res.error === 'string' ? res.error : undefined,
  };
}

export async function traceKernelCode(
  code: string,
  pythonPath?: string,
  cwd?: string
): Promise<KernelExecResponse> {
  const res = await sendKernelRequest({ action: 'trace', code, pythonPath, cwd });
  return {
    ok: Boolean(res.ok),
    execution_count: typeof res.execution_count === 'number' ? res.execution_count : 1,
    elapsed_ms: typeof res.elapsed_ms === 'number' ? res.elapsed_ms : 0,
    outputs: (res.outputs as NotebookOutput[]) ?? [],
    variables: (res.variables as LiveVariable[]) ?? [],
    trace: res.trace as CellTraceData | undefined,
    error: typeof res.error === 'string' ? res.error : undefined,
  };
}

export async function restartKernel(pythonPath?: string): Promise<void> {
  const result = await sendKernelRequest({ action: 'restart', pythonPath }, 10000);
  if (result.ok === false) throw new Error(typeof result.error === 'string' ? result.error : 'Could not restart Python kernel');
}

export async function interruptKernel(): Promise<void> {
  const result = await sendKernelRequest({ action: 'interrupt' }, 5000);
  if (result.ok === false) throw new Error(typeof result.error === 'string' ? result.error : 'Could not interrupt Python kernel');
}

// MARK: - Native Swift Local Folder Workspace Bridge (Forma Lab)

interface NativeWorkspaceBridge {
  formaWorkspace?: {
    postMessage: (payload: Record<string, unknown>) => void;
  };
}

const pendingWorkspaceResolvers = new Map<string, (payload: Record<string, unknown>) => void>();

function ensureWorkspaceCallbackHook(): void {
  const w = window as unknown as {
    __formaWorkspaceEvent?: (payload: Record<string, unknown>) => void;
  };
  if (!w.__formaWorkspaceEvent) {
    w.__formaWorkspaceEvent = (payload: Record<string, unknown>) => {
      const reqId = typeof payload.reqId === 'string' ? payload.reqId : '';
      const resolver = pendingWorkspaceResolvers.get(reqId);
      if (resolver) {
        pendingWorkspaceResolvers.delete(reqId);
        resolver(payload);
      }
    };
  }
}

export function isNativeWorkspaceAvailable(): boolean {
  const webkit = (window as unknown as { webkit?: { messageHandlers?: NativeWorkspaceBridge } }).webkit;
  return Boolean(webkit?.messageHandlers?.formaWorkspace);
}

function sendWorkspaceRequest(
  payload: Record<string, unknown>,
  timeoutMs = 30000
): Promise<Record<string, unknown>> {
  ensureWorkspaceCallbackHook();
  const webkit = (window as unknown as { webkit?: { messageHandlers?: NativeWorkspaceBridge } }).webkit;
  const handler = webkit?.messageHandlers?.formaWorkspace;
  if (!handler) {
    return Promise.reject(new Error('Native folder workspace is only available inside Forma Lab.app'));
  }

  const reqId = `w_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingWorkspaceResolvers.delete(reqId);
      reject(new Error('Workspace request timed out'));
    }, timeoutMs);

    pendingWorkspaceResolvers.set(reqId, (res) => {
      clearTimeout(timer);
      resolve(res);
    });

    handler.postMessage({ ...payload, reqId });
  });
}

export async function pickLabFolder(): Promise<LabFolderWorkspace | null> {
  const res = await sendWorkspaceRequest({ action: 'pickFolder' }, 120000);
  if (!res.ok || typeof res.rootPath !== 'string') return null;
  return {
    rootPath: res.rootPath,
    rootName: (res.rootName as string) || res.rootPath.split('/').pop() || 'Folder',
    entries: (res.entries as WorkspaceTreeNode[]) ?? [],
  };
}

export async function listLabFolder(path: string): Promise<LabFolderWorkspace | null> {
  const res = await sendWorkspaceRequest({ action: 'listFolder', path }, 15000);
  if (!res.ok || typeof res.rootPath !== 'string') return null;
  return {
    rootPath: res.rootPath,
    rootName: (res.rootName as string) || res.rootPath.split('/').pop() || 'Folder',
    entries: (res.entries as WorkspaceTreeNode[]) ?? [],
  };
}

export async function readWorkspaceFile(
  path: string
): Promise<{ path: string; name: string; content: string } | null> {
  const res = await sendWorkspaceRequest({ action: 'readFile', path }, 15000);
  if (!res.ok || typeof res.content !== 'string') return null;
  return {
    path: (res.path as string) || path,
    name: (res.name as string) || path.split('/').pop() || 'file',
    content: res.content,
  };
}

export async function writeWorkspaceFile(path: string, content: string): Promise<boolean> {
  const res = await sendWorkspaceRequest({ action: 'writeFile', path, content }, 15000);
  return Boolean(res.ok);
}

export async function writeBinaryWorkspaceFile(path: string, bytes: Uint8Array): Promise<boolean> {
  const res = await sendWorkspaceRequest(
    { action: 'writeBinaryFile', path, base64: bytesToBase64(bytes) },
    30000
  );
  return Boolean(res.ok);
}

export async function createWorkspaceNotebook(
  dirPath: string,
  name: string,
  content: string
): Promise<{ path: string; name: string } | null> {
  const res = await sendWorkspaceRequest({ action: 'createNotebook', dirPath, name, content }, 15000);
  if (!res.ok || typeof res.path !== 'string') return null;
  return {
    path: res.path,
    name: (res.name as string) || name,
  };
}
