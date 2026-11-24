import React, { useState } from 'react';
import { Editor } from '@tiptap/react';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  CheckSquare,
  Code,
  Code2,
  Columns2,
  Download,
  Eye,
  FileCode2,
  FolderOpen,
  Highlighter,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  MessageSquare,
  Minus,
  Printer,
  Quote,
  Redo2,
  Save,
  Search,
  Sigma,
  Strikethrough,
  Subscript,
  Superscript,
  Table as TableIcon,
  Underline,
  Undo2,
  Upload,
} from 'lucide-react';
import { DocsViewMode, DocumentSourceFormat } from '../../types/document';
import { DocumentExportFormat } from '../../types/office';
import { ReadingModePicker, ReadingTheme } from '../common/ReadingModePicker';

interface DocsRibbonProps {
  editor: Editor | null;
  fontFamily: string;
  onChangeFontFamily: (font: string) => void;
  viewMode: DocsViewMode;
  onChangeViewMode: (mode: DocsViewMode) => void;
  sourceFormat?: DocumentSourceFormat;
  nativePath?: string;
  onSavePrimary: () => void;
  showFindReplace: boolean;
  onToggleFindReplace: () => void;
  readingTheme: ReadingTheme;
  onSelectReadingTheme: (theme: ReadingTheme) => void;
  onImportFile: (file: File) => void;
  onExport: (format: DocumentExportFormat) => void;
  onPrintPdf: () => void;
  showComments?: boolean;
  openCommentCount?: number;
  onToggleComments?: () => void;
  hasDocsFolder?: boolean;
  folderSidebarActive?: boolean;
  onClickFolderButton?: () => void;
}

const TEXT_COLORS = ['#0f172a', '#475569', '#dc2626', '#ea580c', '#15803d', '#2563eb', '#7c3aed'];
const HIGHLIGHTS = ['', '#fef08a', '#bbf7d0', '#bfdbfe', '#fecdd3', '#e9d5ff'];

