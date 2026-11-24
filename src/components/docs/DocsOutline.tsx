import React, { useMemo, useState } from 'react';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Link2,
  Search,
} from 'lucide-react';
import { DocumentPageSettings, OutlineHeading } from '../../types/document';
import { LabFolderWorkspace, WorkspaceTreeNode } from '../../types/notebook';

const DOC_FOLDER_EXTS = new Set(['md', 'markdown', 'txt', 'docx', 'html', 'htm']);

function filterDocTree(nodes: WorkspaceTreeNode[], query: string): WorkspaceTreeNode[] {
  const q = query.trim().toLowerCase();
  const out: WorkspaceTreeNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'dir') {
      const children = filterDocTree(node.children ?? [], q);
      if (children.length > 0) {
        out.push({ ...node, children });
      }
    } else {
      const ext = (node.ext ?? node.name.split('.').pop() ?? '').toLowerCase();
      if (!DOC_FOLDER_EXTS.has(ext)) continue;
      if (!q || node.name.toLowerCase().includes(q)) {
        out.push(node);
      }
    }
  }
  return out;
}

interface DocsOutlineProps {
  headings: OutlineHeading[];
  pageSettings: DocumentPageSettings;
  wordCount: number;
  charCount: number;
  onJumpToPos: (pos: number) => void;
  onUpdatePageSettings: (patch: Partial<DocumentPageSettings>) => void;
  docsFolder?: LabFolderWorkspace | null;
  activeNativePath?: string;
  sidebarTab?: 'outline' | 'folder';
  onChangeSidebarTab?: (tab: 'outline' | 'folder') => void;
  onPickDocsFolder?: () => void;
  onOpenFolderDoc?: (path: string) => void;
  wikilinks?: string[];
  onOpenWikilink?: (title: string) => void;
}

