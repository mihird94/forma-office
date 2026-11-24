import React, { useMemo, useState } from 'react';
import {
  AppWindow,
  Clock,
  Copy,
  Download,
  ExternalLink,
  FileBadge2,
  FileSpreadsheet,
  FileText,
  FlaskConical,
  FolderOpen,
  FolderSearch,
  Home,
  Layers,
  MoreHorizontal,
  PenTool,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Presentation,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { StandaloneAppKind, WorkspaceFileKind, WorkspaceFileSummary } from '../../types/office';
import { SHEET_TEMPLATES, SheetTemplateId } from '../../engine/spreadsheet/templates';
import { DOC_TEMPLATES, DocTemplateId } from '../../engine/document/sampleDocs';
import { SLIDE_TEMPLATES, SlideTemplateId } from '../../engine/slides/slideTemplates';
import { NOTEBOOK_TEMPLATES, NotebookTemplateId } from '../../engine/notebook/notebookTemplates';
import { CANVAS_TEMPLATES } from '../../engine/canvas/canvasTemplates';
import { CanvasTemplateId } from '../../types/canvas';
import { LabFolderWorkspace } from '../../types/notebook';
import { countNotebooksInTree } from '../../storage/notebookStore';
import { openNativeFileDialog } from '../../storage/workspaceStore';
import { ContextMenu, ContextMenuItem } from './ContextMenu';

interface HomeHubProps {
  standaloneKind?: StandaloneAppKind;
  files: WorkspaceFileSummary[];
  openFileIds: string[];
  onOpenFile: (id: string, kind: WorkspaceFileKind) => void;
  onOpenInNewWindow: (id?: string) => void;
  onCreateSheetTemplate: (templateId: SheetTemplateId) => void;
  onCreateDocTemplate: (templateId: DocTemplateId) => void;
  onCreateSlideTemplate: (templateId: SlideTemplateId) => void;
  onCreateNotebookTemplate: (templateId: NotebookTemplateId) => void;
  onCreateCanvasTemplate: (templateId: CanvasTemplateId) => void;
  labFolder?: LabFolderWorkspace | null;
  onOpenLabFolder?: () => void;
  onCreatePdfTemplate: (templateId: 'blank' | 'report') => void;
  onMergePdfFiles: (files: File[]) => void;
  onRenameFile: (id: string, kind: WorkspaceFileKind) => void;
  onDuplicateFile: (id: string, kind: WorkspaceFileKind) => void;
  onTogglePinFile: (id: string, kind: WorkspaceFileKind) => void;
  onExportFile: (id: string, kind: WorkspaceFileKind, fmt: string) => void;
  onDeleteFile: (id: string, kind: WorkspaceFileKind) => void;
  onImportAnyFile: (file: File) => void;
  onOpenIndexedFolders?: () => void;
}

export const HomeHub: React.FC<HomeHubProps> = ({
  standaloneKind,
  files,
  openFileIds,
  onOpenFile,
  onOpenInNewWindow,
  onCreateSheetTemplate,
  onCreateDocTemplate,
  onCreateSlideTemplate,
  onCreateNotebookTemplate,
  onCreateCanvasTemplate,
  labFolder,
  onOpenLabFolder,
  onCreatePdfTemplate,
  onMergePdfFiles,
  onRenameFile,
  onDuplicateFile,
  onTogglePinFile,
  onExportFile,
  onDeleteFile,
  onImportAnyFile,
  onOpenIndexedFolders,
}) => {
  const [section, setSection] = useState<'home' | 'templates'>('home');
  const [listTab, setListTab] = useState<'recent' | 'pinned'>('recent');
  const [typeFilter, setTypeFilter] = useState<'all' | WorkspaceFileKind>('all');
  const [search, setSearch] = useState('');
  const [menuState, setMenuState] = useState<{
    x: number;
    y: number;
    file: WorkspaceFileSummary;
  } | null>(null);

  const isSheetsOnly = standaloneKind === 'sheets';
  const isDocsOnly = standaloneKind === 'docs';
  const isSlidesOnly = standaloneKind === 'slides';
  const isPdfOnly = standaloneKind === 'pdf';
  const isLabOnly = standaloneKind === 'lab';
  const isCanvasOnly = standaloneKind === 'canvas';
  const isStandalone = isSheetsOnly || isDocsOnly || isSlidesOnly || isPdfOnly || isLabOnly || isCanvasOnly;

  const railBg = isCanvasOnly
    ? 'bg-cyan-950'
    : isLabOnly
      ? 'bg-violet-950'
      : isPdfOnly
        ? 'bg-rose-950'
        : isSlidesOnly
          ? 'bg-amber-950'
          : isDocsOnly
            ? 'bg-blue-950'
            : 'bg-emerald-950';
  const activeTabClass = isCanvasOnly
    ? 'border-cyan-600 text-cyan-700'
    : isLabOnly
      ? 'border-violet-600 text-violet-700'
      : isPdfOnly
        ? 'border-rose-600 text-rose-700'
        : isSlidesOnly
          ? 'border-amber-600 text-amber-800'
          : isDocsOnly
            ? 'border-blue-600 text-blue-700'
            : 'border-emerald-600 text-emerald-700';

  const acceptExts = isSheetsOnly
    ? '.xlsx,.ods,.csv,.tsv'
    : isDocsOnly
      ? '.docx,.odt,.md,.markdown,.html,.htm'
      : isSlidesOnly
        ? '.pptx,.odp'
        : isPdfOnly
          ? '.pdf'
          : isLabOnly
            ? '.ipynb'
            : isCanvasOnly
              ? '.fcanvas,.excalidraw'
              : '.xlsx,.ods,.csv,.tsv,.docx,.odt,.md,.markdown,.html,.htm,.pptx,.odp,.pdf,.ipynb,.fcanvas,.excalidraw';

  const visibleFiles = useMemo(() => {
    const q = search.trim().toLowerCase();
    return files.filter((f) => {
      if (isSheetsOnly && f.kind !== 'spreadsheet') return false;
      if (isDocsOnly && f.kind !== 'document') return false;
      if (isSlidesOnly && f.kind !== 'slides') return false;
      if (isPdfOnly && f.kind !== 'pdf') return false;
      if (isLabOnly && f.kind !== 'notebook') return false;
      if (isCanvasOnly && f.kind !== 'canvas') return false;
      if (!isStandalone && typeFilter !== 'all' && f.kind !== typeFilter) return false;
      if (listTab === 'pinned' && !f.pinned) return false;
      if (q && !f.title.toLowerCase().includes(q) && !(f.previewText ?? '').toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [files, isSheetsOnly, isDocsOnly, isSlidesOnly, isPdfOnly, isLabOnly, isCanvasOnly, isStandalone, typeFilter, listTab, search]);

  const buildFileContextItems = (file: WorkspaceFileSummary): ContextMenuItem[] => {
    const exportItems: ContextMenuItem[] =
      file.kind === 'spreadsheet'
        ? [
            {
              id: 'ex-xlsx',
              label: 'Export as Excel (.xlsx)',
              icon: <Download className="w-3.5 h-3.5" />,
              onClick: () => onExportFile(file.id, file.kind, 'xlsx'),
            },
            {
              id: 'ex-ods',
              label: 'Export as OpenDocument (.ods)',
              icon: <Download className="w-3.5 h-3.5" />,
              onClick: () => onExportFile(file.id, file.kind, 'ods'),
            },
            {
              id: 'ex-csv',
              label: 'Export as CSV (.csv)',
              icon: <Download className="w-3.5 h-3.5" />,
              onClick: () => onExportFile(file.id, file.kind, 'csv'),
            },
          ]
        : file.kind === 'document'
          ? [
              {
                id: 'ex-docx',
                label: 'Export as Word (.docx)',
                icon: <Download className="w-3.5 h-3.5" />,
                onClick: () => onExportFile(file.id, file.kind, 'docx'),
              },
              {
                id: 'ex-odt',
                label: 'Export as OpenDocument (.odt)',
                icon: <Download className="w-3.5 h-3.5" />,
                onClick: () => onExportFile(file.id, file.kind, 'odt'),
              },
              {
                id: 'ex-md',
                label: 'Export as Markdown (.md)',
                icon: <Download className="w-3.5 h-3.5" />,
                onClick: () => onExportFile(file.id, file.kind, 'md'),
              },
            ]
        : file.kind === 'slides'
          ? [
              {
                id: 'ex-pptx',
                label: 'Export as PowerPoint (.pptx)',
                icon: <Download className="w-3.5 h-3.5" />,
                onClick: () => onExportFile(file.id, file.kind, 'pptx'),
              },
              {
                id: 'ex-odp',
                label: 'Export as OpenDocument (.odp)',
                icon: <Download className="w-3.5 h-3.5" />,
                onClick: () => onExportFile(file.id, file.kind, 'odp'),
              },
              {
                id: 'ex-spdf',
                label: 'Export as PDF (.pdf)',
                icon: <Download className="w-3.5 h-3.5" />,
                onClick: () => onExportFile(file.id, file.kind, 'pdf'),
              },
            ]
          : file.kind === 'notebook'
            ? [
                {
                  id: 'ex-ipynb',
                  label: 'Export as Jupyter Notebook (.ipynb)',
                  icon: <Download className="w-3.5 h-3.5" />,
                  onClick: () => onExportFile(file.id, file.kind, 'ipynb'),
                },
                {
                  id: 'ex-py',
                  label: 'Export as Python Script (.py)',
                  icon: <Download className="w-3.5 h-3.5" />,
                  onClick: () => onExportFile(file.id, file.kind, 'py'),
                },
                {
                  id: 'ex-nbmd',
                  label: 'Export as Study Markdown (.md)',
                  icon: <Download className="w-3.5 h-3.5" />,
                  onClick: () => onExportFile(file.id, file.kind, 'md'),
                },
              ]
            : file.kind === 'canvas'
              ? [
                  {
                    id: 'ex-fcanvas',
                    label: 'Save as Forma Canvas (.fcanvas)',
                    icon: <Download className="w-3.5 h-3.5" />,
                    onClick: () => onExportFile(file.id, file.kind, 'fcanvas'),
                  },
                  {
                    id: 'ex-excalidraw',
                    label: 'Export as Excalidraw (.excalidraw)',
                    icon: <Download className="w-3.5 h-3.5" />,
                    onClick: () => onExportFile(file.id, file.kind, 'excalidraw'),
                  },
                  {
                    id: 'ex-svg',
                    label: 'Export as Vector SVG (.svg)',
                    icon: <Download className="w-3.5 h-3.5" />,
                    onClick: () => onExportFile(file.id, file.kind, 'svg'),
                  },
                  {
                    id: 'ex-png',
                    label: 'Export as PNG Image (.png)',
                    icon: <Download className="w-3.5 h-3.5" />,
                    onClick: () => onExportFile(file.id, file.kind, 'png'),
                  },
                  {
                    id: 'ex-cpdf',
                    label: 'Export as Vector PDF (.pdf)',
                    icon: <Download className="w-3.5 h-3.5" />,
                    onClick: () => onExportFile(file.id, file.kind, 'pdf'),
                  },
                ]
              : [
                  {
                    id: 'ex-pdf',
                    label: 'Save Annotated PDF (.pdf)',
                    icon: <Download className="w-3.5 h-3.5" />,
                    onClick: () => onExportFile(file.id, file.kind, 'pdf'),
                  },
                ];

    return [
      {
        id: 'open',
        label: 'Open',
        icon: <ExternalLink className="w-3.5 h-3.5" />,
        onClick: () => onOpenFile(file.id, file.kind),
      },
      {
        id: 'new-window',
        label: 'Open in New Window',
        shortcut: '⇧⌘N',
        icon: <AppWindow className="w-3.5 h-3.5" />,
        onClick: () => onOpenInNewWindow(file.id),
      },
      { id: 'd1', divider: true },
      {
        id: 'pin',
        label: file.pinned ? 'Unpin from Top' : 'Pin to Pinned List',
        icon: file.pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />,
        onClick: () => onTogglePinFile(file.id, file.kind),
      },
      {
        id: 'rename',
        label: 'Rename…',
        icon: <Pencil className="w-3.5 h-3.5" />,
        onClick: () => onRenameFile(file.id, file.kind),
      },
      {
        id: 'duplicate',
        label: 'Make a Copy',
        icon: <Copy className="w-3.5 h-3.5" />,
        onClick: () => onDuplicateFile(file.id, file.kind),
      },
      { id: 'd2', divider: true },
      ...exportItems,
      { id: 'd3', divider: true },
      {
        id: 'delete',
        label: 'Delete File',
        danger: true,
        icon: <Trash2 className="w-3.5 h-3.5" />,
        onClick: () => onDeleteFile(file.id, file.kind),
      },
    ];
  };

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden bg-slate-50 select-none">
      {/* Left Backstage Rail */}
      <aside className={`w-48 shrink-0 flex flex-col justify-between py-4 px-2.5 text-white ${railBg}`}>
        <div className="space-y-1">
          <div className="px-2.5 pb-3 mb-2 border-b border-white/10">
            <div className="text-sm font-bold tracking-tight">
              {isSheetsOnly
                ? 'Forma Sheets'
                : isDocsOnly
                  ? 'Forma Docs'
                  : isSlidesOnly
                    ? 'Forma Slides'
                    : isPdfOnly
                      ? 'Forma PDF'
                      : isLabOnly
                        ? 'Forma Lab'
                        : isCanvasOnly
                          ? 'Forma Canvas'
                          : 'Forma Office'}
            </div>
            <div className="text-[11px] text-white/60">
              {isSheetsOnly
                ? 'Spreadsheets'
                : isDocsOnly
                  ? 'Documents'
                  : isSlidesOnly
                    ? 'Presentations'
                    : isPdfOnly
                      ? 'PDF Reader & Editor'
                      : isLabOnly
                        ? 'Notebooks'
                        : isCanvasOnly
                          ? 'Whiteboard & Diagrams'
                          : 'Office Suite'}
            </div>
          </div>

          <button
            onClick={() => setSection('home')}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition ${
              section === 'home'
                ? 'bg-white/15 text-white shadow-xs'
                : 'text-white/75 hover:bg-white/10 hover:text-white'
            }`}
          >
            <Home className="w-4 h-4" />
            <span>Home</span>
          </button>

          <button
            onClick={() => setSection('templates')}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition ${
              section === 'templates'
                ? 'bg-white/15 text-white shadow-xs'
                : 'text-white/75 hover:bg-white/10 hover:text-white'
            }`}
          >
            <Sparkles className="w-4 h-4" />
            <span>{isPdfOnly ? 'PDF Tools' : 'New from Template'}</span>
          </button>

          <label
            onClick={(e) => {
              if (openNativeFileDialog()) e.preventDefault();
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium text-white/75 hover:bg-white/10 hover:text-white cursor-pointer transition"
          >
            <FolderOpen className="w-4 h-4" />
            <span>
              {isPdfOnly
                ? 'Open PDF…'
                : isLabOnly
                  ? 'Open Notebook…'
                  : isCanvasOnly
                    ? 'Open Canvas…'
                    : 'Open File…'}
            </span>
            <input
              type="file"
              multiple
              accept={acceptExts}
              className="hidden"
              onChange={(e) => {
                const list = Array.from(e.target.files ?? []);
                list.forEach((f) => onImportAnyFile(f));
                e.target.value = '';
              }}
            />
          </label>

          {isLabOnly && onOpenLabFolder && (
            <button
              onClick={onOpenLabFolder}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium text-white/85 hover:bg-white/15 hover:text-white transition"
            >
              <FolderOpen className="w-4 h-4 text-violet-300" />
              <span className="truncate">
                {labFolder ? `Folder: ${labFolder.rootName}` : 'Open Folder…'}
              </span>
            </button>
          )}

          {isPdfOnly && (
            <label className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium text-white/75 hover:bg-white/10 hover:text-white cursor-pointer transition">
              <Layers className="w-4 h-4" />
              <span>Merge PDFs…</span>
              <input
                type="file"
                multiple
                accept=".pdf"
                className="hidden"
                onChange={(e) => {
                  const list = Array.from(e.target.files ?? []);
                  if (list.length > 0) onMergePdfFiles(list);
                  e.target.value = '';
                }}
              />
            </label>
          )}

          {onOpenIndexedFolders && (
            <button
              type="button"
              onClick={onOpenIndexedFolders}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium text-white/75 hover:bg-white/10 hover:text-white transition"
            >
              <FolderSearch className="w-4 h-4" />
              <span>Indexed Folders</span>
            </button>
          )}

          <button
            onClick={() => onOpenInNewWindow()}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium text-white/75 hover:bg-white/10 hover:text-white transition"
          >
            <AppWindow className="w-4 h-4" />
            <span>New Window</span>
          </button>
        </div>
      </aside>

      {/* Main Backstage Content */}
      <main className="flex-1 overflow-y-auto px-7 py-6 flex flex-col gap-7">
        {/* New / Templates Gallery */}
        <section
          className={`space-y-3 ${
            section === 'home' && visibleFiles.length > 0 ? 'order-2' : 'order-1'
          }`}
        >
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-800">
              {isPdfOnly ? 'PDF Tools' : section === 'templates' ? 'Templates' : 'New'}
            </h2>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
            {/* Sheets Templates */}
            {(!isStandalone || isSheetsOnly) &&
              SHEET_TEMPLATES.map((tpl) => (
                <button
                  key={`sheet_${tpl.id}`}
                  onClick={() => onCreateSheetTemplate(tpl.id)}
                  className="group text-left bg-white border border-slate-200 rounded-xl overflow-hidden hover:border-emerald-500 hover:shadow-md transition flex flex-col"
                >
                  <div className="h-24 bg-gradient-to-br from-slate-50 to-emerald-50/60 border-b border-slate-100 p-3 flex flex-col justify-between">
                    {tpl.id === 'blank' ? (
                      <div className="flex-1 flex items-center justify-center">
                        <div className="w-10 h-10 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center group-hover:scale-110 transition">
                          <Plus className="w-5 h-5" />
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-1.5 opacity-85">
                        <div className="h-2.5 w-3/4 rounded bg-emerald-600/80" />
                        <div className="grid grid-cols-3 gap-1">
                          <div className="h-2 rounded bg-slate-200" />
                          <div className="h-2 rounded bg-slate-200" />
                          <div className="h-2 rounded bg-emerald-200" />
                          <div className="h-2 rounded bg-slate-200" />
                          <div className="h-2 rounded bg-slate-200" />
                          <div className="h-2 rounded bg-emerald-200" />
                          <div className="h-2 rounded bg-slate-200" />
                          <div className="h-2 rounded bg-slate-200" />
                          <div className="h-2 rounded bg-emerald-300" />
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="p-3">
                    <div className="text-xs font-semibold text-slate-900 group-hover:text-emerald-700 transition">
                      {tpl.name}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">
                      {tpl.subtitle}
                    </div>
                  </div>
                </button>
              ))}

            {/* Docs Templates */}
            {(!isStandalone || isDocsOnly) &&
              DOC_TEMPLATES.map((tpl) => (
                <button
                  key={`doc_${tpl.id}`}
                  onClick={() => onCreateDocTemplate(tpl.id)}
                  className="group text-left bg-white border border-slate-200 rounded-xl overflow-hidden hover:border-blue-500 hover:shadow-md transition flex flex-col"
                >
                  <div className="h-24 bg-gradient-to-br from-slate-50 to-blue-50/60 border-b border-slate-100 p-3 flex flex-col justify-between">
                    {tpl.id === 'blank' ? (
                      <div className="flex-1 flex items-center justify-center">
                        <div className="w-10 h-10 rounded-xl bg-blue-100 text-blue-700 flex items-center justify-center group-hover:scale-110 transition">
                          <Plus className="w-5 h-5" />
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-1.5 opacity-85">
                        <div className="h-2.5 w-2/3 rounded bg-blue-600/80" />
                        <div className="h-1.5 w-full rounded bg-slate-300" />
                        <div className="h-1.5 w-5/6 rounded bg-slate-200" />
                        <div className="h-1.5 w-full rounded bg-slate-200" />
                        <div className="h-1.5 w-3/4 rounded bg-slate-200" />
                      </div>
                    )}
                  </div>
                  <div className="p-3">
                    <div className="text-xs font-semibold text-slate-900 group-hover:text-blue-700 transition">
                      {tpl.name}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">
                      {tpl.subtitle}
                    </div>
                  </div>
                </button>
              ))}

            {/* Slides Templates */}
            {(!isStandalone || isSlidesOnly) &&
              SLIDE_TEMPLATES.map((tpl) => (
                <button
                  key={`slide_${tpl.id}`}
                  onClick={() => onCreateSlideTemplate(tpl.id)}
                  className="group text-left bg-white border border-slate-200 rounded-xl overflow-hidden hover:border-amber-500 hover:shadow-md transition flex flex-col"
                >
                  <div className="h-24 bg-gradient-to-br from-slate-50 to-amber-50/70 border-b border-slate-100 p-3 flex flex-col justify-center">
                    {tpl.id === 'blank' ? (
                      <div className="flex-1 flex items-center justify-center">
                        <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center group-hover:scale-110 transition">
                          <Plus className="w-5 h-5" />
                        </div>
                      </div>
                    ) : (
                      <div
                        className={`rounded-md p-2 space-y-1.5 border ${
                          tpl.id === 'pitch'
                            ? 'bg-slate-900 border-slate-700'
                            : tpl.id === 'tech'
                              ? 'bg-blue-950 border-blue-800'
                              : 'bg-white border-slate-200'
                        }`}
                      >
                        <div className="h-1.5 w-8 rounded bg-amber-500" />
                        <div
                          className={`h-2.5 w-3/4 rounded ${
                            tpl.id === 'qbr' ? 'bg-slate-800' : 'bg-white/90'
                          }`}
                        />
                        <div className="grid grid-cols-3 gap-1 pt-0.5">
                          <div className="h-4 rounded bg-amber-500/25" />
                          <div className="h-4 rounded bg-amber-500/25" />
                          <div className="h-4 rounded bg-amber-500/25" />
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="p-3">
                    <div className="text-xs font-semibold text-slate-900 group-hover:text-amber-700 transition">
                      {tpl.name}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">
                      {tpl.subtitle}
                    </div>
                  </div>
                </button>
              ))}

            {/* Notebook (Lab) Templates */}
            {(!isStandalone || isLabOnly) && onOpenLabFolder && (
              <button
                onClick={onOpenLabFolder}
                className="group text-left bg-white border border-violet-200 rounded-xl overflow-hidden hover:border-violet-500 hover:shadow-md transition flex flex-col"
              >
                <div className="h-24 bg-gradient-to-br from-violet-50 to-indigo-100/70 border-b border-violet-100 flex items-center justify-center">
                  <div className="w-10 h-10 rounded-xl bg-violet-600 text-white flex items-center justify-center group-hover:scale-110 transition shadow-xs">
                    <FolderOpen className="w-5 h-5" />
                  </div>
                </div>
                <div className="p-3">
                  <div className="text-xs font-semibold text-slate-900 group-hover:text-violet-700 transition truncate">
                    {labFolder ? `Switch Folder (${labFolder.rootName})` : 'Open Local Folder'}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">
                    {labFolder
                      ? `${countNotebooksInTree(labFolder.entries)} .ipynb notebooks in workspace · ⇧⌘O`
                      : 'Browse a repo or course folder of .ipynb & .py files (⇧⌘O)'}
                  </div>
                </div>
              </button>
            )}
            {(!isStandalone || isLabOnly) &&
              NOTEBOOK_TEMPLATES.map((tpl) => (
                <button
                  key={`nb_${tpl.id}`}
                  onClick={() => onCreateNotebookTemplate(tpl.id)}
                  className="group text-left bg-white border border-slate-200 rounded-xl overflow-hidden hover:border-violet-500 hover:shadow-md transition flex flex-col"
                >
                  <div className="h-24 bg-gradient-to-br from-slate-50 to-violet-50/75 border-b border-slate-100 p-3 flex flex-col justify-center">
                    {tpl.id === 'blank' ? (
                      <div className="flex-1 flex items-center justify-center">
                        <div className="w-10 h-10 rounded-xl bg-violet-100 text-violet-700 flex items-center justify-center group-hover:scale-110 transition">
                          <Plus className="w-5 h-5" />
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-md bg-white border border-violet-200/80 p-2 space-y-1.5 shadow-2xs">
                        <div className="flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full bg-violet-500" />
                          <div className="h-2 w-2/3 rounded bg-violet-600/80" />
                        </div>
                        <div className="rounded bg-slate-900/90 px-2 py-1 space-y-1">
                          <div className="h-1.5 w-4/5 rounded bg-violet-300/80" />
                          <div className="h-1.5 w-3/5 rounded bg-emerald-300/80" />
                        </div>
                        <div className="h-1.5 w-1/2 rounded bg-slate-300" />
                      </div>
                    )}
                  </div>
                  <div className="p-3">
                    <div className="text-xs font-semibold text-slate-900 group-hover:text-violet-700 transition">
                      {tpl.name}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">
                      {tpl.subtitle}
                    </div>
                  </div>
                </button>
              ))}

            {/* Canvas Templates */}
            {(!isStandalone || isCanvasOnly) &&
              CANVAS_TEMPLATES.map((tpl) => (
                <button
                  key={`canvas_${tpl.id}`}
                  onClick={() => onCreateCanvasTemplate(tpl.id)}
                  className="group text-left bg-white border border-slate-200 rounded-xl overflow-hidden hover:border-cyan-500 hover:shadow-md transition flex flex-col"
                >
                  <div className="h-24 bg-gradient-to-br from-slate-50 to-cyan-50/75 border-b border-slate-100 p-3 flex flex-col justify-center">
                    {tpl.id === 'blank' ? (
                      <div className="flex-1 flex items-center justify-center">
                        <div className="w-10 h-10 rounded-xl bg-cyan-100 text-cyan-700 flex items-center justify-center group-hover:scale-110 transition">
                          <Plus className="w-5 h-5" />
                        </div>
                      </div>
                    ) : tpl.id === 'kanban' ? (
                      <div className="grid grid-cols-3 gap-1.5">
                        <div className="rounded bg-white border border-slate-200 p-1 space-y-1">
                          <div className="h-1.5 w-3/4 rounded bg-cyan-500/70" />
                          <div className="h-3.5 rounded bg-amber-200" />
                          <div className="h-3 rounded bg-amber-100" />
                        </div>
                        <div className="rounded bg-white border border-slate-200 p-1 space-y-1">
                          <div className="h-1.5 w-3/4 rounded bg-blue-500/70" />
                          <div className="h-3.5 rounded bg-cyan-200" />
                        </div>
                        <div className="rounded bg-white border border-slate-200 p-1 space-y-1">
                          <div className="h-1.5 w-3/4 rounded bg-emerald-500/70" />
                          <div className="h-3.5 rounded bg-emerald-200" />
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-md bg-white border border-cyan-200/70 p-2 flex items-center justify-between gap-1.5 shadow-2xs">
                        <div className="w-9 h-7 rounded bg-cyan-100 border border-cyan-400" />
                        <div className="h-0.5 flex-1 bg-slate-400" />
                        <div className="w-9 h-7 rounded-full bg-amber-100 border border-amber-400" />
                        <div className="h-0.5 flex-1 bg-slate-400" />
                        <div className="w-9 h-7 rounded bg-emerald-100 border border-emerald-400" />
                      </div>
                    )}
                  </div>
                  <div className="p-3">
                    <div className="text-xs font-semibold text-slate-900 group-hover:text-cyan-700 transition">
                      {tpl.name}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">
                      {tpl.subtitle}
                    </div>
                  </div>
                </button>
              ))}

            {/* PDF Quick Start & Templates */}
            {(!isStandalone || isPdfOnly) && (
              <>
                <label
                  onClick={(e) => {
                    if (openNativeFileDialog()) e.preventDefault();
                  }}
                  className="group text-left bg-white border border-slate-200 rounded-xl overflow-hidden hover:border-rose-500 hover:shadow-md transition flex flex-col cursor-pointer"
                >
                  <div className="h-24 bg-gradient-to-br from-slate-50 to-rose-50/70 border-b border-slate-100 flex items-center justify-center">
                    <div className="w-10 h-10 rounded-xl bg-rose-100 text-rose-700 flex items-center justify-center group-hover:scale-110 transition">
                      <FolderOpen className="w-5 h-5" />
                    </div>
                  </div>
                  <div className="p-3">
                    <div className="text-xs font-semibold text-slate-900 group-hover:text-rose-700">
                      Open Local PDF
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      View, highlight, fill, sign &amp; organize any .pdf
                    </div>
                  </div>
                  <input
                    type="file"
                    multiple
                    accept=".pdf"
                    className="hidden"
                    onChange={(e) => {
                      Array.from(e.target.files ?? []).forEach((f) => onImportAnyFile(f));
                      e.target.value = '';
                    }}
                  />
                </label>

                <label className="group text-left bg-white border border-slate-200 rounded-xl overflow-hidden hover:border-rose-500 hover:shadow-md transition flex flex-col cursor-pointer">
                  <div className="h-24 bg-gradient-to-br from-slate-50 to-rose-50/70 border-b border-slate-100 flex items-center justify-center">
                    <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center group-hover:scale-110 transition">
                      <Layers className="w-5 h-5" />
                    </div>
                  </div>
                  <div className="p-3">
                    <div className="text-xs font-semibold text-slate-900 group-hover:text-rose-700">
                      Merge Multiple PDFs
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      Select 2+ PDF files to combine into one document
                    </div>
                  </div>
                  <input
                    type="file"
                    multiple
                    accept=".pdf"
                    className="hidden"
                    onChange={(e) => {
                      const list = Array.from(e.target.files ?? []);
                      if (list.length > 0) onMergePdfFiles(list);
                      e.target.value = '';
                    }}
                  />
                </label>

                <button
                  onClick={() => onCreatePdfTemplate('blank')}
                  className="group text-left bg-white border border-slate-200 rounded-xl overflow-hidden hover:border-rose-500 hover:shadow-md transition flex flex-col"
                >
                  <div className="h-24 bg-gradient-to-br from-slate-50 to-rose-50/70 border-b border-slate-100 flex items-center justify-center">
                    <div className="w-10 h-10 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center group-hover:scale-110 transition">
                      <Plus className="w-5 h-5" />
                    </div>
                  </div>
                  <div className="p-3">
                    <div className="text-xs font-semibold text-slate-900 group-hover:text-rose-700">
                      Blank PDF Page
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      Clean US Letter PDF for sketches, notes &amp; signatures
                    </div>
                  </div>
                </button>

                <button
                  onClick={() => onCreatePdfTemplate('report')}
                  className="group text-left bg-white border border-slate-200 rounded-xl overflow-hidden hover:border-rose-500 hover:shadow-md transition flex flex-col"
                >
                  <div className="h-24 bg-gradient-to-br from-slate-50 to-rose-50/70 border-b border-slate-100 p-3 flex flex-col justify-center space-y-1.5">
                    <div className="h-3 w-3/4 rounded bg-rose-600/80" />
                    <div className="h-1.5 w-full rounded bg-slate-300" />
                    <div className="h-1.5 w-5/6 rounded bg-slate-200" />
                    <div className="h-1.5 w-2/3 rounded bg-slate-200" />
                  </div>
                  <div className="p-3">
                    <div className="text-xs font-semibold text-slate-900 group-hover:text-rose-700">
                      Sample 3-Page Report
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      Try highlighting, signing, rotating &amp; extracting pages
                    </div>
                  </div>
                </button>
              </>
            )}
          </div>
        </section>

        {/* Continue Working / Recent & Pinned Files Section */}
        {section === 'home' && (
          <section
            className={`space-y-3 ${visibleFiles.length > 0 ? 'order-1' : 'order-2'}`}
          >
            {visibleFiles.length > 0 && (
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-800">Continue working</h2>
                <button
                  onClick={() => onOpenFile(visibleFiles[0].id, visibleFiles[0].kind)}
                  className="text-xs font-medium text-slate-600 hover:text-slate-900 flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white border border-slate-200 hover:border-slate-300 shadow-2xs transition"
                >
                  <ExternalLink className="w-3 h-3" />
                  <span className="truncate max-w-[260px]">Resume: {visibleFiles[0].title}</span>
                </button>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-4 border-b border-slate-200">
                <button
                  onClick={() => setListTab('recent')}
                  className={`pb-2 text-xs font-semibold flex items-center gap-1.5 border-b-2 transition -mb-px ${
                    listTab === 'recent'
                      ? activeTabClass
                      : 'border-transparent text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <Clock className="w-3.5 h-3.5" />
                  <span>Recent</span>
                </button>
                <button
                  onClick={() => setListTab('pinned')}
                  className={`pb-2 text-xs font-semibold flex items-center gap-1.5 border-b-2 transition -mb-px ${
                    listTab === 'pinned'
                      ? activeTabClass
                      : 'border-transparent text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <Pin className="w-3.5 h-3.5" />
                  <span>Pinned</span>
                </button>
              </div>

              <div className="flex items-center gap-2">
                {!isStandalone && (
                  <div className="flex items-center gap-0.5 bg-slate-200/70 p-0.5 rounded-lg text-[11px]">
                    {(['all', 'spreadsheet', 'document', 'slides', 'notebook', 'canvas', 'pdf'] as const).map((f) => (
                      <button
                        key={f}
                        onClick={() => setTypeFilter(f)}
                        className={`px-2 py-1 rounded-md font-medium transition ${
                          typeFilter === f ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                        }`}
                      >
                        {f === 'all'
                          ? 'All'
                          : f === 'spreadsheet'
                            ? 'Sheets'
                            : f === 'document'
                              ? 'Docs'
                              : f === 'slides'
                                ? 'Slides'
                                : f === 'notebook'
                                  ? 'Lab'
                                  : f === 'canvas'
                                    ? 'Canvas'
                                    : 'PDF'}
                      </button>
                    ))}
                  </div>
                )}

                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search files..."
                    className="pl-8 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg w-48 focus:outline-none focus:border-slate-400"
                  />
                </div>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xs">
              <div className="grid grid-cols-[1fr_140px_130px_64px] px-4 py-2 bg-slate-50 border-b border-slate-200 text-[11px] font-semibold text-slate-500">
                <span>Name</span>
                <span>Format</span>
                <span>Modified</span>
                <span className="text-right">Actions</span>
              </div>

              <div className="divide-y divide-slate-100">
                {visibleFiles.map((file) => {
                  const isOpen = openFileIds.includes(file.id);
                  return (
                    <div
                      key={file.id}
                      onClick={() => onOpenFile(file.id, file.kind)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenuState({ x: e.clientX, y: e.clientY, file });
                      }}
                      className="grid grid-cols-[1fr_140px_130px_64px] items-center px-4 py-2.5 hover:bg-slate-50 cursor-pointer transition group"
                    >
                      <div className="flex items-center gap-3 min-w-0 pr-3">
                        <div
                          className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                            file.kind === 'spreadsheet'
                              ? 'bg-emerald-50 text-emerald-600'
                              : file.kind === 'document'
                                ? 'bg-blue-50 text-blue-600'
                                : file.kind === 'slides'
                                  ? 'bg-amber-50 text-amber-600'
                                  : file.kind === 'notebook'
                                    ? 'bg-violet-50 text-violet-600'
                                    : file.kind === 'canvas'
                                      ? 'bg-cyan-50 text-cyan-600'
                                      : 'bg-rose-50 text-rose-600'
                          }`}
                        >
                          {file.kind === 'spreadsheet' && <FileSpreadsheet className="w-4 h-4" />}
                          {file.kind === 'document' && <FileText className="w-4 h-4" />}
                          {file.kind === 'slides' && <Presentation className="w-4 h-4" />}
                          {file.kind === 'notebook' && <FlaskConical className="w-4 h-4" />}
                          {file.kind === 'canvas' && <PenTool className="w-4 h-4" />}
                          {file.kind === 'pdf' && <FileBadge2 className="w-4 h-4" />}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-slate-900 truncate">
                              {file.title}
                            </span>
                            {file.pinned && <Pin className="w-3 h-3 text-amber-500 shrink-0" />}
                            {isOpen && (
                              <span
                                className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
                                  file.kind === 'spreadsheet'
                                    ? 'bg-emerald-100 text-emerald-800'
                                    : file.kind === 'document'
                                      ? 'bg-blue-100 text-blue-800'
                                      : file.kind === 'slides'
                                        ? 'bg-amber-100 text-amber-800'
                                        : file.kind === 'notebook'
                                          ? 'bg-violet-100 text-violet-800'
                                          : file.kind === 'canvas'
                                            ? 'bg-cyan-100 text-cyan-800'
                                            : 'bg-rose-100 text-rose-800'
                                }`}
                              >
                                Open
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-400 truncate">
                            {file.previewText}
                          </div>
                        </div>
                      </div>

                      <div className="text-[11px] font-mono text-slate-500 truncate">
                        {file.primaryFormat}
                      </div>

                      <div className="text-[11px] text-slate-500">
                        {new Date(file.updatedAt).toLocaleString([], {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </div>

                      <div className="flex items-center justify-end gap-1">
                        <button
                          title={file.pinned ? 'Unpin' : 'Pin'}
                          onClick={(e) => {
                            e.stopPropagation();
                            onTogglePinFile(file.id, file.kind);
                          }}
                          className={`p-1 rounded hover:bg-slate-200/70 transition ${
                            file.pinned
                              ? 'text-amber-500'
                              : 'text-slate-300 opacity-0 group-hover:opacity-100 hover:text-slate-600'
                          }`}
                        >
                          <Pin className="w-3.5 h-3.5" />
                        </button>
                        <button
                          title="More actions (or right-click row)"
                          onClick={(e) => {
                            e.stopPropagation();
                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            setMenuState({ x: rect.right - 200, y: rect.bottom + 4, file });
                          }}
                          className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-200/70 transition"
                        >
                          <MoreHorizontal className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}

                {visibleFiles.length === 0 && (
                  <div className="py-12 px-6 text-center space-y-2">
                    <div className="text-xs font-medium text-slate-500">
                      {listTab === 'pinned'
                        ? 'No pinned files yet. Right-click any file to pin it here.'
                        : 'No recent files yet.'}
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Pick a card above or open an existing local file (⌘O) to get started.
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}
      </main>

      {menuState && (
        <ContextMenu
          x={menuState.x}
          y={menuState.y}
          items={buildFileContextItems(menuState.file)}
          onClose={() => setMenuState(null)}
        />
      )}
    </div>
  );
};
