import React, { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';

interface FormulaBarProps {
  addressLabel: string;
  formulaValue: string;
  isEditing: boolean;
  errorText?: string;
  onJumpToAddress: (addr: string) => void;
  onStartEdit: () => void;
  onChange: (val: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onOpenFunctionCatalog: () => void;
}

export const FormulaBar: React.FC<FormulaBarProps> = ({
  addressLabel,
  formulaValue,
  isEditing,
  errorText,
  onJumpToAddress,
  onStartEdit,
  onChange,
  onCommit,
  onCancel,
  onOpenFunctionCatalog,
}) => {
  const [nameBoxVal, setNameBoxVal] = useState(addressLabel);

  useEffect(() => {
    setNameBoxVal(addressLabel);
  }, [addressLabel]);

  return (
    <div className="h-9 bg-white border-b border-slate-200 flex items-center px-2 gap-1.5 shrink-0">
      {/* Name Box */}
      <input
        aria-label="Cell Address"
        value={nameBoxVal}
        onChange={(e) => setNameBoxVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            onJumpToAddress(nameBoxVal.trim().toUpperCase());
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="w-24 h-6 px-2 text-xs font-mono font-semibold text-slate-700 bg-slate-50 border border-slate-200 rounded focus:outline-none focus:border-emerald-500 focus:bg-white text-center"
        title="Name Box — type a cell like B12 and press Enter"
      />

      <div className="h-4 w-px bg-slate-200 mx-0.5" />

      {/* Cancel / Commit buttons while editing */}
      <div className="flex items-center gap-0.5">
        <button
          disabled={!isEditing}
          onClick={onCancel}
          title="Cancel (Esc)"
          className={`p-1 rounded ${
            isEditing
              ? 'text-rose-600 hover:bg-rose-50'
              : 'text-slate-300 cursor-default'
          }`}
        >
          <X className="w-3.5 h-3.5" />
        </button>
        <button
          disabled={!isEditing}
          onClick={onCommit}
          title="Commit (Enter)"
          className={`p-1 rounded ${
            isEditing
              ? 'text-emerald-600 hover:bg-emerald-50'
              : 'text-slate-300 cursor-default'
          }`}
        >
          <Check className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onOpenFunctionCatalog}
          title="Insert Function (fx)"
          className="px-1.5 py-0.5 rounded text-xs font-serif italic font-bold text-slate-600 hover:bg-slate-100 hover:text-emerald-700 transition"
        >
          fx
        </button>
      </div>

      <div className="h-4 w-px bg-slate-200 mx-0.5" />

      {/* Formula Input */}
      <input
        aria-label="Formula Input"
        value={formulaValue}
        onFocus={() => {
          if (!isEditing) onStartEdit();
        }}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onCommit();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder="Enter value or formula (e.g. =SUM(B5:E5))"
        className={`flex-1 h-6 px-2 text-xs font-mono bg-transparent focus:outline-none ${
          formulaValue.startsWith('=') ? 'text-emerald-800 font-medium' : 'text-slate-800'
        }`}
      />

      {errorText && (
        <span className="text-[11px] font-mono font-semibold text-rose-600 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded">
          {errorText}
        </span>
      )}
    </div>
  );
};
