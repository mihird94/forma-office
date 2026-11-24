import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Command,
  CornerDownLeft,
  Cpu,
  FileBadge2,
  FileSpreadsheet,
  FileText,
  FlaskConical,
  FolderSearch,
  Image as ImageIcon,
  Loader2,
  PenTool,
  Presentation,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import {
  getSemanticStatus,
  isNativeAiAvailable,
  SemanticIndexStatus,
  SemanticSearchHit,
  semanticSearchWorkspace,
} from '../../storage/aiSemanticStore';
import { WorkspaceFileKind, WorkspaceFileSummary } from '../../types/office';

export interface CommandPaletteCommand {
  id: string;
  label: string;
  category: string;
  shortcut?: string;
  onRun: () => void;
}

export interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  files: WorkspaceFileSummary[];
  commands: CommandPaletteCommand[];
  onSelectFile: (id: string, kind: WorkspaceFileKind) => void;
  onOpenExternalPath?: (path: string) => void;
  onReindexAll: () => void | Promise<void>;
  onOpenIndexedFolders?: () => void;
}

type PaletteTab = 'quick' | 'semantic';
type KindFilter = 'all' | WorkspaceFileKind | 'image';

type QuickItem =
  | {
      type: 'file';
      key: string;
      file: WorkspaceFileSummary;
    }
  | {
      type: 'command';
      key: string;
      command: CommandPaletteCommand;
    };

function normalizeKind(kind: string): WorkspaceFileKind {
  switch (kind) {
    case 'spreadsheet':
    case 'document':
    case 'slides':
    case 'pdf':
    case 'notebook':
    case 'canvas':
      return kind;
    default:
      return 'document';
  }
}

function renderKindIcon(kind: string, className = 'w-4 h-4 shrink-0') {
  switch (kind) {
    case 'spreadsheet':
      return <FileSpreadsheet className={`${className} text-emerald-600`} />;
    case 'document':
      return <FileText className={`${className} text-blue-600`} />;
    case 'slides':
      return <Presentation className={`${className} text-amber-600`} />;
    case 'notebook':
      return <FlaskConical className={`${className} text-violet-600`} />;
    case 'pdf':
      return <FileBadge2 className={`${className} text-rose-600`} />;
    case 'canvas':
      return <PenTool className={`${className} text-cyan-600`} />;
    case 'image':
      return <ImageIcon className={`${className} text-teal-600`} />;
    default:
      return <FileText className={`${className} text-slate-500`} />;
  }
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'spreadsheet':
      return 'Sheets';
    case 'document':
      return 'Docs';
    case 'slides':
      return 'Slides';
    case 'notebook':
      return 'Lab';
    case 'pdf':
      return 'PDF';
    case 'canvas':
      return 'Canvas';
    case 'image':
      return 'Image';
    default:
      return 'File';
  }
}

function formatRelativeTime(ts: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(ts).toLocaleDateString();
}

function renderHighlightedSnippet(snippet: string, query: string): React.ReactNode {
  const terms = Array.from(
    new Set(
      query
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length >= 2)
    )
  );
  if (terms.length === 0) return snippet;

  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = snippet.split(regex);

  return parts.map((part, idx) => {
    const isMatch = terms.includes(part.toLowerCase());
    return isMatch ? (
      <mark key={idx} className="bg-amber-200/80 text-slate-900 rounded px-0.5 font-medium">
        {part}
      </mark>
    ) : (
      <React.Fragment key={idx}>{part}</React.Fragment>
    );
  });
}

