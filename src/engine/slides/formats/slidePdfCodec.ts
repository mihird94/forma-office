import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { PresentationData, SLIDE_H, SLIDE_W } from '../../../types/slides';

function hexToRgb(hex?: string, fallback = { r: 0.06, g: 0.09, b: 0.16 }) {
  if (!hex) return fallback;
  const c = hex.replace('#', '').trim();
  if (c.length === 6) {
    return {
      r: parseInt(c.slice(0, 2), 16) / 255,
      g: parseInt(c.slice(2, 4), 16) / 255,
      b: parseInt(c.slice(4, 6), 16) / 255,
    };
  }
  return fallback;
}

/** Export a 16:9 widescreen Presentation Deck as a crisp vector ISO 32000 PDF */
export async function exportPresentationToPdf(deck: PresentationData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(deck.title);
  doc.setCreator('Forma Slides');

  const fontReg = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  // 16:9 widescreen PDF points (960 x 540 logical -> 960 x 540 pt)
  for (const slide of deck.slides) {
    const page = doc.addPage([SLIDE_W, SLIDE_H]);
    const bg = hexToRgb(slide.backgroundColor, { r: 1, g: 1, b: 1 });
    page.drawRectangle({ x: 0, y: 0, width: SLIDE_W, height: SLIDE_H, color: rgb(bg.r, bg.g, bg.b) });

    for (const el of slide.elements) {
      const pdfY = SLIDE_H - el.y - el.height;

      if (el.kind === 'shape') {
        const fill = hexToRgb(el.fillColor, { r: 0.88, g: 0.91, b: 0.94 });
        if (el.shape === 'ellipse') {
          page.drawEllipse({
            x: el.x + el.width / 2,
            y: pdfY + el.height / 2,
            xScale: el.width / 2,
            yScale: el.height / 2,
            color: rgb(fill.r, fill.g, fill.b),
          });
        } else {
          page.drawRectangle({
            x: el.x,
            y: pdfY,
            width: el.width,
            height: el.height,
            color: rgb(fill.r, fill.g, fill.b),
          });
        }
      } else if (el.kind === 'text' && el.text) {
        const font = el.bold ? fontBold : fontReg;
        const size = Math.max(8, (el.fontSize ?? 20) * 0.88);
        const col = hexToRgb(el.color);
        const lines = el.text.split('\n');
        let cursorY = SLIDE_H - el.y - size * 1.15;

        for (const rawLine of lines) {
          // Simple word wrap within el.width
          const words = rawLine.split(' ');
          let current = '';
          const wrapped: string[] = [];
          for (const w of words) {
            const candidate = current ? `${current} ${w}` : w;
            // Strip non-WinAnsi glyphs safely for StandardFonts
            const safe = candidate.replace(/[^\x20-\xFF]/g, '-');
            if (font.widthOfTextAtSize(safe, size) > el.width && current) {
              wrapped.push(current.replace(/[^\x20-\xFF]/g, '-'));
              current = w;
            } else {
              current = candidate;
            }
          }
          wrapped.push(current.replace(/[^\x20-\xFF]/g, '-'));

          for (const line of wrapped) {
            if (cursorY < pdfY - size) break;
            const textW = font.widthOfTextAtSize(line, size);
            let drawX = el.x;
            if (el.align === 'center') drawX = el.x + Math.max(0, (el.width - textW) / 2);
            else if (el.align === 'right') drawX = el.x + Math.max(0, el.width - textW);
            page.drawText(line, {
              x: drawX,
              y: cursorY,
              size,
              font,
              color: rgb(col.r, col.g, col.b),
            });
            cursorY -= size * 1.35;
          }
        }
      } else if (el.kind === 'table' && el.tableData && el.tableData.length > 0) {
        const rowCount = el.tableData.length;
        const colCount = Math.max(1, ...el.tableData.map((r) => r.length));
        const cellW = el.width / colCount;
        const cellH = el.height / rowCount;
        const hasHeader = el.headerRow ?? true;
        const headerFill = hexToRgb(el.fillColor, { r: 0.12, g: 0.16, b: 0.23 });
        const borderCol = hexToRgb(el.borderColor, { r: 0.8, g: 0.84, b: 0.88 });
        const textCol = hexToRgb(el.color, { r: 0.06, g: 0.09, b: 0.16 });
        const size = Math.max(8, Math.min(cellH * 0.48, (el.fontSize ?? 14) * 0.84));

        for (let rIdx = 0; rIdx < rowCount; rIdx++) {
          const row = el.tableData[rIdx] ?? [];
          const isHeader = hasHeader && rIdx === 0;
          const rowBg = isHeader
            ? headerFill
            : rIdx % 2 === 0
              ? { r: 0.97, g: 0.98, b: 0.99 }
              : { r: 1, g: 1, b: 1 };
          const cy = SLIDE_H - el.y - (rIdx + 1) * cellH;
          for (let cIdx = 0; cIdx < colCount; cIdx++) {
            const cx = el.x + cIdx * cellW;
            page.drawRectangle({
              x: cx,
              y: cy,
              width: cellW,
              height: cellH,
              color: rgb(rowBg.r, rowBg.g, rowBg.b),
              borderColor: rgb(borderCol.r, borderCol.g, borderCol.b),
              borderWidth: 0.9,
            });
            const rawVal = (row[cIdx] ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\xFF]/g, '-');
            if (!rawVal) continue;
            const font = isHeader || el.bold ? fontBold : fontReg;
            const maxTextW = Math.max(8, cellW - 10);
            let display = rawVal;
            while (display.length > 1 && font.widthOfTextAtSize(display, size) > maxTextW) {
              display = display.slice(0, -1);
            }
            const textW = font.widthOfTextAtSize(display, size);
            let drawX = cx + 5;
            if (el.align === 'center') drawX = cx + Math.max(4, (cellW - textW) / 2);
            else if (el.align === 'right') drawX = cx + Math.max(4, cellW - textW - 5);
            const drawY = cy + Math.max(2, (cellH - size) / 2 + size * 0.15);
            const col = isHeader ? { r: 1, g: 1, b: 1 } : textCol;
            page.drawText(display, {
              x: drawX,
              y: drawY,
              size,
              font,
              color: rgb(col.r, col.g, col.b),
            });
          }
        }
      } else if (el.kind === 'image' && el.src) {
        try {
          const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(el.src);
          if (m) {
            const fmt = m[1].toLowerCase();
            const b64 = m[2];
            const bin = atob(b64);
            const imgBytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) imgBytes[i] = bin.charCodeAt(i);
            const embedded =
              fmt === 'png' ? await doc.embedPng(imgBytes) : await doc.embedJpg(imgBytes);
            page.drawImage(embedded, {
              x: el.x,
              y: pdfY,
              width: el.width,
              height: el.height,
            });
          }
        } catch {
          // skip invalid image data
        }
      }
    }
  }

  return doc.save();
}
