import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import {
  addIndexedFolder,
  getIndexedFolderConfig,
  removeIndexedFolder,
  setIndexedImages,
  syncIndexedFolders,
  type IndexedFolderConfig,
} from '../../storage/aiSemanticStore';

function lastSynced(timestamp: number): string {
  if (!timestamp) return 'Never synced';
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes === 0) return 'Synced just now';
  const age = new Intl.RelativeTimeFormat(undefined, { numeric: 'always' });
  if (minutes < 60) return 'Synced ' + age.format(-minutes, 'minute');
  if (minutes < 1440) return 'Synced ' + age.format(-Math.floor(minutes / 60), 'hour');
  return 'Synced ' + age.format(-Math.floor(minutes / 1440), 'day');
}

export function IndexedFoldersDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [config, setConfig] = useState<IndexedFolderConfig | null>(null);
  const [busy, setBusy] = useState<'add' | 'change' | 'sync' | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    let mounted = true;
    const refresh = async (initial = false) => {
      try {
        const updated = await getIndexedFolderConfig();
        if (mounted) setConfig(updated);
      } catch (problem) {
        if (mounted && initial) setError(problem instanceof Error ? problem.message : 'Could not load indexed folders.');
      }
    };
    void refresh(true);
    const timer = setInterval(() => void refresh(), 3_000);
    return () => {
      mounted = false;
      clearInterval(timer);
      element?.close();
    };
  }, []);

  const mutate = async (action: NonNullable<typeof busy>, update: () => Promise<IndexedFolderConfig | null>) => {
    setBusy(action);
    setError('');
    setNotice('');
    try {
      const updated = await update();
      if (updated) setConfig(updated);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Could not update indexed folders.');
    } finally {
      setBusy(null);
    }
  };

  const sync = () => void mutate('sync', async () => {
    const summary = await syncIndexedFolders();
    setNotice(summary.indexedCount || summary.prunedCount
      ? `${summary.indexedCount} indexed, ${summary.prunedCount} removed`
      : 'Indexed folders are up to date');
    return getIndexedFolderConfig();
  });

  return (
    <dialog
      ref={dialog}
      aria-labelledby="indexed-folders-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      className="m-auto w-[calc(100%_-_2rem)] max-w-xl rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-2xl backdrop:bg-slate-950/50"
    >
      <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-5 py-4">
        <h2 id="indexed-folders-title" className="font-semibold">Indexed Folders (AI Search)</h2>
        <button type="button" onClick={onClose} aria-label="Close indexed folders" className="rounded-lg p-2 hover:bg-slate-100">
          <X className="size-4" />
        </button>
      </div>

      <div className="space-y-4 px-5 py-4">
        {config ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <span className="rounded-full bg-violet-50 px-2 py-1 font-medium text-violet-800">
                {config.backend === 'forma-embedded'
                  ? `Self-Contained · ${config.embedModel.replace(' (built-in)', '')} (${config.multimodal ? 'Text + Vision' : 'Text'})`
                  : 'Local keyword search'}
              </span>
              <span>{lastSynced(config.lastFullSyncAt)}</span>
            </div>
            {config.folders.length ? (
              <ul className="max-h-64 divide-y divide-slate-100 overflow-auto rounded-lg border border-slate-200">
                {config.folders.map(({ path, fileCount }) => {
                  const name = path.split('/').filter(Boolean).at(-1) ?? path;
                  return (
                    <li key={path} className="flex items-center gap-3 px-3 py-2.5">
                      <FolderOpen className="size-4 shrink-0 text-violet-600" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{name}</div>
                        <div title={path} className="truncate text-xs text-slate-500">{path}</div>
                      </div>
                      <span className="shrink-0 text-xs tabular-nums text-slate-600">{fileCount} {fileCount === 1 ? 'file' : 'files'}</span>
                      <button
                        type="button"
                        disabled={busy !== null}
                        aria-label={`Remove ${name}`}
                        title="Remove from the index"
                        className="rounded-md p-2 text-slate-500 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
                        onClick={() => void mutate('change', () => removeIndexedFolder(path))}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="text-sm text-slate-600">Add a folder to make its files searchable.</p>}
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={config.includeStandaloneImages}
                disabled={busy !== null}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  void mutate('change', () => setIndexedImages(enabled));
                }}
                className="size-4 accent-violet-600"
              />
              Index standalone images (.png / .jpg / .webp)
            </label>
          </>
        ) : !error && <p role="status" className="text-sm text-slate-600">Loading indexed folders…</p>}
        {error && <div role="alert" className="text-sm text-rose-800">{error}</div>}
        {(notice || busy === 'sync') && (
          <div role="status" className="text-sm text-slate-600">{busy === 'sync' ? 'Syncing indexed folders…' : notice}</div>
        )}
      </div>

      <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 px-5 py-3">
        <button
          type="button"
          onClick={() => void mutate('add', addIndexedFolder)}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
        >
          <Plus className="size-4" />
          Add Folder…
        </button>
        <button
          type="button"
          onClick={sync}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-lg bg-violet-700 px-3 py-2 text-sm font-medium text-white hover:bg-violet-800 disabled:opacity-50"
        >
          <RefreshCw className="size-4" />
          Sync Now
        </button>
      </div>
    </dialog>
  );
}
