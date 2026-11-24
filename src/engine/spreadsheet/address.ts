import { CellCoord, CellSelection, NormalizedRange } from '../../types/spreadsheet';

/** Convert 0-based column index to Excel column letters (0 -> A, 25 -> Z, 26 -> AA) */
export function colToLetter(col: number): string {
  let n = col + 1;
  let result = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

/** Convert Excel column letters to 0-based column index (A -> 0, AA -> 26) */
export function letterToCol(letters: string): number {
  const upper = letters.toUpperCase();
  let col = 0;
  for (let i = 0; i < upper.length; i++) {
    col = col * 26 + (upper.charCodeAt(i) - 64);
  }
  return col - 1;
}

/** Convert (row, col) 0-based coordinates to A1 address */
export function coordToAddress(row: number, col: number): string {
  return `${colToLetter(col)}${row + 1}`;
}

export interface ParsedCellRef {
  row: number;
  col: number;
  absRow: boolean;
  absCol: boolean;
  sheetName?: string;
}

const CELL_REF_REGEX = /^(?:(?:'((?:[^']|'')+)'|([A-Za-z0-9_.\s-]+))!)?(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/;

/** Parse an A1 cell reference (with optional sheet prefix and $ anchors) */
export function parseAddress(ref: string): ParsedCellRef | null {
  const trimmed = ref.trim();
  const match = CELL_REF_REGEX.exec(trimmed);
  if (!match) return null;
  const rawSheet = match[1] ? match[1].replace(/''/g, "'") : match[2];
  const sheetName = rawSheet ?? undefined;
  const absCol = match[3] === '$';
  const col = letterToCol(match[4]);
  const absRow = match[5] === '$';
  const row = parseInt(match[6], 10) - 1;
  if (row < 0 || col < 0) return null;
  return { row, col, absRow, absCol, sheetName };
}

export interface ParsedRangeRef {
  start: ParsedCellRef;
  end: ParsedCellRef;
  sheetName?: string;
}

/** Parse A1:B10 or Sheet2!A1:B10 */
export function parseRange(rangeStr: string): ParsedRangeRef | null {
  const trimmed = rangeStr.trim();
  let sheetName: string | undefined;
  let body = trimmed;

  const bangIdx = trimmed.indexOf('!');
  if (bangIdx !== -1) {
    let rawSheet = trimmed.slice(0, bangIdx).trim();
    if (rawSheet.startsWith("'") && rawSheet.endsWith("'")) {
      rawSheet = rawSheet.slice(1, -1).replace(/''/g, "'");
    }
    sheetName = rawSheet;
    body = trimmed.slice(bangIdx + 1).trim();
  }

  const parts = body.split(':');
  if (parts.length === 1) {
    const single = parseAddress(parts[0]);
    if (!single) return null;
    return { start: { ...single, sheetName }, end: { ...single, sheetName }, sheetName };
  }
  if (parts.length !== 2) return null;

  const start = parseAddress(parts[0]);
  const end = parseAddress(parts[1]);
  if (!start || !end) return null;

  return {
    start: { ...start, sheetName },
    end: { ...end, sheetName },
    sheetName,
  };
}

export function normalizeSelection(sel: CellSelection): NormalizedRange {
  return {
    startRow: Math.min(sel.anchor.row, sel.focus.row),
    startCol: Math.min(sel.anchor.col, sel.focus.col),
    endRow: Math.max(sel.anchor.row, sel.focus.row),
    endCol: Math.max(sel.anchor.col, sel.focus.col),
  };
}

export function rangeToA1(range: NormalizedRange): string {
  const start = coordToAddress(range.startRow, range.startCol);
  if (range.startRow === range.endRow && range.startCol === range.endCol) {
    return start;
  }
  return `${start}:${coordToAddress(range.endRow, range.endCol)}`;
}

export function isCoordInRange(coord: CellCoord, range: NormalizedRange): boolean {
  return (
    coord.row >= range.startRow &&
    coord.row <= range.endRow &&
    coord.col >= range.startCol &&
    coord.col <= range.endCol
  );
}

