import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  Code2,
  Columns2,
  Download,
  Eye,
  FolderOpen,
  Globe,
  MapPin,
  MessageSquare,
  Pencil,
  Save,
  ShieldCheck,
} from 'lucide-react';
import { DocComment } from '../../types/document';
import { DocumentExportFormat } from '../../types/office';
import {
  buildHtmlPreviewDocument,
  buildSandboxedHtmlSrcDoc,
  DEFAULT_HTML_CDN_ORIGINS,
  detectExternalHtmlOrigins,
  registerNativeHtmlPreview,
} from '../../engine/document/formats/htmlCodec';

interface Props {
  source: string;
  comments: DocComment[];
  selectedComment?: string;
  onSourceChange: (source: string) => void;
  onPin: (pin: NonNullable<DocComment['pin']>) => void;
  onSelection: (quote: string) => void;
  onSelectComment: (id: string) => void;
  onConvert: () => void;
  nativePath?: string;
  onSavePrimary?: () => void;
  onExport?: (format: DocumentExportFormat) => void;
  onPrintPdf?: () => void;
  showComments?: boolean;
  openCommentCount?: number;
  onToggleComments?: () => void;
  hasDocsFolder?: boolean;
  folderSidebarActive?: boolean;
  onClickFolderButton?: () => void;
}

