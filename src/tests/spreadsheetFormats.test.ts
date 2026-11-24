import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { createSampleWorkbook, mutateSheetStructure } from '../engine/spreadsheet/workbookOps';
import { evaluateWorkbook } from '../engine/spreadsheet/formulaEngine';
import {
  exportWorkbookToXlsx,
  importWorkbookFromXlsx,
} from '../engine/spreadsheet/formats/xlsxCodec';
import {
  excelFormulaToOpenFormula,
  exportWorkbookToOds,
  importWorkbookFromOds,
  openFormulaToExcelFormula,
} from '../engine/spreadsheet/formats/odsCodec';
import {
  exportSheetToDelimited,
  importWorkbookFromDelimited,
} from '../engine/spreadsheet/formats/csvCodec';

describe('Spreadsheet Open Formats Interoperability (.xlsx, .ods, .csv)', () => {
  it('preserves table definitions, validation, and notes after editing and inserting rows in an XLSX', async () => {
    const original = new ExcelJS.Workbook();
    const source = original.addWorksheet('Items');
    source.addTable({
      name: 'ItemsTable', ref: 'A1', headerRow: true, style: { showRowStripes: true },
      columns: [{ name: 'Amount' }, { name: 'Status' }], rows: [[10, 'Open'], [20, 'Closed']],
    });
    source.getCell('A2').note = 'Entered by reviewer';
    source.getCell('E2').note = 'Blank cell note';
    source.getCell('B2').dataValidation = { type: 'list', formulae: ['"Open,Closed"'], allowBlank: true };
    const imported = await importWorkbookFromXlsx(new Uint8Array(await original.xlsx.writeBuffer()));
    const shifted = mutateSheetStructure(imported.sheets[0], 'row', 0, 1);
    shifted.cells.A3 = { ...shifted.cells.A3, raw: '42' };
    const exported = await exportWorkbookToXlsx({ ...imported, sheets: [shifted] });
    const roundTrip = new ExcelJS.Workbook();
    await roundTrip.xlsx.load(exported.slice().buffer);
    const result = roundTrip.getWorksheet('Items')!;
    expect(result.getCell('A3').value).toBe(42);
    expect(result.getCell('A3').note).toBe('Entered by reviewer');
    expect(result.getCell('E3').value).toBeNull();
    const reopened = await importWorkbookFromXlsx(exported);
    expect(reopened.sheets[0].cells.E3).toMatchObject({ raw: '', note: 'Blank cell note' });
    expect(result.getCell('B3').dataValidation).toMatchObject({ type: 'list', formulae: ['"Open,Closed"'], allowBlank: true });
    expect(result.getTable('ItemsTable')).toBeTruthy();
    const zip = await JSZip.loadAsync(exported);
    const definition = await zip.file('xl/tables/table1.xml')?.async('string');
    expect(definition).toContain('ref="A2:B4"');
    expect(definition).toContain('showRowStripes="1"');
  });

  it('round-trips OOXML (.xlsx) preserving multi-sheet formulas, values, and styles', async () => {
    const orig = createSampleWorkbook();
    const origEval = evaluateWorkbook(orig);

    const bytes = await exportWorkbookToXlsx(orig);
    expect(bytes.byteLength).toBeGreaterThan(1000);

    const imported = await importWorkbookFromXlsx(bytes, 'RoundTrip.xlsx');
    expect(imported.sheets.length).toBe(2);
    expect(imported.sheets[0].name).toBe('Forecast');
    expect(imported.sheets[1].name).toBe('Assumptions');

    // Formulas preserved
    expect(imported.sheets[0].cells['F8'].raw).toBe('=SUM(B8:E8)');
    expect(imported.sheets[1].cells['B6'].raw).toBe('=Forecast!F8');
    // Styling preserved
    expect(imported.sheets[0].cells['A4'].style?.bold).toBe(true);
    expect(imported.sheets[0].cells['B5'].style?.numFmt).toBe('currency');

    // Re-evaluated values match original
    const importedEval = evaluateWorkbook(imported);
    expect(importedEval[imported.sheets[0].id].F8.value).toBe(
      origEval[orig.sheets[0].id].F8.value
    );
    expect(importedEval[imported.sheets[1].id].B6.value).toBe(
      origEval[orig.sheets[1].id].B6.value
    );
  });

  it('converts Excel formulas <-> ODF OpenFormula and round-trips ISO/IEC 26300 (.ods)', async () => {
    expect(excelFormulaToOpenFormula('=SUM(B5:E5)')).toBe('of:=SUM([.B5:.E5])');
    expect(openFormulaToExcelFormula('of:=SUM([.B5:.E5])')).toBe('=SUM(B5:E5)');
    expect(excelFormulaToOpenFormula('=Assumptions!B4*1.05')).toBe('of:=[Assumptions.B4]*1.05');
    expect(openFormulaToExcelFormula('of:=[Assumptions.B4]*1.05')).toBe('=Assumptions!B4*1.05');

    const orig = createSampleWorkbook();
    const origEval = evaluateWorkbook(orig);
    const bytes = await exportWorkbookToOds(orig);

    // Verify compliant ODF ZIP structure
    const zip = await JSZip.loadAsync(bytes);
    expect(await zip.file('mimetype')?.async('string')).toBe(
      'application/vnd.oasis.opendocument.spreadsheet'
    );
    expect(zip.file('META-INF/manifest.xml')).toBeTruthy();
    expect(zip.file('content.xml')).toBeTruthy();

    // Import back & evaluate
    const imported = await importWorkbookFromOds(bytes, 'RoundTrip.ods');
    expect(imported.sheets.length).toBe(2);
    expect(imported.sheets[0].cells['F8'].raw).toBe('=SUM(B8:E8)');
    expect(imported.sheets[1].cells['B6'].raw).toBe('=Forecast!F8');

    const importedEval = evaluateWorkbook(imported);
    expect(importedEval[imported.sheets[0].id].F8.value).toBe(
      origEval[orig.sheets[0].id].F8.value
    );
  });

  it('round-trips RFC 4180 CSV with commas and quotes', () => {
    const csvInput = 'Item,Note,Price\r\n"Widget, Pro","Says ""Hello""",49.99\r\nBasic,Simple,19.5';
    const wb = importWorkbookFromDelimited(csvInput, 'prices.csv', ',');
    expect(wb.sheets[0].cells['A2'].raw).toBe('Widget, Pro');
    expect(wb.sheets[0].cells['B2'].raw).toBe('Says "Hello"');
    expect(wb.sheets[0].cells['C2'].raw).toBe('49.99');

    const exported = exportSheetToDelimited(wb, wb.sheets[0].id, ',');
    expect(exported).toContain('"Widget, Pro"');
    expect(exported).toContain('"Says ""Hello"""');
  });
});
