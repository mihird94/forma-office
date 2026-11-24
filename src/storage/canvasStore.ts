import { CanvasData } from '../types/canvas';

export const CANVASES_KEY = 'forma_office_canvases_v1';

export function loadCanvases(): CanvasData[] {
  try {
    const raw = localStorage.getItem(CANVASES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as CanvasData[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // ignore storage parse failures
  }
  return [];
}

export function saveCanvases(canvases: CanvasData[]): void {
  try {
    localStorage.setItem(CANVASES_KEY, JSON.stringify(canvases));
  } catch {
    // quota fallback
  }
}
