import React, { useEffect, useState } from 'react';
import { Palette, Plus, Trash2, X } from 'lucide-react';
import { ConditionalFormatKind, ConditionalFormatRule } from '../../types/spreadsheet';
import { parseRange } from '../../engine/spreadsheet/address';
import { uid } from '../../engine/spreadsheet/workbookOps';

interface ConditionalFormatModalProps {
  selectedRangeA1: string;
  rules: ConditionalFormatRule[];
  onAddRule: (rule: ConditionalFormatRule) => void;
  onDeleteRule: (id: string) => void;
  onClose: () => void;
}

const RULE_KIND_LABELS: Record<ConditionalFormatKind, string> = {
  greaterThan: 'Greater Than (>)',
  lessThan: 'Less Than (<)',
  equals: 'Equals (=)',
  contains: 'Text Contains',
  colorScale: 'Green–Yellow–Red Color Scale',
  dataBar: 'Data Bar (Horizontal Fill)',
};

const HIGHLIGHT_PRESETS = [
  { label: 'Emerald', color: '#14532d', backgroundColor: '#dcfce7' },
  { label: 'Rose', color: '#991b1b', backgroundColor: '#fee2e2' },
  { label: 'Amber', color: '#92400e', backgroundColor: '#fef3c7' },
  { label: 'Blue', color: '#1e40af', backgroundColor: '#dbeafe' },
  { label: 'Violet', color: '#5b21b6', backgroundColor: '#ede9fe' },
];

const DATABAR_PRESETS = [
  { label: 'Emerald', backgroundColor: '#86efac' },
  { label: 'Sky Blue', backgroundColor: '#93c5fd' },
  { label: 'Amber', backgroundColor: '#fcd34d' },
  { label: 'Rose', backgroundColor: '#fda4af' },
  { label: 'Violet', backgroundColor: '#c4b5fd' },
];

