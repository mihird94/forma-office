import React, { useEffect, useMemo, useState } from 'react';
import { Table2, X } from 'lucide-react';
import {
  ComputedCell,
  PivotAggregation,
  SheetData,
} from '../../types/spreadsheet';
import {
  buildPivotTable,
  extractRangeHeaders,
  pivotToSheetData,
} from '../../engine/spreadsheet/pivotEngine';

interface PivotModalProps {
  sheet: SheetData;
  computed: Record<string, ComputedCell>;
  initialRangeA1: string;
  onCreatePivotSheet: (pivotSheet: SheetData) => void;
  onClose: () => void;
}

const AGG_OPTIONS: Array<{ value: PivotAggregation; label: string }> = [
  { value: 'sum', label: 'SUM' },
  { value: 'avg', label: 'AVG' },
  { value: 'count', label: 'COUNT' },
  { value: 'min', label: 'MIN' },
  { value: 'max', label: 'MAX' },
];

function formatPreviewNumber(val: number, agg: PivotAggregation): string {
  if (!Number.isFinite(val)) return '0';
  if (agg === 'count' || Number.isInteger(val)) {
    return val.toLocaleString('en-US');
  }
  return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const PivotModal: React.FC<PivotModalProps> = ({
  sheet,
  computed,
  initialRangeA1,
  onCreatePivotSheet,
  onClose,
}) => {
  const [sourceRange, setSourceRange] = useState(initialRangeA1);
  const [agg, setAgg] = useState<PivotAggregation>('sum');
  const [sheetName, setSheetName] = useState(`Pivot - ${sheet.name}`);

  const fields = useMemo(
    () => extractRangeHeaders(sheet, computed, sourceRange),
    [sheet, computed, sourceRange]
  );

  const [rowField, setRowField] = useState<number>(0);
  const [colField, setColField] = useState<string>('');
  const [valueField, setValueField] = useState<number>(() => {
    const firstNumeric = fields.find((f) => f.isNumeric && f.index !== 0);
    return firstNumeric ? firstNumeric.index : Math.max(0, fields.length - 1);
  });

  // Clamp field selections cleanly when the user edits sourceRange
  useEffect(() => {
    if (fields.length === 0) return;
    if (rowField >= fields.length) setRowField(0);
    if (colField !== '' && Number(colField) >= fields.length) setColField('');
    if (valueField >= fields.length) {
      const firstNum = fields.find((f) => f.isNumeric && f.index !== 0);
      setValueField(firstNum ? firstNum.index : fields.length - 1);
    }
  }, [fields, rowField, colField, valueField]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const preview = useMemo(() => {
    if (fields.length === 0) {
      return { headers: [], rows: [], rowTotals: [], colTotals: [], grandTotal: 0 };
    }
    return buildPivotTable(sheet, computed, {
      sourceRange,
      rowField,
      colField: colField === '' ? undefined : Number(colField),
      valueField,
      agg,
    });
  }, [sheet, computed, sourceRange, fields.length, rowField, colField, valueField, agg]);

  const is2D = preview.headers.length > 2;
  const canCreate = preview.headers.length > 0 && preview.rows.length > 0;

  const handleCreate = () => {
    if (!canCreate) return;
    const cleanName = sheetName.trim() || `Pivot - ${sheet.name}`;
    const newSheet = pivotToSheetData(cleanName, preview);
    onCreatePivotSheet(newSheet);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[1px] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center">
              <Table2 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-900 text-sm">Create Pivot Table</h3>
              <p className="text-xs text-slate-500">
                Summarize and cross-tabulate data from <span className="font-medium text-slate-700">{sheet.name}</span>
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

        {/* Configuration Controls */}
        <div className="p-5 border-b border-slate-100 bg-slate-50/60 space-y-3.5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                Source Data Range
              </label>
              <input
                value={sourceRange}
                onChange={(e) => setSourceRange(e.target.value)}
                placeholder="A1:G20"
                className="w-full px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                Destination Sheet Name
              </label>
              <input
                value={sheetName}
                onChange={(e) => setSheetName(e.target.value)}
                placeholder="Pivot Table"
                className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                Row Field
              </label>
              <select
                value={rowField}
                onChange={(e) => setRowField(Number(e.target.value))}
                disabled={fields.length === 0}
                className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500"
              >
                {fields.map((f) => (
                  <option key={f.index} value={f.index}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                Column Field (Optional)
              </label>
              <select
                value={colField}
                onChange={(e) => setColField(e.target.value)}
                disabled={fields.length === 0}
                className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500"
              >
                <option value="">None (1D Summary)</option>
                {fields.map((f) => (
                  <option key={f.index} value={String(f.index)}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                Value Field
              </label>
              <select
                value={valueField}
                onChange={(e) => setValueField(Number(e.target.value))}
                disabled={fields.length === 0}
                className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500"
              >
                {fields.map((f) => (
                  <option key={f.index} value={f.index}>
                    {f.label} {f.isNumeric ? '(Numeric)' : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold text-slate-600">Aggregation:</span>
            <div className="flex items-center gap-1">
              {AGG_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setAgg(opt.value)}
                  className={`px-2.5 py-1 rounded-md text-xs font-semibold transition ${
                    agg === opt.value
                      ? 'bg-emerald-600 text-white shadow-xs'
                      : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Live Preview */}
        <div className="flex-1 overflow-auto p-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Live Preview
            </span>
            {canCreate && (
              <span className="text-[11px] text-slate-500">
                {preview.rows.length} group{preview.rows.length === 1 ? '' : 's'} · {preview.headers.length} columns
              </span>
            )}
          </div>

          {!canCreate ? (
            <div className="py-12 text-center text-xs text-slate-400 border border-dashed border-slate-200 rounded-xl">
              Select a valid table range with a header row and at least one data row to preview.
            </div>
          ) : (
            <div className="border border-slate-200 rounded-xl overflow-auto max-h-[300px]">
              <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-slate-900 text-white">
                    {preview.headers.map((h, i) => (
                      <th
                        key={i}
                        className={`px-3 py-2 font-semibold border-r border-slate-700 last:border-r-0 whitespace-nowrap ${
                          i === 0 ? 'text-left' : 'text-right'
                        }`}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {preview.rows.slice(0, 100).map((row, rIdx) => (
                    <tr key={rIdx} className={rIdx % 2 === 1 ? 'bg-slate-50/70' : 'bg-white'}>
                      {row.map((val, cIdx) => {
                        const isTotalCol = is2D && cIdx === row.length - 1;
                        return (
                          <td
                            key={cIdx}
                            className={`px-3 py-1.5 border-r border-slate-100 last:border-r-0 whitespace-nowrap ${
                              cIdx === 0
                                ? 'font-medium text-slate-800 text-left'
                                : `font-mono text-right ${
                                    isTotalCol ? 'font-semibold bg-slate-100/70 text-slate-900' : 'text-slate-700'
                                  }`
                            }`}
                          >
                            {typeof val === 'number' ? formatPreviewNumber(val, agg) : val}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-emerald-50 text-emerald-950 font-semibold border-t-2 border-emerald-500">
                    <td className="px-3 py-2 text-left border-r border-emerald-200">Grand Total</td>
                    {is2D ? (
                      <>
                        {preview.colTotals.map((ct, i) => (
                          <td
                            key={i}
                            className="px-3 py-2 text-right font-mono border-r border-emerald-200 whitespace-nowrap"
                          >
                            {formatPreviewNumber(ct, agg)}
                          </td>
                        ))}
                        <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                          {formatPreviewNumber(preview.grandTotal, agg)}
                        </td>
                      </>
                    ) : (
                      <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                        {formatPreviewNumber(preview.grandTotal, agg)}
                      </td>
                    )}
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-200/70 transition"
          >
            Cancel
          </button>
          <button
            disabled={!canCreate}
            onClick={handleCreate}
            className="px-4 py-1.5 rounded-lg text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 transition shadow-xs"
          >
            Create Pivot Sheet
          </button>
        </div>
      </div>
    </div>
  );
};
