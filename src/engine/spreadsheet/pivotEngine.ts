import {
  CellData,
  CellStyle,
  ComputedCell,
  NormalizedRange,
  PivotAggregation,
  PivotTableSpec,
  SheetData,
} from '../../types/spreadsheet';
import { colToLetter, coordToAddress, parseAddress, parseRange } from './address';
import { createBlankSheet } from './workbookOps';

export interface PivotTableResult {
  headers: string[];
  rows: Array<(string | number)[]>;
  rowTotals: number[];
  colTotals: number[];
  grandTotal: number;
  rowFieldName?: string;
  colFieldName?: string;
  valueFieldName?: string;
  agg?: PivotAggregation;
}

export interface PivotFieldOption {
  /** 0-based index relative to the sourceRange */
  index: number;
  /** 0-based absolute sheet column index */
  col: number;
  label: string;
  isNumeric: boolean;
}

interface AggBucket {
  nums: number[];
  count: number;
}

function createBucket(): AggBucket {
  return { nums: [], count: 0 };
}

function addToBucket(bucket: AggBucket, rawValue: string | number | boolean | null): void {
  if (rawValue === null || rawValue === '') return;
  bucket.count += 1;
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    bucket.nums.push(rawValue);
    return;
  }
  if (typeof rawValue === 'string') {
    const cleaned = rawValue.trim().replace(/[$,]/g, '');
    if (cleaned === '') return;
    if (cleaned.endsWith('%')) {
      const n = Number(cleaned.slice(0, -1));
      if (Number.isFinite(n)) bucket.nums.push(n / 100);
      return;
    }
    const n = Number(cleaned);
    if (Number.isFinite(n)) bucket.nums.push(n);
  }
}

function computeAggregate(bucket: AggBucket | undefined, agg: PivotAggregation): number {
  if (!bucket) return 0;
  switch (agg) {
    case 'count':
      return bucket.count;
    case 'sum':
      return bucket.nums.reduce((acc, v) => acc + v, 0);
    case 'avg':
      return bucket.nums.length > 0
        ? bucket.nums.reduce((acc, v) => acc + v, 0) / bucket.nums.length
        : 0;
    case 'min':
      return bucket.nums.length > 0 ? Math.min(...bucket.nums) : 0;
    case 'max':
      return bucket.nums.length > 0 ? Math.max(...bucket.nums) : 0;
  }
}

function roundClean(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1e8) / 1e8;
}

const AGG_LABELS: Record<PivotAggregation, string> = {
  sum: 'Sum',
  avg: 'Average',
  count: 'Count',
  min: 'Min',
  max: 'Max',
};

function readCell(
  sheet: SheetData,
  computed: Record<string, ComputedCell>,
  row: number,
  col: number
): { value: string | number | boolean | null; formatted: string } {
  const addr = coordToAddress(row, col);
  const comp = computed[addr];
  if (comp !== undefined) {
    return { value: comp.error ? null : comp.value, formatted: comp.formatted ?? '' };
  }
  const raw = sheet.cells[addr]?.raw ?? '';
  if (raw === '') return { value: null, formatted: '' };
  const n = Number(raw.replace(/[$,]/g, ''));
  return {
    value: Number.isFinite(n) && raw.trim() !== '' ? n : raw,
    formatted: raw,
  };
}

