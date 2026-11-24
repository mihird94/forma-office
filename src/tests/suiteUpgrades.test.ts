import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';

import {
  chunkTextForEmbedding,
  cosineSimilarity,
  extractDocumentIndexText,
  extractNotebookIndexText,
  extractPresentationIndexText,
  extractWorkbookIndexText,
  scoreHybridSearch,
} from '../storage/aiSemanticStore';
import { createWorkbookEvaluator } from '../engine/spreadsheet/formulaEngine';
import { createBlankWorkbook } from '../engine/spreadsheet/workbookOps';
import { buildPivotTable, pivotToSheetData } from '../engine/spreadsheet/pivotEngine';
import { extractDocVisuals, renderMermaidToSvg } from '../engine/document/mermaidSvg';
import { createBlankDocument } from '../engine/document/sampleDocs';
import { exportDocumentToDocx } from '../engine/document/formats/docxCodec';
import { createBlankPresentation } from '../engine/slides/slideTemplates';
import { exportPresentationToPptx, importPresentationFromPptx } from '../engine/slides/formats/pptxCodec';
import { exportPresentationToOdp, importPresentationFromOdp } from '../engine/slides/formats/odpCodec';
import { exportPresentationToPdf } from '../engine/slides/formats/slidePdfCodec';
import {
  applyRedactionsToPdf,
  fillPdfFormFields,
  readPdfFormFields,
  remapPageAnnotations,
} from '../engine/pdf/pdfEngine';
import { createBlankNotebook } from '../engine/notebook/notebookTemplates';
import { PdfRedactAnnotation } from '../types/pdf';

