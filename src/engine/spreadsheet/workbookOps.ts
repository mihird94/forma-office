import {
  CellData,
  CellStyle,
  NormalizedRange,
  SheetData,
  WorkbookData,
  XlsxSheetMetadata,
} from '../../types/spreadsheet';
import {
  adjustFormulaForStructureChange,
  coordToAddress,
  parseAddress,
  parseRange,
  shiftFormulaReferences,
} from './address';
import { evaluateWorkbook } from './formulaEngine';

export function uid(prefix = 'id'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createBlankSheet(name = 'Sheet1', rowCount = 60, colCount = 26): SheetData {
  return {
    id: uid('sheet'),
    name,
    rowCount,
    colCount,
    cells: {},
    colWidths: {},
    rowHeights: {},
    frozenRows: 0,
    frozenCols: 0,
    merges: [],
    charts: [],
  };
}

export function createBlankWorkbook(title = 'Untitled Workbook'): WorkbookData {
  const sheet = createBlankSheet('Sheet1');
  const now = Date.now();
  return {
    id: uid('wb'),
    title,
    sheets: [sheet],
    activeSheetId: sheet.id,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Rich multi-sheet starter workbook showcasing formulas, cross-sheet refs,
 * currency/percent formatting, frozen headers, and an embedded chart.
 */
export function createSampleWorkbook(): WorkbookData {
  const now = Date.now();
  const s1Id = uid('sheet');
  const s2Id = uid('sheet');

  const headerStyle: CellStyle = {
    bold: true,
    backgroundColor: '#0f172a',
    color: '#ffffff',
    align: 'center',
    fontSize: 12,
  };
  const subHeaderStyle: CellStyle = {
    bold: true,
    backgroundColor: '#e2e8f0',
    color: '#0f172a',
  };
  const totalStyle: CellStyle = {
    bold: true,
    backgroundColor: '#f0fdf4',
    color: '#14532d',
    numFmt: 'currency',
    decimals: 0,
    border: { top: true, bottom: true, color: '#16a34a' },
  };
  const currencyStyle: CellStyle = { numFmt: 'currency', decimals: 0, align: 'right' };
  const pctStyle: CellStyle = { numFmt: 'percent', decimals: 1, align: 'right', bold: true };

  const revenueCells: Record<string, CellData> = {
    A1: {
      raw: 'Forma SaaS — FY2026 Operating Model',
      style: { bold: true, fontSize: 15, color: '#0f172a' },
    },
    A2: {
      raw: 'Open-format workbook (.xlsx / .ods / .csv interoperable)',
      style: { italic: true, color: '#64748b', fontSize: 11 },
    },

    A4: { raw: 'Metric / Line Item', style: { ...headerStyle, align: 'left' } },
    B4: { raw: 'Q1 2026', style: headerStyle },
    C4: { raw: 'Q2 2026', style: headerStyle },
    D4: { raw: 'Q3 2026', style: headerStyle },
    E4: { raw: 'Q4 2026', style: headerStyle },
    F4: { raw: 'FY2026 Total', style: headerStyle },
    G4: { raw: 'QoQ Avg', style: headerStyle },

    A5: { raw: 'Enterprise Subscriptions', style: { bold: true } },
    B5: { raw: '185000', style: currencyStyle },
    C5: { raw: '=ROUND(B5*1.14, 0)', style: currencyStyle },
    D5: { raw: '=ROUND(C5*1.16, 0)', style: currencyStyle },
    E5: { raw: '=ROUND(D5*1.18, 0)', style: currencyStyle },
    F5: { raw: '=SUM(B5:E5)', style: { ...currencyStyle, bold: true } },
    G5: { raw: '=AVERAGE(B5:E5)', style: currencyStyle },

    A6: { raw: 'Self-Serve Pro Plans', style: { bold: true } },
    B6: { raw: '74000', style: currencyStyle },
    C6: { raw: '=ROUND(B6*1.12, 0)', style: currencyStyle },
    D6: { raw: '=ROUND(C6*1.15, 0)', style: currencyStyle },
    E6: { raw: '=ROUND(D6*1.15, 0)', style: currencyStyle },
    F6: { raw: '=SUM(B6:E6)', style: { ...currencyStyle, bold: true } },
    G6: { raw: '=AVERAGE(B6:E6)', style: currencyStyle },

    A7: { raw: 'Services & Training', style: { bold: true } },
    B7: { raw: '28000', style: currencyStyle },
    C7: { raw: '32000', style: currencyStyle },
    D7: { raw: '35000', style: currencyStyle },
    E7: { raw: '42000', style: currencyStyle },
    F7: { raw: '=SUM(B7:E7)', style: { ...currencyStyle, bold: true } },
    G7: { raw: '=AVERAGE(B7:E7)', style: currencyStyle },

    A8: { raw: 'Total Revenue', style: { ...totalStyle, align: 'left', numFmt: 'general' } },
    B8: { raw: '=SUM(B5:B7)', style: totalStyle },
    C8: { raw: '=SUM(C5:C7)', style: totalStyle },
    D8: { raw: '=SUM(D5:D7)', style: totalStyle },
    E8: { raw: '=SUM(E5:E7)', style: totalStyle },
    F8: { raw: '=SUM(B8:E8)', style: totalStyle },
    G8: { raw: '=AVERAGE(B8:E8)', style: totalStyle },

    A10: { raw: 'Operating Expenses', style: subHeaderStyle },
    B10: { raw: '', style: subHeaderStyle },
    C10: { raw: '', style: subHeaderStyle },
    D10: { raw: '', style: subHeaderStyle },
    E10: { raw: '', style: subHeaderStyle },
    F10: { raw: '', style: subHeaderStyle },
    G10: { raw: '', style: subHeaderStyle },

    A11: { raw: 'Cloud Infrastructure (COGS)' },
    B11: { raw: '=ROUND(B8*0.16, 0)', style: currencyStyle },
    C11: { raw: '=ROUND(C8*0.15, 0)', style: currencyStyle },
    D11: { raw: '=ROUND(D8*0.145, 0)', style: currencyStyle },
    E11: { raw: '=ROUND(E8*0.14, 0)', style: currencyStyle },
    F11: { raw: '=SUM(B11:E11)', style: { ...currencyStyle, bold: true } },
    G11: { raw: '=AVERAGE(B11:E11)', style: currencyStyle },

    A12: { raw: 'R&D / Engineering Payroll' },
    B12: { raw: '=Assumptions!B4', style: currencyStyle },
    C12: { raw: '=Assumptions!B4*1.05', style: currencyStyle },
    D12: { raw: '=Assumptions!B4*1.1', style: currencyStyle },
    E12: { raw: '=Assumptions!B4*1.15', style: currencyStyle },
    F12: { raw: '=SUM(B12:E12)', style: { ...currencyStyle, bold: true } },
    G12: { raw: '=AVERAGE(B12:E12)', style: currencyStyle },

    A13: { raw: 'Sales & Marketing' },
    B13: { raw: '52000', style: currencyStyle },
    C13: { raw: '58000', style: currencyStyle },
    D13: { raw: '64000', style: currencyStyle },
    E13: { raw: '72000', style: currencyStyle },
    F13: { raw: '=SUM(B13:E13)', style: { ...currencyStyle, bold: true } },
    G13: { raw: '=AVERAGE(B13:E13)', style: currencyStyle },

    A14: { raw: 'Total OpEx', style: { bold: true, backgroundColor: '#fef2f2', color: '#991b1b' } },
    B14: { raw: '=SUM(B11:B13)', style: { ...currencyStyle, bold: true, backgroundColor: '#fef2f2', color: '#991b1b' } },
    C14: { raw: '=SUM(C11:C13)', style: { ...currencyStyle, bold: true, backgroundColor: '#fef2f2', color: '#991b1b' } },
    D14: { raw: '=SUM(D11:D13)', style: { ...currencyStyle, bold: true, backgroundColor: '#fef2f2', color: '#991b1b' } },
    E14: { raw: '=SUM(E11:E13)', style: { ...currencyStyle, bold: true, backgroundColor: '#fef2f2', color: '#991b1b' } },
    F14: { raw: '=SUM(B14:E14)', style: { ...currencyStyle, bold: true, backgroundColor: '#fef2f2', color: '#991b1b' } },
    G14: { raw: '=AVERAGE(B14:E14)', style: { ...currencyStyle, bold: true, backgroundColor: '#fef2f2', color: '#991b1b' } },

    A16: { raw: 'Net Operating Income (EBITDA)', style: { bold: true, backgroundColor: '#eff6ff', color: '#1e3a8a' } },
    B16: { raw: '=B8-B14', style: { ...currencyStyle, bold: true, backgroundColor: '#eff6ff', color: '#1e3a8a' } },
    C16: { raw: '=C8-C14', style: { ...currencyStyle, bold: true, backgroundColor: '#eff6ff', color: '#1e3a8a' } },
    D16: { raw: '=D8-D14', style: { ...currencyStyle, bold: true, backgroundColor: '#eff6ff', color: '#1e3a8a' } },
    E16: { raw: '=E8-E14', style: { ...currencyStyle, bold: true, backgroundColor: '#eff6ff', color: '#1e3a8a' } },
    F16: { raw: '=SUM(B16:E16)', style: { ...currencyStyle, bold: true, backgroundColor: '#eff6ff', color: '#1e3a8a' } },
    G16: { raw: '=AVERAGE(B16:E16)', style: { ...currencyStyle, bold: true, backgroundColor: '#eff6ff', color: '#1e3a8a' } },

    A17: { raw: 'Operating Margin %', style: { bold: true } },
    B17: { raw: '=IFERROR(B16/B8, 0)', style: pctStyle },
    C17: { raw: '=IFERROR(C16/C8, 0)', style: pctStyle },
    D17: { raw: '=IFERROR(D16/D8, 0)', style: pctStyle },
    E17: { raw: '=IFERROR(E16/E8, 0)', style: pctStyle },
    F17: { raw: '=IFERROR(F16/F8, 0)', style: pctStyle },
    G17: { raw: '=IF(F17>=0.2, "Healthy", "Watch")', style: { align: 'center', bold: true, color: '#15803d', backgroundColor: '#dcfce7' } },
  };

  const assumptionsCells: Record<string, CellData> = {
    A1: { raw: 'Model Assumptions & Drivers', style: { bold: true, fontSize: 14 } },
    A3: { raw: 'Parameter', style: { ...headerStyle, align: 'left' } },
    B3: { raw: 'Value', style: headerStyle },
    C3: { raw: 'Notes', style: { ...headerStyle, align: 'left' } },
    A4: { raw: 'Baseline Quarterly R&D Payroll' },
    B4: { raw: '118000', style: currencyStyle },
    C4: { raw: 'Referenced dynamically by Forecast!B12:E12' },
    A5: { raw: 'Target Operating Margin' },
    B5: { raw: '0.20', style: pctStyle },
    C5: { raw: 'Rule-of-40 profitability floor' },
    A6: { raw: 'FY2026 Total Revenue (Linked)' },
    B6: { raw: '=Forecast!F8', style: { ...currencyStyle, bold: true } },
    C6: { raw: 'Live cross-sheet reference' },
    A7: { raw: 'FY2026 Net Operating Income (Linked)' },
    B7: { raw: '=Forecast!F16', style: { ...currencyStyle, bold: true } },
    C7: { raw: 'Live cross-sheet reference' },
  };

  const sheet1: SheetData = {
    id: s1Id,
    name: 'Forecast',
    rowCount: 60,
    colCount: 20,
    cells: revenueCells,
    colWidths: { 0: 245, 1: 118, 2: 118, 3: 118, 4: 118, 5: 132, 6: 118 },
    rowHeights: { 0: 32, 3: 30 },
    frozenRows: 4,
    frozenCols: 1,
    merges: [],
    charts: [
      {
        id: uid('chart'),
        title: 'Quarterly Revenue vs OpEx & EBITDA',
        type: 'bar',
        dataRange: 'A4:E8',
        sheetId: s1Id,
        x: 32,
        y: 485,
        width: 560,
        height: 270,
      },
    ],
  };

  const sheet2: SheetData = {
    id: s2Id,
    name: 'Assumptions',
    rowCount: 40,
    colCount: 14,
    cells: assumptionsCells,
    colWidths: { 0: 260, 1: 140, 2: 340 },
    rowHeights: { 0: 30 },
    frozenRows: 3,
    frozenCols: 0,
    merges: [],
    charts: [],
  };

  return {
    id: uid('wb'),
    title: 'FY2026 SaaS Operating Model',
    sheets: [sheet1, sheet2],
    activeSheetId: s1Id,
    createdAt: now,
    updatedAt: now,
  };
}

/** Update a single cell in a sheet immutably */
export function updateSheetCell(
  sheet: SheetData,
  address: string,
  updater: (prev: CellData | undefined) => CellData | undefined
): SheetData {
  const nextCells = { ...sheet.cells };
  const updated = updater(nextCells[address]);
  if (!updated || (updated.raw === '' && (!updated.style || Object.keys(updated.style).length === 0) && !updated.note)) {
    delete nextCells[address];
  } else {
    nextCells[address] = updated;
  }
  return { ...sheet, cells: nextCells };
}

/** Apply style partial to all cells in a normalized range */
export function applyStyleToRange(
  sheet: SheetData,
  range: NormalizedRange,
  stylePatch: Partial<CellStyle>
): SheetData {
  const nextCells = { ...sheet.cells };
  for (let r = range.startRow; r <= range.endRow; r++) {
    for (let c = range.startCol; c <= range.endCol; c++) {
      const addr = coordToAddress(r, c);
      const prev = nextCells[addr] ?? { raw: '' };
      nextCells[addr] = {
        ...prev,
        style: { ...(prev.style ?? {}), ...stylePatch },
      };
    }
  }
  return { ...sheet, cells: nextCells };
}

/** Clear raw values (keeping styles) in a range */
export function clearRangeValues(sheet: SheetData, range: NormalizedRange): SheetData {
  const nextCells = { ...sheet.cells };
  for (let r = range.startRow; r <= range.endRow; r++) {
    for (let c = range.startCol; c <= range.endCol; c++) {
      const addr = coordToAddress(r, c);
      const prev = nextCells[addr];
      if (!prev) continue;
      if (!prev.style || Object.keys(prev.style).length === 0) {
        delete nextCells[addr];
      } else {
        nextCells[addr] = { ...prev, raw: '' };
      }
    }
  }
  return { ...sheet, cells: nextCells };
}

/**
 * Fill target range from source range (Excel fill-handle drag).
 * Automatically shifts relative formula references and detects numeric linear series!
 */
export function fillRangeFromSource(
  sheet: SheetData,
  source: NormalizedRange,
  target: NormalizedRange
): SheetData {
  const nextCells = { ...sheet.cells };
  const srcRows = source.endRow - source.startRow + 1;
  const srcCols = source.endCol - source.startCol + 1;

  for (let r = target.startRow; r <= target.endRow; r++) {
    for (let c = target.startCol; c <= target.endCol; c++) {
      // Skip cells inside source
      if (
        r >= source.startRow &&
        r <= source.endRow &&
        c >= source.startCol &&
        c <= source.endCol
      ) {
        continue;
      }

      const relR = ((r - source.startRow) % srcRows + srcRows) % srcRows;
      const relC = ((c - source.startCol) % srcCols + srcCols) % srcCols;
      const srcR = source.startRow + relR;
      const srcC = source.startCol + relC;
      const srcAddr = coordToAddress(srcR, srcC);
      const dstAddr = coordToAddress(r, c);
      const srcCell = sheet.cells[srcAddr];
      if (!srcCell) continue;

      let newRaw = srcCell.raw;
      if (newRaw.startsWith('=')) {
        newRaw = shiftFormulaReferences(newRaw, r - srcR, c - srcC);
      } else if (srcRows >= 2 && c >= source.startCol && c <= source.endCol) {
        // Vertical numeric series detection
        const v0 = Number(sheet.cells[coordToAddress(source.startRow, c)]?.raw);
        const v1 = Number(sheet.cells[coordToAddress(source.startRow + 1, c)]?.raw);
        if (!isNaN(v0) && !isNaN(v1) && sheet.cells[coordToAddress(source.startRow, c)]?.raw !== '') {
          const step = v1 - v0;
          newRaw = String(v0 + step * (r - source.startRow));
        }
      } else if (srcCols >= 2 && r >= source.startRow && r <= source.endRow) {
        // Horizontal numeric series detection
        const v0 = Number(sheet.cells[coordToAddress(r, source.startCol)]?.raw);
        const v1 = Number(sheet.cells[coordToAddress(r, source.startCol + 1)]?.raw);
        if (!isNaN(v0) && !isNaN(v1) && sheet.cells[coordToAddress(r, source.startCol)]?.raw !== '') {
          const step = v1 - v0;
          newRaw = String(v0 + step * (c - source.startCol));
        }
      }

      nextCells[dstAddr] = {
        raw: newRaw,
        style: srcCell.style ? { ...srcCell.style } : undefined,
      };
    }
  }

  return { ...sheet, cells: nextCells };
}

function shiftXlsxRanges(
  metadata: XlsxSheetMetadata,
  axis: 'row' | 'col',
  index: number,
  delta: 1 | -1
): XlsxSheetMetadata {
  const shiftRange = (address: string): string | undefined => {
    const range = parseRange(address);
    if (!range || range.sheetName) return address;
    const start = { ...range.start };
    const end = { ...range.end };
    if (delta === -1 && start[axis] === index && end[axis] === index) return undefined;
    if (start[axis] > index || (delta === 1 && start[axis] === index)) start[axis] += delta;
    if (end[axis] >= index) end[axis] += delta;
    const first = coordToAddress(start.row, start.col);
    const last = coordToAddress(end.row, end.col);
    return first === last && !address.includes(':') ? first : `${first}:${last}`;
  };

  const validations: XlsxSheetMetadata['validations'] = {};
  for (const [address, rule] of Object.entries(metadata.validations)) {
    const next = shiftRange(address);
    if (!next) continue;
    const formulae = rule.formulae?.map((formula) => {
      if (typeof formula !== 'string' || rule.type === 'date') return formula;
      const hasEquals = formula.startsWith('=');
      const adjusted = adjustFormulaForStructureChange(hasEquals ? formula : `=${formula}`, axis, index, delta);
      return hasEquals ? adjusted : adjusted.slice(1);
    });
    validations[next] = { ...rule, formulae };
  }

  const tables = metadata.tables.flatMap((table) => {
    const tableRef = shiftRange(table.tableRef);
    if (!tableRef) return [];
    const range = parseRange(table.tableRef);
    if (!range) return [table];
    const columns = [...table.columns];
    if (axis === 'col' && index >= range.start.col && index <= range.end.col) {
      const position = index - range.start.col;
      if (delta === -1) {
        columns.splice(position, 1);
      } else if (position > 0) {
        const names = new Set(columns.map(({ name }) => name.toLowerCase()));
        let suffix = position + 1;
        while (names.has(`column${suffix}`)) suffix++;
        columns.splice(position, 0, { name: `Column${suffix}` });
      }
    }
    const deletesRow = axis === 'row' && delta === -1;
    const headerRow = table.headerRow && !(deletesRow && index === range.start.row);
    const totalsRow = table.totalsRow && !(deletesRow && index === range.end.row);
    const autoFilterRef = headerRow && table.autoFilterRef ? shiftRange(table.autoFilterRef) : undefined;
    return [{ ...table, tableRef, autoFilterRef, columns, headerRow, totalsRow }];
  });

  return { tables, validations };
}

/** Insert or delete a row or column and automatically adjust references in the sheet. */
export function mutateSheetStructure(
  sheet: SheetData,
  axis: 'row' | 'col',
  index: number,
  delta: 1 | -1
): SheetData {
  const nextCells: Record<string, CellData> = {};

  for (const [addr, cell] of Object.entries(sheet.cells)) {
    const parsed = parseAddress(addr);
    if (!parsed) continue;
    let { row, col } = parsed;

    if (axis === 'row') {
      if (delta === -1 && row === index) continue;
      if (row >= index) row += delta;
    } else {
      if (delta === -1 && col === index) continue;
      if (col >= index) col += delta;
    }

    if (row < 0 || col < 0) continue;
    const adjustedRaw = cell.raw.startsWith('=')
      ? adjustFormulaForStructureChange(cell.raw, axis, index, delta)
      : cell.raw;

    nextCells[coordToAddress(row, col)] = {
      ...cell,
      raw: adjustedRaw,
    };
  }

  const nextRowCount = axis === 'row' ? Math.max(10, sheet.rowCount + delta) : sheet.rowCount;
  const nextColCount = axis === 'col' ? Math.max(5, sheet.colCount + delta) : sheet.colCount;

  // Shift rowHeights or colWidths
  const nextRowHeights: Record<number, number> = {};
  for (const [rStr, h] of Object.entries(sheet.rowHeights)) {
    let r = Number(rStr);
    if (axis === 'row') {
      if (delta === -1 && r === index) continue;
      if (r >= index) r += delta;
    }
    if (r >= 0) nextRowHeights[r] = h;
  }

  const nextColWidths: Record<number, number> = {};
  for (const [cStr, w] of Object.entries(sheet.colWidths)) {
    let c = Number(cStr);
    if (axis === 'col') {
      if (delta === -1 && c === index) continue;
      if (c >= index) c += delta;
    }
    if (c >= 0) nextColWidths[c] = w;
  }

  // Shift merged ranges
  const nextMerges = sheet.merges
    .map((m) => {
      if (axis === 'row') {
        if (delta === 1) {
          return {
            ...m,
            startRow: m.startRow >= index ? m.startRow + 1 : m.startRow,
            endRow: m.endRow >= index ? m.endRow + 1 : m.endRow,
          };
        }
        if (m.startRow === index && m.endRow === index) return null;
        return {
          ...m,
          startRow: m.startRow > index ? m.startRow - 1 : m.startRow,
          endRow: m.endRow >= index ? Math.max(m.startRow, m.endRow - 1) : m.endRow,
        };
      }
      if (delta === 1) {
        return {
          ...m,
          startCol: m.startCol >= index ? m.startCol + 1 : m.startCol,
          endCol: m.endCol >= index ? m.endCol + 1 : m.endCol,
        };
      }
      if (m.startCol === index && m.endCol === index) return null;
      return {
        ...m,
        startCol: m.startCol > index ? m.startCol - 1 : m.startCol,
        endCol: m.endCol >= index ? Math.max(m.startCol, m.endCol - 1) : m.endCol,
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null && (m.endRow > m.startRow || m.endCol > m.startCol));

  // Shift chart dataRanges
  const nextCharts = sheet.charts.map((ch) => {
    const shifted = adjustFormulaForStructureChange(`=${ch.dataRange}`, axis, index, delta).slice(1);
    return shifted.includes('#REF!') ? ch : { ...ch, dataRange: shifted };
  });

  return {
    ...sheet,
    rowCount: nextRowCount,
    colCount: nextColCount,
    cells: nextCells,
    rowHeights: nextRowHeights,
    colWidths: nextColWidths,
    merges: nextMerges,
    charts: nextCharts,
    xlsxMetadata: sheet.xlsxMetadata && shiftXlsxRanges(sheet.xlsxMetadata, axis, index, delta),
  };
}

/** Sort rows inside a selection range by a given column */
export function sortRangeByColumn(
  workbook: WorkbookData,
  sheetId: string,
  range: NormalizedRange,
  sortCol: number,
  direction: 'asc' | 'desc'
): SheetData {
  const sheet = workbook.sheets.find((s) => s.id === sheetId)!;
  const computed = evaluateWorkbook(workbook)[sheetId] ?? {};

  const rows: Array<{
    origRow: number;
    sortVal: string | number | boolean | null;
    cells: Record<number, CellData | undefined>;
  }> = [];

  for (let r = range.startRow; r <= range.endRow; r++) {
    const rowCells: Record<number, CellData | undefined> = {};
    for (let c = range.startCol; c <= range.endCol; c++) {
      rowCells[c] = sheet.cells[coordToAddress(r, c)];
    }
    const sortVal = computed[coordToAddress(r, sortCol)]?.value ?? null;
    rows.push({ origRow: r, sortVal, cells: rowCells });
  }

  rows.sort((a, b) => {
    const av = a.sortVal;
    const bv = b.sortVal;
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    let cmp = 0;
    if (typeof av === 'number' && typeof bv === 'number') {
      cmp = av - bv;
    } else {
      cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
    }
    return direction === 'asc' ? cmp : -cmp;
  });

  const nextCells = { ...sheet.cells };
  rows.forEach((rowEntry, i) => {
    const targetRow = range.startRow + i;
    const dRow = targetRow - rowEntry.origRow;
    for (let c = range.startCol; c <= range.endCol; c++) {
      const addr = coordToAddress(targetRow, c);
      const cell = rowEntry.cells[c];
      if (!cell) {
        delete nextCells[addr];
      } else {
        nextCells[addr] = {
          ...cell,
          raw: cell.raw.startsWith('=') ? shiftFormulaReferences(cell.raw, dRow, 0) : cell.raw,
        };
      }
    }
  });

  return { ...sheet, cells: nextCells };
}

/** Serialize a selected range to TSV for system clipboard interoperability (Excel / Sheets / Docs) */
export function rangeToTSV(
  sheet: SheetData,
  computed: Record<string, { formatted: string }>,
  range: NormalizedRange,
  useFormatted = true
): string {
  const lines: string[] = [];
  for (let r = range.startRow; r <= range.endRow; r++) {
    const rowVals: string[] = [];
    for (let c = range.startCol; c <= range.endCol; c++) {
      const addr = coordToAddress(r, c);
      if (useFormatted) {
        rowVals.push(computed[addr]?.formatted ?? '');
      } else {
        rowVals.push(sheet.cells[addr]?.raw ?? '');
      }
    }
    lines.push(rowVals.join('\t'));
  }
  return lines.join('\n');
}

/** Convert a selected range into an HTML table (for direct paste into Forma Docs or Word!) */
export function rangeToHTMLTable(
  computed: Record<string, { formatted: string }>,
  range: NormalizedRange
): string {
  let html = '<table><tbody>';
  for (let r = range.startRow; r <= range.endRow; r++) {
    html += '<tr>';
    for (let c = range.startCol; c <= range.endCol; c++) {
      const addr = coordToAddress(r, c);
      const val = (computed[addr]?.formatted ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const tag = r === range.startRow ? 'th' : 'td';
      html += `<${tag}>${val}</${tag}>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}
