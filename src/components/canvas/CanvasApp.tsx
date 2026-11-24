import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Circle,
  Diamond,
  Download,
  FileCode2,
  FileImage,
  FileJson,
  FileText,
  FolderOpen,
  Frame,
  GitBranch,
  Grid3X3,
  Hand,
  ImagePlus,
  Maximize2,
  Minus,
  Moon,
  MousePointer2,
  Pencil,
  Plus,
  Redo2,
  Send,
  Square,
  StickyNote,
  Sun,
  Type,
  Undo2,
  X,
} from 'lucide-react';
import {
  CanvasAnchorSide,
  CanvasBackground,
  CanvasBinding,
  CanvasData,
  CanvasElement,
  CanvasElementKind,
  CanvasPoint,
  CanvasTool,
} from '../../types/canvas';
import {
  buildSketchyLinePaths,
  buildSketchyShapePaths,
  computeElementBounds,
  exportCanvasToExcalidraw,
  exportCanvasToFcanvas,
  exportCanvasToPdf,
  exportCanvasToPng,
  exportCanvasToSvg,
  getAnchorPoint,
  getCanvasFontStack,
  getTextColorForElement,
  importMermaidToCanvas,
  pointsToSmoothSvgPath,
  resolveBoundEndpoints,
} from '../../engine/canvas/canvasCodec';
import { triggerFileDownload, wasNativeSaveCancelled } from '../../storage/workspaceStore';
import { CanvasInspector } from './CanvasInspector';

export interface CanvasHistoryEntry {
  past: CanvasData[];
  future: CanvasData[];
}

export interface CanvasTransferPayload {
  canvasId: string;
  title: string;
  svgDataUrl: string;
  svgText: string;
}

export function svgStringToDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

export interface CanvasAppProps {
  canvas: CanvasData;
  historyMap?: Map<string, CanvasHistoryEntry>;
  onChangeCanvas: (next: CanvasData) => void;
  onImportCanvasFile: (file: File) => void;
  onSendCanvasToSuite?: (payload: CanvasTransferPayload) => void;
  onNotify: (msg: string) => void;
}

type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

interface SnapGuide {
  axis: 'x' | 'y';
  pos: number;
  start: number;
  end: number;
}

interface AnchorMatch {
  elementId: string;
  anchor: CanvasAnchorSide;
  point: CanvasPoint;
}

const MAX_HISTORY = 60;
const SNAP_TOLERANCE = 6;
const BINDABLE_KINDS = new Set<CanvasElementKind>([
  'rect',
  'roundRect',
  'diamond',
  'ellipse',
  'sticky',
  'image',
  'frame',
]);

const DEFAULT_MERMAID_SAMPLE = `flowchart LR
  A[User Request] --> B{Authenticated?}
  B -->|Yes| C(Core API)
  B -->|No| D[Auth Login]
  C --> E[(Postgres DB)]
  C --> F[Redis Cache]`;

