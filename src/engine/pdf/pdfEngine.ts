import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFRadioGroup,
  PDFTextField,
  StandardFonts,
  degrees,
  rgb,
} from 'pdf-lib';
import { PdfAnnotation, PdfRedactAnnotation } from '../../types/pdf';

export interface PdfFormFieldInfo {
  name: string;
  type: 'text' | 'checkbox' | 'dropdown' | 'radio';
  value: string | boolean;
  options?: string[];
}

type PageChange =
  | { type: 'insert' | 'duplicate' | 'delete'; index: number }
  | { type: 'move'; from: number; to: number }
  | { type: 'rotate'; index: number; deltaDeg: number };

export function remapPageAnnotations(annotations: PdfAnnotation[], change: PageChange): PdfAnnotation[] {
  return annotations.flatMap((annotation) => {
    const page = annotation.pageIndex;
    if (change.type === 'delete') {
      if (page === change.index) return [];
      return [page > change.index ? { ...annotation, pageIndex: page - 1 } : annotation];
    }
    if (change.type === 'rotate') {
      if (page !== change.index) return [annotation];
      const normDeg = ((change.deltaDeg % 360) + 360) % 360;
      const rotPt = (x: number, y: number): { x: number; y: number } => {
        if (normDeg === 90) return { x: 1 - y, y: x };
        if (normDeg === 180) return { x: 1 - x, y: 1 - y };
        if (normDeg === 270) return { x: y, y: 1 - x };
        return { x, y };
      };
      if (annotation.type === 'highlight' || annotation.type === 'redact') {
        if (normDeg === 90) {
          return [{ ...annotation, x: 1 - annotation.y - annotation.height, y: annotation.x, width: annotation.height, height: annotation.width }];
        }
        if (normDeg === 180) {
          return [{ ...annotation, x: 1 - annotation.x - annotation.width, y: 1 - annotation.y - annotation.height }];
        }
        if (normDeg === 270) {
          return [{ ...annotation, x: annotation.y, y: 1 - annotation.x - annotation.width, width: annotation.height, height: annotation.width }];
        }
        return [annotation];
      }
      if (annotation.type === 'ink') {
        return [{ ...annotation, points: annotation.points.map((pt) => rotPt(pt.x, pt.y)) }];
      }
      const p = rotPt(annotation.x, annotation.y);
      return [{ ...annotation, x: p.x, y: p.y }];
    }
    if (change.type === 'move') {
      let next = page;
      if (page === change.from) next = change.to;
      else if (change.from < change.to && page > change.from && page <= change.to) next--;
      else if (change.from > change.to && page >= change.to && page < change.from) next++;
      return [{ ...annotation, pageIndex: next }];
    }
    const moved = { ...annotation, pageIndex: page > change.index ? page + 1 : page };
    if (change.type === 'duplicate' && page === change.index) {
      return [moved, { ...annotation, id: crypto.randomUUID(), pageIndex: page + 1 }];
    }
    return [moved];
  });
}

function hexToRgbTuple(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '').trim();
  if (clean.length === 6) {
    return {
      r: parseInt(clean.slice(0, 2), 16) / 255,
      g: parseInt(clean.slice(2, 4), 16) / 255,
      b: parseInt(clean.slice(4, 6), 16) / 255,
    };
  }
  return { r: 0.9, g: 0.1, b: 0.2 };
}

/** Create a clean 1-page US Letter blank PDF (ISO 32000) */
export async function createBlankPdfBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('Untitled PDF');
  doc.setCreator('Forma PDF');
  doc.addPage([612, 792]); // US Letter (8.5 x 11 in)
  return doc.save();
}

