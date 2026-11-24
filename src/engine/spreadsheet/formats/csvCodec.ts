import { CellData, SheetData, WorkbookData } from '../../../types/spreadsheet';
import { coordToAddress, parseAddress } from '../address';
import { evaluateWorkbook } from '../formulaEngine';
import { uid } from '../workbookOps';

/** RFC 4180 CSV/TSV serializer */
export function exportSheetToDelimited(
  workbook: WorkbookData,
  sheetId: string,
  delimiter: ',' | '\t' = ','
): string {
  const sheet = workbook.sheets.find((s) => s.id === sheetId) ?? workbook.sheets[0];
  const computed = evaluateWorkbook(workbook)[sheet.id] ?? {};

  let maxRow = -1;
  let maxCol = -1;
  for (const addr of Object.keys(sheet.cells)) {
    const parsed = parseAddress(addr);
    if (!parsed) continue;
    if (sheet.cells[addr].raw === '') continue;
    if (parsed.row > maxRow) maxRow = parsed.row;
    if (parsed.col > maxCol) maxCol = parsed.col;
  }

  if (maxRow < 0 || maxCol < 0) return '';

  const lines: string[] = [];
  for (let r = 0; r <= maxRow; r++) {
    const rowCols: string[] = [];
    for (let c = 0; c <= maxCol; c++) {
      const addr = coordToAddress(r, c);
      const comp = computed[addr];
      let val = '';
      if (comp && comp.value !== null && comp.value !== undefined) {
        val = typeof comp.value === 'boolean' ? (comp.value ? 'TRUE' : 'FALSE') : String(comp.value);
      }
      if (
        val.includes(delimiter) ||
        val.includes('"') ||
        val.includes('\n') ||
        val.includes('\r')
      ) {
        val = `"${val.replace(/"/g, '""')}"`;
      }
      rowCols.push(val);
    }
    lines.push(rowCols.join(delimiter));
  }
  return lines.join('\r\n');
}

/** RFC 4180 CSV/TSV parser (strips leading UTF-8 BOM if present) */
export function parseDelimitedRows(rawText: string, delimiter: ',' | '\t' = ','): string[][] {
  const text = rawText.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"' && field === '') {
        inQuotes = true;
        i++;
      } else if (ch === delimiter) {
        row.push(field);
        field = '';
        i++;
      } else if (ch === '\r' && text[i + 1] === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        i += 2;
      } else if (ch === '\n' || ch === '\r') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        i++;
      } else {
        field += ch;
        i++;
      }
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function importWorkbookFromDelimited(
  text: string,
  filename = 'Imported Data',
  delimiter: ',' | '\t' = ','
): WorkbookData {
  const rows = parseDelimitedRows(text, delimiter);
  const cells: Record<string, CellData> = {};
  let maxCol = 20;

  rows.forEach((cols, r) => {
    if (cols.length > maxCol) maxCol = cols.length + 4;
    cols.forEach((val, c) => {
      if (val !== '') {
        cells[coordToAddress(r, c)] = { raw: val };
      }
    });
  });

  const sheet: SheetData = {
    id: uid('sheet'),
    name: filename.replace(/\.(csv|tsv)$/i, '').slice(0, 31) || 'Sheet1',
    rowCount: Math.max(60, rows.length + 20),
    colCount: Math.max(26, maxCol),
    cells,
    colWidths: {},
    rowHeights: {},
    frozenRows: 0,
    frozenCols: 0,
    merges: [],
    charts: [],
  };

  const now = Date.now();
  return {
    id: uid('wb'),
    title: filename.replace(/\.(csv|tsv)$/i, ''),
    sheets: [sheet],
    activeSheetId: sheet.id,
    createdAt: now,
    updatedAt: now,
  };
}