/** Detect the bounding range of non-empty cells on a sheet (smartly skips single-cell banner rows at the top). */
export function detectUsedRange(sheet: SheetData): NormalizedRange | null {
  const rowCols = new Map<number, number[]>();
  for (const [addr, cell] of Object.entries(sheet.cells)) {
    if (!cell || cell.raw.trim() === '') continue;
    const parsed = parseAddress(addr);
    if (!parsed) continue;
    if (!rowCols.has(parsed.row)) rowCols.set(parsed.row, []);
    rowCols.get(parsed.row)!.push(parsed.col);
  }
  if (rowCols.size === 0) return null;

  const sortedRows = [...rowCols.keys()].sort((a, b) => a - b);
  let startRow = sortedRows[0];
  // If top rows are single-cell title/subtitle banners and a multi-column table starts shortly below, start at the table header
  const firstMultiColRow = sortedRows.find((r) => (rowCols.get(r)?.length ?? 0) >= 2);
  if (firstMultiColRow !== undefined && (rowCols.get(startRow)?.length ?? 0) === 1) {
    startRow = firstMultiColRow;
  }

  let endRow = startRow;
  let startCol = Infinity;
  let endCol = -1;
  for (const r of sortedRows) {
    if (r < startRow) continue;
    endRow = Math.max(endRow, r);
    for (const c of rowCols.get(r)!) {
      if (c < startCol) startCol = c;
      if (c > endCol) endCol = c;
    }
  }
  if (!Number.isFinite(startCol) || endCol < startCol) return null;
  return { startRow, startCol, endRow, endCol };
}

/** Extract field header labels and numeric hints for the first row of `sourceRange`. */
export function extractRangeHeaders(
  sheet: SheetData,
  computed: Record<string, ComputedCell>,
  sourceRange: string
): PivotFieldOption[] {
  const parsed = parseRange(sourceRange);
  if (!parsed) return [];
  const startRow = Math.min(parsed.start.row, parsed.end.row);
  const endRow = Math.max(parsed.start.row, parsed.end.row);
  const startCol = Math.min(parsed.start.col, parsed.end.col);
  const endCol = Math.max(parsed.start.col, parsed.end.col);

  const fields: PivotFieldOption[] = [];
  for (let c = startCol; c <= endCol; c++) {
    const hdr = readCell(sheet, computed, startRow, c);
    const label = hdr.formatted.trim() || `Column ${colToLetter(c)}`;
    let numericHits = 0;
    let nonEmptyHits = 0;
    const sampleEnd = Math.min(endRow, startRow + 25);
    for (let r = startRow + 1; r <= sampleEnd; r++) {
      const cell = readCell(sheet, computed, r, c);
      if (cell.value === null || cell.value === '') continue;
      nonEmptyHits++;
      if (typeof cell.value === 'number' && Number.isFinite(cell.value)) {
        numericHits++;
      }
    }
    fields.push({
      index: c - startCol,
      col: c,
      label,
      isNumeric: nonEmptyHits > 0 && numericHits >= nonEmptyHits / 2,
    });
  }
  return fields;
}

/**
 * Pure pivot table builder supporting 1D (Row × Value) and 2D (Row × Column × Value)
 * cross-tabs with SUM, AVG, COUNT, MIN, and MAX aggregations.
 */