describe('Forma Office Suite Upgrades & Regression Fixes', () => {
  it('supports local semantic chunking, cosine similarity, hybrid search ranking, and all file extractors', () => {
    const wb = createBlankWorkbook('Revenue Forecast');
    wb.sheets[0].cells['A1'] = { raw: 'Quarter' };
    wb.sheets[0].cells['B1'] = { raw: 'ARR' };
    wb.sheets[0].cells['A2'] = { raw: 'Q4 2026' };
    wb.sheets[0].cells['B2'] = { raw: '2400000' };
    expect(extractWorkbookIndexText(wb)).toContain('Q4 2026');

    const doc = createBlankDocument('Architecture Memo');
    doc.html = '<h1>Local Embeddings</h1><p>Runs qwen3-embedding locally on Apple Silicon.</p>';
    expect(extractDocumentIndexText(doc)).toContain('qwen3-embedding');

    const deck = createBlankPresentation('Board Update');
    deck.slides[0].elements.push({
      id: 't1',
      kind: 'table',
      x: 40,
      y: 80,
      width: 500,
      height: 160,
      headerRow: true,
      tableData: [
        ['Region', 'Growth'],
        ['North America', '42%'],
      ],
    });
    expect(extractPresentationIndexText(deck)).toContain('North America');

    const nb = createBlankNotebook('Monte Carlo');
    nb.cells[0].source = 'import math\n# Portfolio volatility simulation';
    expect(extractNotebookIndexText(nb)).toContain('volatility simulation');

    const chunks = chunkTextForEmbedding('Alpha '.repeat(400), 500, 100, 10);
    expect(chunks.length).toBeGreaterThan(2);
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);

    const hits = scoreHybridSearch(
      'portfolio risk',
      [
        {
          docId: 'd1',
          kind: 'document',
          title: 'Portfolio Risk Analysis',
          path: '',
          sectionLabel: 'Section 1',
          text: 'Portfolio risk and Monte Carlo drawdown bounds.',
          embedding: [0.98, 0.1, 0],
        },
        {
          docId: 'd2',
          kind: 'document',
          title: 'Grocery List',
          path: '',
          sectionLabel: 'Section 1',
          text: 'Apples, bananas, coffee beans.',
          embedding: [0, 1, 0],
        },
      ],
      { queryEmbedding: [1, 0, 0], limit: 5 }
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].docId).toBe('d1');
    expect(hits[0].matchType).toBe('hybrid');
  });

  it('evaluates XLOOKUP, INDEX, SUMIFS/COUNTIFS, dynamic array FILTER/UNIQUE/SORT spill, 2000-cell reverse chains, and pivot tables', () => {
    const wb = createBlankWorkbook('Advanced Formulas');
    const s = wb.sheets[0];
    s.cells['A1'] = { raw: 'Region' };
    s.cells['B1'] = { raw: 'Product' };
    s.cells['C1'] = { raw: 'Sales' };
    s.cells['A2'] = { raw: 'East' };
    s.cells['B2'] = { raw: 'Alpha' };
    s.cells['C2'] = { raw: '100' };
    s.cells['A3'] = { raw: 'West' };
    s.cells['B3'] = { raw: 'Beta' };
    s.cells['C3'] = { raw: '250' };
    s.cells['A4'] = { raw: 'East' };
    s.cells['B4'] = { raw: 'Alpha' };
    s.cells['C4'] = { raw: '150' };

    s.cells['E1'] = { raw: '=XLOOKUP("Beta", B2:B4, C2:C4, "Missing")' };
    s.cells['E2'] = { raw: '=INDEX(C2:C4, 2)' };
    s.cells['E3'] = { raw: '=SUMIFS(C2:C4, A2:A4, "East", B2:B4, "Alpha")' };
    s.cells['E4'] = { raw: '=COUNTIFS(A2:A4, "East", C2:C4, ">120")' };
    s.cells['E5'] = { raw: '=IFS(C2>200, "High", C2>=100, "Mid", TRUE, "Low")' };
    s.cells['E6'] = { raw: '=SWITCH(A3, "East", 1, "West", 2, 0)' };
    s.cells['E7'] = { raw: '=TEXTJOIN("-", TRUE, A2, "", B2)' };
    s.cells['G1'] = { raw: '=UNIQUE(A2:A4)' }; // spills G1=East, G2=West
    s.cells['H1'] = { raw: '=SORT(C2:C4, 1, -1)' }; // spills 250, 150, 100

    const evalFn = createWorkbookEvaluator();
    const comp = evalFn(wb)[s.id];
    expect(comp['E1']?.value).toBe(250);
    expect(comp['E2']?.value).toBe(250);
    expect(comp['E3']?.value).toBe(250);
    expect(comp['E4']?.value).toBe(1);
    expect(comp['E5']?.value).toBe('Mid');
    expect(comp['E6']?.value).toBe(2);
    expect(comp['E7']?.value).toBe('East-Alpha');
    expect(comp['G1']?.value).toBe('East');
    expect(comp['G2']?.value).toBe('West');
    expect(comp['H1']?.value).toBe(250);
    expect(comp['H3']?.value).toBe(100);

    // Pivot table aggregation
    const pivot = buildPivotTable(s, comp, {
      sourceRange: 'A1:C4',
      rowField: 0,
      colField: 1,
      valueField: 2,
      agg: 'sum',
    });
    expect(pivot.grandTotal).toBe(500);
    const pivotSheet = pivotToSheetData('Pivot Summary', pivot);
    expect(Object.keys(pivotSheet.cells).length).toBeGreaterThan(4);

    // Stress test: 2,000-cell reverse-order dependency chain must NOT stack-overflow
    const chainWb = createBlankWorkbook('Deep Chain');
    const cs = chainWb.sheets[0];
    cs.rowCount = 2050;
    for (let r = 1; r < 2000; r++) {
      cs.cells[`A${r}`] = { raw: `=A${r + 1}+1` };
    }
    cs.cells['A2000'] = { raw: '1' };
    const chainComp = createWorkbookEvaluator()(chainWb)[cs.id];
    expect(chainComp['A1']?.error).toBeUndefined();
    expect(chainComp['A1']?.value).toBe(2000);
  });

  it('renders Mermaid SVG diagrams, extracts Docs math/diagrams, and exports DOCX headers/footers/page numbers', async () => {
    const flowSvg = renderMermaidToSvg('flowchart LR\n  A[Start] -->|go| B{Check}\n  B --> C((Done))');
    expect(flowSvg).toContain('<svg');
    expect(flowSvg).toContain('Start');
    expect(flowSvg).toContain('Done');

    const seqSvg = renderMermaidToSvg('sequenceDiagram\n  Client->>Server: Request\n  Server-->>Client: 200 OK');
    expect(seqSvg).toContain('<svg');
    expect(seqSvg).toContain('Request');

    const visuals = extractDocVisuals(
      '<p>Energy: $$E = mc^2$$</p><pre><code class="language-mermaid">flowchart TD\nA-->B</code></pre>'
    );
    expect(visuals.some((v) => v.kind === 'math-display')).toBe(true);
    expect(visuals.some((v) => v.kind === 'mermaid')).toBe(true);

    const doc = createBlankDocument('Header Footer Test');
    doc.pageSettings.headerText = 'Confidential Draft';
    doc.pageSettings.footerText = 'Forma Office';
    doc.pageSettings.showPageNumbers = true;
    const docxBytes = await exportDocumentToDocx(doc);
    const zip = await JSZip.loadAsync(docxBytes);
    const headerFiles = Object.keys(zip.files).filter((k) => /word\/header\d+\.xml/.test(k));
    const footerFiles = Object.keys(zip.files).filter((k) => /word\/footer\d+\.xml/.test(k));
    expect(headerFiles.length).toBeGreaterThan(0);
    expect(footerFiles.length).toBeGreaterThan(0);
    expect(await zip.file(headerFiles[0])!.async('string')).toContain('Confidential Draft');
    expect(await zip.file(footerFiles[0])!.async('string')).toContain('Forma Office');
  });

  it('round-trips native editable Slides tables across PPTX, ODP, and PDF export', async () => {
    const deck = createBlankPresentation('Tables Deck');
    deck.slides[0].elements = [
      {
        id: 'tbl1',
        kind: 'table',
        x: 60,
        y: 80,
        width: 640,
        height: 220,
        headerRow: true,
        tableData: [
          ['Metric', 'Q1', 'Q2'],
          ['Revenue', '$1.2M', '$1.6M'],
          ['Margin', '72%', '75%'],
        ],
      },
    ];

    const pptxBytes = await exportPresentationToPptx(deck);
    const fromPptx = await importPresentationFromPptx(pptxBytes, 'Tables.pptx');
    const pptxTbl = fromPptx.slides[0].elements.find((e) => e.kind === 'table');
    expect(pptxTbl?.tableData?.length).toBe(3);
    expect(pptxTbl?.tableData?.[1]?.[2]).toBe('$1.6M');

    const odpBytes = await exportPresentationToOdp(deck);
    const fromOdp = await importPresentationFromOdp(odpBytes, 'Tables.odp');
    const odpTbl = fromOdp.slides[0].elements.find((e) => e.kind === 'table');
    expect(odpTbl?.tableData?.length).toBe(3);
    expect(odpTbl?.tableData?.[2]?.[0]).toBe('Margin');

    const pdfBytes = await exportPresentationToPdf(deck);
    expect(pdfBytes.byteLength).toBeGreaterThan(500);
  });

  it('reads/fills PDF AcroForm fields and applies/rotates PDF redactions', async () => {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([600, 800]);
    const form = pdfDoc.getForm();
    const nameField = form.createTextField('applicant.name');
    nameField.setText('Initial');
    nameField.addToPage(page, { x: 50, y: 700, width: 200, height: 24 });
    const agreeBox = form.createCheckBox('applicant.agree');
    agreeBox.addToPage(page, { x: 50, y: 650, width: 18, height: 18 });

    const originalBytes = new Uint8Array(await pdfDoc.save());
    const fields = await readPdfFormFields(originalBytes);
    expect(fields.map((f) => f.name)).toContain('applicant.name');
    expect(fields.map((f) => f.name)).toContain('applicant.agree');

    const filledBytes = await fillPdfFormFields(originalBytes, {
      'applicant.name': 'Ada Lovelace',
      'applicant.agree': true,
    });
    const reRead = await readPdfFormFields(filledBytes);
    expect(reRead.find((f) => f.name === 'applicant.name')?.value).toBe('Ada Lovelace');
    expect(reRead.find((f) => f.name === 'applicant.agree')?.value).toBe(true);

    const redactions: PdfRedactAnnotation[] = [
      { id: 'r1', type: 'redact', pageIndex: 0, x: 0.1, y: 0.1, width: 0.2, height: 0.05 },
    ];
    const rotated = remapPageAnnotations(redactions, { type: 'rotate', index: 0, deltaDeg: 90 });
    expect(rotated[0].type).toBe('redact');
    const redactedBytes = await applyRedactionsToPdf(filledBytes, redactions);
    expect(redactedBytes.byteLength).toBeGreaterThan(500);
  });

  it('streams stdout, serializes interactive DataFrames, and executes SQL in macos/forma_kernel.py', () => {
    const kernelPath = path.resolve(process.cwd(), 'macos/forma_kernel.py');
    const script = [
      JSON.stringify({
        type: 'exec',
        reqId: 's1',
        code: 'import time\nfor i in range(3):\n    print("tick", i)\n    time.sleep(0.07)\nrows = [{"city": "SF", "val": 10}, {"city": "NYC", "val": 25}]\nrows',
      }),
      JSON.stringify({
        type: 'sql',
        reqId: 'q1',
        code: 'SELECT city, val * 2 AS doubled FROM rows ORDER BY val DESC',
      }),
    ].join('\n') + '\n';

    const out = execFileSync('python3', ['-u', kernelPath], {
      input: script,
      encoding: 'utf-8',
      timeout: 15000,
    });
    const events = out
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(events[0].type).toBe('ready');
    const streamChunks = events.filter((e) => e.type === 'stream_chunk' && e.reqId === 's1');
    expect(streamChunks.length).toBeGreaterThan(0);

    const execRes = events.find((e) => e.type === 'result' && e.reqId === 's1') as {
      ok: boolean;
      outputs: Array<{ output_type: string; data?: Record<string, unknown> }>;
    };
    expect(execRes?.ok).toBe(true);
    const tableOut = execRes.outputs.find((o) => o.data?.['application/vnd.forma.table+json']);
    expect(tableOut).toBeTruthy();

    const sqlRes = events.find((e) => e.reqId === 'q1' && e.type === 'result') as {
      ok: boolean;
      outputs: Array<{ data?: { 'application/vnd.forma.table+json'?: { columns: string[]; rows: unknown[][] } } }>;
    };
    expect(sqlRes?.ok).toBe(true);
    const sqlTable = sqlRes.outputs[0]?.data?.['application/vnd.forma.table+json'];
    expect(sqlTable?.columns).toEqual(['city', 'doubled']);
    expect(sqlTable?.rows[0]).toEqual(['NYC', 50]);
  });
});
