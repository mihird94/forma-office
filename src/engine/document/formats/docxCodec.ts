import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
} from 'docx';
import mammoth from 'mammoth';
import { FormaDocument } from '../../../types/document';
import { uid } from '../../spreadsheet/workbookOps';
import { readDocxLayout } from './docxLayout';

interface RunFormatting {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  sub?: boolean;
  sup?: boolean;
  color?: string;
  highlight?: string;
  href?: string;
}

function cssColorToHex(color?: string): string | undefined {
  if (!color) return undefined;
  const trimmed = color.trim();
  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    if (hex.length === 3) {
      return hex
        .split('')
        .map((c) => c + c)
        .join('')
        .toUpperCase();
    }
    if (hex.length === 6) return hex.toUpperCase();
  }
  const rgbMatch = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(trimmed);
  if (rgbMatch) {
    const toHex = (n: string) => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0');
    return `${toHex(rgbMatch[1])}${toHex(rgbMatch[2])}${toHex(rgbMatch[3])}`.toUpperCase();
  }
  return undefined;
}

function mapAlignment(el: Element): (typeof AlignmentType)[keyof typeof AlignmentType] | undefined {
  const align = (el as HTMLElement).style?.textAlign || el.getAttribute('align') || '';
  switch (align.toLowerCase()) {
    case 'center':
      return AlignmentType.CENTER;
    case 'right':
      return AlignmentType.RIGHT;
    case 'justify':
      return AlignmentType.JUSTIFIED;
    case 'left':
      return AlignmentType.LEFT;
    default:
      return undefined;
  }
}

type ParagraphChild = TextRun | ExternalHyperlink | ImageRun;

function parseImageDataUri(src: string): {
  type: 'png' | 'jpg' | 'gif';
  data: Uint8Array;
  width: number;
  height: number;
} | null {
  const m = /^data:image\/(png|jpeg|jpg|gif);base64,([A-Za-z0-9+/=\s]+)$/i.exec(src.trim());
  if (!m) return null;
  const rawExt = m[1].toLowerCase();
  const type = rawExt === 'jpeg' || rawExt === 'jpg' ? 'jpg' : rawExt === 'gif' ? 'gif' : 'png';
  const bin = atob(m[2].replace(/\s+/g, ''));
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  let width = 360;
  let height = 240;
  if (type === 'png' && data.length >= 24 && data[0] === 0x89 && data[1] === 0x50) {
    const pw = ((data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19]) >>> 0;
    const ph = ((data[20] << 24) | (data[21] << 16) | (data[22] << 8) | data[23]) >>> 0;
    if (pw > 0 && ph > 0) {
      const scale = Math.min(1, 480 / pw);
      width = Math.max(24, Math.round(pw * scale));
      height = Math.max(24, Math.round(ph * scale));
    }
  }
  return { type, data, width, height };
}

