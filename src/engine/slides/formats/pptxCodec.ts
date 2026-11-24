import PptxGenJS from 'pptxgenjs';
import { FastZip } from '../../../utils/fastZip';
import {
  PresentationData,
  SLIDE_H,
  SLIDE_W,
  SlideAlign,
  SlideData,
  SlideElement,
} from '../../../types/slides';
import { uid } from '../../spreadsheet/workbookOps';

// Standard 16:9 widescreen slide in PowerPoint: 10 x 5.625 inches
const INCH_W = 10;
const INCH_H = 5.625;

function toInX(px: number): number {
  return Math.round((px / SLIDE_W) * INCH_W * 1000) / 1000;
}

function toInY(px: number): number {
  return Math.round((px / SLIDE_H) * INCH_H * 1000) / 1000;
}

function cleanHex(color?: string, fallback = '0F172A'): string {
  if (!color) return fallback;
  const c = color.replace('#', '').trim();
  if (c.length === 3) {
    return c
      .split('')
      .map((ch) => ch + ch)
      .join('')
      .toUpperCase();
  }
  return c.length === 6 ? c.toUpperCase() : fallback;
}

/**
 * Export a Forma Slides deck to ISO/IEC 29500 OOXML (.pptx) via PptxGenJS.
 * Opens cleanly in Microsoft PowerPoint, Apple Keynote, Google Slides, and LibreOffice Impress.
 */
export async function exportPresentationToPptx(deck: PresentationData): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.title = deck.title;
  pptx.author = 'Forma Slides';

  for (const slide of deck.slides) {
    const s = pptx.addSlide();
    s.background = { color: cleanHex(slide.backgroundColor, 'FFFFFF') };

    if (slide.notes && slide.notes.trim()) {
      s.addNotes(slide.notes);
    }

    for (const el of slide.elements) {
      const x = toInX(el.x);
      const y = toInY(el.y);
      const w = Math.max(0.1, toInX(el.width));
      const h = Math.max(0.05, toInY(el.height));

      if (el.kind === 'shape') {
        const shapeMap: Record<string, PptxGenJS.SHAPE_NAME> = {
          rect: pptx.ShapeType.rect,
          roundRect: pptx.ShapeType.roundRect,
          ellipse: pptx.ShapeType.ellipse,
          line: pptx.ShapeType.line,
        };
        const shapeType = shapeMap[el.shape ?? 'rect'] ?? pptx.ShapeType.rect;
        s.addShape(shapeType, {
          x,
          y,
          w,
          h,
          fill: el.fillColor ? { color: cleanHex(el.fillColor, 'E2E8F0') } : undefined,
          line: el.borderColor
            ? { color: cleanHex(el.borderColor, '94A3B8'), pt: el.borderWidth ?? 1 }
            : { type: 'none' },
        });
        if (el.text && el.text.trim()) {
          s.addText(el.text, {
            x,
            y,
            w,
            h,
            fontSize: Math.max(8, Math.round((el.fontSize ?? 18) * 0.75)),
            fontFace: el.fontFamily ?? 'Arial',
            bold: el.bold,
            italic: el.italic,
            color: cleanHex(el.color, '0F172A'),
            align: el.align ?? 'center',
            valign: 'middle',
          });
        }
      } else if (el.kind === 'text') {
        s.addText(el.text ?? '', {
          x,
          y,
          w,
          h,
          fontSize: Math.max(8, Math.round((el.fontSize ?? 20) * 0.75)),
          fontFace: el.fontFamily ?? 'Arial',
          bold: el.bold,
          italic: el.italic,
          underline: el.underline ? { style: 'sng' } : undefined,
          color: cleanHex(el.color, '0F172A'),
          align: el.align ?? 'left',
          valign: 'top',
          fill: el.fillColor ? { color: cleanHex(el.fillColor, 'FFFFFF') } : undefined,
          wrap: true,
        });
      } else if (el.kind === 'image' && el.src) {
        if (el.src.startsWith('data:')) {
          s.addImage({ data: el.src, x, y, w, h });
        } else {
          s.addImage({ path: el.src, x, y, w, h });
        }
      } else if (el.kind === 'table' && el.tableData && el.tableData.length > 0) {
        const colCount = Math.max(1, ...el.tableData.map((r) => r.length));
        const headerFill = cleanHex(el.fillColor, '1E293B');
        const borderCol = cleanHex(el.borderColor, 'CBD5E1');
        const textCol = cleanHex(el.color, '0F172A');
        const fontSize = Math.max(8, Math.round((el.fontSize ?? 14) * 0.75));
        const hasHeader = el.headerRow ?? true;
        const rows: PptxGenJS.TableRow[] = el.tableData.map((row, rIdx) => {
          const isHeader = hasHeader && rIdx === 0;
          const padded = Array.from({ length: colCount }, (_, cIdx) => row[cIdx] ?? '');
          return padded.map((cell) => ({
            text: cell,
            options: {
              bold: isHeader || Boolean(el.bold),
              italic: Boolean(el.italic),
              fontSize,
              fontFace: el.fontFamily ?? 'Arial',
              color: isHeader ? 'FFFFFF' : textCol,
              fill: isHeader
                ? { color: headerFill }
                : rIdx % 2 === 0
                  ? { color: 'F8FAFC' }
                  : { color: 'FFFFFF' },
              border: { pt: 1, color: borderCol },
              align: el.align ?? 'left',
              valign: 'middle' as const,
              margin: [4, 6, 4, 6] as [number, number, number, number],
            },
          }));
        });
        const colW = Array.from({ length: colCount }, () => Math.max(0.3, w / colCount));
        s.addTable(rows, {
          x,
          y,
          w,
          h,
          colW,
          border: { pt: 1, color: borderCol },
        });
      }
    }
  }

  const ab = (await pptx.write({ outputType: 'arraybuffer' })) as ArrayBuffer;
  return new Uint8Array(ab);
}

