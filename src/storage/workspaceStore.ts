import { CanvasData } from '../types/canvas';
import { FormaDocument } from '../types/document';
import { NotebookData } from '../types/notebook';
import { WorkspaceFileSummary } from '../types/office';
import { FormaPdfRecord } from '../types/pdf';
import { PresentationData } from '../types/slides';
import { WorkbookData } from '../types/spreadsheet';

export const WORKBOOKS_KEY = 'forma_office_workbooks_v2';
export const DOCS_KEY = 'forma_office_docs_v2';

export function loadWorkbooks(): WorkbookData[] {
  try {
    const raw = localStorage.getItem(WORKBOOKS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as WorkbookData[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // ignore corrupted storage
  }
  return [];
}

export function saveWorkbooks(workbooks: WorkbookData[]): void {
  try {
    localStorage.setItem(WORKBOOKS_KEY, JSON.stringify(workbooks));
  } catch {
    // quota fallback
  }
}

export function loadDocuments(): FormaDocument[] {
  try {
    const raw = localStorage.getItem(DOCS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as FormaDocument[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // ignore corrupted storage
  }
  return [];
}

export function saveDocuments(docs: FormaDocument[]): void {
  try {
    localStorage.setItem(DOCS_KEY, JSON.stringify(docs));
  } catch {
    // quota fallback
  }
}

export function listWorkspaceFiles(
  workbooks: WorkbookData[],
  docs: FormaDocument[],
  pdfs: FormaPdfRecord[] = [],
  presentations: PresentationData[] = [],
  notebooks: NotebookData[] = [],
  canvases: CanvasData[] = []
): WorkspaceFileSummary[] {
  const wbItems: WorkspaceFileSummary[] = workbooks.map((w) => ({
    id: w.id,
    title: w.title,
    kind: 'spreadsheet',
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    pinned: Boolean(w.pinned),
    primaryFormat: '.xlsx / .ods',
    previewText: `${w.sheets.length} sheet${w.sheets.length === 1 ? '' : 's'} · ${w.sheets
      .map((s) => s.name)
      .join(', ')}`,
  }));

  const docItems: WorkspaceFileSummary[] = docs.map((d) => {
    const stripped = d.html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      id: d.id,
      title: d.title,
      kind: 'document',
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      pinned: Boolean(d.pinned),
      primaryFormat: d.sourceFormat === 'html' || d.rawHtmlSource !== undefined ? '.html' : '.docx / .odt / .md',
      previewText: stripped
        ? stripped.slice(0, 110) + (stripped.length > 110 ? '…' : '')
        : 'Blank document',
    };
  });

  const pdfItems: WorkspaceFileSummary[] = pdfs.map((p) => ({
    id: p.id,
    title: p.title,
    kind: 'pdf',
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    pinned: Boolean(p.pinned),
    primaryFormat: '.pdf (ISO 32000)',
    previewText: `${p.pageCount} page${p.pageCount === 1 ? '' : 's'} · ${(p.sizeBytes / 1024).toFixed(1)} KB${
      p.annotations.length > 0 ? ` · ${p.annotations.length} annotation${p.annotations.length === 1 ? '' : 's'}` : ''
    }`,
  }));

  const slideItems: WorkspaceFileSummary[] = presentations.map((pr) => ({
    id: pr.id,
    title: pr.title,
    kind: 'slides',
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    pinned: Boolean(pr.pinned),
    primaryFormat: '.pptx / .odp',
    previewText: `${pr.slides.length} slide${pr.slides.length === 1 ? '' : 's'} · 16:9 Widescreen`,
  }));

  const nbItems: WorkspaceFileSummary[] = notebooks.map((nb) => {
    const codeCount = nb.cells.filter((c) => c.cell_type === 'code').length;
    return {
      id: nb.id,
      title: nb.title,
      kind: 'notebook',
      createdAt: nb.createdAt,
      updatedAt: nb.updatedAt,
      pinned: Boolean(nb.pinned),
      primaryFormat: '.ipynb (Python)',
      previewText: `${nb.cells.length} cell${nb.cells.length === 1 ? '' : 's'} · ${codeCount} code · ${nb.kernelName || 'Python 3'}`,
    };
  });

  const canvasItems: WorkspaceFileSummary[] = canvases.map((c) => {
    const count = c.elements?.length ?? 0;
    return {
      id: c.id,
      title: c.title,
      kind: 'canvas',
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      pinned: Boolean(c.pinned),
      primaryFormat: '.fcanvas / .excalidraw',
      previewText: `${count} object${count === 1 ? '' : 's'} · Infinite Canvas`,
    };
  });

  return [...wbItems, ...docItems, ...slideItems, ...nbItems, ...canvasItems, ...pdfItems].sort(
    (a, b) => b.updatedAt - a.updatedAt
  );
}

interface NativeBridge {
  formaSaveFile?: {
    postMessage: (payload: { requestId: string; filename: string; base64: string; mimeType: string }) => void;
  };
  formaPrint?: {
    postMessage: (payload: { title: string }) => void;
  };
  formaNewWindow?: {
    postMessage: (payload: { fileId?: string }) => void;
  };
  formaOpenFileDialog?: {
    postMessage: (payload: Record<string, never>) => void;
  };
}

function getNativeBridge(): NativeBridge | undefined {
  return (window as unknown as { webkit?: { messageHandlers?: NativeBridge } }).webkit
    ?.messageHandlers;
}

export function isNativeMacApp(): boolean {
  return Boolean(getNativeBridge()?.formaNewWindow);
}

/** True only when the native macOS NSSavePanel was explicitly cancelled by the user. */
export function wasNativeSaveCancelled(savedPath: string | undefined): boolean {
  return isNativeMacApp() && savedPath === '';
}

/** Open the native macOS NSOpenPanel (streams PDFs zero-copy!). Returns false if in browser. */
export function openNativeFileDialog(): boolean {
  const bridge = getNativeBridge();
  if (bridge?.formaOpenFileDialog) {
    bridge.formaOpenFileDialog.postMessage({});
    return true;
  }
  return false;
}

/** Open a new native macOS window (optionally focused directly on a specific file ID) */
export function openNativeNewWindow(fileId?: string): void {
  const bridge = getNativeBridge();
  if (bridge?.formaNewWindow) {
    bridge.formaNewWindow.postMessage({ fileId });
  } else {
    const url = new URL(window.location.href);
    if (fileId) url.searchParams.set('file', fileId);
    else url.searchParams.delete('file');
    window.open(url.toString(), '_blank');
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Trigger file download — uses native macOS Save Panel when running inside Forma Sheets/Docs.app */
const pendingSaves = new Map<string, { resolve: (path: string) => void; reject: (error: Error) => void }>();

export async function triggerFileDownload(
  data: Uint8Array | string,
  filename: string,
  mimeType: string
): Promise<string | undefined> {
  const bridge = getNativeBridge();
  if (bridge?.formaSaveFile) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const requestId = crypto.randomUUID();
    const host = window as unknown as { __formaSaveResult?: (result: { requestId: string; path?: string; error?: string; cancelled?: boolean }) => void };
    host.__formaSaveResult = (result) => {
      const pending = pendingSaves.get(result.requestId);
      if (!pending) return;
      pendingSaves.delete(result.requestId);
      if (result.path) pending.resolve(result.path);
      else if (result.cancelled) pending.resolve('');
      else pending.reject(new Error(result.error || 'File could not be saved'));
    };
    return new Promise<string>((resolve, reject) => {
      pendingSaves.set(requestId, { resolve, reject });
      try { bridge.formaSaveFile!.postMessage({ requestId, filename, base64: bytesToBase64(bytes), mimeType }); }
      catch (error) { pendingSaves.delete(requestId); reject(error); }
    });
  }

  const blobPart: BlobPart =
    typeof data === 'string'
      ? data
      : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  const blob = new Blob([blobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
