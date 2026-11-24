import { Dispatch, SetStateAction, useCallback, useEffect, useRef, useState } from 'react';

interface RecordData { id: string; updatedAt: number }
interface StoredRecord<T> {
  collection: string;
  id: string;
  revision: number;
  data: T | null;
  previous?: T | null;
}
export type SaveState = 'saving' | 'saved' | 'error';

const cache = new Map<string, StoredRecord<RecordData>[]>();
let database: Promise<IDBDatabase | null> | undefined;
const activeFlushers = new Set<() => Promise<boolean>>();

const channel = (() => {
  try {
    return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('forma-workspace-v3');
  } catch {
    return null;
  }
})();

const IDB_OPEN_TIMEOUT_MS = 8000;
const WRITE_DEBOUNCE_MS = 300;

/**
 * Flush all mounted workspace stores to IndexedDB immediately and await full
 * transaction completion. Returns true only if every pending write succeeded.
 */
export async function flushAllWorkspaceSaves(): Promise<boolean> {
  // Yield once so any synchronous React setState from editor snapshot() settles into refs
  await new Promise((r) => setTimeout(r, 0));
  const results = await Promise.all(Array.from(activeFlushers).map((fn) => fn()));
  return results.every(Boolean);
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (!database) {
    database = new Promise<IDBDatabase | null>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Workspace storage took too long to open. Click Retry to reconnect without losing files.'));
        }
      }, IDB_OPEN_TIMEOUT_MS);

      try {
        const request = indexedDB.open('forma_workspace_v3', 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains('files')) {
            request.result.createObjectStore('files', { keyPath: ['collection', 'id'] });
          }
        };
        request.onsuccess = () => {
          if (settled) {
            request.result.close();
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(request.result);
        };
        request.onerror = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(request.error);
        };
        request.onblocked = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error('Close other Forma windows to finish opening storage.'));
        };
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      }
    });
    database.catch(() => { database = undefined; });
  }
  return database;
}

function readLegacyFromLocalStorage(key: string): StoredRecord<RecordData>[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const rows: StoredRecord<RecordData>[] = [];
    for (const data of parsed) {
      if (data && typeof data.id === 'string') {
        rows.push({ collection: key, id: data.id, revision: 1, data });
      }
    }
    rows.push({ collection: key, id: '', revision: 1, data: null });
    return rows;
  } catch {
    return [{ collection: key, id: '', revision: 1, data: null }];
  }
}

async function readCollection(key: string): Promise<StoredRecord<RecordData>[]> {
  const db = await openDatabase();
  if (!db) return cache.get(key) ?? readLegacyFromLocalStorage(key);
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readonly');
    const request = tx.objectStore('files').getAll(IDBKeyRange.bound([key, ''], [key, '\uffff']));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readCollectionsBatch(db: IDBDatabase, keys: string[]): Promise<Map<string, StoredRecord<RecordData>[]>> {
  return new Promise((resolve, reject) => {
    const results = new Map<string, StoredRecord<RecordData>[]>();
    const tx = db.transaction('files', 'readonly');
    const store = tx.objectStore('files');
    for (const key of keys) {
      const req = store.getAll(IDBKeyRange.bound([key, ''], [key, '\uffff']));
      req.onsuccess = () => results.set(key, req.result);
    }
    tx.oncomplete = () => resolve(results);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Could not read workspace storage.'));
  });
}

export async function initializeWorkspace(keys: string[]): Promise<void> {
  const db = await openDatabase();
  if (!db) {
    for (const key of keys) {
      cache.set(key, readLegacyFromLocalStorage(key));
    }
    return;
  }

  // Single readonly transaction to read all collections in parallel instead of N sequential round-trips
  const initialMap = await readCollectionsBatch(db, keys);
  const toMigrate: string[] = [];

  for (const key of keys) {
    const stored = initialMap.get(key) ?? [];
    if (stored.some((row) => row.id === '')) {
      cache.set(key, stored);
    } else {
      toMigrate.push(key);
    }
  }

  for (const key of toMigrate) {
    const raw = localStorage.getItem(key);
    const legacy = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(legacy)) {
      throw new Error('The existing workspace needs recovery. Export or restore its saved data before continuing.');
    }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite');
      const store = tx.objectStore('files');
      // Recheck within the transaction so simultaneous first launches migrate once.
      const marker = store.get([key, '']);
      marker.onsuccess = () => {
        if (marker.result) return;
        for (const data of legacy) {
          if (!data || typeof data.id !== 'string') { tx.abort(); return; }
          store.put({ collection: key, id: data.id, revision: 1, data });
        }
        store.put({ collection: key, id: '', revision: 1, data: null });
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('Workspace migration could not be saved.'));
      tx.onerror = () => reject(tx.error);
    });
    cache.set(key, await readCollection(key));
  }
}