export function buildPivotTable(
  sheet: SheetData,
  computed: Record<string, ComputedCell>,
  spec: PivotTableSpec
): PivotTableResult {
  const parsed = parseRange(spec.sourceRange);
  if (!parsed) {
    return { headers: [], rows: [], rowTotals: [], colTotals: [], grandTotal: 0 };
  }

  const startRow = Math.min(parsed.start.row, parsed.end.row);
  const endRow = Math.max(parsed.start.row, parsed.end.row);
  const startCol = Math.min(parsed.start.col, parsed.end.col);
  const endCol = Math.max(parsed.start.col, parsed.end.col);
  const numCols = endCol - startCol + 1;

  if (
    spec.rowField < 0 ||
    spec.rowField >= numCols ||
    spec.valueField < 0 ||
    spec.valueField >= numCols ||
    (spec.colField !== undefined && (spec.colField < 0 || spec.colField >= numCols))
  ) {
    return { headers: [], rows: [], rowTotals: [], colTotals: [], grandTotal: 0 };
  }

  const rowCol = startCol + spec.rowField;
  const valCol = startCol + spec.valueField;
  const colCol = spec.colField !== undefined ? startCol + spec.colField : undefined;

  const rowHeader = readCell(sheet, computed, startRow, rowCol).formatted.trim() || `Column ${colToLetter(rowCol)}`;
  const valHeader = readCell(sheet, computed, startRow, valCol).formatted.trim() || `Column ${colToLetter(valCol)}`;
  const colHeader =
    colCol !== undefined
      ? readCell(sheet, computed, startRow, colCol).formatted.trim() || `Column ${colToLetter(colCol)}`
      : undefined;

  const rowKeySet = new Set<string>();
  const colKeySet = new Set<string>();
  const rowBuckets = new Map<string, AggBucket>();
  const colBuckets = new Map<string, AggBucket>();
  const cellBuckets = new Map<string, Map<string, AggBucket>>();
  const grandBucket = createBucket();

  for (let r = startRow + 1; r <= endRow; r++) {
    // Skip completely empty rows inside the source range
    let rowHasAnyData = false;
    for (let c = startCol; c <= endCol; c++) {
      const cell = readCell(sheet, computed, r, c);
      if (cell.value !== null && cell.value !== '' && cell.formatted.trim() !== '') {
        rowHasAnyData = true;
        break;
      }
    }
    if (!rowHasAnyData) continue;

    const rCell = readCell(sheet, computed, r, rowCol);
    const rowKey = rCell.formatted.trim() || '(Blank)';
    const vCell = readCell(sheet, computed, r, valCol);

    rowKeySet.add(rowKey);
    if (!rowBuckets.has(rowKey)) rowBuckets.set(rowKey, createBucket());
    addToBucket(rowBuckets.get(rowKey)!, vCell.value);
    addToBucket(grandBucket, vCell.value);

    if (colCol !== undefined) {
      const cCell = readCell(sheet, computed, r, colCol);
      const colKey = cCell.formatted.trim() || '(Blank)';
      colKeySet.add(colKey);
      if (!colBuckets.has(colKey)) colBuckets.set(colKey, createBucket());
      addToBucket(colBuckets.get(colKey)!, vCell.value);

      if (!cellBuckets.has(rowKey)) cellBuckets.set(rowKey, new Map());
      const byCol = cellBuckets.get(rowKey)!;
      if (!byCol.has(colKey)) byCol.set(colKey, createBucket());
      addToBucket(byCol.get(colKey)!, vCell.value);
    }
  }

  const rowKeys = [...rowKeySet].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  );
  const grandTotal = roundClean(computeAggregate(grandBucket, spec.agg));

  if (colCol === undefined) {
    const aggTitle = `${AGG_LABELS[spec.agg]} of ${valHeader}`;
    const headers = [rowHeader, aggTitle];
    const rows: Array<(string | number)[]> = [];
    const rowTotals: number[] = [];

    for (const rk of rowKeys) {
      const val = roundClean(computeAggregate(rowBuckets.get(rk), spec.agg));
      rows.push([rk, val]);
      rowTotals.push(val);
    }

    return {
      headers,
      rows,
      rowTotals,
      colTotals: [grandTotal],
      grandTotal,
      rowFieldName: rowHeader,
      valueFieldName: valHeader,
      agg: spec.agg,
    };
  }

  const colKeys = [...colKeySet].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  );
  const headers = [rowHeader, ...colKeys, 'Total'];
  const rows: Array<(string | number)[]> = [];
  const rowTotals: number[] = [];

  for (const rk of rowKeys) {
    const byCol = cellBuckets.get(rk);
    const vals = colKeys.map((ck) => roundClean(computeAggregate(byCol?.get(ck), spec.agg)));
    const rTot = roundClean(computeAggregate(rowBuckets.get(rk), spec.agg));
    rows.push([rk, ...vals, rTot]);
    rowTotals.push(rTot);
  }

  const colTotals = colKeys.map((ck) => roundClean(computeAggregate(colBuckets.get(ck), spec.agg)));

  return {
    headers,
    rows,
    rowTotals,
    colTotals,
    grandTotal,
    rowFieldName: rowHeader,
    colFieldName: colHeader,
    valueFieldName: valHeader,
    agg: spec.agg,
  };
}

