import { describe, expect, it } from 'vitest';
import { evaluateWorkbook } from '../engine/spreadsheet/formulaEngine';
import {
  colToLetter,
  letterToCol,
  shiftFormulaReferences,
  adjustFormulaForStructureChange,
} from '../engine/spreadsheet/address';
import {
  createBlankSheet,
  createSampleWorkbook,
  fillRangeFromSource,
  mutateSheetStructure,
} from '../engine/spreadsheet/workbookOps';
import { WorkbookData } from '../types/spreadsheet';

function makeWb(cells: Record<string, string>, extraSheetCells?: Record<string, string>): WorkbookData {
  const s1 = createBlankSheet('Sheet1');
  for (const [addr, raw] of Object.entries(cells)) {
    s1.cells[addr] = { raw };
  }
  const sheets = [s1];
  if (extraSheetCells) {
    const s2 = createBlankSheet('Data');
    for (const [addr, raw] of Object.entries(extraSheetCells)) {
      s2.cells[addr] = { raw };
    }
    sheets.push(s2);
  }
  return {
    id: 'wb_test',
    title: 'Test',
    sheets,
    activeSheetId: s1.id,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('Address & Formula Reference Shifting', () => {
  it('converts column indices and letters accurately', () => {
    expect(colToLetter(0)).toBe('A');
    expect(colToLetter(25)).toBe('Z');
    expect(colToLetter(26)).toBe('AA');
    expect(letterToCol('AA')).toBe(26);
    expect(letterToCol('AZ')).toBe(51);
  });

  it('shifts relative references while preserving absolute $ anchors', () => {
    expect(shiftFormulaReferences('=SUM(A1:$B$2, $C1, D$4)', 2, 1)).toBe(
      '=SUM(B3:$B$2, $C3, E$4)'
    );
  });

  it('adjusts references on row/col insert and delete', () => {
    expect(adjustFormulaForStructureChange('=SUM(A2:A5)', 'row', 1, 1)).toBe('=SUM(A3:A6)');
    expect(adjustFormulaForStructureChange('=A2+B3', 'row', 1, -1)).toBe('=#REF!+B2');
  });
});

describe('Formula Engine Evaluation', () => {
  it('handles arithmetic, precedence, percentages, and string concatenation', () => {
    const wb = makeWb({
      A1: '=2+3*4',
      A2: '=(2+3)*4',
      A3: '=2^3^1',
      A4: '=50%+0.25',
      A5: '="Forma " & "Sheets"',
      A6: '=10/0',
    });
    const res = evaluateWorkbook(wb)[wb.sheets[0].id];
    expect(res.A1.value).toBe(14);
    expect(res.A2.value).toBe(20);
    expect(res.A3.value).toBe(8);
    expect(res.A4.value).toBeCloseTo(0.75);
    expect(res.A5.value).toBe('Forma Sheets');
    expect(res.A6.error).toBe('#DIV/0!');
  });

  it('evaluates aggregation, conditional, lookup, financial, and cross-sheet functions', () => {
    const wb = makeWb(
      {
        A1: 'Apple',
        B1: '10',
        A2: 'Banana',
        B2: '25',
        A3: 'Cherry',
        B3: '40',
        C1: '=SUM(B1:B3)',
        C2: '=AVERAGE(B1:B3)',
        C3: '=SUMIF(B1:B3, ">15")',
        C4: '=COUNTIF(A1:A3, "B*")',
        C5: '=VLOOKUP("Banana", A1:B3, 2, FALSE)',
        C6: '=XLOOKUP("Cherry", A1:A3, B1:B3, "None")',
        C7: '=IFERROR(10/0, 999)',
        C8: '=IF(C1>50, "High", "Low")',
        C9: '=Data!A1*2',
        C10: '=ROUND(PMT(0.05/12, 360, 200000), 2)',
      },
      { A1: '150' }
    );
    const res = evaluateWorkbook(wb)[wb.sheets[0].id];
    expect(res.C1.value).toBe(75);
    expect(res.C2.value).toBe(25);
    expect(res.C3.value).toBe(65);
    expect(res.C4.value).toBe(1);
    expect(res.C5.value).toBe(25);
    expect(res.C6.value).toBe(40);
    expect(res.C7.value).toBe(999);
    expect(res.C8.value).toBe('High');
    expect(res.C9.value).toBe(300);
    expect(res.C10.value).toBeCloseTo(-1073.64, 2);
  });

  it('detects circular dependencies cleanly without infinite recursion', () => {
    const wb = makeWb({
      A1: '=B1+1',
      B1: '=A1+1',
    });
    const res = evaluateWorkbook(wb)[wb.sheets[0].id];
    expect(res.A1.error).toBe('#CYCLE!');
    expect(res.B1.error).toBe('#CYCLE!');
  });

  it('evaluates the multi-sheet sample SaaS Operating Model without errors', () => {
    const wb = createSampleWorkbook();
    const res = evaluateWorkbook(wb);
    const forecast = res[wb.sheets[0].id];
    const assumptions = res[wb.sheets[1].id];

    expect(forecast.F8.error).toBeUndefined();
    expect(typeof forecast.F8.value).toBe('number');
    expect(forecast.F8.value as number).toBeGreaterThan(1000000);
    // Cross-sheet link Assumptions!B6 === Forecast!F8
    expect(assumptions.B6.value).toBe(forecast.F8.value);
    expect(assumptions.B7.value).toBe(forecast.F16.value);
  });

  it('supports fill handle series & formula shifting and structural insert/delete', () => {
    let sheet = createBlankSheet('Sheet1');
    sheet.cells['A1'] = { raw: '10' };
    sheet.cells['A2'] = { raw: '20' };
    sheet.cells['B1'] = { raw: '=A1*2' };

    sheet = fillRangeFromSource(
      sheet,
      { startRow: 0, startCol: 0, endRow: 1, endCol: 0 },
      { startRow: 0, startCol: 0, endRow: 3, endCol: 0 }
    );
    expect(sheet.cells['A3'].raw).toBe('30');
    expect(sheet.cells['A4'].raw).toBe('40');

    sheet = fillRangeFromSource(
      sheet,
      { startRow: 0, startCol: 1, endRow: 0, endCol: 1 },
      { startRow: 0, startCol: 1, endRow: 2, endCol: 1 }
    );
    expect(sheet.cells['B2'].raw).toBe('=A2*2');
    expect(sheet.cells['B3'].raw).toBe('=A3*2');

    sheet = mutateSheetStructure(sheet, 'row', 0, 1);
    expect(sheet.cells['A2'].raw).toBe('10');
    expect(sheet.cells['B2'].raw).toBe('=A2*2');
  });
});
