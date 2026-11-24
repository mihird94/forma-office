import React, { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { FUNCTION_CATALOG } from '../../engine/spreadsheet/formulaEngine';

interface FunctionHelpModalProps {
  onInsert: (template: string) => void;
  onClose: () => void;
}

export const FunctionHelpModal: React.FC<FunctionHelpModalProps> = ({ onInsert, onClose }) => {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('All');

  const categories = ['All', 'Math & Stats', 'Logical', 'Lookup', 'Text', 'Financial', 'Date'];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return FUNCTION_CATALOG.filter((fn) => {
      if (category !== 'All' && fn.category !== category) return false;
      if (!q) return true;
      return (
        fn.name.toLowerCase().includes(q) ||
        fn.description.toLowerCase().includes(q) ||
        fn.signature.toLowerCase().includes(q)
      );
    });
  }, [query, category]);

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[1px] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-slate-900 text-sm">Function Catalog (fx)</h3>
            <p className="text-xs text-slate-500">
              Excel &amp; OpenFormula compatible functions — click any function to insert
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 border-b border-slate-100 space-y-2.5">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search functions (e.g. SUMIF, XLOOKUP, PMT, IRR)..."
              className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition ${
                  category === cat
                    ? 'bg-emerald-600 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
          {filtered.map((fn) => (
            <button
              key={fn.name}
              onClick={() => {
                onInsert(`=${fn.name}(`);
                onClose();
              }}
              className="w-full text-left px-5 py-3 hover:bg-emerald-50/60 transition flex items-start justify-between gap-4"
            >
              <div>
                <div className="font-mono text-xs font-semibold text-emerald-700">
                  {fn.signature}
                </div>
                <div className="text-xs text-slate-600 mt-0.5">{fn.description}</div>
              </div>
              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 shrink-0">
                {fn.category}
              </span>
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="p-8 text-center text-xs text-slate-400">
              No matching functions found.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
