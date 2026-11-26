import React, { useState } from 'react';
import {
  BookOpen,
  Code2,
  Cpu,
  Database,
  Download,
  Eraser,
  FastForward,
  FileCode2,
  FolderOpen,
  Play,
  Printer,
  RotateCcw,
  Save,
  Square,
  Terminal,
  Upload,
  Zap,
} from 'lucide-react';
import { NotebookViewMode, PythonEnvInfo } from '../../types/notebook';
import { ReadingModePicker, ReadingTheme } from '../common/ReadingModePicker';
import { openNativeFileDialog } from '../../storage/workspaceStore';

interface NotebookRibbonProps {
  viewMode: NotebookViewMode;
  readingTheme: ReadingTheme;
  kernelAvailable: boolean;
  isRunning: boolean;
  kernelTransitioning?: boolean;
  reactiveMode: boolean;
  envs: PythonEnvInfo[];
  activePythonPath: string;
  hasNativePath?: boolean;
  onChangeViewMode: (mode: NotebookViewMode) => void;
  onToggleReactiveMode: () => void;
  onSelectReadingTheme: (theme: ReadingTheme) => void;
  onSelectPythonPath: (path: string) => void;
  onRunActive: () => void;
  onRunAll: () => void;
  onInterrupt: () => void;
  onRestart: () => void;
  onClearAllOutputs: () => void;
  onAddCodeCell: () => void;
  onAddSqlCell: () => void;
  onAddMarkdownCell: () => void;
  onOpenFolder: () => void;
  onSaveToDisk?: () => void;
  onImportIpynb: (file: File) => void;
  onExport: (fmt: 'ipynb' | 'py' | 'md') => void;
  onPrint: () => void;
}

