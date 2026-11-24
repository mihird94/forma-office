import JSZip from 'jszip';
import { CellData, CellStyle, NormalizedRange, SheetData, WorkbookData } from '../../../types/spreadsheet';
import { coordToAddress, parseAddress } from '../address';
import { evaluateWorkbook } from '../formulaEngine';
import { uid } from '../workbookOps';

const ODS_MIME = 'application/vnd.oasis.opendocument.spreadsheet';

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Convert Excel A1 formula (=SUM(A1:B5)) into OpenFormula (of:=SUM([.A1:.B5]))
 * per ISO/IEC 26300-2 (ODF OpenFormula) so LibreOffice Calc & Excel evaluate it natively.
 */
export function excelFormulaToOpenFormula(formula: string): string {
  if (!formula.startsWith('=')) return formula;
  const body = formula.slice(1);
  // Wrap cell/range refs in [.A1] or [.A1:.B5] skipping string literals
  const converted = body.replace(
    /"(?:[^"]|"")*"|(?:(?:'((?:[^']|'')+)'|([A-Za-z0-9_.-]+))!)?(\$?[A-Za-z]{1,3}\$?\d+)(?::(\$?[A-Za-z]{1,3}\$?\d+))?/g,
    (match, quotedSheet, plainSheet, startRef, endRef) => {
      if (match.startsWith('"')) return match;
      const sheetPrefix = quotedSheet
        ? `'${quotedSheet}'.`
        : plainSheet
          ? `${plainSheet}.`
          : '.';
      if (endRef) {
        return `[${sheetPrefix}${startRef}:.${endRef}]`;
      }
      return `[${sheetPrefix}${startRef}]`;
    }
  );
  return `of:=${converted}`;
}

/**
 * Convert OpenFormula (of:=SUM([.A1:.B5]) or =SUM([Sheet2.A1])) back into Excel A1 syntax.
 */
export function openFormulaToExcelFormula(ofFormula: string): string {
  let expr = ofFormula.trim();
  if (expr.startsWith('of:')) expr = expr.slice(3);
  if (!expr.startsWith('=')) expr = `=${expr}`;

  // Convert [Sheet.A1:.B5] or [.A1:.B5] or [.A1]
  expr = expr.replace(/\[([^\]]+)\]/g, (_, inside: string) => {
    const parts = inside.split(':');
    const parsePart = (p: string, isFirst: boolean): string => {
      const dotIdx = p.lastIndexOf('.');
      if (dotIdx === -1) return p;
      const sheetPart = p.slice(0, dotIdx);
      const cellPart = p.slice(dotIdx + 1);
      if (isFirst && sheetPart && sheetPart !== '') {
        return `${sheetPart}!${cellPart}`;
      }
      return cellPart;
    };
    if (parts.length === 2) {
      return `${parsePart(parts[0], true)}:${parsePart(parts[1], false)}`;
    }
    return parsePart(parts[0], true);
  });

  // OpenFormula uses semicolons as arg separators in some producers; normalize to commas outside strings
  let out = '';
  let inQuotes = false;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '"') inQuotes = !inQuotes;
    out += !inQuotes && ch === ';' ? ',' : ch;
  }
  return out;
}

/**
 * Export a Forma Workbook to ISO/IEC 26300 OpenDocument Spreadsheet (.ods).
 * Creates a compliant ODF ZIP package with uncompressed `mimetype`, `META-INF/manifest.xml`,
 * `styles.xml`, and `content.xml` including OpenFormula formulas & typed cached values.
 */
