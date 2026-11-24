import React from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Copy,
  Lock,
  Minus,
  PenTool,
  Plus,
  Sparkles,
  Trash2,
  Type,
  Unlock,
} from 'lucide-react';
import { CanvasElement } from '../../types/canvas';

export interface CanvasInspectorProps {
  selectedElements: CanvasElement[];
  theme: 'light' | 'dark';
  onPatchSelected: (patch: Partial<CanvasElement>) => void;
  onEditText?: () => void;
  onArrange: (direction: 'forward' | 'backward' | 'front' | 'back') => void;
  onDuplicate: () => void;
  onToggleLock: () => void;
  onDelete: () => void;
}

const STROKE_SWATCHES = [
  { color: '#0f172a', label: 'Slate Ink' },
  { color: '#475569', label: 'Cool Gray' },
  { color: '#0d9488', label: 'Teal' },
  { color: '#2563eb', label: 'Blue' },
  { color: '#7c3aed', label: 'Violet' },
  { color: '#059669', label: 'Emerald' },
  { color: '#d97706', label: 'Amber' },
  { color: '#e11d48', label: 'Rose' },
  { color: '#ffffff', label: 'White' },
];

const FILL_SWATCHES = [
  { color: 'transparent', label: 'Transparent' },
  { color: '#ffffff', label: 'White' },
  { color: '#f8fafc', label: 'Cloud' },
  { color: '#fef08a', label: 'Sticky Canary' },
  { color: '#fed7aa', label: 'Sticky Peach' },
  { color: '#bbf7d0', label: 'Sticky Mint' },
  { color: '#bfdbfe', label: 'Sticky Sky' },
  { color: '#ddd6fe', label: 'Sticky Lavender' },
  { color: '#fecdd3', label: 'Sticky Rose' },
  { color: '#ccfbf1', label: 'Soft Teal' },
  { color: '#0f172a', label: 'Deep Slate' },
  { color: '#0d9488', label: 'Accent Teal' },
];

const STROKE_WIDTHS: Array<{ value: number; label: string }> = [
  { value: 1.5, label: 'Thin' },
  { value: 2.5, label: 'Medium' },
  { value: 4, label: 'Bold' },
];

const STROKE_STYLES: Array<{ value: 'solid' | 'dashed' | 'dotted'; label: string }> = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' },
];

const FONT_FAMILIES: Array<{ value: 'sans' | 'hand' | 'mono'; label: string }> = [
  { value: 'sans', label: 'Sans' },
  { value: 'hand', label: 'Hand' },
  { value: 'mono', label: 'Mono' },
];

function kindDisplayName(kind: CanvasElement['kind']): string {
  switch (kind) {
    case 'rect':
      return 'Rectangle';
    case 'roundRect':
      return 'Rounded Box';
    case 'diamond':
      return 'Diamond';
    case 'ellipse':
      return 'Ellipse';
    case 'sticky':
      return 'Sticky Note';
    case 'text':
      return 'Text';
    case 'arrow':
      return 'Arrow';
    case 'line':
      return 'Line';
    case 'freehand':
      return 'Freehand';
    case 'frame':
      return 'Frame';
    case 'image':
      return 'Image';
  }
}

