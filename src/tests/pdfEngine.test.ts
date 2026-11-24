import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  bakeAnnotationsIntoPdf,
  createBlankPdfBytes,
  createSampleReportPdfBytes,
  deletePdfPage,
  duplicatePdfPage,
  extractPdfPage,
  getPdfPageCount,
  insertBlankPdfPage,
  mergePdfBytes,
  movePdfPage,
  rotatePdfPage,
} from '../engine/pdf/pdfEngine';

describe('Forma PDF Engine (ISO 32000)', () => {
  it('creates blank and multi-page sample PDFs', async () => {
    const blank = await createBlankPdfBytes();
    expect(await getPdfPageCount(blank)).toBe(1);

    const report = await createSampleReportPdfBytes();
    expect(await getPdfPageCount(report)).toBe(3);
  });

  it('supports rotate, duplicate, insert, reorder, delete, extract, and merge', async () => {
    let bytes = await createSampleReportPdfBytes();

    // Rotate page 0 by 90 deg
    bytes = await rotatePdfPage(bytes, 0, 90);
    const rotDoc = await PDFDocument.load(bytes);
    expect(rotDoc.getPage(0).getRotation().angle).toBe(90);

    // Duplicate page 1 -> 4 pages
    bytes = await duplicatePdfPage(bytes, 1);
    expect(await getPdfPageCount(bytes)).toBe(4);

    // Insert blank page -> 5 pages
    bytes = await insertBlankPdfPage(bytes, 0);
    expect(await getPdfPageCount(bytes)).toBe(5);

    // Reorder page 4 to 0 -> still 5 pages
    bytes = await movePdfPage(bytes, 4, 0);
    expect(await getPdfPageCount(bytes)).toBe(5);

    // Delete page 0 -> 4 pages
    bytes = await deletePdfPage(bytes, 0);
    expect(await getPdfPageCount(bytes)).toBe(4);

    // Extract single page -> 1 page
    const extracted = await extractPdfPage(bytes, 0);
    expect(await getPdfPageCount(extracted)).toBe(1);

    // Merge 4-page PDF + 1-page PDF -> 5 pages
    const merged = await mergePdfBytes([bytes, extracted]);
    expect(await getPdfPageCount(merged)).toBe(5);
  });

  it('bakes highlight, text, ink signature, and note annotations permanently into PDF', async () => {
    const base = await createBlankPdfBytes();
    const annotated = await bakeAnnotationsIntoPdf(base, [
      { id: 'a1', type: 'highlight', pageIndex: 0, x: 0.1, y: 0.2, width: 0.4, height: 0.05, color: '#fde047' },
      { id: 'a2', type: 'text', pageIndex: 0, x: 0.15, y: 0.3, text: 'Approved by QA', fontSize: 14, color: '#dc2626' },
      {
        id: 'a3',
        type: 'ink',
        pageIndex: 0,
        color: '#1e3a8a',
        strokeWidth: 2,
        points: [
          { x: 0.2, y: 0.5 },
          { x: 0.3, y: 0.55 },
          { x: 0.4, y: 0.48 },
        ],
      },
      { id: 'a4', type: 'note', pageIndex: 0, x: 0.6, y: 0.2, text: 'Verify Q4 margin', color: '#f59e0b' },
    ]);

    expect(annotated.byteLength).toBeGreaterThan(base.byteLength);
    expect(await getPdfPageCount(annotated)).toBe(1);
  });
});
