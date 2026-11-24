import { addXlsxCharts, readXlsxRelatedParts } from './xlsxRelatedParts';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {
  CellData,
  CellStyle,
  MergeRange,
  SheetData,
  WorkbookData,
  XlsxSheetMetadata,
  XlsxTableDefinition,
} from '../../../types/spreadsheet';
import { coordToAddress, parseAddress, parseRange, shiftFormulaReferences } from '../address';
import { evaluateWorkbook } from '../formulaEngine';
import { fromExcelNumFmt, toExcelNumFmt } from '../formatter';
import { uid } from '../workbookOps';

const DEFAULT_OOXML_NAMESPACES = [
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://schemas.openxmlformats.org/package/2006/relationships',
  'http://schemas.openxmlformats.org/package/2006/content-types',
  'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties',
];

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize OOXML (.xlsx) archives produced by OpenXML SDK / ChatGPT / Python / .NET tools
 * that prefix SpreadsheetML elements (e.g. `<x:workbook xmlns:x="...">`), include UTF-8 BOMs
 * in `.rels` / `.xml` entries, or use root-relative `/xl/...` relationship targets.
 */
async function normalizeXlsxArchive(ab: ArrayBuffer): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(ab);

  // Fast-path probe on small header files (xl/workbook.xml & xl/_rels/workbook.xml.rels)
  // so 20MB+ standard Excel workbooks (180MB+ worksheet XML) skip full-archive string decompression!
  const wbEntry = zip.file('xl/workbook.xml');
  const wbRelsEntry = zip.file('xl/_rels/workbook.xml.rels');
  if (wbEntry) {
    const wbHead = (await wbEntry.async('string')).slice(0, 600);
    const relsHead = wbRelsEntry ? (await wbRelsEntry.async('string')).slice(0, 600) : '';
    const hasPrefixedMainNs = /xmlns:[A-Za-z0-9_]+="http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main"/.test(wbHead);
    const hasBomOrRootRel =
      wbHead.startsWith('\uFEFF') ||
      relsHead.startsWith('\uFEFF') ||
      /Target="\/?xl\//.test(relsHead);
    if (!hasPrefixedMainNs && !hasBomOrRootRel) {
      return ab;
    }
  }

  let modified = false;

  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (entry.dir || (!entryName.endsWith('.xml') && !entryName.endsWith('.rels'))) {
      continue;
    }
    const orig = await entry.async('string');
    let next = orig.replace(/^\uFEFF/, '');
    const head = next.slice(0, 1024);

    for (const nsUri of DEFAULT_OOXML_NAMESPACES) {
      const nsRegex = new RegExp(`xmlns:([A-Za-z0-9_]+)="${escapeRegExp(nsUri)}"`);
      const match = nsRegex.exec(head);
      if (match) {
        const prefix = match[1];
        const hasDefaultNs = new RegExp(`xmlns="${escapeRegExp(nsUri)}"`).test(head);
        next = next.replace(
          new RegExp(`\\s*xmlns:${escapeRegExp(prefix)}="${escapeRegExp(nsUri)}"`, 'g'),
          hasDefaultNs ? '' : ` xmlns="${nsUri}"`
        );
        next = next
          .replace(new RegExp(`<${escapeRegExp(prefix)}:`, 'g'), '<')
          .replace(new RegExp(`</${escapeRegExp(prefix)}:`, 'g'), '</');
      }
    }

    if (entryName.startsWith('xl/worksheets/_rels/') && entryName.endsWith('.rels')) {
      next = next.replace(/Target="\/?xl\//g, 'Target="../');
    } else if (entryName.startsWith('xl/_rels/') && entryName.endsWith('.rels')) {
      next = next.replace(/Target="\/?xl\//g, 'Target="');
    }

    if (next !== orig) {
      zip.file(entryName, next);
      modified = true;
    }
  }

  if (!modified) return ab;
  return zip.generateAsync({ type: 'arraybuffer' });
}

function hexToArgb(hex?: string): string | undefined {
  if (!hex) return undefined;
  const clean = hex.replace('#', '').trim();
  if (clean.length === 6) return `FF${clean.toUpperCase()}`;
  if (clean.length === 8) return clean.toUpperCase();
  return undefined;
}

function argbToHex(argb?: string): string | undefined {
  if (!argb || typeof argb !== 'string') return undefined;
  const clean = argb.trim();
  if (clean.length === 8) return `#${clean.slice(2).toLowerCase()}`;
  if (clean.length === 6) return `#${clean.toLowerCase()}`;
  return undefined;
}