export const CanvasInspector: React.FC<CanvasInspectorProps> = ({
  selectedElements,
  theme,
  onPatchSelected,
  onEditText,
  onArrange,
  onDuplicate,
  onToggleLock,
  onDelete,
}) => {
  if (selectedElements.length === 0) return null;

  const primary = selectedElements[0];
  const allLocked = selectedElements.every((e) => Boolean(e.locked));
  const anyLocked = selectedElements.some((e) => Boolean(e.locked));
  const isDark = theme === 'dark';

  const hasFillable = selectedElements.some(
    (e) =>
      e.kind === 'rect' ||
      e.kind === 'roundRect' ||
      e.kind === 'diamond' ||
      e.kind === 'ellipse' ||
      e.kind === 'sticky' ||
      e.kind === 'frame'
  );
  const hasStrokeable = selectedElements.some((e) => e.kind !== 'image');
  const hasText = selectedElements.some((e) => e.kind !== 'freehand' && e.kind !== 'image');
  const hasRoughness = selectedElements.some(
    (e) => e.kind !== 'text' && e.kind !== 'freehand' && e.kind !== 'image' && e.kind !== 'frame'
  );

  const activeStroke = primary.stroke ?? (isDark ? '#e2e8f0' : '#0f172a');
  const activeFill = primary.fill ?? 'transparent';
  const activeWidth = primary.strokeWidth ?? 2;
  const activeStyle = primary.strokeStyle ?? 'solid';
  const activeRoughness = primary.roughness ?? 0;
  const activeFont = primary.fontFamily ?? 'sans';
  const activeFontSize = primary.fontSize ?? (primary.kind === 'text' ? 18 : 14);
  const activeAlign = primary.textAlign ?? (primary.kind === 'sticky' || primary.kind === 'text' ? 'left' : 'center');
  const activeOpacity = Math.round((primary.opacity ?? 1) * 100);

  const cardBg = isDark
    ? 'bg-slate-900/95 border-slate-700/90 text-slate-100'
    : 'bg-white/95 border-slate-200/90 text-slate-800';
  const sectionLabel = isDark ? 'text-slate-400' : 'text-slate-500';
  const btnIdle = isDark
    ? 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
    : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200';
  const btnActive = isDark
    ? 'bg-teal-500/20 text-teal-300 border-teal-500/60'
    : 'bg-teal-50 text-teal-700 border-teal-400';

  const headerTitle =
    selectedElements.length === 1
      ? kindDisplayName(primary.kind)
      : `${selectedElements.length} elements`;

  return (
    <div
      className={`absolute left-4 top-20 z-30 w-[236px] max-h-[calc(100%-7.5rem)] overflow-y-auto rounded-2xl border backdrop-blur-md shadow-xl p-3 space-y-3 text-xs select-none ${cardBg}`}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-200/60 dark:border-slate-700/60 pb-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="inline-block w-2 h-2 rounded-full bg-teal-500 shrink-0" />
          <span className="font-semibold truncate">{headerTitle}</span>
        </div>
        {anyLocked ? (
          <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[10px] font-medium">
            Locked
          </span>
        ) : (
          onEditText && (
            <button
              type="button"
              onClick={onEditText}
              title="Edit text inside element (Double-click or Enter)"
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[10px] font-medium transition-colors ${btnActive}`}
            >
              <Type className="w-3 h-3" />
              <span>Edit Text</span>
            </button>
          )
        )}
      </div>

      {/* Stroke Color */}
      {hasStrokeable && (
        <div className="space-y-1.5">
          <div className={`text-[10px] font-semibold uppercase tracking-wider ${sectionLabel}`}>
            {primary.kind === 'text' ? 'Text Color' : 'Stroke'}
          </div>
          <div className="grid grid-cols-9 gap-1">
            {STROKE_SWATCHES.map((s) => {
              const selected = activeStroke.toLowerCase() === s.color.toLowerCase();
              return (
                <button
                  key={s.color}
                  type="button"
                  title={s.label}
                  onClick={() => onPatchSelected({ stroke: s.color })}
                  className={`w-5 h-5 rounded-md border transition-transform hover:scale-110 ${
                    selected
                      ? 'ring-2 ring-teal-500 ring-offset-1 border-slate-400'
                      : 'border-slate-300/80 dark:border-slate-600'
                  }`}
                  style={{ backgroundColor: s.color }}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Fill Color */}
      {hasFillable && (
        <div className="space-y-1.5">
          <div className={`text-[10px] font-semibold uppercase tracking-wider ${sectionLabel}`}>
            Fill
          </div>
          <div className="grid grid-cols-6 gap-1.5">
            {FILL_SWATCHES.map((s) => {
              const selected = activeFill.toLowerCase() === s.color.toLowerCase();
              const isTrans = s.color === 'transparent';
              return (
                <button
                  key={s.color}
                  type="button"
                  title={s.label}
                  onClick={() => onPatchSelected({ fill: s.color })}
                  className={`w-7 h-5 rounded-md border relative overflow-hidden transition-transform hover:scale-105 ${
                    selected
                      ? 'ring-2 ring-teal-500 ring-offset-1 border-slate-400'
                      : 'border-slate-300/80 dark:border-slate-600'
                  }`}
                  style={{
                    backgroundColor: isTrans ? (isDark ? '#1e293b' : '#ffffff') : s.color,
                  }}
                >
                  {isTrans && (
                    <span className="absolute inset-0 flex items-center justify-center">
                      <span className="w-full h-[1.5px] bg-rose-500/80 -rotate-25 block" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Stroke Width & Style */}
      {hasStrokeable && primary.kind !== 'text' && (
        <div className="space-y-2">
          <div className="space-y-1">
            <div className={`text-[10px] font-semibold uppercase tracking-wider ${sectionLabel}`}>
              Stroke Width
            </div>
            <div className="grid grid-cols-3 gap-1">
              {STROKE_WIDTHS.map((w) => {
                const isSelected = Math.abs(activeWidth - w.value) < 0.6;
                return (
                  <button
                    key={w.value}
                    type="button"
                    title={w.label}
                    onClick={() => onPatchSelected({ strokeWidth: w.value })}
                    className={`h-7 rounded-lg border flex items-center justify-center transition-colors ${
                      isSelected ? btnActive : btnIdle
                    }`}
                  >
                    <span
                      className="w-7 rounded-full bg-current"
                      style={{ height: `${Math.max(1.5, w.value)}px` }}
                    />
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1">
            <div className={`text-[10px] font-semibold uppercase tracking-wider ${sectionLabel}`}>
              Stroke Style
            </div>
            <div className="grid grid-cols-3 gap-1">
              {STROKE_STYLES.map((st) => {
                const isSelected = activeStyle === st.value;
                return (
                  <button
                    key={st.value}
                    type="button"
                    title={st.label}
                    onClick={() => onPatchSelected({ strokeStyle: st.value })}
                    className={`h-7 rounded-lg border flex items-center justify-center px-1.5 transition-colors ${
                      isSelected ? btnActive : btnIdle
                    }`}
                  >
                    <svg width="28" height="6" viewBox="0 0 28 6" className="overflow-visible">
                      <line
                        x1="1"
                        y1="3"
                        x2="27"
                        y2="3"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeDasharray={
                          st.value === 'dashed' ? '6 4' : st.value === 'dotted' ? '2 4' : undefined
                        }
                      />
                    </svg>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Style: Clean vs Sketchy */}
      {hasRoughness && (
        <div className="space-y-1">
          <div className={`text-[10px] font-semibold uppercase tracking-wider ${sectionLabel}`}>
            Rendering
          </div>
          <div className="grid grid-cols-2 gap-1">
            <button
              type="button"
              onClick={() => onPatchSelected({ roughness: 0 })}
              className={`h-7 rounded-lg border flex items-center justify-center gap-1.5 font-medium transition-colors ${
                activeRoughness === 0 ? btnActive : btnIdle
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              Clean
            </button>
            <button
              type="button"
              onClick={() => onPatchSelected({ roughness: 1 })}
              className={`h-7 rounded-lg border flex items-center justify-center gap-1.5 font-medium transition-colors ${
                activeRoughness === 1 ? btnActive : btnIdle
              }`}
            >
              <PenTool className="w-3.5 h-3.5" />
              Sketchy
            </button>
          </div>
        </div>
      )}

      {/* Typography */}
      {hasText && (
        <div className="space-y-2">
          <div className={`text-[10px] font-semibold uppercase tracking-wider ${sectionLabel}`}>
            Typography
          </div>
          <div className="grid grid-cols-3 gap-1">
            {FONT_FAMILIES.map((ff) => (
              <button
                key={ff.value}
                type="button"
                onClick={() => onPatchSelected({ fontFamily: ff.value })}
                className={`h-7 rounded-lg border text-[11px] font-medium transition-colors ${
                  activeFont === ff.value ? btnActive : btnIdle
                }`}
                style={{
                  fontFamily:
                    ff.value === 'mono'
                      ? 'ui-monospace, monospace'
                      : ff.value === 'hand'
                        ? 'cursive'
                        : 'inherit',
                }}
              >
                {ff.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            <div className="flex items-center rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden flex-1">
              <button
                type="button"
                title="Decrease font size"
                onClick={() => onPatchSelected({ fontSize: Math.max(10, activeFontSize - 2) })}
                className={`h-7 px-2 transition-colors ${btnIdle} border-0`}
              >
                <Minus className="w-3 h-3" />
              </button>
              <span className="flex-1 text-center font-semibold text-[11px] tabular-nums">
                {activeFontSize}px
              </span>
              <button
                type="button"
                title="Increase font size"
                onClick={() => onPatchSelected({ fontSize: Math.min(64, activeFontSize + 2) })}
                className={`h-7 px-2 transition-colors ${btnIdle} border-0`}
              >
                <Plus className="w-3 h-3" />
              </button>
            </div>

            <div className="flex items-center gap-0.5">
              {(
                [
                  { id: 'left', icon: AlignLeft },
                  { id: 'center', icon: AlignCenter },
                  { id: 'right', icon: AlignRight },
                ] as const
              ).map((al) => {
                const Icon = al.icon;
                return (
                  <button
                    key={al.id}
                    type="button"
                    title={`Align ${al.id}`}
                    onClick={() => onPatchSelected({ textAlign: al.id })}
                    className={`w-7 h-7 rounded-lg border flex items-center justify-center transition-colors ${
                      activeAlign === al.id ? btnActive : btnIdle
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Opacity */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className={`text-[10px] font-semibold uppercase tracking-wider ${sectionLabel}`}>
            Opacity
          </span>
          <span className="text-[11px] font-medium tabular-nums">{activeOpacity}%</span>
        </div>
        <input
          type="range"
          min={10}
          max={100}
          step={5}
          value={activeOpacity}
          onChange={(e) => onPatchSelected({ opacity: Number(e.target.value) / 100 })}
          className="w-full accent-teal-600 cursor-pointer h-1.5"
        />
      </div>

      {/* Arrange */}
      <div className="space-y-1">
        <div className={`text-[10px] font-semibold uppercase tracking-wider ${sectionLabel}`}>
          Arrange
        </div>
        <div className="grid grid-cols-4 gap-1">
          <button
            type="button"
            title="Send to Back"
            onClick={() => onArrange('back')}
            className={`h-7 rounded-lg border flex items-center justify-center transition-colors ${btnIdle}`}
          >
            <ArrowDownToLine className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            title="Send Backward"
            onClick={() => onArrange('backward')}
            className={`h-7 rounded-lg border flex items-center justify-center transition-colors ${btnIdle}`}
          >
            <ArrowDown className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            title="Bring Forward"
            onClick={() => onArrange('forward')}
            className={`h-7 rounded-lg border flex items-center justify-center transition-colors ${btnIdle}`}
          >
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            title="Bring to Front"
            onClick={() => onArrange('front')}
            className={`h-7 rounded-lg border flex items-center justify-center transition-colors ${btnIdle}`}
          >
            <ArrowUpToLine className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Actions */}
      <div className="grid grid-cols-3 gap-1 pt-1 border-t border-slate-200/60 dark:border-slate-700/60">
        <button
          type="button"
          title="Duplicate (⌘D)"
          onClick={onDuplicate}
          className={`h-8 rounded-lg border flex items-center justify-center gap-1 font-medium transition-colors ${btnIdle}`}
        >
          <Copy className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          title={allLocked ? 'Unlock' : 'Lock'}
          onClick={onToggleLock}
          className={`h-8 rounded-lg border flex items-center justify-center gap-1 font-medium transition-colors ${
            allLocked ? btnActive : btnIdle
          }`}
        >
          {allLocked ? <Unlock className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
        </button>
        <button
          type="button"
          title="Delete (⌫)"
          onClick={onDelete}
          className="h-8 rounded-lg border border-rose-200 dark:border-rose-800/70 bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 hover:bg-rose-100 dark:hover:bg-rose-900/50 flex items-center justify-center transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
