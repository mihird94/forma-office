import { WorkspaceFileKind } from '../types/office';

export interface SavedTabRef {
  id: string;
  kind: WorkspaceFileKind;
}

export interface WorkspaceSession {
  openTabs: SavedTabRef[];
  activeTabId: string | null;
  showingHub: boolean;
}

export interface FileViewPosition {
  pdfPage?: number;
  slideIndex?: number;
  sheetId?: string;
  cellRow?: number;
  cellCol?: number;
  docsViewMode?: 'preview' | 'markdown' | 'split';
}

const SESSION_PREFIX = 'forma_session_v1_';
const POSITIONS_KEY = 'forma_file_positions_v1';

export function loadWorkspaceSession(scope: string): WorkspaceSession | null {
  try {
    const raw = localStorage.getItem(`${SESSION_PREFIX}${scope}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WorkspaceSession>;
    if (!Array.isArray(parsed.openTabs)) return null;
    return {
      openTabs: parsed.openTabs.filter(
        (t): t is SavedTabRef =>
          Boolean(t && typeof t.id === 'string' && typeof t.kind === 'string')
      ),
      activeTabId: typeof parsed.activeTabId === 'string' ? parsed.activeTabId : null,
      showingHub: typeof parsed.showingHub === 'boolean' ? parsed.showingHub : true,
    };
  } catch {
    return null;
  }
}

export function saveWorkspaceSession(scope: string, session: WorkspaceSession): void {
  try {
    localStorage.setItem(`${SESSION_PREFIX}${scope}`, JSON.stringify(session));
  } catch {
    // ignore quota errors
  }
}

function loadAllPositions(): Record<string, FileViewPosition> {
  try {
    const raw = localStorage.getItem(POSITIONS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, FileViewPosition>) : {};
  } catch {
    return {};
  }
}

export function loadFilePosition(id: string): FileViewPosition | null {
  const all = loadAllPositions();
  return all[id] ?? null;
}

export function saveFilePosition(id: string, patch: Partial<FileViewPosition>): void {
  try {
    const all = loadAllPositions();
    all[id] = { ...(all[id] ?? {}), ...patch };
    // Keep map bounded to latest 150 files
    const keys = Object.keys(all);
    if (keys.length > 150) {
      for (const k of keys.slice(0, keys.length - 150)) delete all[k];
    }
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(all));
  } catch {
    // ignore
  }
}