function collectInlineRuns(
  node: Node,
  fmt: RunFormatting = {}
): ParagraphChild[] {
  const runs: ParagraphChild[] = [];

  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? '';
    if (text === '') return runs;
    const run = new TextRun({
      text,
      bold: fmt.bold,
      italics: fmt.italic,
      strike: fmt.strike,
      underline: fmt.underline ? { type: UnderlineType.SINGLE } : undefined,
      subScript: fmt.sub,
      superScript: fmt.sup,
      font: fmt.code ? 'Courier New' : undefined,
      color: fmt.href ? '2563EB' : fmt.color,
      shading: fmt.code
        ? { type: ShadingType.CLEAR, color: 'auto', fill: 'F1F5F9' }
        : fmt.highlight
          ? { type: ShadingType.CLEAR, color: 'auto', fill: fmt.highlight }
          : undefined,
    });
    if (fmt.href) {
      runs.push(
        new ExternalHyperlink({
          link: fmt.href,
          children: [run],
        })
      );
    } else {
      runs.push(run);
    }
    return runs;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return runs;
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();

  if (tag === 'img') {
    const parsed = parseImageDataUri(el.getAttribute('src') || '');
    if (parsed) {
      runs.push(
        new ImageRun({
          type: parsed.type,
          data: parsed.data,
          transformation: { width: parsed.width, height: parsed.height },
        })
      );
    }
    return runs;
  }

  if (tag === 'br') {
    runs.push(el.classList.contains('page-break') ? new PageBreak() : new TextRun({ break: 1 }));
    return runs;
  }

  const nextFmt: RunFormatting = { ...fmt };
  if (tag === 'strong' || tag === 'b') nextFmt.bold = true;
  if (tag === 'em' || tag === 'i') nextFmt.italic = true;
  if (tag === 'u') nextFmt.underline = true;
  if (tag === 's' || tag === 'del' || tag === 'strike') nextFmt.strike = true;
  if (tag === 'code') nextFmt.code = true;
  if (tag === 'sub') nextFmt.sub = true;
  if (tag === 'sup') nextFmt.sup = true;
  if (tag === 'mark') {
    nextFmt.highlight = cssColorToHex(el.style?.backgroundColor) ?? 'FEF08A';
  }
  if (tag === 'a') {
    const href = el.getAttribute('href');
    if (href) {
      nextFmt.href = href;
      nextFmt.underline = true;
    }
  }
  if (el.style?.color) {
    const hex = cssColorToHex(el.style.color);
    if (hex) nextFmt.color = hex;
  }
  if (el.style?.backgroundColor && tag !== 'mark') {
    const hex = cssColorToHex(el.style.backgroundColor);
    if (hex) nextFmt.highlight = hex;
  }

  for (const child of Array.from(el.childNodes)) {
    runs.push(...collectInlineRuns(child, nextFmt));
  }
  return runs;
}

function collectListItemRuns(li: Element): ParagraphChild[] {
  const runs: ParagraphChild[] = [];
  for (const child of Array.from(li.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const cTag = (child as Element).tagName.toLowerCase();
      if (cTag === 'ul' || cTag === 'ol') continue;
    }
    runs.push(...collectInlineRuns(child));
  }
  return runs;
}

function convertListElement(el: Element, level = 0): Paragraph[] {
  const tag = el.tagName.toLowerCase();
  const isTaskList = el.getAttribute('data-type') === 'taskList';
  const items: Paragraph[] = [];
  const liNodes = Array.from(el.children).filter((c) => c.tagName.toLowerCase() === 'li');
  const clampedLevel = Math.min(5, level);

  for (const li of liNodes) {
    if (isTaskList) {
      const checked = li.getAttribute('data-checked') === 'true';
      const prefix = checked ? '☑ ' : '☐ ';
      const textContainer = li.querySelector(':scope > div') ?? li;
      items.push(
        new Paragraph({
          indent: { left: 360 * (clampedLevel + 1) },
          spacing: { after: 80 },
          children: [new TextRun({ text: prefix, bold: true }), ...collectListItemRuns(textContainer)],
        })
      );
    } else if (tag === 'ul') {
      items.push(
        new Paragraph({
          bullet: { level: clampedLevel },
          spacing: { after: 80 },
          children: collectListItemRuns(li),
        })
      );
    } else {
      items.push(
        new Paragraph({
          numbering: { reference: 'forma-ol', level: clampedLevel },
          spacing: { after: 80 },
          children: collectListItemRuns(li),
        })
      );
    }
    for (const child of Array.from(li.children)) {
      const cTag = child.tagName.toLowerCase();
      if (cTag === 'ul' || cTag === 'ol') {
        items.push(...convertListElement(child, level + 1));
      }
    }
  }
  return items;
}

