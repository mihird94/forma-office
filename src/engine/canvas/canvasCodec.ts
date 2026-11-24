import { LineCapStyle, PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  CanvasAnchorSide,
  CanvasBackground,
  CanvasBinding,
  CanvasData,
  CanvasElement,
  CanvasElementKind,
  CanvasPoint,
} from '../../types/canvas';

function uid(prefix = 'el'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function stripExtension(filename?: string): string {
  if (!filename) return 'Untitled Canvas';
  const cleaned = filename.replace(/\.(fcanvas|excalidraw|json)$/i, '').trim();
  return cleaned || 'Untitled Canvas';
}

export function getCanvasFontStack(fontFamily?: 'sans' | 'hand' | 'mono'): string {
  switch (fontFamily) {
    case 'hand':
      return "'Caveat', 'Bradley Hand', 'Segoe Print', 'Comic Sans MS', cursive";
    case 'mono':
      return "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    case 'sans':
    default:
      return "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  }
}

export function hexToRgbNorm(
  hex?: string,
  fallback: { r: number; g: number; b: number } = { r: 0.06, g: 0.09, b: 0.16 }
): { r: number; g: number; b: number } {
  if (!hex || hex === 'transparent' || hex === 'none') return fallback;
  const raw = hex.replace('#', '').trim();
  if (raw.length === 3) {
    const r = parseInt(raw[0] + raw[0], 16);
    const g = parseInt(raw[1] + raw[1], 16);
    const b = parseInt(raw[2] + raw[2], 16);
    if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
      return { r: r / 255, g: g / 255, b: b / 255 };
    }
  }
  if (raw.length === 6) {
    const r = parseInt(raw.slice(0, 2), 16);
    const g = parseInt(raw.slice(2, 4), 16);
    const b = parseInt(raw.slice(4, 6), 16);
    if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
      return { r: r / 255, g: g / 255, b: b / 255 };
    }
  }
  return fallback;
}

export function isDarkColor(hex?: string): boolean {
  if (!hex || hex === 'transparent' || hex === 'none') return false;
  const { r, g, b } = hexToRgbNorm(hex, { r: 1, g: 1, b: 1 });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance < 0.38;
}

export function getTextColorForElement(el: CanvasElement, theme: 'light' | 'dark' = 'light'): string {
  if (el.kind === 'text') {
    if (el.stroke && el.stroke !== 'transparent') return el.stroke;
    return theme === 'dark' ? '#f8fafc' : '#0f172a';
  }
  if (el.kind === 'frame') {
    if (el.fill && el.fill !== 'transparent' && isDarkColor(el.fill)) return '#e2e8f0';
    return theme === 'dark' ? '#cbd5e1' : '#475569';
  }
  if (el.kind === 'arrow' || el.kind === 'line') {
    return el.stroke && el.stroke !== 'transparent'
      ? el.stroke
      : theme === 'dark'
        ? '#e2e8f0'
        : '#334155';
  }
  if (el.fill && el.fill !== 'transparent' && el.fill !== 'none') {
    return isDarkColor(el.fill) ? '#f8fafc' : '#0f172a';
  }
  return theme === 'dark' ? '#f8fafc' : '#0f172a';
}

export function getAnchorPoint(el: CanvasElement, side: CanvasAnchorSide): CanvasPoint {
  const x = el.width >= 0 ? el.x : el.x + el.width;
  const y = el.height >= 0 ? el.y : el.y + el.height;
  const w = Math.abs(el.width);
  const h = Math.abs(el.height);
  switch (side) {
    case 'top':
      return { x: x + w / 2, y };
    case 'right':
      return { x: x + w, y: y + h / 2 };
    case 'bottom':
      return { x: x + w / 2, y: y + h };
    case 'left':
      return { x, y: y + h / 2 };
    case 'center':
    default:
      return { x: x + w / 2, y: y + h / 2 };
  }
}

export function resolveBoundEndpoints(
  el: CanvasElement,
  all: CanvasElement[]
): { start: CanvasPoint; end: CanvasPoint } {
  let start: CanvasPoint;
  let end: CanvasPoint;

  if (el.points && el.points.length >= 2) {
    const first = el.points[0];
    const last = el.points[el.points.length - 1];
    start = { x: el.x + first.x, y: el.y + first.y };
    end = { x: el.x + last.x, y: el.y + last.y };
  } else {
    start = { x: el.x, y: el.y };
    end = { x: el.x + el.width, y: el.y + el.height };
  }

  if (el.startBinding) {
    const target = all.find((item) => item.id === el.startBinding?.elementId);
    if (target) {
      start = getAnchorPoint(target, el.startBinding.anchor);
    }
  }
  if (el.endBinding) {
    const target = all.find((item) => item.id === el.endBinding?.elementId);
    if (target) {
      end = getAnchorPoint(target, el.endBinding.anchor);
    }
  }

  return { start, end };
}

