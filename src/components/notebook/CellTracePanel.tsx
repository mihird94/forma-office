import React, { useEffect, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Sparkles,
  X,
} from 'lucide-react';
import { CellTraceData } from '../../types/notebook';

interface CellTracePanelProps {
  trace: CellTraceData;
  stepIndex: number;
  dark: boolean;
  onChangeStep: (nextIndex: number) => void;
  onClose: () => void;
}

export const CellTracePanel: React.FC<CellTracePanelProps> = ({
  trace,
  stepIndex,
  dark,
  onChangeStep,
  onClose,
}) => {
  const [playing, setPlaying] = useState(false);
  const total = trace.steps.length;
  const safeIdx = Math.max(0, Math.min(total - 1, stepIndex));
  const current = trace.steps[safeIdx];

  useEffect(() => {
    if (!playing) return;
    if (safeIdx >= total - 1) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => {
      onChangeStep(safeIdx + 1);
    }, 320);
    return () => clearTimeout(timer);
  }, [playing, safeIdx, total, onChangeStep]);

  if (!current) return null;

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className={`no-print border-t px-4 py-3 space-y-2.5 text-xs ${
        dark
          ? 'bg-slate-900/90 border-amber-500/40 text-slate-200'
          : 'bg-amber-50/60 border-amber-200/90 text-slate-800'
      }`}
    >
      {/* Top Timeline Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="px-2 py-0.5 rounded-md bg-amber-500 text-white text-[10px] font-bold uppercase tracking-wider">
            Trace
          </span>
          <span className="font-mono text-[11px] font-semibold">
            Step {safeIdx + 1} / {total}
          </span>
          <span className={`font-mono text-[11px] ${dark ? 'text-amber-300' : 'text-amber-800'}`}>
            · line {current.line}
            {current.func && current.func !== '<module>' ? ` in ${current.func}()` : ''}
            {current.event === 'return' ? ' (return)' : ''}
          </span>
          {trace.truncated && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-200/70 text-amber-900">
              capped at {total} steps
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            title="First Step"
            disabled={safeIdx === 0}
            onClick={() => {
              setPlaying(false);
              onChangeStep(0);
            }}
            className="p-1 rounded hover:bg-amber-200/50 disabled:opacity-30"
          >
            <SkipBack className="w-3.5 h-3.5" />
          </button>
          <button
            title="Previous Step"
            disabled={safeIdx === 0}
            onClick={() => {
              setPlaying(false);
              onChangeStep(safeIdx - 1);
            }}
            className="p-1 rounded hover:bg-amber-200/50 disabled:opacity-30"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <button
            title={playing ? 'Pause Auto-Step' : 'Animate Steps'}
            onClick={() => {
              if (!playing && safeIdx >= total - 1) onChangeStep(0);
              setPlaying((p) => !p);
            }}
            className="px-2 py-0.5 rounded bg-amber-500 hover:bg-amber-600 text-white font-semibold flex items-center gap-1 text-[11px]"
          >
            {playing ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3 fill-current" />}
            <span>{playing ? 'Pause' : 'Play'}</span>
          </button>
          <button
            title="Next Step"
            disabled={safeIdx >= total - 1}
            onClick={() => {
              setPlaying(false);
              onChangeStep(safeIdx + 1);
            }}
            className="p-1 rounded hover:bg-amber-200/50 disabled:opacity-30"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
          <button
            title="Last Step"
            disabled={safeIdx >= total - 1}
            onClick={() => {
              setPlaying(false);
              onChangeStep(total - 1);
            }}
            className="p-1 rounded hover:bg-amber-200/50 disabled:opacity-30"
          >
            <SkipForward className="w-3.5 h-3.5" />
          </button>
          <button
            title="Close Trace"
            onClick={onClose}
            className="ml-1 p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-200/60"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Timeline Scrubber */}
      <input
        type="range"
        min={0}
        max={Math.max(0, total - 1)}
        value={safeIdx}
        onChange={(e) => {
          setPlaying(false);
          onChangeStep(Number(e.target.value));
        }}
        className="w-full accent-amber-500 cursor-pointer h-1.5"
      />

      {/* Variable State Diff Grid at This Step */}
      <div className="space-y-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wider opacity-60">
          Live Scope State at Step {safeIdx + 1} (changed values highlighted)
        </div>
        {current.locals.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
            {current.locals.map((v) => (
              <div
                key={v.name}
                className={`px-2.5 py-1.5 rounded-lg border text-[11px] font-mono transition ${
                  v.changed
                    ? dark
                      ? 'bg-emerald-950/60 border-emerald-500/70 ring-1 ring-emerald-500/30'
                      : 'bg-emerald-50 border-emerald-400 ring-1 ring-emerald-300/60'
                    : dark
                      ? 'bg-slate-800/70 border-slate-700'
                      : 'bg-white/90 border-slate-200'
                }`}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <span className="font-bold flex items-center gap-1 truncate">
                    {v.changed && <Sparkles className="w-2.5 h-2.5 text-emerald-500 shrink-0" />}
                    <span className={dark ? 'text-violet-300' : 'text-violet-800'}>{v.name}</span>
                  </span>
                  <span
                    className={`text-[10px] px-1 py-0 rounded shrink-0 ${
                      dark ? 'bg-slate-700 text-slate-300' : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {v.type}
                    {v.shape ? ` ${v.shape}` : ''}
                  </span>
                </div>
                <div
                  className={`truncate mt-0.5 ${
                    v.changed
                      ? dark
                        ? 'text-emerald-200 font-semibold'
                        : 'text-emerald-900 font-semibold'
                      : dark
                        ? 'text-slate-400'
                        : 'text-slate-600'
                  }`}
                  title={v.preview}
                >
                  {v.preview}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[11px] opacity-60 italic">No local variables assigned yet at this line.</div>
        )}
      </div>

      {/* Cumulative Stdout up to this Step */}
      {current.stdout && (
        <div
          className={`rounded-lg px-2.5 py-1.5 font-mono text-[11px] whitespace-pre-wrap max-h-24 overflow-y-auto border ${
            dark
              ? 'bg-slate-950/70 border-slate-700 text-slate-200'
              : 'bg-white/90 border-amber-200/80 text-slate-800'
          }`}
        >
          <div className="text-[9px] font-sans uppercase tracking-wider opacity-55 mb-0.5">
            stdout up to step {safeIdx + 1}
          </div>
          {current.stdout}
        </div>
      )}
    </div>
  );
};
