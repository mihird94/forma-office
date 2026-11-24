import JSZip from 'jszip';
import {
  PresentationData,
  SLIDE_H,
  SLIDE_W,
  SlideData,
  SlideElement,
} from '../../../types/slides';
import { uid } from '../../spreadsheet/workbookOps';

const ODP_MIME = 'application/vnd.oasis.opendocument.presentation';
// 16:9 Widescreen in centimeters: 25.4cm x 14.2875cm
const CM_W = 25.4;
const CM_H = 14.2875;

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toCmX(px: number): string {
  return `${((px / SLIDE_W) * CM_W).toFixed(3)}cm`;
}

function toCmY(px: number): string {
  return `${((px / SLIDE_H) * CM_H).toFixed(3)}cm`;
}

function parseCm(val: string | null, axis: 'x' | 'y'): number {
  if (!val) return 60;
  const num = parseFloat(val);
  if (isNaN(num)) return 60;
  const cm = val.endsWith('in') ? num * 2.54 : val.endsWith('mm') ? num / 10 : num;
  return axis === 'x' ? Math.round((cm / CM_W) * SLIDE_W) : Math.round((cm / CM_H) * SLIDE_H);
}

/**
 * Export a Forma Slides presentation to ISO/IEC 26300 OpenDocument Presentation (.odp).
 * Opens natively in LibreOffice Impress and PowerPoint.
 */
export async function exportPresentationToOdp(deck: PresentationData): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', ODP_MIME, { compression: 'STORE' });

  const manifestXml = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="${ODP_MIME}"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
  office:version="1.2">
  <office:automatic-styles>
    <style:page-layout style:name="PM1">
      <style:page-layout-properties fo:page-width="${CM_W}cm" fo:page-height="${CM_H}cm" style:print-orientation="landscape"/>
    </style:page-layout>
  </office:automatic-styles>
  <office:master-styles>
    <style:master-page style:name="Default" style:page-layout-name="PM1"/>
  </office:master-styles>
</office:document-styles>`;

  const autoStyles: string[] = [];
  const manifestPicEntries: string[] = [];

  const pagesXml = deck.slides
    .map((slide, sIdx) => {
      const pageStyle = `dp${sIdx + 1}`;
      autoStyles.push(
        `<style:style style:name="${pageStyle}" style:family="drawing-page"><style:drawing-page-properties draw:fill="solid" draw:fill-color="${escapeXml(
          slide.backgroundColor || '#ffffff'
        )}"/></style:style>`
      );

      const elemsXml = slide.elements
        .map((el, eIdx) => {
          const stName = `gr_${sIdx}_${eIdx}`;
          if (el.kind === 'shape') {
            autoStyles.push(
              `<style:style style:name="${stName}" style:family="graphic"><style:graphic-properties draw:fill="solid" draw:fill-color="${escapeXml(
                el.fillColor || '#e2e8f0'
              )}" draw:stroke="none"/></style:style>`
            );
            const tag = el.shape === 'ellipse' ? 'draw:ellipse' : 'draw:rect';
            const innerP = el.text ? `<text:p>${escapeXml(el.text)}</text:p>` : '';
            return `<${tag} draw:style-name="${stName}" svg:x="${toCmX(el.x)}" svg:y="${toCmY(
              el.y
            )}" svg:width="${toCmX(el.width)}" svg:height="${toCmY(el.height)}">${innerP}</${tag}>`;
          }
          if (el.kind === 'text') {
            const txtStyle = `T_${sIdx}_${eIdx}`;
            autoStyles.push(
              `<style:style style:name="${txtStyle}" style:family="text"><style:text-properties fo:font-size="${Math.round(
                (el.fontSize ?? 20) * 0.75
              )}pt" fo:color="${escapeXml(el.color || '#0f172a')}"${
                el.bold ? ' fo:font-weight="bold"' : ''
              }${el.italic ? ' fo:font-style="italic"' : ''}/></style:style>`
            );
            const lines = (el.text ?? '')
              .split('\n')
              .map((line) => `<text:p><text:span text:style-name="${txtStyle}">${escapeXml(line)}</text:span></text:p>`)
              .join('');
            return `<draw:frame svg:x="${toCmX(el.x)}" svg:y="${toCmY(el.y)}" svg:width="${toCmX(
              el.width
            )}" svg:height="${toCmY(el.height)}"><draw:text-box>${lines}</draw:text-box></draw:frame>`;
          }
          if (el.kind === 'image' && el.src) {
            const m = /^data:(image\/([a-zA-Z0-9+.-]+));base64,(.+)$/.exec(el.src);
            if (m) {
              const mime = m[1];
              const ext = m[2] === 'jpeg' ? 'jpg' : m[2] === 'svg+xml' ? 'svg' : m[2];
              const b64 = m[3];
              const picPath = `Pictures/img_${sIdx}_${eIdx}.${ext}`;
              zip.file(picPath, b64, { base64: true });
              manifestPicEntries.push(
                `  <manifest:file-entry manifest:full-path="${picPath}" manifest:media-type="${mime}"/>`
              );
              return `<draw:frame svg:x="${toCmX(el.x)}" svg:y="${toCmY(el.y)}" svg:width="${toCmX(
                el.width
              )}" svg:height="${toCmY(el.height)}"><draw:image xlink:href="${picPath}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>`;
            }
          }
          if (el.kind === 'table' && el.tableData && el.tableData.length > 0) {
            const colCount = Math.max(1, ...el.tableData.map((r) => r.length));
            const colsXml = Array.from({ length: colCount }, () => '<table:table-column/>').join('');
            const rowsXml = el.tableData
              .map((row) => {
                const cellsXml = Array.from({ length: colCount }, (_, cIdx) => {
                  const val = row[cIdx] ?? '';
                  return `<table:table-cell office:value-type="string"><text:p>${escapeXml(val)}</text:p></table:table-cell>`;
                }).join('');
                return `<table:table-row>${cellsXml}</table:table-row>`;
              })
              .join('');
            return `<draw:frame svg:x="${toCmX(el.x)}" svg:y="${toCmY(el.y)}" svg:width="${toCmX(
              el.width
            )}" svg:height="${toCmY(el.height)}"><table:table>${colsXml}${rowsXml}</table:table></draw:frame>`;
          }
          return '';
        })
        .join('\n');

      const notesXml = slide.notes?.trim()
        ? `<presentation:notes><draw:frame svg:x="2cm" svg:y="14cm" svg:width="17cm" svg:height="10cm"><draw:text-box><text:p>${escapeXml(
            slide.notes
          )}</text:p></draw:text-box></draw:frame></presentation:notes>`
        : '';

      return `<draw:page draw:name="page${sIdx + 1}" draw:style-name="${pageStyle}" draw:master-page-name="Default">${elemsXml}${notesXml}</draw:page>`;
    })
    .join('\n');

  const contentXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
  xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  office:version="1.2">
  <office:automatic-styles>
    ${autoStyles.join('\n    ')}
  </office:automatic-styles>
  <office:body>
    <office:presentation>
      ${pagesXml}
    </office:presentation>
  </office:body>