/** Generate a polished 3-page sample PDF report for immediate inspection/annotation */
export async function createSampleReportPdfBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('Forma Office — Q4 Executive Report');
  doc.setCreator('Forma PDF');

  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontReg = await doc.embedFont(StandardFonts.Helvetica);

  // Page 1: Cover & Executive Summary
  const p1 = doc.addPage([612, 792]);
  p1.drawRectangle({ x: 0, y: 690, width: 612, height: 102, color: rgb(0.06, 0.09, 0.16) });
  p1.drawText('FORMA OFFICE', { x: 54, y: 748, size: 11, font: fontBold, color: rgb(0.96, 0.25, 0.37) });
  p1.drawText('Q4 Executive Architecture & Interoperability Report', {
    x: 54,
    y: 716,
    size: 20,
    font: fontBold,
    color: rgb(1, 1, 1),
  });

  p1.drawText('1. Executive Summary', { x: 54, y: 642, size: 15, font: fontBold, color: rgb(0.06, 0.09, 0.16) });
  const p1Lines = [
    'Forma PDF is a native, local-first PDF workspace compliant with ISO 32000.',
    'Use the toolbar above to highlight passages, type form text directly onto pages,',
    'draw freehand signatures, reorder or rotate pages, merge multiple PDFs, and',
    'export permanently annotated .pdf files with zero cloud dependency.',
  ];
  p1Lines.forEach((line, idx) => {
    p1.drawText(line, { x: 54, y: 612 - idx * 20, size: 11, font: fontReg, color: rgb(0.2, 0.25, 0.33) });
  });

  // Summary metrics box
  p1.drawRectangle({
    x: 54,
    y: 440,
    width: 504,
    height: 84,
    color: rgb(0.97, 0.98, 0.99),
    borderColor: rgb(0.82, 0.85, 0.9),
    borderWidth: 1,
  });
  p1.drawText('OPEN STANDARDS COVERAGE', { x: 72, y: 498, size: 9, font: fontBold, color: rgb(0.4, 0.45, 0.55) });
  p1.drawText('Forma Sheets: .xlsx, .ods, .csv, .tsv', { x: 72, y: 476, size: 11, font: fontBold, color: rgb(0.02, 0.47, 0.34) });
  p1.drawText('Forma Docs:   .docx, .odt, .md, .html', { x: 72, y: 458, size: 11, font: fontBold, color: rgb(0.11, 0.31, 0.85) });
  p1.drawText('Forma PDF:    .pdf (ISO 32000) — Annotate, Sign, Merge, Rotate, Extract', {
    x: 72,
    y: 446 - 4,
    size: 10.5,
    font: fontBold,
    color: rgb(0.75, 0.07, 0.24),
  });
  p1.drawText('Page 1 of 3', { x: 280, y: 36, size: 9, font: fontReg, color: rgb(0.5, 0.55, 0.62) });

  // Page 2: Financial & Operational Snapshot
  const p2 = doc.addPage([612, 792]);
  p2.drawText('2. Quarterly Performance Snapshot', { x: 54, y: 730, size: 16, font: fontBold, color: rgb(0.06, 0.09, 0.16) });
  const rows = [
    ['Quarter', 'Revenue', 'OpEx', 'Net EBITDA', 'Margin'],
    ['Q1 2026', '$287,000', '$215,920', '$71,080', '24.8%'],
    ['Q2 2026', '$325,780', '$230,767', '$95,013', '29.2%'],
    ['Q3 2026', '$374,956', '$248,169', '$126,787', '33.8%'],
    ['Q4 2026', '$440,289', '$269,340', '$170,949', '38.8%'],
    ['FY Total', '$1,428,025', '$964,196', '$463,829', '32.5%'],
  ];
  const colX = [54, 155, 255, 355, 465];
  rows.forEach((row, rIdx) => {
    const y = 682 - rIdx * 30;
    if (rIdx === 0 || rIdx === rows.length - 1) {
      p2.drawRectangle({
        x: 48,
        y: y - 8,
        width: 516,
        height: 26,
        color: rIdx === 0 ? rgb(0.06, 0.09, 0.16) : rgb(0.94, 0.99, 0.96),
      });
    }
    row.forEach((cell, cIdx) => {
      p2.drawText(cell, {
        x: colX[cIdx],
        y,
        size: 11,
        font: rIdx === 0 || rIdx === rows.length - 1 ? fontBold : fontReg,
        color: rIdx === 0 ? rgb(1, 1, 1) : rgb(0.1, 0.15, 0.22),
      });
    });
  });
  p2.drawText('Tip: Try highlighting Q4 2026 or right-clicking this page thumbnail to rotate or extract it.', {
    x: 54,
    y: 470,
    size: 10.5,
    font: fontReg,
    color: rgb(0.4, 0.45, 0.55),
  });
  p2.drawText('Page 2 of 3', { x: 280, y: 36, size: 9, font: fontReg, color: rgb(0.5, 0.55, 0.62) });

  // Page 3: Sign-off & Signature Box
  const p3 = doc.addPage([612, 792]);
  p3.drawText('3. Approval & Sign-Off', { x: 54, y: 730, size: 16, font: fontBold, color: rgb(0.06, 0.09, 0.16) });
  p3.drawText('Select the Draw / Sign tool or Add Text tool above to sign and date directly below:', {
    x: 54,
    y: 696,
    size: 11,
    font: fontReg,
    color: rgb(0.25, 0.3, 0.38),
  });
  p3.drawRectangle({
    x: 54,
    y: 540,
    width: 300,
    height: 110,
    borderColor: rgb(0.7, 0.75, 0.82),
    borderWidth: 1,
    color: rgb(0.99, 0.99, 1),
  });
  p3.drawText('Signature', { x: 64, y: 550, size: 9, font: fontReg, color: rgb(0.55, 0.6, 0.68) });
  p3.drawRectangle({
    x: 374,
    y: 540,
    width: 184,
    height: 110,
    borderColor: rgb(0.7, 0.75, 0.82),
    borderWidth: 1,
    color: rgb(0.99, 0.99, 1),
  });
  p3.drawText('Date', { x: 384, y: 550, size: 9, font: fontReg, color: rgb(0.55, 0.6, 0.68) });
  p3.drawText('Page 3 of 3', { x: 280, y: 36, size: 9, font: fontReg, color: rgb(0.5, 0.55, 0.62) });

  return doc.save();
}