export async function exportWorkbookToOds(workbook: WorkbookData): Promise<Uint8Array> {
  const zip = new JSZip();
  // ODF spec requires `mimetype` stored uncompressed
  zip.file('mimetype', ODS_MIME, { compression: 'STORE' });

  const manifestXml = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="${ODS_MIME}"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
  office:version="1.2">
  <office:styles/>
</office:document-styles>`;

  const computed = evaluateWorkbook(workbook);
  const autoStyles: string[] = [];
  const styleKeyToName = new Map<string, string>();

  const registerCellStyle = (style?: CellStyle): string | null => {
    if (!style) return null;
    const sig = JSON.stringify({
      bold: Boolean(style.bold),
      italic: Boolean(style.italic),
      color: style.color || '',
      backgroundColor: style.backgroundColor || '',
      align: style.align || '',
    });
    if (sig === '{"bold":false,"italic":false,"color":"","backgroundColor":"","align":""}') return null;
    const existing = styleKeyToName.get(sig);
    if (existing) return existing;
    const name = `ce_${autoStyles.length + 1}`;
    styleKeyToName.set(sig, name);
    const cellProps: string[] = [];
    const textProps: string[] = [];
    const paraProps: string[] = [];
    if (style.backgroundColor) cellProps.push(`fo:background-color="${escapeXml(style.backgroundColor)}"`);
    if (style.bold) textProps.push('fo:font-weight="bold"');
    if (style.italic) textProps.push('fo:font-style="italic"');
    if (style.color) textProps.push(`fo:color="${escapeXml(style.color)}"`);
    if (style.align) {
      const foAlign = style.align === 'right' ? 'end' : style.align === 'center' ? 'center' : 'start';
      paraProps.push(`fo:text-align="${foAlign}"`);
    }
    const inner = [
      cellProps.length ? `<style:table-cell-properties ${cellProps.join(' ')}/>` : '',
      textProps.length ? `<style:text-properties ${textProps.join(' ')}/>` : '',
      paraProps.length ? `<style:paragraph-properties ${paraProps.join(' ')}/>` : '',
    ].join('');
    autoStyles.push(`<style:style style:name="${name}" style:family="table-cell">${inner}</style:style>`);
    return name;
  };

  const tablesXml = workbook.sheets
    .map((sheet, sIdx) => {
      const sheetComp = computed[sheet.id] ?? {};
      let maxRow = 0;
      let maxCol = 0;

      for (const addr of Object.keys(sheet.cells)) {
        const parsed = parseAddress(addr);
        if (!parsed) continue;
        if (parsed.row > maxRow) maxRow = parsed.row;
        if (parsed.col > maxCol) maxCol = parsed.col;
      }
      for (const m of sheet.merges) {
        if (m.endRow > maxRow) maxRow = m.endRow;
        if (m.endCol > maxCol) maxCol = m.endCol;
      }
      for (const colStr of Object.keys(sheet.colWidths)) {
        const c = parseInt(colStr, 10);
        if (c > maxCol) maxCol = c;
      }
      for (const rowStr of Object.keys(sheet.rowHeights)) {
        const r = parseInt(rowStr, 10);
        if (r > maxRow) maxRow = r;
      }

      const mergeOriginMap = new Map<string, NormalizedRange>();
      const coveredSet = new Set<string>();
      for (const m of sheet.merges) {
        mergeOriginMap.set(`${m.startRow}:${m.startCol}`, m);
        for (let rr = m.startRow; rr <= m.endRow; rr++) {
          for (let cc = m.startCol; cc <= m.endCol; cc++) {
            if (rr !== m.startRow || cc !== m.startCol) coveredSet.add(`${rr}:${cc}`);
          }
        }
      }

      const colsXml: string[] = [];
      for (let c = 0; c <= maxCol; c++) {
        const px = sheet.colWidths[c];
        if (px) {
          const stName = `co_${sIdx}_${c}`;
          const pt = +(px * 0.75).toFixed(2);
          autoStyles.push(`<style:style style:name="${stName}" style:family="table-column"><style:table-column-properties style:column-width="${pt}pt"/></style:style>`);
          colsXml.push(`<table:table-column table:style-name="${stName}"/>`);
        } else {
          colsXml.push('<table:table-column/>');
        }
      }

      const rowsXml: string[] = [];
      for (let r = 0; r <= maxRow; r++) {
        const rowH = sheet.rowHeights[r];
        let rowStyleAttr = '';
        if (rowH) {
          const stName = `ro_${sIdx}_${r}`;
          const pt = +(rowH * 0.75).toFixed(2);
          autoStyles.push(`<style:style style:name="${stName}" style:family="table-row"><style:table-row-properties style:row-height="${pt}pt"/></style:style>`);
          rowStyleAttr = ` table:style-name="${stName}"`;
        }

        const cellsXml: string[] = [];
        for (let c = 0; c <= maxCol; c++) {
          const key = `${r}:${c}`;
          if (coveredSet.has(key)) {
            cellsXml.push('<table:covered-table-cell/>');
            continue;
          }
          const addr = coordToAddress(r, c);
          const cell = sheet.cells[addr];
          const merge = mergeOriginMap.get(key);
          const spanAttr = merge
            ? `${merge.endCol > merge.startCol ? ` table:number-columns-spanned="${merge.endCol - merge.startCol + 1}"` : ''}${merge.endRow > merge.startRow ? ` table:number-rows-spanned="${merge.endRow - merge.startRow + 1}"` : ''}`
            : '';
          const styleName = registerCellStyle(cell?.style);
          const styleAttr = styleName ? ` table:style-name="${styleName}"` : '';

          if (!cell || cell.raw === '') {
            cellsXml.push(`<table:table-cell${styleAttr}${spanAttr}/>`);
            continue;
          }

          const evalCell = sheetComp[addr];
          const val = evalCell?.value;
          const formulaAttr = cell.raw.startsWith('=')
            ? ` table:formula="${escapeXml(excelFormulaToOpenFormula(cell.raw))}"`
            : '';

          let typeAttrs = ' office:value-type="string"';
          let displayText = evalCell?.formatted ?? cell.raw;

          if (typeof val === 'number' && Number.isFinite(val)) {
            if (cell.style?.numFmt === 'currency') {
              typeAttrs = ` office:value-type="currency" office:currency="USD" office:value="${val}"`;
            } else if (cell.style?.numFmt === 'percent') {
              typeAttrs = ` office:value-type="percentage" office:value="${val}"`;
            } else {
              typeAttrs = ` office:value-type="float" office:value="${val}"`;
            }
          } else if (typeof val === 'boolean') {
            typeAttrs = ` office:value-type="boolean" office:boolean-value="${val ? 'true' : 'false'}"`;
          }

          cellsXml.push(
            `<table:table-cell${styleAttr}${spanAttr}${formulaAttr}${typeAttrs}><text:p>${escapeXml(displayText)}</text:p></table:table-cell>`
          );
        }
        rowsXml.push(`<table:table-row${rowStyleAttr}>${cellsXml.join('')}</table:table-row>`);
      }

      const freezeMeta = (sheet.frozenRows > 0 || sheet.frozenCols > 0)
        ? `<forma:freeze xmlns:forma="urn:forma:sheet" rows="${sheet.frozenRows}" cols="${sheet.frozenCols}"/>`
        : '';
      return `<table:table table:name="${escapeXml(sheet.name)}">${freezeMeta}${colsXml.join('')}${rowsXml.join('')}</table:table>`;
    })
    .join('\n');

  const contentXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
  xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2"
  office:version="1.2">
  <office:automatic-styles>
    ${autoStyles.join('\n    ')}
  </office:automatic-styles>
  <office:body>
    <office:spreadsheet>
      ${tablesXml}
    </office:spreadsheet>
  </office:body>
</office:document-content>`;

  zip.file('META-INF/manifest.xml', manifestXml);
  zip.file('styles.xml', stylesXml);
  zip.file('content.xml', contentXml);

  return zip.generateAsync({ type: 'uint8array' });
}

