import { describe, expect, it } from 'vitest';
import { importDocumentFromHtml, exportDocumentToHtml } from '../engine/document/formats/htmlCodec';
import { importDocumentFromMarkdown } from '../engine/document/formats/markdownCodec';
import { renderMathMarkdown } from '../engine/notebook/mathMarkdown';
import { sanitizeDocumentHtml } from '../utils/documentSecurity';

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

describe('Document rendering isolation', () => {
  it('keeps layout, math, and embedded images while dropping nested documents and remote images', () => {
    const rendered = sanitizeDocumentHtml(renderMathMarkdown([
      '# Example',
      '',
      'Inline math $x^2$.',
      '',
      '<iframe title="Embedded document" src="about:blank"></iframe>',
      '<img alt="Remote asset" src="https://example.invalid/picture.png">',
      '<img alt="Embedded asset" src="data:image/png;base64,AA==">',
    ].join('\n')));
    const doc = parse(rendered);
    expect(doc.querySelector('h1')?.textContent).toBe('Example');
    expect(doc.querySelector('.katex')).toBeTruthy();
    expect(doc.querySelector('iframe')).toBeNull();
    expect(doc.querySelector('img[alt="Remote asset"]')?.hasAttribute('src')).toBe(false);
    expect(doc.querySelector('img[alt="Embedded asset"]')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
  });

  it('preserves task and table structure through import and gives exported HTML a restrictive policy', () => {
    const markdown = importDocumentFromMarkdown('- [x] Complete');
    expect(parse(markdown.html).querySelector('li[data-type="taskItem"][data-checked="true"]')).toBeTruthy();
    const imported = importDocumentFromHtml('<table><tr><td>Cell</td></tr></table><form><button>Submit</button></form>');
    const exported = parse(exportDocumentToHtml(imported));
    expect(exported.querySelector('td')?.textContent).toBe('Cell');
    expect(exported.querySelector('form, button')).toBeNull();
    expect(exported.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("default-src 'none'");
  });

  it('preserves live Forma Canvas SVG data-URI embeds and data-forma-canvas metadata', () => {
    const svgBase64 = 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==';
    const html = `<p><img src="data:image/svg+xml;base64,${svgBase64}" alt="System Architecture" data-forma-canvas="canvas_42:System Architecture" /></p>`;
    const doc = parse(sanitizeDocumentHtml(html));
    const img = doc.querySelector('img[data-forma-canvas]');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toBe(`data:image/svg+xml;base64,${svgBase64}`);
    expect(img?.getAttribute('data-forma-canvas')).toBe('canvas_42:System Architecture');
  });
});
