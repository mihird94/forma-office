import React, { useState } from 'react';
import {
  AlertTriangle,
  AppWindow,
  CheckCircle2,
  Copy,
  FileBadge2,
  FileSpreadsheet,
  FileText,
  FlaskConical,
  Home,
  Pencil,
  PenTool,
  Plus,
  Presentation,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { SaveState } from '../../storage/recordStore';
import { StandaloneAppKind, WorkspaceFileKind } from '../../types/office';
import { ContextMenu, ContextMenuItem } from './ContextMenu';

export interface OpenTabItem {
  id: string;
  kind: WorkspaceFileKind;
  title: string;
}

interface AppHeaderProps {
  saveState: SaveState;
  storageNotice?: { label: string; tone: 'amber' | 'rose'; onRetry?: () => void } | null;
  onRetrySave: () => void;
  standaloneKind?: StandaloneAppKind;
  showingHub: boolean;
  openTabs: OpenTabItem[];
  activeTabId: string | null;
  onShowHub: () => void;
  onSelectTab: (id: string, kind: WorkspaceFileKind) => void;
  onCloseTab: (id: string) => void;
  onCloseOtherTabs: (keepId: string) => void;
  onRenameTab: (id: string, kind: WorkspaceFileKind, nextTitle: string) => void;
  onDuplicateTab: (id: string, kind: WorkspaceFileKind) => void;
  onOpenTabInNewWindow: (id?: string) => void;
  onCreateBlank: (kind: WorkspaceFileKind) => void;
  onOpenCommandPalette?: () => void;
  onToggleCopilot?: () => void;
  copilotOpen?: boolean;
}

export const AppHeader: React.FC<AppHeaderProps> = ({
  saveState,
  storageNotice,
  onRetrySave,
  standaloneKind,
  showingHub,
  openTabs,
  activeTabId,
  onShowHub,
  onSelectTab,
  onCloseTab,
  onCloseOtherTabs,
  onRenameTab,
  onDuplicateTab,
  onOpenTabInNewWindow,
  onCreateBlank,
  onOpenCommandPalette,
  onToggleCopilot,
  copilotOpen = false,
}) => {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [tabMenu, setTabMenu] = useState<{
    x: number;
    y: number;
    tab: OpenTabItem;
  } | null>(null);

  const isSheetsOnly = standaloneKind === 'sheets';
  const isDocsOnly = standaloneKind === 'docs';
  const isSlidesOnly = standaloneKind === 'slides';
  const isPdfOnly = standaloneKind === 'pdf';
  const isLabOnly = standaloneKind === 'lab';
  const isCanvasOnly = standaloneKind === 'canvas';
  const isStandalone = isSheetsOnly || isDocsOnly || isSlidesOnly || isPdfOnly || isLabOnly || isCanvasOnly;

  const commitRename = (tab: OpenTabItem) => {
    const trimmed = draftTitle.trim();
    if (trimmed && trimmed !== tab.title) {
      onRenameTab(tab.id, tab.kind, trimmed);
    }
    setRenamingId(null);
  };

  const buildTabContextItems = (tab: OpenTabItem): ContextMenuItem[] => [
    {
      id: 'rename',
      label: 'Rename',
      icon: <Pencil className="w-3.5 h-3.5" />,
      onClick: () => {
        setRenamingId(tab.id);
        setDraftTitle(tab.title);
      },
    },
    {
      id: 'duplicate',
      label: 'Duplicate File',
      icon: <Copy className="w-3.5 h-3.5" />,
      onClick: () => onDuplicateTab(tab.id, tab.kind),
    },
    {
      id: 'new-win',
      label: 'Open in New Window',
      shortcut: '⇧⌘N',
      icon: <AppWindow className="w-3.5 h-3.5" />,
      onClick: () => onOpenTabInNewWindow(tab.id),
    },
    { id: 'div', divider: true },
    {
      id: 'close',
      label: 'Close Tab',
      shortcut: '⌘W',
      icon: <X className="w-3.5 h-3.5" />,
      onClick: () => onCloseTab(tab.id),
    },
    {
      id: 'close-others',
      label: 'Close Other Tabs',
      disabled: openTabs.length <= 1,
      onClick: () => onCloseOtherTabs(tab.id),
    },
  ];

  const defaultNewKind: WorkspaceFileKind = isCanvasOnly
    ? 'canvas'
    : isPdfOnly
      ? 'pdf'
      : isLabOnly
        ? 'notebook'
        : isSlidesOnly
          ? 'slides'
          : isDocsOnly
            ? 'document'
            : 'spreadsheet';

  return (
    <header className="no-print h-11 bg-slate-900 text-white px-2 flex items-center gap-1.5 shrink-0 select-none border-b border-slate-800">
      {/* Left: Backstage Home Button */}
      <button
        onClick={onShowHub}
        title="Start Hub — Templates & Recent Files"
        className={`h-8 px-2.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition shrink-0 ${
          showingHub
            ? isCanvasOnly
              ? 'bg-cyan-600 text-white shadow-xs'
              : isPdfOnly
                ? 'bg-rose-600 text-white shadow-xs'
                : isLabOnly
                  ? 'bg-violet-600 text-white shadow-xs'
                  : isSlidesOnly
                    ? 'bg-amber-600 text-white shadow-xs'
                    : isDocsOnly
                      ? 'bg-blue-600 text-white shadow-xs'
                      : 'bg-emerald-600 text-white shadow-xs'
            : 'bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white'
        }`}
      >
        <Home className="w-3.5 h-3.5" />
        <span>Hub</span>
      </button>

      <div className="h-5 w-px bg-slate-700/80 mx-0.5 shrink-0" />

      {/* Center: Multi-File Open Tabs Strip */}
      <div className="flex-1 flex items-center gap-1 overflow-x-auto min-w-0 py-1">
        {openTabs.map((tab) => {
          const isActive = !showingHub && tab.id === activeTabId;
          const isEditing = renamingId === tab.id;

          const activeBorder =
            tab.kind === 'canvas'
              ? 'border-cyan-500/75'
              : tab.kind === 'pdf'
                ? 'border-rose-500/75'
                : tab.kind === 'notebook'
                  ? 'border-violet-500/75'
                  : tab.kind === 'slides'
                    ? 'border-amber-500/75'
                    : tab.kind === 'document'
                      ? 'border-blue-500/75'
                      : 'border-emerald-500/75';

          return (
            <div
              key={tab.id}
              onClick={() => onSelectTab(tab.id, tab.kind)}
              onDoubleClick={() => {
                setRenamingId(tab.id);
                setDraftTitle(tab.title);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setTabMenu({ x: e.clientX, y: e.clientY, tab });
              }}
              title={`${tab.title} — Double-click to rename, right-click for options`}
              className={`group h-8 max-w-[220px] min-w-[115px] px-2.5 rounded-lg flex items-center gap-1.5 text-xs cursor-pointer border transition shrink-0 ${
                isActive
                  ? `bg-slate-800 text-white ${activeBorder} shadow-xs`
                  : 'bg-slate-900/60 text-slate-400 border-transparent hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              {tab.kind === 'spreadsheet' && (
                <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              )}
              {tab.kind === 'document' && (
                <FileText className="w-3.5 h-3.5 text-blue-400 shrink-0" />
              )}
              {tab.kind === 'slides' && (
                <Presentation className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              )}
              {tab.kind === 'notebook' && (
                <FlaskConical className="w-3.5 h-3.5 text-violet-400 shrink-0" />
              )}
              {tab.kind === 'pdf' && (
                <FileBadge2 className="w-3.5 h-3.5 text-rose-400 shrink-0" />
              )}
              {tab.kind === 'canvas' && (
                <PenTool className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
              )}

              {isEditing ? (
                <input
                  autoFocus
                  value={draftTitle}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onBlur={() => commitRename(tab)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(tab);
                    else if (e.key === 'Escape') setRenamingId(null);
                  }}
                  className="w-full bg-slate-950 text-white text-xs px-1 py-0.5 rounded border border-slate-500 focus:outline-none"
                />
              ) : (
                <span className="truncate font-medium flex-1">{tab.title}</span>
              )}

              <button
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
                className="p-0.5 rounded hover:bg-slate-700 text-slate-500 hover:text-white opacity-70 group-hover:opacity-100 shrink-0"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        })}

        {/* Quick "+" New Tab button: opens PDF file dialog in Forma PDF, blank Sheet/Doc otherwise */}
        <button
          onClick={() => onCreateBlank(defaultNewKind)}
          title={
            isCanvasOnly
              ? 'New Blank Canvas (⌘N)'
              : isPdfOnly
                ? 'Open PDF File… (⌘O)'
                : isLabOnly
                  ? 'New Blank Notebook (⌘N)'
                  : isSlidesOnly
                    ? 'New Blank Presentation (⌘N)'
                    : isDocsOnly
                      ? 'New Blank Document (⌘N)'
                      : 'New Blank Workbook (⌘N)'
          }
          className="h-7 w-7 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 flex items-center justify-center transition shrink-0"
        >
          <Plus className="w-4 h-4" />
        </button>

        {!isStandalone && (
          <>
            <button
              onClick={() => onCreateBlank('document')}
              title="New Blank Document"
              className="h-7 px-2 rounded-lg text-[11px] font-medium text-blue-300 bg-blue-500/15 hover:bg-blue-500/25 flex items-center gap-1 transition shrink-0"
            >
              <Plus className="w-3 h-3" />
              <span>Doc</span>
            </button>
            <button
              onClick={() => onCreateBlank('slides')}
              title="New Blank Presentation"
              className="h-7 px-2 rounded-lg text-[11px] font-medium text-amber-300 bg-amber-500/15 hover:bg-amber-500/25 flex items-center gap-1 transition shrink-0"
            >
              <Plus className="w-3 h-3" />
              <span>Slides</span>
            </button>
            <button
              onClick={() => onCreateBlank('notebook')}
              title="New Blank Notebook"
              className="h-7 px-2 rounded-lg text-[11px] font-medium text-violet-300 bg-violet-500/15 hover:bg-violet-500/25 flex items-center gap-1 transition shrink-0"
            >
              <Plus className="w-3 h-3" />
              <span>Lab</span>
            </button>
            <button
              onClick={() => onCreateBlank('pdf')}
              title="Open PDF"
              className="h-7 px-2 rounded-lg text-[11px] font-medium text-rose-300 bg-rose-500/15 hover:bg-rose-500/25 flex items-center gap-1 transition shrink-0"
            >
              <Plus className="w-3 h-3" />
              <span>PDF</span>
            </button>
            <button
              onClick={() => onCreateBlank('canvas')}
              title="New Blank Canvas"
              className="h-7 px-2 rounded-lg text-[11px] font-medium text-cyan-300 bg-cyan-500/15 hover:bg-cyan-500/25 flex items-center gap-1 transition shrink-0"
            >
              <Plus className="w-3 h-3" />
              <span>Canvas</span>
            </button>
          </>
        )}
      </div>

      {/* Right: Command Palette, Local AI, Auto-Save Badge + New Window */}
      <div className="flex items-center gap-1.5 shrink-0 pl-1">
        {onOpenCommandPalette && (
          <button
            onClick={onOpenCommandPalette}
            title="Command Palette & Semantic Search across all docs (⌘K)"
            className="h-7 px-2 rounded-lg text-xs text-slate-300 bg-slate-800/80 hover:text-white hover:bg-slate-700 border border-slate-700/80 flex items-center gap-1.5 transition"
          >
            <Search className="w-3.5 h-3.5 text-sky-400" />
            <span className="hidden lg:inline">Search</span>
            <kbd className="text-[10px] font-mono text-slate-400 bg-slate-900/80 px-1 rounded">⌘K</kbd>
          </button>
        )}
        {onToggleCopilot && (
          <button
            onClick={onToggleCopilot}
            title="Local Ollama AI Copilot (⌘J)"
            className={`h-7 px-2 rounded-lg text-xs flex items-center gap-1 transition border ${
              copilotOpen
                ? 'bg-violet-600 text-white border-violet-500'
                : 'text-slate-300 bg-slate-800/80 hover:text-white hover:bg-slate-700 border-slate-700/80'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span className="hidden xl:inline">AI</span>
          </button>
        )}
        {!showingHub && activeTabId && (
          storageNotice ? (
            <span
              role="status"
              title={storageNotice.label}
              className={`hidden md:flex items-center gap-1 text-[11px] ${
                storageNotice.tone === 'rose' ? 'text-rose-400' : 'text-amber-300'
              }`}
            >
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>{storageNotice.label}</span>
              {storageNotice.onRetry && (
                <button onClick={storageNotice.onRetry} className="underline ml-0.5">Retry</button>
              )}
            </span>
          ) : (
            <span
              role="status"
              title="Changes are stored in the Forma workspace. Use Save or Export to write a disk file."
              className={`hidden md:flex items-center gap-1 text-[11px] ${
                saveState === 'error' ? 'text-rose-400' : saveState === 'saving' ? 'text-amber-300' : 'text-emerald-400'
              }`}
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>{saveState === 'saved' ? 'Workspace saved' : saveState === 'saving' ? 'Saving…' : 'Save failed'}</span>
              {saveState === 'error' && <button onClick={onRetrySave} className="underline">Retry</button>}
            </span>
          )
        )}
        <button
          onClick={() => onOpenTabInNewWindow(showingHub ? undefined : activeTabId ?? undefined)}
          title="Open New Window (⇧⌘N)"
          className="h-7 px-2 rounded-lg text-xs text-slate-300 hover:text-white hover:bg-slate-800 flex items-center gap-1 transition"
        >
          <AppWindow className="w-3.5 h-3.5" />
          <span className="hidden lg:inline">New Window</span>
        </button>
      </div>

      {tabMenu && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          items={buildTabContextItems(tabMenu.tab)}
          onClose={() => setTabMenu(null)}
        />
      )}
    </header>
  );
};
