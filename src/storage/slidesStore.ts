import { PresentationData } from '../types/slides';

export const SLIDES_KEY = 'forma_office_slides_v1';

export function loadPresentations(): PresentationData[] {
  try {
    const raw = localStorage.getItem(SLIDES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PresentationData[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // ignore
  }
  return [];
}

export function savePresentations(decks: PresentationData[]): void {
  try {
    localStorage.setItem(SLIDES_KEY, JSON.stringify(decks));
  } catch {
    // quota fallback
  }
}
