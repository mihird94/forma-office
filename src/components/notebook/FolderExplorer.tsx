import React, { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FileCode2,
  FilePlus2,
  FileText,
  FlaskConical,
  Folder,
  FolderOpen,
  RefreshCw,
  Search,
} from 'lucide-react';
import { LabFolderWorkspace, WorkspaceTreeNode } from '../../types/notebook';

interface FolderExplorerProps {
  workspace: LabFolderWorkspace | null;
  activeNativePath?: string;
  onPickFolder: () => void;
  onRefreshFolder: () => void;
  onOpenNotebookPath: (path: string) => void;
  onPreviewTextFile: (path: string, name: string) => void;
  onCreateNotebookInDir: (dirPath: string) => void;
  onCopyRelativePath: (relPath: string) => void;
}

function filterTree(nodes: WorkspaceTreeNode[], query: string): WorkspaceTreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  const out: WorkspaceTreeNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'dir') {
      const filteredChildren = filterTree(node.children ?? [], q);
      if (node.name.toLowerCase().includes(q) || filteredChildren.length > 0) {
        out.push({ ...node, children: filteredChildren });
      }
    } else if (node.name.toLowerCase().includes(q)) {
      out.push(node);
    }
  }
  return out;
}

const PREVIEWABLE_EXTS = new Set([
  'py',
  'md',
  'markdown',
  'txt',
  'json',
  'csv',
  'tsv',
  'yaml',
  'yml',
  'toml',
  'cfg',
  'ini',
  'sh',
]);

export const FolderExplorer: React.FC<FolderExplorerProps> = ({
  workspace,
  activeNativePath,
  onPickFolder,
  onRefreshFolder,
  onOpenNotebookPath,
  onPreviewTextFile,
  onCreateNotebookInDir,
  onCopyRelativePath,
}) => {
  const [filter, setFilter] = useState('');
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());

  const filteredNodes = useMemo(
    () => (workspace ? filterTree(workspace.entries, filter) : []),
    [workspace, filter]
  );

  if (!workspace) {
    return (
      <div className="px-2 py-6 text-center space-y-3">
        <div className="w-10 h-10 mx-auto rounded-xl bg-violet-100 text-violet-700 flex items-center justify-center">
          <FolderOpen className="w-5 h-5" />
        </div>
        <div className="space-y-1">
          <div className="text-xs font-semibold text-slate-800">Open a Study or Repo Folder</div>
          <div className="text-[11px] text-slate-500 leading-relaxed">
            Browse all <code className="font-mono text-violet-700">.ipynb</code> notebooks &amp; helper{' '}
            <code className="font-mono">.py</code> files. Python automatically runs with the folder as its working directory.
          </div>
        </div>
        <button
          onClick={onPickFolder}
          className="w-full py-2 px-3 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold flex items-center justify-center gap-1.5 shadow-xs transition"
        >
          <FolderOpen className="w-3.5 h-3.5" />
          <span>Open Folder… (⇧⌘O)</span>
        </button>
      </div>
    );
  }

  const toggleDir = (dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  };

  const getRelPath = (fullPath: string) => {
    const prefix = workspace.rootPath.endsWith('/') ? workspace.rootPath : `${workspace.rootPath}/`;
    return fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath;
  };

  const renderNodes = (nodes: WorkspaceTreeNode[], depth = 0): React.ReactNode =>
    nodes.map((node) => {
      if (node.kind === 'dir') {
        const isOpen = filter.trim().length > 0 || expandedDirs.has(node.path);
        return (
          <div key={node.path}>
            <div
              onClick={() => toggleDir(node.path)}
              style={{ paddingLeft: `${depth * 12 + 6}px` }}
              className="group flex items-center justify-between gap-1 py-1 pr-1.5 rounded-md text-xs text-slate-700 hover:bg-slate-100 cursor-pointer select-none"
            >
              <div className="flex items-center gap-1.5 min-w-0">
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
              </div>
              <button
                title={`New .ipynb inside ${node.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onCreateNotebookInDir(node.path);
                }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-violet-100 text-violet-700 transition"
              >
                <FilePlus2 className="w-3 h-3" />
              </button>
            </div>
            {isOpen && node.children && node.children.length > 0 && (
              <div>{renderNodes(node.children, depth + 1)}</div>
            )}
          </div>
        );
      }

      const isNotebook = node.ext === 'ipynb';
      const isPy = node.ext === 'py';
      const isActive = activeNativePath === node.path;
      const canPreview = node.ext ? PREVIEWABLE_EXTS.has(node.ext) : false;

      return (
        <div
          key={node.path}
          onClick={() => {
            if (isNotebook) onOpenNotebookPath(node.path);
            else if (canPreview) onPreviewTextFile(node.path, node.name);
            else onCopyRelativePath(getRelPath(node.path));
          }}
          style={{ paddingLeft: `${depth * 12 + 20}px` }}
          title={node.path}
          className={`group flex items-center justify-between gap-1 py-1 pr-1.5 rounded-md text-xs cursor-pointer transition ${
            isActive
              ? 'bg-violet-100 text-violet-900 font-semibold'
              : isNotebook
                ? 'text-slate-800 hover:bg-violet-50 hover:text-violet-900 font-medium'
                : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
          }`}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            {isNotebook ? (
              <FlaskConical className="w-3.5 h-3.5 text-violet-600 shrink-0" />
            ) : isPy ? (
              <FileCode2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
            ) : (
              <FileText className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            )}
            <span className="truncate">{node.name}</span>
          </div>
          <button
            title="Copy relative path for Python"
            onClick={(e) => {
              e.stopPropagation();
              onCopyRelativePath(getRelPath(node.path));
            }}
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-slate-200/80 text-slate-500 shrink-0 transition"
          >
            <Copy className="w-3 h-3" />
          </button>
        </div>
      );
    });

  return (
    <div className="flex flex-col h-full gap-2">
      {/* Folder Header Bar */}
      <div className="flex items-center justify-between gap-1 px-1">
        <div className="min-w-0 flex items-center gap-1.5" title={workspace.rootPath}>
          <FolderOpen className="w-3.5 h-3.5 text-violet-600 shrink-0" />
          <span className="text-xs font-bold text-slate-800 truncate">{workspace.rootName}</span>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            title="New Notebook (.ipynb) in this folder"
            onClick={() => onCreateNotebookInDir(workspace.rootPath)}
            className="p-1 rounded hover:bg-violet-100 text-violet-700 transition"
          >
            <FilePlus2 className="w-3.5 h-3.5" />
          </button>
          <button
            title="Refresh Folder Tree"
            onClick={onRefreshFolder}
            className="p-1 rounded hover:bg-slate-200/70 text-slate-600 transition"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            title="Switch Folder… (⇧⌘O)"
            onClick={onPickFolder}
            className="p-1 rounded hover:bg-slate-200/70 text-slate-600 transition"
          >
            <FolderOpen className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Quick Filter */}
      <div className="relative">
        <Search className="w-3 h-3 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter files…"
          className="w-full pl-6 pr-2 py-1 text-[11px] bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-violet-400"
        />
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto space-y-0.5 pr-0.5">
        {filteredNodes.length > 0 ? (
          renderNodes(filteredNodes)
        ) : (
          <div className="text-[11px] text-slate-400 text-center py-6">
            {filter ? 'No matching files' : 'Empty folder'}
          </div>
        )}
      </div>
    </div>
  );
};
