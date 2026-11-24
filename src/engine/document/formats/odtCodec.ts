import { FastZip } from '../../../utils/fastZip';
import { FormaDocument } from '../../../types/document';
import { uid } from '../../spreadsheet/workbookOps';

const ODT_MIME = 'application/vnd.oasis.opendocument.text';

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

interface OdtImageAsset {
  path: string;
  mime: string;
  bytes: Uint8Array;
}

function registerOdtImage(src: string, images: OdtImageAsset[]): string {
  const m = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(src.trim());
  if (!m) return '';
  const rawExt = m[1].toLowerCase();
  const ext = rawExt === 'jpeg' ? 'jpg' : rawExt;
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  const bin = atob(m[2].replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const path = `Pictures/img_${images.length + 1}.${ext}`;
  images.push({ path, mime, bytes });
  return `<draw:frame draw:name="Image${images.length}" text:anchor-type="as-char" svg:width="10cm" svg:height="7cm"><draw:image xlink:href="${path}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>`;
}

function serializeInlineToOdt(node: Node, images: OdtImageAsset[]): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeXml(node.textContent ?? '');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (tag === 'img') {
    return registerOdtImage(el.getAttribute('src') || '', images);
  }
  const inner = Array.from(el.childNodes).map((c) => serializeInlineToOdt(c, images)).join('');

  switch (tag) {
    case 'strong':
    case 'b':
      return `<text:span text:style-name="Bold">${inner}</text:span>`;
    case 'em':
    case 'i':
      return `<text:span text:style-name="Italic">${inner}</text:span>`;
    case 'u':
      return `<text:span text:style-name="Underline">${inner}</text:span>`;
    case 's':
    case 'del':
      return `<text:span text:style-name="Strike">${inner}</text:span>`;
    case 'code':
      return `<text:span text:style-name="Code">${inner}</text:span>`;
    case 'mark':
      return `<text:span text:style-name="Highlight">${inner}</text:span>`;
    case 'a': {
      const href = el.getAttribute('href') || '';
      return `<text:a xlink:type="simple" xlink:href="${escapeXml(href)}">${inner}</text:a>`;
    }
    case 'br':
      return '<text:line-break/>';
    default:
      return inner;
  }
}

function serializeListItemToOdt(li: Element, images: OdtImageAsset[]): string {
  const inlineParts: string[] = [];
  const subLists: string[] = [];
  for (const child of Array.from(li.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const cTag = (child as Element).tagName.toLowerCase();
      if (cTag === 'ul' || cTag === 'ol') {
        subLists.push(serializeBlockToOdt(child as Element, images));
        continue;
      }
    }
    inlineParts.push(serializeInlineToOdt(child, images));
  }
  return `<text:list-item><text:p text:style-name="Standard">${inlineParts.join('')}</text:p>${subLists.join('')}</text:list-item>`;
}

