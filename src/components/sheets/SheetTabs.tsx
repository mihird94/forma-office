import React, { useState } from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { SheetData } from '../../types/spreadsheet';
import { ZoomControl } from '../common/ZoomControl';

interface SelectionStats {
  count: number;
  numericCount: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
}

interface SheetTabsProps {
  sheets: SheetData[];
  activeSheetId: string;
  stats: SelectionStats;
  zoom: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onZoomReset: () => void;
  onSelectSheet: (id: string) => void;
  onAddSheet: () => void;
  onRenameSheet: (id: string, name: string) => void;
  onDuplicateSheet: (id: string) => void;
  onDeleteSheet: (id: string) => void;
}

export const SheetTabs: React.FC<SheetTabsProps> = ({
  sheets,
  activeSheetId,
  stats,
  zoom,
  onZoomOut,
  onZoomIn,
  onZoomReset,
  onSelectSheet,
  onAddSheet,
  onRenameSheet,
  onDuplicateSheet,
  onDeleteSheet,
}) => {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  const fmt = (n: number) =>
    Number.isInteger(n)
      ? n.toLocaleString()
      : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

  return (
    <div className="h-9 bg-slate-100 border-t border-slate-200 flex items-center justify-between px-2 shrink-0 select-none">
      {/* Left: Sheet Tabs */}
      <div className="flex items-center gap-1 overflow-x-auto">
        <button
          onClick={onAddSheet}
          title="Add Sheet"
          className="p-1.5 rounded-md text-slate-600 hover:bg-slate-200 hover:text-slate-900 transition"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>

        {sheets.map((s) => {
          const active = s.id === activeSheetId;
          const isRenaming = renamingId === s.id;
          return (
            <div
              key={s.id}
              onClick={() => onSelectSheet(s.id)}
              onDoubleClick={() => {
                setRenamingId(s.id);
                setDraftName(s.name);
              }}
              className={`group flex items-center gap-1.5 px-3 py-1 rounded-t-md text-xs font-medium cursor-pointer border transition ${
                active
                  ? 'bg-white text-emerald-700 border-slate-200 border-b-white shadow-xs -mb-px'
                  : 'bg-slate-100/70 text-slate-600 border-transparent hover:bg-slate-200/70'
              }`}
            >
              {isRenaming ? (
                <input
                  autoFocus
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onBlur={() => {
                    if (draftName.trim()) onRenameSheet(s.id, draftName.trim());
                    setRenamingId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      if (draftName.trim()) onRenameSheet(s.id, draftName.trim());
                      setRenamingId(null);
                    } else if (e.key === 'Escape') {
                      setRenamingId(null);
                    }
                  }}
                  className="w-24 px-1 py-0 text-xs bg-white border border-emerald-500 rounded focus:outline-none"
                />
              ) : (
                <span>{s.name}</span>
              )}

              {active && !isRenaming && (
                <div className="flex items-center gap-0.5 ml-1 opacity-70 group-hover:opacity-100">
                  <button
                    title="Duplicate Sheet"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDuplicateSheet(s.id);
                    }}
                    className="p-0.5 rounded hover:bg-slate-100 text-slate-500"
                  >
                    <Copy className="w-3 h-3" />
                  </button>
                  {sheets.length > 1 && (
                    <button
                      title="Delete Sheet"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteSheet(s.id);
                      }}
                      className="p-0.5 rounded hover:bg-rose-50 text-slate-500 hover:text-rose-600"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Right: Excel-style Live Selection Aggregations */}
      <div className="flex items-center gap-3 text-[11px] text-slate-600 font-mono">
        {stats.count > 0 && <span>Count: <strong className="text-slate-800">{stats.count}</strong></span>}
        {stats.numericCount > 1 && (
          <>
            <span>Sum: <strong className="text-emerald-700">{fmt(stats.sum)}</strong></span>
            <span>Avg: <strong className="text-slate-800">{fmt(stats.avg)}</strong></span>
            <span>Min: <strong className="text-slate-800">{fmt(stats.min)}</strong></span>
            <span>Max: <strong className="text-slate-800">{fmt(stats.max)}</strong></span>
          </>
        )}
        <ZoomControl zoom={zoom} onZoomOut={onZoomOut} onZoomIn={onZoomIn} onZoomReset={onZoomReset} />
      </div>
    </div>
  );
};