export const DocsOutline: React.FC<DocsOutlineProps> = ({
  headings,
  pageSettings,
  wordCount,
  charCount,
  onJumpToPos,
  onUpdatePageSettings,
  docsFolder,
  activeNativePath,
  sidebarTab = 'outline',
  onChangeSidebarTab,
  onPickDocsFolder,
  onOpenFolderDoc,
  wikilinks = [],
  onOpenWikilink,
}) => {
  const readingMins = Math.max(1, Math.ceil(wordCount / 220));
  const [folderQuery, setFolderQuery] = useState('');
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());

  const showFolderTabToggle = Boolean(docsFolder || onPickDocsFolder || sidebarTab === 'folder');
  const activeTab: 'outline' | 'folder' = showFolderTabToggle ? sidebarTab : 'outline';

  const filteredTree = useMemo(
    () => (docsFolder ? filterDocTree(docsFolder.entries, folderQuery) : []),
    [docsFolder, folderQuery]
  );

  const toggleDir = (dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  };

  const renderTreeNodes = (nodes: WorkspaceTreeNode[], depth = 0): React.ReactNode =>
    nodes.map((node) => {
      if (node.kind === 'dir') {
        const isOpen = folderQuery.trim().length > 0 || expandedDirs.has(node.path);
        return (
          <div key={node.path}>
            <button
              type="button"
              onClick={() => toggleDir(node.path)}
              style={{ paddingLeft: `${depth * 12 + 6}px` }}
              className="w-full flex items-center gap-1.5 py-1 pr-2 rounded-md text-xs text-slate-700 hover:bg-slate-100 transition text-left"
            >
              {isOpen ? (
                <ChevronDown className="w-3 h-3 text-slate-400 shrink-0" />
              ) : (
                <ChevronRight className="w-3 h-3 text-slate-400 shrink-0" />
              )}
              {isOpen ? (
                <FolderOpen className="w-3.5 h-3.5 text-amber-500 shrink-0" />
              ) : (
                <Folder className="w-3.5 h-3.5 text-amber-500 shrink-0" />
              )}
              <span className="truncate font-medium">{node.name}</span>
            </button>
            {isOpen && node.children && node.children.length > 0 && (
              <div>{renderTreeNodes(node.children, depth + 1)}</div>
            )}
          </div>
        );
      }

      const ext = (node.ext ?? node.name.split('.').pop() ?? '').toLowerCase();
      const isMd = ext === 'md' || ext === 'markdown';
      const isActive = Boolean(activeNativePath && activeNativePath === node.path);
      return (
        <button
          key={node.path}
          type="button"
          onClick={() => onOpenFolderDoc?.(node.path)}
          style={{ paddingLeft: `${depth * 12 + 20}px` }}
          title={node.path}
          className={`w-full flex items-center gap-1.5 py-1.5 pr-2 rounded-md text-xs transition text-left ${
            isActive
              ? 'bg-blue-50 text-blue-700 font-semibold'
              : 'text-slate-700 hover:bg-slate-100'
          }`}
        >
          {isMd ? (
            <FileCode2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
          ) : (
            <FileText className="w-3.5 h-3.5 text-blue-500 shrink-0" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
      );
    });

  return (
    <aside className="no-print w-64 bg-white border-r border-slate-200 flex flex-col shrink-0">
      {/* Sidebar Header / Mode Switcher */}
      <div className="px-3 py-2.5 border-b border-slate-100 flex items-center justify-between gap-2">
        {showFolderTabToggle ? (
          <div className="flex-1 flex items-center bg-slate-100 rounded-lg p-0.5 text-[11px] font-medium">
            <button
              type="button"
              onClick={() => onChangeSidebarTab?.('outline')}
              className={`flex-1 py-1 px-2 rounded-md flex items-center justify-center gap-1 transition ${
                activeTab === 'outline'
                  ? 'bg-white text-blue-700 shadow-2xs font-semibold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <BookOpen className="w-3 h-3" />
              <span>Outline</span>
            </button>
            <button
              type="button"
              onClick={() => onChangeSidebarTab?.('folder')}
              className={`flex-1 py-1 px-2 rounded-md flex items-center justify-center gap-1 transition ${
                activeTab === 'folder'
                  ? 'bg-white text-blue-700 shadow-2xs font-semibold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <FolderOpen className="w-3 h-3" />
              <span>Folder</span>
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 px-1">
            <BookOpen className="w-4 h-4 text-blue-600" />
            <span className="text-xs font-semibold text-slate-800">Document Outline</span>
          </div>
        )}
      </div>

      {/* Main Scroll Area: Outline or Folder Tree */}
      {activeTab === 'folder' ? (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {!docsFolder ? (
            <div className="p-4 text-center space-y-3 my-auto">
              <div className="w-9 h-9 mx-auto rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center">
                <FolderOpen className="w-4 h-4" />
              </div>
              <div className="space-y-1">
                <div className="text-xs font-semibold text-slate-800">Markdown Notes Folder</div>
                <div className="text-[11px] text-slate-500 leading-relaxed">
                  Open a local folder to browse and open{' '}
                  <code className="font-mono text-blue-700">.md</code>,{' '}
                  <code className="font-mono">.txt</code>,{' '}
                  <code className="font-mono">.docx</code> &amp;{' '}
                  <code className="font-mono">.html</code> docs in one click.
                </div>
              </div>
              {onPickDocsFolder && (
                <button
                  type="button"
                  onClick={onPickDocsFolder}
                  className="w-full py-1.5 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  <span>Open Folder…</span>
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="px-3 py-2 border-b border-slate-100 space-y-1.5 bg-slate-50/60">
                <div className="flex items-center justify-between gap-1.5">
                  <span
                    className="text-[11px] font-semibold text-slate-700 truncate flex items-center gap-1"
                    title={docsFolder.rootPath}
                  >
                    <FolderOpen className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                    <span className="truncate">{docsFolder.rootName}</span>
                  </span>
                  {onPickDocsFolder && (
                    <button
                      type="button"
                      onClick={onPickDocsFolder}
                      className="text-[10px] font-medium text-blue-600 hover:text-blue-800 shrink-0"
                    >
                      Switch
                    </button>
                  )}
                </div>
                <div className="relative">
                  <Search className="w-3 h-3 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    aria-label="Filter folder documents"
                    value={folderQuery}
                    onChange={(e) => setFolderQuery(e.target.value)}
                    placeholder="Filter notes…"
                    className="w-full h-6 pl-6 pr-2 text-[11px] bg-white border border-slate-200 rounded text-slate-700 focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
                {filteredTree.length === 0 ? (
                  <div className="text-[11px] text-slate-400 px-2 py-4 text-center">
                    No matching Markdown or document files found.
                  </div>
                ) : (
                  renderTreeNodes(filteredTree)
                )}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          <div className="space-y-0.5">
            {headings.length === 0 ? (
              <div className="text-xs text-slate-400 px-1 py-4">
                Add Heading 1–3 styles to build an interactive outline.
              </div>
            ) : (
              headings.map((h) => (
                <button
                  key={h.id}
                  onClick={() => onJumpToPos(h.pos)}
                  style={{ paddingLeft: `${(h.level - 1) * 12 + 8}px` }}
                  className={`w-full text-left py-1.5 pr-2 rounded-md text-xs truncate transition hover:bg-blue-50 hover:text-blue-700 ${
                    h.level === 1
                      ? 'font-semibold text-slate-800'
                      : h.level === 2
                        ? 'font-medium text-slate-700'
                        : 'text-slate-500'
                  }`}
                  title={h.text}
                >
                  {h.text}
                </button>
              ))
            )}
          </div>

          {wikilinks.length > 0 && (
            <div className="pt-2.5 border-t border-slate-100 space-y-1.5">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600 px-1">
                <Link2 className="w-3 h-3 text-blue-600" />
                <span>Wikilinks ({wikilinks.length})</span>
              </div>
              <div className="flex flex-wrap gap-1 px-0.5">
                {wikilinks.map((title) => (
                  <button
                    key={title}
                    type="button"
                    onClick={() => onOpenWikilink?.(title)}
                    title={`Open [[${title}]]`}
                    className="px-2 py-0.5 rounded-full bg-blue-50 hover:bg-blue-100 border border-blue-200/80 text-[11px] font-medium text-blue-700 max-w-full truncate transition"
                  >
                    [[{title}]]
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Page Setup Controls */}
      <div className="p-3.5 border-t border-slate-200 bg-slate-50/70 space-y-2.5 text-xs">
        <div className="flex items-center gap-1.5 font-semibold text-slate-700">
          <FileText className="w-3.5 h-3.5 text-slate-500" />
          <span>Page Layout</span>
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          {(['letter', 'a4'] as const).map((sz) => (
            <button
              key={sz}
              onClick={() => onUpdatePageSettings({ pageSize: sz })}
              className={`py-1 rounded border text-[11px] font-medium transition ${
                pageSettings.pageSize === sz
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100'
              }`}
            >
              {sz === 'letter' ? 'US Letter' : 'ISO A4'}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-3 gap-1">
          {(['narrow', 'normal', 'wide'] as const).map((m) => (
            <button
              key={m}
              onClick={() => onUpdatePageSettings({ margins: m })}
              className={`py-1 rounded border text-[10px] capitalize font-medium transition ${
                pageSettings.margins === m
                  ? 'bg-blue-50 text-blue-700 border-blue-300'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100'
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        {/* Header, Footer & Page Numbers */}
        <div className="pt-2 border-t border-slate-200/80 space-y-1.5">
          <label className="block space-y-0.5">
            <span className="text-[10px] font-medium text-slate-500">Header Text</span>
            <input
              type="text"
              aria-label="Header Text"
              value={pageSettings.headerText ?? ''}
              onChange={(e) => onUpdatePageSettings({ headerText: e.target.value })}
              placeholder="e.g. Confidential · Q4 Brief"
              className="w-full h-6 px-2 text-[11px] bg-white border border-slate-200 rounded text-slate-700 placeholder:text-slate-400 focus:outline-none focus:border-blue-500"
            />
          </label>
          <label className="block space-y-0.5">
            <span className="text-[10px] font-medium text-slate-500">Footer Text</span>
            <input
              type="text"
              aria-label="Footer Text"
              value={pageSettings.footerText ?? ''}
              onChange={(e) => onUpdatePageSettings({ footerText: e.target.value })}
              placeholder="e.g. Forma Office"
              className="w-full h-6 px-2 text-[11px] bg-white border border-slate-200 rounded text-slate-700 placeholder:text-slate-400 focus:outline-none focus:border-blue-500"
            />
          </label>
          <label className="flex items-center justify-between pt-0.5 cursor-pointer select-none">
            <span className="text-[11px] text-slate-600 font-medium">Show Page Numbers</span>
            <input
              type="checkbox"
              aria-label="Show Page Numbers"
              checked={Boolean(pageSettings.showPageNumbers)}
              onChange={(e) => onUpdatePageSettings({ showPageNumbers: e.target.checked })}
              className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            />
          </label>
        </div>

        <div className="pt-2 border-t border-slate-200 text-[11px] text-slate-500 space-y-0.5">
          <div className="flex justify-between">
            <span>Words</span>
            <strong className="text-slate-700 font-mono">{wordCount.toLocaleString()}</strong>
          </div>
          <div className="flex justify-between">
            <span>Characters</span>
            <strong className="text-slate-700 font-mono">{charCount.toLocaleString()}</strong>
          </div>
          <div className="flex justify-between">
            <span>Read time</span>
            <strong className="text-slate-700 font-mono">~{readingMins} min</strong>
          </div>
        </div>
      </div>
    </aside>
  );
};
