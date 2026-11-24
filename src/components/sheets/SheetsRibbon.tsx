import React, { useState } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownZA,
  ArrowUpAZ,
  BarChart3,
  Bold,
  Code2,
  Columns3,
  DollarSign,
  Download,
  FileText,
  Filter,
  Grid2x2,
  Italic,
  Merge,
  Palette,
  Percent,
  Pin,
  Plus,
  Redo2,
  Rows3,
  Strikethrough,
  Table2,
  Trash2,
  Underline,
  Undo2,
  Upload,
  WrapText,
} from 'lucide-react';
import { CellStyle, NumberFormatType } from '../../types/spreadsheet';
import { SpreadsheetExportFormat } from '../../types/office';

interface SheetsRibbonProps {
  activeStyle: CellStyle;
  canUndo: boolean;
  canRedo: boolean;
  hasFrozenHeader: boolean;
  isFilterEnabled?: boolean;
  condFormatCount?: number;
  canRunPython?: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onStylePatch: (patch: Partial<CellStyle>) => void;
  onAdjustDecimals: (delta: 1 | -1) => void;
  onToggleBorders: () => void;
  onToggleMerge: () => void;
  onToggleFreeze: () => void;
  onToggleFilter?: () => void;
  onOpenCondFormat?: () => void;
  onOpenPivot?: () => void;
  onOpenPythonTransform?: () => void;
  onSort: (dir: 'asc' | 'desc') => void;
  onInsertRow: () => void;
  onDeleteRow: () => void;
  onInsertCol: () => void;
  onDeleteCol: () => void;
  onInsertChart: () => void;
  onCopyToDocs: () => void;
  onImportFile: (file: File) => void;
  onExport: (format: SpreadsheetExportFormat) => void;
}

const TEXT_COLORS = ['#0f172a', '#475569', '#dc2626', '#ea580c', '#15803d', '#2563eb', '#7c3aed', '#ffffff'];
const FILL_COLORS = ['', '#f8fafc', '#f1f5f9', '#dcfce7', '#dbeafe', '#fef9c3', '#fee2e2', '#f3e8ff', '#0f172a'];