export interface CanvasBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export function computeElementBounds(elements: CanvasElement[]): CanvasBounds {
  if (elements.length === 0) {
    return { minX: 0, minY: 0, maxX: 800, maxY: 600, width: 800, height: 600 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const include = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  for (const el of elements) {
    if (el.kind === 'arrow' || el.kind === 'line') {
      const { start, end } = resolveBoundEndpoints(el, elements);
      include(start.x, start.y);
      include(end.x, end.y);
      if (el.points && el.points.length > 2) {
        for (let i = 1; i < el.points.length - 1; i++) {
          include(el.x + el.points[i].x, el.y + el.points[i].y);
        }
      }
    } else if (el.kind === 'freehand' && el.points && el.points.length > 0) {
      for (const pt of el.points) {
        include(el.x + pt.x, el.y + pt.y);
      }
    } else {
      const x1 = Math.min(el.x, el.x + el.width);
      const y1 = Math.min(el.y, el.y + el.height);
      const x2 = Math.max(el.x, el.x + el.width);
      const y2 = Math.max(el.y, el.y + el.height);
      include(x1, y1);
      include(x2, y2);
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { minX: 0, minY: 0, maxX: 800, maxY: 600, width: 800, height: 600 };
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

// Deterministic seeded PRNG for sketchy double-stroke paths (zero flicker across re-renders)
function createSeededRng(seedStr: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function jitterSegment(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rng: () => number,
  amp = 2.2
): string {
  const j = () => (rng() - 0.5) * 2 * amp;
  const mx = (x1 + x2) / 2 + j() * 1.15;
  const my = (y1 + y2) / 2 + j() * 1.15;
  return `M ${(x1 + j() * 0.6).toFixed(1)} ${(y1 + j() * 0.6).toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${(x2 + j() * 0.6).toFixed(1)} ${(y2 + j() * 0.6).toFixed(1)}`;
}

export function buildSketchyLinePaths(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  seed: string
): string[] {
  const rng = createSeededRng(seed);
  return [
    jitterSegment(x1, y1, x2, y2, rng, 2.0),
    jitterSegment(x1, y1, x2, y2, rng, 2.6),
  ];
}

export function buildSketchyShapePaths(el: CanvasElement): string[] {
  const rng = createSeededRng(el.id);
  const x = el.x;
  const y = el.y;
  const w = Math.max(2, el.width);
  const h = Math.max(2, el.height);

  if (el.kind === 'diamond') {
    const pts: CanvasPoint[] = [
      { x: x + w / 2, y },
      { x: x + w, y: y + h / 2 },
      { x: x + w / 2, y: y + h },
      { x, y: y + h / 2 },
    ];
    const pass = (amp: number) =>
      pts
        .map((p, i) => {
          const next = pts[(i + 1) % pts.length];
          return jitterSegment(p.x, p.y, next.x, next.y, rng, amp);
        })
        .join(' ');
    return [pass(1.9), pass(2.5)];
  }

  if (el.kind === 'ellipse') {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const rx = w / 2;
    const ry = h / 2;
    const buildEllipseLoop = (amp: number) => {
      const steps = 16;
      const pts: CanvasPoint[] = [];
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const jx = (rng() - 0.5) * amp;
        const jy = (rng() - 0.5) * amp;
        pts.push({
          x: cx + Math.cos(a) * (rx + jx),
          y: cy + Math.sin(a) * (ry + jy),
        });
      }
      return pointsToSmoothSvgPath(pts, 0, 0);
    };
    return [buildEllipseLoop(2.2), buildEllipseLoop(3.0)];
  }

  // rect / roundRect / sticky / frame
  const r = el.kind === 'roundRect' ? Math.min(14, w / 4, h / 4) : el.kind === 'sticky' ? 6 : 0;
  const buildBox = (amp: number) => {
    const top = jitterSegment(x + r, y, x + w - r, y, rng, amp);
    const right = jitterSegment(x + w, y + r, x + w, y + h - r, rng, amp);
    const bottom = jitterSegment(x + w - r, y + h, x + r, y + h, rng, amp);
    const left = jitterSegment(x, y + h - r, x, y + r, rng, amp);
    if (r <= 0) return `${top} ${right} ${bottom} ${left}`;
    const c1 = `M ${(x + w - r).toFixed(1)} ${y.toFixed(1)} Q ${(x + w).toFixed(1)} ${y.toFixed(1)} ${(x + w).toFixed(1)} ${(y + r).toFixed(1)}`;
    const c2 = `M ${(x + w).toFixed(1)} ${(y + h - r).toFixed(1)} Q ${(x + w).toFixed(1)} ${(y + h).toFixed(1)} ${(x + w - r).toFixed(1)} ${(y + h).toFixed(1)}`;
    const c3 = `M ${(x + r).toFixed(1)} ${(y + h).toFixed(1)} Q ${x.toFixed(1)} ${(y + h).toFixed(1)} ${x.toFixed(1)} ${(y + h - r).toFixed(1)}`;
    const c4 = `M ${x.toFixed(1)} ${(y + r).toFixed(1)} Q ${x.toFixed(1)} ${y.toFixed(1)} ${(x + r).toFixed(1)} ${y.toFixed(1)}`;
    return `${top} ${c1} ${right} ${c2} ${bottom} ${c3} ${left} ${c4}`;
  };
  return [buildBox(1.8), buildBox(2.4)];
}

export function pointsToSmoothSvgPath(
  points: CanvasPoint[],
  offsetX = 0,
  offsetY = 0
): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    const px = offsetX + points[0].x;
    const py = offsetY + points[0].y;
    return `M ${px.toFixed(1)} ${py.toFixed(1)} L ${(px + 0.5).toFixed(1)} ${(py + 0.5).toFixed(1)}`;
  }
  if (points.length === 2) {
    return `M ${(offsetX + points[0].x).toFixed(1)} ${(offsetY + points[0].y).toFixed(1)} L ${(offsetX + points[1].x).toFixed(1)} ${(offsetY + points[1].y).toFixed(1)}`;
  }

  let d = `M ${(offsetX + points[0].x).toFixed(1)} ${(offsetY + points[0].y).toFixed(1)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const cx = offsetX + points[i].x;
    const cy = offsetY + points[i].y;
    const nx = offsetX + points[i + 1].x;
    const ny = offsetY + points[i + 1].y;
    const mx = (cx + nx) / 2;
    const my = (cy + ny) / 2;
    d += ` Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  const last = points[points.length - 1];
  d += ` L ${(offsetX + last.x).toFixed(1)} ${(offsetY + last.y).toFixed(1)}`;
  return d;
}

// ============================================================================
// 1. Forma Canvas (.fcanvas) JSON Codec
// ============================================================================

export function exportCanvasToFcanvas(canvas: CanvasData): string {
  const payload = {
    format: 'forma-canvas',
    version: 1,
    title: canvas.title,
    background: canvas.background,
    theme: canvas.theme,
    viewport: canvas.viewport,
    elements: canvas.elements,
  };
  return JSON.stringify(payload, null, 2);
}

const VALID_KINDS = new Set<CanvasElementKind>([
  'rect',
  'roundRect',
  'diamond',
  'ellipse',
  'sticky',
  'text',
  'arrow',
  'line',
  'freehand',
  'frame',
  'image',
]);

function normalizeElement(raw: Record<string, unknown>): CanvasElement | null {
  const kind = raw.kind as CanvasElementKind;
  if (!VALID_KINDS.has(kind)) return null;
  const el: CanvasElement = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid('el'),
    kind,
    x: typeof raw.x === 'number' && Number.isFinite(raw.x) ? raw.x : 0,
    y: typeof raw.y === 'number' && Number.isFinite(raw.y) ? raw.y : 0,
    width: typeof raw.width === 'number' && Number.isFinite(raw.width) ? raw.width : 120,
    height: typeof raw.height === 'number' && Number.isFinite(raw.height) ? raw.height : 80,
  };
  if (Array.isArray(raw.points)) {
    el.points = raw.points
      .map((p) => {
        if (Array.isArray(p) && p.length >= 2) {
          return { x: Number(p[0]) || 0, y: Number(p[1]) || 0 };
        }
        if (p && typeof p === 'object') {
          const obj = p as Record<string, unknown>;
          return { x: Number(obj.x) || 0, y: Number(obj.y) || 0 };
        }
        return null;
      })
      .filter((p): p is CanvasPoint => p !== null);
  }
  if (raw.startBinding && typeof raw.startBinding === 'object') {
    const b = raw.startBinding as Record<string, unknown>;
    if (typeof b.elementId === 'string') {
      el.startBinding = {
        elementId: b.elementId,
        anchor: (b.anchor as CanvasAnchorSide) || 'center',
      };
    }
  }
  if (raw.endBinding && typeof raw.endBinding === 'object') {
    const b = raw.endBinding as Record<string, unknown>;
    if (typeof b.elementId === 'string') {
      el.endBinding = {
        elementId: b.elementId,
        anchor: (b.anchor as CanvasAnchorSide) || 'center',
      };
    }
  }
  if (typeof raw.text === 'string') el.text = raw.text;
  if (typeof raw.fontSize === 'number') el.fontSize = raw.fontSize;
  if (raw.fontFamily === 'sans' || raw.fontFamily === 'hand' || raw.fontFamily === 'mono') {
    el.fontFamily = raw.fontFamily;
  }
  if (raw.textAlign === 'left' || raw.textAlign === 'center' || raw.textAlign === 'right') {
    el.textAlign = raw.textAlign;
  }
  if (typeof raw.fill === 'string') el.fill = raw.fill;
  if (typeof raw.stroke === 'string') el.stroke = raw.stroke;
  if (typeof raw.strokeWidth === 'number') el.strokeWidth = raw.strokeWidth;
  if (raw.strokeStyle === 'solid' || raw.strokeStyle === 'dashed' || raw.strokeStyle === 'dotted') {
    el.strokeStyle = raw.strokeStyle;
  }
  if (raw.roughness === 0 || raw.roughness === 1) el.roughness = raw.roughness;
  if (typeof raw.opacity === 'number') {
    el.opacity = raw.opacity > 1 ? Math.min(1, raw.opacity / 100) : Math.max(0, raw.opacity);
  }
  if (typeof raw.src === 'string') el.src = raw.src;
  if (typeof raw.locked === 'boolean') el.locked = raw.locked;
  return el;
}

export function importCanvasFromFcanvas(jsonText: string, filename?: string): CanvasData {
  const parsed = JSON.parse(jsonText) as Record<string, unknown>;
  if (parsed && parsed.type === 'excalidraw') {
    return importCanvasFromExcalidraw(jsonText, filename);
  }

  const now = Date.now();
  const rawElements = Array.isArray(parsed?.elements) ? parsed.elements : [];
  const elements = rawElements
    .map((item) =>
      item && typeof item === 'object' ? normalizeElement(item as Record<string, unknown>) : null
    )
    .filter((item): item is CanvasElement => item !== null);

  const rawViewport = parsed?.viewport as Record<string, unknown> | undefined;
  const viewport = {
    x: typeof rawViewport?.x === 'number' ? rawViewport.x : 0,
    y: typeof rawViewport?.y === 'number' ? rawViewport.y : 0,
    zoom:
      typeof rawViewport?.zoom === 'number' && rawViewport.zoom > 0.05 && rawViewport.zoom <= 10
        ? rawViewport.zoom
        : 1,
  };

  const bg: CanvasBackground =
    parsed?.background === 'dots' || parsed?.background === 'grid' || parsed?.background === 'plain'
      ? parsed.background
      : 'dots';

  const theme: 'light' | 'dark' = parsed?.theme === 'dark' ? 'dark' : 'light';
  const title =
    typeof parsed?.title === 'string' && parsed.title.trim()
      ? parsed.title.trim()
      : stripExtension(filename);

  return {
    id: uid('canvas'),
    title,
    elements,
    viewport,
    background: bg,
    theme,
    sourceFormat: 'fcanvas',
    createdAt: now,
    updatedAt: now,
  };
}

// ============================================================================
// 2. Excalidraw v2 Codec
// ============================================================================

interface ExcalidrawElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: string;
  strokeWidth: number;
  strokeStyle: string;
  roughness: number;
  opacity: number;
  groupIds: string[];
  frameId: string | null;
  roundness: { type: number } | null;
  seed: number;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  boundElements: Array<{ id: string; type: string }> | null;
  updated: number;
  link: string | null;
  locked: boolean;
  text?: string;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: string;
  verticalAlign?: string;
  containerId?: string | null;
  originalText?: string;
  points?: Array<[number, number]>;
  startBinding?: { elementId: string; focus: number; gap: number } | null;
  endBinding?: { elementId: string; focus: number; gap: number } | null;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
  name?: string | null;
}

function mapFontFamilyToExcalidraw(ff?: 'sans' | 'hand' | 'mono'): number {
  if (ff === 'hand') return 1;
  if (ff === 'mono') return 3;
  return 2;
}

function mapFontFamilyFromExcalidraw(ff?: unknown): 'sans' | 'hand' | 'mono' {
  if (ff === 1 || ff === 'hand') return 'hand';
  if (ff === 3 || ff === 'mono') return 'mono';
  return 'sans';
}

function nearestAnchorForPoint(target: CanvasElement, pt: CanvasPoint): CanvasAnchorSide {
  const sides: CanvasAnchorSide[] = ['top', 'right', 'bottom', 'left'];
  let best: CanvasAnchorSide = 'center';
  let bestDist = Infinity;
  for (const s of sides) {
    const ap = getAnchorPoint(target, s);
    const d = Math.hypot(ap.x - pt.x, ap.y - pt.y);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best;
}

export function exportCanvasToExcalidraw(canvas: CanvasData): string {
  const now = Date.now();
  const out: ExcalidrawElement[] = [];

  for (let i = 0; i < canvas.elements.length; i++) {
    const el = canvas.elements[i];
    if (el.kind === 'image') continue; // Excalidraw binary files map not needed for basic vector export

    const base: ExcalidrawElement = {
      id: el.id,
      type: 'rectangle',
      x: el.x,
      y: el.y,
      width: Math.abs(el.width),
      height: Math.abs(el.height),
      angle: 0,
      strokeColor: el.stroke || (canvas.theme === 'dark' ? '#f8fafc' : '#0f172a'),
      backgroundColor: el.fill && el.fill !== 'none' ? el.fill : 'transparent',
      fillStyle: 'solid',
      strokeWidth: el.strokeWidth ?? 2,
      strokeStyle: el.strokeStyle ?? 'solid',
      roughness: el.roughness === 1 ? 1 : 0,
      opacity: Math.round((el.opacity ?? 1) * 100),
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 1000 + i * 37,
      version: 1,
      versionNonce: 2000 + i * 19,
      isDeleted: false,
      boundElements: null,
      updated: now,
      link: null,
      locked: Boolean(el.locked),
    };

    if (el.kind === 'rect') {
      base.type = 'rectangle';
    } else if (el.kind === 'roundRect' || el.kind === 'sticky') {
      base.type = 'rectangle';
      base.roundness = { type: 3 };
    } else if (el.kind === 'diamond') {
      base.type = 'diamond';
    } else if (el.kind === 'ellipse') {
      base.type = 'ellipse';
    } else if (el.kind === 'frame') {
      base.type = 'frame';
      base.name = el.text ?? 'Frame';
    } else if (el.kind === 'text') {
      base.type = 'text';
      base.text = el.text ?? '';
      base.originalText = el.text ?? '';
      base.fontSize = el.fontSize ?? 18;
      base.fontFamily = mapFontFamilyToExcalidraw(el.fontFamily);
      base.textAlign = el.textAlign ?? 'left';
      base.verticalAlign = 'top';
      base.containerId = null;
    } else if (el.kind === 'arrow' || el.kind === 'line') {
      const { start, end } = resolveBoundEndpoints(el, canvas.elements);
      base.type = el.kind;
      base.x = start.x;
      base.y = start.y;
      base.width = Math.abs(end.x - start.x);
      base.height = Math.abs(end.y - start.y);
      base.points = [
        [0, 0],
        [end.x - start.x, end.y - start.y],
      ];
      base.startBinding = el.startBinding
        ? { elementId: el.startBinding.elementId, focus: 0, gap: 4 }
        : null;
      base.endBinding = el.endBinding
        ? { elementId: el.endBinding.elementId, focus: 0, gap: 4 }
        : null;
      base.startArrowhead = null;
      base.endArrowhead = el.kind === 'arrow' ? 'arrow' : null;
    } else if (el.kind === 'freehand') {
      base.type = 'freedraw';
      base.points = (el.points ?? [{ x: 0, y: 0 }]).map((p) => [p.x, p.y]);
    }

    // Emit bound text label for shapes/stickies/arrows
    if (
      el.text &&
      el.text.trim().length > 0 &&
      el.kind !== 'text' &&
      el.kind !== 'frame' &&
      el.kind !== 'freehand'
    ) {
      const textId = `${el.id}_label`;
      base.boundElements = [{ id: textId, type: 'text' }];
      out.push(base);

      const fontSize = el.fontSize ?? 14;
      const labelW = Math.max(40, base.width - 16);
      const labelH = Math.max(24, fontSize * 1.4 * el.text.split('\n').length);
      out.push({
        id: textId,
        type: 'text',
        x: base.x + (base.width - labelW) / 2,
        y: base.y + (base.height - labelH) / 2,
        width: labelW,
        height: labelH,
        angle: 0,
        strokeColor: getTextColorForElement(el, canvas.theme),
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: 1,
        strokeStyle: 'solid',
        roughness: 0,
        opacity: base.opacity,
        groupIds: [],
        frameId: null,
        roundness: null,
        seed: 5000 + i * 29,
        version: 1,
        versionNonce: 6000 + i * 17,
        isDeleted: false,
        boundElements: null,
        updated: now,
        link: null,
        locked: Boolean(el.locked),
        text: el.text,
        originalText: el.text,
        fontSize,
        fontFamily: mapFontFamilyToExcalidraw(el.fontFamily),
        textAlign: el.textAlign ?? 'center',
        verticalAlign: 'middle',
        containerId: el.id,
      });
    } else {
      out.push(base);
    }
  }

  return JSON.stringify(
    {
      type: 'excalidraw',
      version: 2,
      source: 'forma-canvas',
      elements: out,
      appState: {
        viewBackgroundColor: canvas.theme === 'dark' ? '#0f172a' : '#ffffff',
        gridSize: canvas.background === 'grid' ? 20 : null,
      },
      files: {},
    },
    null,
    2
  );
}

export function importCanvasFromExcalidraw(jsonText: string, filename?: string): CanvasData {
  const parsed = JSON.parse(jsonText) as {
    elements?: Array<Record<string, unknown>>;
    appState?: { viewBackgroundColor?: string; gridSize?: number | null };
  };
  const now = Date.now();
  const rawList = Array.isArray(parsed?.elements) ? parsed.elements : [];
  const activeRaw = rawList.filter((item) => item && item.isDeleted !== true);

  // Collect bound text labels keyed by containerId
  const boundTextMap = new Map<
    string,
    { text: string; fontSize?: number; fontFamily?: 'sans' | 'hand' | 'mono'; textAlign?: 'left' | 'center' | 'right' }
  >();
  for (const item of activeRaw) {
    if (item.type === 'text' && typeof item.containerId === 'string' && item.containerId) {
      boundTextMap.set(item.containerId, {
        text: typeof item.text === 'string' ? item.text : '',
        fontSize: typeof item.fontSize === 'number' ? item.fontSize : undefined,
        fontFamily: mapFontFamilyFromExcalidraw(item.fontFamily),
        textAlign:
          item.textAlign === 'left' || item.textAlign === 'center' || item.textAlign === 'right'
            ? item.textAlign
            : 'center',
      });
    }
  }

  const elements: CanvasElement[] = [];

  for (const item of activeRaw) {
    const type = String(item.type || '');
    if (type === 'text' && typeof item.containerId === 'string' && item.containerId) {
      continue; // Merged into its container
    }

    let kind: CanvasElementKind | null = null;
    if (type === 'rectangle') {
      kind = item.roundness ? 'roundRect' : 'rect';
    } else if (type === 'diamond') {
      kind = 'diamond';
    } else if (type === 'ellipse') {
      kind = 'ellipse';
    } else if (type === 'text') {
      kind = 'text';
    } else if (type === 'arrow') {
      kind = 'arrow';
    } else if (type === 'line') {
      kind = 'line';
    } else if (type === 'freedraw') {
      kind = 'freehand';
    } else if (type === 'frame') {
      kind = 'frame';
    }

    if (!kind) continue;

    const id = typeof item.id === 'string' && item.id ? item.id : uid('ex');
    const x = typeof item.x === 'number' ? item.x : 0;
    const y = typeof item.y === 'number' ? item.y : 0;
    const width = typeof item.width === 'number' ? Math.max(1, Math.abs(item.width)) : 120;
    const height = typeof item.height === 'number' ? Math.max(1, Math.abs(item.height)) : 80;

    const bound = boundTextMap.get(id);
    const rawOpacity = typeof item.opacity === 'number' ? item.opacity : 100;
    const opacity = rawOpacity > 1 ? Math.min(1, rawOpacity / 100) : Math.max(0, rawOpacity);

    const el: CanvasElement = {
      id,
      kind,
      x,
      y,
      width,
      height,
      stroke: typeof item.strokeColor === 'string' ? item.strokeColor : '#0f172a',
      fill:
        typeof item.backgroundColor === 'string' && item.backgroundColor !== ''
          ? item.backgroundColor
          : 'transparent',
      strokeWidth: typeof item.strokeWidth === 'number' ? item.strokeWidth : 2,
      strokeStyle:
        item.strokeStyle === 'dashed' || item.strokeStyle === 'dotted' ? item.strokeStyle : 'solid',
      roughness: typeof item.roughness === 'number' && item.roughness > 0 ? 1 : 0,
      opacity,
      locked: Boolean(item.locked),
    };

    if (kind === 'text') {
      el.text = typeof item.text === 'string' ? item.text : '';
      el.fontSize = typeof item.fontSize === 'number' ? item.fontSize : 18;
      el.fontFamily = mapFontFamilyFromExcalidraw(item.fontFamily);
      el.textAlign =
        item.textAlign === 'left' || item.textAlign === 'center' || item.textAlign === 'right'
          ? item.textAlign
          : 'left';
    } else if (kind === 'frame') {
      el.text = typeof item.name === 'string' ? item.name : 'Frame';
      el.fontSize = 14;
      el.fontFamily = 'sans';
    } else if (bound) {
      el.text = bound.text;
      el.fontSize = bound.fontSize ?? 14;
      el.fontFamily = bound.fontFamily ?? 'sans';
      el.textAlign = bound.textAlign ?? 'center';
    }

    if ((kind === 'arrow' || kind === 'line' || kind === 'freehand') && Array.isArray(item.points)) {
      el.points = item.points
        .map((pt) => {
          if (Array.isArray(pt) && pt.length >= 2) {
            return { x: Number(pt[0]) || 0, y: Number(pt[1]) || 0 };
          }
          if (pt && typeof pt === 'object') {
            const pObj = pt as Record<string, unknown>;
            return { x: Number(pObj.x) || 0, y: Number(pObj.y) || 0 };
          }
          return null;
        })
        .filter((p): p is CanvasPoint => p !== null);
    }

    if (kind === 'arrow' || kind === 'line') {
      const sb = item.startBinding as Record<string, unknown> | null | undefined;
      const eb = item.endBinding as Record<string, unknown> | null | undefined;
      if (sb && typeof sb.elementId === 'string') {
        el.startBinding = { elementId: sb.elementId, anchor: 'center' };
      }
      if (eb && typeof eb.elementId === 'string') {
        el.endBinding = { elementId: eb.elementId, anchor: 'center' };
      }
    }

    elements.push(el);
  }

  // Refine arrow binding anchors to nearest side of their target shape
  for (const el of elements) {
    if ((el.kind === 'arrow' || el.kind === 'line') && el.points && el.points.length >= 2) {
      const startPt = { x: el.x + el.points[0].x, y: el.y + el.points[0].y };
      const endPt = {
        x: el.x + el.points[el.points.length - 1].x,
        y: el.y + el.points[el.points.length - 1].y,
      };
      if (el.startBinding) {
        const target = elements.find((t) => t.id === el.startBinding?.elementId);
        if (target) el.startBinding.anchor = nearestAnchorForPoint(target, startPt);
      }
      if (el.endBinding) {
        const target = elements.find((t) => t.id === el.endBinding?.elementId);
        if (target) el.endBinding.anchor = nearestAnchorForPoint(target, endPt);
      }
    }
  }

  const viewBg = parsed?.appState?.viewBackgroundColor;
  const theme: 'light' | 'dark' = isDarkColor(viewBg) ? 'dark' : 'light';
  const background: CanvasBackground = parsed?.appState?.gridSize ? 'grid' : 'dots';

  return {
    id: uid('canvas'),
    title: stripExtension(filename),
    elements,
    viewport: { x: 40, y: 40, zoom: 1 },
    background,
    theme,
    sourceFormat: 'excalidraw',
    createdAt: now,
    updatedAt: now,
  };
}

// ============================================================================
// 3. Mermaid Flowchart -> Canvas Elements Parser
// ============================================================================

interface ParsedMermaidNode {
  key: string;
  label: string;
  kind: CanvasElementKind;
  fill: string;
  stroke: string;
  subgraph?: string;
}

interface ParsedMermaidEdge {
  from: string;
  to: string;
  label?: string;
  dashed: boolean;
  isLine: boolean;
}

function parseMermaidNodeToken(rawToken: string): ParsedMermaidNode | null {
  const token = rawToken.trim();
  if (!token) return null;

  // Match patterns: A((Label)), A([Label]), A[(Label)], A{Label}, A(Label), A[Label], or bare A
  const patterns: Array<{
    re: RegExp;
    kind: CanvasElementKind;
    fill: string;
    stroke: string;
  }> = [
    { re: /^([A-Za-z0-9_-]+)\s*\(\(([\s\S]+?)\)\)$/, kind: 'ellipse', fill: '#fefce8', stroke: '#ca8a04' },
    { re: /^([A-Za-z0-9_-]+)\s*\(\[([\s\S]+?)\]\)$/, kind: 'roundRect', fill: '#eff6ff', stroke: '#2563eb' },
    { re: /^([A-Za-z0-9_-]+)\s*\[\(([\s\S]+?)\)\]$/, kind: 'ellipse', fill: '#f5f3ff', stroke: '#7c3aed' },
    { re: /^([A-Za-z0-9_-]+)\s*\{\{([\s\S]+?)\}\}$/, kind: 'diamond', fill: '#f0fdfa', stroke: '#0d9488' },
    { re: /^([A-Za-z0-9_-]+)\s*\{([\s\S]+?)\}$/, kind: 'diamond', fill: '#f0fdfa', stroke: '#0d9488' },
    { re: /^([A-Za-z0-9_-]+)\s*\(([\s\S]+?)\)$/, kind: 'roundRect', fill: '#ecfdf5', stroke: '#059669' },
    { re: /^([A-Za-z0-9_-]+)\s*\[([\s\S]+?)\]$/, kind: 'rect', fill: '#f8fafc', stroke: '#334155' },
  ];

  for (const p of patterns) {
    const m = p.re.exec(token);
    if (m) {
      const label = m[2].replace(/^["']|["']$/g, '').replace(/<br\s*\/?>/gi, '\n').trim();
      return { key: m[1], label: label || m[1], kind: p.kind, fill: p.fill, stroke: p.stroke };
    }
  }

  const bare = /^([A-Za-z0-9_-]+)$/.exec(token);
  if (bare) {
    return {
      key: bare[1],
      label: bare[1],
      kind: 'roundRect',
      fill: '#f8fafc',
      stroke: '#334155',
    };
  }
  return null;
}

export function importMermaidToCanvas(mermaidCode: string): CanvasElement[] {
  const rawLines = mermaidCode
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/%%.*$/, '').trim())
    .filter((l) => l.length > 0);

  let direction: 'TD' | 'TB' | 'LR' | 'RL' | 'BT' = 'TD';
  const nodes = new Map<string, ParsedMermaidNode>();
  const nodeOrder: string[] = [];
  const edges: ParsedMermaidEdge[] = [];
  const subgraphStack: string[] = [];

  const registerNode = (parsed: ParsedMermaidNode | null, explicitShape = false): string | null => {
    if (!parsed) return null;
    const existing = nodes.get(parsed.key);
    if (!existing) {
      if (subgraphStack.length > 0) {
        parsed.subgraph = subgraphStack[subgraphStack.length - 1];
      }
      nodes.set(parsed.key, parsed);
      nodeOrder.push(parsed.key);
    } else {
      // Upgrade bare placeholder when an explicit label/shape is encountered
      if (explicitShape || (existing.label === existing.key && parsed.label !== parsed.key)) {
        existing.label = parsed.label;
        existing.kind = parsed.kind;
        existing.fill = parsed.fill;
        existing.stroke = parsed.stroke;
      }
      if (!existing.subgraph && subgraphStack.length > 0) {
        existing.subgraph = subgraphStack[subgraphStack.length - 1];
      }
    }
    return parsed.key;
  };

  // Edge connector matcher supporting -->, ---, -.->, ==>, -->|label|, -- label -->, -. label .->
  const edgeSplitRegex =
    /\s*(-->\s*\|([^|]+)\||-\.->\s*\|([^|]+)\||==>\s*\|([^|]+)\||--\s+([^->\n]+?)\s+-->|-\.\s+([^.\n]+?)\s+\.->|-.->|==>|-->|---)\s*/;

  for (const rawLine of rawLines) {
    // Header line
    const headerMatch = /^(?:flowchart|graph)\s+(TD|TB|LR|RL|BT)\b/i.exec(rawLine);
    if (headerMatch) {
      direction = headerMatch[1].toUpperCase() as 'TD' | 'TB' | 'LR' | 'RL' | 'BT';
      continue;
    }

    // Subgraph open/close
    const subMatch = /^subgraph\s+(.+)$/i.exec(rawLine);
    if (subMatch) {
      const title = subMatch[1].replace(/^["']|["']$/g, '').replace(/^[A-Za-z0-9_-]+\s*\[(.+)\]$/, '$1').trim();
      subgraphStack.push(title || 'Group');
      continue;
    }
    if (/^end$/i.test(rawLine)) {
      subgraphStack.pop();
      continue;
    }

    // Skip style/classDef directives
    if (/^(?:style|classDef|class|click|linkStyle)\b/i.test(rawLine)) {
      continue;
    }

    // Split chained statements separated by semicolons
    const statements = rawLine
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const stmt of statements) {
      if (edgeSplitRegex.test(stmt)) {
        // Parse chained edges: A --> B -->|yes| C
        let remaining = stmt;
        let prevKey: string | null = null;

        while (remaining.length > 0) {
          const match = edgeSplitRegex.exec(remaining);
          if (!match) {
            const tailNode = parseMermaidNodeToken(remaining);
            const hasExplicit = /[\[\(\{]/.test(remaining);
            const tailKey = registerNode(tailNode, hasExplicit);
            if (prevKey && tailKey) {
              // Shouldn't happen without connector
            }
            break;
          }

          const leftPart = remaining.slice(0, match.index).trim();
          const connector = match[1].trim();
          const label = (match[2] || match[3] || match[4] || match[5] || match[6] || '').trim() || undefined;
          const dashed = connector.includes('-.');
          const isLine = connector === '---';

          if (leftPart) {
            const leftNode = parseMermaidNodeToken(leftPart);
            const leftKey = registerNode(leftNode, /[\[\(\{]/.test(leftPart));
            if (leftKey) prevKey = leftKey;
          }

          remaining = remaining.slice(match.index + match[0].length).trim();

          // Find next connector to isolate right node token
          const nextMatch = edgeSplitRegex.exec(remaining);
          const rightPart = nextMatch ? remaining.slice(0, nextMatch.index).trim() : remaining;
          const rightNode = parseMermaidNodeToken(rightPart);
          const rightKey = registerNode(rightNode, /[\[\(\{]/.test(rightPart));

          if (prevKey && rightKey) {
            edges.push({ from: prevKey, to: rightKey, label, dashed, isLine });
            prevKey = rightKey;
          }

          if (nextMatch) {
            remaining = remaining.slice(nextMatch.index).trim();
          } else {
            break;
          }
        }
      } else {
        // Standalone node declaration
        const node = parseMermaidNodeToken(stmt);
        registerNode(node, /[\[\(\{]/.test(stmt));
      }
    }
  }

  if (nodeOrder.length === 0) return [];

  // Topological / longest-path layer assignment with cycle guard
  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const key of nodeOrder) {
    inDegree.set(key, 0);
    outgoing.set(key, []);
  }
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    outgoing.get(edge.from)?.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const layerOf = new Map<string, number>();
  const queue: string[] = [];
  for (const key of nodeOrder) {
    if ((inDegree.get(key) ?? 0) === 0) {
      queue.push(key);
      layerOf.set(key, 0);
    }
  }
  if (queue.length === 0) {
    queue.push(nodeOrder[0]);
    layerOf.set(nodeOrder[0], 0);
  }

  let safety = 0;
  const maxSteps = nodeOrder.length * nodeOrder.length + 32;
  while (queue.length > 0 && safety < maxSteps) {
    safety++;
    const curr = queue.shift()!;
    const currLayer = layerOf.get(curr) ?? 0;
    for (const next of outgoing.get(curr) ?? []) {
      const existing = layerOf.get(next);
      if (existing === undefined || (existing < currLayer + 1 && currLayer + 1 < nodeOrder.length)) {
        layerOf.set(next, currLayer + 1);
        queue.push(next);
      }
    }
  }

  for (const key of nodeOrder) {
    if (!layerOf.has(key)) layerOf.set(key, 0);
  }

  // Group nodes by layer
  const layers = new Map<number, string[]>();
  let maxLayer = 0;
  for (const key of nodeOrder) {
    const l = layerOf.get(key) ?? 0;
    if (l > maxLayer) maxLayer = l;
    const bucket = layers.get(l) ?? [];
    bucket.push(key);
    layers.set(l, bucket);
  }

  const isHorizontal = direction === 'LR' || direction === 'RL';
  const isReversed = direction === 'RL' || direction === 'BT';

  const nodeW = 176;
  const nodeH = 74;
  const gapX = isHorizontal ? 255 : 220;
  const gapY = isHorizontal ? 128 : 138;

  const elementByKey = new Map<string, CanvasElement>();
  const createdNodes: CanvasElement[] = [];

  // Calculate max breadth so all layers are cleanly centered
  let maxPerLayer = 1;
  for (const bucket of layers.values()) {
    if (bucket.length > maxPerLayer) maxPerLayer = bucket.length;
  }

  for (let l = 0; l <= maxLayer; l++) {
    const bucket = layers.get(l) ?? [];
    const effectiveLayer = isReversed ? maxLayer - l : l;
    const breadthOffset = ((maxPerLayer - bucket.length) * (isHorizontal ? gapY : gapX)) / 2;

    bucket.forEach((key, idx) => {
      const info = nodes.get(key)!;
      const w = info.kind === 'diamond' ? 164 : Math.max(nodeW, Math.min(240, info.label.length * 8 + 44));
      const h = info.kind === 'diamond' ? 96 : Math.max(nodeH, info.label.split('\n').length * 22 + 34);
      const x = isHorizontal
        ? 80 + effectiveLayer * gapX
        : 80 + breadthOffset + idx * gapX + (nodeW - w) / 2;
      const y = isHorizontal
        ? 80 + breadthOffset + idx * gapY + (nodeH - h) / 2
        : 80 + effectiveLayer * gapY;

      const el: CanvasElement = {
        id: uid('mnode'),
        kind: info.kind,
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(w),
        height: Math.round(h),
        text: info.label,
        fontSize: 14,
        fontFamily: 'sans',
        textAlign: 'center',
        fill: info.fill,
        stroke: info.stroke,
        strokeWidth: 2,
        strokeStyle: 'solid',
        roughness: 0,
        opacity: 1,
      };
      elementByKey.set(key, el);
      createdNodes.push(el);
    });
  }

  // Optional frames for subgraphs
  const subgraphFrames: CanvasElement[] = [];
  const subgraphMembers = new Map<string, CanvasElement[]>();
  for (const key of nodeOrder) {
    const info = nodes.get(key)!;
    if (info.subgraph) {
      const el = elementByKey.get(key);
      if (el) {
        const list = subgraphMembers.get(info.subgraph) ?? [];
        list.push(el);
        subgraphMembers.set(info.subgraph, list);
      }
    }
  }
  for (const [title, members] of subgraphMembers.entries()) {
    const b = computeElementBounds(members);
    subgraphFrames.push({
      id: uid('mframe'),
      kind: 'frame',
      x: b.minX - 28,
      y: b.minY - 40,
      width: b.width + 56,
      height: b.height + 68,
      text: title,
      fontSize: 13,
      fontFamily: 'sans',
      textAlign: 'left',
      fill: '#f8fafc',
      stroke: '#cbd5e1',
      strokeWidth: 1.5,
      strokeStyle: 'dashed',
      opacity: 1,
    });
  }

  // Create bound arrows/lines for edges
  const createdEdges: CanvasElement[] = [];
  for (const edge of edges) {
    const fromEl = elementByKey.get(edge.from);
    const toEl = elementByKey.get(edge.to);
    if (!fromEl || !toEl) continue;

    const fromLayer = layerOf.get(edge.from) ?? 0;
    const toLayer = layerOf.get(edge.to) ?? 0;
    const isForward = isReversed ? fromLayer > toLayer : fromLayer < toLayer;

    let startAnchor: CanvasAnchorSide;
    let endAnchor: CanvasAnchorSide;
    if (isHorizontal) {
      if (isForward) {
        startAnchor = 'right';
        endAnchor = 'left';
      } else {
        startAnchor = 'bottom';
        endAnchor = 'bottom';
      }
    } else {
      if (isForward) {
        startAnchor = 'bottom';
        endAnchor = 'top';
      } else {
        startAnchor = 'right';
        endAnchor = 'right';
      }
    }

    const start = getAnchorPoint(fromEl, startAnchor);
    const end = getAnchorPoint(toEl, endAnchor);
    createdEdges.push({
      id: uid('medge'),
      kind: edge.isLine ? 'line' : 'arrow',
      x: start.x,
      y: start.y,
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
      points: [
        { x: 0, y: 0 },
        { x: end.x - start.x, y: end.y - start.y },
      ],
      startBinding: { elementId: fromEl.id, anchor: startAnchor },
      endBinding: { elementId: toEl.id, anchor: endAnchor },
      text: edge.label,
      fontSize: 12,
      fontFamily: 'sans',
      textAlign: 'center',
      stroke: '#475569',
      strokeWidth: 2,
      strokeStyle: edge.dashed ? 'dashed' : 'solid',
      roughness: 0,
      opacity: 1,
    });
  }

  return [...subgraphFrames, ...createdNodes, ...createdEdges];
}

// ============================================================================
// 4. Standalone Vector SVG Export
// ============================================================================

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function strokeDashAttr(style?: 'solid' | 'dashed' | 'dotted', sw = 2): string {
  if (style === 'dashed') return ` stroke-dasharray="${(sw * 4).toFixed(1)} ${(sw * 2.5).toFixed(1)}"`;
  if (style === 'dotted') return ` stroke-dasharray="${sw.toFixed(1)} ${(sw * 2.5).toFixed(1)}"`;
  return '';
}

function wrapTextLines(text: string, maxCharsPerLine: number): string[] {
  const out: string[] = [];
  const limit = Math.max(6, Math.floor(maxCharsPerLine));
  for (const para of text.split('\n')) {
    if (!para) {
      out.push('');
      continue;
    }
    const words = para.split(' ');
    let line = '';
    for (const w of words) {
      const candidate = line ? `${line} ${w}` : w;
      if (candidate.length > limit && line) {
        out.push(line);
        line = w;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out;
}

export function exportCanvasToSvg(canvas: CanvasData): string {
  const padding = 48;
  const bounds = computeElementBounds(canvas.elements);
  const vx = Math.floor(bounds.minX - padding);
  const vy = Math.floor(bounds.minY - padding);
  const vw = Math.max(320, Math.ceil(bounds.width + padding * 2));
  const vh = Math.max(240, Math.ceil(bounds.height + padding * 2));
  const bgColor = canvas.theme === 'dark' ? '#0f172a' : '#ffffff';

  // Collect unique arrow stroke colors for clean per-color SVG <marker> arrowheads
  const arrowColors = new Map<string, string>();
  let markerCounter = 0;
  for (const el of canvas.elements) {
    if (el.kind === 'arrow') {
      const col = el.stroke || (canvas.theme === 'dark' ? '#e2e8f0' : '#0f172a');
      if (!arrowColors.has(col)) {
        arrowColors.set(col, `forma-arrow-${++markerCounter}`);
      }
    }
  }

  const markerDefs = Array.from(arrowColors.entries())
    .map(
      ([col, id]) =>
        `    <marker id="${id}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 1 1.5 L 9 5 L 1 8.5 z" fill="${escapeXml(col)}" />
    </marker>`
    )
    .join('\n');

  const bodyParts: string[] = [];

  for (const el of canvas.elements) {
    const opacity = el.opacity ?? 1;
    const stroke = el.stroke || (canvas.theme === 'dark' ? '#e2e8f0' : '#0f172a');
    const fill = el.fill && el.fill !== 'none' ? el.fill : 'none';
    const sw = el.strokeWidth ?? 2;
    const dash = strokeDashAttr(el.strokeStyle, sw);
    const fontStack = escapeXml(getCanvasFontStack(el.fontFamily));
    const fontSize = el.fontSize ?? (el.kind === 'text' ? 18 : 14);
    const textColor = getTextColorForElement(el, canvas.theme);

    if (el.kind === 'frame') {
      const frameFill =
        el.fill && el.fill !== 'transparent' && el.fill !== 'none'
          ? el.fill
          : canvas.theme === 'dark'
            ? '#1e293b'
            : '#f8fafc';
      const frameStroke = el.stroke || (canvas.theme === 'dark' ? '#475569' : '#cbd5e1');
      bodyParts.push(
        `  <g opacity="${opacity}">
    <rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" rx="12" ry="12" fill="${escapeXml(frameFill)}" stroke="${escapeXml(frameStroke)}" stroke-width="${sw}"${dash} />
    ${
      el.text
        ? `<text x="${el.x + 14}" y="${el.y + 22}" font-family="${fontStack}" font-size="${fontSize}" font-weight="600" fill="${escapeXml(textColor)}">${escapeXml(el.text)}</text>`
        : ''
    }
  </g>`
      );
      continue;
    }

    if (
      el.kind === 'rect' ||
      el.kind === 'roundRect' ||
      el.kind === 'diamond' ||
      el.kind === 'ellipse' ||
      el.kind === 'sticky'
    ) {
      const filterAttr = el.kind === 'sticky' ? ' filter="url(#forma-sticky-shadow)"' : '';
      const shapeParts: string[] = [];

      if (el.kind === 'diamond') {
        const cx = el.x + el.width / 2;
        const cy = el.y + el.height / 2;
        const pts = `${cx},${el.y} ${el.x + el.width},${cy} ${cx},${el.y + el.height} ${el.x},${cy}`;
        if (el.roughness === 1) {
          if (fill !== 'none' && fill !== 'transparent') {
            shapeParts.push(`<polygon points="${pts}" fill="${escapeXml(fill)}" stroke="none" />`);
          }
          for (const d of buildSketchyShapePaths(el)) {
            shapeParts.push(
              `<path d="${d}" fill="none" stroke="${escapeXml(stroke)}" stroke-width="${sw}" stroke-linecap="round"${dash} />`
            );
          }
        } else {
          shapeParts.push(
            `<polygon points="${pts}" fill="${escapeXml(fill === 'transparent' ? 'none' : fill)}" stroke="${escapeXml(stroke)}" stroke-width="${sw}" stroke-linejoin="round"${dash} />`
          );
        }
      } else if (el.kind === 'ellipse') {
        const cx = el.x + el.width / 2;
        const cy = el.y + el.height / 2;
        const rx = Math.max(1, el.width / 2);
        const ry = Math.max(1, el.height / 2);
        if (el.roughness === 1) {
          if (fill !== 'none' && fill !== 'transparent') {
            shapeParts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${escapeXml(fill)}" stroke="none" />`);
          }
          for (const d of buildSketchyShapePaths(el)) {
            shapeParts.push(
              `<path d="${d}" fill="none" stroke="${escapeXml(stroke)}" stroke-width="${sw}" stroke-linecap="round"${dash} />`
            );
          }
        } else {
          shapeParts.push(
            `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${escapeXml(fill === 'transparent' ? 'none' : fill)}" stroke="${escapeXml(stroke)}" stroke-width="${sw}"${dash} />`
          );
        }
      } else {
        const r = el.kind === 'roundRect' ? 14 : el.kind === 'sticky' ? 8 : 2;
        const actualFill =
          el.kind === 'sticky' && (fill === 'none' || fill === 'transparent')
            ? '#fef08a'
            : fill === 'transparent'
              ? 'none'
              : fill;
        if (el.roughness === 1) {
          if (actualFill !== 'none') {
            shapeParts.push(
              `<rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" rx="${r}" ry="${r}" fill="${escapeXml(actualFill)}" stroke="none"${filterAttr} />`
            );
          }
          for (const d of buildSketchyShapePaths(el)) {
            shapeParts.push(
              `<path d="${d}" fill="none" stroke="${escapeXml(stroke)}" stroke-width="${sw}" stroke-linecap="round"${dash} />`
            );
          }
        } else {
          shapeParts.push(
            `<rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" rx="${r}" ry="${r}" fill="${escapeXml(actualFill)}" stroke="${escapeXml(stroke)}" stroke-width="${sw}"${dash}${filterAttr} />`
          );
        }
      }

      // Centered or aligned label inside shape/sticky
      if (el.text && el.text.trim()) {
        const padX = el.kind === 'diamond' ? Math.max(18, el.width * 0.18) : 14;
        const availW = Math.max(30, el.width - padX * 2);
        const lines = wrapTextLines(el.text, availW / (fontSize * 0.56));
        const lineH = fontSize * 1.32;
        const totalH = lines.length * lineH;
        const align = el.textAlign ?? (el.kind === 'sticky' ? 'left' : 'center');
        const anchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle';
        const tx =
          align === 'left'
            ? el.x + padX
            : align === 'right'
              ? el.x + el.width - padX
              : el.x + el.width / 2;
        const startY =
          el.kind === 'sticky'
            ? el.y + 18 + fontSize * 0.85
            : el.y + (el.height - totalH) / 2 + fontSize * 0.88;

        const tspans = lines
          .map(
            (ln, idx) =>
              `<tspan x="${tx.toFixed(1)}" y="${(startY + idx * lineH).toFixed(1)}">${escapeXml(ln || ' ')}</tspan>`
          )
          .join('');
        shapeParts.push(
          `<text font-family="${fontStack}" font-size="${fontSize}" font-weight="${el.kind === 'sticky' ? '500' : '600'}" text-anchor="${anchor}" fill="${escapeXml(textColor)}">${tspans}</text>`
        );
      }

      bodyParts.push(`  <g opacity="${opacity}">\n    ${shapeParts.join('\n    ')}\n  </g>`);
      continue;
    }

    if (el.kind === 'text' && el.text) {
      const lines = el.text.split('\n');
      const lineH = fontSize * 1.35;
      const align = el.textAlign ?? 'left';
      const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
      const tx =
        align === 'center'
          ? el.x + el.width / 2
          : align === 'right'
            ? el.x + el.width
            : el.x;
      const tspans = lines
        .map(
          (ln, idx) =>
            `<tspan x="${tx.toFixed(1)}" y="${(el.y + fontSize * 0.95 + idx * lineH).toFixed(1)}">${escapeXml(ln || ' ')}</tspan>`
        )
        .join('');
      bodyParts.push(
        `  <text opacity="${opacity}" font-family="${fontStack}" font-size="${fontSize}" font-weight="${fontSize >= 22 ? '700' : '500'}" text-anchor="${anchor}" fill="${escapeXml(textColor)}">${tspans}</text>`
      );
      continue;
    }

    if (el.kind === 'arrow' || el.kind === 'line') {
      const { start, end } = resolveBoundEndpoints(el, canvas.elements);
      const markerAttr =
        el.kind === 'arrow' ? ` marker-end="url(#${arrowColors.get(stroke)})"` : '';
      const paths: string[] = [];

      if (el.roughness === 1) {
        const sketchy = buildSketchyLinePaths(start.x, start.y, end.x, end.y, el.id);
        sketchy.forEach((d, idx) => {
          paths.push(
            `<path d="${d}" fill="none" stroke="${escapeXml(stroke)}" stroke-width="${sw}" stroke-linecap="round"${dash}${idx === 0 ? markerAttr : ''} />`
          );
        });
      } else {
        paths.push(
          `<line x1="${start.x.toFixed(1)}" y1="${start.y.toFixed(1)}" x2="${end.x.toFixed(1)}" y2="${end.y.toFixed(1)}" stroke="${escapeXml(stroke)}" stroke-width="${sw}" stroke-linecap="round"${dash}${markerAttr} />`
        );
      }

      if (el.text && el.text.trim()) {
        const mx = (start.x + end.x) / 2;
        const my = (start.y + end.y) / 2;
        const pillW = Math.max(36, el.text.length * fontSize * 0.62 + 14);
        const pillH = fontSize + 10;
        const pillBg = canvas.theme === 'dark' ? '#1e293b' : '#ffffff';
        paths.push(
          `<rect x="${(mx - pillW / 2).toFixed(1)}" y="${(my - pillH / 2).toFixed(1)}" width="${pillW.toFixed(1)}" height="${pillH.toFixed(1)}" rx="6" fill="${pillBg}" stroke="${escapeXml(stroke)}" stroke-opacity="0.35" stroke-width="1" />`
        );
        paths.push(
          `<text x="${mx.toFixed(1)}" y="${(my + fontSize * 0.35).toFixed(1)}" font-family="${fontStack}" font-size="${fontSize}" font-weight="600" text-anchor="middle" fill="${escapeXml(textColor)}">${escapeXml(el.text)}</text>`
        );
      }

      bodyParts.push(`  <g opacity="${opacity}">\n    ${paths.join('\n    ')}\n  </g>`);
      continue;
    }

    if (el.kind === 'freehand' && el.points && el.points.length > 0) {
      const d = pointsToSmoothSvgPath(el.points, el.x, el.y);
      bodyParts.push(
        `  <path opacity="${opacity}" d="${d}" fill="none" stroke="${escapeXml(stroke)}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${dash} />`
      );
      continue;
    }

    if (el.kind === 'image' && el.src) {
      bodyParts.push(
        `  <image opacity="${opacity}" href="${escapeXml(el.src)}" x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" preserveAspectRatio="xMidYMid meet" />`
      );
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}" width="${vw}" height="${vh}">
  <defs>
    <filter id="forma-sticky-shadow" x="-12%" y="-12%" width="128%" height="132%">
      <feDropShadow dx="0" dy="6" stdDeviation="6" flood-color="#0f172a" flood-opacity="0.12" />
    </filter>
${markerDefs}
  </defs>
  <rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="${bgColor}" />
${bodyParts.join('\n')}
</svg>`;
}

// ============================================================================
// 5. Crisp 2x PNG Export
// ============================================================================

export async function exportCanvasToPng(canvas: CanvasData): Promise<Uint8Array> {
  const svgStr = exportCanvasToSvg(canvas);
  const bounds = computeElementBounds(canvas.elements);
  const padding = 48;
  const baseW = Math.max(320, Math.ceil(bounds.width + padding * 2));
  const baseH = Math.max(240, Math.ceil(bounds.height + padding * 2));

  // Scale 2x for retina crispness, safely bounded to 4096px
  const maxDim = 4096;
  const scale = Math.min(2, maxDim / Math.max(baseW, baseH));
  const outW = Math.max(1, Math.round(baseW * scale));
  const outH = Math.max(1, Math.round(baseH * scale));

  const svgBlob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Failed to render canvas SVG to PNG'));
      image.src = url;
    });

    const offscreen = document.createElement('canvas');
    offscreen.width = outW;
    offscreen.height = outH;
    const ctx = offscreen.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');

    ctx.fillStyle = canvas.theme === 'dark' ? '#0f172a' : '#ffffff';
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(img, 0, 0, outW, outH);

    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      offscreen.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('PNG encoding failed'));
      }, 'image/png');
    });

    const buf = await pngBlob.arrayBuffer();
    return new Uint8Array(buf);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ============================================================================
// 6. Vector PDF Export via pdf-lib
// ============================================================================

function sanitizeWinAnsi(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2022/g, '*')
    .replace(/\u2192/g, '->')
    .replace(/\u2190/g, '<-')
    .replace(/[^\x20-\xFF]/g, ' ');
}

export async function exportCanvasToPdf(canvas: CanvasData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(sanitizeWinAnsi(canvas.title || 'Forma Canvas'));
  doc.setCreator('Forma Canvas');

  const fontSans = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontMono = await doc.embedFont(StandardFonts.Courier);
  const fontItalic = await doc.embedFont(StandardFonts.HelveticaOblique);

  const padding = 48;
  const bounds = computeElementBounds(canvas.elements);
  const originX = bounds.minX - padding;
  const originY = bounds.minY - padding;
  const pageW = Math.max(400, Math.ceil(bounds.width + padding * 2));
  const pageH = Math.max(300, Math.ceil(bounds.height + padding * 2));

  const page = doc.addPage([pageW, pageH]);
  const bgRgb = canvas.theme === 'dark' ? rgb(0.059, 0.09, 0.165) : rgb(1, 1, 1);
  page.drawRectangle({ x: 0, y: 0, width: pageW, height: pageH, color: bgRgb });

  const toPdfX = (x: number) => x - originX;
  const toPdfY = (y: number) => pageH - (y - originY);

  const pickFont = (el: CanvasElement, bold = false) => {
    if (el.fontFamily === 'mono') return fontMono;
    if (el.fontFamily === 'hand') return fontItalic;
    return bold ? fontBold : fontSans;
  };

  for (const el of canvas.elements) {
    const opacity = el.opacity ?? 1;
    const strokeCol = hexToRgbNorm(
      el.stroke,
      canvas.theme === 'dark' ? { r: 0.89, g: 0.91, b: 0.94 } : { r: 0.06, g: 0.09, b: 0.16 }
    );
    const hasFill = Boolean(el.fill && el.fill !== 'transparent' && el.fill !== 'none');
    const fillCol = hexToRgbNorm(
      el.fill,
      el.kind === 'sticky' ? { r: 0.996, g: 0.941, b: 0.541 } : { r: 0.97, g: 0.98, b: 0.99 }
    );
    const sw = el.strokeWidth ?? 2;
    const dashArray =
      el.strokeStyle === 'dashed'
        ? [sw * 3.5, sw * 2.2]
        : el.strokeStyle === 'dotted'
          ? [sw, sw * 2.2]
          : undefined;

    if (
      el.kind === 'rect' ||
      el.kind === 'roundRect' ||
      el.kind === 'sticky' ||
      el.kind === 'frame'
    ) {
      const px = toPdfX(el.x);
      const py = toPdfY(el.y + el.height);
      const shouldFill = hasFill || el.kind === 'sticky' || el.kind === 'frame';
      page.drawRectangle({
        x: px,
        y: py,
        width: el.width,
        height: el.height,
        color: shouldFill ? rgb(fillCol.r, fillCol.g, fillCol.b) : undefined,
        borderColor: rgb(strokeCol.r, strokeCol.g, strokeCol.b),
        borderWidth: sw,
        borderDashArray: dashArray,
        opacity,
        borderOpacity: opacity,
      });
    } else if (el.kind === 'ellipse') {
      const cx = toPdfX(el.x + el.width / 2);
      const cy = toPdfY(el.y + el.height / 2);
      page.drawEllipse({
        x: cx,
        y: cy,
        xScale: Math.max(1, el.width / 2),
        yScale: Math.max(1, el.height / 2),
        color: hasFill ? rgb(fillCol.r, fillCol.g, fillCol.b) : undefined,
        borderColor: rgb(strokeCol.r, strokeCol.g, strokeCol.b),
        borderWidth: sw,
        opacity,
        borderOpacity: opacity,
      });
    } else if (el.kind === 'diamond') {
      const top = { x: toPdfX(el.x + el.width / 2), y: toPdfY(el.y) };
      const right = { x: toPdfX(el.x + el.width), y: toPdfY(el.y + el.height / 2) };
      const bottom = { x: toPdfX(el.x + el.width / 2), y: toPdfY(el.y + el.height) };
      const left = { x: toPdfX(el.x), y: toPdfY(el.y + el.height / 2) };

      if (hasFill) {
        // drawSvgPath uses top-left relative SVG coordinates rooted at (x, y)
        const svgPath = `M ${el.width / 2} 0 L ${el.width} ${el.height / 2} L ${el.width / 2} ${el.height} L 0 ${el.height / 2} Z`;
        page.drawSvgPath(svgPath, {
          x: toPdfX(el.x),
          y: toPdfY(el.y),
          color: rgb(fillCol.r, fillCol.g, fillCol.b),
          opacity,
        });
      }

      const verts = [top, right, bottom, left];
      for (let i = 0; i < verts.length; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % verts.length];
        page.drawLine({
          start: a,
          end: b,
          thickness: sw,
          color: rgb(strokeCol.r, strokeCol.g, strokeCol.b),
          dashArray,
          opacity,
          lineCap: LineCapStyle.Round,
        });
      }
    } else if (el.kind === 'arrow' || el.kind === 'line') {
      const { start, end } = resolveBoundEndpoints(el, canvas.elements);
      const p1 = { x: toPdfX(start.x), y: toPdfY(start.y) };
      const p2 = { x: toPdfX(end.x), y: toPdfY(end.y) };
      page.drawLine({
        start: p1,
        end: p2,
        thickness: sw,
        color: rgb(strokeCol.r, strokeCol.g, strokeCol.b),
        dashArray,
        opacity,
        lineCap: LineCapStyle.Round,
      });

      if (el.kind === 'arrow') {
        const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
        const headLen = Math.max(9, sw * 4.2);
        const spread = Math.PI / 6;
        const wing1 = {
          x: p2.x - headLen * Math.cos(angle - spread),
          y: p2.y - headLen * Math.sin(angle - spread),
        };
        const wing2 = {
          x: p2.x - headLen * Math.cos(angle + spread),
          y: p2.y - headLen * Math.sin(angle + spread),
        };
        page.drawLine({
          start: p2,
          end: wing1,
          thickness: sw,
          color: rgb(strokeCol.r, strokeCol.g, strokeCol.b),
          opacity,
          lineCap: LineCapStyle.Round,
        });
        page.drawLine({
          start: p2,
          end: wing2,
          thickness: sw,
          color: rgb(strokeCol.r, strokeCol.g, strokeCol.b),
          opacity,
          lineCap: LineCapStyle.Round,
        });
      }

      if (el.text && el.text.trim()) {
        const safe = sanitizeWinAnsi(el.text.trim());
        const size = Math.max(8, (el.fontSize ?? 12) * 0.9);
        const font = pickFont(el, true);
        const tw = font.widthOfTextAtSize(safe, size);
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        const pillBg = canvas.theme === 'dark' ? rgb(0.118, 0.161, 0.231) : rgb(1, 1, 1);
        page.drawRectangle({
          x: mx - tw / 2 - 5,
          y: my - size * 0.5 - 3,
          width: tw + 10,
          height: size + 6,
          color: pillBg,
          opacity,
        });
        page.drawText(safe, {
          x: mx - tw / 2,
          y: my - size * 0.35,
          size,
          font,
          color: rgb(strokeCol.r, strokeCol.g, strokeCol.b),
          opacity,
        });
      }
      continue;
    } else if (el.kind === 'freehand' && el.points && el.points.length >= 2) {
      for (let i = 1; i < el.points.length; i++) {
        const a = el.points[i - 1];
        const b = el.points[i];
        page.drawLine({
          start: { x: toPdfX(el.x + a.x), y: toPdfY(el.y + a.y) },
          end: { x: toPdfX(el.x + b.x), y: toPdfY(el.y + b.y) },
          thickness: sw,
          color: rgb(strokeCol.r, strokeCol.g, strokeCol.b),
          opacity,
          lineCap: LineCapStyle.Round,
        });
      }
      continue;
    } else if (el.kind === 'image' && el.src) {
      try {
        const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(el.src);
        if (m) {
          const fmt = m[1].toLowerCase();
          const bin = atob(m[2]);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const embedded = fmt === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
          page.drawImage(embedded, {
            x: toPdfX(el.x),
            y: toPdfY(el.y + el.height),
            width: el.width,
            height: el.height,
            opacity,
          });
        }
      } catch {
        // skip unsupported image formats
      }
      continue;
    }

    // Draw text label for shapes, stickies, frames, and text blocks
    if (el.text && el.text.trim()) {
      const size = Math.max(8, (el.fontSize ?? (el.kind === 'text' ? 18 : 14)) * 0.9);
      const isBold = el.kind === 'frame' || (el.kind === 'text' && (el.fontSize ?? 18) >= 20) || el.kind === 'roundRect' || el.kind === 'rect';
      const font = pickFont(el, isBold);
      const textCol = hexToRgbNorm(getTextColorForElement(el, canvas.theme));
      const padX = el.kind === 'text' ? 2 : el.kind === 'diamond' ? Math.max(16, el.width * 0.18) : 12;
      const availW = Math.max(24, el.width - padX * 2);

      const safeLines: string[] = [];
      for (const rawLine of sanitizeWinAnsi(el.text).split('\n')) {
        const words = rawLine.split(' ');
        let curr = '';
        for (const w of words) {
          const cand = curr ? `${curr} ${w}` : w;
          if (font.widthOfTextAtSize(cand, size) > availW && curr) {
            safeLines.push(curr);
            curr = w;
          } else {
            curr = cand;
          }
        }
        safeLines.push(curr);
      }

      const lineH = size * 1.32;
      const totalH = safeLines.length * lineH;
      const align =
        el.textAlign ?? (el.kind === 'sticky' || el.kind === 'frame' || el.kind === 'text' ? 'left' : 'center');

      let cursorY: number;
      if (el.kind === 'frame') {
        cursorY = toPdfY(el.y + 18);
      } else if (el.kind === 'text') {
        cursorY = toPdfY(el.y + size * 1.05);
      } else if (el.kind === 'sticky') {
        cursorY = toPdfY(el.y + 20 + size * 0.8);
      } else {
        cursorY = toPdfY(el.y + (el.height - totalH) / 2 + size * 0.85);
      }

      for (const ln of safeLines) {
        if (!ln) {
          cursorY -= lineH;
          continue;
        }
        const tw = font.widthOfTextAtSize(ln, size);
        let drawX = toPdfX(el.x + padX);
        if (align === 'center') drawX = toPdfX(el.x + el.width / 2) - tw / 2;
        else if (align === 'right') drawX = toPdfX(el.x + el.width - padX) - tw;
        page.drawText(ln, {
          x: drawX,
          y: cursorY,
          size,
          font,
          color: rgb(textCol.r, textCol.g, textCol.b),
          opacity,
        });
        cursorY -= lineH;
      }
    }
  }

  return doc.save();
}
