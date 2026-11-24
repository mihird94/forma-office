import React, { useMemo, useRef } from 'react';
import { highlightPythonToHtml } from '../../engine/notebook/pythonHighlight';
import { ReadingTheme } from '../common/ReadingModePicker';

interface PythonCodeEditorProps {
  value: string;
  theme: ReadingTheme;
  highlightLine?: number | null; // 1-based active execution trace line
  placeholder?: string;
  onChange: (nextValue: string) => void;
  onRunAdvance: () => void;
  onRunInPlace: () => void;
}

export const PythonCodeEditor: React.FC<PythonCodeEditorProps> = ({
  value,
  theme,
  highlightLine = null,
  placeholder = '# Write Python code and press Shift+Enter to execute...',
  onChange,
  onRunAdvance,
  onRunInPlace,
}) => {
  const preRef = useRef<HTMLPreElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const lines = useMemo(() => value.split('\n'), [value]);
  const lineCount = Math.max(1, lines.length);

  // Append a trailing newline so an empty last line renders the same height as the textarea
  const highlightedHtml = useMemo(
    () => highlightPythonToHtml(value) + (value.endsWith('\n') ? ' ' : '\n'),
    [value]
  );

  const isDark = theme === 'dark';
  const isWarm = theme === 'sepia' || theme === 'paperwhite';

  const containerClass = isDark
    ? 'forma-py-dark bg-[#121620]'
    : isWarm
      ? 'forma-py-warm bg-[#faf6ec]'
      : 'forma-py-light bg-[#fbfbfd]';

  const gutterClass = isDark
    ? 'bg-[#0e121a] border-slate-800 text-slate-600'
    : isWarm
      ? 'bg-[#f2ebd9] border-[#e2d6b8] text-[#9b8a6b]'
      : 'bg-slate-50/90 border-slate-200/80 text-slate-400';

  const syncScroll = () => {
    if (preRef.current && taRef.current) {
      preRef.current.scrollLeft = taRef.current.scrollLeft;
      preRef.current.scrollTop = taRef.current.scrollTop;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      onRunAdvance();
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onRunInPlace();
      return;
    }
    if (e.key === 'Enter' && !e.altKey) {
      // Smart Python auto-indent (preserves leading spaces, +4 spaces after ':')
      const ta = e.currentTarget;
      const s = ta.selectionStart;
      const end = ta.selectionEnd;
      const lineStart = value.lastIndexOf('\n', s - 1) + 1;
      const currentLine = value.slice(lineStart, s);
      const indentMatch = currentLine.match(/^\s*/);
      const baseIndent = indentMatch ? indentMatch[0] : '';
      const extra = currentLine.trimEnd().endsWith(':') ? '    ' : '';
      if (baseIndent || extra) {
        e.preventDefault();
        const insert = `\n${baseIndent}${extra}`;
        const nextVal = value.slice(0, s) + insert + value.slice(end);
        onChange(nextVal);
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = s + insert.length;
        });
      }
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget;
      const s = ta.selectionStart;
      const end = ta.selectionEnd;
      if (e.shiftKey) {
        const lineStart = value.lastIndexOf('\n', s - 1) + 1;
        const prefix = value.slice(lineStart, lineStart + 4);
        const removeCount = prefix.match(/^ {1,4}/)?.[0].length ?? 0;
        if (removeCount > 0) {
          const nextVal = value.slice(0, lineStart) + value.slice(lineStart + removeCount);
          onChange(nextVal);
          requestAnimationFrame(() => {
            ta.selectionStart = Math.max(lineStart, s - removeCount);
            ta.selectionEnd = Math.max(lineStart, end - removeCount);
          });
        }
      } else {
        const nextVal = value.slice(0, s) + '    ' + value.slice(end);
        onChange(nextVal);
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = s + 4;
        });
      }
    }
  };

  // Exact geometry: 21px line height + 24px vertical padding (12px top + 12px bottom)
  const editorMinHeight = Math.max(2, lineCount) * 21 + 24;

  return (
    <div className={`forma-py-editor relative flex font-mono text-[13px] ${containerClass}`}>
      {/* Line Number Gutter */}
      <div
        aria-hidden="true"
        className={`py-3 px-2.5 text-right text-[11px] leading-[21px] border-r select-none shrink-0 tabular-nums min-w-[40px] ${gutterClass}`}
      >
        {Array.from({ length: Math.max(1, lineCount) }, (_, idx) => {
          const isTraced = highlightLine === idx + 1;
          return (
            <div
              key={idx}
              className={
                isTraced
                  ? 'font-bold text-amber-600 bg-amber-400/20 -mx-2.5 px-2.5 rounded-l-xs'
                  : ''
              }
            >
              {isTraced ? `▸${idx + 1}` : idx + 1}
            </div>
          );
        })}
      </div>

      {/* Synchronized Highlight Layer + Transparent Caret Textarea */}
      <div className="relative flex-1 min-w-0 overflow-hidden" style={{ minHeight: editorMinHeight }}>
        {highlightLine !== null && highlightLine >= 1 && highlightLine <= lineCount && (
          <div
            aria-hidden="true"
            style={{
              top: 12 + (highlightLine - 1) * 21,
              height: 21,
            }}
            className={`pointer-events-none absolute left-0 right-0 border-l-2 border-amber-500 transition-all duration-100 ${
              isDark ? 'bg-amber-400/15' : 'bg-amber-300/28'
            }`}
          />
        )}
        <pre
          ref={preRef}
          aria-hidden="true"
          className="forma-py-layer pointer-events-none m-0 py-3 px-3.5 overflow-hidden whitespace-pre"
          style={{ minHeight: editorMinHeight }}
        >
          {value.length > 0 ? (
            <code dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
          ) : (
            <span className={isDark ? 'text-slate-600' : 'text-slate-400'}>{placeholder}</span>
          )}
        </pre>

        <textarea
          ref={taRef}
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          onScroll={syncScroll}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Python code cell"
          className={`forma-py-layer forma-py-textarea absolute inset-0 w-full h-full m-0 py-3 px-3.5 bg-transparent resize-none focus:outline-none overflow-x-auto overflow-y-hidden whitespace-pre ${
            isDark ? 'caret-violet-300' : 'caret-violet-700'
          }`}
          style={{
            color: 'transparent',
            WebkitTextFillColor: 'transparent',
          }}
        />
      </div>
    </div>
  );
};
