import { PdfInkAnnotation } from '../types/pdf';
import { uid } from '../engine/spreadsheet/workbookOps';

export const SIGNATURE_STORAGE_KEY = 'forma_saved_signatures_v1';

export interface SignaturePoint {
  x: number;
  y: number;
}

export interface SavedSignature {
  id: string;
  name: string;
  color: string;
  strokeWidth: number;
  /** Normalized point strokes inside a 0..1 x 0..1 bounding box */
  strokes: SignaturePoint[][];
  /** Original width / height aspect ratio (clamped to sensible signature proportions) */
  aspectRatio: number;
  /** Inline SVG preview markup */
  svgPreview: string;
  createdAt: number;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function normalizeSignatureStrokes(
  rawStrokes: SignaturePoint[][]
): { strokes: SignaturePoint[][]; aspectRatio: number } {
  const validStrokes = rawStrokes.filter((s) => s.length >= 2);
  if (validStrokes.length === 0) {
    return { strokes: [], aspectRatio: 3 };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const stroke of validStrokes) {
    for (const pt of stroke) {
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    }
  }
  const spanX = Math.max(0.001, maxX - minX);
  const spanY = Math.max(0.001, maxY - minY);
  const aspectRatio = clamp(spanX / spanY, 1.2, 6.0);

  const pad = 0.06;
  const usable = 1 - pad * 2;
  const strokes = validStrokes.map((stroke) =>
    stroke.map((pt) => ({
      x: Math.round((pad + ((pt.x - minX) / spanX) * usable) * 10000) / 10000,
      y: Math.round((pad + ((pt.y - minY) / spanY) * usable) * 10000) / 10000,
    }))
  );
  return { strokes, aspectRatio };
}

export function buildSignatureSvgPreview(
  strokes: SignaturePoint[][],
  color = '#1e3a8a',
  strokeWidth = 2.4
): string {
  const vbW = 160;
  const vbH = 54;
  const paths = strokes
    .filter((s) => s.length >= 2)
    .map((stroke) => {
      const d = stroke
        .map(
          (pt, idx) =>
            `${idx === 0 ? 'M' : 'L'} ${(pt.x * vbW).toFixed(1)} ${(pt.y * vbH).toFixed(1)}`
        )
        .join(' ');
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" />`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vbW} ${vbH}" width="${vbW}" height="${vbH}">${paths}</svg>`;
}

export function loadSavedSignatures(): SavedSignature[] {
  try {
    const raw = window.localStorage.getItem(SIGNATURE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is SavedSignature =>
        Boolean(item) &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        Array.isArray(item.strokes) &&
        item.strokes.length > 0
    );
  } catch {
    return [];
  }
}

function persistSignatures(list: SavedSignature[]): void {
  try {
    window.localStorage.setItem(SIGNATURE_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // ignore storage quota errors
  }
}

export function saveSignatureToVault(input: {
  name: string;
  color: string;
  strokeWidth?: number;
  rawStrokes: SignaturePoint[][];
}): SavedSignature | null {
  const { strokes, aspectRatio } = normalizeSignatureStrokes(input.rawStrokes);
  if (strokes.length === 0) return null;
  const strokeWidth = input.strokeWidth ?? 2.2;
  const entry: SavedSignature = {
    id: uid('sig'),
    name: input.name.trim() || 'My Signature',
    color: input.color || '#1e3a8a',
    strokeWidth,
    strokes,
    aspectRatio,
    svgPreview: buildSignatureSvgPreview(strokes, input.color || '#1e3a8a', strokeWidth),
    createdAt: Date.now(),
  };
  const existing = loadSavedSignatures();
  const next = [entry, ...existing].slice(0, 24);
  persistSignatures(next);
  return entry;
}

export function deleteSavedSignature(id: string): SavedSignature[] {
  const next = loadSavedSignatures().filter((s) => s.id !== id);
  persistSignatures(next);
  return next;
}

/**
 * Convert a saved signature into one or more PdfInkAnnotation strokes stamped at normalized
 * page coordinates (centerX, centerY).
 */
export function stampSignatureToInkAnnotations(
  sig: SavedSignature,
  pageIndex: number,
  centerX: number,
  centerY: number,
  boxWidthNorm = 0.24
): PdfInkAnnotation[] {
  // Assume ~8.5x11 page proportions when mapping signature aspectRatio to normalized height
  const pageAspect = 612 / 792;
  const boxHeightNorm = clamp((boxWidthNorm * pageAspect) / Math.max(1.2, sig.aspectRatio), 0.03, 0.14);
  const left = clamp(centerX - boxWidthNorm / 2, 0.02, 0.98 - boxWidthNorm);
  const top = clamp(centerY - boxHeightNorm / 2, 0.02, 0.98 - boxHeightNorm);

  return sig.strokes
    .filter((s) => s.length >= 2)
    .map((stroke) => ({
      id: uid('ann'),
      type: 'ink' as const,
      pageIndex,
      color: sig.color,
      strokeWidth: sig.strokeWidth,
      points: stroke.map((pt) => ({
        x: clamp(left + pt.x * boxWidthNorm, 0, 1),
        y: clamp(top + pt.y * boxHeightNorm, 0, 1),
      })),
    }));
}