export async function getPdfPageCount(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return doc.getPageCount();
}

export async function rotatePdfPage(
  bytes: Uint8Array,
  pageIndex: number,
  deltaDeg: number
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const page = doc.getPage(pageIndex);
  const current = page.getRotation().angle;
  page.setRotation(degrees((current + deltaDeg + 360) % 360));
  return doc.save();
}

export async function deletePdfPage(bytes: Uint8Array, pageIndex: number): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  if (doc.getPageCount() <= 1) return bytes;
  doc.removePage(pageIndex);
  return doc.save();
}

export async function duplicatePdfPage(bytes: Uint8Array, pageIndex: number): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const [copied] = await doc.copyPages(doc, [pageIndex]);
  doc.insertPage(pageIndex + 1, copied);
  return doc.save();
}

export async function insertBlankPdfPage(
  bytes: Uint8Array,
  afterPageIndex: number
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const refPage = doc.getPage(Math.min(afterPageIndex, doc.getPageCount() - 1));
  const { width, height } = refPage.getSize();
  doc.insertPage(afterPageIndex + 1, [width, height]);
  return doc.save();
}

export async function movePdfPage(
  bytes: Uint8Array,
  fromIndex: number,
  toIndex: number
): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const count = src.getPageCount();
  if (fromIndex < 0 || fromIndex >= count || toIndex < 0 || toIndex >= count || fromIndex === toIndex) {
    return bytes;
  }
  const order = Array.from({ length: count }, (_, i) => i);
  const [moved] = order.splice(fromIndex, 1);
  order.splice(toIndex, 0, moved);

  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, order);
  copied.forEach((p) => out.addPage(p));
  return out.save();
}

export async function extractPdfPage(bytes: Uint8Array, pageIndex: number): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const [copied] = await out.copyPages(src, [pageIndex]);
  out.addPage(copied);
  return out.save();
}

export async function mergePdfBytes(pdfList: Uint8Array[]): Promise<Uint8Array> {
  const merged = await PDFDocument.create();
  merged.setCreator('Forma PDF');
  for (const bytes of pdfList) {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const indices = src.getPageIndices();
    const pages = await merged.copyPages(src, indices);
    pages.forEach((p) => merged.addPage(p));
  }
  return merged.save();
}

function sanitizeWinAnsiText(text: string): string {
  // Replace control characters (newlines/tabs) with spaces and non-WinAnsi Unicode with '?' so StandardFonts never throws
  return text.replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\xFF]/g, '?');
}

