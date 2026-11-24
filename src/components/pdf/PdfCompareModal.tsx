import React, { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { Columns2, FileUp, Loader2, X } from 'lucide-react';

interface PdfCompareModalProps {
  baseTitle: string;
  basePdfDoc: pdfjsLib.PDFDocumentProxy | null;
  baseTextCache?: Map<number, string>;
  onClose: () => void;
  onJumpToPage?: (pageIndex: number) => void;
}

interface DiffOp {
  type: 'equal' | 'removed' | 'added';
  text: string;
}

interface SideBySideRow {
  left?: { text: string; kind: 'equal' | 'removed' };
  right?: { text: string; kind: 'equal' | 'added' };
}

interface PageDiffResult {
  pageIndex: number;
  rows: SideBySideRow[];
  addedCount: number;
  removedCount: number;
  changed: boolean;
}

async function extractPageLines(doc: pdfjsLib.PDFDocumentProxy, pageNumber: number): Promise<string[]> {
  if (pageNumber < 1 || pageNumber > doc.numPages) return [];
  try {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines: Array<{ y: number; parts: string[] }> = [];

    for (const rawItem of content.items) {
      if (!('str' in rawItem)) continue;
      const str = rawItem.str;
      if (!str.trim()) continue;
      const transform = 'transform' in rawItem && Array.isArray(rawItem.transform) ? rawItem.transform : null;
      const y = transform && typeof transform[5] === 'number' ? Math.round(transform[5] / 3) * 3 : 0;
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - y) <= 4) {
        last.parts.push(str);
      } else {
        lines.push({ y, parts: [str] });
      }
    }

    return lines
      .map((l) => l.parts.join(' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function computeLineDiff(leftLines: string[], rightLines: string[]): DiffOp[] {
  const n = leftLines.length;
  const m = rightLines.length;

  // Fallback linear diff for unusually huge single-page dumps to guarantee instant UI
  if (n * m > 250_000) {
    const ops: DiffOp[] = [];
    const maxLen = Math.max(n, m);
    for (let i = 0; i < maxLen; i++) {
      const a = leftLines[i];
      const b = rightLines[i];
      if (a === b && a !== undefined) {
        ops.push({ type: 'equal', text: a });
      } else {
        if (a !== undefined) ops.push({ type: 'removed', text: a });
        if (b !== undefined) ops.push({ type: 'added', text: b });
      }
    }
    return ops;
  }

  // Standard LCS DP table
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (leftLines[i] === rightLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
      }
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (leftLines[i] === rightLines[j]) {
      ops.push({ type: 'equal', text: leftLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'removed', text: leftLines[i] });
      i++;
    } else {
      ops.push({ type: 'added', text: rightLines[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'removed', text: leftLines[i++] });
  while (j < m) ops.push({ type: 'added', text: rightLines[j++] });
  return ops;
}

function pairSideBySide(ops: DiffOp[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === 'equal') {
      rows.push({
        left: { text: ops[i].text, kind: 'equal' },
        right: { text: ops[i].text, kind: 'equal' },
      });
      i++;
      continue;
    }
    const removed: string[] = [];
    const added: string[] = [];
    while (i < ops.length && ops[i].type !== 'equal') {
      if (ops[i].type === 'removed') removed.push(ops[i].text);
      else added.push(ops[i].text);
      i++;
    }
    const span = Math.max(removed.length, added.length);
    for (let k = 0; k < span; k++) {
      rows.push({
        left: k < removed.length ? { text: removed[k], kind: 'removed' } : undefined,
        right: k < added.length ? { text: added[k], kind: 'added' } : undefined,
      });
    }
  }
  return rows;
}

export const PdfCompareModal: React.FC<PdfCompareModalProps> = ({
  baseTitle,
  basePdfDoc,
  baseTextCache,
  onClose,
  onJumpToPage,
}) => {
  const [otherTitle, setOtherTitle] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageDiffs, setPageDiffs] = useState<PageDiffResult[]>([]);
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const otherTaskRef = useRef<pdfjsLib.PDFDocumentLoadingTask | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (otherTaskRef.current) {
        void otherTaskRef.current.destroy();
        otherTaskRef.current = null;
      }
    };
  }, [onClose]);

  const handleSelectSecondPdf = async (file: File) => {
    if (!basePdfDoc) {
      setError('Current PDF is still loading.');
      return;
    }
    setError(null);
    setComparing(true);
    setOtherTitle(file.name);
    setPageDiffs([]);

    if (otherTaskRef.current) {
      void otherTaskRef.current.destroy();
      otherTaskRef.current = null;
    }

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const task = pdfjsLib.getDocument({ data: bytes });
      otherTaskRef.current = task;
      const otherDoc = await task.promise;

      const totalPages = Math.max(basePdfDoc.numPages, otherDoc.numPages);
      const results: PageDiffResult[] = [];

      for (let i = 0; i < totalPages; i++) {
        setProgress(`Comparing page ${i + 1} of ${totalPages}…`);
        let leftLines = await extractPageLines(basePdfDoc, i + 1);
        if (leftLines.length === 0 && baseTextCache?.has(i)) {
          const cached = baseTextCache.get(i) ?? '';
          leftLines = cached
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
        }
        const rightLines = await extractPageLines(otherDoc, i + 1);
        const ops = computeLineDiff(leftLines, rightLines);
        const addedCount = ops.filter((o) => o.type === 'added').length;
        const removedCount = ops.filter((o) => o.type === 'removed').length;
        results.push({
          pageIndex: i,
          rows: pairSideBySide(ops),
          addedCount,
          removedCount,
          changed: addedCount > 0 || removedCount > 0,
        });
      }

      setPageDiffs(results);
      setProgress('');
    } catch (err) {
      setError(`Could not compare PDF: ${(err as Error).message}`);
    } finally {
      setComparing(false);
    }
  };

  const totalAdded = pageDiffs.reduce((sum, p) => sum + p.addedCount, 0);
  const totalRemoved = pageDiffs.reduce((sum, p) => sum + p.removedCount, 0);
  const changedPagesCount = pageDiffs.filter((p) => p.changed).length;
  const visibleDiffs = onlyChanged ? pageDiffs.filter((p) => p.changed) : pageDiffs;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[150] bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-6xl h-[86vh] bg-white rounded-2xl shadow-2xl border border-slate-200 flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-rose-100 text-rose-700 flex items-center justify-center shrink-0">
              <Columns2 className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-slate-900 truncate">
                Side-by-Side PDF Comparison
              </h2>
              <p className="text-[11px] text-slate-500 truncate">
                <span className="font-medium text-slate-700">{baseTitle}</span>
                {otherTitle ? (
                  <>
                    {' '}
                    vs. <span className="font-medium text-rose-700">{otherTitle}</span>
                  </>
                ) : (
                  ' — Pick a second PDF to inspect line-by-line text changes per page'
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <label className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-600 hover:bg-rose-700 text-white cursor-pointer flex items-center gap-1.5 transition shadow-xs">
              <FileUp className="w-3.5 h-3.5" />
              <span>{otherTitle ? 'Pick Another PDF' : 'Choose Second PDF…'}</span>
              <input
                type="file"
                accept=".pdf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleSelectSecondPdf(f);
                  e.target.value = '';
                }}
              />
            </label>
            <button
              onClick={onClose}
              title="Close (Esc)"
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Summary Bar */}
        {pageDiffs.length > 0 && !comparing && (
          <div className="px-5 py-2 border-b border-slate-200 bg-white flex flex-wrap items-center justify-between gap-3 text-xs shrink-0">
            <div className="flex items-center gap-3">
              <span className="text-slate-600">
                Compared <strong className="font-mono text-slate-900">{pageDiffs.length}</strong> page
                {pageDiffs.length === 1 ? '' : 's'}
              </span>
              <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-medium">
                {changedPagesCount} changed page{changedPagesCount === 1 ? '' : 's'}
              </span>
              <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 font-mono font-semibold">
                +{totalAdded} added
              </span>
              <span className="px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 font-mono font-semibold">
                -{totalRemoved} removed
              </span>
            </div>
            <label className="flex items-center gap-1.5 text-slate-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={onlyChanged}
                onChange={(e) => setOnlyChanged(e.target.checked)}
                className="rounded border-slate-300 text-rose-600 focus:ring-rose-500"
              />
              <span>Show changed pages only</span>
            </label>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 bg-slate-100/70 space-y-5">
          {error && (
            <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl p-4 text-xs">
              {error}
            </div>
          )}

          {comparing ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-slate-500 text-xs">
              <Loader2 className="w-6 h-6 animate-spin text-rose-600" />
              <span>{progress || 'Loading comparison PDF…'}</span>
            </div>
          ) : pageDiffs.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto gap-3">
              <div className="w-12 h-12 rounded-2xl bg-white border border-slate-200 shadow-xs flex items-center justify-center text-rose-600">
                <Columns2 className="w-6 h-6" />
              </div>
              <div className="text-sm font-semibold text-slate-800">
                Compare "{baseTitle}" against another PDF
              </div>
              <p className="text-xs text-slate-500 leading-relaxed">
                Select a revised contract, manuscript, or report to inspect page-by-page line additions
                and removals side by side. Everything runs locally on your Mac.
              </p>
              <label className="mt-1 px-4 py-2 rounded-xl text-xs font-semibold bg-rose-600 hover:bg-rose-700 text-white cursor-pointer inline-flex items-center gap-2 shadow-sm transition">
                <FileUp className="w-4 h-4" />
                <span>Select Second PDF File…</span>
                <input
                  type="file"
                  accept=".pdf"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleSelectSecondPdf(f);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
          ) : visibleDiffs.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-xs text-slate-500">
              No text differences found between the two PDFs.
            </div>
          ) : (
            visibleDiffs.map((pg) => (
              <section
                key={pg.pageIndex}
                className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden"
              >
                <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-800 font-mono">
                      Page {pg.pageIndex + 1}
                    </span>
                    {pg.changed ? (
                      <>
                        <span className="text-[11px] font-mono text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">
                          +{pg.addedCount}
                        </span>
                        <span className="text-[11px] font-mono text-rose-700 bg-rose-50 px-1.5 py-0.5 rounded">
                          -{pg.removedCount}
                        </span>
                      </>
                    ) : (
                      <span className="text-[11px] text-slate-400">Identical text</span>
                    )}
                  </div>
                  {onJumpToPage && basePdfDoc && pg.pageIndex < basePdfDoc.numPages && (
                    <button
                      onClick={() => {
                        onJumpToPage(pg.pageIndex);
                        onClose();
                      }}
                      className="text-[11px] text-rose-700 hover:underline font-medium"
                    >
                      Jump to Page {pg.pageIndex + 1}
                    </button>
                  )}
                </div>

                {/* Column Headers */}
                <div className="grid grid-cols-2 border-b border-slate-200 bg-slate-50/60 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  <div className="px-3 py-1 border-r border-slate-200 truncate">{baseTitle}</div>
                  <div className="px-3 py-1 truncate">{otherTitle}</div>
                </div>

                {/* Diff Rows */}
                {pg.rows.length === 0 ? (
                  <div className="p-4 text-xs text-slate-400 italic text-center">
                    No extractable text on this page (consider running Vision OCR first).
                  </div>
                ) : (
                  <div className="divide-y divide-slate-100 text-xs font-mono">
                    {pg.rows.map((row, rIdx) => (
                      <div key={rIdx} className="grid grid-cols-2">
                        <div
                          className={`px-3 py-1 border-r border-slate-200 whitespace-pre-wrap break-words ${
                            row.left?.kind === 'removed'
                              ? 'bg-rose-50 text-rose-900'
                              : row.left
                                ? 'text-slate-700'
                                : 'bg-slate-50/70'
                          }`}
                        >
                          {row.left ? (
                            <>
                              <span
                                className={`inline-block w-4 select-none font-bold ${
                                  row.left.kind === 'removed' ? 'text-rose-500' : 'text-slate-300'
                                }`}
                              >
                                {row.left.kind === 'removed' ? '-' : ' '}
                              </span>
                              {row.left.text}
                            </>
                          ) : null}
                        </div>
                        <div
                          className={`px-3 py-1 whitespace-pre-wrap break-words ${
                            row.right?.kind === 'added'
                              ? 'bg-emerald-50 text-emerald-900'
                              : row.right
                                ? 'text-slate-700'
                                : 'bg-slate-50/70'
                          }`}
                        >
                          {row.right ? (
                            <>
                              <span
                                className={`inline-block w-4 select-none font-bold ${
                                  row.right.kind === 'added' ? 'text-emerald-600' : 'text-slate-300'
                                }`}
                              >
                                {row.right.kind === 'added' ? '+' : ' '}
                              </span>
                              {row.right.text}
                            </>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