function makeId(prefix = 'el'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function sanitizeFilename(title: string): string {
  const cleaned = title.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'forma_canvas';
}

function wrapSvgTextLines(text: string, availWidth: number, fontSize: number): string[] {
  const safeWidth = Math.max(24, availWidth);
  const avgCharW = Math.max(5.5, fontSize * 0.56);
  const maxChars = Math.max(4, Math.floor(safeWidth / avgCharW));
  const out: string[] = [];

  for (const para of text.split('\n')) {
    if (!para) {
      out.push('');
      continue;
    }
    const words = para.split(' ');
    let line = '';
    for (const rawWord of words) {
      if (rawWord.length > maxChars) {
        if (line) {
          out.push(line);
          line = '';
        }
        for (let i = 0; i < rawWord.length; i += maxChars) {
          const slice = rawWord.slice(i, i + maxChars);
          if (i + maxChars < rawWord.length) {
            out.push(slice);
          } else {
            line = slice;
          }
        }
        continue;
      }
      const candidate = line ? `${line} ${rawWord}` : rawWord;
      if (candidate.length > maxChars && line) {
        out.push(line);
        line = rawWord;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out;
}

function getElementBBox(
  el: CanvasElement,
  all: CanvasElement[]
): { x: number; y: number; width: number; height: number } {
  if (el.kind === 'arrow' || el.kind === 'line') {
    const { start, end } = resolveBoundEndpoints(el, all);
    const minX = Math.min(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    const maxX = Math.max(start.x, end.x);
    const maxY = Math.max(start.y, end.y);
    return {
      x: minX,
      y: minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    };
  }
  if (el.kind === 'freehand' && el.points && el.points.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of el.points) {
      const wx = el.x + p.x;
      const wy = el.y + p.y;
      if (wx < minX) minX = wx;
      if (wy < minY) minY = wy;
      if (wx > maxX) maxX = wx;
      if (wy > maxY) maxY = wy;
    }
    return {
      x: minX,
      y: minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    };
  }
  return {
    x: el.width >= 0 ? el.x : el.x + el.width,
    y: el.height >= 0 ? el.y : el.y + el.height,
    width: Math.abs(el.width),
    height: Math.abs(el.height),
  };
}

function findNearestAnchor(
  worldPt: CanvasPoint,
  elements: CanvasElement[],
  excludeIds: Set<string>,
  threshold: number
): AnchorMatch | null {
  const sides: CanvasAnchorSide[] = ['top', 'right', 'bottom', 'left'];
  let best: AnchorMatch | null = null;
  let bestDist = threshold;

  for (const el of elements) {
    if (excludeIds.has(el.id) || !BINDABLE_KINDS.has(el.kind)) continue;
    for (const side of sides) {
      const pt = getAnchorPoint(el, side);
      const dist = Math.hypot(pt.x - worldPt.x, pt.y - worldPt.y);
      if (dist <= bestDist) {
        bestDist = dist;
        best = { elementId: el.id, anchor: side, point: pt };
      }
    }
  }
  return best;
}

function syncBoundArrowsGeometry(elements: CanvasElement[]): CanvasElement[] {
  return elements.map((el) => {
    if ((el.kind === 'arrow' || el.kind === 'line') && (el.startBinding || el.endBinding)) {
      const { start, end } = resolveBoundEndpoints(el, elements);
      return {
        ...el,
        x: start.x,
        y: start.y,
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
        points: [
          { x: 0, y: 0 },
          { x: end.x - start.x, y: end.y - start.y },
        ],
      };
    }
    return el;
  });
}

function strokeDashArray(style?: 'solid' | 'dashed' | 'dotted', sw = 2): string | undefined {
  if (style === 'dashed') return `${sw * 4} ${sw * 2.5}`;
  if (style === 'dotted') return `${sw} ${sw * 2.5}`;
  return undefined;
}

type InteractionState =
  | { kind: 'idle' }
  | {
      kind: 'pan';
      startScreenX: number;
      startScreenY: number;
      origVpX: number;
      origVpY: number;
    }
  | {
      kind: 'marquee';
      startWorld: CanvasPoint;
      currWorld: CanvasPoint;
      additive: boolean;
      baseSelected: string[];
    }
  | {
      kind: 'drag';
      pointerId: number;
      captured: boolean;
      startWorld: CanvasPoint;
      snapshot: CanvasData;
      initialPositions: Map<string, { x: number; y: number }>;
      moved: boolean;
    }
  | {
      kind: 'resize';
      elementId: string;
      handle: ResizeHandle;
      startWorld: CanvasPoint;
      origBox: { x: number; y: number; width: number; height: number };
      snapshot: CanvasData;
      moved: boolean;
    }
  | {
      kind: 'endpoint';
      elementId: string;
      which: 'start' | 'end';
      fixedWorld: CanvasPoint;
      fixedBinding?: CanvasBinding;
      snapshot: CanvasData;
      moved: boolean;
    }
  | {
      kind: 'draw';
      tool: CanvasTool;
      elementId: string;
      startWorld: CanvasPoint;
      snapshot: CanvasData;
      moved: boolean;
    };

export const CanvasApp: React.FC<CanvasAppProps> = ({
  canvas,
  historyMap,
  onChangeCanvas,
  onImportCanvasFile,
  onSendCanvasToSuite,
  onNotify,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const openFileInputRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<CanvasData>(canvas);
  canvasRef.current = canvas;

  const [tool, setTool] = useState<CanvasTool>('select');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [spacePressed, setSpacePressed] = useState(false);
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
  const [hoveredAnchor, setHoveredAnchor] = useState<AnchorMatch | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const editDraftRef = useRef('');
  editDraftRef.current = editDraft;
  const editSnapshotRef = useRef<CanvasData | null>(null);
  const editingFallbackElRef = useRef<CanvasElement | null>(null);
  const editingOpenedAtRef = useRef(0);
  const lastElementClickRef = useRef<{ id: string; time: number; x: number; y: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showMermaidModal, setShowMermaidModal] = useState(false);
  const [mermaidText, setMermaidText] = useState(DEFAULT_MERMAID_SAMPLE);
  const [mermaidError, setMermaidError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // Local viewport state for fluid 60fps pan & zoom, synced with canvas.viewport
  const [viewport, setViewport] = useState(canvas.viewport);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const vpFlushTimerRef = useRef<number | null>(null);

  // Persistent per-canvas Undo / Redo stacks
  const [past, setPast] = useState<CanvasData[]>(() => historyMap?.get(canvas.id)?.past ?? []);
  const [future, setFuture] = useState<CanvasData[]>(() => historyMap?.get(canvas.id)?.future ?? []);
  const clipboardRef = useRef<CanvasElement[]>([]);
  const interactionRef = useRef<InteractionState>({ kind: 'idle' });

  useEffect(() => {
    if (!historyMap) return;
    historyMap.set(canvas.id, { past, future });
  }, [historyMap, canvas.id, past, future]);

  const prevCanvasIdRef = useRef(canvas.id);
  useEffect(() => {
    if (prevCanvasIdRef.current !== canvas.id) {
      prevCanvasIdRef.current = canvas.id;
      const saved = historyMap?.get(canvas.id);
      setPast(saved?.past ?? []);
      setFuture(saved?.future ?? []);
      setSelectedIds([]);
      setEditingId(null);
      setSnapGuides([]);
      setHoveredAnchor(null);
      setViewport(canvas.viewport);
    }
  }, [canvas.id, canvas.viewport, historyMap]);

  useEffect(() => {
    return () => {
      if (vpFlushTimerRef.current !== null) {
        window.clearTimeout(vpFlushTimerRef.current);
      }
    };
  }, []);

  const flushViewport = useCallback(
    (vp: { x: number; y: number; zoom: number }, immediate = false) => {
      if (vpFlushTimerRef.current !== null) {
        window.clearTimeout(vpFlushTimerRef.current);
        vpFlushTimerRef.current = null;
      }
      const commit = () => {
        const curr = canvasRef.current;
        if (
          Math.abs(curr.viewport.x - vp.x) < 0.5 &&
          Math.abs(curr.viewport.y - vp.y) < 0.5 &&
          Math.abs(curr.viewport.zoom - vp.zoom) < 0.001
        ) {
          return;
        }
        onChangeCanvas({ ...curr, viewport: vp });
      };
      if (immediate) {
        commit();
      } else {
        vpFlushTimerRef.current = window.setTimeout(commit, 180);
      }
    },
    [onChangeCanvas]
  );

  const pushHistorySnapshot = useCallback((snapshot: CanvasData) => {
    setPast((prev) => [...prev.slice(-(MAX_HISTORY - 1)), snapshot]);
    setFuture([]);
  }, []);

  const commitCanvasChange = useCallback(
    (nextElements: CanvasElement[], snapshotBefore?: CanvasData) => {
      const curr = canvasRef.current;
      if (snapshotBefore) {
        pushHistorySnapshot(snapshotBefore);
      }
      onChangeCanvas({
        ...curr,
        elements: nextElements,
        viewport: viewportRef.current,
        updatedAt: Date.now(),
      });
    },
    [onChangeCanvas, pushHistorySnapshot]
  );

  const handleUndo = useCallback(() => {
    setPast((prev) => {
      if (prev.length === 0) return prev;
      const previous = prev[prev.length - 1];
      setFuture((f) => [canvasRef.current, ...f.slice(0, MAX_HISTORY - 1)]);
      onChangeCanvas({ ...previous, viewport: viewportRef.current, updatedAt: Date.now() });
      setEditingId(null);
      return prev.slice(0, -1);
    });
  }, [onChangeCanvas]);

  const handleRedo = useCallback(() => {
    setFuture((prev) => {
      if (prev.length === 0) return prev;
      const next = prev[0];
      setPast((p) => [...p.slice(-(MAX_HISTORY - 1)), canvasRef.current]);
      onChangeCanvas({ ...next, viewport: viewportRef.current, updatedAt: Date.now() });
      setEditingId(null);
      return prev.slice(1);
    });
  }, [onChangeCanvas]);

  const screenToWorld = useCallback((clientX: number, clientY: number): CanvasPoint => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const vp = viewportRef.current;
    return {
      x: (clientX - rect.left - vp.x) / vp.zoom,
      y: (clientY - rect.top - vp.y) / vp.zoom,
    };
  }, []);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedElements = useMemo(
    () => canvas.elements.filter((el) => selectedSet.has(el.id)),
    [canvas.elements, selectedSet]
  );

  // ============================================================================
  // Inline Text Editing
  // ============================================================================

  const startTextEdit = useCallback((el: CanvasElement, snapshotOverride?: CanvasData) => {
    if (el.locked || el.kind === 'freehand' || el.kind === 'image') return;
    editSnapshotRef.current = snapshotOverride ?? canvasRef.current;
    editingFallbackElRef.current = el;
    editingOpenedAtRef.current = performance.now();
    const initial = el.text ?? '';
    editDraftRef.current = initial;
    setEditingId(el.id);
    setEditDraft(initial);
    setSelectedIds([el.id]);
    const focusBox = () => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      if (initial.length > 0) {
        ta.select();
      } else {
        ta.setSelectionRange(0, 0);
      }
    };
    requestAnimationFrame(focusBox);
    window.setTimeout(focusBox, 25);
  }, []);

  useEffect(() => {
    if (!editingId) return;
    const focusBox = () => {
      const ta = textareaRef.current;
      if (!ta) return;
      if (document.activeElement !== ta) {
        ta.focus();
      }
    };
    focusBox();
    const raf = requestAnimationFrame(focusBox);
    const t = window.setTimeout(focusBox, 40);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, [editingId]);

  const finishTextEdit = useCallback(
    (commit = true) => {
      if (!editingId) return;
      const targetId = editingId;
      const draft = editDraftRef.current;
      const snap = editSnapshotRef.current;
      setEditingId(null);
      editSnapshotRef.current = null;
      editingFallbackElRef.current = null;

      if (!commit) return;
      const curr = canvasRef.current;
      const existing = curr.elements.find((e) => e.id === targetId);
      if (!existing) return;

      // Remove empty newly-created standalone text box if user left it blank
      if (existing.kind === 'text' && draft.trim() === '' && (existing.text ?? '') === '') {
        const filtered = curr.elements.filter((e) => e.id !== targetId);
        onChangeCanvas({ ...curr, elements: filtered, updatedAt: Date.now() });
        setSelectedIds((prev) => prev.filter((id) => id !== targetId));
        return;
      }

      if ((existing.text ?? '') === draft) return;

      const updated = curr.elements.map((e) => {
        if (e.id !== targetId) return e;
        if (e.kind === 'text') {
          const lines = draft.split('\n');
          const fs = e.fontSize ?? 18;
          const estH = Math.max(36, lines.length * fs * 1.4 + 12);
          const longest = Math.max(...lines.map((l) => l.length), 6);
          const estW = Math.max(e.width, Math.min(640, longest * fs * 0.62 + 24));
          return { ...e, text: draft, width: estW, height: Math.max(e.height, estH) };
        }
        return { ...e, text: draft };
      });
      commitCanvasChange(updated, snap ?? curr);
    },
    [editingId, commitCanvasChange, onChangeCanvas]
  );

  // ============================================================================
  // Viewport Controls: Zoom & Fit to Content
  // ============================================================================

  const zoomAroundScreenPoint = useCallback(
    (nextZoomRaw: number, screenX: number, screenY: number, immediateFlush = false) => {
      const nextZoom = clamp(nextZoomRaw, 0.15, 4);
      const vp = viewportRef.current;
      const wx = (screenX - vp.x) / vp.zoom;
      const wy = (screenY - vp.y) / vp.zoom;
      const nextVp = {
        x: screenX - wx * nextZoom,
        y: screenY - wy * nextZoom,
        zoom: nextZoom,
      };
      setViewport(nextVp);
      flushViewport(nextVp, immediateFlush);
    },
    [flushViewport]
  );

  const zoomByFactor = useCallback(
    (factor: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      const cx = rect ? rect.width / 2 : 400;
      const cy = rect ? rect.height / 2 : 300;
      zoomAroundScreenPoint(viewportRef.current.zoom * factor, cx, cy, true);
    },
    [zoomAroundScreenPoint]
  );

  const resetZoom = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    const cx = rect ? rect.width / 2 : 400;
    const cy = rect ? rect.height / 2 : 300;
    zoomAroundScreenPoint(1, cx, cy, true);
  }, [zoomAroundScreenPoint]);

  const fitToContent = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const elements = canvasRef.current.elements;
    if (elements.length === 0) {
      const nextVp = { x: 0, y: 0, zoom: 1 };
      setViewport(nextVp);
      flushViewport(nextVp, true);
      return;
    }
    const b = computeElementBounds(elements);
    const pad = 80;
    const availW = Math.max(160, rect.width - pad * 2);
    const availH = Math.max(160, rect.height - pad * 2);
    const z = clamp(Math.min(availW / Math.max(1, b.width), availH / Math.max(1, b.height)), 0.2, 1.5);
    const nextVp = {
      x: rect.width / 2 - (b.minX + b.width / 2) * z,
      y: rect.height / 2 - (b.minY + b.height / 2) * z,
      zoom: z,
    };
    setViewport(nextVp);
    flushViewport(nextVp, true);
  }, [flushViewport]);

  // Attach non-passive wheel listener for smooth trackpad pan & pinch-to-zoom
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.008);
        zoomAroundScreenPoint(
          viewportRef.current.zoom * factor,
          e.clientX - rect.left,
          e.clientY - rect.top,
          false
        );
      } else {
        const vp = viewportRef.current;
        const nextVp = {
          x: vp.x - e.deltaX,
          y: vp.y - e.deltaY,
          zoom: vp.zoom,
        };
        setViewport(nextVp);
        flushViewport(nextVp, false);
      }
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [zoomAroundScreenPoint, flushViewport]);

  // ============================================================================
  // Selection Operations (Patch, Arrange, Duplicate, Copy/Paste, Delete, Lock)
  // ============================================================================

  const handlePatchSelected = useCallback(
    (patch: Partial<CanvasElement>) => {
      if (selectedIds.length === 0) return;
      const curr = canvasRef.current;
      const sel = new Set(selectedIds);
      const next = curr.elements.map((el) => (sel.has(el.id) ? { ...el, ...patch } : el));
      commitCanvasChange(next, curr);
    },
    [selectedIds, commitCanvasChange]
  );

  const handleArrange = useCallback(
    (direction: 'forward' | 'backward' | 'front' | 'back') => {
      if (selectedIds.length === 0) return;
      const curr = canvasRef.current;
      const sel = new Set(selectedIds);
      const arr = [...curr.elements];

      if (direction === 'front') {
        const rest = arr.filter((e) => !sel.has(e.id));
        const picked = arr.filter((e) => sel.has(e.id));
        commitCanvasChange([...rest, ...picked], curr);
      } else if (direction === 'back') {
        const picked = arr.filter((e) => sel.has(e.id));
        const rest = arr.filter((e) => !sel.has(e.id));
        commitCanvasChange([...picked, ...rest], curr);
      } else if (direction === 'forward') {
        for (let i = arr.length - 2; i >= 0; i--) {
          if (sel.has(arr[i].id) && !sel.has(arr[i + 1].id)) {
            [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
          }
        }
        commitCanvasChange(arr, curr);
      } else if (direction === 'backward') {
        for (let i = 1; i < arr.length; i++) {
          if (sel.has(arr[i].id) && !sel.has(arr[i - 1].id)) {
            [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
          }
        }
        commitCanvasChange(arr, curr);
      }
    },
    [selectedIds, commitCanvasChange]
  );

  const cloneElementsWithOffset = useCallback((source: CanvasElement[], offset = 28): CanvasElement[] => {
    const idMap = new Map<string, string>();
    for (const el of source) {
      idMap.set(el.id, makeId(el.kind.slice(0, 3)));
    }
    return source.map((el) => {
      const nextId = idMap.get(el.id)!;
      const cloned: CanvasElement = {
        ...el,
        id: nextId,
        x: el.x + offset,
        y: el.y + offset,
        locked: false,
        points: el.points ? el.points.map((p) => ({ ...p })) : undefined,
      };
      if (el.startBinding) {
        const mapped = idMap.get(el.startBinding.elementId);
        cloned.startBinding = mapped ? { ...el.startBinding, elementId: mapped } : undefined;
      }
      if (el.endBinding) {
        const mapped = idMap.get(el.endBinding.elementId);
        cloned.endBinding = mapped ? { ...el.endBinding, elementId: mapped } : undefined;
      }
      return cloned;
    });
  }, []);

  const handleDuplicate = useCallback(() => {
    if (selectedIds.length === 0) return;
    const curr = canvasRef.current;
    const sel = new Set(selectedIds);
    const toClone = curr.elements.filter((e) => sel.has(e.id));
    if (toClone.length === 0) return;
    const clones = cloneElementsWithOffset(toClone, 28);
    const next = syncBoundArrowsGeometry([...curr.elements, ...clones]);
    commitCanvasChange(next, curr);
    setSelectedIds(clones.map((c) => c.id));
  }, [selectedIds, cloneElementsWithOffset, commitCanvasChange]);

  const handleToggleLock = useCallback(() => {
    if (selectedIds.length === 0) return;
    const curr = canvasRef.current;
    const sel = new Set(selectedIds);
    const allLocked = curr.elements.filter((e) => sel.has(e.id)).every((e) => Boolean(e.locked));
    const next = curr.elements.map((e) => (sel.has(e.id) ? { ...e, locked: !allLocked } : e));
    commitCanvasChange(next, curr);
  }, [selectedIds, commitCanvasChange]);

  const handleDeleteSelected = useCallback(() => {
    if (selectedIds.length === 0) return;
    const curr = canvasRef.current;
    const sel = new Set(selectedIds);
    const removable = new Set(
      curr.elements.filter((e) => sel.has(e.id) && !e.locked).map((e) => e.id)
    );
    if (removable.size === 0) {
      onNotify('Unlock selected elements before deleting.');
      return;
    }
    const remaining = curr.elements
      .filter((e) => !removable.has(e.id))
      .map((e) => {
        // Detach bindings pointing to deleted elements
        let changed = false;
        let sb = e.startBinding;
        let eb = e.endBinding;
        if (sb && removable.has(sb.elementId)) {
          sb = undefined;
          changed = true;
        }
        if (eb && removable.has(eb.elementId)) {
          eb = undefined;
          changed = true;
        }
        return changed ? { ...e, startBinding: sb, endBinding: eb } : e;
      });
    commitCanvasChange(remaining, curr);
    setSelectedIds((prev) => prev.filter((id) => !removable.has(id)));
  }, [selectedIds, commitCanvasChange, onNotify]);

  // ============================================================================
  // Image Insertion (File Picker, Drag-and-Drop, Clipboard Paste)
  // ============================================================================

  const insertImageFile = useCallback(
    (file: File, dropWorldPt?: CanvasPoint) => {
      if (!file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : '';
        if (!dataUrl) return;
        const img = new Image();
        img.onload = () => {
          const maxW = 420;
          const scale = img.naturalWidth > maxW ? maxW / img.naturalWidth : 1;
          const w = Math.max(80, Math.round(img.naturalWidth * scale));
          const h = Math.max(60, Math.round(img.naturalHeight * scale));

          let cx = dropWorldPt?.x;
          let cy = dropWorldPt?.y;
          if (cx === undefined || cy === undefined) {
            const rect = containerRef.current?.getBoundingClientRect();
            const vp = viewportRef.current;
            cx = rect ? (rect.width / 2 - vp.x) / vp.zoom : 300;
            cy = rect ? (rect.height / 2 - vp.y) / vp.zoom : 240;
          }

          const newEl: CanvasElement = {
            id: makeId('img'),
            kind: 'image',
            x: Math.round(cx - w / 2),
            y: Math.round(cy - h / 2),
            width: w,
            height: h,
            src: dataUrl,
            opacity: 1,
          };
          const curr = canvasRef.current;
          commitCanvasChange([...curr.elements, newEl], curr);
          setSelectedIds([newEl.id]);
          setTool('select');
          onNotify(`Inserted image (${w}×${h})`);
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    },
    [commitCanvasChange, onNotify]
  );

  // Global clipboard paste handler for images
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile();
          if (file) {
            e.preventDefault();
            insertImageFile(file);
            return;
          }
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [insertImageFile]);

  // ============================================================================
  // Keyboard Shortcuts
  // ============================================================================

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTyping =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);

      if (e.code === 'Space' && !isTyping) {
        e.preventDefault();
        setSpacePressed(true);
        return;
      }

      if (isTyping || showMermaidModal) return;

      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        handleRedo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelectedIds(canvasRef.current.elements.map((el) => el.id));
        return;
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        handleDuplicate();
        return;
      }
      if (mod && e.key.toLowerCase() === 'c') {
        if (selectedIds.length > 0) {
          e.preventDefault();
          const sel = new Set(selectedIds);
          clipboardRef.current = canvasRef.current.elements
            .filter((el) => sel.has(el.id))
            .map((el) => ({ ...el, points: el.points?.map((p) => ({ ...p })) }));
          onNotify(`Copied ${clipboardRef.current.length} element${clipboardRef.current.length > 1 ? 's' : ''}`);
        }
        return;
      }
      if (mod && e.key.toLowerCase() === 'v') {
        if (clipboardRef.current.length > 0) {
          e.preventDefault();
          const clones = cloneElementsWithOffset(clipboardRef.current, 28);
          clipboardRef.current = clones;
          const curr = canvasRef.current;
          commitCanvasChange(syncBoundArrowsGeometry([...curr.elements, ...clones]), curr);
          setSelectedIds(clones.map((c) => c.id));
        }
        return;
      }
      if (mod && e.key === '0') {
        e.preventDefault();
        resetZoom();
        return;
      }
      if (mod && e.key === '1') {
        e.preventDefault();
        fitToContent();
        return;
      }

      if (e.key === 'Enter' && selectedIds.length === 1 && !editingId) {
        const targetEl = canvasRef.current.elements.find((el) => el.id === selectedIds[0]);
        if (targetEl && !targetEl.locked && targetEl.kind !== 'freehand' && targetEl.kind !== 'image') {
          e.preventDefault();
          startTextEdit(targetEl);
          return;
        }
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedIds.length > 0) {
          e.preventDefault();
          handleDeleteSelected();
        }
        return;
      }

      if (e.key === 'Escape') {
        setSelectedIds([]);
        setTool('select');
        setShowExportMenu(false);
        return;
      }

      // Arrow keys nudge
      if (
        selectedIds.length > 0 &&
        (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      ) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        const curr = canvasRef.current;
        const sel = new Set(selectedIds);
        const moved = curr.elements.map((el) =>
          sel.has(el.id) && !el.locked ? { ...el, x: el.x + dx, y: el.y + dy } : el
        );
        commitCanvasChange(syncBoundArrowsGeometry(moved), curr);
        return;
      }

      if (mod || e.altKey) return;

      // Single-key tool shortcuts
      const k = e.key.toLowerCase();
      const map: Record<string, CanvasTool> = {
        v: 'select',
        h: 'hand',
        r: 'rect',
        u: 'roundRect',
        d: 'diamond',
        o: 'ellipse',
        s: 'sticky',
        t: 'text',
        a: 'arrow',
        l: 'line',
        p: 'freehand',
        f: 'frame',
      };
      if (map[k]) {
        setTool(map[k]);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpacePressed(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [
    showMermaidModal,
    selectedIds,
    editingId,
    startTextEdit,
    handleUndo,
    handleRedo,
    handleDuplicate,
    handleDeleteSelected,
    cloneElementsWithOffset,
    commitCanvasChange,
    resetZoom,
    fitToContent,
    onNotify,
  ]);

  // ============================================================================
  // Export Handlers (all checking wasNativeSaveCancelled)
  // ============================================================================

  const handleExport = useCallback(
    async (format: 'fcanvas' | 'excalidraw' | 'svg' | 'png' | 'pdf') => {
      setShowExportMenu(false);
      const curr = canvasRef.current;
      const safe = sanitizeFilename(curr.title);
      try {
        let savedPath: string | undefined;
        if (format === 'fcanvas') {
          savedPath = await triggerFileDownload(
            exportCanvasToFcanvas(curr),
            `${safe}.fcanvas`,
            'application/json;charset=utf-8'
          );
        } else if (format === 'excalidraw') {
          savedPath = await triggerFileDownload(
            exportCanvasToExcalidraw(curr),
            `${safe}.excalidraw`,
            'application/json;charset=utf-8'
          );
        } else if (format === 'svg') {
          savedPath = await triggerFileDownload(
            exportCanvasToSvg(curr),
            `${safe}.svg`,
            'image/svg+xml;charset=utf-8'
          );
        } else if (format === 'png') {
          const pngBytes = await exportCanvasToPng(curr);
          savedPath = await triggerFileDownload(pngBytes, `${safe}.png`, 'image/png');
        } else if (format === 'pdf') {
          const pdfBytes = await exportCanvasToPdf(curr);
          savedPath = await triggerFileDownload(pdfBytes, `${safe}.pdf`, 'application/pdf');
        }
        if (wasNativeSaveCancelled(savedPath)) return;
        onNotify(`Exported ${safe}.${format}`);
      } catch (err) {
        onNotify(err instanceof Error ? err.message : `Failed to export .${format}`);
      }
    },
    [onNotify]
  );

  const handleSendToSuite = useCallback(() => {
    setShowExportMenu(false);
    const curr = canvasRef.current;
    if (curr.elements.length === 0) {
      onNotify('Add elements to the canvas before embedding');
      return;
    }
    const svgText = exportCanvasToSvg(curr);
    const svgDataUrl = svgStringToDataUrl(svgText);
    if (onSendCanvasToSuite) {
      onSendCanvasToSuite({
        canvasId: curr.id,
        title: curr.title,
        svgDataUrl,
        svgText,
      });
    } else {
      try {
        void navigator.clipboard?.writeText(svgText);
      } catch {
        // ignore clipboard failure
      }
      onNotify(`Copied "${curr.title}" SVG to clipboard`);
    }
  }, [onSendCanvasToSuite, onNotify]);

  // ============================================================================
  // Mermaid Import Modal Handler
  // ============================================================================

  const handleInsertMermaid = useCallback(() => {
    const generated = importMermaidToCanvas(mermaidText);
    if (generated.length === 0) {
      setMermaidError('Could not find any nodes or edges. Try "flowchart TD" or "graph LR".');
      return;
    }

    // Center generated diagram into the current viewport
    const b = computeElementBounds(generated);
    const rect = containerRef.current?.getBoundingClientRect();
    const vp = viewportRef.current;
    const viewCenterX = rect ? (rect.width / 2 - vp.x) / vp.zoom : 400;
    const viewCenterY = rect ? (rect.height / 2 - vp.y) / vp.zoom : 300;
    const offsetX = Math.round(viewCenterX - (b.minX + b.width / 2));
    const offsetY = Math.round(viewCenterY - (b.minY + b.height / 2));

    const shifted = generated.map((el) => ({
      ...el,
      x: el.x + offsetX,
      y: el.y + offsetY,
    }));

    const curr = canvasRef.current;
    commitCanvasChange(syncBoundArrowsGeometry([...curr.elements, ...shifted]), curr);
    setSelectedIds(shifted.map((el) => el.id));
    setShowMermaidModal(false);
    setMermaidError(null);
    setTool('select');
    onNotify(`Imported Mermaid diagram (${shifted.length} elements)`);
  }, [mermaidText, commitCanvasChange, onNotify]);

  // ============================================================================
  // Pointer Interaction Pipeline (Pan, Draw, Drag, Snap, Resize, Endpoint, Marquee)
  // ============================================================================

  const createElementDefaults = useCallback(
    (activeTool: CanvasTool, start: CanvasPoint): CanvasElement => {
      const isDark = canvasRef.current.theme === 'dark';
      const defaultStroke = isDark ? '#e2e8f0' : '#0f172a';
      const base = {
        id: makeId(activeTool.slice(0, 3)),
        x: start.x,
        y: start.y,
        width: 1,
        height: 1,
        stroke: defaultStroke,
        strokeWidth: 2,
        strokeStyle: 'solid' as const,
        roughness: 0 as const,
        opacity: 1,
        fontFamily: 'sans' as const,
        fontSize: 14,
        textAlign: 'center' as const,
      };

      switch (activeTool) {
        case 'sticky':
          return {
            ...base,
            kind: 'sticky',
            width: 180,
            height: 150,
            fill: '#fef08a',
            stroke: '#eab308',
            strokeWidth: 1.5,
            fontFamily: 'hand',
            fontSize: 15,
            textAlign: 'left',
            text: '',
          };
        case 'text':
          return {
            ...base,
            kind: 'text',
            width: 180,
            height: 40,
            fill: 'transparent',
            stroke: defaultStroke,
            fontSize: 18,
            textAlign: 'left',
            text: '',
          };
        case 'frame':
          return {
            ...base,
            kind: 'frame',
            fill: isDark ? '#1e293b' : '#f8fafc',
            stroke: isDark ? '#475569' : '#cbd5e1',
            strokeWidth: 1.5,
            strokeStyle: 'dashed',
            textAlign: 'left',
            text: 'Frame',
          };
        case 'arrow':
        case 'line':
          return {
            ...base,
            kind: activeTool,
            fill: 'transparent',
            points: [
              { x: 0, y: 0 },
              { x: 1, y: 1 },
            ],
          };
        case 'freehand':
          return {
            ...base,
            kind: 'freehand',
            fill: 'transparent',
            strokeWidth: 2.5,
            points: [{ x: 0, y: 0 }],
          };
        case 'diamond':
          return {
            ...base,
            kind: 'diamond',
            fill: isDark ? '#134e4a' : '#f0fdfa',
            stroke: '#0d9488',
          };
        case 'ellipse':
          return {
            ...base,
            kind: 'ellipse',
            fill: isDark ? '#1e3a8a' : '#eff6ff',
            stroke: '#2563eb',
          };
        case 'roundRect':
          return {
            ...base,
            kind: 'roundRect',
            fill: isDark ? '#1e293b' : '#ffffff',
            stroke: defaultStroke,
          };
        case 'rect':
        default:
          return {
            ...base,
            kind: 'rect',
            fill: isDark ? '#1e293b' : '#ffffff',
            stroke: defaultStroke,
          };
      }
    },
    []
  );

  const handleBoardPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      setShowExportMenu(false);
      if (editingId) {
        finishTextEdit(true);
      }

      // Middle-mouse, Hand tool, or Spacebar -> Pan
      if (e.button === 1 || tool === 'hand' || spacePressed) {
        e.preventDefault();
        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
        interactionRef.current = {
          kind: 'pan',
          startScreenX: e.clientX,
          startScreenY: e.clientY,
          origVpX: viewportRef.current.x,
          origVpY: viewportRef.current.y,
        };
        return;
      }

      if (e.button !== 0) return;

      const worldPt = screenToWorld(e.clientX, e.clientY);

      // Select tool on empty background -> Marquee selection
      if (tool === 'select') {
        if (!e.shiftKey) setSelectedIds([]);
        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
        interactionRef.current = {
          kind: 'marquee',
          startWorld: worldPt,
          currWorld: worldPt,
          additive: e.shiftKey,
          baseSelected: e.shiftKey ? [...selectedIds] : [],
        };
        return;
      }

      // Drawing tools
      const curr = canvasRef.current;
      const newEl = createElementDefaults(tool, worldPt);

      // Snap arrow/line start to nearby shape anchor (within 18px)
      if (tool === 'arrow' || tool === 'line') {
        const snapThreshold = Math.max(18, 18 / viewportRef.current.zoom);
        const match = findNearestAnchor(worldPt, curr.elements, new Set([newEl.id]), snapThreshold);
        if (match) {
          newEl.x = match.point.x;
          newEl.y = match.point.y;
          newEl.startBinding = { elementId: match.elementId, anchor: match.anchor };
          setHoveredAnchor(match);
        }
      }

      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      onChangeCanvas({
        ...curr,
        elements: [...curr.elements, newEl],
        updatedAt: Date.now(),
      });
      setSelectedIds([newEl.id]);
      interactionRef.current = {
        kind: 'draw',
        tool,
        elementId: newEl.id,
        startWorld: { x: newEl.x, y: newEl.y },
        snapshot: curr,
        moved: false,
      };
    },
    [
      editingId,
      finishTextEdit,
      tool,
      spacePressed,
      screenToWorld,
      selectedIds,
      createElementDefaults,
      onChangeCanvas,
    ]
  );

  const handleElementPointerDown = useCallback(
    (e: React.PointerEvent, el: CanvasElement) => {
      if (e.button === 1 || tool === 'hand' || spacePressed) {
        return; // Bubble to board pan
      }
      if (tool !== 'select') {
        return; // Allow drawing on top of frames/shapes
      }
      e.stopPropagation();
      setShowExportMenu(false);
      if (editingId && editingId !== el.id) {
        finishTextEdit(true);
      }
      if (editingId === el.id) return;

      // Reliable double-click detection (independent of pointer capture / WebKit dblclick quirks)
      const now = performance.now();
      const prevClick = lastElementClickRef.current;
      const isDoubleTap =
        e.detail >= 2 ||
        (prevClick !== null &&
          prevClick.id === el.id &&
          now - prevClick.time < 380 &&
          Math.hypot(e.clientX - prevClick.x, e.clientY - prevClick.y) < 8);
      if (isDoubleTap) {
        lastElementClickRef.current = null;
        interactionRef.current = { kind: 'idle' };
        if (!el.locked && el.kind !== 'freehand' && el.kind !== 'image') {
          e.preventDefault();
          startTextEdit(el);
        }
        return;
      }
      lastElementClickRef.current = { id: el.id, time: now, x: e.clientX, y: e.clientY };

      let nextSel: string[];
      if (e.shiftKey) {
        nextSel = selectedIds.includes(el.id)
          ? selectedIds.filter((id) => id !== el.id)
          : [...selectedIds, el.id];
      } else if (selectedIds.includes(el.id)) {
        nextSel = selectedIds;
      } else {
        nextSel = [el.id];
      }
      setSelectedIds(nextSel);

      const curr = canvasRef.current;
      const initialPositions = new Map<string, { x: number; y: number }>();
      for (const item of curr.elements) {
        if (nextSel.includes(item.id) && !item.locked) {
          initialPositions.set(item.id, { x: item.x, y: item.y });
        }
      }
      if (initialPositions.size === 0) return;

      // Defer pointer capture until actual drag (>3px) so double-click events stay intact
      interactionRef.current = {
        kind: 'drag',
        pointerId: e.pointerId,
        captured: false,
        startWorld: screenToWorld(e.clientX, e.clientY),
        snapshot: curr,
        initialPositions,
        moved: false,
      };
    },
    [tool, spacePressed, editingId, finishTextEdit, startTextEdit, selectedIds, screenToWorld]
  );

  const handleResizePointerDown = useCallback(
    (e: React.PointerEvent, el: CanvasElement, handle: ResizeHandle) => {
      if (el.locked) return;
      e.stopPropagation();
      containerRef.current?.setPointerCapture(e.pointerId);
      interactionRef.current = {
        kind: 'resize',
        elementId: el.id,
        handle,
        startWorld: screenToWorld(e.clientX, e.clientY),
        origBox: { x: el.x, y: el.y, width: el.width, height: el.height },
        snapshot: canvasRef.current,
        moved: false,
      };
    },
    [screenToWorld]
  );

  const handleEndpointPointerDown = useCallback(
    (e: React.PointerEvent, el: CanvasElement, which: 'start' | 'end') => {
      if (el.locked) return;
      e.stopPropagation();
      const { start, end } = resolveBoundEndpoints(el, canvasRef.current.elements);
      containerRef.current?.setPointerCapture(e.pointerId);
      interactionRef.current = {
        kind: 'endpoint',
        elementId: el.id,
        which,
        fixedWorld: which === 'start' ? end : start,
        fixedBinding: which === 'start' ? el.endBinding : el.startBinding,
        snapshot: canvasRef.current,
        moved: false,
      };
    },
    []
  );

  const handleBoardPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const state = interactionRef.current;

      // Live anchor preview when arrow/line tool is armed even before clicking
      if (state.kind === 'idle') {
        if (tool === 'arrow' || tool === 'line') {
          const wp = screenToWorld(e.clientX, e.clientY);
          const match = findNearestAnchor(
            wp,
            canvasRef.current.elements,
            new Set(),
            Math.max(18, 18 / viewportRef.current.zoom)
          );
          setHoveredAnchor(match);
        } else if (hoveredAnchor) {
          setHoveredAnchor(null);
        }
        return;
      }

      if (state.kind === 'pan') {
        const dx = e.clientX - state.startScreenX;
        const dy = e.clientY - state.startScreenY;
        const nextVp = {
          x: state.origVpX + dx,
          y: state.origVpY + dy,
          zoom: viewportRef.current.zoom,
        };
        setViewport(nextVp);
        return;
      }

      const worldPt = screenToWorld(e.clientX, e.clientY);

      if (state.kind === 'marquee') {
        state.currWorld = worldPt;
        const x = Math.min(state.startWorld.x, worldPt.x);
        const y = Math.min(state.startWorld.y, worldPt.y);
        const w = Math.abs(worldPt.x - state.startWorld.x);
        const h = Math.abs(worldPt.y - state.startWorld.y);
        setMarquee({ x, y, w, h });

        const curr = canvasRef.current;
        const hits = curr.elements
          .filter((el) => {
            const box = getElementBBox(el, curr.elements);
            return (
              box.x < x + w &&
              box.x + box.width > x &&
              box.y < y + h &&
              box.y + box.height > y
            );
          })
          .map((el) => el.id);

        if (state.additive) {
          setSelectedIds(Array.from(new Set([...state.baseSelected, ...hits])));
        } else {
          setSelectedIds(hits);
        }
        return;
      }

      if (state.kind === 'drag') {
        let dx = worldPt.x - state.startWorld.x;
        let dy = worldPt.y - state.startWorld.y;
        const dragDist = Math.hypot(dx, dy);
        if (!state.moved && dragDist <= 3) return;
        if (!state.moved) {
          state.moved = true;
          if (!state.captured) {
            state.captured = true;
            try {
              containerRef.current?.setPointerCapture(state.pointerId);
            } catch {
              // ignore if pointer already released
            }
          }
        }

        const curr = canvasRef.current;
        const movingIds = state.initialPositions;

        // Compute aggregate bounding box of moving elements for 6px snap guides
        let gMinX = Infinity;
        let gMinY = Infinity;
        let gMaxX = -Infinity;
        let gMaxY = -Infinity;
        for (const el of state.snapshot.elements) {
          const orig = movingIds.get(el.id);
          if (!orig) continue;
          const box = getElementBBox({ ...el, x: orig.x + dx, y: orig.y + dy }, state.snapshot.elements);
          if (box.x < gMinX) gMinX = box.x;
          if (box.y < gMinY) gMinY = box.y;
          if (box.x + box.width > gMaxX) gMaxX = box.x + box.width;
          if (box.y + box.height > gMaxY) gMaxY = box.y + box.height;
        }

        const guides: SnapGuide[] = [];
        if (Number.isFinite(gMinX) && !e.altKey) {
          const gCenterX = (gMinX + gMaxX) / 2;
          const gCenterY = (gMinY + gMaxY) / 2;
          const movingXs = [gMinX, gCenterX, gMaxX];
          const movingYs = [gMinY, gCenterY, gMaxY];

          let bestSnapX: { delta: number; pos: number; minY: number; maxY: number } | null = null;
          let bestSnapY: { delta: number; pos: number; minX: number; maxX: number } | null = null;

          for (const sib of curr.elements) {
            if (movingIds.has(sib.id) || sib.kind === 'arrow' || sib.kind === 'line' || sib.kind === 'freehand') {
              continue;
            }
            const sb = getElementBBox(sib, curr.elements);
            const sibXs = [sb.x, sb.x + sb.width / 2, sb.x + sb.width];
            const sibYs = [sb.y, sb.y + sb.height / 2, sb.y + sb.height];

            for (const mx of movingXs) {
              for (const sx of sibXs) {
                const diff = sx - mx;
                if (
                  Math.abs(diff) <= SNAP_TOLERANCE &&
                  (!bestSnapX || Math.abs(diff) < Math.abs(bestSnapX.delta))
                ) {
                  bestSnapX = {
                    delta: diff,
                    pos: sx,
                    minY: Math.min(gMinY, sb.y) - 24,
                    maxY: Math.max(gMaxY, sb.y + sb.height) + 24,
                  };
                }
              }
            }

            for (const my of movingYs) {
              for (const sy of sibYs) {
                const diff = sy - my;
                if (
                  Math.abs(diff) <= SNAP_TOLERANCE &&
                  (!bestSnapY || Math.abs(diff) < Math.abs(bestSnapY.delta))
                ) {
                  bestSnapY = {
                    delta: diff,
                    pos: sy,
                    minX: Math.min(gMinX, sb.x) - 24,
                    maxX: Math.max(gMaxX, sb.x + sb.width) + 24,
                  };
                }
              }
            }
          }

          if (bestSnapX) {
            dx += bestSnapX.delta;
            guides.push({
              axis: 'x',
              pos: bestSnapX.pos,
              start: bestSnapX.minY,
              end: bestSnapX.maxY,
            });
          }
          if (bestSnapY) {
            dy += bestSnapY.delta;
            guides.push({
              axis: 'y',
              pos: bestSnapY.pos,
              start: bestSnapY.minX,
              end: bestSnapY.maxX,
            });
          }
        }

        setSnapGuides(guides);

        const nextEls = state.snapshot.elements.map((el) => {
          const orig = movingIds.get(el.id);
          if (!orig) return el;
          return {
            ...el,
            x: Math.round(orig.x + dx),
            y: Math.round(orig.y + dy),
          };
        });
        onChangeCanvas({ ...curr, elements: nextEls });
        return;
      }

      if (state.kind === 'resize') {
        const dx = worldPt.x - state.startWorld.x;
        const dy = worldPt.y - state.startWorld.y;
        if (Math.hypot(dx, dy) > 1) state.moved = true;

        const { x, y, width, height } = state.origBox;
        const minSize = 24;
        let nx = x;
        let ny = y;
        let nw = width;
        let nh = height;

        if (state.handle.includes('e')) {
          nw = Math.max(minSize, width + dx);
        }
        if (state.handle.includes('s')) {
          nh = Math.max(minSize, height + dy);
        }
        if (state.handle.includes('w')) {
          const clampedDx = Math.min(dx, width - minSize);
          nx = x + clampedDx;
          nw = width - clampedDx;
        }
        if (state.handle.includes('n')) {
          const clampedDy = Math.min(dy, height - minSize);
          ny = y + clampedDy;
          nh = height - clampedDy;
        }

        const curr = canvasRef.current;
        const nextEls = curr.elements.map((el) =>
          el.id === state.elementId
            ? {
                ...el,
                x: Math.round(nx),
                y: Math.round(ny),
                width: Math.round(nw),
                height: Math.round(nh),
              }
            : el
        );
        onChangeCanvas({ ...curr, elements: nextEls });
        return;
      }

      if (state.kind === 'endpoint') {
        state.moved = true;
        const curr = canvasRef.current;
        const snapThreshold = Math.max(18, 18 / viewportRef.current.zoom);
        const match = findNearestAnchor(
          worldPt,
          curr.elements,
          new Set([state.elementId]),
          snapThreshold
        );
        setHoveredAnchor(match);
        const movedPt = match ? match.point : worldPt;
        const movedBinding: CanvasBinding | undefined = match
          ? { elementId: match.elementId, anchor: match.anchor }
          : undefined;

        const startPt = state.which === 'start' ? movedPt : state.fixedWorld;
        const endPt = state.which === 'end' ? movedPt : state.fixedWorld;
        const startBinding = state.which === 'start' ? movedBinding : state.fixedBinding;
        const endBinding = state.which === 'end' ? movedBinding : state.fixedBinding;

        const nextEls = curr.elements.map((el) =>
          el.id === state.elementId
            ? {
                ...el,
                x: startPt.x,
                y: startPt.y,
                width: Math.abs(endPt.x - startPt.x),
                height: Math.abs(endPt.y - startPt.y),
                points: [
                  { x: 0, y: 0 },
                  { x: endPt.x - startPt.x, y: endPt.y - startPt.y },
                ],
                startBinding,
                endBinding,
              }
            : el
        );
        onChangeCanvas({ ...curr, elements: nextEls });
        return;
      }

      if (state.kind === 'draw') {
        const curr = canvasRef.current;
        const dist = Math.hypot(worldPt.x - state.startWorld.x, worldPt.y - state.startWorld.y);
        if (dist > 6) state.moved = true;

        if (state.tool === 'freehand') {
          const nextEls = curr.elements.map((el) => {
            if (el.id !== state.elementId) return el;
            const pts = el.points ?? [{ x: 0, y: 0 }];
            const relX = worldPt.x - el.x;
            const relY = worldPt.y - el.y;
            const last = pts[pts.length - 1];
            if (last && Math.hypot(relX - last.x, relY - last.y) < 2.2) return el;
            return { ...el, points: [...pts, { x: relX, y: relY }] };
          });
          onChangeCanvas({ ...curr, elements: nextEls });
          return;
        }

        if (state.tool === 'arrow' || state.tool === 'line') {
          const snapThreshold = Math.max(18, 18 / viewportRef.current.zoom);
          const match = findNearestAnchor(
            worldPt,
            curr.elements,
            new Set([state.elementId]),
            snapThreshold
          );
          setHoveredAnchor(match);
          const endPt = match ? match.point : worldPt;
          const endBinding: CanvasBinding | undefined = match
            ? { elementId: match.elementId, anchor: match.anchor }
            : undefined;

          const nextEls = curr.elements.map((el) =>
            el.id === state.elementId
              ? {
                  ...el,
                  width: Math.abs(endPt.x - el.x),
                  height: Math.abs(endPt.y - el.y),
                  points: [
                    { x: 0, y: 0 },
                    { x: endPt.x - el.x, y: endPt.y - el.y },
                  ],
                  endBinding,
                }
              : el
          );
          onChangeCanvas({ ...curr, elements: nextEls });
          return;
        }

        // Standard shape / sticky / text / frame drag box
        const x = Math.min(state.startWorld.x, worldPt.x);
        const y = Math.min(state.startWorld.y, worldPt.y);
        const w = Math.max(8, Math.abs(worldPt.x - state.startWorld.x));
        const h = Math.max(8, Math.abs(worldPt.y - state.startWorld.y));
        const nextEls = curr.elements.map((el) =>
          el.id === state.elementId
            ? { ...el, x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) }
            : el
        );
        onChangeCanvas({ ...curr, elements: nextEls });
      }
    },
    [tool, hoveredAnchor, screenToWorld, onChangeCanvas]
  );

  const handleBoardPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const state = interactionRef.current;
      interactionRef.current = { kind: 'idle' };

      if (containerRef.current?.hasPointerCapture(e.pointerId)) {
        containerRef.current.releasePointerCapture(e.pointerId);
      }

      if (state.kind === 'pan') {
        flushViewport(viewportRef.current, true);
        return;
      }

      if (state.kind === 'marquee') {
        setMarquee(null);
        return;
      }

      if (state.kind === 'drag') {
        setSnapGuides([]);
        if (state.moved) {
          const synced = syncBoundArrowsGeometry(canvasRef.current.elements);
          commitCanvasChange(synced, state.snapshot);
        }
        return;
      }

      if (state.kind === 'resize') {
        if (state.moved) {
          const synced = syncBoundArrowsGeometry(canvasRef.current.elements);
          commitCanvasChange(synced, state.snapshot);
        }
        return;
      }

      if (state.kind === 'endpoint') {
        setHoveredAnchor(null);
        if (state.moved) {
          const synced = syncBoundArrowsGeometry(canvasRef.current.elements);
          commitCanvasChange(synced, state.snapshot);
        }
        return;
      }

      if (state.kind === 'draw') {
        setHoveredAnchor(null);
        const curr = canvasRef.current;
        const created = curr.elements.find((el) => el.id === state.elementId);
        if (!created) return;

        // If user single-clicked without dragging, apply sensible defaults
        if (!state.moved) {
          if (state.tool === 'freehand') {
            // Discard accidental 1-point tap in freehand
            onChangeCanvas(state.snapshot);
            setSelectedIds([]);
            return;
          }
          if (state.tool === 'arrow' || state.tool === 'line') {
            const defaulted = curr.elements.map((el) =>
              el.id === state.elementId
                ? {
                    ...el,
                    width: 140,
                    height: 0,
                    points: [
                      { x: 0, y: 0 },
                      { x: 140, y: 0 },
                    ],
                  }
                : el
            );
            commitCanvasChange(defaulted, state.snapshot);
            setTool('select');
            return;
          }

          const defaultsByKind: Record<string, { w: number; h: number }> = {
            sticky: { w: 190, h: 156 },
            text: { w: 200, h: 42 },
            frame: { w: 340, h: 240 },
            diamond: { w: 156, h: 108 },
            ellipse: { w: 160, h: 96 },
            rect: { w: 164, h: 96 },
            roundRect: { w: 164, h: 96 },
          };
          const dim = defaultsByKind[created.kind] ?? { w: 160, h: 96 };
          const updatedEl: CanvasElement = {
            ...created,
            x: Math.round(state.startWorld.x - (created.kind === 'text' ? 8 : dim.w / 2)),
            y: Math.round(state.startWorld.y - (created.kind === 'text' ? 14 : dim.h / 2)),
            width: dim.w,
            height: dim.h,
          };
          const nextEls = curr.elements.map((el) => (el.id === created.id ? updatedEl : el));
          const updatedCanvas: CanvasData = {
            ...curr,
            elements: nextEls,
            viewport: viewportRef.current,
            updatedAt: Date.now(),
          };
          commitCanvasChange(nextEls, state.snapshot);
          setTool('select');

          // Single click with Sticky or Text opens inline text editing immediately!
          if (created.kind === 'sticky' || created.kind === 'text') {
            startTextEdit(updatedEl, updatedCanvas);
          }
          return;
        }

        // Normal drag-created element
        if (state.tool === 'freehand' && created.points) {
          // Normalize freehand bounding box
          const b = getElementBBox(created, curr.elements);
          const normEl: CanvasElement = {
            ...created,
            x: b.x,
            y: b.y,
            width: b.width,
            height: b.height,
            points: created.points.map((p) => ({
              x: created.x + p.x - b.x,
              y: created.y + p.y - b.y,
            })),
          };
          const nextEls = curr.elements.map((el) => (el.id === created.id ? normEl : el));
          commitCanvasChange(nextEls, state.snapshot);
          // Stay in freehand tool so users can keep sketching naturally
          setSelectedIds([]);
          return;
        }

        commitCanvasChange(curr.elements, state.snapshot);
        setTool('select');
        if (created.kind === 'sticky' || created.kind === 'text') {
          startTextEdit(created, curr);
        }
      }
    },
    [flushViewport, commitCanvasChange, onChangeCanvas, startTextEdit]
  );

  // ============================================================================
  // Drag-and-Drop Files onto Board
  // ============================================================================

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      const dropPt = screenToWorld(e.clientX, e.clientY);
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          insertImageFile(file, dropPt);
        } else if (/\.(fcanvas|excalidraw|json)$/i.test(file.name)) {
          onImportCanvasFile(file);
        }
      }
    },
    [screenToWorld, insertImageFile, onImportCanvasFile]
  );

  // ============================================================================
  // Board Theme & Background Helpers
  // ============================================================================

  const setBackground = useCallback(
    (bg: CanvasBackground) => {
      onChangeCanvas({ ...canvasRef.current, background: bg, updatedAt: Date.now() });
    },
    [onChangeCanvas]
  );

  const toggleTheme = useCallback(() => {
    const curr = canvasRef.current;
    onChangeCanvas({
      ...curr,
      theme: curr.theme === 'dark' ? 'light' : 'dark',
      updatedAt: Date.now(),
    });
  }, [onChangeCanvas]);

  // ============================================================================
  // Render Helpers
  // ============================================================================

  const isDark = canvas.theme === 'dark';
  const boardBgColor = isDark ? '#0f172a' : '#f8fafc';
  const patternDotColor = isDark ? '#334155' : '#cbd5e1';
  const patternGridColor = isDark ? '#1e293b' : '#e2e8f0';

  const singleSelected =
    selectedElements.length === 1 && !selectedElements[0].locked ? selectedElements[0] : null;
  const editingEl = editingId
    ? canvas.elements.find((e) => e.id === editingId) ??
      (editingFallbackElRef.current?.id === editingId ? editingFallbackElRef.current : null)
    : null;

  // Unique arrow marker definitions by color
  const arrowMarkers = useMemo(() => {
    const map = new Map<string, string>();
    let idx = 0;
    for (const el of canvas.elements) {
      if (el.kind === 'arrow') {
        const col = el.stroke || (isDark ? '#e2e8f0' : '#0f172a');
        if (!map.has(col)) map.set(col, `live-arrow-${++idx}`);
      }
    }
    return map;
  }, [canvas.elements, isDark]);

  // Cursor computation
  const cursorClass = useMemo(() => {
    if (interactionRef.current.kind === 'pan') return 'cursor-grabbing';
    if (tool === 'hand' || spacePressed) return 'cursor-grab';
    if (tool === 'select') return 'cursor-default';
    if (tool === 'text') return 'cursor-text';
    return 'cursor-crosshair';
  }, [tool, spacePressed]);

  // Toolbar item definitions
  const toolItems: Array<{
    id: CanvasTool;
    label: string;
    shortcut?: string;
    icon: React.ReactNode;
  }> = [
    { id: 'select', label: 'Select', shortcut: 'V', icon: <MousePointer2 className="w-4 h-4" /> },
    { id: 'hand', label: 'Pan', shortcut: 'H', icon: <Hand className="w-4 h-4" /> },
    { id: 'rect', label: 'Rectangle', shortcut: 'R', icon: <Square className="w-4 h-4" /> },
    {
      id: 'roundRect',
      label: 'Rounded Rect',
      icon: (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="4" width="18" height="16" rx="5" />
        </svg>
      ),
    },
    { id: 'diamond', label: 'Diamond', shortcut: 'D', icon: <Diamond className="w-4 h-4" /> },
    { id: 'ellipse', label: 'Ellipse', shortcut: 'O', icon: <Circle className="w-4 h-4" /> },
    { id: 'sticky', label: 'Sticky Note', shortcut: 'S', icon: <StickyNote className="w-4 h-4" /> },
    { id: 'text', label: 'Text', shortcut: 'T', icon: <Type className="w-4 h-4" /> },
    { id: 'arrow', label: 'Arrow', shortcut: 'A', icon: <ArrowUpRight className="w-4 h-4" /> },
    { id: 'line', label: 'Line', shortcut: 'L', icon: <Minus className="w-4 h-4" /> },
    { id: 'freehand', label: 'Freehand', shortcut: 'P', icon: <Pencil className="w-4 h-4" /> },
    { id: 'frame', label: 'Frame', shortcut: 'F', icon: <Frame className="w-4 h-4" /> },
  ];

  const pillBg = isDark
    ? 'bg-slate-900/95 border-slate-700/90 text-slate-200'
    : 'bg-white/95 border-slate-200/90 text-slate-700';

  const toolbarBtn = (active: boolean) =>
    active
      ? isDark
        ? 'bg-teal-500/25 text-teal-300 shadow-xs'
        : 'bg-teal-50 text-teal-700 ring-1 ring-teal-300/80 shadow-xs'
      : isDark
        ? 'text-slate-300 hover:bg-slate-800 hover:text-white'
        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900';

  // Compute screen box for inline textarea editor
  const editingBox = useMemo(() => {
    if (!editingEl) return null;
    if (editingEl.kind === 'arrow' || editingEl.kind === 'line') {
      const { start, end } = resolveBoundEndpoints(editingEl, canvas.elements);
      const mx = ((start.x + end.x) / 2) * viewport.zoom + viewport.x;
      const my = ((start.y + end.y) / 2) * viewport.zoom + viewport.y;
      return {
        left: mx - 90,
        top: my - 18,
        width: 180,
        height: 36,
        isSingleLine: true,
      };
    }
    if (editingEl.kind === 'frame') {
      return {
        left: editingEl.x * viewport.zoom + viewport.x + 8,
        top: editingEl.y * viewport.zoom + viewport.y + 4,
        width: Math.max(140, editingEl.width * viewport.zoom - 16),
        height: 30,
        isSingleLine: true,
      };
    }
    const pad = editingEl.kind === 'sticky' ? 12 : editingEl.kind === 'text' ? 2 : 8;
    return {
      left: editingEl.x * viewport.zoom + viewport.x + pad * viewport.zoom,
      top: editingEl.y * viewport.zoom + viewport.y + pad * viewport.zoom,
      width: Math.max(80, (editingEl.width - pad * 2) * viewport.zoom),
      height: Math.max(36, (editingEl.height - pad * 2) * viewport.zoom),
      isSingleLine: false,
    };
  }, [editingEl, canvas.elements, viewport]);

  const patternStep = 24 * viewport.zoom;

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full overflow-hidden select-none ${cursorClass}`}
      style={{ backgroundColor: boardBgColor }}
      onPointerDown={handleBoardPointerDown}
      onPointerMove={handleBoardPointerMove}
      onPointerUp={handleBoardPointerUp}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Hidden File Inputs */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) insertImageFile(f);
          e.target.value = '';
        }}
      />
      <input
        ref={openFileInputRef}
        type="file"
        accept=".fcanvas,.excalidraw,.json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onImportCanvasFile(f);
          e.target.value = '';
        }}
      />

      {/* ================================================================= */}
      {/* Top Floating Pill Toolbar                                         */}
      {/* ================================================================= */}
      <div
        className="absolute top-3.5 left-1/2 -translate-x-1/2 z-30 max-w-[calc(100%-2rem)]"
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <div
          className={`flex items-center gap-0.5 px-2 py-1.5 rounded-2xl border backdrop-blur-md shadow-lg ${pillBg}`}
        >
          {toolItems.map((item, idx) => (
            <React.Fragment key={item.id}>
              {(idx === 2 || idx === 12) && (
                <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-1 shrink-0" />
              )}
              <button
                type="button"
                title={item.shortcut ? `${item.label} (${item.shortcut})` : item.label}
                onClick={() => setTool(item.id)}
                className={`relative w-8 h-8 rounded-xl flex items-center justify-center transition-colors shrink-0 ${toolbarBtn(
                  tool === item.id
                )}`}
              >
                {item.icon}
                {item.shortcut && (
                  <span className="absolute bottom-0.5 right-0.5 text-[8px] font-semibold opacity-55 leading-none pointer-events-none">
                    {item.shortcut}
                  </span>
                )}
              </button>
            </React.Fragment>
          ))}

          <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-1 shrink-0" />

          {/* Insert Image */}
          <button
            type="button"
            title="Insert Image (or paste / drop)"
            onClick={() => imageInputRef.current?.click()}
            className={`w-8 h-8 rounded-xl flex items-center justify-center transition-colors shrink-0 ${toolbarBtn(false)}`}
          >
            <ImagePlus className="w-4 h-4" />
          </button>

          {/* Import Mermaid Diagram */}
          <button
            type="button"
            title="Import Mermaid Diagram"
            onClick={() => {
              setMermaidError(null);
              setShowMermaidModal(true);
            }}
            className={`h-8 px-2 rounded-xl flex items-center gap-1 text-xs font-medium transition-colors shrink-0 ${toolbarBtn(
              showMermaidModal
            )}`}
          >
            <GitBranch className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
            <span className="hidden lg:inline">Mermaid</span>
          </button>

          <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-1 shrink-0" />

          {/* Undo / Redo */}
          <button
            type="button"
            title="Undo (⌘Z)"
            disabled={past.length === 0}
            onClick={handleUndo}
            className={`w-8 h-8 rounded-xl flex items-center justify-center transition-colors shrink-0 disabled:opacity-35 ${toolbarBtn(
              false
            )}`}
          >
            <Undo2 className="w-4 h-4" />
          </button>
          <button
            type="button"
            title="Redo (⌘⇧Z)"
            disabled={future.length === 0}
            onClick={handleRedo}
            className={`w-8 h-8 rounded-xl flex items-center justify-center transition-colors shrink-0 disabled:opacity-35 ${toolbarBtn(
              false
            )}`}
          >
            <Redo2 className="w-4 h-4" />
          </button>

          <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-1 shrink-0" />

          {/* Open File */}
          <button
            type="button"
            title="Open .fcanvas or .excalidraw file"
            onClick={() => openFileInputRef.current?.click()}
            className={`w-8 h-8 rounded-xl flex items-center justify-center transition-colors shrink-0 ${toolbarBtn(
              false
            )}`}
          >
            <FolderOpen className="w-4 h-4" />
          </button>

          {/* Embed in Docs / Slides */}
          {onSendCanvasToSuite && (
            <button
              type="button"
              title="Embed live diagram in Forma Docs or Forma Slides"
              onClick={handleSendToSuite}
              className={`h-8 px-2.5 rounded-xl flex items-center gap-1.5 text-xs font-medium transition-colors shrink-0 ${toolbarBtn(
                false
              )}`}
            >
              <Send className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400" />
              <span className="hidden lg:inline">Embed</span>
            </button>
          )}

          {/* Export Menu */}
          <div className="relative">
            <button
              type="button"
              title="Export Canvas"
              onClick={() => setShowExportMenu((v) => !v)}
              className={`h-8 px-2.5 rounded-xl flex items-center gap-1.5 text-xs font-medium transition-colors shrink-0 ${
                showExportMenu
                  ? 'bg-teal-600 text-white'
                  : 'bg-teal-600/95 hover:bg-teal-600 text-white shadow-xs'
              }`}
            >
              <Download className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Export</span>
            </button>

            {showExportMenu && (
              <div
                className={`absolute right-0 top-10 w-52 rounded-xl border shadow-xl p-1.5 z-40 text-xs ${pillBg}`}
              >
                <button
                  type="button"
                  onClick={() => handleExport('fcanvas')}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-left"
                >
                  <FileJson className="w-3.5 h-3.5 text-teal-600" />
                  <div>
                    <div className="font-medium">Forma Canvas (.fcanvas)</div>
                    <div className="text-[10px] opacity-60">Native lossless JSON</div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => handleExport('excalidraw')}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-left"
                >
                  <FileCode2 className="w-3.5 h-3.5 text-violet-500" />
                  <div>
                    <div className="font-medium">Excalidraw (.excalidraw)</div>
                    <div className="text-[10px] opacity-60">Excalidraw v2 compatible</div>
                  </div>
                </button>
                <div className="my-1 border-t border-slate-200 dark:border-slate-700" />
                <button
                  type="button"
                  onClick={() => handleExport('svg')}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-left"
                >
                  <FileCode2 className="w-3.5 h-3.5 text-sky-500" />
                  <div>
                    <div className="font-medium">Vector SVG (.svg)</div>
                    <div className="text-[10px] opacity-60">Crisp scalable graphics</div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => handleExport('png')}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-left"
                >
                  <FileImage className="w-3.5 h-3.5 text-emerald-500" />
                  <div>
                    <div className="font-medium">Retina PNG (.png)</div>
                    <div className="text-[10px] opacity-60">2× high-DPI image</div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => handleExport('pdf')}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-left"
                >
                  <FileText className="w-3.5 h-3.5 text-rose-500" />
                  <div>
                    <div className="font-medium">Vector PDF (.pdf)</div>
                    <div className="text-[10px] opacity-60">Print-ready document</div>
                  </div>
                </button>
                {onSendCanvasToSuite && (
                  <>
                    <div className="my-1 border-t border-slate-200 dark:border-slate-700" />
                    <button
                      type="button"
                      onClick={handleSendToSuite}
                      className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-cyan-50 dark:hover:bg-cyan-950/50 text-left"
                    >
                      <Send className="w-3.5 h-3.5 text-cyan-600" />
                      <div>
                        <div className="font-medium">Embed in Docs / Slides…</div>
                        <div className="text-[10px] opacity-60">Live one-click refresh</div>
                      </div>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ================================================================= */}
      {/* Floating Selection Inspector                                      */}
      {/* ================================================================= */}
      <CanvasInspector
        selectedElements={selectedElements}
        theme={canvas.theme}
        onPatchSelected={handlePatchSelected}
        onEditText={
          singleSelected &&
          singleSelected.kind !== 'freehand' &&
          singleSelected.kind !== 'image'
            ? () => startTextEdit(singleSelected)
            : undefined
        }
        onArrange={handleArrange}
        onDuplicate={handleDuplicate}
        onToggleLock={handleToggleLock}
        onDelete={handleDeleteSelected}
      />

      {/* ================================================================= */}
      {/* Infinite Interactive SVG Surface                                  */}
      {/* ================================================================= */}
      <svg className="w-full h-full block">
        <defs>
          {/* Sticky note drop shadow */}
          <filter id="canvas-sticky-shadow" x="-15%" y="-15%" width="130%" height="136%">
            <feDropShadow
              dx="0"
              dy="6"
              stdDeviation="6"
              floodColor="#0f172a"
              floodOpacity={isDark ? '0.45' : '0.12'}
            />
          </filter>

          {/* Background Dot Pattern */}
          {canvas.background === 'dots' && (
            <pattern
              id="forma-bg-dots"
              width={patternStep}
              height={patternStep}
              patternUnits="userSpaceOnUse"
              x={viewport.x % patternStep}
              y={viewport.y % patternStep}
            >
              <circle
                cx={patternStep / 2}
                cy={patternStep / 2}
                r={Math.max(1, 1.35 * Math.min(1.4, viewport.zoom))}
                fill={patternDotColor}
              />
            </pattern>
          )}

          {/* Background Grid Pattern */}
          {canvas.background === 'grid' && (
            <pattern
              id="forma-bg-grid"
              width={patternStep}
              height={patternStep}
              patternUnits="userSpaceOnUse"
              x={viewport.x % patternStep}
              y={viewport.y % patternStep}
            >
              <path
                d={`M ${patternStep} 0 L 0 0 0 ${patternStep}`}
                fill="none"
                stroke={patternGridColor}
                strokeWidth="1"
              />
            </pattern>
          )}

          {/* Per-color arrowhead markers */}
          {Array.from(arrowMarkers.entries()).map(([col, id]) => (
            <marker
              key={id}
              id={id}
              viewBox="0 0 10 10"
              refX="8.5"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 1 1.5 L 9 5 L 1 8.5 z" fill={col} />
            </marker>
          ))}
        </defs>

        {/* Infinite Background Pattern Rect */}
        {canvas.background !== 'plain' && (
          <rect
            width="100%"
            height="100%"
            fill={canvas.background === 'dots' ? 'url(#forma-bg-dots)' : 'url(#forma-bg-grid)'}
          />
        )}

        {/* World-Space Layer */}
        <g transform={`translate(${viewport.x}, ${viewport.y}) scale(${viewport.zoom})`}>
          {canvas.elements.map((el) => {
            const isSelected = selectedSet.has(el.id);
            const isEditingThis = editingId === el.id;
            const opacity = el.opacity ?? 1;
            const stroke = el.stroke || (isDark ? '#e2e8f0' : '#0f172a');
            const fill =
              el.fill && el.fill !== 'none'
                ? el.fill === 'transparent'
                  ? 'none'
                  : el.fill
                : 'none';
            const sw = el.strokeWidth ?? 2;
            const dash = strokeDashArray(el.strokeStyle, sw);
            const fontStack = getCanvasFontStack(el.fontFamily);
            const fontSize = el.fontSize ?? (el.kind === 'text' ? 18 : 14);
            const textColor = getTextColorForElement(el, canvas.theme);

            // Frame
            if (el.kind === 'frame') {
              const frameFill =
                el.fill && el.fill !== 'transparent' && el.fill !== 'none'
                  ? el.fill
                  : isDark
                    ? 'rgba(30,41,59,0.55)'
                    : 'rgba(248,250,252,0.8)';
              const frameStroke = el.stroke || (isDark ? '#475569' : '#cbd5e1');
              return (
                <g
                  key={el.id}
                  opacity={opacity}
                  onPointerDown={(e) => handleElementPointerDown(e, el)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    startTextEdit(el);
                  }}
                >
                  <rect
                    x={el.x}
                    y={el.y}
                    width={Math.max(1, el.width)}
                    height={Math.max(1, el.height)}
                    rx={12}
                    ry={12}
                    fill={frameFill}
                    stroke={isSelected ? '#0d9488' : frameStroke}
                    strokeWidth={isSelected ? Math.max(sw, 2) : sw}
                    strokeDasharray={dash}
                  />
                  {!isEditingThis && el.text && (
                    <text
                      x={el.x + 14}
                      y={el.y + 22}
                      fontFamily={fontStack}
                      fontSize={fontSize}
                      fontWeight={600}
                      fill={textColor}
                      className="pointer-events-none"
                    >
                      {el.text}
                    </text>
                  )}
                </g>
              );
            }

            // Arrow / Line
            if (el.kind === 'arrow' || el.kind === 'line') {
              const { start, end } = resolveBoundEndpoints(el, canvas.elements);
              const markerId = el.kind === 'arrow' ? arrowMarkers.get(stroke) : undefined;
              const mx = (start.x + end.x) / 2;
              const my = (start.y + end.y) / 2;
              const sketchyPaths =
                el.roughness === 1
                  ? buildSketchyLinePaths(start.x, start.y, end.x, end.y, el.id)
                  : null;

              return (
                <g
                  key={el.id}
                  opacity={opacity}
                  onPointerDown={(e) => handleElementPointerDown(e, el)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    startTextEdit(el);
                  }}
                >
                  {/* Generous invisible hit area */}
                  <line
                    x1={start.x}
                    y1={start.y}
                    x2={end.x}
                    y2={end.y}
                    stroke="transparent"
                    strokeWidth={Math.max(14, 14 / viewport.zoom)}
                    strokeLinecap="round"
                  />
                  {isSelected && (
                    <line
                      x1={start.x}
                      y1={start.y}
                      x2={end.x}
                      y2={end.y}
                      stroke="#14b8a6"
                      strokeOpacity={0.28}
                      strokeWidth={sw + 6}
                      strokeLinecap="round"
                      className="pointer-events-none"
                    />
                  )}
                  {sketchyPaths ? (
                    sketchyPaths.map((d, idx) => (
                      <path
                        key={idx}
                        d={d}
                        fill="none"
                        stroke={stroke}
                        strokeWidth={sw}
                        strokeDasharray={dash}
                        strokeLinecap="round"
                        markerEnd={idx === 0 && markerId ? `url(#${markerId})` : undefined}
                        className="pointer-events-none"
                      />
                    ))
                  ) : (
                    <line
                      x1={start.x}
                      y1={start.y}
                      x2={end.x}
                      y2={end.y}
                      stroke={stroke}
                      strokeWidth={sw}
                      strokeDasharray={dash}
                      strokeLinecap="round"
                      markerEnd={markerId ? `url(#${markerId})` : undefined}
                      className="pointer-events-none"
                    />
                  )}
                  {!isEditingThis && el.text && el.text.trim() && (
                    <g className="pointer-events-none">
                      <rect
                        x={mx - Math.max(24, el.text.length * fontSize * 0.34 + 8)}
                        y={my - fontSize * 0.75 - 3}
                        width={Math.max(48, el.text.length * fontSize * 0.68 + 16)}
                        height={fontSize * 1.5 + 6}
                        rx={6}
                        fill={isDark ? '#1e293b' : '#ffffff'}
                        stroke={stroke}
                        strokeOpacity={0.35}
                        strokeWidth={1}
                      />
                      <text
                        x={mx}
                        y={my + fontSize * 0.36}
                        textAnchor="middle"
                        fontFamily={fontStack}
                        fontSize={fontSize}
                        fontWeight={600}
                        fill={textColor}
                      >
                        {el.text}
                      </text>
                    </g>
                  )}
                </g>
              );
            }

            // Freehand
            if (el.kind === 'freehand') {
              const d = pointsToSmoothSvgPath(el.points ?? [], el.x, el.y);
              return (
                <g
                  key={el.id}
                  opacity={opacity}
                  onPointerDown={(e) => handleElementPointerDown(e, el)}
                >
                  <path
                    d={d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={Math.max(14, 14 / viewport.zoom)}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  {isSelected && (
                    <path
                      d={d}
                      fill="none"
                      stroke="#14b8a6"
                      strokeOpacity={0.3}
                      strokeWidth={sw + 6}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="pointer-events-none"
                    />
                  )}
                  <path
                    d={d}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={sw}
                    strokeDasharray={dash}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="pointer-events-none"
                  />
                </g>
              );
            }

            // Standalone Text
            if (el.kind === 'text') {
              return (
                <g
                  key={el.id}
                  opacity={opacity}
                  onPointerDown={(e) => handleElementPointerDown(e, el)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    startTextEdit(el);
                  }}
                >
                  <rect
                    x={el.x - 4}
                    y={el.y - 4}
                    width={Math.max(24, el.width + 8)}
                    height={Math.max(24, el.height + 8)}
                    rx={6}
                    fill="transparent"
                    stroke={isSelected ? '#0d9488' : 'transparent'}
                    strokeWidth={1.5 / viewport.zoom}
                    strokeDasharray={isSelected ? `${4 / viewport.zoom} ${3 / viewport.zoom}` : undefined}
                  />
                  {!isEditingThis && (() => {
                    const displayText = el.text || 'Text';
                    const align = el.textAlign ?? 'left';
                    const lineHeight = fontSize * 1.35;
                    const lines = wrapSvgTextLines(displayText, Math.max(40, el.width), fontSize);
                    const anchor =
                      align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
                    const tx =
                      align === 'center'
                        ? el.x + Math.max(40, el.width) / 2
                        : align === 'right'
                          ? el.x + Math.max(40, el.width)
                          : el.x;
                    return (
                      <text
                        x={tx}
                        y={el.y + fontSize}
                        textAnchor={anchor}
                        fontFamily={fontStack}
                        fontSize={fontSize}
                        fontWeight={fontSize >= 22 ? 700 : 500}
                        fill={textColor}
                        className="pointer-events-none"
                      >
                        {lines.map((line, i) => (
                          <tspan key={i} x={tx} dy={i === 0 ? 0 : lineHeight}>
                            {line || '\u00A0'}
                          </tspan>
                        ))}
                      </text>
                    );
                  })()}
                </g>
              );
            }

            // Image
            if (el.kind === 'image') {
              return (
                <g
                  key={el.id}
                  opacity={opacity}
                  onPointerDown={(e) => handleElementPointerDown(e, el)}
                >
                  <image
                    href={el.src}
                    x={el.x}
                    y={el.y}
                    width={Math.max(1, el.width)}
                    height={Math.max(1, el.height)}
                    preserveAspectRatio="xMidYMid meet"
                  />
                  {isSelected && (
                    <rect
                      x={el.x}
                      y={el.y}
                      width={Math.max(1, el.width)}
                      height={Math.max(1, el.height)}
                      fill="none"
                      stroke="#0d9488"
                      strokeWidth={2 / viewport.zoom}
                      className="pointer-events-none"
                    />
                  )}
                </g>
              );
            }

            // Geometric shapes & Sticky notes
            const w = Math.max(1, el.width);
            const h = Math.max(1, el.height);
            const actualFill =
              el.kind === 'sticky' && fill === 'none' ? '#fef08a' : fill;
            const sketchy = el.roughness === 1 ? buildSketchyShapePaths(el) : null;
            const align = el.textAlign ?? (el.kind === 'sticky' ? 'left' : 'center');

            return (
              <g
                key={el.id}
                opacity={opacity}
                onPointerDown={(e) => handleElementPointerDown(e, el)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  startTextEdit(el);
                }}
              >
                {el.kind === 'diamond' ? (
                  <>
                    <polygon
                      points={`${el.x + w / 2},${el.y} ${el.x + w},${el.y + h / 2} ${el.x + w / 2},${el.y + h} ${el.x},${el.y + h / 2}`}
                      fill={actualFill}
                      stroke={sketchy ? 'none' : stroke}
                      strokeWidth={sw}
                      strokeDasharray={dash}
                      strokeLinejoin="round"
                    />
                    {sketchy?.map((d, i) => (
                      <path
                        key={i}
                        d={d}
                        fill="none"
                        stroke={stroke}
                        strokeWidth={sw}
                        strokeDasharray={dash}
                        strokeLinecap="round"
                        className="pointer-events-none"
                      />
                    ))}
                  </>
                ) : el.kind === 'ellipse' ? (
                  <>
                    <ellipse
                      cx={el.x + w / 2}
                      cy={el.y + h / 2}
                      rx={w / 2}
                      ry={h / 2}
                      fill={actualFill}
                      stroke={sketchy ? 'none' : stroke}
                      strokeWidth={sw}
                      strokeDasharray={dash}
                    />
                    {sketchy?.map((d, i) => (
                      <path
                        key={i}
                        d={d}
                        fill="none"
                        stroke={stroke}
                        strokeWidth={sw}
                        strokeDasharray={dash}
                        strokeLinecap="round"
                        className="pointer-events-none"
                      />
                    ))}
                  </>
                ) : (
                  <>
                    <rect
                      x={el.x}
                      y={el.y}
                      width={w}
                      height={h}
                      rx={el.kind === 'roundRect' ? 14 : el.kind === 'sticky' ? 8 : 2}
                      ry={el.kind === 'roundRect' ? 14 : el.kind === 'sticky' ? 8 : 2}
                      fill={actualFill}
                      stroke={sketchy ? 'none' : stroke}
                      strokeWidth={sw}
                      strokeDasharray={dash}
                      filter={el.kind === 'sticky' ? 'url(#canvas-sticky-shadow)' : undefined}
                    />
                    {sketchy?.map((d, i) => (
                      <path
                        key={i}
                        d={d}
                        fill="none"
                        stroke={stroke}
                        strokeWidth={sw}
                        strokeDasharray={dash}
                        strokeLinecap="round"
                        className="pointer-events-none"
                      />
                    ))}
                  </>
                )}

                {/* Text Label inside shape/sticky (pure native SVG <text> for crisp WebKit/WKWebView rendering) */}
                {!isEditingThis && el.text && (() => {
                  const padX = el.kind === 'diamond' ? w * 0.18 : el.kind === 'sticky' ? 12 : 10;
                  const padY = el.kind === 'sticky' ? 12 : 8;
                  const availW = Math.max(20, w - padX * 2);
                  const availH = Math.max(20, h - padY * 2);
                  const lineHeight = fontSize * 1.32;
                  const lines = wrapSvgTextLines(el.text, availW, fontSize);
                  const totalTextH = lines.length * lineHeight;
                  const anchor =
                    align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle';
                  const tx =
                    align === 'left'
                      ? el.x + padX
                      : align === 'right'
                        ? el.x + w - padX
                        : el.x + w / 2;
                  const startY =
                    el.kind === 'sticky'
                      ? el.y + padY + fontSize * 0.92
                      : el.y + Math.max(padY, (h - totalTextH) / 2) + fontSize * 0.85;
                  const clipId = `canvas-clip-${el.id}`;
                  return (
                    <g className="pointer-events-none">
                      <defs>
                        <clipPath id={clipId}>
                          <rect
                            x={el.x + padX - 2}
                            y={el.y + padY - 2}
                            width={availW + 4}
                            height={availH + 4}
                            rx={4}
                          />
                        </clipPath>
                      </defs>
                      <text
                        x={tx}
                        y={startY}
                        textAnchor={anchor}
                        fontFamily={fontStack}
                        fontSize={fontSize}
                        fontWeight={el.kind === 'sticky' ? 500 : 600}
                        fill={textColor}
                        clipPath={`url(#${clipId})`}
                      >
                        {lines.map((line, i) => (
                          <tspan key={i} x={tx} dy={i === 0 ? 0 : lineHeight}>
                            {line || '\u00A0'}
                          </tspan>
                        ))}
                      </text>
                    </g>
                  );
                })()}

                {/* Multi-select subtle outline */}
                {isSelected && selectedElements.length > 1 && (
                  <rect
                    x={el.x - 3}
                    y={el.y - 3}
                    width={w + 6}
                    height={h + 6}
                    rx={6}
                    fill="none"
                    stroke="#0d9488"
                    strokeWidth={1.5 / viewport.zoom}
                    strokeDasharray={`${4 / viewport.zoom} ${3 / viewport.zoom}`}
                    className="pointer-events-none"
                  />
                )}
              </g>
            );
          })}

          {/* Snap-to-sibling alignment guides */}
          {snapGuides.map((g, i) =>
            g.axis === 'x' ? (
              <line
                key={`gx-${i}`}
                x1={g.pos}
                y1={g.start}
                x2={g.pos}
                y2={g.end}
                stroke="#f43f5e"
                strokeWidth={1.25 / viewport.zoom}
                strokeDasharray={`${5 / viewport.zoom} ${4 / viewport.zoom}`}
                className="pointer-events-none"
              />
            ) : (
              <line
                key={`gy-${i}`}
                x1={g.start}
                y1={g.pos}
                x2={g.end}
                y2={g.pos}
                stroke="#f43f5e"
                strokeWidth={1.25 / viewport.zoom}
                strokeDasharray={`${5 / viewport.zoom} ${4 / viewport.zoom}`}
                className="pointer-events-none"
              />
            )
          )}

          {/* Active Anchor Snap Ring */}
          {hoveredAnchor && (
            <g className="pointer-events-none">
              <circle
                cx={hoveredAnchor.point.x}
                cy={hoveredAnchor.point.y}
                r={10 / viewport.zoom}
                fill="#14b8a6"
                fillOpacity={0.22}
                stroke="#0d9488"
                strokeWidth={2 / viewport.zoom}
              />
              <circle
                cx={hoveredAnchor.point.x}
                cy={hoveredAnchor.point.y}
                r={4 / viewport.zoom}
                fill="#0d9488"
              />
            </g>
          )}

          {/* Single Selection Bounding Box & 8 Resize Handles */}
          {singleSelected &&
            singleSelected.kind !== 'arrow' &&
            singleSelected.kind !== 'line' &&
            singleSelected.kind !== 'freehand' && (
              <g>
                <rect
                  x={singleSelected.x}
                  y={singleSelected.y}
                  width={Math.max(1, singleSelected.width)}
                  height={Math.max(1, singleSelected.height)}
                  fill="none"
                  stroke="#0d9488"
                  strokeWidth={1.5 / viewport.zoom}
                  className="pointer-events-none"
                />
                {(
                  [
                    { id: 'nw', x: singleSelected.x, y: singleSelected.y, cur: 'nwse-resize' },
                    {
                      id: 'n',
                      x: singleSelected.x + singleSelected.width / 2,
                      y: singleSelected.y,
                      cur: 'ns-resize',
                    },
                    {
                      id: 'ne',
                      x: singleSelected.x + singleSelected.width,
                      y: singleSelected.y,
                      cur: 'nesw-resize',
                    },
                    {
                      id: 'e',
                      x: singleSelected.x + singleSelected.width,
                      y: singleSelected.y + singleSelected.height / 2,
                      cur: 'ew-resize',
                    },
                    {
                      id: 'se',
                      x: singleSelected.x + singleSelected.width,
                      y: singleSelected.y + singleSelected.height,
                      cur: 'nwse-resize',
                    },
                    {
                      id: 's',
                      x: singleSelected.x + singleSelected.width / 2,
                      y: singleSelected.y + singleSelected.height,
                      cur: 'ns-resize',
                    },
                    {
                      id: 'sw',
                      x: singleSelected.x,
                      y: singleSelected.y + singleSelected.height,
                      cur: 'nesw-resize',
                    },
                    {
                      id: 'w',
                      x: singleSelected.x,
                      y: singleSelected.y + singleSelected.height / 2,
                      cur: 'ew-resize',
                    },
                  ] as Array<{ id: ResizeHandle; x: number; y: number; cur: string }>
                ).map((h) => {
                  const sz = 9 / viewport.zoom;
                  return (
                    <rect
                      key={h.id}
                      x={h.x - sz / 2}
                      y={h.y - sz / 2}
                      width={sz}
                      height={sz}
                      rx={2 / viewport.zoom}
                      fill="#ffffff"
                      stroke="#0d9488"
                      strokeWidth={1.75 / viewport.zoom}
                      style={{ cursor: h.cur }}
                      onPointerDown={(e) => handleResizePointerDown(e, singleSelected, h.id)}
                    />
                  );
                })}
              </g>
            )}

          {/* Single Selected Arrow / Line Endpoint Handles */}
          {singleSelected &&
            (singleSelected.kind === 'arrow' || singleSelected.kind === 'line') && (() => {
              const { start, end } = resolveBoundEndpoints(singleSelected, canvas.elements);
              const r = 6 / viewport.zoom;
              return (
                <g>
                  <circle
                    cx={start.x}
                    cy={start.y}
                    r={r}
                    fill={singleSelected.startBinding ? '#0d9488' : '#ffffff'}
                    stroke="#0d9488"
                    strokeWidth={2 / viewport.zoom}
                    style={{ cursor: 'grab' }}
                    onPointerDown={(e) => handleEndpointPointerDown(e, singleSelected, 'start')}
                  />
                  <circle
                    cx={end.x}
                    cy={end.y}
                    r={r}
                    fill={singleSelected.endBinding ? '#0d9488' : '#ffffff'}
                    stroke="#0d9488"
                    strokeWidth={2 / viewport.zoom}
                    style={{ cursor: 'grab' }}
                    onPointerDown={(e) => handleEndpointPointerDown(e, singleSelected, 'end')}
                  />
                </g>
              );
            })()}

          {/* Marquee Selection Rectangle */}
          {marquee && (
            <rect
              x={marquee.x}
              y={marquee.y}
              width={marquee.w}
              height={marquee.h}
              fill="rgba(13, 148, 136, 0.1)"
              stroke="#0d9488"
              strokeWidth={1.25 / viewport.zoom}
              strokeDasharray={`${4 / viewport.zoom} ${3 / viewport.zoom}`}
              className="pointer-events-none"
            />
          )}
        </g>
      </svg>

      {/* ================================================================= */}
      {/* Inline On-Canvas Text Editor Overlay                              */}
      {/* ================================================================= */}
      {editingEl && editingBox && (
        <textarea
          ref={textareaRef}
          autoFocus
          value={editDraft}
          onChange={(e) => {
            editDraftRef.current = e.target.value;
            setEditDraft(e.target.value);
          }}
          onBlur={() => {
            // Guard against synthetic focus bounce immediately after pointerup in WebKit/WKWebView
            if (performance.now() - editingOpenedAtRef.current < 180) {
              requestAnimationFrame(() => textareaRef.current?.focus());
              return;
            }
            finishTextEdit(true);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyUp={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') {
              e.preventDefault();
              finishTextEdit(true);
            } else if (e.key === 'Enter') {
              if (editingBox.isSingleLine || e.metaKey || e.ctrlKey) {
                e.preventDefault();
                finishTextEdit(true);
              }
            }
          }}
          placeholder={editingEl.kind === 'arrow' ? 'Label...' : 'Type text...'}
          className="absolute z-40 resize-none rounded-lg px-2 py-1 outline-none ring-2 ring-teal-500 shadow-lg select-text"
          style={{
            left: `${editingBox.left}px`,
            top: `${editingBox.top}px`,
            width: `${editingBox.width}px`,
            height: `${editingBox.height}px`,
            userSelect: 'text',
            WebkitUserSelect: 'text',
            fontFamily: getCanvasFontStack(editingEl.fontFamily),
            fontSize: `${Math.max(11, (editingEl.fontSize ?? (editingEl.kind === 'text' ? 18 : 14)) * viewport.zoom)}px`,
            fontWeight: editingEl.kind === 'sticky' ? 500 : 600,
            lineHeight: 1.32,
            textAlign:
              editingEl.textAlign ??
              (editingEl.kind === 'sticky' || editingEl.kind === 'text' || editingEl.kind === 'frame'
                ? 'left'
                : 'center'),
            color: getTextColorForElement(editingEl, canvas.theme),
            backgroundColor:
              editingEl.kind === 'arrow' || editingEl.kind === 'line' || editingEl.kind === 'frame'
                ? isDark
                  ? '#1e293b'
                  : '#ffffff'
                : editingEl.fill && editingEl.fill !== 'transparent'
                  ? editingEl.fill
                  : isDark
                    ? 'rgba(15,23,42,0.92)'
                    : 'rgba(255,255,255,0.92)',
          }}
        />
      )}

      {/* ================================================================= */}
      {/* Bottom-Left Board Pattern & Theme Controls                        */}
      {/* ================================================================= */}
      <div
        className="absolute bottom-4 left-4 z-30 flex items-center gap-2"
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <div
          className={`flex items-center gap-0.5 p-1 rounded-xl border backdrop-blur-md shadow-md text-xs ${pillBg}`}
        >
          {(
            [
              { id: 'dots', label: 'Dots' },
              { id: 'grid', label: 'Grid' },
              { id: 'plain', label: 'Plain' },
            ] as Array<{ id: CanvasBackground; label: string }>
          ).map((bg) => (
            <button
              key={bg.id}
              type="button"
              onClick={() => setBackground(bg.id)}
              className={`px-2.5 py-1 rounded-lg font-medium transition-colors flex items-center gap-1 ${toolbarBtn(
                canvas.background === bg.id
              )}`}
            >
              {bg.id === 'grid' && <Grid3X3 className="w-3 h-3" />}
              {bg.label}
            </button>
          ))}

          <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1" />

          <button
            type="button"
            title={isDark ? 'Switch to Light Board' : 'Switch to Dark Board'}
            onClick={toggleTheme}
            className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${toolbarBtn(
              false
            )}`}
          >
            {isDark ? <Sun className="w-3.5 h-3.5 text-amber-400" /> : <Moon className="w-3.5 h-3.5" />}
          </button>
        </div>

        <div
          className={`hidden md:flex items-center px-2.5 py-1.5 rounded-xl border backdrop-blur-md shadow-xs text-[11px] opacity-75 ${pillBg}`}
        >
          {canvas.elements.length} {canvas.elements.length === 1 ? 'object' : 'objects'} • Space+drag to pan
        </div>
      </div>

      {/* ================================================================= */}
      {/* Bottom-Right Zoom & Fit-to-Content Controls                       */}
      {/* ================================================================= */}
      <div
        className="absolute bottom-4 right-4 z-30"
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <div
          className={`flex items-center gap-0.5 p-1 rounded-xl border backdrop-blur-md shadow-md text-xs ${pillBg}`}
        >
          <button
            type="button"
            title="Zoom Out"
            onClick={() => zoomByFactor(0.84)}
            className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${toolbarBtn(
              false
            )}`}
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            title="Reset Zoom to 100% (⌘0)"
            onClick={resetZoom}
            className={`px-2 h-7 rounded-lg font-semibold tabular-nums transition-colors ${toolbarBtn(
              false
            )}`}
          >
            {Math.round(viewport.zoom * 100)}%
          </button>
          <button
            type="button"
            title="Zoom In"
            onClick={() => zoomByFactor(1.18)}
            className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${toolbarBtn(
              false
            )}`}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-0.5" />
          <button
            type="button"
            title="Fit to Content (⌘1)"
            onClick={fitToContent}
            className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${toolbarBtn(
              false
            )}`}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Drop File Overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 bg-teal-500/10 border-2 border-dashed border-teal-500 flex items-center justify-center pointer-events-none">
          <div className="px-5 py-3 rounded-2xl bg-white/95 dark:bg-slate-900/95 shadow-xl text-sm font-semibold text-teal-700 dark:text-teal-300">
            Drop an image, .fcanvas, or .excalidraw file onto the board
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* Import Mermaid Diagram Modal                                      */}
      {/* ================================================================= */}
      {showMermaidModal && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setShowMermaidModal(false)}
        >
          <div
            className={`w-full max-w-lg rounded-2xl border shadow-2xl p-5 space-y-4 ${
              isDark
                ? 'bg-slate-900 border-slate-700 text-slate-100'
                : 'bg-white border-slate-200 text-slate-800'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-teal-500/15 text-teal-600 dark:text-teal-400 flex items-center justify-center">
                  <GitBranch className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-semibold text-sm">Import Mermaid Diagram</h3>
                  <p className="text-xs opacity-65">
                    Convert Mermaid flowchart / graph syntax into editable shapes & bound arrows
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowMermaidModal(false)}
                className="w-7 h-7 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <textarea
              value={mermaidText}
              onChange={(e) => {
                setMermaidText(e.target.value);
                if (mermaidError) setMermaidError(null);
              }}
              rows={8}
              spellCheck={false}
              className={`w-full rounded-xl border p-3 font-mono text-xs leading-relaxed outline-none focus:ring-2 focus:ring-teal-500 ${
                isDark
                  ? 'bg-slate-950 border-slate-700 text-slate-100'
                  : 'bg-slate-50 border-slate-200 text-slate-800'
              }`}
              placeholder="flowchart TD&#10;  A[Start] --> B{Decision}&#10;  B -->|Yes| C[Done]"
            />

            {mermaidError && (
              <div className="text-xs text-rose-600 dark:text-rose-400 font-medium">
                {mermaidError}
              </div>
            )}

            <div className="flex items-center justify-between pt-1">
              <button
                type="button"
                onClick={() => setMermaidText(DEFAULT_MERMAID_SAMPLE)}
                className="text-xs font-medium text-teal-600 dark:text-teal-400 hover:underline"
              >
                Reset example
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowMermaidModal(false)}
                  className="px-3.5 py-1.5 rounded-xl text-xs font-medium border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleInsertMermaid}
                  className="px-4 py-1.5 rounded-xl text-xs font-semibold bg-teal-600 hover:bg-teal-700 text-white shadow-xs"
                >
                  Insert Diagram
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