/** Convert a PivotTableResult into a formatted SheetData ready to insert as a new tab in a workbook. */
export function pivotToSheetData(name: string, pivotResult: PivotTableResult): SheetData {
  const colCount = Math.max(12, pivotResult.headers.length + 4);
  const rowCount = Math.max(40, pivotResult.rows.length + 10);
  const sheet = createBlankSheet(name, rowCount, colCount);

  const cells: Record<string, CellData> = {};
  const isCount = pivotResult.agg === 'count';
  const hasFractional =
    !isCount &&
    (pivotResult.rows.some((r) => r.some((v) => typeof v === 'number' && !Number.isInteger(v))) ||
      !Number.isInteger(pivotResult.grandTotal));
  const decimals = isCount ? 0 : hasFractional ? 2 : 0;

  const headerStyle: CellStyle = {
    bold: true,
    backgroundColor: '#0f172a',
    color: '#ffffff',
    align: 'right',
    fontSize: 12,
  };
  const numStyle: CellStyle = {
    numFmt: 'number',
    decimals,
    align: 'right',
  };
  const totalStyle: CellStyle = {
    bold: true,
    backgroundColor: '#f0fdf4',
    color: '#14532d',
    numFmt: 'number',
    decimals,
    align: 'right',
    border: { top: true, bottom: true, color: '#16a34a' },
  };

  // Row 0: Headers
  pivotResult.headers.forEach((h, c) => {
    cells[coordToAddress(0, c)] = {
      raw: h,
      style: { ...headerStyle, align: c === 0 ? 'left' : 'right' },
    };
  });

  // Rows 1..N: Data rows
  const is2D = pivotResult.headers.length > 2;
  pivotResult.rows.forEach((row, idx) => {
    const r = idx + 1;
    const zebraBg = idx % 2 === 1 ? '#f8fafc' : undefined;
    row.forEach((val, c) => {
      const isRowTotalCol = is2D && c === row.length - 1;
      if (c === 0) {
        cells[coordToAddress(r, c)] = {
          raw: String(val),
          style: {
            bold: true,
            align: 'left',
            backgroundColor: zebraBg,
          },
        };
      } else {
        cells[coordToAddress(r, c)] = {
          raw: String(val),
          style: {
            ...numStyle,
            bold: isRowTotalCol || undefined,
            backgroundColor: isRowTotalCol ? '#f1f5f9' : zebraBg,
          },
        };
      }
    });
  });

  // Grand Total row
  const totalRowIdx = pivotResult.rows.length + 1;
  cells[coordToAddress(totalRowIdx, 0)] = {
    raw: 'Grand Total',
    style: {
      ...totalStyle,
      numFmt: 'general',
      align: 'left',
    },
  };
  if (is2D) {
    pivotResult.colTotals.forEach((ct, idx) => {
      cells[coordToAddress(totalRowIdx, idx + 1)] = {
        raw: String(ct),
        style: totalStyle,
      };
    });
    cells[coordToAddress(totalRowIdx, pivotResult.colTotals.length + 1)] = {
      raw: String(pivotResult.grandTotal),
      style: totalStyle,
    };
  } else if (pivotResult.headers.length >= 2) {
    cells[coordToAddress(totalRowIdx, 1)] = {
      raw: String(pivotResult.grandTotal),
      style: totalStyle,
    };
  }

  const colWidths: Record<number, number> = { 0: 210 };
  for (let c = 1; c < pivotResult.headers.length; c++) {
    colWidths[c] = 128;
  }

  return {
    ...sheet,
    cells,
    colWidths,
    rowHeights: { 0: 30 },
    frozenRows: 1,
    frozenCols: 1,
  };
}
