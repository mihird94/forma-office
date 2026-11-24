import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileCheck2,
  LayoutGrid,
  MessageSquare,
  Minimize2,
  PenTool,
  Plus,
  ScanText,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import {
  FormaPdfRecord,
  PdfAnnotation,
  PdfInkAnnotation,
  PdfRedactAnnotation,
  PdfTool,
} from '../../types/pdf';
import {
  clearPdfStreamUrl,
  deletePdfBytes,
  getPdfStreamUrl,
  loadPdfBytes,
  resolveNativePdfPath,
  savePdfBytes,
  setPdfStreamUrl,
} from '../../storage/pdfBlobStore';
import {
  PdfFormFieldInfo,
  applyRedactionsToPdf,
  bakeAnnotationsIntoPdf,
  remapPageAnnotations,
  deletePdfPage,
  duplicatePdfPage,
  extractPdfPage,
  fillPdfFormFields,
  getPdfPageCount,
  insertBlankPdfPage,
  mergePdfBytes,
  movePdfPage,
  readPdfFormFields,
  rotatePdfPage,
} from '../../engine/pdf/pdfEngine';
import {
  SavedSignature,
  SignaturePoint,
  deleteSavedSignature,
  loadSavedSignatures,
  saveSignatureToVault,
  stampSignatureToInkAnnotations,
} from '../../storage/signatureStore';
import { uid } from '../../engine/spreadsheet/workbookOps';
import { isNativeWorkspaceAvailable, writeBinaryWorkspaceFile } from '../../storage/notebookStore';
import { triggerFileDownload, wasNativeSaveCancelled } from '../../storage/workspaceStore';
import { PdfRibbon } from './PdfRibbon';
import { PdfCompareModal } from './PdfCompareModal';
import { ContextMenu, ContextMenuItem } from '../common/ContextMenu';
import {
  READING_THEME_STYLES,
  ReadingModePicker,
  ReadingTheme,
  loadReadingTheme,
  saveReadingTheme,
} from '../common/ReadingModePicker';
import { ZoomControl } from '../common/ZoomControl';
import { useAppZoom } from '../../utils/useAppZoom';
import { loadFilePosition, saveFilePosition } from '../../storage/sessionStore';

interface NativeOcrEventPayload {
  reqId: string;
  ok: boolean;
  text?: string;
  lines?: string[];
  error?: string;
}

const pendingOcrRequests = new Map<
  string,
  { resolve: (res: NativeOcrEventPayload) => void; timer: number }
>();

function ensureOcrEventBridge(): void {
  const w = window as unknown as {
    __formaOcrEvent?: (payload: NativeOcrEventPayload) => void;
  };
  if (w.__formaOcrEvent) return;
  w.__formaOcrEvent = (payload: NativeOcrEventPayload) => {
    if (!payload?.reqId) return;
    const entry = pendingOcrRequests.get(payload.reqId);
    if (!entry) return;
    pendingOcrRequests.delete(payload.reqId);
    window.clearTimeout(entry.timer);
    entry.resolve(payload);
  };
}

function isNativePdfOcrAvailable(): boolean {
  const webkit = (
    window as unknown as {
      webkit?: { messageHandlers?: { formaPdfOcr?: { postMessage: (p: unknown) => void } } };
    }
  ).webkit;
  return Boolean(webkit?.messageHandlers?.formaPdfOcr);
}

async function ocrNativePdfPage(
  path: string,
  pageIndex: number
): Promise<NativeOcrEventPayload> {
  const webkit = (
    window as unknown as {
      webkit?: { messageHandlers?: { formaPdfOcr?: { postMessage: (p: unknown) => void } } };
    }
  ).webkit;
  const handler = webkit?.messageHandlers?.formaPdfOcr;
  if (!handler) {
    return { reqId: '', ok: false, error: 'Vision OCR requires the native macOS Forma PDF app.' };
  }
  ensureOcrEventBridge();
  const reqId = uid('ocr');
  return new Promise<NativeOcrEventPayload>((resolve) => {
    const timer = window.setTimeout(() => {
      pendingOcrRequests.delete(reqId);
      resolve({ reqId, ok: false, error: 'Vision OCR timed out for this page.' });
    }, 30000);
    pendingOcrRequests.set(reqId, { resolve, timer });
    handler.postMessage({ reqId, path, pageIndex });
  });
}

// Same-origin HTTP 206 Range transport running in the main window (so WKURLSchemeHandler
// works cleanly even when pdf.worker runs from a blob: URL with null origin!)
class MainPageRangeTransport extends pdfjsLib.PDFDataRangeTransport {
  private url: string;
  private aborted = false;
  private onStaleStream?: () => void;
  private reportedStale = false;

  constructor(url: string, length: number, initialData?: Uint8Array, onStaleStream?: () => void) {
    super(length, initialData ?? null, true);
    this.url = url;
    this.onStaleStream = onStaleStream;
  }

