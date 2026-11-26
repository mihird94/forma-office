import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BookMarked,
  BookOpen,
  Code2,
  Database,
  Eye,
  EyeOff,
  FolderOpen,
  GitBranch,
  Play,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Table2,
  Trash2,
  Variable,
  X,
  Zap,
} from 'lucide-react';
import {
  CellTraceData,
  FormaTablePayload,
  LabFolderWorkspace,
  LiveVariable,
  NotebookCell,
  NotebookCellType,
  NotebookData,
  NotebookOutput,
  NotebookViewMode,
  PythonEnvInfo,
  RichDataBundle,
} from '../../types/notebook';
import {
  dirnamePath,
  executeKernelCode,
  executeSqlCode,
  interruptKernel,
  isNativeKernelAvailable,
  listPythonEnvs,
  readWorkspaceFile,
  restartKernel,
  traceKernelCode,
  writeWorkspaceFile,
} from '../../storage/notebookStore';
import {
  exportNotebookToIpynb,
  exportNotebookToMarkdown,
  exportNotebookToPython,
} from '../../engine/notebook/ipynbCodec';
import { renderLatexOutput, renderMathMarkdown } from '../../engine/notebook/mathMarkdown';
import { sanitizeDocumentHtml } from '../../utils/documentSecurity';
import { highlightPythonToHtml } from '../../engine/notebook/pythonHighlight';
import {
  CellParameterSlider,
  buildNotebookDependencyGraph,
  extractCellParameters,
  updateParameterInSource,
} from '../../engine/notebook/cellGraph';
import { uid } from '../../engine/spreadsheet/workbookOps';
import { triggerFileDownload, wasNativeSaveCancelled } from '../../storage/workspaceStore';
import { NotebookRibbon } from './NotebookRibbon';
import { FolderExplorer } from './FolderExplorer';
import { PythonCodeEditor } from './PythonCodeEditor';
import { CellTracePanel } from './CellTracePanel';
import { DataFrameViewer } from './DataFrameViewer';
import { ContextMenu, ContextMenuItem } from '../common/ContextMenu';
import {
  READING_THEME_STYLES,
  ReadingTheme,
  loadReadingTheme,
} from '../common/ReadingModePicker';
import { ZoomControl } from '../common/ZoomControl';
import { useAppZoom } from '../../utils/useAppZoom';

interface NotebookAppProps {
  notebook: NotebookData;
  labFolder: LabFolderWorkspace | null;
  onChangeNotebook: (updated: NotebookData) => void;
  onImportNotebookFile: (file: File) => void;
  onPickLabFolder: () => void;
  onRefreshLabFolder: () => void;
  onOpenFolderNotebook: (path: string) => void;
  onCreateNotebookInDir: (dirPath: string) => void;
  onNotify: (msg: string) => void;
}