function serializeBlockToOdt(el: Element, images: OdtImageAsset[]): string {
  const tag = el.tagName.toLowerCase();

  if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
    const level = Math.min(3, parseInt(tag.slice(1), 10));
    return `<text:h text:style-name="Heading_${level}" text:outline-level="${level}">${serializeInlineToOdt(el, images)}</text:h>`;
  }

  if (tag === 'img') {
    const imgXml = serializeInlineToOdt(el, images);
    return imgXml ? `<text:p text:style-name="Standard">${imgXml}</text:p>` : '';
  }

  if (tag === 'p') {
    const align = (el as HTMLElement).style?.textAlign;
    const styleName =
      align === 'center'
        ? 'P_Center'
        : align === 'right'
          ? 'P_Right'
          : align === 'justify'
            ? 'P_Justify'
            : 'Standard';
    return `<text:p text:style-name="${styleName}">${serializeInlineToOdt(el, images)}</text:p>`;
  }

  if (tag === 'blockquote') {
    return `<text:p text:style-name="Quote">${serializeInlineToOdt(el, images)}</text:p>`;
  }

  if (tag === 'pre') {
    const lines = (el.textContent ?? '').split('\n');
    return lines
      .map((l) => `<text:p text:style-name="CodeBlock">${escapeXml(l)}</text:p>`)
      .join('\n');
  }

  if (tag === 'ul' || tag === 'ol') {
    const listStyle = tag === 'ol' ? 'L_Numbered' : 'L_Bullet';
    const items = Array.from(el.children)
      .filter((c) => c.tagName.toLowerCase() === 'li')
      .map((li) => serializeListItemToOdt(li, images))
      .join('');
    return `<text:list text:style-name="${listStyle}">${items}</text:list>`;
  }

  if (tag === 'table') {
    const rows = Array.from(el.querySelectorAll('tr'));
    const maxCols = rows.reduce((m, r) => Math.max(m, r.children.length), 1);
    const colsXml = `<table:table-column table:number-columns-repeated="${maxCols}"/>`;
    const rowsXml = rows
      .map((tr) => {
        const cells = Array.from(tr.children)
          .filter((c) => c.tagName.toLowerCase() === 'td' || c.tagName.toLowerCase() === 'th')
          .map((c) => {
            const st = c.tagName.toLowerCase() === 'th' ? 'TableHeader' : 'Standard';
            const pKids = Array.from(c.children).filter((ch) =>
              ['p', 'div'].includes(ch.tagName.toLowerCase())
            );
            const innerPs = pKids.length
              ? pKids.map((p) => `<text:p text:style-name="${st}">${serializeInlineToOdt(p, images)}</text:p>`).join('')
              : `<text:p text:style-name="${st}">${serializeInlineToOdt(c, images)}</text:p>`;
            return `<table:table-cell office:value-type="string">${innerPs}</table:table-cell>`;
          })
          .join('');
        return `<table:table-row>${cells}</table:table-row>`;
      })
      .join('');
    return `<table:table table:name="Table">${colsXml}${rowsXml}</table:table>`;
  }

  if (tag === 'hr') {
    return '<text:p text:style-name="HorizontalLine"/>';
  }

  return Array.from(el.children).map((c) => serializeBlockToOdt(c, images)).join('\n');
}

/**
 * Export a Forma Document to ISO/IEC 26300 OpenDocument Text (.odt).
 */