  requestDataRange(begin: number, end: number): void {
    if (this.aborted) return;
    const inclusiveEnd = Math.max(begin, end - 1);
    fetch(this.url, { headers: { Range: `bytes=${begin}-${inclusiveEnd}` } })
      .then((res) => {
        if (res.status === 416 && !this.reportedStale) {
          this.reportedStale = true;
          this.onStaleStream?.();
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((ab) => {
        if (!this.aborted) {
          this.onDataRange(begin, new Uint8Array(ab));
        }
      })
      .catch(() => {
        // ignore aborted or stale range fetches
      });
  }

  abort(): void {
    this.aborted = true;
  }
}

// Spin up PDF.js decoding on a real background Web Worker (off main UI thread!)
let workerInitialized = false;
async function ensurePdfWorker(): Promise<void> {
  if (workerInitialized) return;
  workerInitialized = true;
  try {
    const resp = await fetch(pdfWorkerUrl);
    if (resp.ok) {
      const code = await resp.text();
      const blobUrl = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      pdfjsLib.GlobalWorkerOptions.workerSrc = blobUrl;
      return;
    }
  } catch {
    // Fallback to direct URL
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
}

interface PdfAppProps {
  record: FormaPdfRecord;
  onChangeRecord: (updated: FormaPdfRecord) => void;
  onImportNewPdf: (file: File) => void;
  onReadingModeChange?: (active: boolean) => void;
  onNotify: (msg: string) => void;
}

interface OutlineNode {
  title: string;
  dest: unknown;
  items?: OutlineNode[];
}

const EMPTY_ANNOTATIONS: PdfAnnotation[] = [];

/**
 * Deadlock-proof concurrency limiter for PDF.js page & thumbnail rasterization.
 * Releasing is idempotent and tied directly to `useEffect` cleanup (`cancelWait()`),
 * so even if PDF.js never settles a promise on a destroyed worker during tab switch,
 * queue slots are released synchronously on unmount and can never wedge.
 */
function createRenderQueue(maxConcurrent: number) {
  let active = 0;
  const waiting: Array<{ start: () => void; cancel: () => void }> = [];
  const next = () => {
    while (active < maxConcurrent && waiting.length > 0) {
      const item = waiting.shift();
      if (item) {
        active++;
        item.start();
      }
    }
  };
  const releaseOne = () => {
    active = Math.max(0, active - 1);
    next();
  };
  return {
    get activeCount() {
      return active;
    },
    acquire(isCancelled: () => boolean): {
      promise: Promise<(() => void) | null>;
      cancelWait: () => void;
    } {
      if (isCancelled()) {
        return { promise: Promise.resolve(null), cancelWait: () => {} };
      }
      let released = false;
      const makeRelease = () => () => {
        if (released) return;
        released = true;
        releaseOne();
      };
      if (active < maxConcurrent) {
        active++;
        const rel = makeRelease();
        return { promise: Promise.resolve(rel), cancelWait: rel };
      }
      let entry: { start: () => void; cancel: () => void } | null = null;
      let releaseFn: (() => void) | null = null;
      const promise = new Promise<(() => void) | null>((resolve) => {
        entry = {
          start: () => {
            if (isCancelled()) {
              releaseOne();
              resolve(null);
            } else {
              releaseFn = makeRelease();
              resolve(releaseFn);
            }
          },
          cancel: () => {
            resolve(null);
          },
        };
        waiting.push(entry);
      });
      const cancelWait = () => {
        if (releaseFn) {
          releaseFn();
          return;
        }
        if (entry) {
          const idx = waiting.indexOf(entry);
          if (idx !== -1) {
            waiting.splice(idx, 1);
            entry.cancel();
          }
        }
      };
      return { promise, cancelWait };
    },
  };
}

const pageRenderQueue = createRenderQueue(2);
const thumbRenderQueue = createRenderQueue(1);

/**
 * Per-(pdfDoc, pageNumber) mutex so LazyThumbnail and VirtualPdfPage never call
 * `page.render()` concurrently on the same cached `PDFPageProxy` instance (which in
 * pdfjs-dist shares `intentState` and aborts the operatorList if either task cancels).
 */
const pageProxyLocks = new WeakMap<object, Map<number, Promise<void>>>();

async function withPageProxyLock<T>(
  pdfDoc: pdfjsLib.PDFDocumentProxy,
  pageNumber: number,
  cancelSignal: Promise<void>,
  fn: () => Promise<T>
): Promise<T | undefined> {
  let docMap = pageProxyLocks.get(pdfDoc);
  if (!docMap) {
    docMap = new Map();
    pageProxyLocks.set(pdfDoc, docMap);
  }
  const prev = docMap.get(pageNumber) ?? Promise.resolve();
  let releaseLock!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const chained = prev.then(() => current);
  docMap.set(pageNumber, chained);
  try {
    await Promise.race([prev, cancelSignal]);
    return await Promise.race([fn(), cancelSignal.then(() => undefined)]);
  } finally {
    releaseLock();
    if (docMap.get(pageNumber) === chained) {
      docMap.delete(pageNumber);
    }
  }
}

/** Lazy virtualized sidebar thumbnail (serialized after main viewport pages so it never collides or starves) */
const LazyThumbnail: React.FC<{
  pdfDoc: pdfjsLib.PDFDocumentProxy;
  pageNumber: number;
  scrollRoot?: HTMLElement | null;
}> = React.memo(({ pdfDoc, pageNumber }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    setRendered(false);
    let cancelled = false;
    let triggerCancel!: () => void;
    const cancelSignal = new Promise<void>((resolve) => {
      triggerCancel = resolve;
    });
    let renderTask: pdfjsLib.RenderTask | null = null;
    let cancelQueueWait: (() => void) | null = null;

    (async () => {
      // Yield 45ms so main-viewport VirtualPdfPage effects (later in JSX tree) always enqueue first
      await new Promise((r) => setTimeout(r, 45));
      if (cancelled) return;
      while (!cancelled && pageRenderQueue.activeCount > 0) {
        await new Promise((r) => setTimeout(r, 60));
      }
      if (cancelled) return;

      const req = thumbRenderQueue.acquire(() => cancelled);
      cancelQueueWait = req.cancelWait;
      const releaseSlot = await req.promise;
      if (!releaseSlot || cancelled) {
        releaseSlot?.();
        return;
      }
      try {
        await withPageProxyLock(pdfDoc, pageNumber, cancelSignal, async () => {
          if (cancelled) return;
          const page = await pdfDoc.getPage(pageNumber);
          if (cancelled) return;
          const baseVp = page.getViewport({ scale: 1 });
          const scale = 120 / baseVp.width;
          const vp = page.getViewport({ scale });
          const canvas = canvasRef.current;
          if (!canvas) return;
          canvas.width = Math.round(vp.width);
          canvas.height = Math.round(vp.height);
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          renderTask = page.render({ canvasContext: ctx, viewport: vp, canvas });
          await renderTask.promise;
          if (!cancelled) setRendered(true);
        });
      } catch {
        // ignore cancelled render
      } finally {
        releaseSlot();
      }
    })();

    return () => {
      cancelled = true;
      triggerCancel();
      cancelQueueWait?.();
      renderTask?.cancel();
    };
  }, [pdfDoc, pageNumber]);

  return (
    <div
      className="w-full aspect-[8.5/11] bg-white rounded-xs shadow-xs overflow-hidden flex items-center justify-center relative"
    >
      <canvas
        ref={canvasRef}
        className={`w-full h-full object-contain block transition-opacity duration-150 ${
          rendered ? 'opacity-100' : 'opacity-0'
        }`}
      />
      {!rendered && (
        <span className="absolute text-[10px] font-mono text-slate-300">{pageNumber}</span>
      )}
    </div>
  );
});

/**
 * Virtualized Continuous-Scroll PDF Page — renders HiDPI canvas only when near the scroll viewport
 * and releases bitmap memory when scrolled far away, enabling butter-smooth scrolling on 1,000-page books!
 */
interface VirtualPdfPageProps {
  pdfDoc: pdfjsLib.PDFDocumentProxy;
  pageIndex: number; // 0-based
  zoom: number;
  renderZoom: number;
  defaultSize: { width: number; height: number };
  readingTheme: ReadingTheme;
  activeTool: PdfTool;
  activeColor: string;
  armedSignature: SavedSignature | null;
  annotations: PdfAnnotation[];
  selectedAnnId: string | null;
  scrollRoot: HTMLElement | null;
  registerPageRef: (pageIndex: number, el: HTMLDivElement | null) => void;
  onMeasurePageSize: (pageIndex: number, size: { width: number; height: number }) => void;
  onSelectAnn: (id: string | null) => void;
  onAddAnnotation: (ann: PdfAnnotation) => void;
  onStampSignature: (pageIndex: number, normX: number, normY: number) => void;
  onDeleteAnnotation: (id: string) => void;
  onOpenCanvasMenu: (x: number, y: number, pageIndex: number, normX: number, normY: number) => void;
  pendingTextPlacement: { pageIndex: number; x: number; y: number } | null;
  onClearPendingTextPlacement: () => void;
}

const VirtualPdfPage: React.FC<VirtualPdfPageProps> = React.memo(
  ({
    pdfDoc,
    pageIndex,
    zoom,
    renderZoom,
    defaultSize,
    readingTheme,
    activeTool,
    activeColor,
    armedSignature,
    annotations,
    selectedAnnId,
    registerPageRef,
    onMeasurePageSize,
    onSelectAnn,
    onAddAnnotation,
    onStampSignature,
    onDeleteAnnotation,
    onOpenCanvasMenu,
    pendingTextPlacement,
    onClearPendingTextPlacement,
  }) => {
    const wrapperRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const overlayRef = useRef<HTMLDivElement>(null);
    const [rendered, setRendered] = useState(false);
    const dims = {
      width: Math.max(1, Math.round(defaultSize.width * zoom)),
      height: Math.max(1, Math.round(defaultSize.height * zoom)),
    };

    const [highlightDraft, setHighlightDraft] = useState<{
      startX: number;
      startY: number;
      curX: number;
      curY: number;
    } | null>(null);
    const [redactDraft, setRedactDraft] = useState<{
      startX: number;
      startY: number;
      curX: number;
      curY: number;
    } | null>(null);
    const [inkDraft, setInkDraft] = useState<Array<{ x: number; y: number }> | null>(null);
    const [textDraft, setTextDraft] = useState<{ x: number; y: number; value: string } | null>(
      null
    );

    useLayoutEffect(() => {
      registerPageRef(pageIndex, wrapperRef.current);
      return () => registerPageRef(pageIndex, null);
    }, [pageIndex, registerPageRef]);

    useEffect(() => {
      if (pendingTextPlacement && pendingTextPlacement.pageIndex === pageIndex) {
        setTextDraft({ x: pendingTextPlacement.x, y: pendingTextPlacement.y, value: '' });
        onClearPendingTextPlacement();
      }
    }, [pendingTextPlacement, pageIndex, onClearPendingTextPlacement]);

    // Render page at Retina HiDPI resolution (debounced on renderZoom + queued)
    useEffect(() => {
      let cancelled = false;
      let triggerCancel!: () => void;
      const cancelSignal = new Promise<void>((resolve) => {
        triggerCancel = resolve;
      });
      let renderTask: pdfjsLib.RenderTask | null = null;
      let cancelQueueWait: (() => void) | null = null;

      (async () => {
        const req = pageRenderQueue.acquire(() => cancelled);
        cancelQueueWait = req.cancelWait;
        const releaseSlot = await req.promise;
        if (!releaseSlot || cancelled) {
          releaseSlot?.();
          return;
        }

        try {
          await withPageProxyLock(pdfDoc, pageIndex + 1, cancelSignal, async () => {
            if (cancelled) return;
            const page = await pdfDoc.getPage(pageIndex + 1);
            if (cancelled) return;

            const baseVp = page.getViewport({ scale: 1 });
            onMeasurePageSize(pageIndex, { width: baseVp.width, height: baseVp.height });

            const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
            const hiVp = page.getViewport({ scale: renderZoom * dpr });

            const canvas = canvasRef.current;
            if (!canvas) return;
            canvas.width = Math.round(hiVp.width);
            canvas.height = Math.round(hiVp.height);
            canvas.style.width = '100%';
            canvas.style.height = '100%';

            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            renderTask = page.render({ canvasContext: ctx, viewport: hiVp, canvas });
            await renderTask.promise;
            if (!cancelled) setRendered(true);
          });
        } catch {
          // ignore cancelled render
        } finally {
          releaseSlot();
        }
      })();

      return () => {
        cancelled = true;
        triggerCancel();
        cancelQueueWait?.();
        renderTask?.cancel();
      };
    }, [pdfDoc, pageIndex, renderZoom, onMeasurePageSize]);

    const getNormCoords = (e: React.MouseEvent): { x: number; y: number } => {
      const rect = overlayRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
      return {
        x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
      };
    };

    const handleMouseDown = (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const { x, y } = getNormCoords(e);
      if (activeTool === 'select') {
        onSelectAnn(null);
        return;
      }
      if (activeTool === 'highlight') {
        setHighlightDraft({ startX: x, startY: y, curX: x, curY: y });
      } else if (activeTool === 'redact') {
        setRedactDraft({ startX: x, startY: y, curX: x, curY: y });
      } else if (activeTool === 'ink') {
        if (armedSignature) {
          onStampSignature(pageIndex, x, y);
          return;
        }
        setInkDraft([{ x, y }]);
      } else if (activeTool === 'text') {
        setTextDraft({ x, y, value: '' });
      } else if (activeTool === 'note') {
        const noteText = window.prompt('Enter sticky note text:');
        if (noteText && noteText.trim()) {
          onAddAnnotation({
            id: uid('ann'),
            type: 'note',
            pageIndex,
            x,
            y,
            text: noteText.trim(),
            color: '#f59e0b',
          });
        }
      }
    };

    const handleMouseMove = (e: React.MouseEvent) => {
      if (!highlightDraft && !redactDraft && !inkDraft) return;
      const { x, y } = getNormCoords(e);
      if (highlightDraft) {
        setHighlightDraft((prev) => (prev ? { ...prev, curX: x, curY: y } : null));
      } else if (redactDraft) {
        setRedactDraft((prev) => (prev ? { ...prev, curX: x, curY: y } : null));
      } else if (inkDraft) {
        setInkDraft((prev) => (prev ? [...prev, { x, y }] : null));
      }
    };

    const handleMouseUp = () => {
      if (highlightDraft) {
        const x = Math.min(highlightDraft.startX, highlightDraft.curX);
        const y = Math.min(highlightDraft.startY, highlightDraft.curY);
        const width = Math.abs(highlightDraft.curX - highlightDraft.startX);
        const height = Math.abs(highlightDraft.curY - highlightDraft.startY);
        if (width > 0.008 && height > 0.006) {
          onAddAnnotation({
            id: uid('ann'),
            type: 'highlight',
            pageIndex,
            x,
            y,
            width,
            height,
            color: activeColor,
          });
        }
        setHighlightDraft(null);
      } else if (redactDraft) {
        const x = Math.min(redactDraft.startX, redactDraft.curX);
        const y = Math.min(redactDraft.startY, redactDraft.curY);
        const width = Math.abs(redactDraft.curX - redactDraft.startX);
        const height = Math.abs(redactDraft.curY - redactDraft.startY);
        if (width > 0.008 && height > 0.006) {
          onAddAnnotation({
            id: uid('ann'),
            type: 'redact',
            pageIndex,
            x,
            y,
            width,
            height,
          });
        }
        setRedactDraft(null);
      } else if (inkDraft) {
        if (inkDraft.length >= 2) {
          onAddAnnotation({
            id: uid('ann'),
            type: 'ink',
            pageIndex,
            points: inkDraft,
            strokeWidth: 2.2,
            color: activeColor === '#fde047' ? '#1e3a8a' : activeColor,
          });
        }
        setInkDraft(null);
      }
    };

    const commitTextDraft = () => {
      if (!textDraft) return;
      if (textDraft.value.trim()) {
        onAddAnnotation({
          id: uid('ann'),
          type: 'text',
          pageIndex,
          x: textDraft.x,
          y: textDraft.y,
          text: textDraft.value.trim(),
          fontSize: 13,
          color: activeColor === '#fde047' ? '#0f172a' : activeColor,
        });
      }
      setTextDraft(null);
    };

    const themeSpec = READING_THEME_STYLES[readingTheme];

    return (
      <div
        ref={wrapperRef}
        data-page-index={pageIndex}
        style={{
          width: dims.width,
          height: dims.height,
          backgroundColor: themeSpec.paperBg,
          borderColor: themeSpec.paperBorder,
        }}
        className="print-paper relative shadow-lg border shrink-0 overflow-hidden transition-colors duration-200"
      >
        <canvas
          ref={canvasRef}
          style={{ filter: themeSpec.pdfFilter }}
          className={`block transition-opacity duration-150 ${rendered ? 'opacity-100' : 'opacity-0'}`}
        />

        {!rendered && (
          <div className="absolute inset-0 flex items-center justify-center text-xs font-mono text-slate-400">
            Page {pageIndex + 1}
          </div>
        )}

        {themeSpec.pdfMultiplyTint && (
          <div
            style={{ backgroundColor: themeSpec.pdfMultiplyTint, mixBlendMode: 'multiply' }}
            className="no-print absolute inset-0 pointer-events-none z-[5]"
          />
        )}

        {/* Interactive Annotation & Right-Click Overlay */}
        <div
          ref={overlayRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onContextMenu={(e) => {
            e.preventDefault();
            const norm = getNormCoords(e);
            onOpenCanvasMenu(e.clientX, e.clientY, pageIndex, norm.x, norm.y);
          }}
          className={`absolute inset-0 z-10 ${
            activeTool === 'highlight' || activeTool === 'ink' || activeTool === 'redact'
              ? armedSignature && activeTool === 'ink'
                ? 'cursor-copy'
                : 'cursor-crosshair'
              : activeTool === 'text'
                ? 'cursor-text'
                : activeTool === 'note'
                  ? 'cursor-copy'
                  : 'cursor-default'
          }`}
        >
          <svg className="absolute inset-0 w-full h-full pointer-events-none">
            <defs>
              <pattern
                id={`redactStripe_${pageIndex}`}
                width="10"
                height="10"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width="10" height="10" fill="rgba(15, 23, 42, 0.78)" />
                <line x1="0" y1="0" x2="0" y2="10" stroke="#ef4444" strokeWidth="4" strokeOpacity="0.8" />
              </pattern>
            </defs>
            {annotations.map((ann) => {
              if (ann.type === 'highlight') {
                return (
                  <rect
                    key={ann.id}
                    x={`${ann.x * 100}%`}
                    y={`${ann.y * 100}%`}
                    width={`${ann.width * 100}%`}
                    height={`${ann.height * 100}%`}
                    fill={ann.color}
                    fillOpacity={0.38}
                    stroke={selectedAnnId === ann.id ? '#e11d48' : 'none'}
                    strokeWidth={2}
                    className="pointer-events-auto cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectAnn(ann.id);
                    }}
                  />
                );
              }
              if (ann.type === 'redact') {
                return (
                  <g
                    key={ann.id}
                    className="pointer-events-auto cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectAnn(ann.id);
                    }}
                  >
                    <rect
                      x={`${ann.x * 100}%`}
                      y={`${ann.y * 100}%`}
                      width={`${ann.width * 100}%`}
                      height={`${ann.height * 100}%`}
                      fill={`url(#redactStripe_${pageIndex})`}
                      stroke={selectedAnnId === ann.id ? '#facc15' : '#dc2626'}
                      strokeWidth={selectedAnnId === ann.id ? 2.5 : 1.5}
                    />
                  </g>
                );
              }
              if (ann.type === 'ink' && ann.points.length >= 2) {
                const d = ann.points
                  .map(
                    (pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x * dims.width} ${pt.y * dims.height}`
                  )
                  .join(' ');
                return (
                  <path
                    key={ann.id}
                    d={d}
                    fill="none"
                    stroke={ann.color}
                    strokeWidth={ann.strokeWidth * zoom}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="pointer-events-auto cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectAnn(ann.id);
                    }}
                  />
                );
              }
              return null;
            })}

            {highlightDraft && (
              <rect
                x={`${Math.min(highlightDraft.startX, highlightDraft.curX) * 100}%`}
                y={`${Math.min(highlightDraft.startY, highlightDraft.curY) * 100}%`}
                width={`${Math.abs(highlightDraft.curX - highlightDraft.startX) * 100}%`}
                height={`${Math.abs(highlightDraft.curY - highlightDraft.startY) * 100}%`}
                fill={activeColor}
                fillOpacity={0.35}
                stroke="#e11d48"
                strokeDasharray="4,2"
              />
            )}

            {redactDraft && (
              <rect
                x={`${Math.min(redactDraft.startX, redactDraft.curX) * 100}%`}
                y={`${Math.min(redactDraft.startY, redactDraft.curY) * 100}%`}
                width={`${Math.abs(redactDraft.curX - redactDraft.startX) * 100}%`}
                height={`${Math.abs(redactDraft.curY - redactDraft.startY) * 100}%`}
                fill={`url(#redactStripe_${pageIndex})`}
                stroke="#dc2626"
                strokeWidth={2}
                strokeDasharray="5,3"
              />
            )}

            {inkDraft && inkDraft.length >= 2 && (
              <path
                d={inkDraft
                  .map(
                    (pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x * dims.width} ${pt.y * dims.height}`
                  )
                  .join(' ')}
                fill="none"
                stroke={activeColor === '#fde047' ? '#1e3a8a' : activeColor}
                strokeWidth={2.2 * zoom}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </svg>

          {annotations.map((ann) => {
            if (ann.type === 'text') {
              return (
                <div
                  key={ann.id}
                  style={{
                    left: `${ann.x * 100}%`,
                    top: `${ann.y * 100}%`,
                    color: ann.color,
                    fontSize: `${ann.fontSize * zoom}px`,
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectAnn(ann.id);
                  }}
                  className={`absolute px-1 rounded leading-tight font-medium cursor-pointer ${
                    selectedAnnId === ann.id
                      ? 'ring-2 ring-rose-500 bg-rose-50/70'
                      : 'hover:ring-1 hover:ring-slate-300'
                  }`}
                >
                  {ann.text}
                </div>
              );
            }
            if (ann.type === 'note') {
              return (
                <div
                  key={ann.id}
                  style={{ left: `${ann.x * 100}%`, top: `${ann.y * 100}%` }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectAnn(ann.id);
                  }}
                  className={`absolute max-w-[200px] bg-amber-100 border border-amber-400 text-amber-950 rounded-lg shadow-md px-2 py-1 text-[11px] flex items-start gap-1.5 cursor-pointer ${
                    selectedAnnId === ann.id ? 'ring-2 ring-rose-500' : ''
                  }`}
                >
                  <MessageSquare className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
                  <span className="break-words">{ann.text}</span>
                </div>
              );
            }
            return null;
          })}

          {textDraft && (
            <input
              autoFocus
              value={textDraft.value}
              onChange={(e) => setTextDraft({ ...textDraft, value: e.target.value })}
              onBlur={commitTextDraft}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTextDraft();
                else if (e.key === 'Escape') setTextDraft(null);
              }}
              placeholder="Type text & press Enter..."
              style={{
                left: `${textDraft.x * 100}%`,
                top: `${textDraft.y * 100}%`,
                color: activeColor === '#fde047' ? '#0f172a' : activeColor,
              }}
              className="absolute bg-white/95 border border-rose-500 rounded px-1.5 py-0.5 text-sm shadow-md focus:outline-none min-w-[160px]"
            />
          )}

          {selectedAnnId && annotations.some((a) => a.id === selectedAnnId) && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDeleteAnnotation(selectedAnnId);
              }}
              className="no-print absolute top-3 right-3 z-30 bg-rose-600 text-white text-xs font-medium px-2.5 py-1 rounded-lg shadow-lg flex items-center gap-1 hover:bg-rose-700"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Delete Annotation</span>
            </button>
          )}
        </div>
      </div>
    );
  }
);

export const PdfApp: React.FC<PdfAppProps> = ({
  record,
  onChangeRecord,
  onImportNewPdf,
  onReadingModeChange,
  onNotify,
}) => {
  const [sourceVersion, setSourceVersion] = useState(0);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [defaultPageSize, setDefaultPageSize] = useState({ width: 612, height: 792 });
  const [outline, setOutline] = useState<OutlineNode[]>([]);
  const [sidebarTab, setSidebarTab] = useState<'pages' | 'outline'>('pages');
  const [showSidebar, setShowSidebar] = useState(true);
  const [readingMode, setReadingMode] = useState(false);

  const [currentPage, setCurrentPage] = useState(0);
  const { zoom, setZoom, zoomIn, zoomOut, zoomReset } = useAppZoom({
    initial: 1.15,
    min: 0.5,
    max: 3.0,
    step: 0.15,
  });
  const [activeTool, setActiveTool] = useState<PdfTool>('select');
  const [activeColor, setActiveColor] = useState('#fde047');
  const [readingTheme, setReadingTheme] = useState<ReadingTheme>(() => loadReadingTheme());
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [selectedAnnId, setSelectedAnnId] = useState<string | null>(null);
  const [pendingTextPlacement, setPendingTextPlacement] = useState<{
    pageIndex: number;
    x: number;
    y: number;
  } | null>(null);

  // Lazy on-demand search
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatches, setSearchMatches] = useState<number[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const textCacheRef = useRef<Map<number, string>>(new Map());

  // Fillable AcroForms
  const [formFields, setFormFields] = useState<PdfFormFieldInfo[]>([]);
  const [formValues, setFormValues] = useState<Record<string, string | boolean>>({});
  const [showFormPanel, setShowFormPanel] = useState(false);
  const [applyingForm, setApplyingForm] = useState(false);

  // Saved Signature Vault
  const [savedSignatures, setSavedSignatures] = useState<SavedSignature[]>(() => loadSavedSignatures());
  const [armedSignature, setArmedSignature] = useState<SavedSignature | null>(null);
  const [showSigPad, setShowSigPad] = useState(false);
  const [sigNameDraft, setSigNameDraft] = useState('');
  const [padStrokes, setPadStrokes] = useState<SignaturePoint[][]>([]);
  const [padActiveStroke, setPadActiveStroke] = useState<SignaturePoint[] | null>(null);
  const sigPadRef = useRef<HTMLDivElement>(null);

  // True Redaction permanent apply confirmation
  const [confirmingRedaction, setConfirmingRedaction] = useState(false);
  const [applyingRedaction, setApplyingRedaction] = useState(false);

  // Native macOS Vision OCR
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrBanner, setOcrBanner] = useState<{ label: string; text: string } | null>(null);

  // Side-by-Side PDF Compare Modal
  const [showCompareModal, setShowCompareModal] = useState(false);

  // Context menus
  const [thumbMenu, setThumbMenu] = useState<{ x: number; y: number; pageIdx: number } | null>(
    null
  );
  const [canvasMenu, setCanvasMenu] = useState<{
    x: number;
    y: number;
    pageIdx: number;
    normX: number;
    normY: number;
  } | null>(null);

  const [scrollContainerEl, setScrollContainerEl] = useState<HTMLElement | null>(null);
  const [sidebarScrollEl, setSidebarScrollEl] = useState<HTMLElement | null>(null);
  const [sidebarScrollTop, setSidebarScrollTop] = useState(0);
  const [renderZoom, setRenderZoom] = useState(zoom);
  const prevZoomRef = useRef(zoom);
  const pageSizesRef = useRef<Map<number, { width: number; height: number }>>(new Map());
  const [pageSizeVersion, setPageSizeVersion] = useState(0);
  const pageRefsMap = useRef<Map<number, HTMLDivElement>>(new Map());
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;
  const numPagesRef = useRef(record.pageCount || 1);
  if (pdfDoc?.numPages) numPagesRef.current = pdfDoc.numPages;
  const jumpAnchorRef = useRef<{ pageIndex: number; scrollTop: number | null } | null>(null);
  const recordRef = useRef(record);
  recordRef.current = record;

  // Deterministic page & thumbnail strides with per-page mixed-size/rotation support
  const PAGE_GAP_PX = 24; // gap-6
  const pageHeightPx = Math.max(1, Math.round(defaultPageSize.height * zoom));
  const pageStridePx = pageHeightPx + PAGE_GAP_PX;
  const THUMB_STRIDE_PX = 240;

  const getPageHeightPx = useCallback(
    (idx: number): number => {
      const sz = pageSizesRef.current.get(idx) ?? defaultPageSize;
      return Math.max(1, Math.round(sz.height * zoom));
    },
    [defaultPageSize, zoom]
  );

  const getCumulativeOffsetPx = useCallback(
    (targetIdx: number): number => {
      if (targetIdx <= 0) return 0;
      if (pageSizesRef.current.size === 0) return targetIdx * pageStridePx;
      let offset = 0;
      for (let i = 0; i < targetIdx; i++) {
        offset += getPageHeightPx(i) + PAGE_GAP_PX;
      }
      return offset;
    },
    [getPageHeightPx, pageStridePx]
  );

  const getRemainingHeightAfter = useCallback(
    (endIdx: number, total: number): number => {
      if (endIdx >= total - 1) return 0;
      if (pageSizesRef.current.size === 0) return Math.max(0, (total - 1 - endIdx) * pageStridePx);
      let rem = 0;
      for (let i = endIdx + 1; i < total; i++) {
        rem += getPageHeightPx(i) + PAGE_GAP_PX;
      }
      return rem;
    },
    [getPageHeightPx, pageStridePx]
  );

  const handleMeasurePageSize = useCallback(
    (pageIndex: number, size: { width: number; height: number }) => {
      const prev = pageSizesRef.current.get(pageIndex) ?? defaultPageSize;
      if (Math.abs(prev.width - size.width) < 0.5 && Math.abs(prev.height - size.height) < 0.5) {
        return;
      }
      pageSizesRef.current.set(pageIndex, size);
      setPageSizeVersion((v) => v + 1);
    },
    [defaultPageSize]
  );

  // Debounce expensive PDF.js canvas re-renders during smooth trackpad pinch-to-zoom
  useEffect(() => {
    const t = setTimeout(() => setRenderZoom(zoom), 110);
    return () => clearTimeout(t);
  }, [zoom]);

  // Pre-group annotations by page so React.memo on VirtualPdfPage is never defeated on scroll
  const annotationsByPage = useMemo(() => {
    const map = new Map<number, PdfAnnotation[]>();
    for (const ann of record.annotations) {
      const list = map.get(ann.pageIndex);
      if (list) list.push(ann);
      else map.set(ann.pageIndex, [ann]);
    }
    return map;
  }, [record.annotations]);

  const pendingRedactions = useMemo(
    () => record.annotations.filter((a): a is PdfRedactAnnotation => a.type === 'redact'),
    [record.annotations]
  );

  const handleOpenCanvasMenu = useCallback(
    (x: number, y: number, pageIdx: number, normX: number, normY: number) => {
      setCanvasMenu({ x, y, pageIdx, normX, normY });
    },
    []
  );

  const handleClearPendingTextPlacement = useCallback(() => {
    setPendingTextPlacement(null);
  }, []);

  const registerPageRef = useCallback((pageIndex: number, el: HTMLDivElement | null) => {
    if (el) pageRefsMap.current.set(pageIndex, el);
    else pageRefsMap.current.delete(pageIndex);
  }, []);

  const alignJumpAnchor = useCallback(() => {
    const anchor = jumpAnchorRef.current;
    const container = scrollContainerEl;
    if (!anchor || !container) return;
    const el = pageRefsMap.current.get(anchor.pageIndex);
    if (!el) return;
    const viewportTop = container.getBoundingClientRect().top + container.clientTop;
    const pageTop = el.getBoundingClientRect().top - viewportTop + container.scrollTop;
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTop = Math.max(0, Math.min(maxTop, pageTop - 16));
    anchor.scrollTop = container.scrollTop;
  }, [scrollContainerEl]);

  // Neighboring pages can report their rotated dimensions after the jump.
  // Re-align after the measured layout commits, until the reader scrolls away.
  useLayoutEffect(() => {
    if (pdfDoc && !loading) alignJumpAnchor();
  }, [alignJumpAnchor, currentPage, pageSizeVersion, zoom, pdfDoc, loading]);

  const releaseJumpAnchor = useCallback(() => {
    jumpAnchorRef.current = null;
  }, []);

  const alignSidebarToPage = useCallback((pageIndex: number) => {
    const side = sidebarScrollEl;
    if (!side || sidebarTab !== 'pages') return;
    side.scrollTop = Math.max(0, pageIndex * THUMB_STRIDE_PX - side.clientHeight * 0.35);
    setSidebarScrollTop(side.scrollTop);
  }, [sidebarScrollEl, sidebarTab]);

  useLayoutEffect(() => {
    const anchor = jumpAnchorRef.current;
    if (pdfDoc && !loading && anchor) alignSidebarToPage(anchor.pageIndex);
  }, [alignSidebarToPage, pdfDoc, loading]);

  const scrollToPage = useCallback(
    (pageIdx: number) => {
      const total = Math.max(1, pdfDoc?.numPages ?? numPagesRef.current ?? recordRef.current.pageCount ?? 1);
      const clamped = Math.max(0, Math.min(total - 1, pageIdx));
      jumpAnchorRef.current = { pageIndex: clamped, scrollTop: null };
      currentPageRef.current = clamped;
      setCurrentPage(clamped);
      alignJumpAnchor();
      alignSidebarToPage(clamped);
    },
    [pdfDoc?.numPages, alignJumpAnchor, alignSidebarToPage]
  );

  /**
   * Track current page accurately: prefer actual mounted page DOM boxes intersecting viewport center
   * (exact for mixed-size & rotated PDFs), falling back to cumulative measured offset / stride.
   */
  const handleViewportScroll = useCallback(() => {
    const container = scrollContainerEl;
    if (!container) return;
    const anchor = jumpAnchorRef.current;
    if (anchor) {
      if (anchor.scrollTop === null || Math.abs(anchor.scrollTop - container.scrollTop) < 1) return;
      releaseJumpAnchor();
    }
    const total = pdfDoc?.numPages ?? 0;
    if (total <= 0) return;

    const viewTop = container.getBoundingClientRect().top + container.clientTop;
    const viewBottom = viewTop + container.clientHeight;
    const focusY = viewTop + container.clientHeight * 0.35;

    let matchedPage: number | null = null;
    let bestDist = Infinity;

    for (const [idx, el] of pageRefsMap.current.entries()) {
      const { top, bottom } = el.getBoundingClientRect();
      if (bottom < viewTop || top > viewBottom) continue;
      if (focusY >= top && focusY <= bottom) {
        matchedPage = idx;
        bestDist = 0;
        break;
      }
      const center = (top + bottom) / 2;
      const dist = Math.abs(center - focusY);
      if (dist < bestDist) {
        bestDist = dist;
        matchedPage = idx;
      }
    }

    let closestPage: number;
    if (matchedPage !== null) {
      closestPage = Math.max(0, Math.min(total - 1, matchedPage));
    } else if (pageSizesRef.current.size > 0) {
      // Walk cumulative heights for mixed-size PDFs when scrolling rapidly past mounted window
      const targetY = Math.max(0, container.scrollTop + container.clientHeight * 0.35 - 32);
      let acc = 0;
      let found = total - 1;
      for (let i = 0; i < total; i++) {
        const h = getPageHeightPx(i) + PAGE_GAP_PX;
        if (targetY < acc + h) {
          found = i;
          break;
        }
        acc += h;
      }
      closestPage = found;
    } else {
      const midY = Math.max(0, container.scrollTop + container.clientHeight * 0.35 - 32);
      closestPage = Math.max(0, Math.min(total - 1, Math.floor(midY / pageStridePx)));
    }

    if (closestPage !== currentPageRef.current) {
      currentPageRef.current = closestPage;
      setCurrentPage(closestPage);
    }
  }, [scrollContainerEl, pdfDoc?.numPages, pageStridePx, getPageHeightPx, releaseJumpAnchor]);

  const resolveRawBytes = useCallback(async (): Promise<Uint8Array | null> => {
    const existing = await loadPdfBytes(recordRef.current.blobId ?? recordRef.current.id);
    if (existing) return existing;

    let streamUrl = getPdfStreamUrl(recordRef.current.id);
    if (!streamUrl && recordRef.current.nativePath) {
      streamUrl = await resolveNativePdfPath(recordRef.current.nativePath);
      if (streamUrl) setPdfStreamUrl(recordRef.current.id, streamUrl);
    }
    if (streamUrl) {
      const resp = await fetch(streamUrl);
      if (resp.ok) {
        return new Uint8Array(await resp.arrayBuffer());
      }
    }
    return null;
  }, []);

  // Fast Open via HTTP 206 Range streaming
  useEffect(() => {
    let cancelled = false;
    let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
    let rangeTransport: MainPageRangeTransport | null = null;

    setLoading(true);
    setPdfDoc(null);
    setErrorMsg(null);
    setOutline([]);
    pageSizesRef.current.clear();
    jumpAnchorRef.current = null;
    textCacheRef.current.clear();
    setSearchMatches([]);
    setFormFields([]);
    setFormValues({});
    setConfirmingRedaction(false);

    (async () => {
      try {
        await ensurePdfWorker();
        if (cancelled) return;

        let streamUrl = record.blobId ? null : getPdfStreamUrl(record.id);
        if (!streamUrl && !record.blobId && record.nativePath) {
          streamUrl = await resolveNativePdfPath(record.nativePath);
          if (streamUrl) setPdfStreamUrl(record.id, streamUrl);
        }

        if (streamUrl) {
          if (streamUrl.startsWith('forma://')) {
            // Probe exact size via HEAD or use record.sizeBytes, then stream 64KB Range chunks
            // directly from the main window into the background PDF.js worker!
            let totalLen = recordRef.current.sizeBytes;
            if (!totalLen || totalLen <= 0) {
              const head = await fetch(streamUrl, { method: 'HEAD' });
              totalLen = Number(head.headers.get('Content-Length') || 0);
            }
            if (totalLen > 0) {
              rangeTransport = new MainPageRangeTransport(streamUrl, totalLen, undefined, () => {
                if (cancelled) return;
                clearPdfStreamUrl(recordRef.current.id);
                onChangeRecord({ ...recordRef.current, sizeBytes: 0, updatedAt: Date.now() });
                setSourceVersion((v) => v + 1);
              });
              loadingTask = pdfjsLib.getDocument({
                range: rangeTransport,
                rangeChunkSize: 65536,
                disableAutoFetch: true,
              });
            } else {
              const fullResp = await fetch(streamUrl);
              const ab = await fullResp.arrayBuffer();
              loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(ab) });
            }
          } else if (streamUrl.startsWith('blob:')) {
            // Fetch blob: URL on main thread so opaque-origin Web Worker in WKWebView never fails cross-scheme fetch
            const blobResp = await fetch(streamUrl);
            const ab = await blobResp.arrayBuffer();
            loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(ab) });
          } else {
            loadingTask = pdfjsLib.getDocument({
              url: streamUrl,
              rangeChunkSize: 65536,
              disableAutoFetch: true,
              disableStream: false,
            });
          }
        } else {
          const bytes = await loadPdfBytes(record.blobId ?? record.id);
          if (cancelled) return;
          if (!bytes) {
            setErrorMsg('PDF file not found on disk or in local storage. Re-open the file.');
            setLoading(false);
            return;
          }
          loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(bytes) });
        }

        const loadedProxy = await loadingTask.promise;
        if (cancelled) {
          void loadingTask.destroy();
          return;
        }

        // Probe Page 1 size so all virtual page placeholders match the book's exact aspect ratio
        try {
          const p1 = await loadedProxy.getPage(1);
          const vp1 = p1.getViewport({ scale: 1 });
          if (!cancelled) {
            pageSizesRef.current.set(0, { width: vp1.width, height: vp1.height });
            setDefaultPageSize({ width: vp1.width, height: vp1.height });
          }
        } catch {
          // keep US Letter default
        }

        const targetPage =
          sourceVersion > 0
            ? currentPageRef.current
            : loadFilePosition(recordRef.current.id)?.pdfPage ?? 0;
        const initialPage = Math.max(0, Math.min(loadedProxy.numPages - 1, targetPage));
        if (initialPage > 0) {
          try {
            const pTarget = await loadedProxy.getPage(initialPage + 1);
            const vpTarget = pTarget.getViewport({ scale: 1 });
            if (!cancelled) {
              pageSizesRef.current.set(initialPage, { width: vpTarget.width, height: vpTarget.height });
            }
          } catch {
            // ignore target probe error
          }
        }
        if (cancelled) return;
        numPagesRef.current = loadedProxy.numPages;
        jumpAnchorRef.current = { pageIndex: initialPage, scrollTop: null };
        currentPageRef.current = initialPage;
        setCurrentPage(initialPage);
        setPdfDoc(loadedProxy);
        setLoading(false);

        if (recordRef.current.pageCount !== loadedProxy.numPages) {
          onChangeRecord({
            ...recordRef.current,
            pageCount: loadedProxy.numPages,
          });
        }

        try {
          const toc = (await loadedProxy.getOutline()) as OutlineNode[] | null;
          if (!cancelled && toc && toc.length > 0) {
            setOutline(toc);
          }
        } catch {
          // ignore
        }

        // Auto-detect interactive AcroForm fields (skip full-buffer probe on huge >25MB streamed books)
        if ((recordRef.current.sizeBytes ?? 0) <= 25 * 1024 * 1024) {
          try {
            const raw = await resolveRawBytes();
            if (!cancelled && raw) {
              const detected = await readPdfFormFields(raw);
              if (!cancelled && detected.length > 0) {
                setFormFields(detected);
                const initialVals: Record<string, string | boolean> = {};
                for (const f of detected) initialVals[f.name] = f.value;
                setFormValues(initialVals);
              }
            }
          } catch {
            // ignore non-form or encrypted form probing failures
          }
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(`Could not render PDF: ${(err as Error).message}`);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      rangeTransport?.abort();
      if (loadingTask) {
        const taskToDestroy = loadingTask;
        // Let child VirtualPdfPage & LazyThumbnail effects cancel their renderTasks first
        setTimeout(() => {
          void taskToDestroy.destroy();
        }, 40);
      }
    };
  }, [record.id, record.nativePath, sourceVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset UI state when switching files
  useEffect(() => {
    setSelectedAnnId(null);
    setShowFormPanel(false);
    setOcrBanner(null);
    setConfirmingRedaction(false);
    setArmedSignature(null);
  }, [record.id]);

  const runLazySearch = useCallback(
    async (query: string) => {
      const q = query.trim().toLowerCase();
      if (!q || !pdfDoc) {
        setSearchMatches([]);
        return;
      }
      setIsSearching(true);
      const found: number[] = [];
      for (let i = 0; i < pdfDoc.numPages; i++) {
        let txt = textCacheRef.current.get(i);
        if (txt === undefined) {
          try {
            const p = await pdfDoc.getPage(i + 1);
            const content = await p.getTextContent();
            txt = content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
            textCacheRef.current.set(i, txt);
          } catch {
            txt = '';
          }
        }
        if (txt.toLowerCase().includes(q)) {
          found.push(i);
          if (found.length === 1) scrollToPage(i);
          setSearchMatches([...found]);
        }
      }
      setSearchMatches(found);
      setIsSearching(false);
    },
    [pdfDoc, scrollToPage]
  );

  const jumpToOutlineDest = async (dest: unknown) => {
    if (!pdfDoc || !dest) return;
    try {
      const resolved =
        typeof dest === 'string' ? await pdfDoc.getDestination(dest) : (dest as unknown[]);
      if (Array.isArray(resolved) && resolved[0]) {
        const pageIdx = await pdfDoc.getPageIndex(resolved[0] as never);
        scrollToPage(pageIdx);
      }
    } catch {
      // ignore
    }
  };

  // MacBook trackpad pinch-to-zoom (ctrlKey + wheel) on the PDF scroll viewport
  useEffect(() => {
    const el = scrollContainerEl;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 0.08 : -0.08;
      setZoom(zoom + factor);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [scrollContainerEl, zoom, setZoom]);

  useEffect(() => {
    if (prevZoomRef.current !== zoom) {
      if (!jumpAnchorRef.current && scrollContainerEl && prevZoomRef.current > 0) {
        const ratio = zoom / prevZoomRef.current;
        scrollContainerEl.scrollTop = Math.round(scrollContainerEl.scrollTop * ratio);
      }
      prevZoomRef.current = zoom;
    }
  }, [zoom, scrollContainerEl]);

  const handleFitWidth = useCallback(() => {
    const containerW = scrollContainerEl?.clientWidth ?? window.innerWidth - 240;
    const curPageW = pageSizesRef.current.get(currentPageRef.current)?.width ?? defaultPageSize.width;
    const target = (containerW - 64) / Math.max(200, curPageW);
    setZoom(target);
  }, [scrollContainerEl, defaultPageSize.width, setZoom]);

  useEffect(() => {
    if (loading || !pdfDoc) return;
    const t = setTimeout(() => {
      saveFilePosition(record.id, { pdfPage: currentPage });
    }, 400);
    return () => clearTimeout(t);
  }, [record.id, currentPage, loading, pdfDoc]);

  useEffect(() => {
    onReadingModeChange?.(readingMode);
    return () => {
      onReadingModeChange?.(false);
    };
  }, [readingMode, onReadingModeChange]);

  useEffect(() => {
    const w = window as unknown as { __formaToggleReadingMode?: () => void };
    const toggle = () => setReadingMode((v) => !v);
    w.__formaToggleReadingMode = toggle;

    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inInput = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setShowSearch((v) => !v);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        setReadingMode((v) => !v);
        return;
      }
      if (e.key === 'Escape' && readingMode && !inInput) {
        e.preventDefault();
        setReadingMode(false);
        return;
      }
      if (inInput) return;

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedAnnId) {
        e.preventDefault();
        onChangeRecord({
          ...record,
          annotations: record.annotations.filter((a) => a.id !== selectedAnnId),
          updatedAt: Date.now(),
        });
        setSelectedAnnId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (w.__formaToggleReadingMode === toggle) delete w.__formaToggleReadingMode;
    };
  }, [selectedAnnId, readingMode, record, onChangeRecord]);

  const persistMutatedBytes = useCallback(
    async (nextBytes: Uint8Array, nextAnnotations?: PdfAnnotation[], notice?: string) => {
      const prevBlobId = recordRef.current.blobId ?? recordRef.current.id;
      const blobId = uid('pdf_bytes');
      await savePdfBytes(blobId, nextBytes);
      if (prevBlobId && prevBlobId !== blobId) {
        void deletePdfBytes(prevBlobId);
      }
      const nextBlobUrl = URL.createObjectURL(
        new Blob(
          [
            nextBytes.buffer.slice(
              nextBytes.byteOffset,
              nextBytes.byteOffset + nextBytes.byteLength
            ) as ArrayBuffer,
          ],
          { type: 'application/pdf' }
        )
      );
      setPdfStreamUrl(record.id, nextBlobUrl);
      const count = await getPdfPageCount(nextBytes);
      onChangeRecord({
        ...recordRef.current,
        pageCount: count,
        sizeBytes: nextBytes.byteLength,
        annotations: nextAnnotations ?? recordRef.current.annotations,
        blobId,
        nativePath: undefined,
        updatedAt: Date.now(),
      });
      setSourceVersion((v) => v + 1);
      if (notice) onNotify(notice);
    },
    [record.id, onChangeRecord, onNotify]
  );

  const addAnnotation = useCallback(
    (ann: PdfAnnotation) => {
      onChangeRecord({
        ...recordRef.current,
        annotations: [...recordRef.current.annotations, ann],
        updatedAt: Date.now(),
      });
    },
    [onChangeRecord]
  );

  const deleteAnnotation = useCallback(
    (id: string) => {
      onChangeRecord({
        ...recordRef.current,
        annotations: recordRef.current.annotations.filter((a) => a.id !== id),
        updatedAt: Date.now(),
      });
      setSelectedAnnId(null);
    },
    [onChangeRecord]
  );

  const mutationBusy = useRef(false);
  const mutatePdf = async (operation: () => Promise<void>) => {
    if (mutationBusy.current) { onNotify('Finishing the current PDF edit…'); return; }
    mutationBusy.current = true;
    try { await operation(); }
    catch (err) { onNotify(`PDF edit failed: ${(err as Error).message}`); }
    finally { mutationBusy.current = false; }
  };

  const handleRotate = (pageIdx: number, deg: number) => mutatePdf(async () => {
    const raw = await resolveRawBytes();
    if (!raw) return;
    const next = await rotatePdfPage(raw, pageIdx, deg);
    const rotatedAnns = remapPageAnnotations(recordRef.current.annotations, {
      type: 'rotate',
      index: pageIdx,
      deltaDeg: deg,
    });
    await persistMutatedBytes(next, rotatedAnns, `Rotated page ${pageIdx + 1}`);
  });

  const handleDeletePage = (pageIdx: number) => mutatePdf(async () => {
    const raw = await resolveRawBytes();
    const curTotal = pdfDoc?.numPages ?? recordRef.current.pageCount;
    if (!raw || curTotal <= 1) return;
    const next = await deletePdfPage(raw, pageIdx);
    const remapped = remapPageAnnotations(recordRef.current.annotations, {
      type: 'delete',
      index: pageIdx,
    });
    const nextClampedPage = Math.max(0, Math.min(curTotal - 2, currentPageRef.current));
    currentPageRef.current = nextClampedPage;
    setCurrentPage(nextClampedPage);
    await persistMutatedBytes(next, remapped, `Deleted page ${pageIdx + 1}`);
  });

  const handleDuplicatePage = (pageIdx: number) => mutatePdf(async () => {
    const raw = await resolveRawBytes();
    if (!raw) return;
    const next = await duplicatePdfPage(raw, pageIdx);
    await persistMutatedBytes(next, remapPageAnnotations(recordRef.current.annotations, { type: 'duplicate', index: pageIdx }), `Duplicated page ${pageIdx + 1}`);
  });

  const handleInsertBlank = (afterIdx: number) => mutatePdf(async () => {
    const raw = await resolveRawBytes();
    if (!raw) return;
    const next = await insertBlankPdfPage(raw, afterIdx);
    currentPageRef.current = afterIdx + 1;
    setCurrentPage(afterIdx + 1);
    await persistMutatedBytes(next, remapPageAnnotations(recordRef.current.annotations, { type: 'insert', index: afterIdx }), `Inserted blank page after page ${afterIdx + 1}`);
  });

  const handleMovePage = (fromIdx: number, toIdx: number) => mutatePdf(async () => {
    const raw = await resolveRawBytes();
    if (!raw) return;
    const next = await movePdfPage(raw, fromIdx, toIdx);
    currentPageRef.current = toIdx;
    setCurrentPage(toIdx);
    await persistMutatedBytes(next, remapPageAnnotations(recordRef.current.annotations, { type: 'move', from: fromIdx, to: toIdx }), `Moved page ${fromIdx + 1} to position ${toIdx + 1}`);
  });

  const handleExtractPage = async (pageIdx: number) => {
    try {
      const raw = await resolveRawBytes();
      if (!raw) return;
      const baked = await bakeAnnotationsIntoPdf(
        raw,
        recordRef.current.annotations.filter((a) => a.pageIndex === pageIdx)
      );
      const extracted = await extractPdfPage(baked, pageIdx);
      const safe = recordRef.current.title.replace(/[^a-zA-Z0-9._ -]/g, '_') || 'Document';
      const saved = await triggerFileDownload(extracted, `${safe}_page_${pageIdx + 1}.pdf`, 'application/pdf');
      if (wasNativeSaveCancelled(saved)) return;
      onNotify(`Extracted page ${pageIdx + 1}`);
    } catch (err) {
      onNotify(`Extract failed: ${(err as Error).message}`);
    }
  };

  const handleMergePdfFile = async (file: File) => {
    const raw = await resolveRawBytes();
    if (!raw) return;
    try {
      const otherBytes = new Uint8Array(await file.arrayBuffer());
      const merged = await mergePdfBytes([raw, otherBytes]);
      await persistMutatedBytes(merged, undefined, `Merged "${file.name}" into document`);
    } catch (err) {
      onNotify(`Merge failed: ${(err as Error).message}`);
    }
  };

  const handleExportPdf = async (saveInPlaceIfNative = false) => {
    const raw = await resolveRawBytes();
    if (!raw) return;
    try {
      const cur = recordRef.current;
      const outBytes = await bakeAnnotationsIntoPdf(raw, cur.annotations);
      const safe = cur.title.replace(/[^a-zA-Z0-9._ -]/g, '_') || 'Document';
      let savedPath: string | undefined;
      if (saveInPlaceIfNative && cur.nativePath && isNativeWorkspaceAvailable()) {
        const ok = await writeBinaryWorkspaceFile(cur.nativePath, outBytes);
        if (!ok) {
          onNotify(`Could not save ${cur.nativePath.split('/').pop()}`);
          return;
        }
        savedPath = cur.nativePath;
      } else {
        savedPath = await triggerFileDownload(outBytes, `${safe}.pdf`, 'application/pdf');
        if (wasNativeSaveCancelled(savedPath)) return;
      }
      if (savedPath && (!cur.nativePath || savedPath === cur.nativePath)) {
        // Reload cleanly from the updated disk file & clear baked annotations so repeated saves don't double-bake
        const prevBlobId = cur.blobId ?? cur.id;
        if (prevBlobId) void deletePdfBytes(prevBlobId);
        clearPdfStreamUrl(cur.id);
        const freshUrl = await resolveNativePdfPath(savedPath);
        if (freshUrl) setPdfStreamUrl(cur.id, freshUrl);
        onChangeRecord({
          ...cur,
          nativePath: savedPath,
          blobId: undefined,
          sizeBytes: outBytes.byteLength,
          annotations: [],
          updatedAt: Date.now(),
        });
        setSourceVersion((v) => v + 1);
      } else if (cur.annotations.length > 0 && !savedPath) {
        onChangeRecord({ ...cur, annotations: [], updatedAt: Date.now() });
      }
      onNotify(`Saved ${savedPath ? savedPath.split('/').pop() : `${safe}.pdf`}`);
    } catch (err) {
      onNotify(`Save failed: ${(err as Error).message}`);
    }
  };

  const handleSavePdfRef = useRef<() => Promise<void>>(async () => {});
  handleSavePdfRef.current = () => handleExportPdf(true);

  useEffect(() => {
    const w = window as unknown as { __formaSaveActivePdf?: () => Promise<void> };
    const saver = () => handleSavePdfRef.current();
    w.__formaSaveActivePdf = saver;
    return () => {
      if (w.__formaSaveActivePdf === saver) delete w.__formaSaveActivePdf;
    };
  }, []);

  const handleExportText = async (asMarkdown: boolean) => {
    if (!pdfDoc) return;
    onNotify('Extracting text…');
    try {
      const chunks: string[] = [];
      for (let i = 0; i < pdfDoc.numPages; i++) {
        let txt = textCacheRef.current.get(i);
        if (txt === undefined) {
          const p = await pdfDoc.getPage(i + 1);
          const content = await p.getTextContent();
          txt = content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
          textCacheRef.current.set(i, txt);
        }
        chunks.push(
          asMarkdown ? `## Page ${i + 1}\n\n${txt.trim()}` : `--- Page ${i + 1} ---\n${txt.trim()}`
        );
      }
      const safe = recordRef.current.title.replace(/[^a-zA-Z0-9._ -]/g, '_') || 'Document';
      const savedPath = await triggerFileDownload(
        chunks.join('\n\n'),
        `${safe}.${asMarkdown ? 'md' : 'txt'}`,
        asMarkdown ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8'
      );
      if (wasNativeSaveCancelled(savedPath)) return;
      onNotify(`Saved ${savedPath ? savedPath.split('/').pop() : `${safe}.${asMarkdown ? 'md' : 'txt'}`}`);
    } catch (err) {
      onNotify(`Text export failed: ${(err as Error).message}`);
    }
  };

  // Fillable AcroForms: write form field values back into PDF bytes
  const handleApplyFormFields = async () => {
    setApplyingForm(true);
    await mutatePdf(async () => {
      const raw = await resolveRawBytes();
      if (!raw) return;
      const filled = await fillPdfFormFields(raw, formValues);
      await persistMutatedBytes(filled, undefined, `Applied ${formFields.length} form field value(s) to PDF`);
    });
    setApplyingForm(false);
  };

  // Saved Signature Vault handlers
  const handleStampSignature = useCallback(
    (pageIndex: number, normX: number, normY: number) => {
      if (!armedSignature) return;
      const stamped = stampSignatureToInkAnnotations(armedSignature, pageIndex, normX, normY);
      if (stamped.length === 0) return;
      onChangeRecord({
        ...recordRef.current,
        annotations: [...recordRef.current.annotations, ...stamped],
        updatedAt: Date.now(),
      });
      setArmedSignature(null);
      onNotify(`Stamped "${armedSignature.name}" on page ${pageIndex + 1}`);
    },
    [armedSignature, onChangeRecord, onNotify]
  );

  const handleSaveLastInkSignature = () => {
    const pageInks = record.annotations.filter(
      (a): a is PdfInkAnnotation => a.type === 'ink' && a.pageIndex === currentPage
    );
    const sourceInks =
      pageInks.length > 0
        ? pageInks.slice(-6)
        : record.annotations.filter((a): a is PdfInkAnnotation => a.type === 'ink').slice(-6);
    if (sourceInks.length === 0) {
      onNotify('Draw a signature on the page or use the signature pad first.');
      return;
    }
    const saved = saveSignatureToVault({
      name: sigNameDraft.trim() || `Signature ${savedSignatures.length + 1}`,
      color: sourceInks[sourceInks.length - 1].color || '#1e3a8a',
      strokeWidth: sourceInks[sourceInks.length - 1].strokeWidth || 2.2,
      rawStrokes: sourceInks.map((a) => a.points),
    });
    if (saved) {
      setSavedSignatures(loadSavedSignatures());
      setSigNameDraft('');
      onNotify(`Saved "${saved.name}" to Signature Vault`);
    }
  };

  const handleSavePadSignature = () => {
    if (padStrokes.length === 0) {
      onNotify('Draw inside the signature pad first.');
      return;
    }
    const saved = saveSignatureToVault({
      name: sigNameDraft.trim() || `Signature ${savedSignatures.length + 1}`,
      color: activeColor === '#fde047' ? '#1e3a8a' : activeColor,
      strokeWidth: 2.2,
      rawStrokes: padStrokes,
    });
    if (saved) {
      setSavedSignatures(loadSavedSignatures());
      setArmedSignature(saved);
      setPadStrokes([]);
      setSigNameDraft('');
      setShowSigPad(false);
      onNotify(`Saved "${saved.name}" — click any page to stamp it`);
    }
  };

  const handleDeleteSavedSignature = (sigId: string) => {
    const next = deleteSavedSignature(sigId);
    setSavedSignatures(next);
    if (armedSignature?.id === sigId) setArmedSignature(null);
  };

  // True Redaction: rasterize redacted pages with opaque black boxes (stripping underlying text streams!)
  const handleApplyRedactions = async () => {
    const redactions = recordRef.current.annotations.filter(
      (a): a is PdfRedactAnnotation => a.type === 'redact'
    );
    if (redactions.length === 0) {
      setConfirmingRedaction(false);
      return;
    }
    setApplyingRedaction(true);
    await mutatePdf(async () => {
      const raw = await resolveRawBytes();
      if (!raw) return;

      const byPage = new Map<number, PdfRedactAnnotation[]>();
      for (const r of redactions) {
        const list = byPage.get(r.pageIndex);
        if (list) list.push(r);
        else byPage.set(r.pageIndex, [r]);
      }

      const rasterizedPages = new Map<number, { pngBytes: Uint8Array; width: number; height: number }>();
      if (pdfDoc && typeof document !== 'undefined') {
        for (const [pageIdx, pageRedactions] of byPage.entries()) {
          try {
            const page = await pdfDoc.getPage(pageIdx + 1);
            const baseVp = page.getViewport({ scale: 1 });
            const scale = 2.0;
            const vp = page.getViewport({ scale });
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(vp.width);
            canvas.height = Math.round(vp.height);
            const ctx = canvas.getContext('2d');
            if (!ctx) continue;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;

            // Paint solid opaque black boxes over redacted regions so no pixel or text survives
            ctx.fillStyle = '#000000';
            for (const r of pageRedactions) {
              ctx.fillRect(
                Math.floor(r.x * canvas.width),
                Math.floor(r.y * canvas.height),
                Math.ceil(r.width * canvas.width),
                Math.ceil(r.height * canvas.height)
              );
            }

            const pngBlob = await new Promise<Blob | null>((resolve) =>
              canvas.toBlob((b) => resolve(b), 'image/png')
            );
            if (pngBlob) {
              const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
              rasterizedPages.set(pageIdx, {
                pngBytes,
                width: baseVp.width,
                height: baseVp.height,
              });
            }
          } catch {
            // Fall back to opaque pdf-lib overlay for this page if canvas rasterization fails
          }
        }
      }

      const nextBytes = await applyRedactionsToPdf(raw, redactions, rasterizedPages);
      const remainingAnns = recordRef.current.annotations.filter((a) => a.type !== 'redact');
      for (const pageIdx of byPage.keys()) {
        textCacheRef.current.delete(pageIdx);
      }
      await persistMutatedBytes(
        nextBytes,
        remainingAnns,
        `Permanently redacted ${redactions.length} region${redactions.length === 1 ? '' : 's'} across ${byPage.size} page${byPage.size === 1 ? '' : 's'}`
      );
      setConfirmingRedaction(false);
    });
    setApplyingRedaction(false);
  };

  // Native macOS Vision OCR Integration
  const handleRunOcr = async (mode: 'current' | 'all') => {
    if (ocrBusy) return;
    if (!isNativePdfOcrAvailable()) {
      onNotify('Vision OCR requires the native macOS Forma PDF app.');
      return;
    }
    const nativePath = recordRef.current.nativePath;
    if (!nativePath) {
      onNotify('Save this PDF to disk first to run native macOS Vision OCR.');
      return;
    }
    const total = pdfDoc?.numPages ?? recordRef.current.pageCount ?? 1;
    const pagesToOcr =
      mode === 'current'
        ? [Math.max(0, Math.min(total - 1, currentPageRef.current))]
        : Array.from({ length: total }, (_, i) => i);

    setOcrBusy(true);
    try {
      const collected: string[] = [];
      let succeeded = 0;
      for (const pIdx of pagesToOcr) {
        onNotify(
          mode === 'all'
            ? `Running Vision OCR on page ${pIdx + 1} of ${total}…`
            : `Running Vision OCR on page ${pIdx + 1}…`
        );
        const res = await ocrNativePdfPage(nativePath, pIdx);
        if (res.ok) {
          const text = (res.text ?? (res.lines ? res.lines.join('\n') : '')).trim();
          const prev = textCacheRef.current.get(pIdx) ?? '';
          const mergedText = text || prev;
          textCacheRef.current.set(pIdx, mergedText);
          if (mergedText) {
            collected.push(mode === 'all' ? `--- Page ${pIdx + 1} ---\n${mergedText}` : mergedText);
          }
          succeeded++;
        } else if (mode === 'current') {
          onNotify(res.error || 'Vision OCR failed on this page.');
          return;
        }
      }

      const combined = collected.join('\n\n').trim();
      const charCount = combined.length;
      const label =
        mode === 'current'
          ? `Vision OCR (Page ${pagesToOcr[0] + 1}): ${charCount} characters indexed for ⌘F search & export`
          : `Vision OCR complete (${succeeded}/${total} pages): ${charCount} characters indexed for ⌘F search & export`;
      setOcrBanner({ label, text: combined });
      onNotify(label);
    } finally {
      setOcrBusy(false);
    }
  };

  const pageCount = pdfDoc?.numPages ?? record.pageCount;

  const triggerPrint = () => {
    const webkit = (
      window as unknown as {
        webkit?: { messageHandlers?: { formaPrint?: { postMessage: (p: { title: string }) => void } } };
      }
    ).webkit;
    if (webkit?.messageHandlers?.formaPrint) {
      webkit.messageHandlers.formaPrint.postMessage({ title: record.title });
    } else {
      window.print();
    }
  };

  const renderOutlineItems = (nodes: OutlineNode[], depth = 0): React.ReactNode =>
    nodes.map((node, idx) => (
      <div key={`${depth}_${idx}_${node.title}`}>
        <button
          onClick={() => void jumpToOutlineDest(node.dest)}
          style={{ paddingLeft: `${depth * 10 + 6}px` }}
          className="w-full text-left py-1 pr-1.5 rounded text-[11px] text-slate-700 hover:bg-rose-50 hover:text-rose-700 truncate transition"
          title={node.title}
        >
          {node.title}
        </button>
        {node.items && node.items.length > 0 && renderOutlineItems(node.items, depth + 1)}
      </div>
    ));

  return (
    <div className="relative flex-1 flex flex-col min-h-0 overflow-hidden">
      {!readingMode && (
        <PdfRibbon
          activeTool={activeTool}
          activeColor={activeColor}
          zoom={zoom}
          currentPage={currentPage}
          pageCount={pageCount}
          annotationCount={record.annotations.length}
          pendingRedactionCount={pendingRedactions.length}
          formFieldCount={formFields.length}
          showFormPanel={showFormPanel}
          ocrBusy={ocrBusy}
          showSearch={showSearch}
          showSidebar={showSidebar}
          readingMode={readingMode}
          readingTheme={readingTheme}
          onSelectReadingTheme={setReadingTheme}
          onToggleSidebar={() => setShowSidebar((v) => !v)}
          onToggleReadingMode={() => setReadingMode((v) => !v)}
          onSelectTool={(t) => {
            setActiveTool(t);
            if (t !== 'ink') setArmedSignature(null);
            if (t === 'ink' && activeColor === '#fde047') setActiveColor('#1e3a8a');
            if (t === 'text' && activeColor === '#fde047') setActiveColor('#0f172a');
          }}
          onSelectColor={setActiveColor}
          onUndoAnnotation={() => {
            if (record.annotations.length === 0) return;
            onChangeRecord({
              ...record,
              annotations: record.annotations.slice(0, -1),
              updatedAt: Date.now(),
            });
          }}
          onApplyRedactions={() => setConfirmingRedaction(true)}
          onToggleFormPanel={() => setShowFormPanel((v) => !v)}
          onRunOcrCurrentPage={() => void handleRunOcr('current')}
          onRunOcrAllPages={() => void handleRunOcr('all')}
          onOpenCompare={() => setShowCompareModal(true)}
          onZoomChange={setZoom}
          onFitWidth={handleFitWidth}
          onPageChange={(p) => scrollToPage(Math.max(0, Math.min(pageCount - 1, p)))}
          onRotatePage={() => void handleRotate(currentPage, 90)}
          onInsertBlankPage={() => void handleInsertBlank(currentPage)}
          onMergePdfFile={(f) => void handleMergePdfFile(f)}
          onToggleSearch={() => setShowSearch((v) => !v)}
          onOpenPdfFile={onImportNewPdf}
          onExportPdf={() => void handleExportPdf()}
          onExportText={(md) => void handleExportText(md)}
          onPrint={triggerPrint}
        />
      )}

      {/* Compact Saved Signature Vault Popover Bar (visible when Sign tool is active) */}
      {!readingMode && activeTool === 'ink' && (
        <div className="no-print bg-slate-50 border-b border-slate-200 px-4 py-2 flex flex-wrap items-center gap-2 text-xs">
          <div className="flex items-center gap-1.5 font-semibold text-slate-700">
            <PenTool className="w-3.5 h-3.5 text-rose-600" />
            <span>Signature Vault</span>
          </div>

          {savedSignatures.length === 0 ? (
            <span className="text-slate-400">
              Draw freely on the page or save reusable signatures below
            </span>
          ) : (
            <div className="flex items-center gap-1.5 flex-wrap">
              {savedSignatures.map((sig) => {
                const isArmed = armedSignature?.id === sig.id;
                return (
                  <div
                    key={sig.id}
                    className={`group flex items-center gap-1 pl-1.5 pr-1 py-0.5 rounded-lg border transition ${
                      isArmed
                        ? 'bg-rose-50 border-rose-500 ring-1 ring-rose-400'
                        : 'bg-white border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <button
                      onClick={() => setArmedSignature(isArmed ? null : sig)}
                      title={
                        isArmed
                          ? 'Click anywhere on a page to stamp (click again to cancel)'
                          : `Select "${sig.name}" to stamp on page`
                      }
                      className="flex items-center gap-1.5 text-left"
                    >
                      <img
                        className="w-16 h-6 object-contain pointer-events-none"
                        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(sig.svgPreview)}`}
                        alt=""
                      />
                      <span className="text-[11px] font-medium text-slate-700 max-w-[90px] truncate">
                        {sig.name}
                      </span>
                    </button>
                    <button
                      onClick={() => handleDeleteSavedSignature(sig.id)}
                      title={`Delete "${sig.name}"`}
                      className="p-0.5 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {armedSignature && (
            <span className="px-2 py-0.5 rounded-full bg-rose-600 text-white font-medium text-[11px]">
              Click page to stamp "{armedSignature.name}"
            </span>
          )}

          <div className="flex-1" />

          <div className="flex items-center gap-1.5">
            <input
              value={sigNameDraft}
              onChange={(e) => setSigNameDraft(e.target.value)}
              placeholder="Signature label…"
              className="w-32 px-2 py-1 bg-white border border-slate-200 rounded text-xs focus:outline-none focus:border-rose-500"
            />
            <button
              onClick={handleSaveLastInkSignature}
              title="Save your drawn ink strokes from the page into the vault"
              className="px-2 py-1 rounded bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 font-medium"
            >
              Save Drawn
            </button>
            <button
              onClick={() => {
                setShowSigPad((v) => !v);
                setPadStrokes([]);
                setPadActiveStroke(null);
              }}
              className="px-2 py-1 rounded bg-rose-600 hover:bg-rose-700 text-white font-medium flex items-center gap-1"
            >
              <Plus className="w-3 h-3" />
              <span>{showSigPad ? 'Close Pad' : 'New Pad'}</span>
            </button>
          </div>

          {showSigPad && (
            <div className="w-full mt-1 pt-2 border-t border-slate-200 flex flex-wrap items-center gap-3">
              <div
                ref={sigPadRef}
                onMouseDown={(e) => {
                  const rect = sigPadRef.current?.getBoundingClientRect();
                  if (!rect) return;
                  const pt = {
                    x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
                    y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
                  };
                  setPadActiveStroke([pt]);
                }}
                onMouseMove={(e) => {
                  if (!padActiveStroke) return;
                  const rect = sigPadRef.current?.getBoundingClientRect();
                  if (!rect) return;
                  const pt = {
                    x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
                    y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
                  };
                  setPadActiveStroke((prev) => (prev ? [...prev, pt] : null));
                }}
                onMouseUp={() => {
                  if (padActiveStroke && padActiveStroke.length >= 2) {
                    setPadStrokes((prev) => [...prev, padActiveStroke]);
                  }
                  setPadActiveStroke(null);
                }}
                onMouseLeave={() => {
                  if (padActiveStroke && padActiveStroke.length >= 2) {
                    setPadStrokes((prev) => [...prev, padActiveStroke]);
                  }
                  setPadActiveStroke(null);
                }}
                className="relative w-72 h-24 bg-white border-2 border-dashed border-slate-300 rounded-lg cursor-crosshair select-none overflow-hidden"
              >
                {padStrokes.length === 0 && !padActiveStroke && (
                  <span className="absolute inset-0 flex items-center justify-center text-[11px] text-slate-400 pointer-events-none">
                    Draw signature here…
                  </span>
                )}
                <svg viewBox="0 0 288 96" className="w-full h-full pointer-events-none">
                  {[...padStrokes, ...(padActiveStroke ? [padActiveStroke] : [])].map((stroke, idx) =>
                    stroke.length >= 2 ? (
                      <path
                        key={idx}
                        d={stroke
                          .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x * 288} ${pt.y * 96}`)
                          .join(' ')}
                        fill="none"
                        stroke={activeColor === '#fde047' ? '#1e3a8a' : activeColor}
                        strokeWidth={2.5}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    ) : null
                  )}
                </svg>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPadStrokes([])}
                  className="px-2.5 py-1 rounded bg-white border border-slate-300 hover:bg-slate-100 text-slate-600"
                >
                  Clear
                </button>
                <button
                  onClick={handleSavePadSignature}
                  className="px-3 py-1 rounded bg-slate-900 hover:bg-black text-white font-semibold flex items-center gap-1"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>Save to Vault</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Permanent True Redaction Confirmation Banner */}
      {!readingMode && confirmingRedaction && pendingRedactions.length > 0 && (
        <div className="no-print bg-slate-900 text-white border-b border-rose-500/40 px-4 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0" />
            <span>
              <strong>Apply Redactions Permanently?</strong> This will flatten{' '}
              <strong className="font-mono text-rose-300">{pendingRedactions.length}</strong>{' '}
              marked redaction box{pendingRedactions.length === 1 ? '' : 'es'} into opaque black masks
              and strip underlying text on redacted pages.
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              disabled={applyingRedaction}
              onClick={() => setConfirmingRedaction(false)}
              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
            >
              Cancel
            </button>
            <button
              disabled={applyingRedaction}
              onClick={() => void handleApplyRedactions()}
              className="px-3 py-1 rounded bg-rose-600 hover:bg-rose-700 text-white font-semibold disabled:opacity-50"
            >
              {applyingRedaction ? 'Redacting…' : 'Apply Redactions Permanently'}
            </button>
          </div>
        </div>
      )}

      {/* Vision OCR Status & Copy Text Banner */}
      {!readingMode && ocrBanner && (
        <div className="no-print bg-indigo-50 border-b border-indigo-200 px-4 py-1.5 flex items-center justify-between gap-3 text-xs text-indigo-950">
          <div className="flex items-center gap-2 min-w-0">
            <ScanText className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
            <span className="truncate font-medium">{ocrBanner.label}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {ocrBanner.text && (
              <button
                onClick={() => {
                  void navigator.clipboard?.writeText(ocrBanner.text);
                  onNotify('Copied OCR text to clipboard');
                }}
                className="px-2 py-0.5 rounded bg-white border border-indigo-200 hover:bg-indigo-100 text-indigo-800 font-medium flex items-center gap-1"
              >
                <Copy className="w-3 h-3" />
                <span>Copy OCR Text</span>
              </button>
            )}
            <button
              onClick={() => setOcrBanner(null)}
              className="p-0.5 rounded text-indigo-400 hover:text-indigo-700"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Floating Auto-Fading Reading Mode HUD */}
      {readingMode && (
        <div className="no-print fixed top-3 right-4 z-50 flex items-center gap-2 px-2.5 py-1.5 rounded-xl bg-slate-900/85 backdrop-blur-md border border-white/15 text-slate-100 shadow-xl opacity-35 hover:opacity-100 focus-within:opacity-100 transition-opacity duration-200 select-none">
          <div className="flex items-center gap-0.5 text-xs">
            <button
              disabled={currentPage <= 0}
              onClick={() => scrollToPage(Math.max(0, currentPage - 1))}
              title="Previous Page"
              className="p-1 rounded hover:bg-white/15 disabled:opacity-30"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="font-mono text-[11px] px-1">
              {pageCount > 0 ? currentPage + 1 : 0} / {pageCount}
            </span>
            <button
              disabled={currentPage >= pageCount - 1}
              onClick={() => scrollToPage(Math.min(pageCount - 1, currentPage + 1))}
              title="Next Page"
              className="p-1 rounded hover:bg-white/15 disabled:opacity-30"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="h-4 w-px bg-white/15" />
          <ZoomControl
            zoom={zoom}
            onZoomOut={zoomOut}
            onZoomIn={zoomIn}
            onZoomReset={zoomReset}
            dark
          />
          <div className="h-4 w-px bg-white/15" />
          <ReadingModePicker value={readingTheme} onChange={setReadingTheme} compact />
          <div className="h-4 w-px bg-white/15" />
          <button
            onClick={() => setReadingMode(false)}
            title="Exit Reading Mode (Esc or ⌘\)"
            className="px-2 py-1 rounded-md bg-white/15 hover:bg-white/25 text-white text-[11px] font-medium flex items-center gap-1 transition"
          >
            <Minimize2 className="w-3 h-3" />
            <span>Exit</span>
          </button>
        </div>
      )}

      {showSearch && (
        <div className="no-print bg-slate-50 border-b border-slate-200 px-4 py-2 flex items-center gap-2 text-xs">
          <input
            autoFocus
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runLazySearch(searchQuery);
            }}
            placeholder="Search text across pages & press Enter..."
            className="w-64 px-2.5 py-1 bg-white border border-slate-300 rounded-md focus:outline-none focus:border-rose-500"
          />
          <button
            onClick={() => void runLazySearch(searchQuery)}
            className="px-2.5 py-1 bg-rose-600 text-white rounded-md font-medium hover:bg-rose-700"
          >
            {isSearching ? 'Searching…' : 'Find'}
          </button>
          {searchMatches.length > 0 && (
            <span className="text-slate-600">
              {searchMatches.length} page{searchMatches.length === 1 ? '' : 's'}:
              {searchMatches.slice(0, 10).map((pIdx) => (
                <button
                  key={pIdx}
                  onClick={() => scrollToPage(pIdx)}
                  className={`ml-1 px-1.5 py-0.5 rounded font-mono text-[11px] ${
                    pIdx === currentPage
                      ? 'bg-rose-600 text-white'
                      : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
                  }`}
                >
                  p.{pIdx + 1}
                </button>
              ))}
            </span>
          )}
          <div className="flex-1" />
          <button
            onClick={() => setShowSearch(false)}
            className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-200"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left Sidebar: Lazy Thumbnails & Bookmarks Outline */}
        {!readingMode && showSidebar && (
          <aside className="no-print w-48 bg-slate-100 border-r border-slate-200 flex flex-col shrink-0 hidden md:flex select-none">
          <div className="p-2 border-b border-slate-200 flex gap-1 bg-white/60">
            <button
              onClick={() => setSidebarTab('pages')}
              className={`flex-1 py-1 rounded text-[11px] font-semibold flex items-center justify-center gap-1 transition ${
                sidebarTab === 'pages'
                  ? 'bg-rose-100 text-rose-800'
                  : 'text-slate-500 hover:bg-slate-200/70'
              }`}
            >
              <LayoutGrid className="w-3 h-3" />
              <span>Pages ({pageCount})</span>
            </button>
            <button
              onClick={() => setSidebarTab('outline')}
              className={`flex-1 py-1 rounded text-[11px] font-semibold flex items-center justify-center gap-1 transition ${
                sidebarTab === 'outline'
                  ? 'bg-rose-100 text-rose-800'
                  : 'text-slate-500 hover:bg-slate-200/70'
              }`}
            >
              <BookOpen className="w-3 h-3" />
              <span>Contents</span>
            </button>
          </div>

          <div
            ref={setSidebarScrollEl}
            onScroll={(e) => setSidebarScrollTop(e.currentTarget.scrollTop)}
            className="flex-1 overflow-y-auto p-2.5"
          >
            {sidebarTab === 'outline' ? (
              outline.length > 0 ? (
                <div className="space-y-0.5">{renderOutlineItems(outline)}</div>
              ) : (
                <div className="text-[11px] text-slate-400 px-1 py-4 text-center">
                  This PDF has no embedded chapter bookmarks.
                </div>
              )
            ) : (
              pdfDoc &&
              (() => {
                const total = pdfDoc.numPages;
                const centerIdx = Math.floor(sidebarScrollTop / THUMB_STRIDE_PX);
                const startIdx = Math.max(0, centerIdx - 6);
                const endIdx = Math.min(total - 1, centerIdx + 10);
                const topPad = startIdx * THUMB_STRIDE_PX;
                const bottomPad = Math.max(0, (total - 1 - endIdx) * THUMB_STRIDE_PX);
                const items: React.ReactNode[] = [];
                for (let idx = startIdx; idx <= endIdx; idx++) {
                  const active = idx === currentPage;
                  const annCount = annotationsByPage.get(idx)?.length ?? 0;
                  items.push(
                    <div
                      key={idx}
                      onClick={() => scrollToPage(idx)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setThumbMenu({ x: e.clientX, y: e.clientY, pageIdx: idx });
                      }}
                      className={`p-1.5 rounded-lg cursor-pointer transition border ${
                        active
                          ? 'bg-rose-50 border-rose-500 ring-1 ring-rose-500/30'
                          : 'bg-white/70 border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <LazyThumbnail pdfDoc={pdfDoc} pageNumber={idx + 1} scrollRoot={sidebarScrollEl} />
                      <div className="mt-1 flex items-center justify-between px-0.5 text-[10px] text-slate-600 font-mono">
                        <span>Page {idx + 1}</span>
                        {annCount > 0 && (
                          <span className="px-1 rounded bg-rose-100 text-rose-700 font-sans font-semibold">
                            {annCount}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                }
                return (
                  <div
                    style={{ paddingTop: topPad, paddingBottom: bottomPad }}
                    className="space-y-2.5"
                  >
                    {items}
                  </div>
                );
              })()
            )}
          </div>
        </aside>
        )}

        {/* Continuous Multi-Page Scroll Viewport (Windowed Virtualization: only ~8 pages mounted!) */}
        <main
          ref={setScrollContainerEl}
          onScroll={handleViewportScroll}
          onWheel={releaseJumpAnchor}
          onTouchStart={releaseJumpAnchor}
          style={{ backgroundColor: READING_THEME_STYLES[readingTheme].backdropBg, overflowAnchor: 'none' }}
          className="flex-1 overflow-auto py-8 px-6 transition-colors duration-200"
        >
          {errorMsg ? (
            <div className="mx-auto bg-white border border-rose-200 text-rose-700 rounded-xl p-6 text-xs max-w-md shadow-sm space-y-3">
              <div>{errorMsg}</div>
              <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-semibold cursor-pointer transition">
                <span>Relink PDF File…</span>
                <input
                  type="file"
                  accept=".pdf"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    try {
                      const bytes = new Uint8Array(await file.arrayBuffer());
                      await persistMutatedBytes(bytes, recordRef.current.annotations, `Relinked ${file.name}`);
                      setErrorMsg(null);
                    } catch (err) {
                      onNotify(`Could not relink PDF: ${(err as Error).message}`);
                    }
                  }}
                />
              </label>
            </div>
          ) : loading || !pdfDoc ? (
            <div className="mx-auto w-[612px] h-[792px] bg-white/90 rounded shadow-md flex items-center justify-center text-xs text-slate-500">
              Opening PDF…
            </div>
          ) : (
            (() => {
              const total = pdfDoc.numPages;
              const startPage = Math.max(0, currentPage - 3);
              const endPage = Math.min(total - 1, currentPage + 4);
              const topSpacer = getCumulativeOffsetPx(startPage);
              const bottomSpacer = getRemainingHeightAfter(endPage, total);
              const visiblePages: React.ReactNode[] = [];
              for (let idx = startPage; idx <= endPage; idx++) {
                visiblePages.push(
                  <VirtualPdfPage
                    key={`${record.id}_${sourceVersion}_${idx}`}
                    pdfDoc={pdfDoc}
                    pageIndex={idx}
                    zoom={zoom}
                    renderZoom={renderZoom}
                    defaultSize={pageSizesRef.current.get(idx) ?? defaultPageSize}
                    readingTheme={readingTheme}
                    activeTool={activeTool}
                    activeColor={activeColor}
                    armedSignature={armedSignature}
                    annotations={annotationsByPage.get(idx) ?? EMPTY_ANNOTATIONS}
                    selectedAnnId={selectedAnnId}
                    scrollRoot={scrollContainerEl}
                    registerPageRef={registerPageRef}
                    onMeasurePageSize={handleMeasurePageSize}
                    onSelectAnn={setSelectedAnnId}
                    onAddAnnotation={addAnnotation}
                    onStampSignature={handleStampSignature}
                    onDeleteAnnotation={deleteAnnotation}
                    onOpenCanvasMenu={handleOpenCanvasMenu}
                    pendingTextPlacement={
                      pendingTextPlacement?.pageIndex === idx ? pendingTextPlacement : null
                    }
                    onClearPendingTextPlacement={handleClearPendingTextPlacement}
                  />
                );
              }
              return (
                <div
                  style={{ paddingTop: topSpacer, paddingBottom: bottomSpacer }}
                  className="flex flex-col items-center gap-6"
                >
                  {visiblePages}
                </div>
              );
            })()
          )}
        </main>

        {/* Right Side Panel: Fillable AcroForm Fields */}
        {!readingMode && showFormPanel && formFields.length > 0 && (
          <aside className="no-print w-72 lg:w-80 bg-white border-l border-slate-200 flex flex-col shrink-0">
            <div className="px-4 py-3 border-b border-slate-200 bg-emerald-50/60 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileCheck2 className="w-4 h-4 text-emerald-700" />
                <div>
                  <div className="text-xs font-semibold text-slate-900">
                    Fillable Form ({formFields.length})
                  </div>
                  <div className="text-[10px] text-slate-500">AcroForm fields detected</div>
                </div>
              </div>
              <button
                onClick={() => setShowFormPanel(false)}
                className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-200"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3 text-xs">
              {formFields.map((field) => {
                const curVal = formValues[field.name] ?? field.value;
                return (
                  <div key={field.name} className="space-y-1">
                    <label className="block text-[11px] font-semibold text-slate-700 break-words">
                      {field.name}
                    </label>
                    {field.type === 'text' ? (
                      <input
                        type="text"
                        value={typeof curVal === 'string' ? curVal : String(curVal ?? '')}
                        onChange={(e) =>
                          setFormValues((prev) => ({ ...prev, [field.name]: e.target.value }))
                        }
                        className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-300 rounded-md text-xs text-slate-900 focus:outline-none focus:border-emerald-600 focus:bg-white"
                      />
                    ) : field.type === 'checkbox' ? (
                      <label className="inline-flex items-center gap-2 text-slate-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={Boolean(curVal)}
                          onChange={(e) =>
                            setFormValues((prev) => ({ ...prev, [field.name]: e.target.checked }))
                          }
                          className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                        />
                        <span>{Boolean(curVal) ? 'Checked' : 'Unchecked'}</span>
                      </label>
                    ) : field.type === 'dropdown' ? (
                      <select
                        value={typeof curVal === 'string' ? curVal : ''}
                        onChange={(e) =>
                          setFormValues((prev) => ({ ...prev, [field.name]: e.target.value }))
                        }
                        className="w-full px-2 py-1.5 bg-slate-50 border border-slate-300 rounded-md text-xs text-slate-900 focus:outline-none focus:border-emerald-600"
                      >
                        <option value="">— Select —</option>
                        {(field.options ?? []).map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div className="space-y-1 pl-1">
                        {(field.options ?? []).map((opt) => (
                          <label
                            key={opt}
                            className="flex items-center gap-2 text-slate-700 cursor-pointer"
                          >
                            <input
                              type="radio"
                              name={`acro_radio_${field.name}`}
                              checked={curVal === opt}
                              onChange={() =>
                                setFormValues((prev) => ({ ...prev, [field.name]: opt }))
                              }
                              className="text-emerald-600 focus:ring-emerald-500"
                            />
                            <span>{opt}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="p-3 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
              <button
                onClick={() => setShowFormPanel(false)}
                className="px-3 py-1.5 rounded-lg text-xs text-slate-600 hover:bg-slate-200"
              >
                Close
              </button>
              <button
                disabled={applyingForm}
                onClick={() => void handleApplyFormFields()}
                className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs disabled:opacity-50 transition"
              >
                {applyingForm ? 'Applying…' : 'Apply to PDF'}
              </button>
            </div>
          </aside>
        )}
      </div>

      {/* Bottom Status Bar */}
      {!readingMode && (
      <div className="no-print h-8 bg-slate-100 border-t border-slate-200 px-4 flex items-center justify-between text-[11px] text-slate-500 shrink-0">
        <div className="flex items-center gap-4">
          <span>
            Page <strong className="text-slate-800 font-mono">{currentPage + 1}</strong> of{' '}
            <strong className="text-slate-800 font-mono">{pageCount}</strong>
          </span>
          <span>
            Annotations: <strong className="text-rose-700 font-mono">{record.annotations.length}</strong>
          </span>
          <span>
            Size:{' '}
            <strong className="text-slate-700 font-mono">
              {record.sizeBytes >= 1024 * 1024
                ? `${(record.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
                : `${(record.sizeBytes / 1024).toFixed(1)} KB`}
            </strong>
          </span>
        </div>
        <ZoomControl zoom={zoom} onZoomOut={zoomOut} onZoomIn={zoomIn} onZoomReset={zoomReset} />
      </div>
      )}

      {thumbMenu && (
        <ContextMenu
          x={thumbMenu.x}
          y={thumbMenu.y}
          onClose={() => setThumbMenu(null)}
          items={
            [
              {
                id: 'rotCW',
                label: 'Rotate 90° Clockwise',
                onClick: () => void handleRotate(thumbMenu.pageIdx, 90),
              },
              {
                id: 'rotCCW',
                label: 'Rotate 90° Counter-Clockwise',
                onClick: () => void handleRotate(thumbMenu.pageIdx, -90),
              },
              { id: 'd1', divider: true },
              {
                id: 'up',
                label: 'Move Page Up',
                disabled: thumbMenu.pageIdx === 0,
                onClick: () => void handleMovePage(thumbMenu.pageIdx, thumbMenu.pageIdx - 1),
              },
              {
                id: 'down',
                label: 'Move Page Down',
                disabled: thumbMenu.pageIdx >= pageCount - 1,
                onClick: () => void handleMovePage(thumbMenu.pageIdx, thumbMenu.pageIdx + 1),
              },
              { id: 'd2', divider: true },
              {
                id: 'dup',
                label: 'Duplicate Page',
                onClick: () => void handleDuplicatePage(thumbMenu.pageIdx),
              },
              {
                id: 'insBlank',
                label: 'Insert Blank Page After',
                onClick: () => void handleInsertBlank(thumbMenu.pageIdx),
              },
              {
                id: 'extract',
                label: 'Extract Page as .pdf…',
                onClick: () => void handleExtractPage(thumbMenu.pageIdx),
              },
              { id: 'd3', divider: true },
              {
                id: 'del',
                label: 'Delete Page',
                danger: true,
                disabled: pageCount <= 1,
                onClick: () => void handleDeletePage(thumbMenu.pageIdx),
              },
            ] as ContextMenuItem[]
          }
        />
      )}

      {canvasMenu && (
        <ContextMenu
          x={canvasMenu.x}
          y={canvasMenu.y}
          onClose={() => setCanvasMenu(null)}
          items={
            [
              {
                id: 'addTextHere',
                label: 'Add Text Here',
                onClick: () => {
                  setActiveTool('text');
                  setPendingTextPlacement({
                    pageIndex: canvasMenu.pageIdx,
                    x: canvasMenu.normX,
                    y: canvasMenu.normY,
                  });
                },
              },
              {
                id: 'addNoteHere',
                label: 'Add Sticky Note Here',
                onClick: () => {
                  const t = window.prompt('Enter sticky note text:');
                  if (t && t.trim()) {
                    addAnnotation({
                      id: uid('ann'),
                      type: 'note',
                      pageIndex: canvasMenu.pageIdx,
                      x: canvasMenu.normX,
                      y: canvasMenu.normY,
                      text: t.trim(),
                      color: '#f59e0b',
                    });
                  }
                },
              },
              { id: 'hlMode', label: 'Highlight Tool', onClick: () => setActiveTool('highlight') },
              {
                id: 'signMode',
                label: 'Draw / Signature Tool',
                onClick: () => {
                  setActiveTool('ink');
                  if (activeColor === '#fde047') setActiveColor('#1e3a8a');
                },
              },
              { id: 'd1', divider: true },
              {
                id: 'rot',
                label: `Rotate Page ${canvasMenu.pageIdx + 1} (90° CW)`,
                onClick: () => void handleRotate(canvasMenu.pageIdx, 90),
              },
              { id: 'zin', label: 'Zoom In', shortcut: '⌘+', onClick: zoomIn },
              { id: 'zout', label: 'Zoom Out', shortcut: '⌘-', onClick: zoomOut },
              {
                id: 'rmode',
                label: readingMode ? 'Exit Reading Mode' : 'Enter Reading Mode',
                shortcut: '⌘\\',
                onClick: () => setReadingMode((v) => !v),
              },
              { id: 'zreset', label: 'Actual Size (100%)', onClick: () => setZoom(1.0) },
              { id: 'd-theme', divider: true },
              {
                id: 'theme-pw',
                label: `Reading Mode: Paperwhite${readingTheme === 'paperwhite' ? ' ✓' : ''}`,
                onClick: () => {
                  saveReadingTheme('paperwhite');
                  setReadingTheme('paperwhite');
                },
              },
              {
                id: 'theme-sepia',
                label: `Reading Mode: Sepia${readingTheme === 'sepia' ? ' ✓' : ''}`,
                onClick: () => {
                  saveReadingTheme('sepia');
                  setReadingTheme('sepia');
                },
              },
              {
                id: 'theme-dark',
                label: `Reading Mode: Night${readingTheme === 'dark' ? ' ✓' : ''}`,
                onClick: () => {
                  saveReadingTheme('dark');
                  setReadingTheme('dark');
                },
              },
              {
                id: 'theme-light',
                label: `Reading Mode: Light${readingTheme === 'light' ? ' ✓' : ''}`,
                onClick: () => {
                  saveReadingTheme('light');
                  setReadingTheme('light');
                },
              },
              { id: 'd2', divider: true },
              { id: 'savePdf', label: 'Save Annotated PDF…', onClick: () => void handleExportPdf() },
              { id: 'printPdf', label: 'Print…', shortcut: '⌘P', onClick: triggerPrint },
            ] as ContextMenuItem[]
          }
        />
      )}

      {showCompareModal && (
        <PdfCompareModal
          baseTitle={record.title}
          basePdfDoc={pdfDoc}
          baseTextCache={textCacheRef.current}
          onClose={() => setShowCompareModal(false)}
          onJumpToPage={(pageIdx) => scrollToPage(pageIdx)}
        />
      )}
    </div>
  );
};