export const HtmlReviewWorkspace: React.FC<Props> = ({
  source,
  comments,
  selectedComment,
  onSourceChange,
  onPin,
  onSelection,
  onSelectComment,
  onConvert,
  nativePath,
  onSavePrimary,
  onExport,
  onPrintPdf,
  showComments = false,
  openCommentCount = 0,
  onToggleComments,
  hasDocsFolder = false,
  folderSidebarActive = false,
  onClickFolderButton,
}) => {
  const [view, setView] = useState<'preview' | 'split' | 'source'>('preview');
  const [pinMode, setPinMode] = useState(false);
  const [offline, setOffline] = useState(false);
  const [approvedOrigins, setApprovedOrigins] = useState<string[]>([]);
  const [draftSource, setDraftSource] = useState(source);
  const [nativePreviewUrl, setNativePreviewUrl] = useState<string | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const iframe = useRef<HTMLIFrameElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommittedRef = useRef(source);

  useEffect(() => {
    if (source !== lastCommittedRef.current) {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      lastCommittedRef.current = source;
      setDraftSource(source);
    }
  }, [source]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        if (e.shiftKey) {
          setView((v) => (v === 'split' ? 'preview' : 'split'));
        } else {
          setView((v) => (v === 'preview' ? 'source' : 'preview'));
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleDraftChange = (next: string) => {
    setDraftSource(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      lastCommittedRef.current = next;
      onSourceChange(next);
    }, 150);
  };

  const flushDraft = () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
      lastCommittedRef.current = draftSource;
      onSourceChange(draftSource);
    }
  };

  const origins = useMemo(() => detectExternalHtmlOrigins(draftSource), [draftSource]);
  const allowed = useMemo(
    () => offline ? [] : origins.filter(origin => DEFAULT_HTML_CDN_ORIGINS.has(origin) || approvedOrigins.includes(origin)),
    [origins, offline, approvedOrigins]
  );
  const previewDocument = useMemo(() => buildHtmlPreviewDocument(draftSource), [draftSource]);
  const fallbackSrcDoc = useMemo(
    () => buildSandboxedHtmlSrcDoc(draftSource, { allowExternalOrigins: allowed }),
    [draftSource, allowed]
  );

  useEffect(() => {
    let cancelled = false;
    void registerNativeHtmlPreview(previewDocument, allowed).then((url) => {
      if (!cancelled) setNativePreviewUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [previewDocument, allowed]);

  const openPins = useMemo(
    () => comments.filter((c): c is DocComment & { pin: NonNullable<DocComment['pin']> } => !c.resolved && Boolean(c.pin)),
    [comments]
  );

  const hasBlockedOrigins = origins.some((origin) => !allowed.includes(origin));

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source === iframe.current?.contentWindow &&
        event.data?.type === 'forma-html-selection' &&
        typeof event.data.quote === 'string'
      ) {
        onSelection(event.data.quote.slice(0, 1000));
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [onSelection]);

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      {/* Single Clean Toolbar */}
      <div className="no-print h-11 px-3 border-b border-slate-200 bg-white flex items-center justify-between gap-2 shrink-0 select-none">
        <div className="flex items-center gap-2 min-w-0">
          {onClickFolderButton && (
            <button
              type="button"
              onClick={onClickFolderButton}
              title={hasDocsFolder ? 'Toggle Folder Files' : 'Open Docs Folder'}
              className={`px-2 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 border transition ${
                folderSidebarActive
                  ? 'bg-blue-50 border-blue-200 text-blue-700'
                  : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
              }`}
            >
              <FolderOpen className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Folder</span>
            </button>
          )}

          <div className="inline-flex rounded-lg bg-slate-100 p-0.5 border border-slate-200/80">
            {([
              ['preview', 'Live Preview', Eye],
              ['split', 'Split', Columns2],
              ['source', 'HTML Source', Code2],
            ] as const).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => setView(id)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 transition ${
                  view === id
                    ? 'bg-white text-blue-700 shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{label}</span>
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setPinMode((v) => !v)}
            title="Click anywhere on the preview to drop a spatial review pin"
            className={`px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 border transition ${
              pinMode
                ? 'bg-blue-600 border-blue-600 text-white shadow-2xs'
                : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
            }`}
          >
            <MapPin className="w-3.5 h-3.5" />
            <span>Drop Pin Comment</span>
          </button>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {origins.length > 0 && (
            hasBlockedOrigins ? (
              <button
                type="button"
                onClick={() => { setApprovedOrigins(origins); setOffline(false); }}
                title={`Allow external libraries: ${origins.join(', ')}`}
                className="px-2.5 py-1 rounded-md bg-amber-50 hover:bg-amber-100 border border-amber-300 text-amber-900 text-xs font-medium flex items-center gap-1.5 transition max-w-[260px] truncate"
              >
                <Globe className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                <span className="truncate">Load CDNs ({origins.length})</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => { setApprovedOrigins([]); setOffline(true); }}
                title={`External libraries allowed (${allowed.join(', ')}). Click to lock back to offline sandbox.`}
                className="px-2.5 py-1 rounded-md bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-800 text-xs font-medium flex items-center gap-1.5 transition"
              >
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span className="hidden md:inline">CDNs Active</span>
              </button>
            )
          )}

          {onToggleComments && (
            <button
              type="button"
              onClick={onToggleComments}
              title="Toggle Review Comments"
              className={`px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 border transition ${
                showComments
                  ? 'bg-blue-50 border-blue-200 text-blue-700'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <MessageSquare className="w-3.5 h-3.5" />
              <span>Comments</span>
              {openCommentCount > 0 && (
                <span className="px-1.5 py-0.2 rounded-full bg-blue-600 text-white text-[10px] font-semibold">
                  {openCommentCount}
                </span>
              )}
            </button>
          )}

          {onSavePrimary && (
            <button
              type="button"
              onClick={() => {
                flushDraft();
                onSavePrimary();
              }}
              title={nativePath ? `Save ${nativePath} (⌘S)` : 'Save HTML (⌘S)'}
              className="px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold flex items-center gap-1.5 shadow-2xs transition"
            >
              <Save className="w-3.5 h-3.5" />
              <span>Save .html</span>
            </button>
          )}

          {(onExport || onPrintPdf) && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowExportMenu((v) => !v)}
                className="px-2.5 py-1 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold flex items-center gap-1 shadow-2xs transition"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export</span>
                <ChevronDown className="w-3 h-3" />
              </button>
              {showExportMenu && (
                <div
                  className="absolute right-0 mt-1 w-44 rounded-lg bg-white border border-slate-200 shadow-lg py-1 z-30 text-xs text-slate-700"
                  onMouseLeave={() => setShowExportMenu(false)}
                >
                  {onExport && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setShowExportMenu(false);
                          flushDraft();
                          onExport('html');
                        }}
                        className="w-full text-left px-3 py-1.5 hover:bg-slate-100"
                      >
                        Export HTML (.html)
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowExportMenu(false);
                          flushDraft();
                          onExport('docx');
                        }}
                        className="w-full text-left px-3 py-1.5 hover:bg-slate-100"
                      >
                        Export Word (.docx)
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowExportMenu(false);
                          flushDraft();
                          onExport('md');
                        }}
                        className="w-full text-left px-3 py-1.5 hover:bg-slate-100"
                      >
                        Export Markdown (.md)
                      </button>
                    </>
                  )}
                  {onPrintPdf && (
                    <button
                      type="button"
                      onClick={() => {
                        setShowExportMenu(false);
                        onPrintPdf();
                      }}
                      className="w-full text-left px-3 py-1.5 hover:bg-slate-100 border-t border-slate-100 mt-1 pt-1.5"
                    >
                      Print / Save as PDF…
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              flushDraft();
              onConvert();
            }}
            className="px-2.5 py-1 rounded-md bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 text-xs font-medium flex items-center gap-1.5 transition"
          >
            <Pencil className="w-3.5 h-3.5" />
            <span>Convert to Editable Doc</span>
          </button>
        </div>
      </div>

      {/* Main Split / Preview Canvas */}
      <div className="flex flex-1 min-h-0 min-w-0">
        {view !== 'preview' && (
          <textarea
            aria-label="HTML Source Editor"
            className="flex-1 min-w-0 p-4 font-mono text-xs leading-relaxed resize-none border-r border-slate-200 focus:outline-none bg-white text-slate-900"
            spellCheck={false}
            value={draftSource}
            onChange={(e) => handleDraftChange(e.target.value)}
            onBlur={flushDraft}
          />
        )}
        {view !== 'source' && (
          <div className="relative flex-1 min-w-0 bg-white">
            <iframe
              ref={iframe}
              aria-label="Live HTML Preview"
              sandbox="allow-scripts"
              src={nativePreviewUrl ?? undefined}
              srcDoc={nativePreviewUrl ? undefined : fallbackSrcDoc}
              className="w-full h-full border-0"
            />
            {pinMode && (
              <div
                aria-label="Place pin"
                className="absolute inset-0 cursor-crosshair bg-blue-500/5 flex items-start justify-center pt-3 pointer-events-auto"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  if (r.width && r.height) {
                    onPin({
                      xPct: Math.max(0, Math.min(100, Math.round(((e.clientX - r.left) / r.width) * 100))),
                      yPct: Math.max(0, Math.min(100, Math.round(((e.clientY - r.top) / r.height) * 100))),
                    });
                  }
                  setPinMode(false);
                }}
              >
                <span className="px-2.5 py-1 rounded-full bg-slate-900/80 text-white text-xs shadow pointer-events-none">
                  Click anywhere to drop review pin
                </span>
              </div>
            )}
            {openPins.map((c, i) => (
              <button
                key={c.id}
                type="button"
                aria-label={`Pin ${i + 1}`}
                title={`${c.author}: ${c.text}`}
                onClick={() => onSelectComment(c.id)}
                style={{ left: `${c.pin.xPct}%`, top: `${c.pin.yPct}%` }}
                className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full w-6 h-6 text-white text-xs font-semibold shadow-md transition ${
                  selectedComment === c.id
                    ? 'bg-amber-500 ring-4 ring-amber-200 scale-110'
                    : 'bg-blue-600 hover:bg-blue-700'
                }`}
              >
                {i + 1}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