export const SheetsRibbon: React.FC<SheetsRibbonProps> = ({
  activeStyle,
  canUndo,
  canRedo,
  hasFrozenHeader,
  isFilterEnabled = false,
  condFormatCount = 0,
  canRunPython = false,
  onUndo,
  onRedo,
  onStylePatch,
  onAdjustDecimals,
  onToggleBorders,
  onToggleMerge,
  onToggleFreeze,
  onToggleFilter,
  onOpenCondFormat,
  onOpenPivot,
  onOpenPythonTransform,
  onSort,
  onInsertRow,
  onDeleteRow,
  onInsertCol,
  onDeleteCol,
  onInsertChart,
  onCopyToDocs,
  onImportFile,
  onExport,
}) => {
  const [openMenu, setOpenMenu] = useState<'textColor' | 'fillColor' | 'export' | null>(null);

  const btn = (active?: boolean) =>
    `p-1 rounded text-xs transition flex items-center gap-0.5 ${
      active
        ? 'bg-emerald-100 text-emerald-800'
        : 'text-slate-700 hover:bg-slate-100'
    }`;

  return (
    <div className="bg-white border-b border-slate-200 px-2 py-1 flex flex-wrap items-center gap-0.5 shrink-0 select-none">
      {/* Undo / Redo */}
      <button
        disabled={!canUndo}
        onClick={onUndo}
        title="Undo (Cmd/Ctrl+Z)"
        className={`${btn()} disabled:opacity-35`}
      >
        <Undo2 className="w-3.5 h-3.5" />
      </button>
      <button
        disabled={!canRedo}
        onClick={onRedo}
        title="Redo (Cmd/Ctrl+Shift+Z)"
        className={`${btn()} disabled:opacity-35`}
      >
        <Redo2 className="w-3.5 h-3.5" />
      </button>

      <div className="h-5 w-px bg-slate-200 mx-1" />

      {/* Font Family & Size */}
      <select
        aria-label="Font Family"
        value={activeStyle.fontFamily ?? 'Inter'}
        onChange={(e) => onStylePatch({ fontFamily: e.target.value })}
        className="h-7 px-1.5 text-xs bg-slate-50 border border-slate-200 rounded text-slate-700 focus:outline-none focus:border-emerald-500"
      >
        <option value="Inter">Inter</option>
        <option value="Arial">Arial</option>
        <option value="Georgia">Georgia</option>
        <option value="JetBrains Mono">Mono</option>
      </select>

      <select
        aria-label="Font Size"
        value={activeStyle.fontSize ?? 12}
        onChange={(e) => onStylePatch({ fontSize: Number(e.target.value) })}
        className="h-7 w-14 px-1 text-xs bg-slate-50 border border-slate-200 rounded text-slate-700 focus:outline-none focus:border-emerald-500"
      >
        {[10, 11, 12, 13, 14, 16, 18, 20, 24].map((sz) => (
          <option key={sz} value={sz}>
            {sz}
          </option>
        ))}
      </select>

      <div className="h-5 w-px bg-slate-200 mx-1" />

      {/* Font Weight / Style */}
      <button
        title="Bold (Cmd/Ctrl+B)"
        onClick={() => onStylePatch({ bold: !activeStyle.bold })}
        className={btn(activeStyle.bold)}
      >
        <Bold className="w-3.5 h-3.5" />
      </button>
      <button
        title="Italic (Cmd/Ctrl+I)"
        onClick={() => onStylePatch({ italic: !activeStyle.italic })}
        className={btn(activeStyle.italic)}
      >
        <Italic className="w-3.5 h-3.5" />
      </button>
      <button
        title="Underline (Cmd/Ctrl+U)"
        onClick={() => onStylePatch({ underline: !activeStyle.underline })}
        className={btn(activeStyle.underline)}
      >
        <Underline className="w-3.5 h-3.5" />
      </button>
      <button
        title="Strikethrough"
        onClick={() => onStylePatch({ strikethrough: !activeStyle.strikethrough })}
        className={btn(activeStyle.strikethrough)}
      >
        <Strikethrough className="w-3.5 h-3.5" />
      </button>

      {/* Text Color */}
      <div className="relative">
        <button
          title="Text Color"
          onClick={() => setOpenMenu(openMenu === 'textColor' ? null : 'textColor')}
          className={btn()}
        >
          <span className="font-bold text-xs leading-none">A</span>
          <span
            className="w-3.5 h-1 rounded-full block"
            style={{ background: activeStyle.color ?? '#0f172a' }}
          />
        </button>
        {openMenu === 'textColor' && (
          <div className="absolute left-0 top-8 z-40 bg-white border border-slate-200 rounded-lg shadow-xl p-2 flex gap-1.5">
            {TEXT_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => {
                  onStylePatch({ color: c });
                  setOpenMenu(null);
                }}
                style={{ background: c }}
                className="w-5 h-5 rounded border border-slate-300 hover:scale-110 transition"
                title={c}
              />
            ))}
          </div>
        )}
      </div>

      {/* Fill Color */}
      <div className="relative">
        <button
          title="Fill Color"
          onClick={() => setOpenMenu(openMenu === 'fillColor' ? null : 'fillColor')}
          className={btn()}
        >
          <span
            className="w-4 h-4 rounded border border-slate-300 inline-block"
            style={{ background: activeStyle.backgroundColor || '#ffffff' }}
          />
        </button>
        {openMenu === 'fillColor' && (
          <div className="absolute left-0 top-8 z-40 bg-white border border-slate-200 rounded-lg shadow-xl p-2 flex gap-1.5">
            {FILL_COLORS.map((c, idx) => (
              <button
                key={idx}
                onClick={() => {
                  onStylePatch({ backgroundColor: c || undefined });
                  setOpenMenu(null);
                }}
                style={{ background: c || '#ffffff' }}
                className="w-5 h-5 rounded border border-slate-300 hover:scale-110 transition relative"
                title={c || 'No Fill'}
              >
                {!c && <span className="text-[10px] text-rose-500 font-bold">/</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      <button title="Toggle Borders" onClick={onToggleBorders} className={btn(Boolean(activeStyle.border))}>
        <Grid2x2 className="w-3.5 h-3.5" />
      </button>

      <div className="h-5 w-px bg-slate-200 mx-1" />

      {/* Alignment & Wrap & Merge */}
      <button
        title="Align Left"
        onClick={() => onStylePatch({ align: 'left' })}
        className={btn(activeStyle.align === 'left')}
      >
        <AlignLeft className="w-3.5 h-3.5" />
      </button>
      <button
        title="Align Center"
        onClick={() => onStylePatch({ align: 'center' })}
        className={btn(activeStyle.align === 'center')}
      >
        <AlignCenter className="w-3.5 h-3.5" />
      </button>
      <button
        title="Align Right"
        onClick={() => onStylePatch({ align: 'right' })}
        className={btn(activeStyle.align === 'right')}
      >
        <AlignRight className="w-3.5 h-3.5" />
      </button>
      <button
        title="Wrap Text"
        onClick={() => onStylePatch({ wrap: !activeStyle.wrap })}
        className={btn(activeStyle.wrap)}
      >
        <WrapText className="w-3.5 h-3.5" />
      </button>
      <button title="Merge / Unmerge Selection" onClick={onToggleMerge} className={btn()}>
        <Merge className="w-3.5 h-3.5" />
      </button>

      <div className="h-5 w-px bg-slate-200 mx-1" />

      {/* Number Formatting */}
      <button
        title="Format as Currency ($)"
        onClick={() => onStylePatch({ numFmt: 'currency', decimals: 2 })}
        className={btn(activeStyle.numFmt === 'currency')}
      >
        <DollarSign className="w-3.5 h-3.5" />
      </button>
      <button
        title="Format as Percent (%)"
        onClick={() => onStylePatch({ numFmt: 'percent', decimals: 1 })}
        className={btn(activeStyle.numFmt === 'percent')}
      >
        <Percent className="w-3.5 h-3.5" />
      </button>
      <select
        aria-label="Number Format"
        value={activeStyle.numFmt ?? 'general'}
        onChange={(e) => onStylePatch({ numFmt: e.target.value as NumberFormatType })}
        className="h-7 px-1.5 text-xs bg-slate-50 border border-slate-200 rounded text-slate-700 focus:outline-none focus:border-emerald-500"
      >
        <option value="general">General</option>
        <option value="number">Number (1,234.56)</option>
        <option value="integer">Integer (1,235)</option>
        <option value="currency">Currency ($)</option>
        <option value="percent">Percent (%)</option>
        <option value="date">Date (YYYY-MM-DD)</option>
        <option value="scientific">Scientific</option>
      </select>
      <button
        title="Decrease Decimals"
        onClick={() => onAdjustDecimals(-1)}
        className="px-1.5 py-1 rounded text-[11px] font-mono text-slate-600 hover:bg-slate-100"
      >
        .0-
      </button>
      <button
        title="Increase Decimals"
        onClick={() => onAdjustDecimals(1)}
        className="px-1.5 py-1 rounded text-[11px] font-mono text-slate-600 hover:bg-slate-100"
      >
        .0+
      </button>

      <div className="h-5 w-px bg-slate-200 mx-1" />

      {/* Structure & Data */}
      <button title="Insert Row Above" onClick={onInsertRow} className={btn()}>
        <Plus className="w-3 h-3" />
        <Rows3 className="w-3.5 h-3.5" />
      </button>
      <button title="Delete Row" onClick={onDeleteRow} className={btn()}>
        <Trash2 className="w-3 h-3 text-rose-500" />
        <Rows3 className="w-3.5 h-3.5" />
      </button>
      <button title="Insert Column Left" onClick={onInsertCol} className={btn()}>
        <Plus className="w-3 h-3" />
        <Columns3 className="w-3.5 h-3.5" />
      </button>
      <button title="Delete Column" onClick={onDeleteCol} className={btn()}>
        <Trash2 className="w-3 h-3 text-rose-500" />
        <Columns3 className="w-3.5 h-3.5" />
      </button>
      <button title="Sort Selection A → Z" onClick={() => onSort('asc')} className={btn()}>
        <ArrowUpAZ className="w-3.5 h-3.5" />
      </button>
      <button title="Sort Selection Z → A" onClick={() => onSort('desc')} className={btn()}>
        <ArrowDownZA className="w-3.5 h-3.5" />
      </button>
      <button
        title="Freeze / Unfreeze Top Row & First Column"
        onClick={onToggleFreeze}
        className={btn(hasFrozenHeader)}
      >
        <Pin className="w-3.5 h-3.5" />
      </button>

      <div className="h-5 w-px bg-slate-200 mx-1" />

      {/* Data Analysis: Filter, Conditional Formatting, Pivot Table, Python Transform */}
      {onToggleFilter && (
        <button
          title={isFilterEnabled ? 'Disable AutoFilter' : 'Enable AutoFilter on Selected Row'}
          onClick={onToggleFilter}
          className={`px-2 py-1 rounded-md text-xs font-medium transition flex items-center gap-1 ${
            isFilterEnabled
              ? 'bg-emerald-600 text-white shadow-xs'
              : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
          }`}
        >
          <Filter className="w-3.5 h-3.5" />
          <span>Filter</span>
        </button>
      )}

      {onOpenCondFormat && (
        <button
          title="Conditional Formatting Rules"
          onClick={onOpenCondFormat}
          className={`px-2 py-1 rounded-md text-xs font-medium transition flex items-center gap-1 ${
            condFormatCount > 0
              ? 'bg-amber-50 text-amber-800 hover:bg-amber-100'
              : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
          }`}
        >
          <Palette className="w-3.5 h-3.5" />
          <span>Cond. Format</span>
          {condFormatCount > 0 && (
            <span className="ml-0.5 px-1 py-0 text-[10px] rounded-full bg-amber-200 text-amber-900 font-semibold">
              {condFormatCount}
            </span>
          )}
        </button>
      )}

      {onOpenPivot && (
        <button
          title="Create Pivot Table from Selected or Used Range"
          onClick={onOpenPivot}
          className="px-2 py-1 rounded-md text-xs font-medium bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition flex items-center gap-1"
        >
          <Table2 className="w-3.5 h-3.5" />
          <span>Pivot Table</span>
        </button>
      )}

      {canRunPython && onOpenPythonTransform && (
        <button
          title="Run Quick Pandas Python Transform via Native Kernel"
          onClick={onOpenPythonTransform}
          className="px-2 py-1 rounded-md text-xs font-medium bg-violet-50 text-violet-700 hover:bg-violet-100 transition flex items-center gap-1"
        >
          <Code2 className="w-3.5 h-3.5" />
          <span>Python</span>
        </button>
      )}

      <div className="h-5 w-px bg-slate-200 mx-1" />

      {/* Chart & Cross-App Docs Interop */}
      <button
        title="Insert Live Chart from Selected Range"
        onClick={onInsertChart}
        className="px-2 py-1 rounded-md text-xs font-medium bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition flex items-center gap-1"
      >
        <BarChart3 className="w-3.5 h-3.5" />
        <span>Chart</span>
      </button>

      <button
        title="Send Selected Table to Forma Docs"
        onClick={onCopyToDocs}
        className="px-2 py-1 rounded-md text-xs font-medium bg-blue-50 text-blue-700 hover:bg-blue-100 transition flex items-center gap-1"
      >
        <FileText className="w-3.5 h-3.5" />
        <span>To Docs</span>
      </button>

      <div className="flex-1" />

      {/* Open / Export Open Formats */}
      <label className="px-2.5 py-1 rounded-md text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 cursor-pointer flex items-center gap-1.5 transition">
        <Upload className="w-3.5 h-3.5" />
        <span>Import</span>
        <input
          type="file"
          accept=".xlsx,.ods,.csv,.tsv"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onImportFile(file);
            e.target.value = '';
          }}
        />
      </label>

      <div className="relative">
        <button
          onClick={() => setOpenMenu(openMenu === 'export' ? null : 'export')}
          className="px-2.5 py-1 rounded-md text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 flex items-center gap-1.5 transition shadow-xs"
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
                onExport('xlsx');
                setOpenMenu(null);
              }}
              className="w-full text-left px-3 py-2 hover:bg-emerald-50 flex items-center justify-between"
            >
              <span className="font-medium text-slate-800">Excel Workbook</span>
              <span className="text-[10px] text-emerald-700 font-mono">.xlsx</span>
            </button>
            <button
              onClick={() => {
                onExport('ods');
                setOpenMenu(null);
              }}
              className="w-full text-left px-3 py-2 hover:bg-emerald-50 flex items-center justify-between"
            >
              <span className="font-medium text-slate-800">OpenDocument Sheet</span>
              <span className="text-[10px] text-emerald-700 font-mono">.ods</span>
            </button>
            <div className="my-1 border-t border-slate-100" />
            <button
              onClick={() => {
                onExport('csv');
                setOpenMenu(null);
              }}
              className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between"
            >
              <span className="text-slate-700">CSV (Current Sheet)</span>
              <span className="text-[10px] text-slate-400 font-mono">.csv</span>
            </button>
            <button
              onClick={() => {
                onExport('tsv');
                setOpenMenu(null);
              }}
              className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between"
            >
              <span className="text-slate-700">Tab-Separated</span>
              <span className="text-[10px] text-slate-400 font-mono">.tsv</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
