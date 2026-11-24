import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { createWorkbookFromTemplate } from '../engine/spreadsheet/templates';
import { exportWorkbookToXlsx, importWorkbookFromXlsx } from '../engine/spreadsheet/formats/xlsxCodec';
import { createPresentationFromTemplate } from '../engine/slides/slideTemplates';
import { exportPresentationToPptx, importPresentationFromPptx } from '../engine/slides/formats/pptxCodec';
import {
  exportNotebookToIpynb,
  exportNotebookToMarkdown,
  exportNotebookToPython,
  importNotebookFromIpynb,
} from '../engine/notebook/ipynbCodec';
import { exportWorkbookToOds, importWorkbookFromOds } from '../engine/spreadsheet/formats/odsCodec';
import { exportDocumentToDocx, importDocumentFromDocx } from '../engine/document/formats/docxCodec';
import { exportDocumentToOdt, importDocumentFromOdt } from '../engine/document/formats/odtCodec';
import { createBlankDocument } from '../engine/document/sampleDocs';
import { remapPageAnnotations } from '../engine/pdf/pdfEngine';
import { visibleIndices } from '../engine/spreadsheet/viewport';
import { createWorkbookEvaluator } from '../engine/spreadsheet/formulaEngine';
import {
  adjustFormulaForStructureChange,
  parseAddress,
  shiftFormulaReferences,
} from '../engine/spreadsheet/address';
import { createBlankWorkbook, mutateSheetStructure } from '../engine/spreadsheet/workbookOps';
import {
  exportDocumentToMarkdown,
  importDocumentFromMarkdown,
} from '../engine/document/formats/markdownCodec';
import { importWorkbookFromDelimited } from '../engine/spreadsheet/formats/csvCodec';
import {
  loadFilePosition,
  loadWorkspaceSession,
  saveFilePosition,
  saveWorkspaceSession,
} from '../storage/sessionStore';
import { PdfAnnotation } from '../types/pdf';