/**
 * Bake all Forma PDF annotations (highlights, text, freehand ink/signatures, notes)
 * permanently into the PDF bytes so they render in Preview, Adobe Acrobat, Chrome, and Edge.
 */
export async function bakeAnnotationsIntoPdf(
  bytes: Uint8Array,
  annotations: PdfAnnotation[]
): Promise<Uint8Array> {
  if (annotations.length === 0) return bytes;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  for (const ann of annotations) {
    if (ann.pageIndex < 0 || ann.pageIndex >= doc.getPageCount()) continue;
    const page = doc.getPage(ann.pageIndex);
    const box = page.getCropBox() ?? page.getMediaBox();
    const x0 = box.x ?? 0;
    const y0 = box.y ?? 0;
    const width = box.width;
    const height = box.height;
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    const c = hexToRgbTuple(ann.color ?? '#000000');

    // Map normalized visual top-left (vx, vy) in [0..1] into unrotated PDF page coordinates
    const toPdfPt = (vx: number, vy: number): { x: number; y: number } => {
      if (rot === 90) {
        return { x: x0 + vy * width, y: y0 + vx * height };
      }
      if (rot === 180) {
        return { x: x0 + (1 - vx) * width, y: y0 + vy * height };
      }
      if (rot === 270) {
        return { x: x0 + (1 - vy) * width, y: y0 + (1 - vx) * height };
      }
      return { x: x0 + vx * width, y: y0 + (1 - vy) * height };
    };

    if (ann.type === 'highlight') {
      const p1 = toPdfPt(ann.x, ann.y);
      const p2 = toPdfPt(ann.x + ann.width, ann.y + ann.height);
      const rx = Math.min(p1.x, p2.x);
      const ry = Math.min(p1.y, p2.y);
      const rw = Math.abs(p2.x - p1.x);
      const rh = Math.abs(p2.y - p1.y);
      page.drawRectangle({
        x: rx,
        y: ry,
        width: rw,
        height: rh,
        color: rgb(c.r, c.g, c.b),
        opacity: 0.35,
      });
    } else if (ann.type === 'redact') {
      const p1 = toPdfPt(ann.x, ann.y);
      const p2 = toPdfPt(ann.x + ann.width, ann.y + ann.height);
      const rx = Math.min(p1.x, p2.x);
      const ry = Math.min(p1.y, p2.y);
      const rw = Math.abs(p2.x - p1.x);
      const rh = Math.abs(p2.y - p1.y);
      page.drawRectangle({
        x: rx,
        y: ry,
        width: rw,
        height: rh,
        color: rgb(0, 0, 0),
        opacity: 1,
      });
    } else if (ann.type === 'text') {
      const pt = toPdfPt(ann.x, ann.y);
      const safeText = sanitizeWinAnsiText(ann.text);
      if (!safeText) continue;
      page.drawText(safeText, {
        x: pt.x,
        y: rot === 0 ? pt.y - ann.fontSize : pt.y,
        size: ann.fontSize,
        font,
        color: rgb(c.r, c.g, c.b),
        rotate: degrees(rot),
      });
    } else if (ann.type === 'ink' && ann.points.length >= 2) {
      for (let i = 1; i < ann.points.length; i++) {
        const p0 = toPdfPt(ann.points[i - 1].x, ann.points[i - 1].y);
        const p1 = toPdfPt(ann.points[i].x, ann.points[i].y);
        page.drawLine({
          start: p0,
          end: p1,
          thickness: ann.strokeWidth,
          color: rgb(c.r, c.g, c.b),
          opacity: 0.95,
        });
      }
    } else if (ann.type === 'note') {
      const pt = toPdfPt(ann.x, ann.y);
      const safeNote = sanitizeWinAnsiText(ann.text);
      const nx = pt.x;
      const ny = pt.y;
      page.drawRectangle({
        x: nx,
        y: ny - 24,
        width: Math.min(260, Math.max(90, safeNote.length * 5.8 + 16)),
        height: 24,
        color: rgb(1, 0.96, 0.72),
        borderColor: rgb(0.85, 0.65, 0.1),
        borderWidth: 0.8,
      });
      page.drawText(safeNote.slice(0, 52), {
        x: nx + 6,
        y: ny - 16,
        size: 9,
        font: fontBold,
        color: rgb(0.25, 0.18, 0.02),
      });
    }
  }

  return doc.save();
}