</office:document-content>`;

  const finalManifest =
    manifestPicEntries.length > 0
      ? manifestXml.replace('</manifest:manifest>', `${manifestPicEntries.join('\n')}\n</manifest:manifest>`)
      : manifestXml;
  zip.file('META-INF/manifest.xml', finalManifest);
  zip.file('styles.xml', stylesXml);
  zip.file('content.xml', contentXml);

  return zip.generateAsync({ type: 'uint8array' });
}

/**
 * Import an ISO/IEC 26300 OpenDocument Presentation (.odp).
 */
export async function importPresentationFromOdp(
  bytes: ArrayBuffer | Uint8Array,
  filename = 'Imported ODP'
): Promise<PresentationData> {
  const zip = await JSZip.loadAsync(bytes);
  const contentStr = await zip.file('content.xml')?.async('string');
  if (!contentStr) throw new Error('Invalid .odp archive: missing content.xml');

  const parser = new DOMParser();
  const doc = parser.parseFromString(contentStr.replace(/^\uFEFF/, ''), 'application/xml');

  // Collect drawing-page / graphic / text automatic styles
  const bgStyleMap = new Map<string, string>();
  const graphicFillMap = new Map<string, string>();
  const textStyleMap = new Map<string, { color?: string; fontSize?: number; bold?: boolean; italic?: boolean }>();

  for (const st of Array.from(doc.getElementsByTagNameNS('*', 'style'))) {
    const name = st.getAttribute('style:name');
    if (!name) continue;
    const dp = st.getElementsByTagNameNS('*', 'drawing-page-properties')[0];
    if (dp?.getAttribute('draw:fill-color')) {
      bgStyleMap.set(name, dp.getAttribute('draw:fill-color')!);
    }
    const gp = st.getElementsByTagNameNS('*', 'graphic-properties')[0];
    if (gp?.getAttribute('draw:fill-color')) {
      graphicFillMap.set(name, gp.getAttribute('draw:fill-color')!);
    }
    const tp = st.getElementsByTagNameNS('*', 'text-properties')[0];
    if (tp) {
      const sz = parseFloat(tp.getAttribute('fo:font-size') || '');
      textStyleMap.set(name, {
        color: tp.getAttribute('fo:color') || undefined,
        fontSize: !isNaN(sz) ? Math.round(sz / 0.75) : undefined,
        bold: tp.getAttribute('fo:font-weight') === 'bold',
        italic: tp.getAttribute('fo:font-style') === 'italic',
      });
    }
  }

  const pages = Array.from(doc.getElementsByTagNameNS('*', 'page'));
  const slides: SlideData[] = [];
  for (const page of pages) {
    const pageStyleName = page.getAttribute('draw:style-name') || '';
    const backgroundColor = bgStyleMap.get(pageStyleName) || '#ffffff';
    const elements: SlideElement[] = [];

    for (const child of Array.from(page.children)) {
      const local = child.localName;
      if (local === 'rect' || local === 'ellipse') {
        const stName = child.getAttribute('draw:style-name') || '';
        elements.push({
          id: uid('el'),
          kind: 'shape',
          shape: local === 'ellipse' ? 'ellipse' : 'rect',
          x: parseCm(child.getAttribute('svg:x'), 'x'),
          y: parseCm(child.getAttribute('svg:y'), 'y'),
          width: Math.max(30, parseCm(child.getAttribute('svg:width'), 'x')),
          height: Math.max(6, parseCm(child.getAttribute('svg:height'), 'y')),
          fillColor: graphicFillMap.get(stName) || '#e2e8f0',
          text: child.textContent?.trim() || undefined,
        });
      } else if (local === 'frame') {
        const imgNode = Array.from(child.children).find((c) => c.localName === 'image');
        if (imgNode) {
          const href = imgNode.getAttribute('xlink:href') || imgNode.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
          if (href && zip.file(href)) {
            const b64 = await zip.file(href)!.async('base64');
            const ext = href.split('.').pop()?.toLowerCase() || 'png';
            const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : 'image/png';
            elements.push({
              id: uid('el'),
              kind: 'image',
              x: parseCm(child.getAttribute('svg:x'), 'x'),
              y: parseCm(child.getAttribute('svg:y'), 'y'),
              width: Math.max(40, parseCm(child.getAttribute('svg:width'), 'x')),
              height: Math.max(30, parseCm(child.getAttribute('svg:height'), 'y')),
              src: `data:${mime};base64,${b64}`,
            });
            continue;
          }
        }
        const tableNode = Array.from(child.children).find((c) => c.localName === 'table');
        if (tableNode) {
          const tableData: string[][] = Array.from(tableNode.getElementsByTagNameNS('*', 'table-row'))
            .map((tr) =>
              Array.from(tr.getElementsByTagNameNS('*', 'table-cell')).map((tc) =>
                Array.from(tc.getElementsByTagNameNS('*', 'p'))
                  .map((p) => p.textContent ?? '')
                  .join('\n')
                  .trim()
              )
            )
            .filter((row) => row.length > 0);
          if (tableData.length > 0) {
            const rowText = tableData.map((r) => r.join('  |  ')).join('\n');
            elements.push({
              id: uid('el'),
              kind: 'table',
              x: parseCm(child.getAttribute('svg:x'), 'x'),
              y: parseCm(child.getAttribute('svg:y'), 'y'),
              width: Math.max(120, parseCm(child.getAttribute('svg:width'), 'x')),
              height: Math.max(60, parseCm(child.getAttribute('svg:height'), 'y')),
              tableData,
              headerRow: true,
              text: rowText,
              fontSize: 14,
              color: '#0f172a',
              fillColor: '#1e293b',
              borderColor: '#cbd5e1',
            });
          }
          continue;
        }
        const textBox = Array.from(child.children).find((c) => c.localName === 'text-box');
        if (!textBox) continue;
        const pNodes = Array.from(textBox.getElementsByTagNameNS('*', 'p'));
        const text = pNodes.map((p) => p.textContent ?? '').join('\n').trim();
        if (!text) continue;
        const firstSpan = textBox.getElementsByTagNameNS('*', 'span')[0];
        const stProps = textStyleMap.get(firstSpan?.getAttribute('text:style-name') || '');
        elements.push({
          id: uid('el'),
          kind: 'text',
          x: parseCm(child.getAttribute('svg:x'), 'x'),
          y: parseCm(child.getAttribute('svg:y'), 'y'),
          width: Math.max(80, parseCm(child.getAttribute('svg:width'), 'x')),
          height: Math.max(30, parseCm(child.getAttribute('svg:height'), 'y')),
          text,
          color: stProps?.color || '#0f172a',
          fontSize: stProps?.fontSize || 20,
          bold: stProps?.bold,
          italic: stProps?.italic,
        });
      }
    }

    const notesEl = Array.from(page.children).find((c) => c.localName === 'notes');
    const notes = notesEl?.textContent?.trim() || '';

    slides.push({ id: uid('slide'), backgroundColor, elements, notes });
  }

  const now = Date.now();
  return {
    id: uid('deck'),
    title: filename.replace(/\.odp$/i, ''),
    themeId: 'daylight',
    slides:
      slides.length > 0
        ? slides
        : [{ id: uid('slide'), backgroundColor: '#ffffff', elements: [], notes: '' }],
    createdAt: now,
    updatedAt: now,
  };
}