type XlsxWorksheetModel = ExcelJS.WorksheetModel & {
  tables?: XlsxTableDefinition[];
  dataValidations?: XlsxSheetMetadata['validations'];
};

function restoreSheetMetadata(
  worksheet: ExcelJS.Worksheet,
  metadata: XlsxSheetMetadata,
  usedTableNames: Set<string>,
  cells: SheetData['cells']
): Map<string, string> {
  const headers = new Map<string, string>();
  const tables = metadata.tables.map((original) => {
    let name = original.name;
    for (let suffix = 2; usedTableNames.has(name.toLowerCase()); suffix++) {
      name = `${original.name}_${suffix}`;
    }
    usedTableNames.add(name.toLowerCase());
    const header = original.headerRow ? parseRange(original.tableRef)?.start : undefined;
    const usedColumnNames = new Set<string>();
    return {
      ...original,
      name,
      displayName: name === original.name ? original.displayName : name,
      columns: original.columns.map((column, index) => {
        if (!header) return { ...column };
        const address = coordToAddress(header.row, header.col + index);
        const baseName = cells[address]?.raw.trim() || column.name;
        let columnName = baseName;
        for (let suffix = 2; usedColumnNames.has(columnName.toLowerCase()); suffix++) {
          columnName = `${baseName}_${suffix}`;
        }
        usedColumnNames.add(columnName.toLowerCase());
        headers.set(address, columnName);
        return { ...column, name: columnName };
      }),
    };
  });
  // addTable also writes table values. Restore only the definitions before writing cells.
  const model = worksheet.model as XlsxWorksheetModel;
  model.tables = tables;
  model.dataValidations = { ...metadata.validations };
  worksheet.model = model;
  return headers;
}

/**
 * Export a Forma Workbook to standard OOXML (.xlsx — ISO/IEC 29500).
 * Preserves formulas, cached results, cell styles, number formats, column widths,
 * row heights, frozen panes, merged cells, and multiple worksheets.
 */
export async function exportWorkbookToXlsx(workbook: WorkbookData): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Forma Office';
  wb.created = new Date(workbook.createdAt);
  wb.modified = new Date(workbook.updatedAt);

  const computed = evaluateWorkbook(workbook);
  const usedTableNames = new Set<string>();

  for (const sheet of workbook.sheets) {
    const ws = wb.addWorksheet(sheet.name, {
      views:
        sheet.frozenRows > 0 || sheet.frozenCols > 0
          ? [{ state: 'frozen', xSplit: sheet.frozenCols, ySplit: sheet.frozenRows }]
          : undefined,
    });
    const headers = sheet.xlsxMetadata && restoreSheetMetadata(ws, sheet.xlsxMetadata, usedTableNames, sheet.cells);

    // Apply column widths (Excel character width ≈ pixels / 7.5)
    for (const [colIdxStr, px] of Object.entries(sheet.colWidths)) {
      const colNum = Number(colIdxStr) + 1;
      if (colNum >= 1) {
        ws.getColumn(colNum).width = Math.max(6, Math.round((px / 7.5) * 10) / 10);
      }
    }

    // Apply row heights (points ≈ pixels * 0.75)
    for (const [rowIdxStr, px] of Object.entries(sheet.rowHeights)) {
      const rowNum = Number(rowIdxStr) + 1;
      if (rowNum >= 1) {
        ws.getRow(rowNum).height = Math.max(12, Math.round(px * 0.75));
      }
    }

    const sheetComputed = computed[sheet.id] ?? {};

    for (const [addr, cellData] of Object.entries(sheet.cells)) {
      const cell = ws.getCell(addr);
      const evalRes = sheetComputed[addr];

      const header = headers?.get(addr);
      if (header !== undefined) {
        cell.value = header;
        headers?.delete(addr);
      } else if (cellData.raw.startsWith('=')) {
        const formulaStr = cellData.raw.slice(1);
        const resultVal = evalRes && !evalRes.error ? evalRes.value ?? undefined : undefined;
        cell.value = { formula: formulaStr, result: resultVal as string | number | boolean | undefined };
      } else if (evalRes && evalRes.value !== null) {
        cell.value = evalRes.value;
      } else if (cellData.raw !== '') {
        cell.value = cellData.raw;
      }

      if (cellData.note) {
        cell.note = cellData.note;
      }

      const st = cellData.style;
      if (st) {
        const font: Partial<ExcelJS.Font> = {};
        if (st.bold) font.bold = true;
        if (st.italic) font.italic = true;
        if (st.underline) font.underline = true;
        if (st.strikethrough) font.strike = true;
        if (st.fontSize) font.size = st.fontSize;
        if (st.fontFamily) font.name = st.fontFamily;
        if (st.color) font.color = { argb: hexToArgb(st.color) };
        if (Object.keys(font).length > 0) cell.font = font;

        if (st.backgroundColor) {
          const argb = hexToArgb(st.backgroundColor);
          if (argb) {
            cell.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb },
            };
          }
        }

        if (st.align || st.valign || st.wrap) {
          cell.alignment = {
            horizontal: st.align,
            vertical: st.valign,
            wrapText: st.wrap,
          };
        }

        const numFmt = toExcelNumFmt(st.numFmt, st.decimals);
        if (numFmt) {
          cell.numFmt = numFmt;
        }

        if (st.border) {
          const bColor = { argb: hexToArgb(st.border.color ?? '#94a3b8') };
          const thin = { style: 'thin' as const, color: bColor };
          cell.border = {
            top: st.border.top ? thin : undefined,
            right: st.border.right ? thin : undefined,
            bottom: st.border.bottom ? thin : undefined,
            left: st.border.left ? thin : undefined,
          };
        }
      }
    }
    headers?.forEach((name, address) => { ws.getCell(address).value = name; });

    // Apply merges
    for (const m of sheet.merges) {
      ws.mergeCells(m.startRow + 1, m.startCol + 1, m.endRow + 1, m.endCol + 1);
    }
  }

  const buffer = await wb.xlsx.writeBuffer();
  return addXlsxCharts(new Uint8Array(buffer as ArrayBuffer), workbook, computed);
}