function convertBlockElement(el: Element): Array<Paragraph | Table> {
  const tag = el.tagName.toLowerCase();
  const alignment = mapAlignment(el);

  if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
    const headingMap = {
      h1: HeadingLevel.HEADING_1,
      h2: HeadingLevel.HEADING_2,
      h3: HeadingLevel.HEADING_3,
      h4: HeadingLevel.HEADING_4,
      h5: HeadingLevel.HEADING_5,
      h6: HeadingLevel.HEADING_6,
    };
    return [
      new Paragraph({
        heading: headingMap[tag],
        alignment,
        spacing: { before: 240, after: 120 },
        children: collectInlineRuns(el),
      }),
    ];
  }

  if (tag === 'img') {
    const children = collectInlineRuns(el);
    return children.length > 0 ? [new Paragraph({ alignment, spacing: { after: 140 }, children })] : [];
  }

  if (tag === 'p') {
    const children = collectInlineRuns(el);
    return [
      new Paragraph({
        alignment,
        spacing: { after: 140 },
        children: children.length > 0 ? children : [new TextRun('')],
      }),
    ];
  }

  if (tag === 'hr') {
    if (el.classList.contains('page-break')) {
      return [new Paragraph({ children: [new PageBreak()] })];
    }
    return [
      new Paragraph({
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CBD5E1', space: 1 },
        },
        spacing: { before: 160, after: 160 },
        children: [],
      }),
    ];
  }

  if (tag === 'blockquote') {
    const innerParagraphs: Paragraph[] = [];
    const childEls = Array.from(el.children);
    if (childEls.length === 0) {
      innerParagraphs.push(
        new Paragraph({
          indent: { left: 480 },
          border: {
            left: { style: BorderStyle.SINGLE, size: 18, color: '2563EB', space: 12 },
          },
          shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F8FAFC' },
          spacing: { before: 120, after: 120 },
          children: collectInlineRuns(el, { italic: true, color: '334155' }),
        })
      );
    } else {
      for (const child of childEls) {
        innerParagraphs.push(
          new Paragraph({
            indent: { left: 480 },
            border: {
              left: { style: BorderStyle.SINGLE, size: 18, color: '2563EB', space: 12 },
            },
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F8FAFC' },
            spacing: { before: 80, after: 80 },
            children: collectInlineRuns(child, { italic: true, color: '334155' }),
          })
        );
      }
    }
    return innerParagraphs;
  }

  if (tag === 'pre') {
    const codeText = el.textContent ?? '';
    const lines = codeText.split('\n');
    return lines.map(
      (line) =>
        new Paragraph({
          shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F1F5F9' },
          spacing: { before: 20, after: 20 },
          indent: { left: 240, right: 240 },
          children: [
            new TextRun({
              text: line || ' ',
              font: 'Courier New',
              size: 19,
              color: '0F172A',
            }),
          ],
        })
    );
  }

  if (tag === 'ul' || tag === 'ol') {
    return convertListElement(el, 0);
  }

  if (tag === 'table') {
    const trNodes = Array.from(el.querySelectorAll('tr'));
    const rows = trNodes.map((tr) => {
      const cellNodes = Array.from(tr.children).filter(
        (c) => c.tagName.toLowerCase() === 'td' || c.tagName.toLowerCase() === 'th'
      );
      return new TableRow({
        children: cellNodes.map((cellEl) => {
          const isHeader = cellEl.tagName.toLowerCase() === 'th';
          const blockChildren = Array.from(cellEl.children).filter((ch) =>
            ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'pre', 'blockquote'].includes(
              ch.tagName.toLowerCase()
            )
          );
          const cellParagraphs: Paragraph[] = blockChildren.length
            ? blockChildren.flatMap((ch) => {
                const cTag = ch.tagName.toLowerCase();
                if (cTag === 'ul' || cTag === 'ol') return convertListElement(ch, 0);
                return [new Paragraph({ children: collectInlineRuns(ch, isHeader ? { bold: true } : {}) })];
              })
            : [new Paragraph({ children: collectInlineRuns(cellEl, isHeader ? { bold: true } : {}) })];
          return new TableCell({
            shading: isHeader
              ? { type: ShadingType.CLEAR, color: 'auto', fill: 'F1F5F9' }
              : undefined,
            margins: { top: 80, bottom: 80, left: 120, right: 120 },
            children: cellParagraphs,
          });
        }),
      });
    });

    if (rows.length === 0) return [];
    return [
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows,
      }),
    ];
  }

  // Fallback container traversal
  const nested: Array<Paragraph | Table> = [];
  for (const child of Array.from(el.children)) {
    nested.push(...convertBlockElement(child));
  }
  if (nested.length === 0 && (el.textContent ?? '').trim() !== '') {
    nested.push(new Paragraph({ children: collectInlineRuns(el) }));
  }
  return nested;
}

