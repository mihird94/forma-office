import React from 'react';
import { Minus, Plus } from 'lucide-react';

interface ZoomControlProps {
  zoom: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onZoomReset: () => void;
  dark?: boolean;
}

export const ZoomControl: React.FC<ZoomControlProps> = ({
  zoom,
  onZoomOut,
  onZoomIn,
  onZoomReset,
  dark = false,
}) => (
  <div
    className={`inline-flex items-center gap-0.5 rounded-md border px-0.5 py-0.5 text-[11px] font-mono select-none ${
      dark
        ? 'bg-slate-800/80 border-slate-700 text-slate-200'
        : 'bg-white border-slate-200/90 text-slate-700'
    }`}
  >
    <button
      type="button"
      onClick={onZoomOut}
      title="Zoom Out (⌘-)"
      className={`p-0.5 rounded transition ${
        dark ? 'hover:bg-slate-700 text-slate-300' : 'hover:bg-slate-100 text-slate-600'
      }`}
    >
      <Minus className="w-3 h-3" />
    </button>
    <button
      type="button"
      onClick={onZoomReset}
      title="Reset Zoom (⌘0)"
      className={`px-1.5 py-0.5 rounded min-w-[40px] text-center transition ${
        dark ? 'hover:bg-slate-700' : 'hover:bg-slate-100'
      }`}
    >
      {Math.round(zoom * 100)}%
    </button>
    <button
      type="button"
      onClick={onZoomIn}
      title="Zoom In (⌘+)"
      className={`p-0.5 rounded transition ${
        dark ? 'hover:bg-slate-700 text-slate-300' : 'hover:bg-slate-100 text-slate-600'
      }`}
    >
      <Plus className="w-3 h-3" />
    </button>
  </div>
);