/**
 * Import an OOXML (.pptx) presentation cleanly via FastZip + XML parser.
 * Extracts slides, backgrounds, shapes, text boxes, styling, embedded images, and speaker notes.
 */
export async function importPresentationFromPptx(
  bytes: ArrayBuffer | Uint8Array,
  filename = 'Imported Presentation'
): Promise<PresentationData> {
  const zip = FastZip.load(bytes);
  const parser = new DOMParser();

  // Detect slide EMU dimensions from ppt/presentation.xml (default 16:9: 9144000 x 5143500 EMU)
  let slideEmuW = 9144000;
  let slideEmuH = 5143500;
  const parseXml = (raw: string) => parser.parseFromString(raw.replace(/^\uFEFF/, ''), 'application/xml');
  const presXml = zip.readText('ppt/presentation.xml');
  if (presXml) {
    const presDoc = parseXml(presXml);
    const sldSz = presDoc.getElementsByTagNameNS('*', 'sldSz')[0];
    if (sldSz) {
      const cx = parseInt(sldSz.getAttribute('cx') || '', 10);
      const cy = parseInt(sldSz.getAttribute('cy') || '', 10);
      if (cx > 0 && cy > 0) {
        slideEmuW = cx;
        slideEmuH = cy;
      }
    }
  }

  const presentationRels = zip.readText('ppt/_rels/presentation.xml.rels');
  const relationships = new Map<string, string>();
  if (presentationRels) {
    for (const rel of Array.from(parseXml(presentationRels).getElementsByTagNameNS('*', 'Relationship'))) {
      const target = rel.getAttribute('Target');
      if (target && rel.getAttribute('Type')?.endsWith('/slide')) {
        relationships.set(rel.getAttribute('Id') || '', new URL(target, 'https://package/ppt/presentation.xml').pathname.slice(1));
      }
    }
  }
  const slidePaths = presXml
    ? Array.from(parseXml(presXml).getElementsByTagNameNS('*', 'sldId')).map((slide) => {
        const rId =
          slide.getAttribute('r:id') ||
          slide.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ||
          '';
        const path = relationships.get(rId);
        if (!path || !zip.has(path)) throw new Error('A slide referenced by the presentation is missing');
        return path;
      })
    : [];

  // Parse theme palette (ppt/theme/theme1.xml) for <a:schemeClr> resolution
  const themeColors: Record<string, string> = {
    dk1: '#0f172a',
    lt1: '#ffffff',
    dk2: '#334155',
    lt2: '#f1f5f9',
  };
  const themeXml = zip.readText('ppt/theme/theme1.xml');
  if (themeXml) {
    const tDoc = parseXml(themeXml);
    const clrScheme = tDoc.getElementsByTagNameNS('*', 'clrScheme')[0];
    if (clrScheme) {
      for (const ch of Array.from(clrScheme.children)) {
        const srgb = ch.getElementsByTagNameNS('*', 'srgbClr')[0]?.getAttribute('val');
        const sys = ch.getElementsByTagNameNS('*', 'sysClr')[0]?.getAttribute('lastClr');
        const hex = srgb || sys;
        if (hex && /^[0-9A-Fa-f]{6}$/.test(hex)) {
          themeColors[ch.localName] = `#${hex.toLowerCase()}`;
        }
      }
    }
  }
  themeColors.tx1 = themeColors.dk1;
  themeColors.bg1 = themeColors.lt1;
  themeColors.tx2 = themeColors.dk2;
  themeColors.bg2 = themeColors.lt2;

  const resolveFillColor = (node: Element | null | undefined): string | undefined => {
    if (!node) return undefined;
    const srgb = node.getElementsByTagNameNS('*', 'srgbClr')[0]?.getAttribute('val');
    if (srgb && /^[0-9A-Fa-f]{6}$/.test(srgb)) return `#${srgb.toLowerCase()}`;
    const scheme = node.getElementsByTagNameNS('*', 'schemeClr')[0]?.getAttribute('val');
    if (scheme && themeColors[scheme]) return themeColors[scheme];
    return undefined;
  };

  const slides: SlideData[] = [];

  for (const slidePath of slidePaths) {
    const xmlStr = zip.readText(slidePath);
    if (!xmlStr) continue;
    const doc = parseXml(xmlStr);

    // Read relationships for images, layouts, & notes
    const slideFileName = slidePath.split('/').pop()!;
    const relsPath = `ppt/slides/_rels/${slideFileName}.rels`;
    const relMap = new Map<string, string>();
    const relTypes: Array<{ type: string; target: string }> = [];
    const relsStr = zip.readText(relsPath);
    if (relsStr) {
      const relsDoc = parseXml(relsStr);
      for (const rel of Array.from(relsDoc.getElementsByTagNameNS('*', 'Relationship'))) {
        const id = rel.getAttribute('Id');
        const target = rel.getAttribute('Target');
        const type = rel.getAttribute('Type') || '';
        if (id && target) relMap.set(id, target);
        if (target) relTypes.push({ type, target });
      }
    }

    const resolveRelPath = (target: string, baseFile = slidePath) =>
      new URL(target, `https://package/${baseFile}`).pathname.slice(1);

    // Background color (slide -> slideLayout -> slideMaster fallback)
    let backgroundColor =
      resolveFillColor(doc.getElementsByTagNameNS('*', 'bg')[0]) ?? '';
    if (!backgroundColor) {
      const layoutTarget = relTypes.find((r) => r.type.endsWith('/slideLayout'))?.target;
      if (layoutTarget) {
        const layoutPath = resolveRelPath(layoutTarget);
        const layoutXml = zip.readText(layoutPath);
        if (layoutXml) {
          backgroundColor =
            resolveFillColor(parseXml(layoutXml).getElementsByTagNameNS('*', 'bg')[0]) ?? '';
        }
        if (!backgroundColor) {
          const layoutRelsPath = layoutPath.replace(/([^/]+)$/, '_rels/$1.rels');
          const layoutRelsStr = zip.readText(layoutRelsPath);
          if (layoutRelsStr) {
            const masterRel = Array.from(parseXml(layoutRelsStr).getElementsByTagNameNS('*', 'Relationship'))
              .find((r) => (r.getAttribute('Type') || '').endsWith('/slideMaster'));
            const masterTarget = masterRel?.getAttribute('Target');
            if (masterTarget) {
              const masterXml = zip.readText(resolveRelPath(masterTarget, layoutPath));
              if (masterXml) {
                backgroundColor =
                  resolveFillColor(parseXml(masterXml).getElementsByTagNameNS('*', 'bg')[0]) ?? '';
              }
            }
          }
        }
      }
    }
    if (!backgroundColor) backgroundColor = '#ffffff';

    const elements: SlideElement[] = [];
    interface GroupTx {
      ox: number;
      oy: number;
      sx: number;
      sy: number;
    }

    const readRect = (xfrm: Element | undefined, tx: GroupTx, defW: number, defH: number) => {
      const off = xfrm?.getElementsByTagNameNS('*', 'off')[0];
      const ext = xfrm?.getElementsByTagNameNS('*', 'ext')[0];
      const rawX = off ? parseInt(off.getAttribute('x') || '0', 10) : (defW === 320 ? 0 : 0);
      const rawY = off ? parseInt(off.getAttribute('y') || '0', 10) : 0;
      const rawW = ext ? parseInt(ext.getAttribute('cx') || '0', 10) : 0;
      const rawH = ext ? parseInt(ext.getAttribute('cy') || '0', 10) : 0;
      const absX = tx.ox + tx.sx * rawX;
      const absY = tx.oy + tx.sy * rawY;
      const absW = rawW > 0 ? tx.sx * rawW : 0;
      const absH = rawH > 0 ? tx.sy * rawH : 0;
      return {
        x: off ? Math.round((absX / slideEmuW) * SLIDE_W) : 60,
        y: off ? Math.round((absY / slideEmuH) * SLIDE_H) : 60,
        width: absW > 0 ? Math.max(24, Math.round((absW / slideEmuW) * SLIDE_W)) : defW,
        height: absH > 0 ? Math.max(8, Math.round((absH / slideEmuH) * SLIDE_H)) : defH,
      };
    };

    const visitTree = async (container: Element, tx: GroupTx): Promise<void> => {
      for (const child of Array.from(container.children)) {
        const local = child.localName;
        if (local === 'grpSp') {
          const grpPr = Array.from(child.children).find((c) => c.localName === 'grpSpPr');
          const xfrm = grpPr?.getElementsByTagNameNS('*', 'xfrm')[0];
          const off = xfrm?.getElementsByTagNameNS('*', 'off')[0];
          const ext = xfrm?.getElementsByTagNameNS('*', 'ext')[0];
          const chOff = xfrm?.getElementsByTagNameNS('*', 'chOff')[0];
          const chExt = xfrm?.getElementsByTagNameNS('*', 'chExt')[0];
          const gX = parseInt(off?.getAttribute('x') || '0', 10);
          const gY = parseInt(off?.getAttribute('y') || '0', 10);
          const gW = parseInt(ext?.getAttribute('cx') || '1', 10) || 1;
          const gH = parseInt(ext?.getAttribute('cy') || '1', 10) || 1;
          const cX = parseInt(chOff?.getAttribute('x') || '0', 10);
          const cY = parseInt(chOff?.getAttribute('y') || '0', 10);
          const cW = parseInt(chExt?.getAttribute('cx') || String(gW), 10) || gW;
          const cH = parseInt(chExt?.getAttribute('cy') || String(gH), 10) || gH;
          const rx = gW / cW;
          const ry = gH / cH;
          await visitTree(child, {
            ox: tx.ox + tx.sx * (gX - rx * cX),
            oy: tx.oy + tx.sy * (gY - ry * cY),
            sx: tx.sx * rx,
            sy: tx.sy * ry,
          });
        } else if (local === 'sp') {
          const spPr = Array.from(child.children).find((c) => c.localName === 'spPr');
          const xfrm = spPr?.getElementsByTagNameNS('*', 'xfrm')[0] ?? child.getElementsByTagNameNS('*', 'xfrm')[0];
          const { x, y, width, height } = readRect(xfrm, tx, 320, 80);

          const pNodes = Array.from(child.getElementsByTagNameNS('*', 'p'));
          const lines = pNodes.map((p) =>
            Array.from(p.getElementsByTagNameNS('*', 't'))
              .map((t) => t.textContent ?? '')
              .join('')
          );
          const text = lines.join('\n').trim();

          const firstRPr = child.getElementsByTagNameNS('*', 'rPr')[0];
          const szHundredths = parseInt(firstRPr?.getAttribute('sz') || '0', 10);
          const fontSize = szHundredths > 0 ? Math.max(10, Math.round((szHundredths / 100) / 0.75)) : 20;
          const bold = firstRPr?.getAttribute('b') === '1';
          const italic = firstRPr?.getAttribute('i') === '1';
          const underline = Boolean(firstRPr?.getAttribute('u') && firstRPr?.getAttribute('u') !== 'none');
          const color = resolveFillColor(firstRPr?.getElementsByTagNameNS('*', 'solidFill')[0]) ?? '#0f172a';

          const firstPPr = child.getElementsByTagNameNS('*', 'pPr')[0];
          const algn = firstPPr?.getAttribute('algn');
          const align: SlideAlign = algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : 'left';

          const fillColor = resolveFillColor(
            spPr ? Array.from(spPr.children).find((c) => c.localName === 'solidFill') : undefined
          );
          const lnEl = spPr ? Array.from(spPr.children).find((c) => c.localName === 'ln') : undefined;
          const strokeColor = resolveFillColor(
            lnEl ? Array.from(lnEl.children).find((c) => c.localName === 'solidFill') : undefined
          );
          const prstGeom = spPr?.getElementsByTagNameNS('*', 'prstGeom')[0]?.getAttribute('prst');
          const shapeKind =
            prstGeom === 'line'
              ? 'line'
              : prstGeom === 'ellipse'
                ? 'ellipse'
                : prstGeom === 'roundRect'
                  ? 'roundRect'
                  : 'rect';

          if (!text && (fillColor || strokeColor || prstGeom === 'line')) {
            elements.push({
              id: uid('el'),
              kind: 'shape',
              shape: shapeKind,
              x,
              y,
              width,
              height,
              fillColor: fillColor ?? (prstGeom === 'line' ? undefined : 'transparent'),
              borderColor: strokeColor,
              ...(strokeColor ? { borderWidth: 2 } : {}),
            });
          } else if (text) {
            elements.push({
              id: uid('el'),
              kind: 'text',
              x,
              y,
              width,
              height,
              text,
              fontSize,
              bold,
              italic,
              underline,
              color,
              align,
              fillColor,
            });
          }
        } else if (local === 'pic') {
          const blip = child.getElementsByTagNameNS('*', 'blip')[0];
          const embedId =
            blip?.getAttribute('r:embed') ||
            blip?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
          if (!embedId) continue;
          const relTarget = relMap.get(embedId);
          if (!relTarget) continue;
          const resolvedPath = resolveRelPath(relTarget);
          const b64 = zip.readBase64(resolvedPath);
          if (b64 === null) continue;
          const ext = resolvedPath.split('.').pop()?.toLowerCase() || 'png';
          const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : 'image/png';
          const xfrm = child.getElementsByTagNameNS('*', 'xfrm')[0];
          const { x, y, width, height } = readRect(xfrm, tx, 320, 200);
          elements.push({
            id: uid('el'),
            kind: 'image',
            x,
            y,
            width,
            height,
            src: `data:${mime};base64,${b64}`,
          });
        } else if (local === 'graphicFrame') {
          const tbl = child.getElementsByTagNameNS('*', 'tbl')[0];
          if (!tbl) continue;
          const xfrm = child.getElementsByTagNameNS('*', 'xfrm')[0];
          const { x, y, width, height } = readRect(xfrm, tx, 480, 180);
          const tableData: string[][] = Array.from(tbl.getElementsByTagNameNS('*', 'tr'))
            .map((tr) =>
              Array.from(tr.getElementsByTagNameNS('*', 'tc')).map((tc) =>
                Array.from(tc.getElementsByTagNameNS('*', 't'))
                  .map((t) => t.textContent ?? '')
                  .join('')
                  .trim()
              )
            )
            .filter((row) => row.length > 0);
          const rowText = tableData
            .map((row) => row.join('  |  '))
            .filter(Boolean)
            .join('\n');
          if (tableData.length > 0) {
            elements.push({
              id: uid('el'),
              kind: 'table',
              x,
              y,
              width,
              height,
              tableData,
              headerRow: true,
              text: rowText,
              fontSize: 13,
              color: '#0f172a',
              align: 'left',
              fillColor: '#1e293b',
              borderColor: '#cbd5e1',
            });
          }
        }
      }
    };

    const spTree = doc.getElementsByTagNameNS('*', 'spTree')[0];
    if (spTree) {
      await visitTree(spTree, { ox: 0, oy: 0, sx: 1, sy: 1 });
    }

    // Read speaker notes if linked
    let notes = '';
    for (const target of relMap.values()) {
      if (target.includes('notesSlide')) {
        const notesPath = target.startsWith('/')
          ? target.slice(1)
          : target.startsWith('../')
            ? `ppt/${target.slice(3)}`
            : `ppt/slides/${target}`;
        const notesXml = zip.readText(notesPath);
        if (notesXml) {
          const nDoc = parseXml(notesXml);
          notes = Array.from(nDoc.getElementsByTagNameNS('*', 't'))
            .map((t) => t.textContent ?? '')
            .join(' ')
            .trim();
        }
      }
    }

    slides.push({
      id: uid('slide'),
      backgroundColor,
      elements,
      notes,
    });
  }

  const now = Date.now();
  return {
    id: uid('deck'),
    title: filename.replace(/\.pptx$/i, ''),
    themeId: 'daylight',
    slides:
      slides.length > 0
        ? slides
        : [{ id: uid('slide'), backgroundColor: '#ffffff', elements: [], notes: '' }],
    createdAt: now,
    updatedAt: now,
  };
}
