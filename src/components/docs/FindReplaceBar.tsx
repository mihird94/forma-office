import React, { useState } from 'react';
import { X } from 'lucide-react';

interface FindReplaceBarProps {
  query: string;
  onQueryChange: (value: string) => void;
  matchCount: number;
  matchIndex: number;
  onNavigate: (direction: number) => void;
  onReplaceAll: (findText: string, replaceText: string) => number;
  onClose: () => void;
}

export const FindReplaceBar: React.FC<FindReplaceBarProps> = ({ query: findVal, onQueryChange, matchCount, matchIndex, onNavigate, onReplaceAll, onClose }) => {
  const [replaceVal, setReplaceVal] = useState('');
  const [status, setStatus] = useState<string>('');

  const handleReplace = () => {
    if (!findVal) return;
    const count = onReplaceAll(findVal, replaceVal);
    setStatus(count > 0 ? `Replaced ${count} match${count === 1 ? '' : 'es'}` : 'No matches found');
  };

  return (
    <div className="no-print bg-slate-50 border-b border-slate-200 px-4 py-2 flex flex-wrap items-center gap-2 text-xs">
      <input
        autoFocus
        value={findVal}
        onChange={(e) => {
          onQueryChange(e.target.value);
          setStatus('');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); onNavigate(e.shiftKey ? -1 : 1); }
          if (e.key === 'Escape') onClose();
        }}
        aria-label="Find text"
        placeholder="Find text..."
        className="w-48 px-2.5 py-1 bg-white border border-slate-300 rounded-md focus:outline-none focus:border-blue-500"
      />
      <span role="status">{matchCount ? `${matchIndex + 1} of ${matchCount}` : '0 matches'}</span>
      <button disabled={!matchCount} onClick={() => onNavigate(-1)} aria-label="Previous match">↑</button>
      <button disabled={!matchCount} onClick={() => onNavigate(1)} aria-label="Next match">↓</button>
      <input
        value={replaceVal}
        onChange={(e) => setReplaceVal(e.target.value)}
        placeholder="Replace with..."
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleReplace();
        }}
        className="w-48 px-2.5 py-1 bg-white border border-slate-300 rounded-md focus:outline-none focus:border-blue-500"
      />
      <button
        onClick={handleReplace}
        className="px-3 py-1 bg-blue-600 text-white font-medium rounded-md hover:bg-blue-700 transition"
      >
        Replace All
      </button>
      {status && <span className="text-slate-600 font-medium">{status}</span>}
      <div className="flex-1" />
      <button
        onClick={onClose}
        className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-200"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};