export function loadRecords<T extends RecordData>(key: string): T[] {
  return (cache.get(key) ?? []).flatMap((row) => row.data ? [row.data as T] : [])
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function entries<T extends RecordData>(key: string): Map<string, StoredRecord<T>> {
  return new Map((cache.get(key) ?? []).filter((row) => row.id).map((row) => [row.id, row as StoredRecord<T>]));
}

function hasPendingChanges<T extends RecordData>(snapshot: T[], base: Map<string, StoredRecord<T>>): boolean {
  let activeInBase = 0;
  for (const row of base.values()) {
    if (row.data !== null) activeInBase++;
  }
  if (snapshot.length !== activeInBase) return true;
  for (const item of snapshot) {
    if ((base.get(item.id)?.data ?? null) !== item) return true;
  }
  return false;
}

async function writeChanges<T extends RecordData>(key: string, snapshot: T[], base: Map<string, StoredRecord<T>>) {
  const next = new Map(snapshot.map((data) => [data.id, data]));
  const changed = new Set([...next.keys(), ...base.keys()]);
  for (const id of changed) if ((base.get(id)?.data ?? null) === (next.get(id) ?? null)) changed.delete(id);
  if (!changed.size) return { committed: base, wrote: false };

  const db = await openDatabase();
  const committed = new Map(base);

  if (!db) {
    // Fallback mode when IndexedDB is unavailable/timed out: persist to localStorage + memory cache
    for (const id of changed) {
      const old = base.get(id);
      const row: StoredRecord<T> = {
        collection: key,
        id,
        revision: (old?.revision ?? 0) + 1,
        data: next.get(id) ?? null,
        previous: old?.data,
      };
      committed.set(id, row);
    }
    // A failed fallback write must leave the baseline unchanged so the UI can
    // report unsaved edits and retry once storage becomes available.
    localStorage.setItem(key, JSON.stringify(snapshot));
    cache.set(key, [...committed.values()] as StoredRecord<RecordData>[]);
    return { committed, wrote: true };
  }

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    const store = tx.objectStore('files');
    let failure: Error | null = null;
    for (const id of changed) {
      const request = store.get([key, id]);
      request.onsuccess = () => {
        const old = request.result as StoredRecord<T> | undefined;
        if ((old?.revision ?? 0) !== (base.get(id)?.revision ?? 0)) {
          failure = new Error('This file changed in another window. Export your edits or reopen its latest saved version.');
          tx.abort();
          return;
        }
        const row = { collection: key, id, revision: (old?.revision ?? 0) + 1, data: next.get(id) ?? null, previous: old?.data };
        committed.set(id, row);
        store.put(row);
      };
    }
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('Workspace save failed. Your edits are still open.'));
    tx.onerror = () => reject(tx.error);
  });
  cache.set(key, [...committed.values()] as StoredRecord<RecordData>[]);
  channel?.postMessage(key);
  return { committed, wrote: true };
}

export function useStoredRecords<T extends RecordData>(key: string): {
  items: T[]; setItems: Dispatch<SetStateAction<T[]>>;
  state: (id: string) => SaveState; error: string | null; retry: () => void;
  flushNow: () => Promise<boolean>;
} {
  const [items, setItems] = useState<T[]>(() => loadRecords<T>(key));
  const current = useRef(items);
  current.current = items;
  const saved = useRef(entries<T>(key));
  const saving = useRef(false);
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, render] = useState(0);

  const flush = useCallback(async (): Promise<boolean> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (inFlightRef.current) {
      const prevOk = await inFlightRef.current;
      if (!hasPendingChanges(current.current, saved.current)) return prevOk;
    }
    if (!hasPendingChanges(current.current, saved.current)) return true;

    const run = (async (): Promise<boolean> => {
      saving.current = true;
      setError(null);
      let anyWrote = false;
      let ok = true;
      try {
        let snapshot: T[];
        do {
          snapshot = current.current;
          const res = await writeChanges(key, snapshot, saved.current);
          saved.current = res.committed;
          if (res.wrote) anyWrote = true;
        } while (snapshot !== current.current && hasPendingChanges(current.current, saved.current));
      } catch (err) {
        ok = false;
        setError((err as Error).message || 'Workspace save failed. Export your edits and retry.');
        anyWrote = true;
      } finally {
        saving.current = false;
        inFlightRef.current = null;
        if (anyWrote) render((v) => v + 1);
      }
      return ok;
    })();
    inFlightRef.current = run;
    return run;
  }, [key]);

  useEffect(() => {
    activeFlushers.add(flush);
    return () => {
      activeFlushers.delete(flush);
    };
  }, [flush]);

  // Debounce writes so rapid keystrokes/drags batch into a single IndexedDB transaction
  useEffect(() => {
    if (!hasPendingChanges(items, saved.current)) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void flush();
    }, WRITE_DEBOUNCE_MS);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [items, flush]);

  useEffect(() => {
    const changedElsewhere = async (event: MessageEvent) => {
      if (event.data !== key) return;
      const incoming = await readCollection(key);
      const local = new Map(current.current.map((data) => [data.id, data]));
      let mutated = false;
      for (const row of incoming) {
        if (!row.id) continue;
        const baseline = saved.current.get(row.id);
        if ((local.get(row.id) ?? null) !== (baseline?.data ?? null)) continue;
        if (baseline?.revision === row.revision) continue;
        saved.current.set(row.id, row as StoredRecord<T>);
        if (row.data) local.set(row.id, row.data as T);
        else local.delete(row.id);
        mutated = true;
      }
      if (mutated) setItems([...local.values()]);
    };
    const onMessage = (event: MessageEvent) => {
      void changedElsewhere(event).catch(() => setError('Could not refresh changes from another window.'));
    };
    channel?.addEventListener('message', onMessage);

    const flushOnHide = () => {
      if (hasPendingChanges(current.current, saved.current)) {
        void flush();
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushOnHide();
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const unsaved = hasPendingChanges(current.current, saved.current);
      if (unsaved) void flush();
      if (unsaved || saving.current) { event.preventDefault(); event.returnValue = ''; }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', flushOnHide);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      channel?.removeEventListener('message', onMessage);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', flushOnHide);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [key, flush]);

  return {
    items, setItems, error, retry: () => void flush(), flushNow: flush,
    state: (id) => saved.current.get(id)?.data === items.find((item) => item.id === id) ? 'saved' : error ? 'error' : 'saving',
  };
}
