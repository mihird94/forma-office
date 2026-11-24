import { visibleIndices } from '../../engine/spreadsheet/viewport';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownZA, ArrowUpAZ, Filter, Search, X } from 'lucide-react';
import {
  CellCoord,
  CellSelection,
  ChartSpec,
  ComputedCell,
  ConditionalFormatRule,
  NormalizedRange,
  SheetData,
} from '../../types/spreadsheet';
import {
  colToLetter,
  coordToAddress,
  extractFormulaReferences,
  isCoordInRange,
  normalizeSelection,
  parseAddress,
  parseRange,
} from '../../engine/spreadsheet/address';
import { ChartOverlay } from './ChartOverlay';
import { ContextMenu, ContextMenuItem } from '../common/ContextMenu';

export type GridContextAction =
  | 'cut'
  | 'copy'
  | 'paste'
  | 'clear'
  | 'insertRowAbove'
  | 'insertRowBelow'
  | 'deleteRow'
  | 'insertColLeft'
  | 'insertColRight'
  | 'deleteCol'
  | 'sortAsc'
  | 'sortDesc'
  | 'formatCurrency'
  | 'formatPercent'
  | 'toggleMerge'
  | 'insertChart'
  | 'sendToDocs';

interface SpreadsheetGridProps {
  sheet: SheetData;
  computed: Record<string, ComputedCell>;
  selection: CellSelection;
  editingCoord: CellCoord | null;
  editDraft: string;
  shouldFocusCellInput?: boolean;
  hiddenRows?: Set<number>;
  zoom?: number;
  onSelect: (sel: CellSelection) => void;
  onStartEdit: (coord: CellCoord, initialText?: string) => void;
  onChangeDraft: (val: string) => void;
  onCommitEdit: (moveDir?: 'down' | 'right' | 'none') => void;
  onCancelEdit: () => void;
  onFillRange: (source: NormalizedRange, target: NormalizedRange) => void;
  onBeginStructureDrag?: () => void;
  onResizeCol: (col: number, width: number) => void;
  onResizeRow: (row: number, height: number) => void;
  onContextAction: (action: GridContextAction) => void;
  onUpdateChart: (chart: ChartSpec, recordHistory?: boolean) => void;
  onDeleteChart: (id: string) => void;
  onUpdateColumnFilter?: (col: number, hiddenValues: string[]) => void;
  onSortColumn?: (col: number, dir: 'asc' | 'desc') => void;
}

const DEFAULT_COL_W = 104;
const DEFAULT_ROW_H = 26;
const REF_COLORS = ['#2563eb', '#d97706', '#7c3aed', '#e11d48', '#0891b2'];

interface PreparedCondRule {
  rule: ConditionalFormatRule;
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  min: number;
  max: number;
  hasNumeric: boolean;
}

function interpolateColorScale(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  let r: number;
  let g: number;
  let b: number;
  if (clamped <= 0.5) {
    const u = clamped * 2;
    r = 254;
    g = Math.round(202 + (240 - 202) * u);
    b = Math.round(202 + (138 - 202) * u);
  } else {
    const u = (clamped - 0.5) * 2;
    r = Math.round(254 + (187 - 254) * u);
    g = Math.round(240 + (247 - 240) * u);
    b = Math.round(138 + (208 - 138) * u);
  }
  return `rgb(${r}, ${g}, ${b})`;
}