export const ConditionalFormatModal: React.FC<ConditionalFormatModalProps> = ({
  selectedRangeA1,
  rules,
  onAddRule,
  onDeleteRule,
  onClose,
}) => {
  const [range, setRange] = useState(selectedRangeA1);
  const [kind, setKind] = useState<ConditionalFormatKind>('greaterThan');
  const [value, setValue] = useState('0');
  const [color, setColor] = useState(HIGHLIGHT_PRESETS[0].color);
  const [backgroundColor, setBackgroundColor] = useState(HIGHLIGHT_PRESETS[0].backgroundColor);
  const [barColor, setBarColor] = useState(DATABAR_PRESETS[0].backgroundColor);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const needsValue =
    kind === 'greaterThan' || kind === 'lessThan' || kind === 'equals' || kind === 'contains';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanedRange = range.trim().toUpperCase();
    if (!parseRange(cleanedRange)) {
      setError('Enter a valid A1 range (e.g. B5:E14).');
      return;
    }
    if (needsValue && value.trim() === '') {
      setError('Enter a comparison value.');
      return;
    }
    if ((kind === 'greaterThan' || kind === 'lessThan') && isNaN(Number(value.trim()))) {
      setError('Greater Than / Less Than requires a numeric threshold.');
      return;
    }
    setError(null);

    const newRule: ConditionalFormatRule = {
      id: uid('cf'),
      range: cleanedRange,
      kind,
      ...(needsValue ? { value: value.trim() } : {}),
      ...(kind === 'dataBar'
        ? { backgroundColor: barColor }
        : kind === 'colorScale'
          ? {}
          : { color, backgroundColor }),
    };
    onAddRule(newRule);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[1px] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-xl max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center">
              <Palette className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-900 text-sm">Conditional Formatting</h3>
              <p className="text-xs text-slate-500">
                Highlight cells dynamically with rules, color scales, or data bars
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 border-b border-slate-100 space-y-3.5 bg-slate-50/50">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                Apply to Range
              </label>
              <input
                value={range}
                onChange={(e) => setRange(e.target.value)}
                placeholder="B5:E14"
                className="w-full px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500"
              />
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                Rule Type
              </label>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as ConditionalFormatKind)}
                className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500"
              >
                {(Object.keys(RULE_KIND_LABELS) as ConditionalFormatKind[]).map((k) => (
                  <option key={k} value={k}>
                    {RULE_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {needsValue && (
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                {kind === 'contains' ? 'Text to Match' : 'Threshold / Value'}
              </label>
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={kind === 'contains' ? 'e.g. Healthy' : 'e.g. 100000'}
                className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500"
              />
            </div>
          )}

          {needsValue && (
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1.5">
                Highlight Style
              </label>
              <div className="flex flex-wrap items-center gap-2">
                {HIGHLIGHT_PRESETS.map((preset) => {
                  const selected =
                    color === preset.color && backgroundColor === preset.backgroundColor;
                  return (
                    <button
                      type="button"
                      key={preset.label}
                      onClick={() => {
                        setColor(preset.color);
                        setBackgroundColor(preset.backgroundColor);
                      }}
                      style={{ color: preset.color, backgroundColor: preset.backgroundColor }}
                      className={`px-2.5 py-1 rounded-md text-xs font-semibold border transition ${
                        selected ? 'border-slate-800 ring-1 ring-slate-800' : 'border-slate-200'
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {kind === 'colorScale' && (
            <div className="p-2.5 rounded-lg bg-white border border-slate-200 flex items-center justify-between gap-3">
              <span className="text-xs text-slate-600">Min → Mid → Max scale</span>
              <div
                className="h-4 flex-1 max-w-[220px] rounded-full border border-slate-200"
                style={{
                  background: 'linear-gradient(to right, #fecaca, #fef08a, #bbf7d0)',
                }}
              />
            </div>
          )}

          {kind === 'dataBar' && (
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1.5">
                Data Bar Color
              </label>
              <div className="flex flex-wrap items-center gap-2">
                {DATABAR_PRESETS.map((preset) => (
                  <button
                    type="button"
                    key={preset.label}
                    onClick={() => setBarColor(preset.backgroundColor)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium border bg-white flex items-center gap-1.5 transition ${
                      barColor === preset.backgroundColor
                        ? 'border-slate-800 ring-1 ring-slate-800'
                        : 'border-slate-200'
                    }`}
                  >
                    <span
                      className="w-3 h-3 rounded-xs inline-block"
                      style={{ backgroundColor: preset.backgroundColor }}
                    />
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && <div className="text-xs text-rose-600 font-medium">{error}</div>}

          <div className="flex justify-end">
            <button
              type="submit"
              className="px-3.5 py-1.5 rounded-lg text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 flex items-center gap-1.5 transition shadow-xs"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Rule
            </button>
          </div>
        </form>

        <div className="flex-1 overflow-y-auto p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">
            Active Rules ({rules.length})
          </div>
          {rules.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400">
              No conditional formatting rules on this sheet yet.
            </div>
          ) : (
            <div className="space-y-2">
              {rules.map((rule) => (
                <div
                  key={rule.id}
                  className="px-3 py-2.5 rounded-xl border border-slate-200 bg-white flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {rule.kind === 'colorScale' ? (
                      <div
                        className="w-10 h-6 rounded border border-slate-200 shrink-0"
                        style={{
                          background: 'linear-gradient(to right, #fecaca, #fef08a, #bbf7d0)',
                        }}
                      />
                    ) : rule.kind === 'dataBar' ? (
                      <div
                        className="w-10 h-6 rounded border border-slate-200 shrink-0"
                        style={{
                          background: `linear-gradient(to right, ${rule.backgroundColor || '#86efac'} 68%, #f8fafc 68%)`,
                        }}
                      />
                    ) : (
                      <div
                        className="w-10 h-6 rounded border border-slate-200 flex items-center justify-center text-[11px] font-bold shrink-0"
                        style={{
                          color: rule.color || '#14532d',
                          backgroundColor: rule.backgroundColor || '#dcfce7',
                        }}
                      >
                        Aa
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">
                          {rule.range}
                        </span>
                        <span className="text-xs font-medium text-slate-800 truncate">
                          {RULE_KIND_LABELS[rule.kind]}
                          {rule.value !== undefined && rule.value !== '' ? ` "${rule.value}"` : ''}
                        </span>
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => onDeleteRule(rule.id)}
                    title="Delete Rule"
                    className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