/**
 * Import an ISO/IEC 26300 OpenDocument Spreadsheet (.ods) file into a Forma Workbook.
 */
export async function importWorkbookFromOds(
  bytes: ArrayBuffer | Uint8Array,
  filename = 'Imported ODS'
): Promise<WorkbookData> {
  const zip = await JSZip.loadAsync(bytes);
  const contentFile = zip.file('content.xml');
  if (!contentFile) {
    throw new Error('Invalid .ods archive: missing content.xml');
  }
  const xmlText = (await contentFile.async('string')).replace(/^\uFEFF/, '');
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');

  const parseLengthPx = (raw: string | null): number | undefined => {
    if (!raw) return undefined;
    const m = /^([\d.]+)\s*(pt|px|cm|mm|in)?$/i.exec(raw.trim());
    if (!m) return undefined;
    const val = parseFloat(m[1]);
    if (!Number.isFinite(val) || val <= 0) return undefined;
    const unit = (m[2] || 'pt').toLowerCase();
    if (unit === 'px') return Math.round(val);
    if (unit === 'pt') return Math.round(val / 0.75);
    if (unit === 'in') return Math.round(val * 96);
    if (unit === 'cm') return Math.round((val / 2.54) * 96);
    if (unit === 'mm') return Math.round((val / 25.4) * 96);
    return undefined;
  };

  const cellStyleMap = new Map<string, CellStyle>();
  const colWidthStyleMap = new Map<string, number>();
  const rowHeightStyleMap = new Map<string, number>();
  for (const st of Array.from(doc.getElementsByTagNameNS('*', 'style'))) {
    const name = st.getAttribute('style:name');
    const family = st.getAttribute('style:family');
    if (!name) continue;
    if (family === 'table-cell') {
      const cs: CellStyle = {};
      const cellProps = st.getElementsByTagNameNS('*', 'table-cell-properties')[0];
      const textProps = st.getElementsByTagNameNS('*', 'text-properties')[0];
      const paraProps = st.getElementsByTagNameNS('*', 'paragraph-properties')[0];
      const bg = cellProps?.getAttribute('fo:background-color');
      if (bg && bg !== 'transparent') cs.backgroundColor = bg;
      if (textProps?.getAttribute('fo:font-weight') === 'bold') cs.bold = true;
      if (textProps?.getAttribute('fo:font-style') === 'italic') cs.italic = true;
      const color = textProps?.getAttribute('fo:color');
      if (color) cs.color = color;
      const align = paraProps?.getAttribute('fo:text-align');
      if (align === 'end' || align === 'right') cs.align = 'right';
      else if (align === 'center') cs.align = 'center';
      else if (align === 'start' || align === 'left') cs.align = 'left';
      if (Object.keys(cs).length > 0) cellStyleMap.set(name, cs);
    } else if (family === 'table-column') {
      const px = parseLengthPx(st.getElementsByTagNameNS('*', 'table-column-properties')[0]?.getAttribute('style:column-width') ?? null);
      if (px) colWidthStyleMap.set(name, px);
    } else if (family === 'table-row') {
      const px = parseLengthPx(st.getElementsByTagNameNS('*', 'table-row-properties')[0]?.getAttribute('style:row-height') ?? null);
      if (px) rowHeightStyleMap.set(name, px);
    }
  }

  const tables = Array.from(doc.getElementsByTagNameNS('*', 'table'));
  const sheets: SheetData[] = [];

  for (const table of tables) {
    const name = table.getAttribute('table:name') || `Sheet${sheets.length + 1}`;
    const cells: Record<string, CellData> = {};
    const colWidths: Record<number, number> = {};
    const rowHeights: Record<number, number> = {};
    const merges: NormalizedRange[] = [];

    let frozenRows = 0;
    let frozenCols = 0;
    const freezeNode = Array.from(table.children).find((el) => el.localName === 'freeze');
    if (freezeNode) {
      frozenRows = Math.max(0, parseInt(freezeNode.getAttribute('rows') || '0', 10) || 0);
      frozenCols = Math.max(0, parseInt(freezeNode.getAttribute('cols') || '0', 10) || 0);
    }

    let colCursor = 0;
    for (const colEl of Array.from(table.children).filter((el) => el.localName === 'table-column')) {
      const repeat = Math.min(200, Math.max(1, parseInt(colEl.getAttribute('table:number-columns-repeated') || '1', 10) || 1));
      const px = colWidthStyleMap.get(colEl.getAttribute('table:style-name') || '');
      if (px) {
        for (let i = 0; i < repeat; i++) colWidths[colCursor + i] = px;
      }
      colCursor += repeat;
    }

    const rows = Array.from(table.children).filter((el) => el.localName === 'table-row');

    let rIdx = 0;
    let maxCol = 20;

    for (const row of rows) {
      const rowRepeat = parseInt(row.getAttribute('table:number-rows-repeated') || '1', 10);
      const rowPx = rowHeightStyleMap.get(row.getAttribute('table:style-name') || '');
      const cellNodes = Array.from(row.children).filter(
        (el) => el.localName === 'table-cell' || el.localName === 'covered-table-cell'
      );

      // Avoid exploding huge trailing empty row repeats (LibreOffice emits 1048576 empty rows)
      const hasAnyContent = cellNodes.some((c) => {
        const hasFormula = Boolean(c.getAttribute('table:formula'));
        const hasVal = Boolean(c.getAttribute('office:value'));
        const hasText = (c.textContent ?? '').trim() !== '';
        return hasFormula || hasVal || hasText;
      });
      if (!hasAnyContent && rowRepeat > 50) {
        rIdx += Math.min(rowRepeat, 5);
        continue;
      }

      const effectiveRowRepeat = Math.min(rowRepeat, 200);
      for (let rr = 0; rr < effectiveRowRepeat; rr++) {
        if (rowPx) rowHeights[rIdx] = rowPx;
        let cIdx = 0;
        for (const cNode of cellNodes) {
          const colRepeat = parseInt(cNode.getAttribute('table:number-columns-repeated') || '1', 10);
          if (cNode.localName === 'covered-table-cell') {
            cIdx += Math.max(1, colRepeat);
            continue;
          }
          const spanCols = parseInt(cNode.getAttribute('table:number-columns-spanned') || '1', 10) || 1;
          const spanRows = parseInt(cNode.getAttribute('table:number-rows-spanned') || '1', 10) || 1;
          if (spanCols > 1 || spanRows > 1) {
            merges.push({
              startRow: rIdx,
              startCol: cIdx,
              endRow: rIdx + spanRows - 1,
              endCol: cIdx + spanCols - 1,
            });
          }

          const formulaAttr = cNode.getAttribute('table:formula');
          const valueType = cNode.getAttribute('office:value-type');
          const officeValue = cNode.getAttribute('office:value');
          const boolValue = cNode.getAttribute('office:boolean-value');
          const stName = cNode.getAttribute('table:style-name') || '';
          const importedStyle = cellStyleMap.get(stName);
          const textContent = Array.from(cNode.getElementsByTagNameNS('*', 'p'))
            .map((p) => p.textContent ?? '')
            .join('\n');

          let raw = '';
          let numFmt: CellStyle | undefined;
          if (formulaAttr) {
            raw = openFormulaToExcelFormula(formulaAttr);
          } else if (valueType === 'currency' && officeValue !== null) {
            raw = officeValue;
            numFmt = { numFmt: 'currency', decimals: 2 };
          } else if (valueType === 'percentage' && officeValue !== null) {
            raw = officeValue;
            numFmt = { numFmt: 'percent', decimals: 1 };
          } else if (valueType === 'float' && officeValue !== null) {
            raw = officeValue;
          } else if (valueType === 'boolean' && boolValue !== null) {
            raw = boolValue.toUpperCase();
          } else if (textContent !== '') {
            raw = textContent;
          }
          const mergedStyle: CellStyle | undefined =
            importedStyle || numFmt ? { ...(importedStyle ?? {}), ...(numFmt ?? {}) } : undefined;

          if (raw === '' && !mergedStyle && colRepeat > 50) {
            cIdx += colRepeat;
            continue;
          }

          const effectiveColRepeat = Math.min(colRepeat, 100);
          for (let cr = 0; cr < effectiveColRepeat; cr++) {
            if (raw !== '' || mergedStyle) {
              cells[coordToAddress(rIdx, cIdx)] = { raw, ...(mergedStyle ? { style: mergedStyle } : {}) };
              if (cIdx + 1 > maxCol) maxCol = cIdx + 6;
            }
            cIdx++;
          }
        }
        rIdx++;
      }
    }

    sheets.push({
      id: uid('sheet'),
      name,
      rowCount: Math.max(60, rIdx + 20),
      colCount: Math.max(26, maxCol),
      cells,
      colWidths,
      rowHeights,
      frozenRows,
      frozenCols,
      merges,
      charts: [],
    });
  }

  if (sheets.length === 0) {
    sheets.push({
      id: uid('sheet'),
      name: 'Sheet1',
      rowCount: 60,
      colCount: 26,
      cells: {},
      colWidths: {},
      rowHeights: {},
      frozenRows: 0,
      frozenCols: 0,
      merges: [],
      charts: [],
    });
  }

  const now = Date.now();
  return {
    id: uid('wb'),
    title: filename.replace(/\.ods$/i, ''),
    sheets,
    activeSheetId: sheets[0].id,
    createdAt: now,
    updatedAt: now,
  };
}