/**
 * Import a standard OOXML (.xlsx) file into a Forma Workbook.
 */
export async function importWorkbookFromXlsx(
  bytes: ArrayBuffer | Uint8Array,
  filename = 'Imported Workbook'
): Promise<WorkbookData> {
  const wb = new ExcelJS.Workbook();
  const rawAb: ArrayBuffer =
    bytes instanceof Uint8Array
      ? (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
      : bytes;
  const ab = await normalizeXlsxArchive(rawAb);
  await wb.xlsx.load(ab);

  const sheets: SheetData[] = [];

  wb.eachSheet((ws) => {
    const cells: Record<string, CellData> = {};
    const colWidths: Record<number, number> = {};
    const rowHeights: Record<number, number> = {};

    let maxRow = 50;
    let maxCol = 20;

    if (Array.isArray(ws.columns)) {
      ws.columns.forEach((col, idx) => {
        if (col?.width) {
          colWidths[idx] = Math.max(48, Math.round(col.width * 7.5));
        }
      });
    }

    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > maxRow) maxRow = rowNumber + 20;
      if (row.height) {
        rowHeights[rowNumber - 1] = Math.max(20, Math.round(row.height / 0.75));
      }

      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        if (colNumber > maxCol) maxCol = colNumber + 6;
        const addr = coordToAddress(rowNumber - 1, colNumber - 1);

        const isMergedSlave =
          Boolean(cell.isMerged) && Boolean(cell.master) && cell.master.address !== cell.address;

        let raw = '';
        const val = isMergedSlave ? null : cell.value;
        if (val !== null && val !== undefined) {
          if (typeof val === 'object') {
            if ('formula' in val && typeof val.formula === 'string') {
              raw = val.formula.startsWith('=') ? val.formula : `=${val.formula}`;
            } else if ('sharedFormula' in val && typeof val.sharedFormula === 'string') {
              const masterCoord = parseAddress(val.sharedFormula);
              const masterVal = ws.getCell(val.sharedFormula)?.value;
              const masterFormula =
                masterVal &&
                typeof masterVal === 'object' &&
                'formula' in masterVal &&
                typeof masterVal.formula === 'string'
                  ? masterVal.formula.startsWith('=')
                    ? masterVal.formula
                    : `=${masterVal.formula}`
                  : null;
              if (masterCoord && masterFormula) {
                raw = shiftFormulaReferences(
                  masterFormula,
                  rowNumber - 1 - masterCoord.row,
                  colNumber - 1 - masterCoord.col
                );
              } else if ('result' in val && val.result !== undefined) {
                raw =
                  typeof val.result === 'object' && val.result !== null && 'error' in val.result
                    ? String((val.result as { error: unknown }).error)
                    : String(val.result);
              }
            } else if ('richText' in val && Array.isArray(val.richText)) {
              raw = val.richText.map((r) => r.text ?? '').join('');
            } else if ('hyperlink' in val && 'text' in val && typeof val.text === 'string') {
              raw = val.text;
            } else if ('text' in val && typeof val.text === 'string') {
              raw = val.text;
            } else if ('error' in val && val.error !== undefined) {
              raw = String(val.error);
            } else if (val instanceof Date || Object.prototype.toString.call(val) === '[object Date]') {
              raw = (val as Date).toISOString().slice(0, 10);
            } else if ('result' in val && val.result !== undefined) {
              raw = String(val.result);
            }
          } else {
            raw = String(val);
          }
        }

        const style: CellStyle = {};
        if (cell.font) {
          if (cell.font.bold) style.bold = true;
          if (cell.font.italic) style.italic = true;
          if (cell.font.underline) style.underline = true;
          if (cell.font.strike) style.strikethrough = true;
          if (cell.font.size) style.fontSize = cell.font.size;
          if (cell.font.name) style.fontFamily = cell.font.name;
          if (cell.font.color?.argb) {
            const hex = argbToHex(cell.font.color.argb);
            if (hex) style.color = hex;
          }
        }

        if (cell.fill && cell.fill.type === 'pattern' && cell.fill.fgColor?.argb) {
          const bg = argbToHex(cell.fill.fgColor.argb);
          if (bg && bg !== '#000000') style.backgroundColor = bg;
        }

        if (cell.alignment) {
          if (
            cell.alignment.horizontal === 'left' ||
            cell.alignment.horizontal === 'center' ||
            cell.alignment.horizontal === 'right'
          ) {
            style.align = cell.alignment.horizontal;
          }
          if (cell.alignment.wrapText) style.wrap = true;
        }

        if (cell.numFmt) {
          const mapped = fromExcelNumFmt(cell.numFmt);
          if (mapped.numFmt) style.numFmt = mapped.numFmt;
          if (mapped.decimals !== undefined) style.decimals = mapped.decimals;
        }

        if (cell.border) {
          const b = {
            top: Boolean(cell.border.top?.style),
            right: Boolean(cell.border.right?.style),
            bottom: Boolean(cell.border.bottom?.style),
            left: Boolean(cell.border.left?.style),
            color:
              argbToHex(cell.border.top?.color?.argb) ??
              argbToHex(cell.border.bottom?.color?.argb) ??
              '#94a3b8',
          };
          if (b.top || b.right || b.bottom || b.left) style.border = b;
        }

        cells[addr] = {
          raw,
          style: Object.keys(style).length > 0 ? style : undefined,
        };
      });
    });

    const merges: MergeRange[] = [];
    const model = ws.model as XlsxWorksheetModel;
    const modelMerges = model.merges ?? [];
    for (const mStr of modelMerges) {
      const parsed = parseRange(mStr);
      if (parsed) {
        merges.push({
          startRow: Math.min(parsed.start.row, parsed.end.row),
          startCol: Math.min(parsed.start.col, parsed.end.col),
          endRow: Math.max(parsed.start.row, parsed.end.row),
          endCol: Math.max(parsed.start.col, parsed.end.col),
        });
      }
    }

    const firstView = ws.views?.[0];
    const frozenRows =
      firstView && firstView.state === 'frozen' && typeof firstView.ySplit === 'number'
        ? firstView.ySplit
        : 0;
    const frozenCols =
      firstView && firstView.state === 'frozen' && typeof firstView.xSplit === 'number'
        ? firstView.xSplit
        : 0;

    const tables = model.tables ?? [];
    const validations = model.dataValidations ?? {};
    sheets.push({
      id: uid('sheet'),
      name: ws.name || 'Sheet1',
      rowCount: maxRow,
      colCount: maxCol,
      cells,
      colWidths,
      rowHeights,
      frozenRows,
      frozenCols,
      merges,
      charts: [],
      xlsxMetadata: tables.length || Object.keys(validations).length ? { tables, validations } : undefined,
    });
  });

  if (sheets.length === 0) {
    sheets.push({
      id: uid('sheet'),
      name: 'Sheet1',
      rowCount: 60,
      colCount: 26,
      cells: {},
      colWidths: {},
      rowHeights: {},
      frozenRows: 0,
      frozenCols: 0,
      merges: [],
      charts: [],
    });
  }

  await readXlsxRelatedParts(ab, sheets);
  const now = Date.now();
  return {
    id: uid('wb'),
    title: filename.replace(/\.xlsx$/i, ''),
    sheets,
    activeSheetId: sheets[0].id,
    createdAt: now,
    updatedAt: now,
  };
}
