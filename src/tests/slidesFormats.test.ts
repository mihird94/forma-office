import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { createPresentationFromTemplate } from '../engine/slides/slideTemplates';
import {
  exportPresentationToPptx,
  importPresentationFromPptx,
} from '../engine/slides/formats/pptxCodec';
import {
  exportPresentationToOdp,
  importPresentationFromOdp,
} from '../engine/slides/formats/odpCodec';
import { exportPresentationToPdf } from '../engine/slides/formats/slidePdfCodec';
import { getPdfPageCount } from '../engine/pdf/pdfEngine';

describe('Presentation Open Formats Interoperability (.pptx, .odp, .pdf)', () => {
  it('round-trips OOXML (.pptx) preserving slides, text, backgrounds, and speaker notes', async () => {
    const pitch = createPresentationFromTemplate('pitch');
    const bytes = await exportPresentationToPptx(pitch);
    expect(bytes.byteLength).toBeGreaterThan(5000);

    const zip = await JSZip.loadAsync(bytes);
    expect(zip.file('ppt/presentation.xml')).toBeTruthy();
    expect(zip.file('ppt/slides/slide1.xml')).toBeTruthy();

    const imported = await importPresentationFromPptx(bytes, 'Pitch.pptx');
    expect(imported.slides.length).toBe(pitch.slides.length);
    const slide1Text = imported.slides[0].elements
      .map((e) => e.text ?? '')
      .join(' ');
    expect(slide1Text).toContain('Forma Office');
    expect(imported.slides[0].notes).toContain('company vision');
  });

  it('exports valid ISO/IEC 26300 (.odp) and round-trips cleanly', async () => {
    const pitch = createPresentationFromTemplate('pitch');
    const bytes = await exportPresentationToOdp(pitch);

    const zip = await JSZip.loadAsync(bytes);
    expect(await zip.file('mimetype')?.async('string')).toBe(
      'application/vnd.oasis.opendocument.presentation'
    );
    expect(zip.file('META-INF/manifest.xml')).toBeTruthy();
    expect(zip.file('content.xml')).toBeTruthy();

    const imported = await importPresentationFromOdp(bytes, 'Pitch.odp');
    expect(imported.slides.length).toBe(pitch.slides.length);
    const slide1Text = imported.slides[0].elements
      .map((e) => e.text ?? '')
      .join(' ');
    expect(slide1Text).toContain('Forma Office');
  });

  it('exports 16:9 vector PDF deck with matching page count', async () => {
    const pitch = createPresentationFromTemplate('pitch');
    const pdfBytes = await exportPresentationToPdf(pitch);
    expect(await getPdfPageCount(pdfBytes)).toBe(pitch.slides.length);
  });
});
