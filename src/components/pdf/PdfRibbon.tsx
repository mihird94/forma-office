import React, { useState } from 'react';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Download,
  EyeOff,
  FileCheck2,
  FilePlus2,
  Highlighter,
  Layers,
  Loader2,
  Maximize2,
  MessageSquarePlus,
  MousePointer2,
  PanelLeftClose,
  PanelLeftOpen,
  PenTool,
  Printer,
  RotateCw,
  ScanText,
  Search,
  ShieldAlert,
  Type,
  Undo2,
  Upload,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { PdfTool } from '../../types/pdf';
import { openNativeFileDialog } from '../../storage/workspaceStore';
import { ReadingModePicker, ReadingTheme } from '../common/ReadingModePicker';

interface PdfRibbonProps {
  activeTool: PdfTool;
  activeColor: string;
  zoom: number;
  currentPage: number;
  pageCount: number;
  annotationCount: number;
  pendingRedactionCount: number;
  formFieldCount: number;
  showFormPanel: boolean;
  ocrBusy: boolean;
  showSearch: boolean;
  showSidebar: boolean;
  readingMode: boolean;
  readingTheme: ReadingTheme;
  onSelectReadingTheme: (theme: ReadingTheme) => void;
  onToggleSidebar: () => void;
  onToggleReadingMode: () => void;
  onSelectTool: (tool: PdfTool) => void;
  onSelectColor: (color: string) => void;
  onUndoAnnotation: () => void;
  onApplyRedactions: () => void;
  onToggleFormPanel: () => void;
  onRunOcrCurrentPage: () => void;
  onRunOcrAllPages: () => void;
  onOpenCompare: () => void;
  onZoomChange: (nextZoom: number) => void;
  onFitWidth: () => void;
  onPageChange: (page: number) => void;
  onRotatePage: () => void;
  onInsertBlankPage: () => void;
  onMergePdfFile: (file: File) => void;
  onToggleSearch: () => void;
  onOpenPdfFile: (file: File) => void;
  onExportPdf: () => void;
  onExportText: (asMarkdown: boolean) => void;
  onPrint: () => void;
}

const COLORS = ['#fde047', '#86efac', '#93c5fd', '#dc2626', '#1e3a8a', '#0f172a'];