export async function exportDocumentToOdt(doc: FormaDocument): Promise<Uint8Array> {
  const zip = new FastZip();
  zip.writeText('mimetype', ODT_MIME, { store: true });

  const manifestXml = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="${ODT_MIME}"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  office:version="1.2">
  <office:styles>
    <style:style style:name="Standard" style:family="paragraph">
      <style:text-properties fo:font-family="Inter" fo:font-size="11pt"/>
    </style:style>
    <style:style style:name="Heading_1" style:family="paragraph">
      <style:text-properties fo:font-size="22pt" fo:font-weight="bold"/>
    </style:style>
    <style:style style:name="Heading_2" style:family="paragraph">
      <style:text-properties fo:font-size="16pt" fo:font-weight="bold"/>
    </style:style>
    <style:style style:name="Heading_3" style:family="paragraph">
      <style:text-properties fo:font-size="13pt" fo:font-weight="bold"/>
    </style:style>
    <style:style style:name="TableHeader" style:family="paragraph">
      <style:text-properties fo:font-weight="bold"/>
    </style:style>
    <style:style style:name="Quote" style:family="paragraph">
      <style:paragraph-properties fo:margin-left="0.5in"/>
      <style:text-properties fo:font-style="italic" fo:color="#334155"/>
    </style:style>
    <style:style style:name="CodeBlock" style:family="paragraph">
      <style:text-properties fo:font-family="Courier New" fo:font-size="9.5pt"/>
    </style:style>
    <style:style style:name="P_Center" style:family="paragraph">
      <style:paragraph-properties fo:text-align="center"/>
    </style:style>
    <style:style style:name="P_Right" style:family="paragraph">
      <style:paragraph-properties fo:text-align="end"/>
    </style:style>
    <style:style style:name="P_Justify" style:family="paragraph">
      <style:paragraph-properties fo:text-align="justify"/>
    </style:style>
  </office:styles>
</office:document-styles>`;

  const parser = new DOMParser();
  const parsed = parser.parseFromString(doc.html || '<p></p>', 'text/html');
  const images: OdtImageAsset[] = [];
  const bodyXml = Array.from(parsed.body.children).map((c) => serializeBlockToOdt(c, images)).join('\n');

  const manifestEntries = images
    .map((img) => `  <manifest:file-entry manifest:full-path="${escapeXml(img.path)}" manifest:media-type="${escapeXml(img.mime)}"/>`)
    .join('\n');
  const finalManifest = manifestEntries
    ? manifestXml.replace('</manifest:manifest>', `${manifestEntries}\n</manifest:manifest>`)
    : manifestXml;

  const contentXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
  xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  office:version="1.2">
  <office:automatic-styles>
    <style:style style:name="Bold" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
    <style:style style:name="Italic" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>
    <style:style style:name="Underline" style:family="text"><style:text-properties style:text-underline-style="solid"/></style:style>
    <style:style style:name="Strike" style:family="text"><style:text-properties style:text-line-through-style="solid"/></style:style>
    <style:style style:name="Code" style:family="text"><style:text-properties fo:font-family="Courier New"/></style:style>
    <style:style style:name="Highlight" style:family="text"><style:text-properties fo:background-color="#fef08a"/></style:style>
    <text:list-style style:name="L_Bullet">
      <text:list-level-style-bullet text:level="1" text:bullet-char="•"/>
    </text:list-style>
    <text:list-style style:name="L_Numbered">
      <text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix="."/>
    </text:list-style>
  </office:automatic-styles>
  <office:body>
    <office:text>
      ${bodyXml}
    </office:text>
  </office:body>
</office:document-content>`;

  zip.writeText('META-INF/manifest.xml', finalManifest);
  zip.writeText('styles.xml', stylesXml);
  zip.writeText('content.xml', contentXml);
  for (const img of images) {
    zip.writeBytes(img.path, img.bytes);
  }

  return zip.toUint8Array();
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function odtInlineToHtml(
  node: Node,
  styleMap: Map<string, Set<string>>,
  imageDataMap: Map<string, string>
): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeHtml(node.textContent ?? '');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  const local = el.localName;

  if (local === 'line-break') return '<br />';
  if (local === 's') {
    const count = parseInt(el.getAttribute('text:c') || '1', 10);
    return ' '.repeat(count);
  }
  if (local === 'tab') return '    ';
  if (local === 'image') {
    const href = el.getAttribute('xlink:href') || '';
    const dataUri = imageDataMap.get(href);
    if (dataUri) return `<img src="${dataUri}" />`;
    const binEl = el.getElementsByTagNameNS('*', 'binary-data')[0];
    if (binEl?.textContent) {
      return `<img src="data:image/png;base64,${binEl.textContent.replace(/\s+/g, '')}" />`;
    }
    return '';
  }

  const inner = Array.from(el.childNodes)
    .map((c) => odtInlineToHtml(c, styleMap, imageDataMap))
    .join('');

  if (local === 'a') {
    const href = el.getAttribute('xlink:href') || '#';
    return `<a href="${escapeHtml(href)}">${inner}</a>`;
  }

  if (local === 'span') {
    const stName = el.getAttribute('text:style-name') || '';
    const traits = styleMap.get(stName) ?? new Set<string>();
    let out = inner;
    if (stName === 'Code' || traits.has('code')) out = `<code>${out}</code>`;
    if (stName === 'Bold' || traits.has('bold')) out = `<strong>${out}</strong>`;
    if (stName === 'Italic' || traits.has('italic')) out = `<em>${out}</em>`;
    if (stName === 'Underline' || traits.has('underline')) out = `<u>${out}</u>`;
    if (stName === 'Strike' || traits.has('strike')) out = `<s>${out}</s>`;
    if (stName === 'Highlight' || traits.has('highlight')) out = `<mark>${out}</mark>`;
    return out;
  }

  return inner;
}

function parseOdtList(
  listEl: Element,
  styleMap: Map<string, Set<string>>,
  imageDataMap: Map<string, string>
): string {
  const stName = (listEl.getAttribute('text:style-name') || '').toLowerCase();
  const tag = stName.includes('num') ? 'ol' : 'ul';
  const items = Array.from(listEl.children)
    .filter((c) => c.localName === 'list-item')
    .map((li) => {
      const pParts: string[] = [];
      const subParts: string[] = [];
      for (const ch of Array.from(li.children)) {
        if (ch.localName === 'list') {
          subParts.push(parseOdtList(ch, styleMap, imageDataMap));
        } else {
          pParts.push(odtInlineToHtml(ch, styleMap, imageDataMap));
        }
      }
      return `<li><p>${pParts.join('<br />')}</p>${subParts.join('')}</li>`;
    })
    .join('');
  return `<${tag}>${items}</${tag}>`;
}

/**
 * Import an ISO/IEC 26300 OpenDocument Text (.odt) file into a Forma Document.
 */
