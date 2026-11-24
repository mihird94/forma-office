import { FormaPdfRecord } from '../types/pdf';

export const PDFS_KEY = 'forma_office_pdfs_v1';

const DB_NAME = 'forma_pdf_storage_v1';
const STORE_NAME = 'pdf_blobs';

// In-memory fallback + fast object/stream URL registry (zero-copy for huge 100MB+ PDF books)
const memoryBlobs = new Map<string, Uint8Array>();
const streamUrls = new Map<string, string>();

export function setPdfStreamUrl(id: string, url: string): void {
  if (streamUrls.get(id) !== url) clearPdfStreamUrl(id);
  streamUrls.set(id, url);
}

export function getPdfStreamUrl(id: string): string | null {
  return streamUrls.get(id) ?? null;
}

export function clearPdfStreamUrl(id: string): void {
  const prev = streamUrls.get(id);
  if (prev?.startsWith('blob:')) {
    URL.revokeObjectURL(prev);
  }
  streamUrls.delete(id);
}

/** Resolve a native macOS disk path back into a zero-copy forma://local/ stream URL */
export function resolveNativePdfPath(path: string): Promise<string | null> {
  const w = window as unknown as {
    webkit?: {
      messageHandlers?: {
        formaResolveLocalPath?: {
          postMessage: (payload: { requestId: string; path: string }) => void;
        };
      };
    };
    __formaResolveLocalPathCb?: (requestId: string, streamUrl: string) => void;
  };
  const handler = w.webkit?.messageHandlers?.formaResolveLocalPath;
  if (!handler) return Promise.resolve(null);

  return new Promise((resolve) => {
    const requestId = `req_${Math.random().toString(36).slice(2, 10)}`;
    const prevCb = w.__formaResolveLocalPathCb;
    const timeout = setTimeout(() => resolve(null), 3000);
    w.__formaResolveLocalPathCb = (rid: string, url: string) => {
      if (rid === requestId) {
        clearTimeout(timeout);
        resolve(url || null);
      } else {
        prevCb?.(rid, url);
      }
    };
    handler.postMessage({ requestId, path });
  });
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function savePdfBytes(id: string, bytes: Uint8Array): Promise<void> {
  const copy = new Uint8Array(bytes);
  const db = await openDb();
  if (!db) throw new Error('PDF storage is unavailable. Keep this file open and export it.');
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(copy, id);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('Could not store this PDF.'));
      tx.onerror = () => reject(tx.error);
    });
    memoryBlobs.set(id, copy);
  } finally {
    db.close();
  }
}

export async function loadPdfBytes(id: string): Promise<Uint8Array | null> {
  const cached = memoryBlobs.get(id);
  if (cached) return new Uint8Array(cached);
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => {
        const val = req.result;
        if (val instanceof Uint8Array) {
          memoryBlobs.set(id, val);
          resolve(new Uint8Array(val));
        } else if (val instanceof ArrayBuffer) {
          const u8 = new Uint8Array(val);
          memoryBlobs.set(id, u8);
          resolve(new Uint8Array(u8));
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function deletePdfBytes(id: string): Promise<void> {
  memoryBlobs.delete(id);
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export function loadPdfRecords(): FormaPdfRecord[] {
  try {
    const raw = localStorage.getItem(PDFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as FormaPdfRecord[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // ignore
  }
  return [];
}

export function savePdfRecords(records: FormaPdfRecord[]): void {
  try {
    localStorage.setItem(PDFS_KEY, JSON.stringify(records));
  } catch {
    // ignore
  }
}