export const PdfRibbon: React.FC<PdfRibbonProps> = ({
  activeTool,
  activeColor,
  zoom,
  currentPage,
  pageCount,
  annotationCount,
  pendingRedactionCount,
  formFieldCount,
  showFormPanel,
  ocrBusy,
  showSearch,
  showSidebar,
  readingMode,
  readingTheme,
  onSelectReadingTheme,
  onToggleSidebar,
  onToggleReadingMode,
  onSelectTool,
  onSelectColor,
  onUndoAnnotation,
  onApplyRedactions,
  onToggleFormPanel,
  onRunOcrCurrentPage,
  onRunOcrAllPages,
  onOpenCompare,
  onZoomChange,
  onFitWidth,
  onPageChange,
  onRotatePage,
  onInsertBlankPage,
  onMergePdfFile,
  onToggleSearch,
  onOpenPdfFile,
  onExportPdf,
  onExportText,
  onPrint,
}) => {
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showOcrMenu, setShowOcrMenu] = useState(false);
  const [pageDraft, setPageDraft] = useState<string | null>(null);

  const btn = (active?: boolean) =>
    `px-2 py-1 rounded text-xs transition flex items-center gap-1 ${
      active
        ? 'bg-rose-100 text-rose-800 font-medium'
        : 'text-slate-700 hover:bg-slate-100'
    }`;

  return (
    <div className="no-print bg-white border-b border-slate-200 px-2 py-1.5 flex flex-wrap items-center gap-1 shrink-0 select-none">
      {/* Sidebar Toggle */}
      <button
        title={showSidebar ? 'Collapse Sidebar' : 'Show Sidebar'}
        onClick={onToggleSidebar}
        className={btn(!showSidebar)}
      >
        {showSidebar ? (
          <PanelLeftClose className="w-3.5 h-3.5" />
        ) : (
          <PanelLeftOpen className="w-3.5 h-3.5" />
        )}
      </button>

      <div className="h-5 w-px bg-slate-200 mx-0.5" />

      {/* Annotation Tools */}
      <button
        title="Select / Pan"
        onClick={() => onSelectTool('select')}
        className={btn(activeTool === 'select')}
      >
        <MousePointer2 className="w-3.5 h-3.5" />
        <span className="hidden xl:inline">Select</span>
      </button>
      <button
        title="Highlight Area"
        onClick={() => onSelectTool('highlight')}
        className={btn(activeTool === 'highlight')}
      >
        <Highlighter className="w-3.5 h-3.5" />
        <span className="hidden xl:inline">Highlight</span>
      </button>
      <button
        title="Add Text / Fill Form"
        onClick={() => onSelectTool('text')}
        className={btn(activeTool === 'text')}
      >
        <Type className="w-3.5 h-3.5" />
        <span className="hidden xl:inline">Text</span>
      </button>
      <button
        title="Draw / Sign Freehand"
        onClick={() => onSelectTool('ink')}
        className={btn(activeTool === 'ink')}
      >
        <PenTool className="w-3.5 h-3.5" />
        <span className="hidden xl:inline">Sign</span>
      </button>
      <button
        title="Add Sticky Note"
        onClick={() => onSelectTool('note')}
        className={btn(activeTool === 'note')}
      >
        <MessageSquarePlus className="w-3.5 h-3.5" />
        <span className="hidden xl:inline">Note</span>
      </button>
      <button
        title="Redact Sensitive Area (Drag box, then Apply Redactions Permanently)"
        onClick={() => onSelectTool('redact')}
        className={
          activeTool === 'redact'
            ? 'px-2 py-1 rounded text-xs transition flex items-center gap-1 bg-slate-900 text-white font-medium'
            : 'px-2 py-1 rounded text-xs transition flex items-center gap-1 text-slate-700 hover:bg-slate-100'
        }
      >
        <EyeOff className="w-3.5 h-3.5" />
        <span className="hidden xl:inline">Redact</span>
      </button>

      {pendingRedactionCount > 0 && (
        <button
          onClick={onApplyRedactions}
          title="Permanently flatten and remove redacted content from PDF"
          className="px-2 py-1 rounded-md text-xs font-semibold bg-slate-900 hover:bg-black text-rose-300 border border-rose-500/60 flex items-center gap-1 transition shadow-xs"
        >
          <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
          <span>Apply Redactions ({pendingRedactionCount})</span>
        </button>
      )}

      {/* Color Swatches */}
      <div className="flex items-center gap-1 px-1.5 py-0.5 bg-slate-50 border border-slate-200 rounded-md mx-0.5">
        {COLORS.map((c) => (
          <button
            key={c}
            title={`Color ${c}`}
            onClick={() => onSelectColor(c)}
            style={{ background: c }}
            className={`w-3.5 h-3.5 rounded-full border transition ${
              activeColor === c ? 'scale-125 border-slate-900 ring-1 ring-slate-400' : 'border-slate-300'
            }`}
          />
        ))}
      </div>

      <button
        disabled={annotationCount === 0}
        onClick={onUndoAnnotation}
        title="Undo Last Annotation"
        className={`${btn()} disabled:opacity-35`}
      >
        <Undo2 className="w-3.5 h-3.5" />
      </button>

      <div className="h-5 w-px bg-slate-200 mx-0.5" />

      {/* Page Navigation (with quick-jump page input) */}
      <button
        disabled={currentPage <= 0}
        onClick={() => onPageChange(currentPage - 1)}
        title="Previous Page"
        className={`${btn()} disabled:opacity-35`}
      >
        <ChevronLeft className="w-3.5 h-3.5" />
      </button>
      <div className="flex items-center gap-1 text-xs font-mono text-slate-700 px-0.5">
        <input
          aria-label="Jump to page number"
          title="Type a page number and press Enter"
          value={pageDraft !== null ? pageDraft : String(pageCount > 0 ? currentPage + 1 : 0)}
          onFocus={(e) => {
            setPageDraft(String(pageCount > 0 ? currentPage + 1 : 1));
            e.currentTarget.select();
          }}
          onChange={(e) => setPageDraft(e.target.value.replace(/[^0-9]/g, ''))}
          onBlur={() => {
            if (pageDraft !== null && pageDraft !== '') {
              const num = parseInt(pageDraft, 10);
              if (Number.isFinite(num) && num >= 1) {
                onPageChange(Math.max(0, Math.min(pageCount - 1, num - 1)));
              }
            }
            setPageDraft(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              setPageDraft(null);
              e.currentTarget.blur();
            }
          }}
          className="w-11 text-center py-0.5 bg-slate-50 border border-slate-200 rounded text-xs font-mono text-slate-800 focus:outline-none focus:border-rose-500"
        />
        <span className="text-slate-400">/ {pageCount}</span>
      </div>
      <button
        disabled={currentPage >= pageCount - 1}
        onClick={() => onPageChange(currentPage + 1)}
        title="Next Page"
        className={`${btn()} disabled:opacity-35`}
      >
        <ChevronRight className="w-3.5 h-3.5" />
      </button>

      <div className="h-5 w-px bg-slate-200 mx-0.5" />

      {/* Zoom */}
      <button
        onClick={() => onZoomChange(Math.max(0.5, Math.round((zoom - 0.15) * 100) / 100))}
        title="Zoom Out (⌘-)"
        className={btn()}
      >
        <ZoomOut className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={() => onZoomChange(1.15)}
        title="Reset Zoom (⌘0)"
        className="px-1.5 py-0.5 rounded text-xs font-mono text-slate-700 hover:bg-slate-100"
      >
        {Math.round(zoom * 100)}%
      </button>
      <button
        onClick={() => onZoomChange(Math.min(3.0, Math.round((zoom + 0.15) * 100) / 100))}
        title="Zoom In (⌘+)"
        className={btn()}
      >
        <ZoomIn className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={onFitWidth}
        title="Fit Page to Width"
        className={btn()}
      >
        <Maximize2 className="w-3.5 h-3.5" />
      </button>

      <div className="h-5 w-px bg-slate-200 mx-0.5" />

      {/* Organize Pages & Search */}
      <button title="Rotate Current Page 90° CW" onClick={onRotatePage} className={btn()}>
        <RotateCw className="w-3.5 h-3.5" />
      </button>
      <button title="Insert Blank Page After Current" onClick={onInsertBlankPage} className={btn()}>
        <FilePlus2 className="w-3.5 h-3.5" />
      </button>
      <label
        title="Merge Another PDF into This Document"
        className="px-2 py-1 rounded text-xs text-slate-700 hover:bg-slate-100 cursor-pointer flex items-center gap-1 transition"
      >
        <Layers className="w-3.5 h-3.5" />
        <span className="hidden lg:inline">Merge</span>
        <input
          type="file"
          accept=".pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onMergePdfFile(f);
            e.target.value = '';
          }}
        />
      </label>
      <button title="Search PDF Text (⌘F)" onClick={onToggleSearch} className={btn(showSearch)}>
        <Search className="w-3.5 h-3.5" />
      </button>

      {formFieldCount > 0 && (
        <button
          onClick={onToggleFormPanel}
          title="Fill Interactive AcroForm Fields"
          className={`px-2 py-1 rounded-md text-xs font-medium flex items-center gap-1 transition border ${
            showFormPanel
              ? 'bg-emerald-600 text-white border-emerald-700 shadow-xs'
              : 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100'
          }`}
        >
          <FileCheck2 className="w-3.5 h-3.5" />
          <span>Forms ({formFieldCount})</span>
        </button>
      )}

      {/* Native macOS Vision OCR */}
      <div className="relative">
        <button
          disabled={ocrBusy}
          onClick={() => setShowOcrMenu((v) => !v)}
          title="Recognize scanned text via native macOS Vision OCR"
          className={`${btn(showOcrMenu)} disabled:opacity-50`}
        >
          {ocrBusy ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-rose-600" />
          ) : (
            <ScanText className="w-3.5 h-3.5" />
          )}
          <span className="hidden lg:inline">{ocrBusy ? 'OCR…' : 'Vision OCR'}</span>
        </button>
        {showOcrMenu && (
          <div className="absolute left-0 top-8 z-40 w-48 bg-white border border-slate-200 rounded-xl shadow-xl py-1.5 text-xs">
            <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              macOS Vision OCR
            </div>
            <button
              onClick={() => {
                setShowOcrMenu(false);
                onRunOcrCurrentPage();
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-rose-50 text-slate-800 font-medium"
            >
              OCR Current Page (p.{currentPage + 1})
            </button>
            <button
              onClick={() => {
                setShowOcrMenu(false);
                onRunOcrAllPages();
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-rose-50 text-slate-700"
            >
              OCR All Pages ({pageCount})
            </button>
          </div>
        )}
      </div>

      {/* Side-by-Side PDF Compare */}
      <button
        onClick={onOpenCompare}
        title="Compare this PDF side-by-side with another PDF"
        className={btn()}
      >
        <Columns2 className="w-3.5 h-3.5" />
        <span className="hidden lg:inline">Compare PDF</span>
      </button>

      <div className="h-5 w-px bg-slate-200 mx-0.5" />

      <ReadingModePicker value={readingTheme} onChange={onSelectReadingTheme} />

      <button
        title="Reading Mode — collapse sidebar & toolbar (⌘\)"
        onClick={onToggleReadingMode}
        className={`px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 transition border ${
          readingMode
            ? 'bg-rose-600 text-white border-rose-700 shadow-xs'
            : 'bg-amber-50/90 text-amber-900 border-amber-200 hover:bg-amber-100'
        }`}
      >
        <BookOpen className="w-3.5 h-3.5" />
        <span>Reading Mode</span>
      </button>

      <div className="flex-1" />

      {/* Print / Import / Save */}
      <button
        title="Print PDF (⌘P)"
        onClick={onPrint}
        className="px-2 py-1 rounded-md text-xs font-medium text-slate-700 hover:bg-slate-100 flex items-center gap-1"
      >
        <Printer className="w-3.5 h-3.5" />
      </button>

      <label
        onClick={(e) => {
          if (openNativeFileDialog()) e.preventDefault();
        }}
        className="px-2.5 py-1 rounded-md text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 cursor-pointer flex items-center gap-1.5 transition"
      >
        <Upload className="w-3.5 h-3.5" />
        <span>Open</span>
        <input
          type="file"
          accept=".pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onOpenPdfFile(f);
            e.target.value = '';
          }}
        />
      </label>

      <div className="relative">
        <button
          onClick={() => setShowExportMenu((v) => !v)}
          className="px-2.5 py-1 rounded-md text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 flex items-center gap-1.5 transition shadow-xs"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Save / Export</span>
        </button>
        {showExportMenu && (
          <div className="absolute right-0 top-8 z-40 w-52 bg-white border border-slate-200 rounded-xl shadow-xl py-1.5 text-xs">
            <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Export As
            </div>
            <button
              onClick={() => {
                onExportPdf();
                setShowExportMenu(false);
              }}
              className="w-full text-left px-3 py-2 hover:bg-rose-50 flex items-center justify-between"
            >
              <span className="font-medium text-slate-800">PDF Document</span>
              <span className="text-[10px] text-rose-700 font-mono">.pdf</span>
            </button>
            <div className="my-1 border-t border-slate-100" />
            <button
              onClick={() => {
                onExportText(false);
                setShowExportMenu(false);
              }}
              className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between"
            >
              <span className="text-slate-700">Plain Text</span>
              <span className="text-[10px] text-slate-400 font-mono">.txt</span>
            </button>
            <button
              onClick={() => {
                onExportText(true);
                setShowExportMenu(false);
              }}
              className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between"
            >
              <span className="text-slate-700">Markdown</span>
              <span className="text-[10px] text-slate-400 font-mono">.md</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