export async function importDocumentFromOdt(
  bytes: ArrayBuffer | Uint8Array,
  filename = 'Imported ODT'
): Promise<FormaDocument> {
  const zip = FastZip.load(bytes);
  const rawContentXml = zip.readText('content.xml');
  if (rawContentXml === null) {
    throw new Error('Invalid .odt archive: missing content.xml');
  }
  const xmlText = rawContentXml.replace(/^\uFEFF/, '');
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, 'application/xml');

  // Collect automatic text styles (bold, italic, underline, strike, monospace)
  const styleMap = new Map<string, Set<string>>();
  for (const st of Array.from(xmlDoc.getElementsByTagNameNS('*', 'style'))) {
    const name = st.getAttribute('style:name');
    if (!name) continue;
    const traits = new Set<string>();
    const textProps = st.getElementsByTagNameNS('*', 'text-properties')[0];
    if (textProps) {
      if (textProps.getAttribute('fo:font-weight') === 'bold') traits.add('bold');
      if (textProps.getAttribute('fo:font-style') === 'italic') traits.add('italic');
      if (textProps.getAttribute('style:text-underline-style')) traits.add('underline');
      if (textProps.getAttribute('style:text-line-through-style')) traits.add('strike');
      if (textProps.getAttribute('fo:background-color')) traits.add('highlight');
      const font = (textProps.getAttribute('fo:font-family') || '').toLowerCase();
      if (font.includes('courier') || font.includes('mono')) traits.add('code');
    }
    styleMap.set(name, traits);
  }

  const imageDataMap = new Map<string, string>();
  for (const path of zip.entries()) {
    if (!/^Pictures\//i.test(path)) continue;
    const ext = path.split('.').pop()?.toLowerCase() ?? 'png';
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
    const b64 = zip.readBase64(path);
    if (b64) imageDataMap.set(path, `data:${mime};base64,${b64}`);
  }

  const officeText = xmlDoc.getElementsByTagNameNS('*', 'text')[0];
  const blocks: string[] = [];

  if (officeText) {
    const codeLines: string[] = [];
    const flushCodeBlock = () => {
      if (codeLines.length === 0) return;
      blocks.push(`<pre><code>${codeLines.map(escapeHtml).join('\n')}</code></pre>`);
      codeLines.length = 0;
    };

    for (const child of Array.from(officeText.children)) {
      const local = child.localName;
      if (local === 'p' && child.getAttribute('text:style-name') === 'CodeBlock') {
        codeLines.push(child.textContent ?? '');
        continue;
      }
      flushCodeBlock();

      if (local === 'h') {
        const lvl = Math.min(3, Math.max(1, parseInt(child.getAttribute('text:outline-level') || '1', 10)));
        blocks.push(`<h${lvl}>${odtInlineToHtml(child, styleMap, imageDataMap)}</h${lvl}>`);
      } else if (local === 'p') {
        const stName = child.getAttribute('text:style-name') || '';
        const content = odtInlineToHtml(child, styleMap, imageDataMap);
        if (stName === 'Quote') {
          blocks.push(`<blockquote><p>${content}</p></blockquote>`);
        } else if (stName === 'HorizontalLine') {
          blocks.push('<hr />');
        } else {
          blocks.push(`<p>${content}</p>`);
        }
      } else if (local === 'list') {
        blocks.push(parseOdtList(child, styleMap, imageDataMap));
      } else if (local === 'table') {
        const rows = Array.from(child.children)
          .filter((c) => c.localName === 'table-row')
          .map((tr, rIdx) => {
            const cells = Array.from(tr.children)
              .filter((c) => c.localName === 'table-cell')
              .map((cell) => {
                const pNodes = Array.from(cell.children).filter((p) => p.localName === 'p');
                const isHeader =
                  rIdx === 0 &&
                  pNodes.some((p) => (p.getAttribute('text:style-name') || '').includes('Header'));
                const cellTag = isHeader ? 'th' : 'td';
                const inner = pNodes.map((p) => odtInlineToHtml(p, styleMap, imageDataMap)).join('<br />');
                return `<${cellTag}>${inner}</${cellTag}>`;
              })
              .join('');
            return `<tr>${cells}</tr>`;
          })
          .join('');
        blocks.push(`<table><tbody>${rows}</tbody></table>`);
      }
    }
    flushCodeBlock();
  }

  const now = Date.now();
  return {
    id: uid('doc'),
    title: filename.replace(/\.odt$/i, ''),
    html: blocks.join('\n') || '<p></p>',
    sourceFormat: 'odt',
    pageSettings: {
      pageSize: 'letter',
      margins: 'normal',
      fontFamily: 'Inter',
    },
    createdAt: now,
    updatedAt: now,
  };
}