/**
 * Shift relative cell references inside a formula by (dRow, dCol),
 * respecting absolute `$` anchors and preserving single-quoted sheet names (e.g. 'Q1 2026'!A1).
 */
export function shiftFormulaReferences(formula: string, dRow: number, dCol: number): string {
  if (!formula.startsWith('=')) return formula;

  // Match string literals (skip) OR optional sheet prefix + cell reference
  const tokenRegex =
    /"(?:[^"]|"")*"|((?:'(?:[^']|'')+'|[A-Za-z0-9_.-]+)!)?(?<![A-Za-z0-9_])(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?!\s*\()/g;
  return formula.replace(tokenRegex, (match, sheetPrefix, absCol, colLetters, absRow, rowDigits) => {
    if (match.startsWith('"')) return match;
    const prefix = sheetPrefix ?? '';
    const origCol = letterToCol(colLetters);
    const origRow = parseInt(rowDigits, 10) - 1;
    const newCol = absCol === '$' ? origCol : origCol + dCol;
    const newRow = absRow === '$' ? origRow : origRow + dRow;
    if (newCol < 0 || newRow < 0) return `${prefix}#REF!`;
    return `${prefix}${absCol}${colToLetter(newCol)}${absRow}${newRow + 1}`;
  });
}

/**
 * Adjust formula references after inserting or deleting a row/column at `index`.
 * Preserves cross-sheet references (e.g. Sheet2!A5 or 'Q1 2026'!A5) untouched when mutating the local sheet.
 */
export function adjustFormulaForStructureChange(
  formula: string,
  axis: 'row' | 'col',
  index: number,
  delta: 1 | -1
): string {
  if (!formula.startsWith('=')) return formula;

  const tokenRegex =
    /"(?:[^"]|"")*"|((?:'(?:[^']|'')+'|[A-Za-z0-9_.-]+)!)?(?<![A-Za-z0-9_])(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?!\s*\()/g;
  return formula.replace(tokenRegex, (match, sheetPrefix, absCol, colLetters, absRow, rowDigits) => {
    if (match.startsWith('"')) return match;
    if (sheetPrefix) return match;
    let col = letterToCol(colLetters);
    let row = parseInt(rowDigits, 10) - 1;

    if (axis === 'row') {
      if (delta === -1 && row === index) return '#REF!';
      if (row >= index) row += delta;
    } else {
      if (delta === -1 && col === index) return '#REF!';
      if (col >= index) col += delta;
    }

    if (col < 0 || row < 0) return '#REF!';
    return `${absCol}${colToLetter(col)}${absRow}${row + 1}`;
  });
}

/**
 * Extract cell/range references inside a formula for live visual color highlighting on the grid.
 */
export function extractFormulaReferences(
  formula: string
): Array<{ raw: string; startRow: number; startCol: number; endRow: number; endCol: number; sheetName?: string }> {
  if (!formula.startsWith('=')) return [];
  const results: Array<{
    raw: string;
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
    sheetName?: string;
  }> = [];

  // Strip string literals first so quotes don't match as refs
  const cleaned = formula.replace(/"(?:[^"]|"")*"/g, '""');
  const refRegex =
    /(?:(?:'((?:[^']|'')+)'|([A-Za-z0-9_.-]+))!)?\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?/g;

  let m: RegExpExecArray | null;
  while ((m = refRegex.exec(cleaned)) !== null) {
    const raw = m[0];
    const parsed = parseRange(raw);
    if (parsed) {
      results.push({
        raw,
        startRow: Math.min(parsed.start.row, parsed.end.row),
        startCol: Math.min(parsed.start.col, parsed.end.col),
        endRow: Math.max(parsed.start.row, parsed.end.row),
        endCol: Math.max(parsed.start.col, parsed.end.col),
        sheetName: parsed.sheetName,
      });
    }
  }
  return results;
}
