import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { Document, Footer, Header, ImageRun, Packer, PageBreak, Paragraph, TextRun } from 'docx';
import { createSampleDocument } from '../engine/document/sampleDocs';
import {
  exportDocumentToDocx,
  importDocumentFromDocx,
} from '../engine/document/formats/docxCodec';
import {
  exportDocumentToOdt,
  importDocumentFromOdt,
} from '../engine/document/formats/odtCodec';
import {
  exportDocumentToMarkdown,
  importDocumentFromMarkdown,
} from '../engine/document/formats/markdownCodec';
import {
  exportDocumentToHtml,
  importDocumentFromHtml,
} from '../engine/document/formats/htmlCodec';

describe('Document Open Formats Interoperability (.docx, .odt, .md, .html)', () => {
  it('exports valid OOXML (.docx) and imports back via Mammoth', async () => {
    const sample = createSampleDocument();
    const bytes = await exportDocumentToDocx(sample);
    expect(bytes.byteLength).toBeGreaterThan(2000);

    // Verify valid OOXML ZIP contents
    const zip = await JSZip.loadAsync(bytes);
    expect(zip.file('word/document.xml')).toBeTruthy();

    const imported = await importDocumentFromDocx(bytes, 'Spec.docx');
    expect(imported.html).toContain('Forma Office');
    expect(imported.html).toContain('Interoperability Matrix');
    expect(imported.html).toContain('<table');
  });

  it('preserves external DOCX header/footer text, images and both ways to add a page break', async () => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6ioAAAAASUVORK5CYII='), (c) => c.charCodeAt(0));
    const input = new Document({
      sections: [{
        headers: { default: new Header({ children: [new Paragraph('Original header')] }) },
        footers: { default: new Footer({ children: [new Paragraph('Original footer')] }) },
        children: [
          new Paragraph('Before breaks'),
          new Paragraph({ text: 'Break before paragraph', pageBreakBefore: true }),
          new Paragraph({ children: [new TextRun('Inline split'), new PageBreak(), new TextRun('After split')] }),
          new Paragraph({ children: [new ImageRun({ data: png, type: 'png', transformation: { width: 24, height: 24 } })] }),
        ],
      }],
    });
    const imported = await importDocumentFromDocx(new Uint8Array(await Packer.toArrayBuffer(input)));
    expect(imported.pageSettings.headerText).toBe('Original header');
    expect(imported.pageSettings.footerText).toBe('Original footer');
    expect(imported.html.match(/class="page-break"/g)).toHaveLength(2);
    expect(imported.html).toContain('data:image/png;base64,');

    const exported = await exportDocumentToDocx({ ...imported, html: imported.html.replace('Before breaks', 'Edited text') });
    const zip = await JSZip.loadAsync(exported);
    const body = await zip.file('word/document.xml')!.async('string');
    expect(body).toContain('Edited text');
    expect(body.match(/w:type="page"/g)).toHaveLength(2);
    expect(await zip.file('word/header1.xml')?.async('string')).toContain('Original header');
    expect(await zip.file('word/footer1.xml')?.async('string')).toContain('Original footer');
    expect(zip.file(/^word\/media\/.+\.png$/)).toHaveLength(1);
  });

  it('exports valid ISO/IEC 26300 (.odt) and round-trips cleanly', async () => {
    const sample = createSampleDocument();
    const bytes = await exportDocumentToOdt(sample);

    const zip = await JSZip.loadAsync(bytes);
    expect(await zip.file('mimetype')?.async('string')).toBe(
      'application/vnd.oasis.opendocument.text'
    );
    expect(zip.file('META-INF/manifest.xml')).toBeTruthy();
    expect(zip.file('content.xml')).toBeTruthy();

    const imported = await importDocumentFromOdt(bytes, 'Spec.odt');
    expect(imported.html).toContain('<h1>Forma Office');
    expect(imported.html).toContain('<table>');
    expect(imported.html).toContain('Forma Sheets');
  });

  it('round-trips GitHub-Flavored Markdown (.md) including tables and headings', () => {
    const sample = createSampleDocument();
    const md = exportDocumentToMarkdown(sample);
    expect(md).toContain('# Forma Office');
    expect(md).toContain('| Application | Primary Open Standards |');

    const imported = importDocumentFromMarkdown(md, 'Spec.md');
    expect(imported.sourceFormat).toBe('md');
    expect(imported.markdownSource).toBe(md);
    expect(imported.html).toContain('<h1>Forma Office');
    expect(imported.html).toContain('<table>');
  });

  it('round-trips standalone HTML5 (.html)', () => {
    const sample = createSampleDocument();
    const html = exportDocumentToHtml(sample);
    expect(html).toContain('<!doctype html>');
    const imported = importDocumentFromHtml(html, 'Spec.html');
    expect(imported.html).toContain('Interoperability Matrix');
  });
});
