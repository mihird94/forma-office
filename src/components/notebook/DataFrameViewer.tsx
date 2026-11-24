import React, { useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Search,
  Table2,
  X,
} from 'lucide-react';
import { FormaTablePayload } from '../../types/notebook';

interface DataFrameViewerProps {
  payload: FormaTablePayload;
  dark?: boolean;
}

type SortDirection = 'asc' | 'desc';

interface SortState {
  colIndex: number;
  dir: SortDirection;
}

function escapeCsvCell(val: string | number | boolean | null | undefined): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function dtypeBadgeClass(dtype: string | undefined, dark: boolean): string {
  const d = (dtype ?? '').toLowerCase();
  if (d.includes('int') || d.includes('float') || d.includes('double') || d.includes('decimal') || d.includes('num')) {
    return dark
      ? 'bg-sky-950/70 text-sky-300 border-sky-800/60'
      : 'bg-sky-50 text-sky-700 border-sky-200/80';
  }
  if (d.includes('bool')) {
    return dark
      ? 'bg-amber-950/70 text-amber-300 border-amber-800/60'
      : 'bg-amber-50 text-amber-700 border-amber-200/80';
  }
  if (d.includes('date') || d.includes('time')) {
    return dark
      ? 'bg-emerald-950/70 text-emerald-300 border-emerald-800/60'
      : 'bg-emerald-50 text-emerald-700 border-emerald-200/80';
  }
  return dark
    ? 'bg-slate-800 text-slate-400 border-slate-700'
    : 'bg-slate-100 text-slate-500 border-slate-200/80';
}

function compareCells(
  a: string | number | boolean | null | undefined,
  b: string | number | boolean | null | undefined,
  dir: SortDirection
): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return 1; // nulls always last
  if (bNull) return -1;

  let cmp = 0;
  if (typeof a === 'number' && typeof b === 'number') {
    cmp = a - b;
  } else if (typeof a === 'boolean' && typeof b === 'boolean') {
    cmp = Number(a) - Number(b);
  } else {
    cmp = String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }
  return dir === 'asc' ? cmp : -cmp;
}