/**
 * Export a Forma Document to ISO/IEC 29500 OOXML (.docx).
 */
export async function exportDocumentToDocx(doc: FormaDocument): Promise<Uint8Array> {
  const parser = new DOMParser();
  const parsed = parser.parseFromString(doc.html || '<p></p>', 'text/html');
  const children: Array<Paragraph | Table> = [];

  for (const child of Array.from(parsed.body.children)) {
    children.push(...convertBlockElement(child));
  }

  if (children.length === 0) {
    children.push(new Paragraph({ children: [new TextRun('')] }));
  }

  const marginTwips =
    doc.pageSettings.margins === 'narrow'
      ? 720
      : doc.pageSettings.margins === 'wide'
        ? 1800
        : 1440;

  const headerText = doc.pageSettings.headerText?.trim();
  const footerText = doc.pageSettings.footerText?.trim();
  const showPageNumbers = Boolean(doc.pageSettings.showPageNumbers);
  const pageTextRun = (text: string) => new TextRun({ text, size: 18, color: '64748B' });

  const headers = headerText
    ? {
        default: new Header({
          children: headerText.split(/\r?\n/).map((line) =>
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [pageTextRun(line)],
            })
          ),
        }),
      }
    : undefined;

  const footerRuns: TextRun[] = [];
  const footerLines = footerText?.split(/\r?\n/) ?? [];
  const lastFooterLine = footerLines.pop();
  if (lastFooterLine) {
    footerRuns.push(pageTextRun(showPageNumbers ? `${lastFooterLine}  ·  ` : lastFooterLine));
  }
  if (showPageNumbers) {
    footerRuns.push(
      new TextRun({
        children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES],
        size: 18,
        color: '64748B',
      })
    );
  }

  const footers =
    footerRuns.length > 0
      ? {
          default: new Footer({
            children: [
              ...footerLines.map((line) => new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [pageTextRun(line)],
              })),
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: footerRuns,
              }),
            ],
          }),
        }
      : undefined;

  const docxDoc = new Document({
    creator: 'Forma Office',
    title: doc.title,
    numbering: {
      config: [
        {
          reference: 'forma-ol',
          levels: Array.from({ length: 6 }, (_, level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: {
              paragraph: {
                indent: { left: 360 * (level + 1), hanging: 240 },
              },
            },
          })),
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: marginTwips,
              right: marginTwips,
              bottom: marginTwips,
              left: marginTwips,
            },
          },
        },
        ...(headers ? { headers } : {}),
        ...(footers ? { footers } : {}),
        children,
      },
    ],
  });

  const ab = await Packer.toArrayBuffer(docxDoc);
  return new Uint8Array(ab);
}

/**
 * Import an OOXML (.docx) file into a Forma Document via Mammoth.
 */
export async function importDocumentFromDocx(
  bytes: ArrayBuffer | Uint8Array,
  filename = 'Imported Document'
): Promise<FormaDocument> {
  const originalBytes: ArrayBuffer =
    bytes instanceof Uint8Array
      ? (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
      : bytes;
  const { bytes: arrayBuffer, pageText } = await readDocxLayout(originalBytes);

  // Provide both `arrayBuffer` (mammoth browser/unzip.js) and `buffer` (mammoth lib/unzip.js)
  // so .docx decoding works identically in WKWebView, browsers, and Node/Vitest.
  const input = {
    arrayBuffer,
    buffer: new Uint8Array(arrayBuffer),
  };
  const result = await mammoth.convertToHtml(
    input as unknown as { arrayBuffer: ArrayBuffer },
    {
      styleMap: [
        "p[style-name='Code'] => pre:separator('\\n')",
        "p[style-name='CodeBlock'] => pre:separator('\\n')",
        "br[type='page'] => br.page-break",
      ],
    }
  );
  const now = Date.now();
  return {
    id: uid('doc'),
    title: filename.replace(/\.docx$/i, ''),
    html: result.value || '<p></p>',
    sourceFormat: 'docx',
    pageSettings: {
      pageSize: 'letter',
      margins: 'normal',
      fontFamily: 'Inter',
      ...pageText,
    },
    createdAt: now,
    updatedAt: now,
  };
}