describe('Forma Office File Safety, Compatibility & Performance Regressions', () => {
  it('preserves charts on an Excel (.xlsx) round-trip of the built-in SaaS workbook', async () => {
    const saas = createWorkbookFromTemplate('saas');
    const origCharts = saas.sheets.flatMap((s) => s.charts);
    expect(origCharts.length).toBeGreaterThan(0);

    const bytes = await exportWorkbookToXlsx(saas);
    const reimported = await importWorkbookFromXlsx(bytes, 'SaaS.xlsx');
    const importedCharts = reimported.sheets.flatMap((s) => s.charts);

    expect(importedCharts.length).toBe(origCharts.length);
    expect(importedCharts[0].title).toBe(origCharts[0].title);
    expect(importedCharts[0].type).toBe(origCharts[0].type);
  });

  it('imports PowerPoint (.pptx) slides in declared presentation.xml order (3, 1, 2)', async () => {
    const deck = createPresentationFromTemplate('qbr');
    // Ensure 3 distinct identifiable slides
    deck.slides = deck.slides.slice(0, 3).map((s, i) => ({
      ...s,
      elements: [
        {
          id: `el_${i}`,
          kind: 'text',
          x: 60,
          y: 60,
          width: 400,
          height: 60,
          text: `SLIDE_MARKER_${i + 1}`,
          fontSize: 24,
        },
      ],
    }));

    const bytes = await exportPresentationToPptx(deck);
    const zip = await JSZip.loadAsync(bytes);

    // Reorder <p:sldId> entries in ppt/presentation.xml to 3, 1, 2
    const presXml = await zip.file('ppt/presentation.xml')!.async('string');
    const sldMatches = Array.from(presXml.matchAll(/<p:sldId\b[^>]*\/>/g)).map((m) => m[0]);
    expect(sldMatches.length).toBe(3);
    const reordered = presXml.replace(
      /<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/,
      `<p:sldIdLst>${sldMatches[2]}${sldMatches[0]}${sldMatches[1]}</p:sldIdLst>`
    );
    zip.file('ppt/presentation.xml', reordered);
    const reorderedBytes = await zip.generateAsync({ type: 'uint8array' });

    const imported = await importPresentationFromPptx(reorderedBytes, 'Reordered.pptx');
    const titles = imported.slides.map((s) => s.elements.map((e) => e.text ?? '').join(' '));
    expect(titles[0]).toContain('SLIDE_MARKER_3');
    expect(titles[1]).toContain('SLIDE_MARKER_1');
    expect(titles[2]).toContain('SLIDE_MARKER_2');
  });

  it('preserves Markdown attachments, cell tags, and application/json outputs across .ipynb round-trip', () => {
    const rawIpynb = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
        custom_nb_flag: 'keep-me',
      },
      cells: [
        {
          cell_type: 'markdown',
          id: 'md1',
          metadata: { tags: ['intro', 'lecture-1'] },
          attachments: {
            'diagram.png': { 'image/png': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' },
          },
          source: ['# Intro\n', '![diagram](attachment:diagram.png)'],
        },
        {
          cell_type: 'code',
          id: 'code1',
          execution_count: 1,
          metadata: { tags: ['parameters'] },
          source: ['{"a": 1}'],
          outputs: [
            {
              output_type: 'display_data',
              data: {
                'application/json': { score: 0.98, nested: [1, 2, 3] },
                'text/plain': '<JSON>',
              },
              metadata: { expanded: true },
            },
          ],
        },
      ],
    });

    const imported = importNotebookFromIpynb(rawIpynb, 'Rich.ipynb');
    const exportedJson = exportNotebookToIpynb(imported);
    const parsed = JSON.parse(exportedJson);

    expect(parsed.metadata.custom_nb_flag).toBe('keep-me');
    expect(parsed.cells[0].metadata.tags).toEqual(['intro', 'lecture-1']);
    expect(parsed.cells[0].attachments['diagram.png']['image/png']).toBe(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
    );
    expect(parsed.cells[1].metadata.tags).toEqual(['parameters']);
    expect(parsed.cells[1].outputs[0].data['application/json']).toEqual({
      score: 0.98,
      nested: [1, 2, 3],
    });
  });

  it('keeps PDF annotations attached to their source page through insert, duplicate, and move', () => {
    const anns: PdfAnnotation[] = [
      { id: 'a1', type: 'note', pageIndex: 1, x: 0.2, y: 0.3, text: 'Page 2 note', color: '#fde047' },
      { id: 'a2', type: 'note', pageIndex: 2, x: 0.4, y: 0.5, text: 'Page 3 note', color: '#fde047' },
    ];

    // Insert blank page after page 0 (before page 1): page 1 -> 2, page 2 -> 3
    const afterInsert = remapPageAnnotations(anns, { type: 'insert', index: 0 });
    expect(afterInsert.map((a) => a.pageIndex)).toEqual([2, 3]);

    // Duplicate page 2 (which now holds a1): copies a1 to page 3, shifts a2 (page 3) -> page 4
    const afterDup = remapPageAnnotations(afterInsert, { type: 'duplicate', index: 2 });
    expect(
      afterDup.filter((a) => a.type === 'note' && a.text === 'Page 2 note').map((a) => a.pageIndex)
    ).toEqual([2, 3]);
    expect(afterDup.find((a) => a.type === 'note' && a.text === 'Page 3 note')?.pageIndex).toBe(4);

    // Move page 4 -> page 1: shifts pages 1..3 down by 1
    const afterMove = remapPageAnnotations(afterDup, { type: 'move', from: 4, to: 1 });
    expect(afterMove.find((a) => a.type === 'note' && a.text === 'Page 3 note')?.pageIndex).toBe(1);
    expect(
      afterMove.filter((a) => a.type === 'note' && a.text === 'Page 2 note').map((a) => a.pageIndex)
    ).toEqual([3, 4]);
  });

  it('virtualizes 1,000-row sheets to visible viewport + frozen panes and recalculates incrementally', () => {
    // 1. Viewport virtualization bounds
    const rowOffsets = Array.from({ length: 1000 }, (_, i) => 26 + i * 26);
    const vis = visibleIndices(rowOffsets, 2600, 650, 2, 5);
    expect(vis.slice(0, 2)).toEqual([0, 1]); // frozen rows preserved
    expect(vis.length).toBeLessThan(60); // far fewer than 1,000 rows!

    // 2. Incremental recalculation on 1,000-row x 10-column CSV with formula per row
    const rows = ['Name,V1,V2,V3,V4,V5,V6,V7,V8,Total'];
    for (let r = 2; r <= 1001; r++) {
      rows.push(`Item${r},10,20,30,40,50,60,70,80,=SUM(B${r}:I${r})`);
    }
    const wb = importWorkbookFromDelimited(rows.join('\n'), 'large.csv', ',');
    const evaluate = createWorkbookEvaluator();
    const res1 = evaluate(wb);
    const sheetId = wb.sheets[0].id;
    expect(res1[sheetId]['J2']?.value).toBe(360);
    expect(res1[sheetId]['J1001']?.value).toBe(360);

    // Mutate one cell on row 500 and verify incremental recompute updates J500
    const updatedWb = {
      ...wb,
      sheets: wb.sheets.map((s) =>
        s.id === sheetId ? { ...s, cells: { ...s.cells, B500: { raw: '110' } } } : s
      ),
    };
    const res2 = evaluate(updatedWb);
    expect(res2[sheetId]['J500']?.value).toBe(460);
    expect(res2[sheetId]['J2']?.value).toBe(360);
  });

  it('persists and restores open tabs and per-file reading/cursor positions', () => {
    saveWorkspaceSession('suite', {
      openTabs: [
        { id: 'doc_1', kind: 'document' },
        { id: 'pdf_1', kind: 'pdf' },
      ],
      activeTabId: 'pdf_1',
      showingHub: false,
    });
    const session = loadWorkspaceSession('suite');
    expect(session?.openTabs.length).toBe(2);
    expect(session?.activeTabId).toBe('pdf_1');
    expect(session?.showingHub).toBe(false);

    saveFilePosition('pdf_1', { pdfPage: 42 });
    saveFilePosition('deck_1', { slideIndex: 5 });
    saveFilePosition('wb_1', { sheetId: 's1', cellRow: 12, cellCol: 3 });

    expect(loadFilePosition('pdf_1')?.pdfPage).toBe(42);
    expect(loadFilePosition('deck_1')?.slideIndex).toBe(5);
    expect(loadFilePosition('wb_1')).toEqual({ sheetId: 's1', cellRow: 12, cellCol: 3 });
  });

  it('imports OpenXML SDK / ChatGPT .xlsx workbooks with x: namespace prefixes, BOM rels, and native OOXML charts', async () => {
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      '\uFEFF<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml" /><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" /><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" /><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml" /></Types>'
    );
    zip.file(
      '_rels/.rels',
      '\uFEFF<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/xl/workbook.xml" Id="rId1" /></Relationships>'
    );
    zip.file(
      'xl/workbook.xml',
      '<?xml version="1.0" encoding="utf-8"?><x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheets><x:sheet name="Trip Summary" sheetId="1" r:id="R1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" /></x:sheets></x:workbook>'
    );
    zip.file(
      'xl/_rels/workbook.xml.rels',
      '\uFEFF<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet1.xml" Id="R1" /></Relationships>'
    );
    zip.file(
      'xl/worksheets/sheet1.xml',
      '<?xml version="1.0" encoding="utf-8"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1" t="str"><x:v>Pacific Coast Road Trip</x:v></x:c><x:c r="B1" /></x:row><x:row r="4"><x:c r="A4" t="str"><x:v>Category</x:v></x:c><x:c r="B4" t="str"><x:v>Booked / Base</x:v></x:c></x:row><x:row r="5"><x:c r="A5" t="str"><x:v>Flights</x:v></x:c><x:c r="B5"><x:v>750</x:v></x:c></x:row><x:row r="6"><x:c r="A6" t="str"><x:v>Rental SUV</x:v></x:c><x:c r="B6"><x:v>809</x:v></x:c></x:row><x:row r="7"><x:c r="A7" t="str"><x:v>Total</x:v></x:c><x:c r="B7"><x:f>SUM(B5:B6)</x:f><x:v>1559</x:v></x:c></x:row></x:sheetData><x:mergeCells count="1"><x:mergeCell ref="A1:B1" /></x:mergeCells><x:drawing r:id="Rdraw1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" /></x:worksheet>'
    );
    zip.file(
      'xl/worksheets/_rels/sheet1.xml.rels',
      '\uFEFF<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="/xl/drawings/drawing1.xml" Id="Rdraw1" /></Relationships>'
    );
    zip.file(
      'xl/drawings/drawing1.xml',
      '<?xml version="1.0" encoding="utf-8"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"><xdr:twoCellAnchor><xdr:from><xdr:col>4</xdr:col><xdr:row>2</xdr:row></xdr:from><xdr:to><xdr:col>10</xdr:col><xdr:row>14</xdr:row></xdr:to><xdr:graphicFrame><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="Rchart1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" /></a:graphicData></a:graphic></xdr:graphicFrame></xdr:twoCellAnchor></xdr:wsDr>'
    );
    zip.file(
      'xl/drawings/_rels/drawing1.xml.rels',
      '\uFEFF<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="/xl/drawings/charts/chart1.xml" Id="Rchart1" /></Relationships>'
    );
    zip.file(
      'xl/drawings/charts/chart1.xml',
      '<?xml version="1.0" encoding="utf-8"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:title><c:tx><c:rich><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>Estimated Cost by Category</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:ser><c:idx val="0" /><c:cat><c:strRef><c:f>\'Trip Summary\'!$A$5:$A$6</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>\'Trip Summary\'!$B$5:$B$6</c:f></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>'
    );

    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const wb = await importWorkbookFromXlsx(bytes, 'west_coast_trip_2026.xlsx');
    expect(wb.sheets.length).toBe(1);
    const sheet = wb.sheets[0];
    expect(sheet.name).toBe('Trip Summary');
    expect(sheet.cells['A1']?.raw).toBe('Pacific Coast Road Trip');
    // Slave cell of merge A1:B1 must not duplicate A1's raw text
    expect(sheet.cells['B1']?.raw ?? '').toBe('');
    expect(sheet.cells['B7']?.raw).toBe('=SUM(B5:B6)');
    expect(sheet.charts.length).toBe(1);
    expect(sheet.charts[0].title).toBe('Estimated Cost by Category');
    expect(sheet.charts[0].type).toBe('bar');
    expect(sheet.charts[0].dataRange).toBe('A4:B6');

    const evalFn = createWorkbookEvaluator();
    const computed = evalFn(wb);
    expect(computed[sheet.id]['B7']?.value).toBe(1559);
  });

  it('handles nested IFERROR parens, blank-cell comparisons/COUNTIF, quoted sheet names, GFM task lists, and PDF annotation rotation', () => {
    // 1. Nested IFERROR / IFNA parens + blank cell comparisons + COUNTIF
    const wb = createBlankWorkbook('Stress');
    const s = wb.sheets[0];
    s.cells['A1'] = { raw: '5' };
    s.cells['A2'] = { raw: '15' };
    // A3..A5 intentionally blank
    s.cells['B1'] = { raw: '=IFERROR((1/0), 42)' };
    s.cells['B2'] = { raw: '=IFERROR(ROUND(1/0, 2), 99)' };
    s.cells['B3'] = { raw: '=A3=""' };
    s.cells['B4'] = { raw: '=COUNTIF(A1:A5, "<10")' };
    s.cells['B5'] = { raw: '=COUNTIF(A1:A5, "")' };
    s.cells['B6'] = { raw: '=COUNTIF(A1:A5, "<>")' };
    s.cells['C1'] = { raw: '02138' }; // leading-zero ZIP preserved as string

    const evalFn = createWorkbookEvaluator();
    const comp = evalFn(wb)[s.id];
    expect(comp['B1']?.value).toBe(42);
    expect(comp['B2']?.value).toBe(99);
    expect(comp['B3']?.value).toBe(true);
    expect(comp['B4']?.value).toBe(1);
    expect(comp['B5']?.value).toBe(3);
    expect(comp['B6']?.value).toBe(2);
    expect(comp['C1']?.value).toBe('02138');

    // 2. Quoted sheet names with A1-like tokens & escaped apostrophes
    expect(parseAddress("'O''Reilly'!$B$4")?.sheetName).toBe("O'Reilly");
    expect(shiftFormulaReferences("='Q1 2026'!A1 + 'Sheet2'!$B1", 1, 1)).toBe(
      "='Q1 2026'!B2 + 'Sheet2'!$B2"
    );
    expect(adjustFormulaForStructureChange("='Q1 2026'!A5 + A5", 'row', 0, 1)).toBe(
      "='Q1 2026'!A5 + A6"
    );

    // 3. mutateSheetStructure shifts merges and rowHeights
    s.merges = [{ startRow: 2, startCol: 0, endRow: 2, endCol: 3 }];
    s.rowHeights = { 2: 40 };
    const shiftedSheet = mutateSheetStructure(s, 'row', 1, 1);
    expect(shiftedSheet.merges[0]).toEqual({ startRow: 3, startCol: 0, endRow: 3, endCol: 3 });
    expect(shiftedSheet.rowHeights[3]).toBe(40);

    // 4. GFM Task List round-trip through Markdown
    const mdDoc = importDocumentFromMarkdown(
      '# Tasks\n\n- [x] Ship Forma Office\n- [ ] Write docs\n',
      'tasks.md'
    );
    expect(mdDoc.html).toContain('data-type="taskList"');
    const roundTripMd = exportDocumentToMarkdown(mdDoc);
    expect(roundTripMd).toContain('- [x] Ship Forma Office');
    expect(roundTripMd).toContain('- [ ] Write docs');

    // 5. PDF annotation rotation without baking/destroying annotations
    const anns: PdfAnnotation[] = [
      {
        id: 'h1',
        type: 'highlight',
        pageIndex: 0,
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.1,
        color: '#fde047',
      },
    ];
    const rotated = remapPageAnnotations(anns, { type: 'rotate', index: 0, deltaDeg: 90 });
    expect(rotated.length).toBe(1);
    expect(rotated[0].type).toBe('highlight');
    if (rotated[0].type === 'highlight') {
      expect(rotated[0].x).toBeCloseTo(0.7, 5);
      expect(rotated[0].y).toBeCloseTo(0.1, 5);
      expect(rotated[0].width).toBeCloseTo(0.1, 5);
      expect(rotated[0].height).toBeCloseTo(0.3, 5);
    }
  });

  it('preserves images, nested lists, code blocks, and multi-paragraph table cells across DOCX/ODT/MD', async () => {
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII=';
    const richDoc = createBlankDocument('Rich Export');
    richDoc.html = [
      '<h1>Doc Title</h1>',
      `<p>Inline image: <img src="${tinyPng}" /></p>`,
      '<ol><li>First<ol><li>Sub-item</li></ol></li><li>Second</li></ol>',
      '<pre><code>line1\nline2</code></pre>',
      '<table><tbody><tr><td><p>Para A</p><p>Para B</p></td></tr></tbody></table>',
    ].join('');

    const docxBytes = await exportDocumentToDocx(richDoc);
    const docxZip = await JSZip.loadAsync(docxBytes);
    const mediaFiles = Object.keys(docxZip.files).filter((k) => k.startsWith('word/media/'));
    expect(mediaFiles.length).toBe(1);
    const docXml = await docxZip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('<w:numPr>');
    const fromDocx = await importDocumentFromDocx(docxBytes, 'Rich.docx');
    expect(fromDocx.html).toContain('Para A');
    expect(fromDocx.html).toContain('Para B');

    const odtBytes = await exportDocumentToOdt(richDoc);
    const odtZip = await JSZip.loadAsync(odtBytes);
    expect(Object.keys(odtZip.files).some((k) => k.startsWith('Pictures/'))).toBe(true);
    const fromOdt = await importDocumentFromOdt(odtBytes, 'Rich.odt');
    expect(fromOdt.html).toContain('data:image/png;base64,');
    // Multi-line CodeBlock must re-import as one <pre>, not one <pre> per line
    expect(fromOdt.html.match(/<pre>/g)?.length).toBe(1);
    expect(fromOdt.html).toContain('line1\nline2');
    expect(fromOdt.html).toContain('Sub-item');

    const mdDoc = createBlankDocument('Nested Lists');
    mdDoc.html = '<ul><li>Parent<ul><li>Child</li></ul></li></ul>';
    const mdOut = exportDocumentToMarkdown(mdDoc);
    expect(mdOut).toContain('- Parent\n  - Child');
  });

  it('imports PPTX group transforms, tables, theme colors, outlined shapes, ODS styles/merges, 1-col XLSX charts, and ipynb array outputs/raw cells', async () => {
    // 1. PPTX group + table + schemeClr + outlined shape
    const pptZip = new JSZip();
    pptZip.file(
      'ppt/theme/theme1.xml',
      '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="Custom"><a:dk1><a:srgbClr val="112233"/></a:dk1><a:lt1><a:srgbClr val="FAFAFA"/></a:lt1><a:accent1><a:srgbClr val="2563EB"/></a:accent1></a:clrScheme></a:themeElements></a:theme>'
    );
    pptZip.file(
      'ppt/presentation.xml',
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldSz cx="9144000" cy="5143500"/><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>'
    );
    pptZip.file(
      'ppt/_rels/presentation.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>'
    );
    pptZip.file(
      'ppt/slides/slide1.xml',
      `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld>
          <p:bg><p:bgPr><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:bgPr></p:bg>
          <p:spTree>
            <p:grpSp>
              <p:grpSpPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="1828800" cy="914400"/><a:chOff x="0" y="0"/><a:chExt cx="1828800" cy="914400"/></a:xfrm></p:grpSpPr>
              <p:sp>
                <p:spPr><a:xfrm><a:off x="457200" y="0"/><a:ext cx="914400" cy="457200"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr>
                <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:rPr><a:t>Grouped Box</a:t></a:r></a:p></p:txBody>
              </p:sp>
            </p:grpSp>
            <p:sp>
              <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="0"/></a:xfrm><a:prstGeom prst="line"/><a:ln><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln></p:spPr>
            </p:sp>
            <p:graphicFrame>
              <p:xfrm><a:off x="914400" y="2000000"/><a:ext cx="3657600" cy="914400"/></p:xfrm>
              <a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Col A</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Col B</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic>
            </p:graphicFrame>
          </p:spTree>
        </p:cSld>
      </p:sld>`
    );
    const importedDeck = await importPresentationFromPptx(await pptZip.generateAsync({ type: 'uint8array' }), 'Grouped.pptx');
    expect(importedDeck.slides[0].backgroundColor).toBe('#2563eb');
    const grouped = importedDeck.slides[0].elements.find((e) => e.text === 'Grouped Box');
    expect(grouped).toBeTruthy();
    expect(grouped!.x).toBe(Math.round(((914400 + 457200) / 9144000) * 960));
    expect(grouped!.color).toBe('#fafafa');
    expect(importedDeck.slides[0].elements.some((e) => e.kind === 'shape' && e.shape === 'line')).toBe(true);
    expect(importedDeck.slides[0].elements.some((e) => (e.text ?? '').includes('Col A  |  Col B'))).toBe(true);

    // 2. ODS styles, colWidths, rowHeights, merges, frozenRows + 1-col XLSX chart
    const odsWb = createBlankWorkbook('StyledODS');
    odsWb.sheets[0].cells['A1'] = {
      raw: 'Header',
      style: { bold: true, italic: true, color: '#ffffff', backgroundColor: '#1e293b', align: 'center' },
    };
    odsWb.sheets[0].cells['A2'] = { raw: '10' };
    odsWb.sheets[0].cells['A3'] = { raw: '20' };
    odsWb.sheets[0].colWidths = { 0: 180 };
    odsWb.sheets[0].rowHeights = { 0: 44 };
    odsWb.sheets[0].frozenRows = 1;
    odsWb.sheets[0].frozenCols = 1;
    odsWb.sheets[0].merges = [{ startRow: 0, startCol: 0, endRow: 0, endCol: 1 }];
    odsWb.sheets[0].charts = [
      { id: 'c1col', title: '1-Col Series', type: 'bar', dataRange: 'A1:A3', sheetId: odsWb.sheets[0].id, x: 20, y: 20, width: 300, height: 200 },
    ];
    const odsRound = await importWorkbookFromOds(await exportWorkbookToOds(odsWb), 'Styled.ods');
    expect(odsRound.sheets[0].cells['A1']?.style?.bold).toBe(true);
    expect(odsRound.sheets[0].cells['A1']?.style?.backgroundColor).toBe('#1e293b');
    expect(odsRound.sheets[0].colWidths[0]).toBeGreaterThanOrEqual(170);
    expect(odsRound.sheets[0].rowHeights[0]).toBeGreaterThanOrEqual(40);
    expect(odsRound.sheets[0].frozenRows).toBe(1);
    expect(odsRound.sheets[0].merges[0]).toEqual({ startRow: 0, startCol: 0, endRow: 0, endCol: 1 });

    const xlsxOneColBytes = await exportWorkbookToXlsx(odsWb);
    const xlsxZip = await JSZip.loadAsync(xlsxOneColBytes);
    const chartXmlStr = await xlsxZip.file('xl/charts/chart1.xml')!.async('string');
    expect(chartXmlStr).toContain('$A$2:$A$3');

    // 3. ipynb multiline array output + raw cells export + v3 multi-worksheet
    const v3Json = JSON.stringify({
      nbformat: 3,
      worksheets: [
        { cells: [{ cell_type: 'code', input: ['x = 1'], outputs: [] }] },
        { cells: [{ cell_type: 'raw', source: ['RAW_BLOCK'] }] },
      ],
    });
    const importedV3 = importNotebookFromIpynb(v3Json, 'V3.ipynb');
    importedV3.cells[0].outputs = [
      { output_type: 'execute_result', execution_count: 1, data: { 'text/plain': 'lineA\nlineB', 'text/html': '<p>a</p>\n<p>b</p>' } },
    ];
    const exportedV4 = JSON.parse(exportNotebookToIpynb(importedV3));
    expect(Array.isArray(exportedV4.cells[0].outputs[0].data['text/plain'])).toBe(true);
    expect(exportedV4.cells[0].outputs[0].data['text/html']).toEqual(['<p>a</p>\n', '<p>b</p>']);
    expect(exportNotebookToPython(importedV3)).toContain('# %% [raw]\n# RAW_BLOCK');
    expect(exportNotebookToMarkdown(importedV3)).toContain('RAW_BLOCK');
  });
});