export const DataFrameViewer: React.FC<DataFrameViewerProps> = ({ payload, dark = false }) => {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortState | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [copied, setCopied] = useState(false);

  const columns = payload.columns ?? [];
  const dtypes = payload.dtypes ?? [];
  const rawRows = payload.rows ?? [];
  const totalRows = typeof payload.totalRows === 'number' ? payload.totalRows : rawRows.length;
  const totalCols = typeof payload.totalCols === 'number' ? payload.totalCols : columns.length;
  const isTruncated = Boolean(
    payload.truncated || totalRows > rawRows.length || totalCols > columns.length
  );

  // Pair each row with its 1-based original row number
  const indexedRows = useMemo(
    () => rawRows.map((row, idx) => ({ idx: idx + 1, row })),
    [rawRows]
  );

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return indexedRows;
    return indexedRows.filter(({ row }) =>
      row.some((cell) => cell !== null && cell !== undefined && String(cell).toLowerCase().includes(q))
    );
  }, [indexedRows, search]);

  const sortedRows = useMemo(() => {
    if (!sort) return filteredRows;
    const { colIndex, dir } = sort;
    return [...filteredRows].sort((a, b) => compareCells(a.row[colIndex], b.row[colIndex], dir));
  }, [filteredRows, sort]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageStart = safePage * pageSize;
  const visibleRows = useMemo(
    () => sortedRows.slice(pageStart, pageStart + pageSize),
    [sortedRows, pageStart, pageSize]
  );

  const toggleSort = (colIndex: number) => {
    setPage(0);
    setSort((prev) => {
      if (!prev || prev.colIndex !== colIndex) return { colIndex, dir: 'asc' };
      if (prev.dir === 'asc') return { colIndex, dir: 'desc' };
      return null;
    });
  };

  const handleCopyCsv = async () => {
    const headerLine = columns.map(escapeCsvCell).join(',');
    const bodyLines = sortedRows.map(({ row }) =>
      columns.map((_, ci) => escapeCsvCell(row[ci])).join(',')
    );
    const csv = [headerLine, ...bodyLines].join('\n');
    try {
      await navigator.clipboard.writeText(csv);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // ignore clipboard errors in restricted environments
    }
  };

  const borderCls = dark ? 'border-slate-700/90' : 'border-slate-200';
  const headerBg = dark ? 'bg-slate-800/90 text-slate-200' : 'bg-slate-100/80 text-slate-700';

  return (
    <div
      className={`rounded-lg border overflow-hidden text-xs ${borderCls} ${
        dark ? 'bg-slate-900/80 text-slate-200' : 'bg-white text-slate-800'
      }`}
    >
      {/* Explorer Toolbar */}
      <div
        className={`px-3 py-2 border-b flex flex-wrap items-center justify-between gap-2 ${borderCls} ${headerBg}`}
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 font-semibold">
            <Table2 className={`w-3.5 h-3.5 ${dark ? 'text-teal-400' : 'text-teal-600'}`} />
            <span>
              {totalRows.toLocaleString()} × {totalCols.toLocaleString()}
            </span>
          </span>
          {isTruncated && (
            <span
              title={`Showing first ${rawRows.length.toLocaleString()} rows × ${columns.length.toLocaleString()} columns`}
              className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${
                dark
                  ? 'bg-amber-950/60 text-amber-300 border-amber-800/70'
                  : 'bg-amber-50 text-amber-800 border-amber-200'
              }`}
            >
              Preview ({rawRows.length.toLocaleString()} rows
              {totalCols > columns.length ? ` · ${columns.length} cols` : ''})
            </span>
          )}
          {search.trim() && (
            <span className={`text-[11px] font-mono ${dark ? 'text-violet-300' : 'text-violet-700'}`}>
              {sortedRows.length.toLocaleString()} match{sortedRows.length === 1 ? '' : 'es'}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {/* Search Input */}
          <div className="relative flex items-center">
            <Search className="w-3 h-3 text-slate-400 absolute left-2 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
              placeholder="Filter rows…"
              aria-label="Filter DataFrame rows"
              className={`pl-6 pr-6 py-1 rounded-md text-[11px] border w-40 sm:w-48 focus:outline-none focus:border-violet-500 transition ${
                dark
                  ? 'bg-slate-900 border-slate-700 text-slate-100 placeholder-slate-500'
                  : 'bg-white border-slate-200 text-slate-800 placeholder-slate-400'
              }`}
            />
            {search && (
              <button
                type="button"
                onClick={() => {
                  setSearch('');
                  setPage(0);
                }}
                title="Clear filter"
                className="absolute right-1.5 text-slate-400 hover:text-slate-600"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          {/* Copy CSV Button */}
          <button
            type="button"
            onClick={() => void handleCopyCsv()}
            title="Copy visible rows as CSV"
            className={`px-2 py-1 rounded-md text-[11px] font-medium border flex items-center gap-1 transition ${
              copied
                ? dark
                  ? 'bg-emerald-950/70 text-emerald-300 border-emerald-700'
                  : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : dark
                  ? 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
            }`}
          >
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            <span>{copied ? 'Copied' : 'CSV'}</span>
          </button>
        </div>
      </div>

      {/* Scrollable Interactive Data Grid */}
      <div className="max-h-[400px] overflow-auto">
        <table className="w-full border-collapse text-left font-mono text-[11.5px]">
          <thead
            className={`sticky top-0 z-10 border-b ${borderCls} ${
              dark ? 'bg-slate-800 text-slate-200' : 'bg-slate-50 text-slate-700'
            }`}
          >
            <tr>
              <th
                className={`px-2.5 py-2 text-[10px] font-semibold text-right select-none border-r w-10 ${borderCls} ${
                  dark ? 'text-slate-500 bg-slate-800' : 'text-slate-400 bg-slate-50'
                }`}
              >
                #
              </th>
              {columns.map((col, ci) => {
                const isSorted = sort?.colIndex === ci;
                const dtype = dtypes[ci];
                return (
                  <th
                    key={`${col}_${ci}`}
                    onClick={() => toggleSort(ci)}
                    title={`Sort by ${col}${dtype ? ` (${dtype})` : ''}`}
                    className={`px-3 py-1.5 font-sans font-semibold border-r last:border-r-0 cursor-pointer select-none whitespace-nowrap transition ${borderCls} ${
                      isSorted
                        ? dark
                          ? 'bg-violet-950/50 text-violet-200'
                          : 'bg-violet-50/90 text-violet-900'
                        : dark
                          ? 'hover:bg-slate-700/60'
                          : 'hover:bg-slate-100'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate max-w-[200px]">{col}</span>
                      <span className="shrink-0 text-slate-400">
                        {isSorted ? (
                          sort.dir === 'asc' ? (
                            <ArrowUp className="w-3 h-3 text-violet-500" />
                          ) : (
                            <ArrowDown className="w-3 h-3 text-violet-500" />
                          )
                        ) : (
                          <ArrowUpDown className="w-2.5 h-2.5 opacity-45" />
                        )}
                      </span>
                    </div>
                    {dtype && (
                      <div className="mt-0.5">
                        <span
                          className={`inline-block font-mono text-[9.5px] font-normal px-1 py-0 rounded border ${dtypeBadgeClass(
                            dtype,
                            dark
                          )}`}
                        >
                          {dtype}
                        </span>
                      </div>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className={`divide-y ${dark ? 'divide-slate-800' : 'divide-slate-100'}`}>
            {visibleRows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + 1}
                  className="px-4 py-6 text-center font-sans text-slate-400"
                >
                  {rawRows.length === 0 ? 'Empty table (0 rows)' : 'No rows match the current filter'}
                </td>
              </tr>
            ) : (
              visibleRows.map(({ idx, row }) => (
                <tr
                  key={idx}
                  className={
                    dark
                      ? 'hover:bg-slate-800/70 odd:bg-slate-900/40'
                      : 'hover:bg-violet-50/40 odd:bg-slate-50/35'
                  }
                >
                  <td
                    className={`px-2.5 py-1.5 text-right text-[10.5px] tabular-nums border-r select-none ${borderCls} ${
                      dark ? 'text-slate-500' : 'text-slate-400'
                    }`}
                  >
                    {idx}
                  </td>
                  {columns.map((_, ci) => {
                    const cell = row[ci];
                    const isNum = typeof cell === 'number';
                    const isBool = typeof cell === 'boolean';
                    const isNull = cell === null || cell === undefined;
                    const displayStr = isNull ? 'null' : String(cell);
                    return (
                      <td
                        key={ci}
                        title={isNull ? 'null' : displayStr}
                        className={`px-3 py-1.5 border-r last:border-r-0 max-w-[280px] truncate ${borderCls} ${
                          isNum ? 'text-right tabular-nums' : ''
                        }`}
                      >
                        {isNull ? (
                          <span className="italic text-slate-400">null</span>
                        ) : isBool ? (
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10.5px] font-semibold ${
                              cell
                                ? dark
                                  ? 'bg-emerald-950/70 text-emerald-300'
                                  : 'bg-emerald-50 text-emerald-700'
                                : dark
                                  ? 'bg-rose-950/60 text-rose-300'
                                  : 'bg-rose-50 text-rose-700'
                            }`}
                          >
                            {displayStr}
                          </span>
                        ) : (
                          displayStr
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Footer */}
      {sortedRows.length > 25 && (
        <div
          className={`px-3 py-1.5 border-t flex flex-wrap items-center justify-between gap-2 text-[11px] ${borderCls} ${
            dark ? 'bg-slate-800/60 text-slate-400' : 'bg-slate-50/80 text-slate-500'
          }`}
        >
          <div className="flex items-center gap-2">
            <span>
              Rows <strong className={dark ? 'text-slate-200' : 'text-slate-700'}>{pageStart + 1}</strong>–
              <strong className={dark ? 'text-slate-200' : 'text-slate-700'}>
                {Math.min(pageStart + pageSize, sortedRows.length)}
              </strong>{' '}
              of <strong className={dark ? 'text-slate-200' : 'text-slate-700'}>{sortedRows.length}</strong>
            </span>
            <select
              aria-label="Rows per page"
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(0);
              }}
              className={`px-1.5 py-0.5 rounded border text-[11px] focus:outline-none ${
                dark
                  ? 'bg-slate-900 border-slate-700 text-slate-200'
                  : 'bg-white border-slate-200 text-slate-700'
              }`}
            >
              <option value={25}>25 / page</option>
              <option value={50}>50 / page</option>
              <option value={100}>100 / page</option>
              <option value={500}>500 / page</option>
            </select>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={safePage === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className={`p-1 rounded border disabled:opacity-35 transition ${
                  dark
                    ? 'border-slate-700 hover:bg-slate-700 text-slate-200'
                    : 'border-slate-200 hover:bg-slate-100 text-slate-700'
                }`}
                aria-label="Previous page"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <span className="px-2 font-mono">
                {safePage + 1} / {totalPages}
              </span>
              <button
                type="button"
                disabled={safePage >= totalPages - 1}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                className={`p-1 rounded border disabled:opacity-35 transition ${
                  dark
                    ? 'border-slate-700 hover:bg-slate-700 text-slate-200'
                    : 'border-slate-200 hover:bg-slate-100 text-slate-700'
                }`}
                aria-label="Next page"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