/**
 * Inspect all interactive AcroForm fields (text, checkbox, dropdown, radio) in a PDF.
 */
export async function readPdfFormFields(bytes: Uint8Array): Promise<PdfFormFieldInfo[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  let form;
  try {
    form = doc.getForm();
  } catch {
    return [];
  }
  const fields = form.getFields();
  const result: PdfFormFieldInfo[] = [];

  for (const field of fields) {
    const name = field.getName();
    if (field instanceof PDFTextField) {
      result.push({
        name,
        type: 'text',
        value: field.getText() ?? '',
      });
    } else if (field instanceof PDFCheckBox) {
      result.push({
        name,
        type: 'checkbox',
        value: field.isChecked(),
      });
    } else if (field instanceof PDFDropdown) {
      const selected = field.getSelected();
      result.push({
        name,
        type: 'dropdown',
        value: selected[0] ?? '',
        options: field.getOptions(),
      });
    } else if (field instanceof PDFRadioGroup) {
      result.push({
        name,
        type: 'radio',
        value: field.getSelected() ?? '',
        options: field.getOptions(),
      });
    }
  }

  return result;
}

/**
 * Write updated values into AcroForm fields (text, checkbox, dropdown, radio) and return updated PDF bytes.
 */
export async function fillPdfFormFields(
  bytes: Uint8Array,
  values: Record<string, string | boolean>
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = doc.getForm();

  for (const field of form.getFields()) {
    const name = field.getName();
    if (!(name in values)) continue;
    const val = values[name];
    if (field instanceof PDFTextField) {
      field.setText(typeof val === 'string' ? val : String(val ?? ''));
    } else if (field instanceof PDFCheckBox) {
      if (Boolean(val)) field.check();
      else field.uncheck();
    } else if (field instanceof PDFDropdown) {
      if (typeof val === 'string' && val.length > 0) field.select(val);
      else field.clear();
    } else if (field instanceof PDFRadioGroup) {
      if (typeof val === 'string' && val.length > 0) field.select(val);
      else field.clear();
    }
  }

  return doc.save();
}

/**
 * Permanently apply redactions to a PDF.
 * When `rasterizedPages` is provided (from browser/WebKit HiDPI canvas rasterization with opaque black
 * redaction boxes painted over the rendered page), each redacted page is replaced with a clean flattened
 * image page — stripping all underlying selectable/copyable text streams underneath the redacted regions.
 * In headless/Node environments without canvas rasterization, falls back to opaque black pdf-lib overlays.
 */
export async function applyRedactionsToPdf(
  bytes: Uint8Array,
  redactions: PdfRedactAnnotation[],
  rasterizedPages?: Map<number, { pngBytes: Uint8Array; width: number; height: number }>
): Promise<Uint8Array> {
  if (redactions.length === 0) return bytes;

  if (rasterizedPages && rasterizedPages.size > 0) {
    const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const outDoc = await PDFDocument.create();
    const total = srcDoc.getPageCount();
    const fallbackRedactions: PdfRedactAnnotation[] = [];

    for (let i = 0; i < total; i++) {
      const flat = rasterizedPages.get(i);
      if (flat) {
        const png = await outDoc.embedPng(flat.pngBytes);
        const page = outDoc.addPage([flat.width, flat.height]);
        page.drawImage(png, { x: 0, y: 0, width: flat.width, height: flat.height });
      } else {
        const [copied] = await outDoc.copyPages(srcDoc, [i]);
        outDoc.addPage(copied);
        for (const r of redactions) {
          if (r.pageIndex === i) fallbackRedactions.push(r);
        }
      }
    }

    const intermediate = await outDoc.save();
    return fallbackRedactions.length > 0
      ? bakeAnnotationsIntoPdf(intermediate, fallbackRedactions)
      : intermediate;
  }

  return bakeAnnotationsIntoPdf(bytes, redactions);
}