export const DocsRibbon: React.FC<DocsRibbonProps> = ({
  editor,
  fontFamily,
  onChangeFontFamily,
  viewMode,
  onChangeViewMode,
  sourceFormat,
  nativePath,
  onSavePrimary,
  showFindReplace,
  onToggleFindReplace,
  readingTheme,
  onSelectReadingTheme,
  onImportFile,
  onExport,
  onPrintPdf,
  showComments = false,
  openCommentCount = 0,
  onToggleComments,
  hasDocsFolder = false,
  folderSidebarActive = false,
  onClickFolderButton,
}) => {
  const [openMenu, setOpenMenu] = useState<'color' | 'highlight' | 'export' | 'math' | null>(null);

  if (!editor) return null;

  const isMarkdownDoc =
    sourceFormat === 'md' || Boolean(nativePath && /\.(md|markdown)$/i.test(nativePath));
  const primaryExt = sourceFormat ?? (isMarkdownDoc ? 'md' : 'docx');

  const btn = (active?: boolean) =>
    `p-1.5 rounded text-xs transition flex items-center gap-1 ${
      active
        ? 'bg-blue-100 text-blue-800'
        : 'text-slate-700 hover:bg-slate-100'
    }`;

  const currentBlock = editor.isActive('heading', { level: 1 })
    ? 'h1'
    : editor.isActive('heading', { level: 2 })
      ? 'h2'
      : editor.isActive('heading', { level: 3 })
        ? 'h3'
        : 'p';

  const handleSetBlock = (val: string) => {
    const chain = editor.chain().focus();
    if (val === 'p') chain.setParagraph().run();
    if (val === 'h1') chain.toggleHeading({ level: 1 }).run();
    if (val === 'h2') chain.toggleHeading({ level: 2 }).run();
    if (val === 'h3') chain.toggleHeading({ level: 3 }).run();
  };

  const handleAddLink = () => {
    const prev = editor.getAttributes('link').href || '';
    const url = window.prompt('Enter URL (leave blank to remove link):', prev);
    if (url === null) return;
    if (url.trim() === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
    }
  };

  const handleAddImage = () => {
    const url = window.prompt('Enter image URL:');
    if (url && url.trim()) {
      editor.chain().focus().setImage({ src: url.trim() }).run();
    }
  };

  const inTable = editor.isActive('table');
  const isMdOnly = viewMode === 'markdown';

  const insertEquation = (displayMode: boolean) => {
    setOpenMenu(null);
    const { from, to } = editor.state.selection;
    const selectedText = editor.state.doc.textBetween(from, to, ' ').trim();
    if (displayMode) {
      const expr = selectedText || '\\sum_{i=1}^{n} x_i = \\frac{n(n+1)}{2}';
      const wrapped = `$$${expr}$$`;
      if (selectedText) {
        editor.chain().focus().insertContent(wrapped).run();
        const afterEnd = editor.state.selection.to;
        editor.commands.setTextSelection({
          from: Math.max(1, afterEnd - wrapped.length + 2),
          to: Math.max(1, afterEnd - 2),
        });
      } else {
        editor.chain().focus().insertContent(`<p>${wrapped}</p>`).run();
        const cursor = editor.state.selection.to;
        editor.commands.setTextSelection({
          from: Math.max(1, cursor - expr.length - 2),
          to: Math.max(1, cursor - 2),
        });
      }
      return;
    }

    const expr = selectedText || 'x^2 + y^2 = z^2';
    const wrapped = `$${expr}$`;
    editor.chain().focus().insertContent(wrapped).run();
    const afterEnd = editor.state.selection.to;
    editor.commands.setTextSelection({
      from: Math.max(1, afterEnd - expr.length - 1),
      to: Math.max(1, afterEnd - 1),
    });
  };

  return (
    <div className="no-print bg-white border-b border-slate-200 px-2.5 py-1.5 flex flex-wrap items-center gap-1 shrink-0 select-none">
      {/* Undo / Redo */}
      <button
        disabled={isMdOnly || !editor.can().undo()}
        onClick={() => editor.chain().focus().undo().run()}
        title="Undo (Cmd/Ctrl+Z)"
        className={`${btn()} disabled:opacity-35`}
      >
        <Undo2 className="w-3.5 h-3.5" />
      </button>
      <button
        disabled={isMdOnly || !editor.can().redo()}
        onClick={() => editor.chain().focus().redo().run()}
        title="Redo (Cmd/Ctrl+Shift+Z)"
        className={`${btn()} disabled:opacity-35`}
      >
        <Redo2 className="w-3.5 h-3.5" />
      </button>

      <div className="h-5 w-px bg-slate-200 mx-1" />

      {/* Block Style */}
      <select
        aria-label="Paragraph Style"
        disabled={isMdOnly}
        value={currentBlock}
        onChange={(e) => handleSetBlock(e.target.value)}
        className="h-7 px-2 text-xs bg-slate-50 border border-slate-200 rounded text-slate-700 font-medium focus:outline-none focus:border-blue-500 disabled:opacity-35"
      >
        <option value="p">Normal Text</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
      </select>

      {/* Document Font */}
      <select
        aria-label="Document Font"
        disabled={isMdOnly}
        value={fontFamily}
        onChange={(e) => onChangeFontFamily(e.target.value)}
        className="h-7 px-1.5 text-xs bg-slate-50 border border-slate-200 rounded text-slate-700 focus:outline-none focus:border-blue-500 disabled:opacity-35"
      >
        <option value="Inter">Inter (Sans)</option>
        <option value="Merriweather">Merriweather (Serif)</option>
        <option value="Georgia">Georgia</option>
        <option value="JetBrains Mono">JetBrains Mono</option>
      </select>

      <div className="h-5 w-px bg-slate-200 mx-1" />

      {/* Inline Marks */}
      <button
        disabled={isMdOnly}
        title="Bold (Cmd/Ctrl+B)"
        onClick={() => editor.chain().focus().toggleBold().run()}
        className={`${btn(editor.isActive('bold'))} disabled:opacity-35`}
      >
        <Bold className="w-3.5 h-3.5" />
      </button>
      <button
        disabled={isMdOnly}
        title="Italic (Cmd/Ctrl+I)"
        onClick={() => editor.chain().focus().toggleItalic().run()}
        className={`${btn(editor.isActive('italic'))} disabled:opacity-35`}
      >
        <Italic className="w-3.5 h-3.5" />
      </button>
      <button
        disabled={isMdOnly}
        title="Underline (Cmd/Ctrl+U)"
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        className={`${btn(editor.isActive('underline'))} disabled:opacity-35`}
      >
        <Underline className="w-3.5 h-3.5" />
      </button>
      <button
        disabled={isMdOnly}
        title="Strikethrough"
        onClick={() => editor.chain().focus().toggleStrike().run()}
        className={`${btn(editor.isActive('strike'))} disabled:opacity-35`}
      >
        <Strikethrough className="w-3.5 h-3.5" />
      </button>
      <button
        disabled={isMdOnly}
        title="Inline Code"
        onClick={() => editor.chain().focus().toggleCode().run()}
        className={`${btn(editor.isActive('code'))} disabled:opacity-35`}
      >
        <Code className="w-3.5 h-3.5" />
      </button>
      <button
        disabled={isMdOnly}
        title="Subscript"
        onClick={() => editor.chain().focus().toggleSubscript().run()}
        className={`${btn(editor.isActive('subscript'))} disabled:opacity-35`}
      >
        <Subscript className="w-3.5 h-3.5" />
      </button>
      <button
        disabled={isMdOnly}
        title="Superscript"
        onClick={() => editor.chain().focus().toggleSuperscript().run()}
        className={`${btn(editor.isActive('superscript'))} disabled:opacity-35`}
      >
        <Superscript className="w-3.5 h-3.5" />
      </button>

      {/* Text Color */}
      <div className="relative">
        <button
          disabled={isMdOnly}
          title="Text Color"
          onClick={() => setOpenMenu(openMenu === 'color' ? null : 'color')}
          className={`${btn()} disabled:opacity-35`}
        >
          <span className="font-bold text-xs leading-none">A</span>
          <span
            className="w-3.5 h-1 rounded-full block"
            style={{ background: editor.getAttributes('textStyle').color || '#0f172a' }}
          />
        </button>
        {!isMdOnly && openMenu === 'color' && (
          <div className="absolute left-0 top-8 z-40 bg-white border border-slate-200 rounded-lg shadow-xl p-2 flex gap-1.5">
            {TEXT_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => {
                  editor.chain().focus().setColor(c).run();
                  setOpenMenu(null);
                }}
                style={{ background: c }}
                className="w-5 h-5 rounded border border-slate-300 hover:scale-110 transition"
              />
            ))}
          </div>
        )}
      </div>

      {/* Highlight */}
      <div className="relative">
        <button
          disabled={isMdOnly}
          title="Highlight"
          onClick={() => setOpenMenu(openMenu === 'highlight' ? null : 'highlight')}
          className={`${btn(editor.isActive('highlight'))} disabled:opacity-35`}
        >
          <Highlighter className="w-3.5 h-3.5" />
        </button>
        {!isMdOnly && openMenu === 'highlight' && (
          <div className="absolute left-0 top-8 z-40 bg-white border border-slate-200 rounded-lg shadow-xl p-2 flex gap-1.5">
            {HIGHLIGHTS.map((c, idx) => (
              <button
                key={idx}
                onClick={() => {
                  if (!c) editor.chain().focus().unsetHighlight().run();
                  else editor.chain().focus().setHighlight({ color: c }).run();
                  setOpenMenu(null);
                }}
                style={{ background: c || '#ffffff' }}
                className="w-5 h-5 rounded border border-slate-300 hover:scale-110 transition"
                title={c || 'No Highlight'}
              >
                {!c && <span className="text-[10px] text-rose-500 font-bold">/</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="h-5 w-px bg-slate-200 mx-1" />

      {/* Alignment */}
      <button
        disabled={isMdOnly}
        title="Align Left"
        onClick={() => editor.chain().focus().setTextAlign('left').run()}
        className={`${btn(editor.isActive({ textAlign: 'left' }))} disabled:opacity-35`}
      >
        <AlignLeft className="w-3.5 h-3.5" />
      </button>
      <button
        disabled={isMdOnly}
        title="Align Center"
        onClick={() => editor.chain().focus().setTextAlign('center').run()}
        className={`${btn(editor.isActive({ textAlign: 'center' }))} disabled:opacity-35`}
      >
        <AlignCenter className="w-3.5 h-3.5" />
      </button>
      <button
        disabled={isMdOnly}
        title="Align Right"
        onClick={() => editor.chain().focus().setTextAlign('right').run()}
        className={`${btn(editor.isActive({ textAlign: 'right' }))} disabled:opacity-35`}
      >
        <AlignRight className="w-3.5 h-3.5" />
      </button>
      <button
        disabled={isMdOnly}
        title="Justify"
        onClick={() => editor.chain().focus().setTextAlign('justify').run()}
        className={`${btn(editor.isActive({ textAlign: 'justify' }))} disabled:opacity-35`}
      >
        <AlignJustify className="w-3.5 h-3.5" />
      </button>

      <div className="h-5 w-px bg-slate-200 mx-1" />

      {/* Lists & Blocks */}
      <button
        disabled={isMdOnly}
        title="Bullet List"
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        className={`${btn(editor.isActive('bulletList'))} disabled:opacity-35`}
      >
        <List className="w-3.5 h-3.5" />
      </button>
      <button
        disabled={isMdOnly}
        title="Numbered List"
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        className={`${btn(editor.isActive('orderedList'))} disabled:opacity-35`}
      >
        <ListOrdered className="w-3.5 h-3.5" />
      </button>
      <button
        disabled={isMdOnly}
        title="Checklist / Task List"
        onClick={() => editor.chain().focus().toggleTaskList().run()}
        className={`${btn(editor.isActive('taskList'))} disabled:opacity-35`}
      >
        <CheckSquare className="w-3.5 h-3.5" />
      </button>
      <button
        disabled={isMdOnly}
        title="Blockquote"
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        className={`${btn(editor.isActive('blockquote'))} disabled:opacity-35`}
      >
        <Quote className="w-3.5 h-3.5" />
      </button>
      <button
        disabled={isMdOnly}
        title="Code Block"
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        className={`${btn(editor.isActive('codeBlock'))} disabled:opacity-35`}
      >
        <Code2 className="w-3.5 h-3.5" />
      </button>
      <button
        disabled={isMdOnly}
        title="Horizontal Divider"
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
        className={`${btn()} disabled:opacity-35`}
      >
        <Minus className="w-3.5 h-3.5" />
      </button>

      <div className="h-5 w-px bg-slate-200 mx-1" />

      {/* Insert Table / Link / Image */}
      <button
        disabled={isMdOnly}
        title="Insert 3x3 Table"
        onClick={() =>
          editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
        }
        className={`${btn(inTable)} disabled:opacity-35`}
      >
        <TableIcon className="w-3.5 h-3.5" />
      </button>
      {!isMdOnly && inTable && (
        <div className="flex items-center gap-0.5 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-200 text-[10px] font-medium text-blue-800">
          <button
            onClick={() => editor.chain().focus().addRowAfter().run()}
            className="px-1 hover:bg-blue-100 rounded"
          >
            +Row
          </button>
          <button
            onClick={() => editor.chain().focus().deleteRow().run()}
            className="px-1 hover:bg-blue-100 rounded"
          >
            -Row
          </button>
          <button
            onClick={() => editor.chain().focus().addColumnAfter().run()}
            className="px-1 hover:bg-blue-100 rounded"
          >
            +Col
          </button>
          <button
            onClick={() => editor.chain().focus().deleteColumn().run()}
            className="px-1 hover:bg-blue-100 rounded"
          >
            -Col
          </button>
          <button
            onClick={() => editor.chain().focus().deleteTable().run()}
            className="px-1 hover:bg-rose-100 text-rose-700 rounded"
          >
            Del
          </button>
        </div>
      )}

      <button
        disabled={isMdOnly}
        title="Insert Link"
        onClick={handleAddLink}
        className={`${btn(editor.isActive('link'))} disabled:opacity-35`}
      >
        <LinkIcon className="w-3.5 h-3.5" />
      </button>
      <button
        disabled={isMdOnly}
        title="Insert Image URL"
        onClick={handleAddImage}
        className={`${btn()} disabled:opacity-35`}
      >
        <ImageIcon className="w-3.5 h-3.5" />
      </button>

      {/* Insert LaTeX Equation */}
      <div className="relative">
        <button
          disabled={isMdOnly}
          title="Insert LaTeX Equation ($...$ or $$...$$)"
          onClick={() => setOpenMenu(openMenu === 'math' ? null : 'math')}
          className={`${btn(openMenu === 'math')} disabled:opacity-35`}
        >
          <Sigma className="w-3.5 h-3.5" />
        </button>
        {!isMdOnly && openMenu === 'math' && (
          <div className="absolute left-0 top-8 z-40 w-52 bg-white border border-slate-200 rounded-lg shadow-xl p-1 text-xs">
            <button
              type="button"
              onClick={() => insertEquation(false)}
              className="w-full flex items-center justify-between px-2.5 py-1.5 rounded hover:bg-blue-50 hover:text-blue-700 text-left text-slate-700"
            >
              <span className="font-medium">Inline Math</span>
              <code className="text-[10px] font-mono text-slate-400">$...$</code>
            </button>
            <button
              type="button"
              onClick={() => insertEquation(true)}
              className="w-full flex items-center justify-between px-2.5 py-1.5 rounded hover:bg-blue-50 hover:text-blue-700 text-left text-slate-700"
            >
              <span className="font-medium">Display Equation</span>
              <code className="text-[10px] font-mono text-slate-400">$$...$$</code>
            </button>
          </div>
        )}
      </div>

      <button
        title="Find & Replace (Cmd/Ctrl+F)"
        onClick={onToggleFindReplace}
        className={btn(showFindReplace)}
      >
        <Search className="w-3.5 h-3.5" />
      </button>

      <div className="h-5 w-px bg-slate-200 mx-0.5" />

      <ReadingModePicker value={readingTheme} onChange={onSelectReadingTheme} />

      <div className="h-5 w-px bg-slate-200 mx-0.5" />

      {/* Preview / Markdown / Split Editor Mode Switcher */}
      <div
        title="Switch between Rich Preview, Raw Markdown Editor (⌘E), and Split View"
        className="flex items-center bg-slate-100 border border-slate-200 rounded-lg p-0.5 text-[11px] font-medium"
      >
        <button
          onClick={() => onChangeViewMode('preview')}
          title="Formatted Preview (Editable in place)"
          className={`px-2 py-0.5 rounded-md flex items-center gap-1 transition ${
            viewMode === 'preview'
              ? 'bg-white text-blue-700 shadow-2xs font-semibold'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <Eye className="w-3 h-3" />
          <span>Preview</span>
        </button>
        <button
          onClick={() => onChangeViewMode('markdown')}
          title="Raw Markdown Editor (⌘E)"
          className={`px-2 py-0.5 rounded-md flex items-center gap-1 transition ${
            viewMode === 'markdown'
              ? 'bg-white text-blue-700 shadow-2xs font-semibold'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <FileCode2 className="w-3 h-3" />
          <span>Markdown</span>
        </button>
        <button
          onClick={() => onChangeViewMode('split')}
          title="Side-by-Side Markdown Editor + Live Preview"
          className={`px-2 py-0.5 rounded-md flex items-center gap-1 transition ${
            viewMode === 'split'
              ? 'bg-white text-blue-700 shadow-2xs font-semibold'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <Columns2 className="w-3 h-3" />
          <span>Split</span>
        </button>
      </div>

      <div className="flex-1" />

      {/* Folder Mode Toggle */}
      {onClickFolderButton && (
        <button
          type="button"
          title={hasDocsFolder ? 'Toggle Markdown Folder Sidebar' : 'Open Markdown Folder…'}
          onClick={onClickFolderButton}
          className={`px-2 py-1 rounded-md text-xs font-medium flex items-center gap-1 transition ${
            folderSidebarActive
              ? 'bg-blue-100 text-blue-800'
              : 'text-slate-700 hover:bg-slate-100'
          }`}
        >
          <FolderOpen className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Folder</span>
        </button>
      )}

      {/* Review Comments Toggle */}
      {onToggleComments && (
        <button
          type="button"
          title="Toggle Review Comments"
          onClick={onToggleComments}
          className={`px-2 py-1 rounded-md text-xs font-medium flex items-center gap-1 transition ${
            showComments
              ? 'bg-blue-100 text-blue-800'
              : 'text-slate-700 hover:bg-slate-100'
          }`}
        >
          <MessageSquare className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Comments</span>
          {openCommentCount > 0 && (
            <span className="px-1.5 py-0.2 rounded-full bg-blue-600 text-white text-[10px] font-semibold font-mono leading-4">
              {openCommentCount}
            </span>
          )}
        </button>
      )}

      {/* Print / Save as PDF */}
      <button
        title="Print / Save as PDF"
        onClick={onPrintPdf}
        className="px-2 py-1 rounded-md text-xs font-medium text-slate-700 hover:bg-slate-100 flex items-center gap-1"
      >
        <Printer className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">PDF</span>
      </button>

      {/* Import Open Formats */}
      <label className="px-2.5 py-1 rounded-md text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 cursor-pointer flex items-center gap-1.5 transition">
        <Upload className="w-3.5 h-3.5" />
        <span>Import</span>
        <input
          type="file"
          accept=".docx,.odt,.md,.markdown,.html,.htm"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onImportFile(file);
            e.target.value = '';
          }}
        />
      </label>

      {/* Direct Save (in-place for .md / linked files, or saves in source format) */}
      <button
        onClick={onSavePrimary}
        title={
          nativePath
            ? `Save in place to ${nativePath} (⌘S)`
            : `Save as .${primaryExt} (⌘S)`
        }
        className="px-2.5 py-1 rounded-md text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 flex items-center gap-1.5 transition shadow-xs"
      >
        <Save className="w-3.5 h-3.5" />
        <span>Save .{primaryExt}</span>
      </button>

      {/* Export Open Formats */}
      <div className="relative">
        <button
          onClick={() => setOpenMenu(openMenu === 'export' ? null : 'export')}
          className="px-2.5 py-1 rounded-md text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 flex items-center gap-1.5 transition shadow-xs"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Export</span>
        </button>
        {openMenu === 'export' && (
          <div className="absolute right-0 top-8 z-40 w-52 bg-white border border-slate-200 rounded-xl shadow-xl py-1.5 text-xs">
            <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Export As
            </div>
            <button
              onClick={() => {
                onExport('docx');
                setOpenMenu(null);
              }}
              className="w-full text-left px-3 py-2 hover:bg-blue-50 flex items-center justify-between"
            >
              <span className="font-medium text-slate-800">Word Document</span>
              <span className="text-[10px] text-blue-700 font-mono">.docx</span>
            </button>
            <button
              onClick={() => {
                onExport('odt');
                setOpenMenu(null);
              }}
              className="w-full text-left px-3 py-2 hover:bg-blue-50 flex items-center justify-between"
            >
              <span className="font-medium text-slate-800">OpenDocument Text</span>
              <span className="text-[10px] text-blue-700 font-mono">.odt</span>
            </button>
            <div className="my-1 border-t border-slate-100" />
            <button
              onClick={() => {
                onExport('md');
                setOpenMenu(null);
              }}
              className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between"
            >
              <span className="text-slate-700">Markdown</span>
              <span className="text-[10px] text-slate-400 font-mono">.md</span>
            </button>
            <button
              onClick={() => {
                onExport('html');
                setOpenMenu(null);
              }}
              className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between"
            >
              <span className="text-slate-700">Web Page</span>
              <span className="text-[10px] text-slate-400 font-mono">.html</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