function attachmentBundleToDataUri(bundle: RichDataBundle): string | null {
  const preferredMimes = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/gif', 'image/webp'];
  for (const mime of preferredMimes) {
    const raw = bundle[mime];
    if (raw === undefined || raw === null) continue;
    const str = Array.isArray(raw) ? raw.map(String).join('') : String(raw);
    if (!str.trim()) continue;
    if (mime === 'image/svg+xml' && str.trimStart().startsWith('<')) {
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(str)}`;
    }
    const base64 = str.replace(/\s+/g, '');
    if (/^[A-Za-z0-9+/]+=*$/.test(base64)) return `data:${mime};base64,${base64}`;
  }
  return null;
}

function renderMarkdownWithAttachments(
  source: string,
  attachments?: Record<string, RichDataBundle>
): string {
  const html = renderMathMarkdown(source);
  if (!attachments || Object.keys(attachments).length === 0) return html;
  return html.replace(/src=(["'])attachment:([^"']+)\1/gi, (match, quote: string, rawName: string) => {
    let decodedName = rawName;
    try {
      decodedName = decodeURIComponent(rawName);
    } catch {
      // keep rawName if malformed URI sequence
    }
    const bundle = attachments[rawName] ?? attachments[decodedName];
    if (!bundle) return match;
    const dataUri = attachmentBundleToDataUri(bundle);
    return dataUri ? `src=${quote}${dataUri}${quote}` : match;
  });
}

function parseFormaTable(raw: unknown): FormaTablePayload | null {
  if (!raw) return null;
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Partial<FormaTablePayload>;
  if (!Array.isArray(rec.columns) || !Array.isArray(rec.rows)) return null;
  return {
    columns: rec.columns.map(String),
    dtypes: Array.isArray(rec.dtypes) ? rec.dtypes.map(String) : undefined,
    rows: rec.rows,
    totalRows: typeof rec.totalRows === 'number' ? rec.totalRows : rec.rows.length,
    totalCols: typeof rec.totalCols === 'number' ? rec.totalCols : rec.columns.length,
    truncated: Boolean(rec.truncated),
  };
}

/** Normalize SQL cells as nbformat-v4.5-compatible `code` cells prefixed with `%%sql` on export/save. */
function prepareNotebookForExport(nb: NotebookData): NotebookData {
  if (!nb.cells.some((c) => c.cell_type === 'sql')) return nb;
  return {
    ...nb,
    cells: nb.cells.map((c) => {
      if (c.cell_type !== 'sql') return c;
      const trimmed = c.source.trimStart();
      const source = trimmed.startsWith('%%sql') ? c.source : `%%sql\n${c.source}`;
      return {
        ...c,
        cell_type: 'code',
        source,
        metadata: {
          ...c.metadata,
          forma: {
            ...(c.metadata?.forma as Record<string, unknown> | undefined),
            cellKind: 'sql',
          },
        },
      };
    }),
  };
}

const SqlCodeEditor: React.FC<{
  value: string;
  theme: ReadingTheme;
  onChange: (nextValue: string) => void;
  onRunAdvance: () => void;
  onRunInPlace: () => void;
}> = ({ value, theme, onChange, onRunAdvance, onRunInPlace }) => {
  const lineCount = Math.max(1, value.split('\n').length);
  const isDark = theme === 'dark';
  const isWarm = theme === 'sepia' || theme === 'paperwhite';
  const editorMinHeight = Math.max(2, lineCount) * 21 + 24;

  const containerClass = isDark
    ? 'bg-[#0f171e] text-teal-50'
    : isWarm
      ? 'bg-[#faf6ec] text-slate-900'
      : 'bg-[#f8fcfc] text-slate-900';

  const gutterClass = isDark
    ? 'bg-[#0b1218] border-teal-900/50 text-teal-600/70'
    : isWarm
      ? 'bg-[#f2ebd9] border-[#e2d6b8] text-[#9b8a6b]'
      : 'bg-teal-50/50 border-teal-200/70 text-teal-500/80';

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      onRunAdvance();
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onRunInPlace();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget;
      const s = ta.selectionStart;
      const end = ta.selectionEnd;
      const nextVal = value.slice(0, s) + '  ' + value.slice(end);
      onChange(nextVal);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = s + 2;
      });
    }
  };

  return (
    <div className={`relative flex font-mono text-[13px] ${containerClass}`}>
      <div
        aria-hidden="true"
        className={`py-3 px-2.5 text-right text-[11px] leading-[21px] border-r select-none shrink-0 tabular-nums min-w-[40px] ${gutterClass}`}
      >
        {Array.from({ length: Math.max(1, lineCount) }, (_, idx) => (
          <div key={idx}>{idx + 1}</div>
        ))}
      </div>
      <textarea
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        aria-label="SQL query cell"
        placeholder="-- Write SQL (DuckDB / SQLite) over live DataFrames or local CSV/Parquet files · Shift+Enter to run"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        style={{ minHeight: editorMinHeight, lineHeight: '21px' }}
        className={`flex-1 w-full m-0 py-3 px-3.5 bg-transparent resize-none focus:outline-none overflow-x-auto overflow-y-hidden whitespace-pre font-mono text-[13px] ${
          isDark
            ? 'text-teal-50 placeholder-slate-600 caret-teal-300'
            : 'text-slate-900 placeholder-slate-400 caret-teal-700'
        }`}
      />
    </div>
  );
};

const OutputView: React.FC<{ outputs: NotebookOutput[]; dark: boolean }> = ({ outputs, dark }) => {
  const [rawModeByIdx, setRawModeByIdx] = useState<Record<number, boolean>>({});

  if (!outputs || outputs.length === 0) return null;

  return (
    <div
      className={`border-t px-4 py-2.5 space-y-2 text-xs ${
        dark ? 'border-slate-700/80 bg-slate-900/40' : 'border-slate-200/80 bg-slate-50/70'
      }`}
    >
      {outputs.map((out, i) => {
        if (out.output_type === 'stream') {
          return (
            <pre
              key={i}
              className={`font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words overflow-x-auto ${
                out.name === 'stderr'
                  ? 'text-rose-600 bg-rose-50/80 px-2.5 py-1.5 rounded'
                  : dark
                    ? 'text-slate-200'
                    : 'text-slate-800'
              }`}
            >
              {out.text}
            </pre>
          );
        }

        if (out.output_type === 'error') {
          return (
            <div
              key={i}
              className="bg-rose-50 border border-rose-200 text-rose-900 rounded-lg p-3 font-mono text-[11.5px] overflow-x-auto"
            >
              <div className="font-bold text-rose-700 mb-1">
                {out.ename}: {out.evalue}
              </div>
              <pre className="whitespace-pre-wrap leading-relaxed text-rose-800/90">
                {out.traceback.join('\n')}
              </pre>
            </div>
          );
        }

        const data = out.data;
        const tablePayload = parseFormaTable(data['application/vnd.forma.table+json']);
        const hasRawFallback = Boolean(data['text/html'] || data['text/plain']);
        const showRaw = Boolean(rawModeByIdx[i]);

        if (tablePayload) {
          return (
            <div key={i} className="space-y-1.5 py-0.5">
              {hasRawFallback && (
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() =>
                      setRawModeByIdx((prev) => ({
                        ...prev,
                        [i]: !prev[i],
                      }))
                    }
                    className={`px-2 py-0.5 rounded text-[10.5px] font-medium border flex items-center gap-1 transition ${
                      dark
                        ? 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                        : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    <Table2 className="w-3 h-3" />
                    <span>{showRaw ? 'Interactive Table' : 'Raw Output'}</span>
                  </button>
                </div>
              )}
              {!showRaw ? (
                <DataFrameViewer payload={tablePayload} dark={dark} />
              ) : data['text/html'] ? (
                <div
                  className="forma-nb-html-out overflow-x-auto py-1"
                  dangerouslySetInnerHTML={{ __html: sanitizeDocumentHtml(data['text/html']) }}
                />
              ) : (
                <pre
                  className={`font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words overflow-x-auto ${
                    dark ? 'text-violet-200' : 'text-slate-900'
                  }`}
                >
                  {data['text/plain']}
                </pre>
              )}
            </div>
          );
        }

        if (data['image/png']) {
          return (
            <div key={i} className="py-1">
              <img
                src={`data:image/png;base64,${data['image/png'].replace(/\s+/g, '')}`}
                alt="Notebook plot output"
                className="max-w-full h-auto rounded-lg border border-slate-200 bg-white shadow-xs"
              />
            </div>
          );
        }
        if (data['image/jpeg']) {
          return (
            <div key={i} className="py-1">
              <img
                src={`data:image/jpeg;base64,${data['image/jpeg'].replace(/\s+/g, '')}`}
                alt="Notebook image output"
                className="max-w-full h-auto rounded-lg border border-slate-200 bg-white"
              />
            </div>
          );
        }
        if (data['image/svg+xml']) {
          return (
            <div key={i} className="py-1 bg-white p-2 rounded-lg border border-slate-200 overflow-x-auto">
              <img
                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(data['image/svg+xml'])}`}
                alt="Notebook plot output"
                className="max-w-full h-auto"
              />
            </div>
          );
        }
        if (data['text/html']) {
          return (
            <div
              key={i}
              className="forma-nb-html-out overflow-x-auto py-1"
              dangerouslySetInnerHTML={{ __html: sanitizeDocumentHtml(data['text/html']) }}
            />
          );
        }
        if (data['text/latex']) {
          return (
            <div
              key={i}
              className="py-1 overflow-x-auto"
              dangerouslySetInnerHTML={{ __html: sanitizeDocumentHtml(renderLatexOutput(data['text/latex'])) }}
            />
          );
        }
        if (data['text/plain']) {
          return (
            <pre
              key={i}
              className={`font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words overflow-x-auto ${
                dark ? 'text-violet-200' : 'text-slate-900'
              }`}
            >
              {data['text/plain']}
            </pre>
          );
        }
        return null;
      })}
    </div>
  );
};

export const NotebookApp: React.FC<NotebookAppProps> = ({
  notebook,
  labFolder,
  onChangeNotebook,
  onImportNotebookFile,
  onPickLabFolder,
  onRefreshLabFolder,
  onOpenFolderNotebook,
  onCreateNotebookInDir,
  onNotify,
}) => {
  const [viewMode, setViewMode] = useState<NotebookViewMode>('lab');
  const [readingTheme, setReadingTheme] = useState<ReadingTheme>(() => loadReadingTheme());
  const { zoom, zoomIn, zoomOut, zoomReset } = useAppZoom({
    initial: 1.0,
    min: 0.75,
    max: 1.6,
    step: 0.1,
  });
  const [sidebarTab, setSidebarTab] = useState<'files' | 'outline' | 'vars'>(() =>
    labFolder ? 'files' : 'outline'
  );
  const [showSidebar, setShowSidebar] = useState(true);
  const [previewFile, setPreviewFile] = useState<{ name: string; path: string; content: string } | null>(
    null
  );

  const prevFolderRootRef = useRef<string | null>(labFolder?.rootPath ?? null);
  useEffect(() => {
    const nextRoot = labFolder?.rootPath ?? null;
    if (nextRoot && nextRoot !== prevFolderRootRef.current) {
      setSidebarTab('files');
      setShowSidebar(true);
    }
    prevFolderRootRef.current = nextRoot;
  }, [labFolder?.rootPath]);

  useEffect(() => {
    const w = window as unknown as { __formaToggleReadingMode?: () => void };
    const toggle = () => setShowSidebar((v) => !v);
    w.__formaToggleReadingMode = toggle;

    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        setShowSidebar((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (w.__formaToggleReadingMode === toggle) delete w.__formaToggleReadingMode;
    };
  }, []);

  const [activeCellId, setActiveCellId] = useState<string>(() => notebook.cells[0]?.id ?? '');
  const [editingMarkdownId, setEditingMarkdownId] = useState<string | null>(null);
  const [runningCellId, setRunningCellId] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const [switchingKernel, setSwitchingKernel] = useState(false);
  const runSequenceRef = useRef(0);
  const runAllActiveRef = useRef(false);
  const kernelTransitionRef = useRef(false);
  const executionActiveRef = useRef(false);
  const [liveStream, setLiveStream] = useState<{
    cellId: string;
    stdout: string;
    stderr: string;
  } | null>(null);
  const [reactiveMode, setReactiveMode] = useState(true);
  const [autoSliderCells, setAutoSliderCells] = useState<Set<string>>(() => new Set());
  const [cellTraces, setCellTraces] = useState<
    Record<string, { data: CellTraceData; stepIndex: number }>
  >({});
  const [revealedInStudy, setRevealedInStudy] = useState<Set<string>>(() => new Set());
  const sliderRunTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const reactiveModeRef = useRef(reactiveMode);
  reactiveModeRef.current = reactiveMode;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (sliderRunTimerRef.current !== null) {
        window.clearTimeout(sliderRunTimerRef.current);
        sliderRunTimerRef.current = null;
      }
    };
  }, []);

  const [kernelAvailable] = useState<boolean>(() => isNativeKernelAvailable());
  const [envs, setEnvs] = useState<PythonEnvInfo[]>([]);
  const [activePythonPath, setActivePythonPath] = useState<string>('');
  const [variables, setVariables] = useState<LiveVariable[]>([]);

  const [cellMenu, setCellMenu] = useState<{ x: number; y: number; cellId: string } | null>(null);

  const cellRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const nbRef = useRef(notebook);
  nbRef.current = notebook;

  // Discover local Python / Conda / Venv environments when inside Forma Lab.app
  useEffect(() => {
    if (!kernelAvailable) return;
    void listPythonEnvs()
      .then((res) => {
        setEnvs(res.envs);
        if (res.activePath) setActivePythonPath(res.activePath);
        else if (res.envs[0]) setActivePythonPath(res.envs[0].path);
      })
      .catch(() => {});
  }, [kernelAvailable]);

  // Reset active cell when switching notebook tabs
  useEffect(() => {
    runSequenceRef.current += 1;
    runAllActiveRef.current = false;
    setRunningAll(false);
    setActiveCellId(notebook.cells[0]?.id ?? '');
    setEditingMarkdownId(null);
  }, [notebook.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateCells = useCallback(
    (updater: (cells: NotebookCell[]) => NotebookCell[]) => {
      const next = {
        ...nbRef.current,
        cells: updater(nbRef.current.cells),
        updatedAt: Date.now(),
      };
      nbRef.current = next;
      onChangeNotebook(next);
    },
    [onChangeNotebook]
  );

  const updateCell = useCallback(
    (cellId: string, patch: Partial<NotebookCell>) => {
      updateCells((cells) => cells.map((c) => (c.id === cellId ? { ...c, ...patch } : c)));
    },
    [updateCells]
  );

  const insertCellAfter = useCallback(
    (afterCellId: string | null, cellType: NotebookCellType) => {
      const isExecutable = cellType === 'code' || cellType === 'sql';
      const newCell: NotebookCell = {
        id: uid('cell'),
        cell_type: cellType,
        source: '',
        execution_count: isExecutable ? null : undefined,
        outputs: isExecutable ? [] : undefined,
      };
      updateCells((cells) => {
        const idx = afterCellId ? cells.findIndex((c) => c.id === afterCellId) : cells.length - 1;
        const next = [...cells];
        next.splice(idx + 1, 0, newCell);
        return next;
      });
      setActiveCellId(newCell.id);
      if (cellType === 'markdown') setEditingMarkdownId(newCell.id);
    },
    [updateCells]
  );

  // Live AST Dependency Graph across code cells
  const depGraph = useMemo(() => buildNotebookDependencyGraph(notebook.cells), [notebook.cells]);
  const depGraphRef = useRef(depGraph);
  depGraphRef.current = depGraph;

  const staleCellIds = useMemo(
    () => new Set(notebook.cells.filter((c) => c.stale).map((c) => c.id)),
    [notebook.cells]
  );

  const runSingleCell = useCallback(
    async (cellId: string, sourceOverride?: string): Promise<boolean> => {
      const startNbId = nbRef.current.id;
      const cell = nbRef.current.cells.find((c) => c.id === cellId);
      if (!cell || (cell.cell_type !== 'code' && cell.cell_type !== 'sql')) return false;
      if (executionActiveRef.current || kernelTransitionRef.current) return false;
      executionActiveRef.current = true;
      const codeToRun = sourceOverride !== undefined ? sourceOverride : cell.source;

      setRunningCellId(cellId);
      setLiveStream({ cellId, stdout: '', stderr: '' });
      try {
        const cwd = dirnamePath(nbRef.current.nativePath) || labFolder?.rootPath;
        const res =
          cell.cell_type === 'sql'
            ? await executeSqlCode(codeToRun, activePythonPath || undefined, cwd)
            : await executeKernelCode(
                codeToRun,
                activePythonPath || undefined,
                cwd,
                (streamName, chunkText) => {
                  if (!mountedRef.current || nbRef.current.id !== startNbId) return;
                  setLiveStream((prev) => {
                    if (!prev || prev.cellId !== cellId) {
                      return {
                        cellId,
                        stdout: streamName === 'stdout' ? chunkText : '',
                        stderr: streamName === 'stderr' ? chunkText : '',
                      };
                    }
                    return {
                      cellId,
                      stdout:
                        streamName === 'stdout'
                          ? (prev.stdout + chunkText).slice(-256000)
                          : prev.stdout,
                      stderr:
                        streamName === 'stderr'
                          ? (prev.stderr + chunkText).slice(-256000)
                          : prev.stderr,
                    };
                  });
                }
              );
        if (!mountedRef.current || nbRef.current.id !== startNbId) return false;
        updateCell(cellId, {
          execution_count: res.execution_count,
          outputs: res.outputs.length || res.ok ? res.outputs : [{ output_type: 'error', ename: 'KernelError', evalue: res.error ?? 'Execution failed', traceback: [res.error ?? 'Execution failed'] }],
          lastRunMs: res.elapsed_ms,
          stale: false,
        });
        setVariables(res.variables);
        return res.ok;
      } catch (err) {
        if (!mountedRef.current || nbRef.current.id !== startNbId) return false;
        updateCell(cellId, {
          outputs: [
            {
              output_type: 'error',
              ename: 'KernelError',
              evalue: (err as Error).message,
              traceback: [(err as Error).message],
            },
          ],
        });
        return false;
      } finally {
        executionActiveRef.current = false;
        if (mountedRef.current) {
          setRunningCellId((current) => current === cellId ? null : current);
          setLiveStream((prev) => (prev?.cellId === cellId ? null : prev));
        }
      }
    },
    [activePythonPath, labFolder?.rootPath, updateCell]
  );

  const runCellById = useCallback(
    async (cellId: string, advance = false, sourceOverride?: string, forceCascade = false) => {
      if (runAllActiveRef.current || kernelTransitionRef.current) return;
      const cell = nbRef.current.cells.find((c) => c.id === cellId);
      if (!cell) return;

      if (cell.cell_type !== 'code' && cell.cell_type !== 'sql') {
        setEditingMarkdownId(null);
        if (advance) {
          const idx = nbRef.current.cells.findIndex((c) => c.id === cellId);
          if (idx >= 0 && idx + 1 < nbRef.current.cells.length) {
            setActiveCellId(nbRef.current.cells[idx + 1].id);
          }
        }
        return;
      }

      if (!kernelAvailable) {
        onNotify('Open this notebook in Forma Lab.app to execute Python & SQL natively');
        return;
      }

      const startNbId = nbRef.current.id;
      const ok = await runSingleCell(cellId, sourceOverride);
      if (!mountedRef.current || nbRef.current.id !== startNbId) return;

      // Reactive DAG cascade: automatically re-run transitive downstream dependent cells
      if (ok && cell.cell_type === 'code' && (forceCascade || reactiveModeRef.current)) {
        const downstreamIds = depGraphRef.current.getTransitiveDownstream(cellId);
        for (const depId of downstreamIds) {
          if (!mountedRef.current || nbRef.current.id !== startNbId) break;
          const depOk = await runSingleCell(depId);
          if (!depOk) break;
        }
      }

      if (advance) {
        const idx = nbRef.current.cells.findIndex((c) => c.id === cellId);
        if (idx >= 0 && idx + 1 < nbRef.current.cells.length) {
          setActiveCellId(nbRef.current.cells[idx + 1].id);
        }
      }
    },
    [kernelAvailable, runSingleCell, onNotify]
  );

  const traceCellById = useCallback(
    async (cellId: string) => {
      const startNbId = nbRef.current.id;
      const cell = nbRef.current.cells.find((c) => c.id === cellId);
      if (!cell || cell.cell_type !== 'code') return;
      if (!kernelAvailable) {
        onNotify('Open this notebook in Forma Lab.app to trace Python execution step-by-step');
        return;
      }
      if (executionActiveRef.current || kernelTransitionRef.current || runAllActiveRef.current) return;
      executionActiveRef.current = true;
      setActiveCellId(cellId);
      setRunningCellId(cellId);
      try {
        const cwd = dirnamePath(nbRef.current.nativePath) || labFolder?.rootPath;
        const res = await traceKernelCode(cell.source, activePythonPath || undefined, cwd);
        if (!mountedRef.current || nbRef.current.id !== startNbId) return;
        updateCell(cellId, {
          execution_count: res.execution_count,
          outputs: res.outputs,
          lastRunMs: res.elapsed_ms,
          stale: false,
        });
        setVariables(res.variables);
        if (!res.ok) {
          onNotify(`Trace stopped: ${res.error ?? 'execution did not complete'}`);
        } else if (res.trace && res.trace.steps.length > 0) {
          setCellTraces((prev) => ({
            ...prev,
            [cellId]: { data: res.trace!, stepIndex: 0 },
          }));
          onNotify(`Recorded ${res.trace.steps.length} execution steps — scrub timeline below`);
        } else {
          onNotify('Cell executed (no traceable lines recorded)');
        }
      } catch (err) {
        if (!mountedRef.current || nbRef.current.id !== startNbId) return;
        onNotify(`Trace failed: ${(err as Error).message}`);
      } finally {
        executionActiveRef.current = false;
        if (mountedRef.current) {
          setRunningCellId((current) => current === cellId ? null : current);
        }
      }
    },
    [kernelAvailable, activePythonPath, labFolder?.rootPath, updateCell, onNotify]
  );

  const handleSliderChange = useCallback(
    (cellId: string, param: CellParameterSlider, nextVal: number) => {
      const cell = nbRef.current.cells.find((c) => c.id === cellId);
      if (!cell) return;
      const nextSource = updateParameterInSource(cell.source, param, nextVal);
      updateCell(cellId, { source: nextSource, stale: true });
      if (!kernelAvailable) return;
      if (sliderRunTimerRef.current !== null) {
        window.clearTimeout(sliderRunTimerRef.current);
      }
      sliderRunTimerRef.current = window.setTimeout(() => {
        sliderRunTimerRef.current = null;
        void runCellById(cellId, false, nextSource, true);
      }, 65);
    },
    [kernelAvailable, updateCell, runCellById]
  );

  const handleSaveToDisk = useCallback(async () => {
    const nb = nbRef.current;
    if (!nb.nativePath) return;
    try {
      const ok = await writeWorkspaceFile(nb.nativePath, exportNotebookToIpynb(prepareNotebookForExport(nb)));
      if (ok) {
        onNotify(`Saved ${nb.nativePath.split('/').pop()}`);
      } else {
        onNotify('Could not save notebook to disk');
      }
    } catch (err) {
      onNotify(`Save failed: ${(err as Error).message}`);
    }
  }, [onNotify]);


  const handlePreviewTextFile = useCallback(
    async (filePath: string, name: string) => {
      try {
        const res = await readWorkspaceFile(filePath);
        if (res) {
          setPreviewFile({ name, path: filePath, content: res.content });
        } else {
          onNotify(`Could not preview ${name}`);
        }
      } catch (err) {
        onNotify(`Preview failed: ${(err as Error).message}`);
      }
    },
    [onNotify]
  );

  const runAllCells = useCallback(async () => {
    if (!kernelAvailable) {
      onNotify('Open in Forma Lab.app to execute Python & SQL cells');
      return;
    }
    if (runAllActiveRef.current || kernelTransitionRef.current || executionActiveRef.current) return;
    const sequence = ++runSequenceRef.current;
    const notebookId = nbRef.current.id;
    const cellIds = nbRef.current.cells.filter(cell => cell.cell_type === 'code' || cell.cell_type === 'sql').map(cell => cell.id);
    runAllActiveRef.current = true;
    setRunningAll(true);
    try {
      for (const id of cellIds) {
        if (!mountedRef.current || nbRef.current.id !== notebookId || sequence !== runSequenceRef.current) return;
        const ok = await runSingleCell(id);
        if (!mountedRef.current || nbRef.current.id !== notebookId || sequence !== runSequenceRef.current) return;
        if (!ok) {
          onNotify('Run All stopped because a cell did not complete');
          return;
        }
      }
      onNotify('Finished running all cells');
    } finally {
      if (sequence === runSequenceRef.current) {
        runAllActiveRef.current = false;
        if (mountedRef.current) setRunningAll(false);
      }
    }
  }, [kernelAvailable, runSingleCell, onNotify]);

  const handleRestartKernel = async (nextPythonPath?: string) => {
    const targetPath = nextPythonPath ?? activePythonPath;
    if (!kernelAvailable || kernelTransitionRef.current) return;
    runSequenceRef.current += 1;
    runAllActiveRef.current = false;
    setRunningAll(false);
    kernelTransitionRef.current = true;
    setSwitchingKernel(true);
    try {
      await restartKernel(targetPath || undefined);
      if (nextPythonPath) setActivePythonPath(nextPythonPath);
      setVariables([]);
      onNotify(nextPythonPath ? `Switched kernel to ${nextPythonPath.split('/').slice(-3).join('/')}` : 'Python kernel restarted');
    } catch (err) {
      onNotify(`Kernel restart failed: ${(err as Error).message}`);
    } finally {
      kernelTransitionRef.current = false;
      if (mountedRef.current) setSwitchingKernel(false);
    }
  };

  const handleInterruptKernel = async () => {
    runSequenceRef.current += 1;
    runAllActiveRef.current = false;
    setRunningAll(false);
    try {
      await interruptKernel();
    } catch (err) {
      onNotify(`Could not interrupt kernel: ${(err as Error).message}`);
    }
  };

  // Extract live Chapter / Heading Outline from all Markdown cells
  const outline = useMemo(() => {
    const items: Array<{ cellId: string; level: number; text: string; pinned?: boolean }> = [];
    for (const cell of notebook.cells) {
      if (cell.cell_type !== 'markdown') continue;
      const lines = cell.source.split('\n');
      for (const line of lines) {
        const m = /^(#{1,3})\s+(.+)$/.exec(line.trim());
        if (m) {
          items.push({
            cellId: cell.id,
            level: m[1].length,
            text: m[2].replace(/[*_`]/g, ''),
            pinned: cell.pinnedConcept,
          });
        }
      }
    }
    return items;
  }, [notebook.cells]);

  const handleExport = async (fmt: 'ipynb' | 'py' | 'md') => {
    try {
    const safe = notebook.title.replace(/[^a-zA-Z0-9._ -]/g, '_') || 'Notebook';
    const exportNb = prepareNotebookForExport(notebook);
    let savedPath: string | undefined;
    if (fmt === 'ipynb') {
      savedPath = await triggerFileDownload(exportNotebookToIpynb(exportNb), `${safe}.ipynb`, 'application/x-ipynb+json');
    } else if (fmt === 'py') {
      savedPath = await triggerFileDownload(exportNotebookToPython(exportNb), `${safe}.py`, 'text/x-python;charset=utf-8');
    } else {
      savedPath = await triggerFileDownload(exportNotebookToMarkdown(exportNb), `${safe}.md`, 'text/markdown;charset=utf-8');
    }
    if (wasNativeSaveCancelled(savedPath)) return;
    onNotify(`Saved ${savedPath ? savedPath.split('/').pop() : `${safe}.${fmt}`}`);
    } catch (err) { onNotify((err as Error).message); }
  };

  const triggerPrint = () => {
    const webkit = (
      window as unknown as {
        webkit?: { messageHandlers?: { formaPrint?: { postMessage: (p: { title: string }) => void } } };
      }
    ).webkit;
    if (webkit?.messageHandlers?.formaPrint) {
      webkit.messageHandlers.formaPrint.postMessage({ title: notebook.title });
    } else {
      window.print();
    }
  };

  const themeSpec = READING_THEME_STYLES[readingTheme];
  const isDark = readingTheme === 'dark';

  const moveCell = (cellId: string, delta: -1 | 1) => {
    updateCells((cells) => {
      const idx = cells.findIndex((c) => c.id === cellId);
      const target = idx + delta;
      if (idx === -1 || target < 0 || target >= cells.length) return cells;
      const next = [...cells];
      const [item] = next.splice(idx, 1);
      next.splice(target, 0, item);
      return next;
    });
  };

  const deleteCell = (cellId: string) => {
    if (notebook.cells.length <= 1) return;
    updateCells((cells) => cells.filter((c) => c.id !== cellId));
  };

  const duplicateCell = (cellId: string) => {
    updateCells((cells) => {
      const idx = cells.findIndex((c) => c.id === cellId);
      if (idx === -1) return cells;
      const copy: NotebookCell = {
        ...JSON.parse(JSON.stringify(cells[idx])),
        id: uid('cell'),
        execution_count: null,
      };
      const next = [...cells];
      next.splice(idx + 1, 0, copy);
      return next;
    });
  };

  const codeCellCount = notebook.cells.filter((c) => c.cell_type === 'code').length;
  const sqlCellCount = notebook.cells.filter((c) => c.cell_type === 'sql').length;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <NotebookRibbon
        viewMode={viewMode}
        readingTheme={readingTheme}
        kernelAvailable={kernelAvailable}
        isRunning={runningCellId !== null || runningAll}
        kernelTransitioning={switchingKernel}
        reactiveMode={reactiveMode}
        envs={envs}
        activePythonPath={activePythonPath}
        hasNativePath={Boolean(notebook.nativePath)}
        onChangeViewMode={setViewMode}
        onToggleReactiveMode={() => setReactiveMode((v) => !v)}
        onSelectReadingTheme={setReadingTheme}
        onSelectPythonPath={(p) => void handleRestartKernel(p)}
        onRunActive={() => void runCellById(activeCellId, true)}
        onRunAll={() => void runAllCells()}
        onInterrupt={() => void handleInterruptKernel()}
        onRestart={() => void handleRestartKernel()}
        onClearAllOutputs={() =>
          updateCells((cells) =>
            cells.map((c) =>
              c.cell_type === 'code' || c.cell_type === 'sql'
                ? { ...c, outputs: [], execution_count: null, stale: false }
                : c
            )
          )
        }
        onAddCodeCell={() => insertCellAfter(activeCellId, 'code')}
        onAddSqlCell={() => insertCellAfter(activeCellId, 'sql')}
        onAddMarkdownCell={() => insertCellAfter(activeCellId, 'markdown')}
        onOpenFolder={onPickLabFolder}
        onSaveToDisk={notebook.nativePath ? () => void handleSaveToDisk() : undefined}
        onImportIpynb={onImportNotebookFile}
        onExport={handleExport}
        onPrint={triggerPrint}
      />

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left Learning Sidebar: Folder Explorer + Chapter Outline + Live Variable Inspector */}
        {showSidebar && (
        <aside className="no-print w-64 bg-white border-r border-slate-200 flex flex-col shrink-0 hidden lg:flex select-none">
          <div className="p-2 border-b border-slate-200 flex gap-1 bg-slate-50/70">
            <button
              onClick={() => setSidebarTab('files')}
              className={`flex-1 py-1.5 rounded-md text-[11px] font-semibold flex items-center justify-center gap-1 transition ${
                sidebarTab === 'files'
                  ? 'bg-violet-100 text-violet-900'
                  : 'text-slate-500 hover:bg-slate-200/70'
              }`}
            >
              <FolderOpen className="w-3.5 h-3.5" />
              <span>Files</span>
            </button>
            <button
              onClick={() => setSidebarTab('outline')}
              className={`flex-1 py-1.5 rounded-md text-[11px] font-semibold flex items-center justify-center gap-1 transition ${
                sidebarTab === 'outline'
                  ? 'bg-violet-100 text-violet-900'
                  : 'text-slate-500 hover:bg-slate-200/70'
              }`}
            >
              <BookOpen className="w-3.5 h-3.5" />
              <span>Outline</span>
            </button>
            <button
              onClick={() => setSidebarTab('vars')}
              className={`flex-1 py-1.5 rounded-md text-[11px] font-semibold flex items-center justify-center gap-1 transition ${
                sidebarTab === 'vars'
                  ? 'bg-violet-100 text-violet-900'
                  : 'text-slate-500 hover:bg-slate-200/70'
              }`}
            >
              <Variable className="w-3.5 h-3.5" />
              <span>Vars ({variables.length})</span>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-2.5">
            {sidebarTab === 'files' ? (
              <FolderExplorer
                workspace={labFolder}
                activeNativePath={notebook.nativePath}
                onPickFolder={onPickLabFolder}
                onRefreshFolder={onRefreshLabFolder}
                onOpenNotebookPath={onOpenFolderNotebook}
                onPreviewTextFile={(p, name) => void handlePreviewTextFile(p, name)}
                onCreateNotebookInDir={onCreateNotebookInDir}
                onCopyRelativePath={(rel) => {
                  try {
                    void navigator.clipboard.writeText(rel);
                  } catch {
                    // ignore
                  }
                  onNotify(`Copied path: ${rel}`);
                }}
              />
            ) : sidebarTab === 'outline' ? (
              outline.length > 0 ? (
                <div className="space-y-0.5">
                  {outline.map((item, idx) => (
                    <button
                      key={`${item.cellId}_${idx}`}
                      onClick={() => {
                        setActiveCellId(item.cellId);
                        cellRefs.current
                          .get(item.cellId)
                          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      }}
                      style={{ paddingLeft: `${(item.level - 1) * 12 + 8}px` }}
                      className={`w-full text-left py-1.5 pr-2 rounded-md text-xs truncate flex items-center gap-1.5 hover:bg-violet-50 hover:text-violet-800 transition ${
                        item.level === 1
                          ? 'font-semibold text-slate-800'
                          : item.level === 2
                            ? 'font-medium text-slate-700'
                            : 'text-slate-500'
                      }`}
                    >
                      {item.pinned && <Sparkles className="w-3 h-3 text-violet-500 shrink-0" />}
                      <span className="truncate">{item.text}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-slate-400 px-2 py-6 text-center">
                  Add Markdown headings (`#`, `##`) to build a chapter map of your notebook.
                </div>
              )
            ) : variables.length > 0 ? (
              <div className="space-y-1.5">
                {variables.map((v) => (
                  <div
                    key={v.name}
                    className="p-2 rounded-lg bg-slate-50 border border-slate-200/80 text-xs space-y-0.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-semibold text-violet-800 truncate">
                        {v.name}
                      </span>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-200/80 text-slate-700 shrink-0">
                        {v.type}
                        {v.shape ? ` · ${v.shape}` : ''}
                      </span>
                    </div>
                    <div className="font-mono text-[11px] text-slate-500 truncate" title={v.preview}>
                      {v.preview}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-slate-400 px-2 py-6 text-center space-y-1">
                <div>No live variables in memory yet.</div>
                <div className="text-[11px]">
                  Run a Python cell (`⇧↩`) to inspect live arrays, tensors, dicts &amp; values here.
                </div>
              </div>
            )}
          </div>
        </aside>
        )}

        {/* Main Notebook Canvas */}
        <main
          style={{ backgroundColor: themeSpec.backdropBg }}
          className={`flex-1 overflow-y-auto py-7 px-4 sm:px-8 transition-colors duration-200 ${themeSpec.docTextClass}`}
        >
          <div style={{ zoom }} className="max-w-4xl mx-auto space-y-4">
            {viewMode === 'study' && (
              <div className="no-print flex items-center justify-between px-4 py-2 rounded-xl bg-violet-950/90 text-violet-100 text-xs shadow-sm">
                <div className="flex items-center gap-2">
                  <BookMarked className="w-4 h-4 text-violet-300" />
                  <span>
                    <strong>Study / Active-Recall Mode:</strong> Code blocks collapse cleanly so you can read math &amp; outputs like a paper and reveal implementations on demand.
                  </span>
                </div>
                <button
                  onClick={() => setViewMode('lab')}
                  className="px-2.5 py-1 rounded-md bg-white/15 hover:bg-white/25 text-white font-medium shrink-0 ml-3"
                >
                  Back to Lab
                </button>
              </div>
            )}

            {notebook.cells.map((cell, idx) => {
              const isSelected = cell.id === activeCellId;
              const isRunning = cell.id === runningCellId;
              const isSqlCell = cell.cell_type === 'sql';
              const isExecutable = cell.cell_type === 'code' || isSqlCell;
              const isEditingMd = cell.cell_type === 'markdown' && editingMarkdownId === cell.id;
              const isCodeHidden =
                isExecutable &&
                ((viewMode === 'study' && !revealedInStudy.has(cell.id)) || cell.collapsedCode);
              const lineCount = Math.max(1, cell.source.split('\n').length);
              const activeLiveStream =
                isRunning && liveStream?.cellId === cell.id && (liveStream.stdout || liveStream.stderr)
                  ? liveStream
                  : null;

              const sliders =
                cell.cell_type === 'code'
                  ? extractCellParameters(cell.source, autoSliderCells.has(cell.id))
                  : [];
              const downstreamEdges =
                cell.cell_type === 'code' ? depGraph.downstreamByCell[cell.id] ?? [] : [];
              const downstreamTransitive =
                cell.cell_type === 'code' ? depGraph.getTransitiveDownstream(cell.id) : [];
              const staleUpstreamSyms =
                cell.cell_type === 'code'
                  ? depGraph.getStaleUpstreamSymbols(cell.id, staleCellIds)
                  : [];
              const activeTrace = cellTraces[cell.id];
              const tracedLine = activeTrace
                ? activeTrace.data.steps[activeTrace.stepIndex]?.line ?? null
                : null;

              return (
                <div
                  key={cell.id}
                  ref={(el) => {
                    if (el) cellRefs.current.set(cell.id, el);
                    else cellRefs.current.delete(cell.id);
                  }}
                  onClick={() => setActiveCellId(cell.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setActiveCellId(cell.id);
                    setCellMenu({ x: e.clientX, y: e.clientY, cellId: cell.id });
                  }}
                  style={{
                    backgroundColor: themeSpec.paperBg,
                    borderColor: isSelected
                      ? isSqlCell
                        ? '#0d9488'
                        : '#7c3aed'
                      : cell.pinnedConcept
                        ? '#a78bfa'
                        : themeSpec.paperBorder,
                  }}
                  className={`print-paper group relative rounded-xl border transition-all overflow-hidden ${
                    isSelected
                      ? isSqlCell
                        ? 'shadow-md ring-1 ring-teal-500/30'
                        : 'shadow-md ring-1 ring-violet-500/30'
                      : 'shadow-xs hover:shadow-sm'
                  } ${cell.pinnedConcept ? 'border-l-4 border-l-violet-500' : ''}`}
                >
                  {/* Cell Header Chrome (minimal in Study Mode) */}
                  {viewMode === 'lab' && (
                    <div
                      className={`no-print px-3 py-1.5 flex items-center justify-between gap-2 text-[11px] border-b ${
                        isDark
                          ? 'bg-slate-800/70 border-slate-700 text-slate-300'
                          : isSqlCell
                            ? 'bg-teal-50/50 border-teal-200/70 text-slate-500'
                            : 'bg-slate-50/90 border-slate-200/80 text-slate-500'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        {isExecutable ? (
                          <>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                void runCellById(cell.id, false);
                              }}
                              disabled={runningCellId !== null || runningAll || switchingKernel}
                              title={isSqlCell ? 'Run SQL Query (Shift+Enter)' : 'Run Cell (Shift+Enter)'}
                              className={`w-6 h-6 rounded-md flex items-center justify-center transition disabled:opacity-40 ${
                                isSqlCell
                                  ? 'bg-teal-600/15 text-teal-700 hover:bg-teal-600 hover:text-white'
                                  : 'bg-emerald-600/15 text-emerald-700 hover:bg-emerald-600 hover:text-white'
                              }`}
                            >
                              <Play className="w-3 h-3 fill-current" />
                            </button>
                            <span
                              className={`font-mono font-semibold ${
                                isSqlCell ? 'text-teal-700' : 'text-violet-700'
                              }`}
                            >
                              [{isRunning ? '*' : cell.execution_count ?? ' '}]
                            </span>
                            {isSqlCell && (
                              <span
                                className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border ${
                                  isDark
                                    ? 'bg-teal-950/70 text-teal-300 border-teal-700/70'
                                    : 'bg-teal-50 text-teal-800 border-teal-200/90'
                                }`}
                              >
                                <Database className="w-2.5 h-2.5" />
                                <span>SQL</span>
                                <span className="text-[9.5px] font-normal text-amber-600 dark:text-amber-300">
                                  DuckDB / SQLite
                                </span>
                              </span>
                            )}
                            {cell.lastRunMs !== undefined && !isRunning && (
                              <span className="font-mono text-[10px] text-slate-400">
                                {cell.lastRunMs} ms
                              </span>
                            )}
                            {cell.stale && (
                              <span
                                title="Cell was edited since it last ran"
                                className="flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-800"
                              >
                                <AlertTriangle className="w-2.5 h-2.5" />
                                Edited
                              </span>
                            )}
                            {staleUpstreamSyms.length > 0 && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void runCellById(cell.id, false, undefined, true);
                                }}
                                title={`Upstream cell changed (${staleUpstreamSyms.join(', ')}) — click to refresh this cell and downstream`}
                                className="flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-800 hover:bg-amber-500/25 border border-amber-300/70 transition"
                              >
                                <Zap className="w-2.5 h-2.5 text-amber-600" />
                                <span>
                                  Stale ({staleUpstreamSyms.slice(0, 2).join(', ')}) · Refresh
                                </span>
                              </button>
                            )}
                            {downstreamTransitive.length > 0 && (
                              <span
                                title={`Feeds ${downstreamTransitive.length} downstream cell${
                                  downstreamTransitive.length === 1 ? '' : 's'
                                } via: ${Array.from(
                                  new Set(downstreamEdges.flatMap((e) => e.symbols))
                                ).join(', ')}`}
                                className={`hidden sm:inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded ${
                                  isDark
                                    ? 'bg-violet-950/60 text-violet-300'
                                    : 'bg-violet-50 text-violet-700'
                                }`}
                              >
                                <GitBranch className="w-2.5 h-2.5" />
                                <span>
                                  → {downstreamTransitive.length}{' '}
                                  {downstreamTransitive.length === 1 ? 'cell' : 'cells'}
                                </span>
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="font-semibold text-indigo-600 flex items-center gap-1">
                            <BookOpen className="w-3 h-3" />
                            Markdown / Math
                          </span>
                        )}

                        {cell.pinnedConcept && (
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-violet-100 text-violet-800 flex items-center gap-1">
                            <Sparkles className="w-2.5 h-2.5" />
                            Key Concept
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-0.5 opacity-70 group-hover:opacity-100 transition">
                        {cell.cell_type === 'markdown' && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingMarkdownId(isEditingMd ? null : cell.id);
                            }}
                            className="px-2 py-0.5 rounded hover:bg-slate-200/70 text-[11px] font-medium"
                          >
                            {isEditingMd ? 'Preview' : 'Edit'}
                          </button>
                        )}
                        {cell.cell_type === 'code' && (
                          <>
                            <button
                              title="Step-Through Execution Trace — scrub line-by-line variable & shape changes"
                              disabled={runningCellId !== null || runningAll || switchingKernel}
                              onClick={(e) => {
                                e.stopPropagation();
                                void traceCellById(cell.id);
                              }}
                              className={`px-1.5 py-0.5 rounded text-[11px] font-medium flex items-center gap-1 transition disabled:opacity-40 ${
                                activeTrace
                                  ? 'bg-amber-500 text-white'
                                  : 'hover:bg-amber-100 hover:text-amber-900'
                              }`}
                            >
                              <Activity className="w-3 h-3" />
                              <span className="hidden md:inline">Trace</span>
                            </button>
                            <button
                              title="Toggle Interactive Parameter Sliders for numeric variables in this cell"
                              onClick={(e) => {
                                e.stopPropagation();
                                setAutoSliderCells((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(cell.id)) next.delete(cell.id);
                                  else next.add(cell.id);
                                  return next;
                                });
                              }}
                              className={`p-1 rounded transition ${
                                autoSliderCells.has(cell.id) || sliders.length > 0
                                  ? 'text-violet-600 bg-violet-100/70'
                                  : 'hover:bg-slate-200/70'
                              }`}
                            >
                              <SlidersHorizontal className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                        {isExecutable && (
                          <button
                            title={cell.collapsedCode ? 'Show Code' : 'Hide Code'}
                            onClick={(e) => {
                              e.stopPropagation();
                              updateCell(cell.id, { collapsedCode: !cell.collapsedCode });
                            }}
                            className="p-1 rounded hover:bg-slate-200/70"
                          >
                            {cell.collapsedCode ? (
                              <Eye className="w-3.5 h-3.5" />
                            ) : (
                              <EyeOff className="w-3.5 h-3.5" />
                            )}
                          </button>
                        )}
                        <button
                          title="Pin / Unpin Key Concept"
                          onClick={(e) => {
                            e.stopPropagation();
                            updateCell(cell.id, { pinnedConcept: !cell.pinnedConcept });
                          }}
                          className={`p-1 rounded hover:bg-slate-200/70 ${
                            cell.pinnedConcept ? 'text-violet-600' : ''
                          }`}
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                        </button>
                        <button
                          title="Move Up"
                          disabled={idx === 0}
                          onClick={(e) => {
                            e.stopPropagation();
                            moveCell(cell.id, -1);
                          }}
                          className="p-1 rounded hover:bg-slate-200/70 disabled:opacity-30"
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          title="Move Down"
                          disabled={idx === notebook.cells.length - 1}
                          onClick={(e) => {
                            e.stopPropagation();
                            moveCell(cell.id, 1);
                          }}
                          className="p-1 rounded hover:bg-slate-200/70 disabled:opacity-30"
                        >
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                        <button
                          title="Delete Cell"
                          disabled={notebook.cells.length <= 1}
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteCell(cell.id);
                          }}
                          className="p-1 rounded hover:bg-rose-50 hover:text-rose-600 disabled:opacity-30"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Cell Body */}
                  {cell.cell_type === 'markdown' ? (
                    isEditingMd ? (
                      <div className="p-3 space-y-2">
                        <textarea
                          autoFocus
                          value={cell.source}
                          rows={Math.max(4, Math.min(18, lineCount + 1))}
                          onChange={(e) => updateCell(cell.id, { source: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.shiftKey || e.metaKey || e.ctrlKey)) {
                              e.preventDefault();
                              setEditingMarkdownId(null);
                            }
                          }}
                          placeholder="Write Markdown with $inline$ or $$display$$ LaTeX math..."
                          className={`w-full font-mono text-xs p-2.5 rounded-lg border resize-y focus:outline-none focus:border-violet-500 ${
                            isDark
                              ? 'bg-slate-900 border-slate-700 text-slate-100'
                              : 'bg-slate-50 border-slate-200 text-slate-900'
                          }`}
                        />
                        <div className="flex justify-between items-center text-[11px] text-slate-400">
                          <span>Markdown &amp; LaTeX (`$...$`, `$$...$$`)</span>
                          <button
                            onClick={() => setEditingMarkdownId(null)}
                            className="px-2.5 py-1 rounded bg-violet-600 text-white font-medium hover:bg-violet-700"
                          >
                            Render (⇧↩)
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div
                        onDoubleClick={() => {
                          if (viewMode === 'lab') setEditingMarkdownId(cell.id);
                        }}
                        className={`forma-nb-prose px-6 py-4 text-[15px] ${
                          isDark ? 'text-slate-100' : readingTheme === 'sepia' ? 'text-amber-950' : 'text-slate-800'
                        }`}
                        dangerouslySetInnerHTML={{
                          __html: sanitizeDocumentHtml(renderMarkdownWithAttachments(cell.source, cell.attachments)),
                        }}
                      />
                    )
                  ) : (
                    <>
                      {/* Explorable Interactive Parameter Sliders Strip (live-reactive in Lab & Study Mode!) */}
                      {sliders.length > 0 && (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className={`no-print px-4 py-2.5 border-b flex flex-wrap items-center gap-x-5 gap-y-2 ${
                            isDark
                              ? 'bg-violet-950/35 border-violet-800/50 text-slate-200'
                              : 'bg-violet-50/75 border-violet-200/70 text-slate-800'
                          }`}
                        >
                          <div className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-violet-600 shrink-0">
                            <Zap className="w-3 h-3 fill-violet-500" />
                            <span>Live Controls</span>
                          </div>
                          {sliders.map((p) => (
                            <label
                              key={`${cell.id}_${p.name}_${p.lineIndex}`}
                              className="flex items-center gap-2 text-xs min-w-[190px]"
                            >
                              <span className="font-mono font-semibold text-violet-700 dark:text-violet-300">
                                {p.name}
                              </span>
                              <input
                                type="range"
                                min={p.min}
                                max={p.max}
                                step={p.step}
                                value={p.value}
                                onChange={(e) =>
                                  handleSliderChange(cell.id, p, Number(e.target.value))
                                }
                                className="w-28 accent-violet-600 cursor-pointer h-1.5"
                              />
                              <span
                                className={`font-mono text-[11px] px-1.5 py-0.5 rounded border min-w-[44px] text-center ${
                                  isDark
                                    ? 'bg-slate-900 border-slate-700 text-violet-200'
                                    : 'bg-white border-violet-200 text-violet-900'
                                }`}
                              >
                                {p.isInt ? Math.round(p.value) : p.value}
                              </span>
                            </label>
                          ))}
                        </div>
                      )}

                      {isCodeHidden ? (
                        <div className="no-print px-4 py-2 flex items-center justify-between text-xs bg-slate-50/70">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (viewMode === 'study') {
                                setRevealedInStudy((prev) => new Set(prev).add(cell.id));
                              } else {
                                updateCell(cell.id, { collapsedCode: false });
                              }
                            }}
                            className={`flex items-center gap-1.5 font-medium ${
                              isSqlCell
                                ? 'text-teal-700 hover:text-teal-900'
                                : 'text-violet-700 hover:text-violet-900'
                            }`}
                          >
                            {isSqlCell ? (
                              <Database className="w-3.5 h-3.5" />
                            ) : (
                              <Code2 className="w-3.5 h-3.5" />
                            )}
                            <span>
                              Reveal {isSqlCell ? 'SQL Query' : 'Python Implementation'} ({lineCount} lines)
                            </span>
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void runCellById(cell.id, false);
                            }}
                            className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 hover:bg-emerald-100 font-medium flex items-center gap-1"
                          >
                            <Play className="w-3 h-3 fill-current" />
                            <span>Run</span>
                          </button>
                        </div>
                      ) : (
                        <div className="relative">
                          {viewMode === 'study' && (
                            <button
                              onClick={() =>
                                setRevealedInStudy((prev) => {
                                  const next = new Set(prev);
                                  next.delete(cell.id);
                                  return next;
                                })
                              }
                              className="no-print absolute top-2 right-2 z-10 px-2 py-0.5 rounded bg-slate-800/80 text-slate-200 text-[10px] hover:bg-slate-700"
                            >
                              Hide {isSqlCell ? 'SQL' : 'Code'}
                            </button>
                          )}
                          {isSqlCell ? (
                            <SqlCodeEditor
                              value={cell.source}
                              theme={readingTheme}
                              onChange={(nextVal) =>
                                updateCell(cell.id, {
                                  source: nextVal,
                                  stale: cell.execution_count != null,
                                })
                              }
                              onRunAdvance={() => void runCellById(cell.id, true)}
                              onRunInPlace={() => void runCellById(cell.id, false)}
                            />
                          ) : (
                            <PythonCodeEditor
                              value={cell.source}
                              theme={readingTheme}
                              highlightLine={tracedLine}
                              onChange={(nextVal) =>
                                updateCell(cell.id, {
                                  source: nextVal,
                                  stale: cell.execution_count != null,
                                })
                              }
                              onRunAdvance={() => void runCellById(cell.id, true)}
                              onRunInPlace={() => void runCellById(cell.id, false)}
                            />
                          )}
                        </div>
                      )}

                      {activeTrace && (
                        <CellTracePanel
                          trace={activeTrace.data}
                          stepIndex={activeTrace.stepIndex}
                          dark={isDark}
                          onChangeStep={(nextStep) =>
                            setCellTraces((prev) => ({
                              ...prev,
                              [cell.id]: { ...activeTrace, stepIndex: nextStep },
                            }))
                          }
                          onClose={() =>
                            setCellTraces((prev) => {
                              const next = { ...prev };
                              delete next[cell.id];
                              return next;
                            })
                          }
                        />
                      )}

                      {activeLiveStream ? (
                        <div
                          className={`border-t px-4 py-2.5 space-y-2 text-xs ${
                            isDark
                              ? 'border-slate-700/80 bg-slate-900/50'
                              : 'border-slate-200/80 bg-slate-50/80'
                          }`}
                        >
                          <div className="flex items-center gap-1.5 text-[10.5px] font-semibold text-emerald-600">
                            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                            <span>Live output streaming…</span>
                          </div>
                          {activeLiveStream.stdout && (
                            <pre
                              className={`font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words max-h-72 overflow-auto ${
                                isDark ? 'text-slate-200' : 'text-slate-800'
                              }`}
                            >
                              {activeLiveStream.stdout}
                            </pre>
                          )}
                          {activeLiveStream.stderr && (
                            <pre className="font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words max-h-72 overflow-auto text-rose-600 bg-rose-50/80 px-2.5 py-1.5 rounded">
                              {activeLiveStream.stderr}
                            </pre>
                          )}
                        </div>
                      ) : (
                        !cell.collapsedOutput &&
                        cell.outputs &&
                        cell.outputs.length > 0 && (
                          <OutputView outputs={cell.outputs} dark={isDark} />
                        )
                      )}
                    </>
                  )}
                </div>
              );
            })}

            {/* Bottom Quick Insert Strip */}
            <div className="no-print flex items-center justify-center gap-2 pt-2 pb-12">
              <button
                onClick={() => insertCellAfter(notebook.cells[notebook.cells.length - 1]?.id ?? null, 'code')}
                className="px-3 py-1.5 rounded-lg bg-white/90 border border-slate-200 text-xs font-medium text-slate-700 hover:border-violet-400 hover:text-violet-700 flex items-center gap-1.5 shadow-xs transition"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Code Cell</span>
              </button>
              <button
                onClick={() => insertCellAfter(notebook.cells[notebook.cells.length - 1]?.id ?? null, 'sql')}
                className="px-3 py-1.5 rounded-lg bg-white/90 border border-slate-200 text-xs font-medium text-slate-700 hover:border-teal-400 hover:text-teal-700 flex items-center gap-1.5 shadow-xs transition"
              >
                <Database className="w-3.5 h-3.5 text-teal-600" />
                <span>Add SQL Cell</span>
              </button>
              <button
                onClick={() => insertCellAfter(notebook.cells[notebook.cells.length - 1]?.id ?? null, 'markdown')}
                className="px-3 py-1.5 rounded-lg bg-white/90 border border-slate-200 text-xs font-medium text-slate-700 hover:border-violet-400 hover:text-violet-700 flex items-center gap-1.5 shadow-xs transition"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Markdown / Math Cell</span>
              </button>
            </div>
          </div>
        </main>
      </div>

      {/* Bottom Status Bar */}
      <div className="no-print h-8 bg-slate-100 border-t border-slate-200 px-4 flex items-center justify-between text-[11px] text-slate-500 shrink-0">
        <div className="flex items-center gap-4">
          <button
            onClick={() => setShowSidebar((v) => !v)}
            title="Toggle Sidebar (⌘\)"
            className="text-slate-600 hover:text-violet-700 font-medium transition"
          >
            {showSidebar ? 'Hide Sidebar' : 'Show Sidebar'}
          </button>
          <span>
            Cells: <strong className="text-slate-800 font-mono">{notebook.cells.length}</strong> (
            {codeCellCount} code{sqlCellCount > 0 ? `, ${sqlCellCount} sql` : ''})
          </span>
          <span>
            Live Vars: <strong className="text-violet-700 font-mono">{variables.length}</strong>
          </span>
          <span>
            Mode: <strong className="text-slate-700 capitalize">{viewMode}</strong>
          </span>
          {(notebook.nativePath || labFolder?.rootPath) && (
            <span
              className="hidden xl:inline font-mono text-[10px] text-slate-400 truncate max-w-[260px]"
              title={notebook.nativePath || labFolder?.rootPath}
            >
              cwd: {dirnamePath(notebook.nativePath) || labFolder?.rootPath}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <ZoomControl zoom={zoom} onZoomOut={zoomOut} onZoomIn={zoomIn} onZoomReset={zoomReset} />
        </div>
      </div>

      {/* Quick Read-Only File Preview Modal (for .py / .md / .csv / .json in workspace folder) */}
      {previewFile && (
        <div
          onClick={() => setPreviewFile(null)}
          className="no-print fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-xs flex items-center justify-center p-6"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-3xl max-h-[80vh] bg-white rounded-2xl shadow-2xl border border-slate-200 flex flex-col overflow-hidden"
          >
            <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-bold text-slate-900 truncate">{previewFile.name}</div>
                <div className="text-[10px] font-mono text-slate-400 truncate">{previewFile.path}</div>
              </div>
              <button
                onClick={() => setPreviewFile(null)}
                className="p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {previewFile.name.toLowerCase().endsWith('.py') ? (
              <pre className="forma-py-dark forma-py-layer flex-1 overflow-auto p-4 bg-[#121620] whitespace-pre">
                <code
                  dangerouslySetInnerHTML={{ __html: highlightPythonToHtml(previewFile.content) }}
                />
              </pre>
            ) : (
              <pre className="flex-1 overflow-auto p-4 text-xs font-mono text-slate-800 bg-slate-50/40 whitespace-pre-wrap break-words leading-relaxed">
                {previewFile.content}
              </pre>
            )}
          </div>
        </div>
      )}

      {/* Cell Right-Click Context Menu */}
      {cellMenu && (
        <ContextMenu
          x={cellMenu.x}
          y={cellMenu.y}
          onClose={() => setCellMenu(null)}
          items={(() => {
            const c = notebook.cells.find((x) => x.id === cellMenu.cellId);
            if (!c) return [];
            const items: ContextMenuItem[] = [
              ...(c.cell_type === 'code'
                ? [
                    {
                      id: 'run',
                      label: 'Run Cell',
                      shortcut: '⇧↩',
                      onClick: () => void runCellById(c.id, false),
                    },
                    {
                      id: 'trace',
                      label: 'Trace Step-by-Step (Scrubber)',
                      onClick: () => void traceCellById(c.id),
                    },
                    {
                      id: 'sliders',
                      label: autoSliderCells.has(c.id)
                        ? 'Hide Auto Parameter Sliders'
                        : 'Show Interactive Parameter Sliders',
                      onClick: () =>
                        setAutoSliderCells((prev) => {
                          const next = new Set(prev);
                          if (next.has(c.id)) next.delete(c.id);
                          else next.add(c.id);
                          return next;
                        }),
                    },
                    {
                      id: 'clearOut',
                      label: 'Clear Output',
                      onClick: () => updateCell(c.id, { outputs: [], execution_count: null }),
                    },
                    {
                      id: 'toggleCode',
                      label: c.collapsedCode ? 'Show Code' : 'Collapse Code (Recall Mode)',
                      onClick: () => updateCell(c.id, { collapsedCode: !c.collapsedCode }),
                    },
                  ]
                : c.cell_type === 'sql'
                  ? [
                      {
                        id: 'runSql',
                        label: 'Run SQL Query',
                        shortcut: '⇧↩',
                        onClick: () => void runCellById(c.id, false),
                      },
                      {
                        id: 'clearOut',
                        label: 'Clear Output',
                        onClick: () => updateCell(c.id, { outputs: [], execution_count: null }),
                      },
                      {
                        id: 'toggleCode',
                        label: c.collapsedCode ? 'Show SQL' : 'Collapse SQL (Recall Mode)',
                        onClick: () => updateCell(c.id, { collapsedCode: !c.collapsedCode }),
                      },
                    ]
                  : [
                      {
                        id: 'editMd',
                        label: 'Edit Markdown / Math',
                        onClick: () => setEditingMarkdownId(c.id),
                      },
                    ]),
              { id: 'd1', divider: true },
              {
                id: 'insCode',
                label: 'Insert Code Cell Below',
                onClick: () => insertCellAfter(c.id, 'code'),
              },
              {
                id: 'insSql',
                label: 'Insert SQL Cell Below',
                onClick: () => insertCellAfter(c.id, 'sql'),
              },
              {
                id: 'insMd',
                label: 'Insert Markdown / Math Below',
                onClick: () => insertCellAfter(c.id, 'markdown'),
              },
              {
                id: 'convert',
                label: c.cell_type === 'code' ? 'Convert to Markdown' : 'Convert to Code',
                onClick: () =>
                  updateCell(c.id, {
                    cell_type: c.cell_type === 'code' ? 'markdown' : 'code',
                    outputs: [],
                    execution_count: null,
                  }),
              },
              ...(c.cell_type !== 'sql'
                ? [
                    {
                      id: 'convertSql',
                      label: 'Convert to SQL Cell',
                      onClick: () =>
                        updateCell(c.id, {
                          cell_type: 'sql',
                          outputs: [],
                          execution_count: null,
                        }),
                    },
                  ]
                : []),
              {
                id: 'pin',
                label: c.pinnedConcept ? 'Unpin Key Concept' : 'Pin as Key Concept',
                onClick: () => updateCell(c.id, { pinnedConcept: !c.pinnedConcept }),
              },
              {
                id: 'dup',
                label: 'Duplicate Cell',
                onClick: () => duplicateCell(c.id),
              },
              { id: 'd2', divider: true },
              {
                id: 'del',
                label: 'Delete Cell',
                danger: true,
                disabled: notebook.cells.length <= 1,
                onClick: () => deleteCell(c.id),
              },
            ];
            return items;
          })()}
        />
      )}
    </div>
  );
};