export const NotebookRibbon: React.FC<NotebookRibbonProps> = ({
  viewMode,
  readingTheme,
  kernelAvailable,
  isRunning,
  kernelTransitioning = false,
  reactiveMode,
  envs,
  activePythonPath,
  hasNativePath,
  onChangeViewMode,
  onToggleReactiveMode,
  onSelectReadingTheme,
  onSelectPythonPath,
  onRunActive,
  onRunAll,
  onInterrupt,
  onRestart,
  onClearAllOutputs,
  onAddCodeCell,
  onAddSqlCell,
  onAddMarkdownCell,
  onOpenFolder,
  onSaveToDisk,
  onImportIpynb,
  onExport,
  onPrint,
}) => {
  const [showExport, setShowExport] = useState(false);

  const btn = (active?: boolean) =>
    `px-2 py-1 rounded text-xs transition flex items-center gap-1 ${
      active ? 'bg-violet-100 text-violet-900 font-medium' : 'text-slate-700 hover:bg-slate-100'
    }`;

  return (
    <div className="no-print bg-white border-b border-slate-200 px-2.5 py-1.5 flex flex-wrap items-center gap-1.5 shrink-0 select-none">
      {/* Reimagined View Mode Switcher: Lab vs Study Paper */}
      <div className="flex items-center bg-slate-100 border border-slate-200 rounded-lg p-0.5">
        <button
          onClick={() => onChangeViewMode('lab')}
          title="Lab Mode — Full interactive code + math notebook"
          className={`px-2.5 py-1 rounded-md text-xs font-semibold flex items-center gap-1 transition ${
            viewMode === 'lab'
              ? 'bg-violet-600 text-white shadow-xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <Terminal className="w-3.5 h-3.5" />
          <span>Lab</span>
        </button>
        <button
          onClick={() => onChangeViewMode('study')}
          title="Study Mode — Clean textbook view with collapsible Reveal Code for active recall"
          className={`px-2.5 py-1 rounded-md text-xs font-semibold flex items-center gap-1 transition ${
            viewMode === 'study'
              ? 'bg-violet-600 text-white shadow-xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <BookOpen className="w-3.5 h-3.5" />
          <span>Study</span>
        </button>
      </div>

      <div className="h-5 w-px bg-slate-200" />

      {/* Kernel Run Cluster */}
      <button
        onClick={onRunActive}
        disabled={isRunning || kernelTransitioning}
        title="Run Selected Cell (Shift+Enter)"
        className="px-2.5 py-1 rounded-md text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-45 flex items-center gap-1 transition shadow-xs"
      >
        <Play className="w-3.5 h-3.5 fill-current" />
        <span>Run</span>
      </button>
      <button
        onClick={onRunAll}
        disabled={isRunning || kernelTransitioning}
        title="Run All Code Cells"
        className={`${btn()} disabled:opacity-45`}
      >
        <FastForward className="w-3.5 h-3.5 text-emerald-700" />
        <span className="hidden lg:inline">Run All</span>
      </button>
      {isRunning && (
        <button
          onClick={onInterrupt}
          title="Interrupt Kernel (SIGINT)"
          className="px-2 py-1 rounded-md text-xs font-semibold bg-rose-100 text-rose-700 hover:bg-rose-200 flex items-center gap-1"
        >
          <Square className="w-3 h-3 fill-current" />
          <span>Stop</span>
        </button>
      )}
      <button onClick={onRestart} disabled={kernelTransitioning} title="Restart Python Kernel" className={btn()}>
        <RotateCcw className="w-3.5 h-3.5" />
      </button>
      <button onClick={onClearAllOutputs} title="Clear All Outputs" className={btn()}>
        <Eraser className="w-3.5 h-3.5" />
      </button>

      <button
        onClick={onToggleReactiveMode}
        title="Reactive Mode — automatically re-runs downstream dependent cells when an upstream cell or slider changes"
        className={`px-2 py-1 rounded-md text-xs font-semibold flex items-center gap-1 transition border ${
          reactiveMode
            ? 'bg-amber-500/15 text-amber-800 border-amber-300 shadow-2xs'
            : 'bg-slate-50 text-slate-500 border-slate-200 hover:text-slate-800'
        }`}
      >
        <Zap className={`w-3.5 h-3.5 ${reactiveMode ? 'fill-amber-500 text-amber-600' : ''}`} />
        <span className="hidden xl:inline">{reactiveMode ? 'Reactive' : 'Manual'}</span>
      </button>

      <div className="h-5 w-px bg-slate-200" />

      {/* Insert Cells */}
      <button onClick={onAddCodeCell} title="Insert Python Code Cell" className={btn()}>
        <Code2 className="w-3.5 h-3.5 text-violet-700" />
        <span>+ Code</span>
      </button>
      <button onClick={onAddSqlCell} title="Insert SQL Query Cell (DuckDB / SQLite)" className={btn()}>
        <Database className="w-3.5 h-3.5 text-teal-600" />
        <span>+ SQL</span>
      </button>
      <button onClick={onAddMarkdownCell} title="Insert Markdown + LaTeX Math Cell" className={btn()}>
        <FileCode2 className="w-3.5 h-3.5 text-indigo-700" />
        <span>+ Math / Note</span>
      </button>

      <div className="h-5 w-px bg-slate-200" />

      {/* Python Environment Selector */}
      <div className="flex items-center gap-1.5">
        <span
          className={`w-2 h-2 rounded-full ${
            isRunning || kernelTransitioning
              ? 'bg-amber-500 animate-pulse'
              : kernelAvailable
                ? 'bg-emerald-500'
                : 'bg-slate-400'
          }`}
          title={
            kernelTransitioning
              ? 'Switching Python kernel'
              : isRunning
              ? 'Kernel Busy'
              : kernelAvailable
                ? 'Native Python Kernel Ready'
                : 'Browser Viewer Mode (open Forma Lab.app to execute Python)'
          }
        />
        {envs.length > 0 ? (
          <select
            aria-label="Python Environment"
            value={activePythonPath}
            disabled={kernelTransitioning}
            onChange={(e) => onSelectPythonPath(e.target.value)}
            className="h-7 max-w-[170px] px-1.5 text-[11px] font-mono bg-slate-50 border border-slate-200 rounded text-slate-700 focus:outline-none focus:border-violet-500"
          >
            {envs.map((env) => (
              <option key={env.path} value={env.path}>
                {env.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-[11px] text-slate-500 flex items-center gap-1">
            <Cpu className="w-3.5 h-3.5" />
            <span className="hidden xl:inline">{kernelAvailable ? 'Python 3' : 'View Only'}</span>
          </span>
        )}
      </div>

      <ReadingModePicker value={readingTheme} onChange={onSelectReadingTheme} />

      <div className="flex-1" />

      {/* Print / Folder / Import / Save / Export */}
      <button onClick={onPrint} title="Print / Save as PDF" className={btn()}>
        <Printer className="w-3.5 h-3.5" />
      </button>

      <button
        onClick={onOpenFolder}
        title="Open Folder Workspace… (⇧⌘O)"
        className="px-2.5 py-1 rounded-md text-xs font-medium text-violet-800 bg-violet-50 hover:bg-violet-100 border border-violet-200/80 flex items-center gap-1.5 transition"
      >
        <FolderOpen className="w-3.5 h-3.5" />
        <span>Folder</span>
      </button>

      {hasNativePath && onSaveToDisk && (
        <button
          onClick={onSaveToDisk}
          title="Save .ipynb directly to disk (⌘S)"
          className="px-2.5 py-1 rounded-md text-xs font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 flex items-center gap-1 transition"
        >
          <Save className="w-3.5 h-3.5" />
          <span>Save</span>
        </button>
      )}

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
          accept=".ipynb"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onImportIpynb(f);
            e.target.value = '';
          }}
        />
      </label>

      <div className="relative">
        <button
          onClick={() => setShowExport((v) => !v)}
          className="px-2.5 py-1 rounded-md text-xs font-semibold text-white bg-violet-600 hover:bg-violet-700 flex items-center gap-1.5 transition shadow-xs"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Export</span>
        </button>
        {showExport && (
          <div className="absolute right-0 top-8 z-40 w-52 bg-white border border-slate-200 rounded-xl shadow-xl py-1.5 text-xs">
            <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Export As
            </div>
            <button
              onClick={() => {
                onExport('ipynb');
                setShowExport(false);
              }}
              className="w-full text-left px-3 py-2 hover:bg-violet-50 flex items-center justify-between"
            >
              <span className="font-medium text-slate-800">Jupyter Notebook</span>
              <span className="text-[10px] text-violet-700 font-mono">.ipynb</span>
            </button>
            <button
              onClick={() => {
                onExport('py');
                setShowExport(false);
              }}
              className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between"
            >
              <span className="text-slate-700">Python Script</span>
              <span className="text-[10px] text-slate-400 font-mono">.py</span>
            </button>
            <button
              onClick={() => {
                onExport('md');
                setShowExport(false);
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