const KIND_FILTERS: Array<{ id: KindFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'spreadsheet', label: 'Sheets' },
  { id: 'document', label: 'Docs' },
  { id: 'slides', label: 'Slides' },
  { id: 'pdf', label: 'PDF' },
  { id: 'notebook', label: 'Lab' },
  { id: 'canvas', label: 'Canvas' },
  { id: 'image', label: 'Images' },
];

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  files,
  commands,
  onSelectFile,
  onOpenExternalPath,
  onReindexAll,
  onOpenIndexedFolders,
}) => {
  const [activeTab, setActiveTab] = useState<PaletteTab>('quick');
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const [status, setStatus] = useState<SemanticIndexStatus | null>(null);
  const [semanticHits, setSemanticHits] = useState<SemanticSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [reindexing, setReindexing] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchSeqRef = useRef(0);

  const nativeAvailable = useMemo(() => isNativeAiAvailable(), []);
  const workspaceFileIdSet = useMemo(() => new Set(files.map((f) => f.id)), [files]);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await getSemanticStatus();
      setStatus(next);
    } catch {
      // ignore status poll errors
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setSelectedIndex(0);
    refreshStatus();
    const timer = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 10);
    return () => clearTimeout(timer);
  }, [isOpen, refreshStatus]);

  // Quick Open & Commands filtering
  const quickItems = useMemo<QuickItem[]>(() => {
    const q = query.trim().toLowerCase();
    const sortedFiles = [...files].sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });

    const matchedFiles = sortedFiles
      .filter((f) => {
        if (!q) return true;
        return (
          f.title.toLowerCase().includes(q) ||
          f.kind.toLowerCase().includes(q) ||
          kindLabel(f.kind).toLowerCase().includes(q) ||
          f.primaryFormat.toLowerCase().includes(q) ||
          (f.previewText?.toLowerCase().includes(q) ?? false)
        );
      })
      .slice(0, q ? 12 : 8);

    const matchedCommands = commands.filter((cmd) => {
      if (!q) return true;
      return (
        cmd.label.toLowerCase().includes(q) ||
        cmd.category.toLowerCase().includes(q) ||
        (cmd.shortcut?.toLowerCase().includes(q) ?? false)
      );
    });

    const combined: QuickItem[] = [
      ...matchedFiles.map((file) => ({ type: 'file' as const, key: `f:${file.id}`, file })),
      ...matchedCommands.map((command) => ({
        type: 'command' as const,
        key: `c:${command.id}`,
        command,
      })),
    ];
    return combined;
  }, [files, commands, query]);

  // Show local matches promptly while the debounced semantic query runs.
  useEffect(() => {
    const seq = ++searchSeqRef.current;
    if (!isOpen || activeTab !== 'semantic') return;
    const trimmed = query.trim();
    if (!trimmed) {
      setSemanticHits([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    setSemanticHits([]);
    const kind = kindFilter === 'all' ? undefined : kindFilter;
    let refined = false;

    if (nativeAvailable) {
      void semanticSearchWorkspace(trimmed, kind, 15, true).then((quickHits) => {
        if (searchSeqRef.current !== seq || refined) return;
        setSemanticHits(quickHits);
        setSelectedIndex(0);
        if (quickHits.length > 0) setSearching(false);
      });
    }

    const timer = setTimeout(async () => {
      try {
        const hits = await semanticSearchWorkspace(trimmed, kind, 15);
        if (searchSeqRef.current === seq) {
          if (hits.length || !nativeAvailable) {
            refined = true;
            setSemanticHits(hits);
          }
        }
      } catch {
        if (searchSeqRef.current === seq) {
          setSemanticHits([]);
        }
      } finally {
        if (searchSeqRef.current === seq) {
          setSearching(false);
        }
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [isOpen, activeTab, query, kindFilter, nativeAvailable]);

  const activeItemCount = activeTab === 'quick' ? quickItems.length : semanticHits.length;

  useEffect(() => {
    setSelectedIndex((prev) => {
      if (activeItemCount === 0) return 0;
      return Math.min(prev, activeItemCount - 1);
    });
  }, [activeItemCount, activeTab]);

  // Keep highlighted row scrolled into view
  useEffect(() => {
    if (!isOpen) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-palette-idx="${selectedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, isOpen, activeTab]);

  const activateQuickItem = useCallback(
    (item: QuickItem) => {
      if (item.type === 'file') {
        onSelectFile(item.file.id, item.file.kind);
      } else {
        item.command.onRun();
      }
      onClose();
    },
    [onSelectFile, onClose]
  );

  const activateSemanticHit = useCallback(
    (hit: SemanticSearchHit) => {
      const isExternalDiskDoc =
        hit.docId.startsWith('file:') ||
        (Boolean(hit.path) && !workspaceFileIdSet.has(hit.docId));

      if (isExternalDiskDoc && onOpenExternalPath) {
        const targetPath = hit.path || hit.docId.replace(/^file:/, '');
        if (targetPath) {
          onOpenExternalPath(targetPath);
          onClose();
          return;
        }
      }

      onSelectFile(hit.docId, normalizeKind(hit.kind));
      onClose();
    },
    [workspaceFileIdSet, onOpenExternalPath, onSelectFile, onClose]
  );

  const handleReindexClick = async () => {
    if (reindexing) return;
    setReindexing(true);
    try {
      await Promise.resolve(onReindexAll());
      await refreshStatus();
      if (activeTab === 'semantic' && query.trim()) {
        const hits = await semanticSearchWorkspace(
          query.trim(),
          kindFilter === 'all' ? undefined : kindFilter,
          15
        );
        setSemanticHits(hits);
      }
    } finally {
      setReindexing(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      setActiveTab((prev) => (prev === 'quick' ? 'semantic' : 'quick'));
      setSelectedIndex(0);
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (activeItemCount > 0) {
        setSelectedIndex((prev) => (prev + 1) % activeItemCount);
      }
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (activeItemCount > 0) {
        setSelectedIndex((prev) => (prev - 1 + activeItemCount) % activeItemCount);
      }
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (activeTab === 'quick') {
        const item = quickItems[selectedIndex];
        if (item) activateQuickItem(item);
      } else {
        const hit = semanticHits[selectedIndex];
        if (hit) activateSemanticHit(hit);
      }
    }
  };

  if (!isOpen) return null;

  const statusPillText = status
    ? (status.embedOnline ?? status.ollamaOnline)
      ? `${status.embedBackend === 'forma-embedded' ? 'Self-Contained · ' : ''}${status.embedModel}${status.multimodal ? ' (Text + Vision)' : ''} · ${status.indexedDocs} docs · ${status.indexedChunks} chunks`
      : `Lexical fallback · ${status.indexedDocs} docs · ${status.indexedChunks} chunks`
    : 'Checking local index…';


  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Forma Command Palette and Semantic Search"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={handleKeyDown}
      className="fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-[2px] flex items-start justify-center pt-[9vh] px-4"
    >
      <div className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl border border-slate-200/90 overflow-hidden flex flex-col max-h-[78vh]">
        {/* Search Input Header */}
        <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-3 bg-white">
          {activeTab === 'semantic' ? (
            <Sparkles className="w-4 h-4 text-violet-600 shrink-0" />
          ) : (
            <Search className="w-4 h-4 text-slate-400 shrink-0" />
          )}
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder={
              activeTab === 'semantic'
                ? 'Search across all documents by meaning (e.g. "Q3 revenue assumptions", "gradient descent")…'
                : 'Jump to file or run a command…'
            }
            className="flex-1 text-sm text-slate-900 placeholder:text-slate-400 bg-transparent focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setSelectedIndex(0);
                inputRef.current?.focus();
              }}
              className="p-1 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition"
              title="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="px-1.5 py-0.5 rounded border border-slate-200 bg-slate-50 text-[10px] font-semibold text-slate-500 hover:bg-slate-100 transition"
          >
            ESC
          </button>
        </div>

        {/* Tabs + Status Pill + Actions */}
        <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1 bg-slate-200/70 p-0.5 rounded-lg">
            <button
              type="button"
              onClick={() => {
                setActiveTab('quick');
                setSelectedIndex(0);
                inputRef.current?.focus();
              }}
              className={`px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 transition ${
                activeTab === 'quick'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Command className="w-3.5 h-3.5" />
              <span>Quick Open &amp; Commands</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab('semantic');
                setSelectedIndex(0);
                inputRef.current?.focus();
              }}
              className={`px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 transition ${
                activeTab === 'semantic'
                  ? 'bg-white text-violet-700 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Semantic Search (AI Embeddings)</span>
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleReindexClick}
              disabled={reindexing}
              title="Reindex all open and saved Forma workspace documents"
              className="h-7 px-2 rounded-lg text-[11px] font-medium bg-white border border-slate-200 text-slate-700 hover:bg-slate-100 disabled:opacity-60 flex items-center gap-1 transition"
            >
              <RefreshCw className={`w-3 h-3 ${reindexing ? 'animate-spin text-violet-600' : ''}`} />
              <span>{reindexing ? 'Reindexing…' : 'Reindex All Docs'}</span>
            </button>

            {onOpenIndexedFolders && (
              <button
                type="button"
                onClick={onOpenIndexedFolders}
                title="Manage Indexed Folders"
                className="h-7 px-2 rounded-lg text-[11px] font-medium bg-white border border-slate-200 text-slate-700 hover:bg-slate-100 flex items-center gap-1 transition"
              >
                <FolderSearch className="w-3 h-3 text-blue-600" />
                <span>Indexed Folders</span>
              </button>
            )}
          </div>
        </div>

        {/* Semantic Tab Kind Filter Bar */}
        {activeTab === 'semantic' && (
          <div className="px-4 py-1.5 bg-white border-b border-slate-100 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1 overflow-x-auto">
              {KIND_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => {
                    setKindFilter(f.id);
                    setSelectedIndex(0);
                  }}
                  className={`px-2 py-0.5 rounded-full text-[11px] font-medium transition shrink-0 ${
                    kindFilter === f.id
                      ? 'bg-violet-600 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            {searching && (
              <span className="flex items-center gap-1 text-[11px] text-violet-600 shrink-0">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>Searching…</span>
              </span>
            )}
          </div>
        )}

        {/* Results List */}
        <div ref={listRef} className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5 min-h-[220px]">
          {activeTab === 'quick' ? (
            quickItems.length === 0 ? (
              <div className="py-12 text-center">
                <p className="text-sm font-medium text-slate-600">No matching files or commands</p>
                <button
                  type="button"
                  onClick={() => setActiveTab('semantic')}
                  className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-violet-50 text-violet-700 hover:bg-violet-100 transition"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Search inside document text with Semantic Search</span>
                </button>
              </div>
            ) : (
              <>
                {quickItems.some((i) => i.type === 'file') && (
                  <div className="px-2.5 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                    Workspace Files
                  </div>
                )}
                {quickItems.map((item, idx) => {
                  const isFirstCommand =
                    item.type === 'command' &&
                    (idx === 0 || quickItems[idx - 1]?.type !== 'command');
                  const isSelected = idx === selectedIndex;

                  return (
                    <React.Fragment key={item.key}>
                      {isFirstCommand && (
                        <div className="px-2.5 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                          Commands
                        </div>
                      )}
                      {item.type === 'file' ? (
                        <button
                          type="button"
                          data-palette-idx={idx}
                          onMouseEnter={() => setSelectedIndex(idx)}
                          onClick={() => activateQuickItem(item)}
                          className={`w-full px-3 py-2 rounded-xl flex items-center gap-3 text-left transition ${
                            isSelected
                              ? 'bg-slate-900 text-white shadow-xs'
                              : 'text-slate-800 hover:bg-slate-100'
                          }`}
                        >
                          {renderKindIcon(item.file.kind, 'w-4 h-4 shrink-0')}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold truncate">
                                {item.file.title}
                              </span>
                              <span
                                className={`text-[10px] px-1.5 py-0.5 rounded uppercase font-medium ${
                                  isSelected
                                    ? 'bg-slate-800 text-slate-300'
                                    : 'bg-slate-100 text-slate-500'
                                }`}
                              >
                                {item.file.primaryFormat}
                              </span>
                            </div>
                            {item.file.previewText && (
                              <p
                                className={`text-[11px] truncate mt-0.5 ${
                                  isSelected ? 'text-slate-300' : 'text-slate-500'
                                }`}
                              >
                                {item.file.previewText}
                              </p>
                            )}
                          </div>
                          <span
                            className={`text-[11px] shrink-0 ${
                              isSelected ? 'text-slate-400' : 'text-slate-400'
                            }`}
                          >
                            {formatRelativeTime(item.file.updatedAt)}
                          </span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          data-palette-idx={idx}
                          onMouseEnter={() => setSelectedIndex(idx)}
                          onClick={() => activateQuickItem(item)}
                          className={`w-full px-3 py-2 rounded-xl flex items-center justify-between gap-3 text-left transition ${
                            isSelected
                              ? 'bg-slate-900 text-white shadow-xs'
                              : 'text-slate-800 hover:bg-slate-100'
                          }`}
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span
                              className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0 ${
                                isSelected
                                  ? 'bg-slate-800 text-slate-300'
                                  : 'bg-slate-100 text-slate-500'
                              }`}
                            >
                              {item.command.category}
                            </span>
                            <span className="text-xs font-medium truncate">
                              {item.command.label}
                            </span>
                          </div>
                          {item.command.shortcut && (
                            <kbd
                              className={`text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${
                                isSelected
                                  ? 'border-slate-700 bg-slate-800 text-slate-200'
                                  : 'border-slate-200 bg-slate-50 text-slate-500'
                              }`}
                            >
                              {item.command.shortcut}
                            </kbd>
                          )}
                        </button>
                      )}
                    </React.Fragment>
                  );
                })}
              </>
            )
          ) : !query.trim() ? (
            <div className="py-10 px-6 text-center space-y-2.5">
              <div className="w-10 h-10 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center mx-auto">
                <Sparkles className="w-5 h-5" />
              </div>
              <p className="text-sm font-semibold text-slate-800">
                Local AI Semantic Search across your Forma Workspace
              </p>
              <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
                Search by concept, question, or phrase across Spreadsheets, Docs, Slides, PDFs,
                Notebooks, and indexed disk folders — 100% private and local.
              </p>
              {status && status.indexedDocs === 0 && (
                <button
                  type="button"
                  onClick={handleReindexClick}
                  disabled={reindexing}
                  className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 text-white hover:bg-violet-700 transition"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${reindexing ? 'animate-spin' : ''}`} />
                  <span>Index Workspace Documents Now</span>
                </button>
              )}
            </div>
          ) : semanticHits.length === 0 && !searching ? (
            <div className="py-12 text-center space-y-1.5">
              <p className="text-sm font-medium text-slate-700">No semantic matches found</p>
              <p className="text-xs text-slate-400">
                Try broader terms, switch the file filter to All, or click Reindex All Docs.
              </p>
            </div>
          ) : (
            semanticHits.map((hit, idx) => {
              const isSelected = idx === selectedIndex;
              const pct = Math.min(100, Math.max(1, Math.round(hit.score * 100)));
              return (
                <button
                  key={`${hit.docId}:${hit.sectionLabel ?? ''}:${idx}`}
                  type="button"
                  data-palette-idx={idx}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  onClick={() => activateSemanticHit(hit)}
                  className={`w-full px-3 py-2.5 rounded-xl text-left transition border ${
                    isSelected
                      ? 'bg-violet-50/90 border-violet-300 shadow-xs'
                      : 'bg-white border-transparent hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {renderKindIcon(hit.kind, 'w-4 h-4 shrink-0')}
                      <span className="text-xs font-semibold text-slate-900 truncate">
                        {hit.title}
                      </span>
                      {hit.sectionLabel && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 truncate max-w-[180px]">
                          {hit.sectionLabel}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span
                        className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                          hit.matchType === 'hybrid'
                            ? 'bg-violet-100 text-violet-700'
                            : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {hit.matchType === 'hybrid' ? 'AI Hybrid' : 'Lexical'} · {pct}%
                      </span>
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-slate-600 leading-relaxed line-clamp-2">
                    {renderHighlightedSnippet(hit.snippet, query)}
                  </p>
                  {hit.path && (
                    <p className="mt-1 text-[10px] text-slate-400 font-mono truncate">{hit.path}</p>
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* Footer: Ollama Status Pill + Keyboard Hints */}
        <div className="px-4 py-2 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-2 text-[11px] text-slate-500">
          <div
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full font-medium border ${
              (status?.embedOnline ?? status?.ollamaOnline)
                ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                : 'bg-amber-50 border-amber-200 text-amber-700'
            }`}
          >
            <Cpu className="w-3 h-3 shrink-0" />
            <span className="truncate max-w-[320px]">{statusPillText}</span>
          </div>

          <div className="hidden sm:flex items-center gap-3 text-[10px] text-slate-400 shrink-0">
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-white border border-slate-200 text-slate-600">
                ↑↓
              </kbd>
              Navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-white border border-slate-200 text-slate-600 inline-flex items-center">
                <CornerDownLeft className="w-2.5 h-2.5" />
              </kbd>
              Open
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-white border border-slate-200 text-slate-600">
                Tab
              </kbd>
              Switch mode
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