export const SpreadsheetGrid: React.FC<SpreadsheetGridProps> = ({
  sheet,
  computed,
  selection,
  editingCoord,
  editDraft,
  shouldFocusCellInput = true,
  hiddenRows,
  zoom = 1,
  onSelect,
  onStartEdit,
  onChangeDraft,
  onCommitEdit,
  onCancelEdit,
  onFillRange,
  onBeginStructureDrag,
  onResizeCol,
  onResizeRow,
  onContextAction,
  onUpdateChart,
  onDeleteChart,
  onUpdateColumnFilter,
  onSortColumn,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [isDraggingSelect, setIsDraggingSelect] = useState(false);
  const [fillTarget, setFillTarget] = useState<NormalizedRange | null>(null);
  const [isDraggingFill, setIsDraggingFill] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [filterMenu, setFilterMenu] = useState<{
    col: number;
    x: number;
    y: number;
    search: string;
    draftExcluded: Set<string>;
  } | null>(null);

  const normRange = useMemo(() => normalizeSelection(selection), [selection]);

  // Live formula reference highlights when editing a formula
  const formulaHighlights = useMemo(() => {
    if (!editingCoord || !editDraft.startsWith('=')) return [];
    return extractFormulaReferences(editDraft).filter(
      (r) => !r.sheetName || r.sheetName.toLowerCase() === sheet.name.toLowerCase()
    );
  }, [editingCoord, editDraft, sheet.name]);

  // Precompute merge lookup maps
  const { mergeOriginMap, mergeHiddenSet } = useMemo(() => {
    const origin = new Map<string, { rowSpan: number; colSpan: number }>();
    const hidden = new Set<string>();
    for (const m of sheet.merges) {
      origin.set(coordToAddress(m.startRow, m.startCol), {
        rowSpan: m.endRow - m.startRow + 1,
        colSpan: m.endCol - m.startCol + 1,
      });
      for (let r = m.startRow; r <= m.endRow; r++) {
        for (let c = m.startCol; c <= m.endCol; c++) {
          if (r !== m.startRow || c !== m.startCol) {
            hidden.add(coordToAddress(r, c));
          }
        }
      }
    }
    return { mergeOriginMap: origin, mergeHiddenSet: hidden };
  }, [sheet.merges]);

  // Precompute cumulative left/top offsets for frozen columns/rows
  const colLeftOffsets = useMemo(() => {
    const arr: number[] = [];
    let acc = 44; // row header width
    for (let c = 0; c < sheet.colCount; c++) {
      arr.push(acc);
      acc += sheet.colWidths[c] ?? DEFAULT_COL_W;
    }
    return arr;
  }, [sheet.colCount, sheet.colWidths]);

  // Precompute conditional formatting rules + range numeric min/max for colorScale/dataBar
  const preparedCondRules = useMemo<PreparedCondRule[]>(() => {
    const rules = sheet.conditionalFormats ?? [];
    if (rules.length === 0) return [];
    const prepared: PreparedCondRule[] = [];
    for (const rule of rules) {
      const parsed = parseRange(rule.range);
      if (!parsed) continue;
      const startRow = Math.min(parsed.start.row, parsed.end.row);
      const endRow = Math.max(parsed.start.row, parsed.end.row);
      const startCol = Math.min(parsed.start.col, parsed.end.col);
      const endCol = Math.max(parsed.start.col, parsed.end.col);
      let min = Infinity;
      let max = -Infinity;
      let hasNumeric = false;
      if (rule.kind === 'colorScale' || rule.kind === 'dataBar') {
        for (let r = startRow; r <= endRow; r++) {
          for (let c = startCol; c <= endCol; c++) {
            const val = computed[coordToAddress(r, c)]?.value;
            if (typeof val === 'number' && Number.isFinite(val)) {
              hasNumeric = true;
              if (val < min) min = val;
              if (val > max) max = val;
            }
          }
        }
      }
      prepared.push({
        rule,
        startRow,
        endRow,
        startCol,
        endCol,
        min: hasNumeric ? min : 0,
        max: hasNumeric ? max : 0,
        hasNumeric,
      });
    }
    return prepared;
  }, [sheet.conditionalFormats, computed]);

  // Max used row for AutoFilter value listing
  const maxUsedRow = useMemo(() => {
    let maxR = sheet.filter?.headerRow ?? 0;
    for (const [addr, cell] of Object.entries(sheet.cells)) {
      if (!cell || cell.raw === '') continue;
      const p = parseAddress(addr);
      if (p && p.row > maxR) maxR = p.row;
    }
    for (const [addr, comp] of Object.entries(computed)) {
      if (!comp || comp.formatted === '') continue;
      const p = parseAddress(addr);
      if (p && p.row > maxR) maxR = p.row;
    }
    return maxR;
  }, [sheet.cells, computed, sheet.filter?.headerRow]);

  // Visible row list & cumulative offsets (respecting AutoFilter hiddenRows)
  const { visibleRowList, visibleRowOffsets, rowTopMap, totalHeight } = useMemo(() => {
    const list: number[] = [];
    const offsets: number[] = [];
    const topMap = new Map<number, number>();
    let acc = 26; // col header height
    for (let r = 0; r < sheet.rowCount; r++) {
      if (hiddenRows && hiddenRows.has(r)) continue;
      list.push(r);
      offsets.push(acc);
      topMap.set(r, acc);
      acc += sheet.rowHeights[r] ?? DEFAULT_ROW_H;
    }
    return { visibleRowList: list, visibleRowOffsets: offsets, rowTopMap: topMap, totalHeight: acc };
  }, [sheet.rowCount, sheet.rowHeights, hiddenRows]);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollLeft = 0;
      containerRef.current.scrollTop = 0;
    }
    setFilterMenu(null);
  }, [sheet.id]);

  useEffect(() => {
    if (editingCoord && shouldFocusCellInput && inputRef.current) {
      inputRef.current.focus();
    }
  }, [editingCoord, shouldFocusCellInput]);

  useEffect(() => {
    const closeMenus = () => {
      setContextMenu(null);
      setFilterMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setFilterMenu(null);
        setContextMenu(null);
      }
    };
    const stopDrag = () => {
      if (isDraggingFill && fillTarget) {
        onFillRange(normRange, fillTarget);
      }
      setIsDraggingSelect(false);
      setIsDraggingFill(false);
      setFillTarget(null);
    };
    window.addEventListener('mouseup', stopDrag);
    window.addEventListener('click', closeMenus);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mouseup', stopDrag);
      window.removeEventListener('click', closeMenus);
      window.removeEventListener('keydown', onKey);
    };
  }, [isDraggingFill, fillTarget, normRange, onFillRange]);

  const handleColResizeStart = (e: React.MouseEvent, col: number) => {
    e.preventDefault();
    e.stopPropagation();
    onBeginStructureDrag?.();
    const startX = e.clientX;
    const origW = sheet.colWidths[col] ?? DEFAULT_COL_W;
    const scale = zoom || 1;
    const onMove = (ev: MouseEvent) => {
      onResizeCol(col, Math.max(44, Math.round(origW + (ev.clientX - startX) / scale)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleRowResizeStart = (e: React.MouseEvent, row: number) => {
    e.preventDefault();
    e.stopPropagation();
    onBeginStructureDrag?.();
    const startY = e.clientY;
    const origH = sheet.rowHeights[row] ?? DEFAULT_ROW_H;
    const scale = zoom || 1;
    const onMove = (ev: MouseEvent) => {
      onResizeRow(row, Math.max(20, Math.round(origH + (ev.clientY - startY) / scale)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleCellMouseDown = (e: React.MouseEvent, row: number, col: number) => {
    if (e.button === 2) {
      // Right-click: select cell if outside current selection
      if (!isCoordInRange({ row, col }, normRange)) {
        onSelect({ anchor: { row, col }, focus: { row, col } });
      }
      return;
    }

    // If currently editing a formula and user clicks another cell, insert its reference!
    if (
      editingCoord &&
      editDraft.startsWith('=') &&
      (editingCoord.row !== row || editingCoord.col !== col)
    ) {
      const trimmedEnd = editDraft.trimEnd();
      const lastChar = trimmedEnd[trimmedEnd.length - 1];
      if ('=+-*/^&(,:<>'.includes(lastChar)) {
        e.preventDefault();
        onChangeDraft(editDraft + coordToAddress(row, col));
        return;
      }
    }

    if (editingCoord && (editingCoord.row !== row || editingCoord.col !== col)) {
      onCommitEdit('none');
    }

    if (e.shiftKey) {
      onSelect({ anchor: selection.anchor, focus: { row, col } });
    } else {
      onSelect({ anchor: { row, col }, focus: { row, col } });
      setIsDraggingSelect(true);
    }
  };

  const handleCellMouseEnter = (row: number, col: number) => {
    if (isDraggingSelect) {
      onSelect({ anchor: selection.anchor, focus: { row, col } });
    } else if (isDraggingFill) {
      setFillTarget({
        startRow: Math.min(normRange.startRow, row),
        startCol: Math.min(normRange.startCol, col),
        endRow: Math.max(normRange.endRow, row),
        endCol: Math.max(normRange.endCol, col),
      });
    }
  };

  const [viewport, setViewport] = useState({ left: 0, top: 0, width: 1000, height: 650 });
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setViewport({ left: container.scrollLeft, top: container.scrollTop, width: container.clientWidth, height: container.clientHeight }));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    container.addEventListener('scroll', measure, { passive: true });
    measure();
    return () => { observer.disconnect(); container.removeEventListener('scroll', measure); cancelAnimationFrame(frame); };
  }, []);

  const totalWidth = (colLeftOffsets.at(-1) ?? 44) + (sheet.colWidths[sheet.colCount - 1] ?? DEFAULT_COL_W);
  const { rowIndices, colIndices } = useMemo(() => {
    let frozenVisibleCount = 0;
    for (const r of visibleRowList) {
      if (r < sheet.frozenRows) frozenVisibleCount++;
      else break;
    }
    const visPositions = visibleIndices(
      visibleRowOffsets,
      viewport.top,
      viewport.height,
      frozenVisibleCount,
      5
    );
    const rows = new Set<number>(visPositions.map((pos) => visibleRowList[pos]));
    const cols = new Set(visibleIndices(colLeftOffsets, viewport.left, viewport.width, sheet.frozenCols, 2));
    // Include the complete span of every visible merge so native table spans stay aligned.
    for (const merge of sheet.merges) {
      const visibleRow = [...rows].some((row) => row >= merge.startRow && row <= merge.endRow);
      const visibleCol = [...cols].some((col) => col >= merge.startCol && col <= merge.endCol);
      if (!visibleRow || !visibleCol) continue;
      for (let row = merge.startRow; row <= merge.endRow; row++) {
        if (!hiddenRows?.has(row)) rows.add(row);
      }
      for (let col = merge.startCol; col <= merge.endCol; col++) cols.add(col);
    }
    if (editingCoord && !hiddenRows?.has(editingCoord.row)) {
      rows.add(editingCoord.row);
      cols.add(editingCoord.col);
    }
    if (
      selection.focus.row >= 0 &&
      selection.focus.row < sheet.rowCount &&
      !hiddenRows?.has(selection.focus.row)
    ) {
      rows.add(selection.focus.row);
    }
    if (selection.focus.col >= 0 && selection.focus.col < sheet.colCount) {
      cols.add(selection.focus.col);
    }
    return { rowIndices: [...rows].sort((a, b) => a - b), colIndices: [...cols].sort((a, b) => a - b) };
  }, [
    visibleRowList,
    visibleRowOffsets,
    hiddenRows,
    colLeftOffsets,
    viewport,
    sheet.frozenRows,
    sheet.frozenCols,
    sheet.merges,
    sheet.rowCount,
    sheet.colCount,
    editingCoord,
    selection.focus.row,
    selection.focus.col,
  ]);

  const columnGap = (index: number) => colLeftOffsets[colIndices[index]] - (index === 0 ? 44 : colLeftOffsets[colIndices[index - 1]] + (sheet.colWidths[colIndices[index - 1]] ?? DEFAULT_COL_W));
  const lastCol = colIndices.at(-1);
  const lastRow = rowIndices.at(-1);
  const trailingWidth =
    lastCol === undefined
      ? Math.max(0, totalWidth - 44)
      : Math.max(0, totalWidth - (colLeftOffsets[lastCol] + (sheet.colWidths[lastCol] ?? DEFAULT_COL_W)));
  const tableColumnCount = 1 + colIndices.length + colIndices.filter((_, i) => columnGap(i) > 0).length + (trailingWidth > 0 ? 1 : 0);
  const trailingHeight =
    lastRow === undefined
      ? Math.max(0, totalHeight - 26)
      : Math.max(0, totalHeight - ((rowTopMap.get(lastRow) ?? 26) + (sheet.rowHeights[lastRow] ?? DEFAULT_ROW_H)));

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const { row, col } = selection.focus;
    const top = rowTopMap.get(row);
    const left = colLeftOffsets[col];
    const height = sheet.rowHeights[row] ?? DEFAULT_ROW_H;
    const width = sheet.colWidths[col] ?? DEFAULT_COL_W;
    let frozenHeight = 26;
    for (let r = 0; r < sheet.frozenRows; r++) {
      if (!hiddenRows?.has(r)) frozenHeight += sheet.rowHeights[r] ?? DEFAULT_ROW_H;
    }
    const frozenWidth = colLeftOffsets[sheet.frozenCols] ?? 44;
    if (top !== undefined) {
      if (row >= sheet.frozenRows && top < el.scrollTop + frozenHeight) el.scrollTop = top - frozenHeight;
      else if (top + height > el.scrollTop + el.clientHeight) el.scrollTop = top + height - el.clientHeight;
    }
    if (left !== undefined) {
      if (col >= sheet.frozenCols && left < el.scrollLeft + frozenWidth) el.scrollLeft = left - frozenWidth;
      else if (left + width > el.scrollLeft + el.clientWidth) el.scrollLeft = left + width - el.clientWidth;
    }
  }, [selection.focus.row, selection.focus.col, rowTopMap, colLeftOffsets, sheet.frozenRows, sheet.frozenCols, sheet.rowHeights, sheet.colWidths, hiddenRows]);

  // Unique values for the currently open column AutoFilter dropdown
  const filterMenuOptions = useMemo(() => {
    if (!filterMenu || !sheet.filter?.enabled) return [];
    const headerRow = sheet.filter.headerRow;
    const counts = new Map<string, number>();
    for (let r = headerRow + 1; r <= maxUsedRow; r++) {
      const formatted = computed[coordToAddress(r, filterMenu.col)]?.formatted ?? '';
      const display = formatted === '' ? '(Blanks)' : formatted;
      counts.set(display, (counts.get(display) ?? 0) + 1);
    }
    const entries = [...counts.entries()].sort((a, b) => {
      if (a[0] === '(Blanks)') return 1;
      if (b[0] === '(Blanks)') return -1;
      return a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: 'base' });
    });
    const q = filterMenu.search.trim().toLowerCase();
    return q ? entries.filter(([val]) => val.toLowerCase().includes(q)) : entries;
  }, [filterMenu, sheet.filter, maxUsedRow, computed]);

  const openColumnFilterMenu = (e: React.MouseEvent, col: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (filterMenu?.col === col) {
      setFilterMenu(null);
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const scale = zoom || 1;
    const menuW = 236;
    const menuH = 330;
    const x = Math.max(8, Math.min(rect.right / scale - menuW, window.innerWidth / scale - menuW - 8));
    const y = Math.max(8, Math.min(rect.bottom / scale + 4, window.innerHeight / scale - menuH - 8));
    const existing = sheet.filter?.hiddenValues[col] ?? [];
    setFilterMenu({
      col,
      x,
      y,
      search: '',
      draftExcluded: new Set(existing),
    });
  };

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-auto relative bg-slate-100/60 select-none"
      onContextMenu={(e) => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <table
        className="border-collapse table-fixed bg-white"
        style={{ width: totalWidth }}
        aria-rowcount={sheet.rowCount + 1}
        aria-colcount={sheet.colCount + 1}
      >
        <colgroup>
          <col style={{ width: 44 }} />
          {colIndices.map((c, i) => <React.Fragment key={c}>
            {columnGap(i) > 0 && <col style={{ width: columnGap(i) }} />}
            <col style={{ width: sheet.colWidths[c] ?? DEFAULT_COL_W }} />
          </React.Fragment>)}
          {trailingWidth > 0 && <col style={{ width: trailingWidth }} />}
        </colgroup>
        <thead>
          <tr style={{ height: 26 }}>
            {/* Top-left Select-All Corner */}
            <th
              onClick={() =>
                onSelect({
                  anchor: { row: 0, col: 0 },
                  focus: { row: sheet.rowCount - 1, col: sheet.colCount - 1 },
                })
              }
              style={{ width: 44, minWidth: 44, maxWidth: 44, left: 0, top: 0 }}
              className="sticky z-50 bg-slate-100 border-r border-b border-slate-300 cursor-pointer hover:bg-slate-200 transition"
              title="Select All"
            />

            {colIndices.map((c, ci) => {
              const colW = sheet.colWidths[c] ?? DEFAULT_COL_W;
              const isSelectedCol = c >= normRange.startCol && c <= normRange.endCol;
              const isFrozenCol = c < sheet.frozenCols;
              return (
                <React.Fragment key={c}>
                {columnGap(ci) > 0 && <th aria-hidden="true" style={{ width: columnGap(ci) }} />}
                <th
                  onClick={() =>
                    onSelect({
                      anchor: { row: 0, col: c },
                      focus: { row: sheet.rowCount - 1, col: c },
                    })
                  }
                  style={{
                    width: colW,
                    minWidth: colW,
                    maxWidth: colW,
                    top: 0,
                    left: isFrozenCol ? colLeftOffsets[c] : undefined,
                  }}
                  className={`sticky ${
                    isFrozenCol ? 'z-40' : 'z-20'
                  } border-r border-b border-slate-300 text-[11px] font-semibold cursor-pointer relative transition ${
                    isSelectedCol
                      ? 'bg-emerald-100/80 text-emerald-800 border-b-emerald-500'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200/70'
                  }`}
                >
                  {colToLetter(c)}
                  <div
                    onMouseDown={(e) => handleColResizeStart(e, c)}
                    className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-emerald-500/60"
                  />
                </th>
                </React.Fragment>
              );
            })}
            {trailingWidth > 0 && <th aria-hidden="true" style={{ width: trailingWidth }} />}
          </tr>
        </thead>

        <tbody>
          {rowIndices.map((r, ri) => {
            const rowH = sheet.rowHeights[r] ?? DEFAULT_ROW_H;
            const rowTop = rowTopMap.get(r) ?? 26;
            const prevBottom =
              ri === 0
                ? 26
                : (rowTopMap.get(rowIndices[ri - 1]) ?? 26) +
                  (sheet.rowHeights[rowIndices[ri - 1]] ?? DEFAULT_ROW_H);
            const rowGap = rowTop - prevBottom;
            const isSelectedRow = r >= normRange.startRow && r <= normRange.endRow;
            const isFrozenRow = r < sheet.frozenRows;
            const isFilterHeaderRow = Boolean(sheet.filter?.enabled && sheet.filter.headerRow === r);

            return (
              <React.Fragment key={r}>
              {rowGap > 0 &&
                <tr aria-hidden="true" style={{ height: rowGap }}><td colSpan={tableColumnCount} /></tr>}
              <tr data-row-index={r} aria-rowindex={r + 2} style={{ height: rowH }}>
                {/* Row Number Header */}
                <td
                  onClick={() =>
                    onSelect({
                      anchor: { row: r, col: 0 },
                      focus: { row: r, col: sheet.colCount - 1 },
                    })
                  }
                  style={{
                    width: 44,
                    minWidth: 44,
                    maxWidth: 44,
                    left: 0,
                    top: isFrozenRow ? rowTop : undefined,
                    height: rowH,
                  }}
                  className={`sticky ${
                    isFrozenRow ? 'z-40' : 'z-30'
                  } border-r border-b border-slate-300 text-[11px] font-medium text-center cursor-pointer relative transition ${
                    isSelectedRow
                      ? 'bg-emerald-100/80 text-emerald-800 border-r-emerald-500'
                      : 'bg-slate-100 text-slate-500 hover:bg-slate-200/70'
                  }`}
                >
                  {r + 1}
                  <div
                    onMouseDown={(e) => handleRowResizeStart(e, r)}
                    className="absolute left-0 right-0 bottom-0 h-1 cursor-row-resize hover:bg-emerald-500/60"
                  />
                </td>

                {colIndices.map((c, ci) => {
                  const addr = coordToAddress(r, c);
                  if (mergeHiddenSet.has(addr)) return null;

                  const mergeSpan = mergeOriginMap.get(addr);
                  const cell = sheet.cells[addr];
                  const evalCell = computed[addr];
                  const st = cell?.style;
                  const isAnchor = selection.anchor.row === r && selection.anchor.col === c;
                  const inSelection = isCoordInRange({ row: r, col: c }, normRange);
                  const inFillPreview =
                    fillTarget !== null &&
                    isCoordInRange({ row: r, col: c }, fillTarget) &&
                    !inSelection;
                  const isEditingThis =
                    editingCoord !== null && editingCoord.row === r && editingCoord.col === c;
                  const isBottomRightOfSelection =
                    r === normRange.endRow && c === normRange.endCol && !editingCoord;

                  const isFrozenCol = c < sheet.frozenCols;
                  const isFrozenCell = isFrozenRow || isFrozenCol;

                  // Formula reference highlight color
                  let refColor: string | undefined;
                  for (let idx = 0; idx < formulaHighlights.length; idx++) {
                    const hl = formulaHighlights[idx];
                    if (
                      r >= hl.startRow &&
                      r <= hl.endRow &&
                      c >= hl.startCol &&
                      c <= hl.endCol
                    ) {
                      refColor = REF_COLORS[idx % REF_COLORS.length];
                      break;
                    }
                  }

                  // Default right-align numbers like Excel
                  const isNumeric = typeof evalCell?.value === 'number';
                  const textAlign = st?.align ?? (isNumeric ? 'right' : 'left');

                  // Evaluate conditional formatting rules dynamically
                  let cfColor: string | undefined;
                  let cfBg: string | undefined;
                  let cfBgImage: string | undefined;
                  if (preparedCondRules.length > 0 && evalCell && !evalCell.error) {
                    const val = evalCell.value;
                    const fmt = evalCell.formatted ?? '';
                    for (const pr of preparedCondRules) {
                      if (r < pr.startRow || r > pr.endRow || c < pr.startCol || c > pr.endCol) {
                        continue;
                      }
                      const rule = pr.rule;
                      if (rule.kind === 'greaterThan') {
                        const threshold = Number(rule.value);
                        if (typeof val === 'number' && Number.isFinite(threshold) && val > threshold) {
                          if (rule.color) cfColor = rule.color;
                          if (rule.backgroundColor) cfBg = rule.backgroundColor;
                        }
                      } else if (rule.kind === 'lessThan') {
                        const threshold = Number(rule.value);
                        if (typeof val === 'number' && Number.isFinite(threshold) && val < threshold) {
                          if (rule.color) cfColor = rule.color;
                          if (rule.backgroundColor) cfBg = rule.backgroundColor;
                        }
                      } else if (rule.kind === 'equals') {
                        const targetStr = (rule.value ?? '').trim();
                        const targetNum = Number(targetStr);
                        const matched =
                          typeof val === 'number' && targetStr !== '' && Number.isFinite(targetNum)
                            ? val === targetNum
                            : fmt.trim().toLowerCase() === targetStr.toLowerCase();
                        if (matched && val !== null && fmt !== '') {
                          if (rule.color) cfColor = rule.color;
                          if (rule.backgroundColor) cfBg = rule.backgroundColor;
                        }
                      } else if (rule.kind === 'contains') {
                        const needle = (rule.value ?? '').trim().toLowerCase();
                        if (needle !== '' && fmt.toLowerCase().includes(needle)) {
                          if (rule.color) cfColor = rule.color;
                          if (rule.backgroundColor) cfBg = rule.backgroundColor;
                        }
                      } else if (rule.kind === 'colorScale') {
                        if (typeof val === 'number' && Number.isFinite(val) && pr.hasNumeric) {
                          const t = pr.max > pr.min ? (val - pr.min) / (pr.max - pr.min) : 0.5;
                          cfBg = interpolateColorScale(t);
                          cfColor = '#0f172a';
                        }
                      } else if (rule.kind === 'dataBar') {
                        if (typeof val === 'number' && Number.isFinite(val) && pr.hasNumeric) {
                          let pct = 0;
                          if (pr.min >= 0) {
                            pct = pr.max > 0 ? Math.max(0, Math.min(100, (val / pr.max) * 100)) : 0;
                          } else if (pr.max > pr.min) {
                            pct = Math.max(0, Math.min(100, ((val - pr.min) / (pr.max - pr.min)) * 100));
                          }
                          const barFill = rule.backgroundColor || '#86efac';
                          cfBgImage = `linear-gradient(to right, ${barFill}88 ${pct.toFixed(1)}%, transparent ${pct.toFixed(1)}%)`;
                        }
                      }
                    }
                  }

                  const borderColor = st?.border?.color ?? '#94a3b8';
                  const hasColFilter = Boolean(
                    isFilterHeaderRow && (sheet.filter?.hiddenValues[c]?.length ?? 0) > 0
                  );

                  const tdStyle: React.CSSProperties = {
                    fontWeight: st?.bold ? 700 : 400,
                    fontStyle: st?.italic ? 'italic' : 'normal',
                    textDecoration: [
                      st?.underline ? 'underline' : '',
                      st?.strikethrough ? 'line-through' : '',
                    ]
                      .filter(Boolean)
                      .join(' ') || undefined,
                    fontFamily: st?.fontFamily || undefined,
                    fontSize: st?.fontSize ? `${st.fontSize}px` : '12px',
                    color: evalCell?.error ? '#dc2626' : cfColor || st?.color || '#0f172a',
                    backgroundColor:
                      cfBg ||
                      st?.backgroundColor ||
                      (inSelection && !isAnchor ? '#ecfdf5' : '#ffffff'),
                    backgroundImage: cfBgImage,
                    textAlign,
                    borderTop: st?.border?.top ? `1.5px solid ${borderColor}` : undefined,
                    borderRight: st?.border?.right ? `1.5px solid ${borderColor}` : undefined,
                    borderBottom: st?.border?.bottom ? `1.5px solid ${borderColor}` : undefined,
                    borderLeft: st?.border?.left ? `1.5px solid ${borderColor}` : undefined,
                    position: isFrozenCell ? 'sticky' : 'relative',
                    top: isFrozenRow ? rowTop : undefined,
                    left: isFrozenCol ? colLeftOffsets[c] : undefined,
                    zIndex: isEditingThis
                      ? 35
                      : isFrozenRow && isFrozenCol
                        ? 25
                        : isFrozenCell
                          ? 15
                          : undefined,
                    boxShadow: refColor
                      ? `inset 0 0 0 1.5px ${refColor}`
                      : isAnchor
                        ? 'inset 0 0 0 2px #059669'
                        : inFillPreview
                          ? 'inset 0 0 0 1.5px #10b981'
                          : undefined,
                  };

                  return (
                    <React.Fragment key={c}>
                    {columnGap(ci) > 0 && <td aria-hidden="true" style={{ width: columnGap(ci), padding: 0 }} />}
                    <td
                      data-cell={addr}
                      aria-colindex={c + 2}
                      rowSpan={mergeSpan?.rowSpan}
                      colSpan={mergeSpan?.colSpan}
                      style={tdStyle}
                      onMouseDown={(e) => handleCellMouseDown(e, r, c)}
                      onMouseEnter={() => handleCellMouseEnter(r, c)}
                      onDoubleClick={() => onStartEdit({ row: r, col: c })}
                      className={`border-r border-b border-slate-200 px-1.5 py-0 cursor-cell ${
                        isFilterHeaderRow && !isEditingThis ? 'pr-6' : ''
                      } ${
                        st?.wrap ? 'whitespace-normal break-words' : 'whitespace-nowrap overflow-hidden text-ellipsis'
                      }`}
                    >
                      {isEditingThis ? (
                        <input
                          ref={inputRef}
                          value={editDraft}
                          onChange={(e) => onChangeDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              onCommitEdit('down');
                            } else if (e.key === 'Tab') {
                              e.preventDefault();
                              onCommitEdit('right');
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              onCancelEdit();
                            }
                          }}
                          className="w-full h-full bg-white text-slate-900 font-mono text-xs focus:outline-none px-0.5"
                        />
                      ) : (
                        <span>{evalCell?.formatted ?? ''}</span>
                      )}

                      {/* AutoFilter funnel button on filter header row */}
                      {isFilterHeaderRow && !isEditingThis && (
                        <button
                          type="button"
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => openColumnFilterMenu(e, c)}
                          title={hasColFilter ? 'Filter active — click to edit' : 'Filter or sort column'}
                          className={`absolute right-1 top-1/2 -translate-y-1/2 w-4 h-4 rounded flex items-center justify-center transition ${
                            hasColFilter
                              ? 'bg-emerald-500 text-white shadow-xs'
                              : 'bg-slate-200/80 text-slate-600 hover:bg-slate-300'
                          }`}
                        >
                          <Filter className="w-2.5 h-2.5" />
                        </button>
                      )}

                      {/* Excel-style Fill Handle at bottom-right of selection */}
                      {isBottomRightOfSelection && (
                        <div
                          onMouseDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setIsDraggingFill(true);
                            setFillTarget(normRange);
                          }}
                          title="Drag to auto-fill series or copy formulas"
                          className="absolute -right-[4px] -bottom-[4px] w-2.5 h-2.5 bg-emerald-600 border border-white cursor-crosshair z-30 rounded-[1px]"
                        />
                      )}
                    </td>
                    </React.Fragment>
                  );
                })}
                {trailingWidth > 0 && <td aria-hidden="true" style={{ width: trailingWidth, padding: 0 }} />}
              </tr>
              </React.Fragment>
            );
          })}
          {trailingHeight > 0 && <tr aria-hidden="true" style={{ height: trailingHeight }}><td colSpan={tableColumnCount} /></tr>}
        </tbody>
      </table>

      {/* Embedded Live Charts */}
      {sheet.charts.map((chart) => (
        <ChartOverlay
          key={chart.id}
          chart={chart}
          computed={computed}
          zoom={zoom}
          onBeginChange={onBeginStructureDrag}
          onUpdate={onUpdateChart}
          onDelete={onDeleteChart}
        />
      ))}

      {/* AutoFilter Column Dropdown Menu */}
      {filterMenu && sheet.filter?.enabled && (
        <div
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          style={{ left: filterMenu.x, top: filterMenu.y }}
          className="fixed z-50 w-60 bg-white border border-slate-200 rounded-xl shadow-2xl overflow-hidden text-xs select-none"
        >
          <div className="px-3 py-2 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
            <span className="font-semibold text-slate-700 truncate">
              Filter: {computed[coordToAddress(sheet.filter.headerRow, filterMenu.col)]?.formatted || `Col ${colToLetter(filterMenu.col)}`}
            </span>
            <button
              type="button"
              onClick={() => setFilterMenu(null)}
              className="p-0.5 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-200"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="p-1.5 border-b border-slate-100 space-y-0.5">
            <button
              type="button"
              onClick={() => {
                onSortColumn?.(filterMenu.col, 'asc');
                setFilterMenu(null);
              }}
              className="w-full px-2 py-1.5 rounded-md hover:bg-emerald-50 text-slate-700 flex items-center gap-2 transition"
            >
              <ArrowUpAZ className="w-3.5 h-3.5 text-emerald-600" />
              <span>Sort A → Z</span>
            </button>
            <button
              type="button"
              onClick={() => {
                onSortColumn?.(filterMenu.col, 'desc');
                setFilterMenu(null);
              }}
              className="w-full px-2 py-1.5 rounded-md hover:bg-emerald-50 text-slate-700 flex items-center gap-2 transition"
            >
              <ArrowDownZA className="w-3.5 h-3.5 text-emerald-600" />
              <span>Sort Z → A</span>
            </button>
          </div>

          <div className="p-2 border-b border-slate-100 space-y-1.5">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2" />
              <input
                value={filterMenu.search}
                onChange={(e) =>
                  setFilterMenu((prev) => (prev ? { ...prev, search: e.target.value } : null))
                }
                placeholder="Search values..."
                className="w-full pl-7 pr-2 py-1 text-xs border border-slate-200 rounded-md focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div className="flex items-center justify-between text-[11px] px-0.5">
              <button
                type="button"
                onClick={() =>
                  setFilterMenu((prev) => (prev ? { ...prev, draftExcluded: new Set() } : null))
                }
                className="text-emerald-700 hover:underline font-medium"
              >
                Select All
              </button>
              <button
                type="button"
                onClick={() =>
                  setFilterMenu((prev) =>
                    prev
                      ? { ...prev, draftExcluded: new Set(filterMenuOptions.map(([v]) => v)) }
                      : null
                  )
                }
                className="text-slate-500 hover:underline"
              >
                Clear All
              </button>
            </div>
          </div>

          <div className="max-h-44 overflow-y-auto p-1.5 space-y-0.5">
            {filterMenuOptions.map(([val, count]) => {
              const checked = !filterMenu.draftExcluded.has(val);
              return (
                <label
                  key={val}
                  className="flex items-center justify-between gap-2 px-2 py-1 rounded hover:bg-slate-50 cursor-pointer"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        setFilterMenu((prev) => {
                          if (!prev) return null;
                          const next = new Set(prev.draftExcluded);
                          if (next.has(val)) next.delete(val);
                          else next.add(val);
                          return { ...prev, draftExcluded: next };
                        });
                      }}
                      className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                    />
                    <span className="truncate text-slate-700">{val}</span>
                  </span>
                  <span className="text-[10px] font-mono text-slate-400 shrink-0">{count}</span>
                </label>
              );
            })}
            {filterMenuOptions.length === 0 && (
              <div className="py-4 text-center text-[11px] text-slate-400">No values found</div>
            )}
          </div>

          <div className="px-2.5 py-2 bg-slate-50 border-t border-slate-100 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                onUpdateColumnFilter?.(filterMenu.col, []);
                setFilterMenu(null);
              }}
              className="px-2 py-1 rounded text-[11px] font-medium text-slate-600 hover:bg-slate-200 transition"
            >
              Clear Filter
            </button>
            <button
              type="button"
              onClick={() => {
                onUpdateColumnFilter?.(filterMenu.col, [...filterMenu.draftExcluded]);
                setFilterMenu(null);
              }}
              className="px-3 py-1 rounded-md text-[11px] font-semibold bg-emerald-600 text-white hover:bg-emerald-700 transition"
            >
              Apply
            </button>
          </div>
        </div>
      )}

      {/* Right-Click Excel-Style Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={
            [
              { id: 'cut', label: 'Cut', shortcut: '⌘X', onClick: () => onContextAction('cut') },
              { id: 'copy', label: 'Copy', shortcut: '⌘C', onClick: () => onContextAction('copy') },
              { id: 'paste', label: 'Paste', shortcut: '⌘V', onClick: () => onContextAction('paste') },
              { id: 'd1', divider: true },
              { id: 'insRowAbove', label: 'Insert Row Above', onClick: () => onContextAction('insertRowAbove') },
              { id: 'insRowBelow', label: 'Insert Row Below', onClick: () => onContextAction('insertRowBelow') },
              { id: 'delRow', label: 'Delete Row', danger: true, onClick: () => onContextAction('deleteRow') },
              { id: 'd2', divider: true },
              { id: 'insColLeft', label: 'Insert Column Left', onClick: () => onContextAction('insertColLeft') },
              { id: 'insColRight', label: 'Insert Column Right', onClick: () => onContextAction('insertColRight') },
              { id: 'delCol', label: 'Delete Column', danger: true, onClick: () => onContextAction('deleteCol') },
              { id: 'd3', divider: true },
              { id: 'sortAsc', label: 'Sort A → Z', onClick: () => onContextAction('sortAsc') },
              { id: 'sortDesc', label: 'Sort Z → A', onClick: () => onContextAction('sortDesc') },
              { id: 'fmtCur', label: 'Format as Currency ($)', onClick: () => onContextAction('formatCurrency') },
              { id: 'fmtPct', label: 'Format as Percent (%)', onClick: () => onContextAction('formatPercent') },
              { id: 'merge', label: 'Merge / Unmerge Cells', onClick: () => onContextAction('toggleMerge') },
              { id: 'd4', divider: true },
              { id: 'chart', label: 'Insert Chart from Selection', onClick: () => onContextAction('insertChart') },
              { id: 'docs', label: 'Copy as Table for Docs', onClick: () => onContextAction('sendToDocs') },
              { id: 'd5', divider: true },
              { id: 'clear', label: 'Clear Contents', shortcut: '⌫', onClick: () => onContextAction('clear') },
            ] as ContextMenuItem[]
          }
        />
      )}
    </div>
  );
};
