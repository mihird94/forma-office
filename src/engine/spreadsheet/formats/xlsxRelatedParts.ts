import JSZip from 'jszip';
import { ChartSpec, ComputedCell, SheetData, WorkbookData } from '../../../types/spreadsheet';
import { coordToAddress, parseAddress, parseRange } from '../address';
import { uid } from '../workbookOps';

const chartNS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const drawingNS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const relationNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageNS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const xml = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colors = ['059669', '2563EB', 'D97706', '7C3AED', 'E11D48', '0891B2'];

function chartXml(chart: ChartSpec, sheet: SheetData, computed: Record<string, ComputedCell>): string {
  const range = parseRange(chart.dataRange);
  if (!range) throw new Error(`Invalid chart range ${chart.dataRange}`);
  const { start, end } = range;
  const sheetPrefix = `'${sheet.name.replace(/'/g, "''")}'!`;
  const address = (row: number, col: number) => coordToAddress(row, col).replace(/([A-Z]+)(\d+)/, '$$$1$$$2');
  const formula = (row: number, first: number, last: number) => xml(sheetPrefix + address(row, first) + ':' + address(row, last));
  const colRangeFormula = (rowA: number, rowB: number, col: number) => xml(sheetPrefix + address(rowA, col) + ':' + address(rowB, col));
  const points = (items: unknown[]) => items.map((value, i) => `<c:pt idx="${i}"><c:v>${xml(value)}</c:v></c:pt>`).join('');
  const series: string[] = [];

  if (start.col === end.col) {
    const firstVal = computed[coordToAddress(start.row, start.col)]?.value;
    const hasHeader = end.row > start.row && typeof firstVal !== 'number';
    const dataStartRow = hasHeader ? start.row + 1 : start.row;
    const seriesName = hasHeader ? (computed[coordToAddress(start.row, start.col)]?.formatted || chart.title) : chart.title;
    const count = Math.max(1, end.row - dataStartRow + 1);
    const categories = Array.from({ length: count }, (_, i) => `Row ${dataStartRow + i + 1}`);
    const values = Array.from({ length: count }, (_, i) => {
      const value = computed[coordToAddress(dataStartRow + i, start.col)]?.value;
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    });
    series.push(`<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>${xml(sheetPrefix + address(start.row, start.col))}</c:f><c:strCache><c:ptCount val="1"/>${points([seriesName])}</c:strCache></c:strRef></c:tx><c:spPr><a:solidFill><a:srgbClr val="${colors[0]}"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="${colors[0]}"/></a:solidFill></a:ln></c:spPr><c:cat><c:strLit><c:ptCount val="${count}"/>${points(categories)}</c:strLit></c:cat><c:val><c:numRef><c:f>${colRangeFormula(dataStartRow, end.row, start.col)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${count}"/>${points(values)}</c:numCache></c:numRef></c:val></c:ser>`);
  } else if (start.row === end.row) {
    const firstVal = computed[coordToAddress(start.row, start.col)]?.value;
    const hasRowLabel = end.col > start.col && typeof firstVal !== 'number';
    const dataStartCol = hasRowLabel ? start.col + 1 : start.col;
    const seriesName = hasRowLabel ? (computed[coordToAddress(start.row, start.col)]?.formatted || chart.title) : chart.title;
    const count = Math.max(1, end.col - dataStartCol + 1);
    const categories = Array.from({ length: count }, (_, i) => `Col ${dataStartCol + i + 1}`);
    const values = Array.from({ length: count }, (_, i) => {
      const value = computed[coordToAddress(start.row, dataStartCol + i)]?.value;
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    });
    series.push(`<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>${xml(sheetPrefix + address(start.row, start.col))}</c:f><c:strCache><c:ptCount val="1"/>${points([seriesName])}</c:strCache></c:strRef></c:tx><c:spPr><a:solidFill><a:srgbClr val="${colors[0]}"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="${colors[0]}"/></a:solidFill></a:ln></c:spPr><c:cat><c:strLit><c:ptCount val="${count}"/>${points(categories)}</c:strLit></c:cat><c:val><c:numRef><c:f>${formula(start.row, dataStartCol, end.col)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${count}"/>${points(values)}</c:numCache></c:numRef></c:val></c:ser>`);
  } else {
    const count = end.col - start.col;
    const categories = Array.from({ length: count }, (_, i) => computed[coordToAddress(start.row, start.col + i + 1)]?.formatted || `Col ${start.col + i + 2}`);
    const lastRow = chart.type === 'pie' ? Math.min(end.row, start.row + 1) : end.row;
    for (let row = start.row + 1; row <= lastRow; row++) {
      const index = row - start.row - 1;
      const name = computed[coordToAddress(row, start.col)]?.formatted || `Row ${row + 1}`;
      const values = Array.from({ length: count }, (_, i) => {
        const value = computed[coordToAddress(row, start.col + i + 1)]?.value;
        return typeof value === 'number' && Number.isFinite(value) ? value : 0;
      });
      series.push(`<c:ser><c:idx val="${index}"/><c:order val="${index}"/><c:tx><c:strRef><c:f>${xml(sheetPrefix + address(row, start.col))}</c:f><c:strCache><c:ptCount val="1"/>${points([name])}</c:strCache></c:strRef></c:tx><c:spPr><a:solidFill><a:srgbClr val="${colors[index % colors.length]}"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="${colors[index % colors.length]}"/></a:solidFill></a:ln></c:spPr><c:cat><c:strRef><c:f>${formula(start.row, start.col + 1, end.col)}</c:f><c:strCache><c:ptCount val="${count}"/>${points(categories)}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>${formula(row, start.col + 1, end.col)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${count}"/>${points(values)}</c:numCache></c:numRef></c:val></c:ser>`);
    }
  }
  const kind = `${chart.type}Chart`;
  const options = chart.type === 'bar' ? '<c:barDir val="col"/><c:grouping val="clustered"/>' : chart.type === 'pie' ? '' : '<c:grouping val="standard"/>';
  const axes = chart.type === 'pie' ? '' : '<c:axId val="1"/><c:axId val="2"/>';
  const axisDefinitions = chart.type === 'pie' ? '' : '<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:crossAx val="2"/><c:crosses val="autoZero"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:numFmt formatCode="General" sourceLinked="1"/><c:crossAx val="1"/><c:crosses val="autoZero"/></c:valAx>';
  return `<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="${chartNS}" xmlns:a="${drawingNS}"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${xml(chart.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:plotArea><c:layout/><c:${kind}>${options}<c:varyColors val="${chart.type === 'pie' ? 1 : 0}"/>${series.join('')}${axes}</c:${kind}>${axisDefinitions}</c:plotArea><c:legend><c:legendPos val="b"/></c:legend><c:plotVisOnly val="1"/></c:chart><c:extLst><c:ext uri="{3D997D3C-7B3D-4C0D-9A94-A7632BCFB737}"><forma:spec xmlns:forma="urn:forma:chart">${xml(JSON.stringify(chart))}</forma:spec></c:ext></c:extLst></c:chartSpace>`;
}

export async function addXlsxCharts(bytes: Uint8Array, workbook: WorkbookData, computed: Record<string, Record<string, ComputedCell>>): Promise<Uint8Array> {
  if (!workbook.sheets.some((sheet) => sheet.charts.length)) return bytes;
  const zip = await JSZip.loadAsync(bytes);
  let types = await zip.file('[Content_Types].xml')!.async('string');
  let chartNumber = 0;
  for (const [index, sheet] of workbook.sheets.entries()) {
    if (!sheet.charts.length) continue;
    const sheetNumber = index + 1;
    const anchors: string[] = [];
    const relations: string[] = [];
    for (const chart of sheet.charts) {
      const n = ++chartNumber;
      zip.file(`xl/charts/chart${n}.xml`, chartXml(chart, sheet, computed[sheet.id]));
      types = types.replace('</Types>', `<Override PartName="/xl/charts/chart${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`);
      anchors.push(`<xdr:absoluteAnchor><xdr:pos x="${Math.round(chart.x * 9525)}" y="${Math.round(chart.y * 9525)}"/><xdr:ext cx="${Math.round(chart.width * 9525)}" cy="${Math.round(chart.height * 9525)}"/><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${n}" name="${xml(chart.title)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${chartNS}"><c:chart xmlns:c="${chartNS}" r:id="rId${n}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:absoluteAnchor>`);
      relations.push(`<Relationship Id="rId${n}" Type="${relationNS}/chart" Target="../charts/chart${n}.xml"/>`);
    }
    zip.file(`xl/drawings/drawing${sheetNumber}.xml`, `<?xml version="1.0" encoding="UTF-8"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="${drawingNS}" xmlns:r="${relationNS}">${anchors.join('')}</xdr:wsDr>`);
    zip.file(`xl/drawings/_rels/drawing${sheetNumber}.xml.rels`, `<Relationships xmlns="${packageNS}">${relations.join('')}</Relationships>`);
    types = types.replace('</Types>', `<Override PartName="/xl/drawings/drawing${sheetNumber}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`);
    const sheetPath = `xl/worksheets/sheet${sheetNumber}.xml`;
    const sheetXml = await zip.file(sheetPath)!.async('string');
    const updatedSheetXml = sheetXml.includes('<legacyDrawing')
      ? sheetXml.replace('<legacyDrawing', '<drawing r:id="formaDrawing"/><legacyDrawing')
      : sheetXml.replace('</worksheet>', '<drawing r:id="formaDrawing"/></worksheet>');
    zip.file(sheetPath, updatedSheetXml);
    const relPath = `xl/worksheets/_rels/sheet${sheetNumber}.xml.rels`;
    const rels = await zip.file(relPath)?.async('string') || `<Relationships xmlns="${packageNS}"></Relationships>`;
    zip.file(relPath, rels.replace('</Relationships>', `<Relationship Id="formaDrawing" Type="${relationNS}/drawing" Target="../drawings/drawing${sheetNumber}.xml"/></Relationships>`));
  }
  zip.file('[Content_Types].xml', types);
  return zip.generateAsync({ type: 'uint8array' });
}

function readSheetNotes(comments: XMLDocument, sheet: SheetData): void {
  for (const comment of Array.from(comments.getElementsByTagNameNS('*', 'comment'))) {
    const coord = parseAddress(comment.getAttribute('ref') ?? '');
    const runs = Array.from(comment.getElementsByTagNameNS('*', 't'));
    if (!coord || !runs.length) continue;
    const address = coordToAddress(coord.row, coord.col);
    const note = runs.map((run) => run.textContent ?? '').join('');
    sheet.cells[address] = { ...sheet.cells[address], raw: sheet.cells[address]?.raw ?? '', note };
    sheet.rowCount = Math.max(sheet.rowCount, coord.row + 1);
    sheet.colCount = Math.max(sheet.colCount, coord.col + 1);
  }
}

export async function readXlsxRelatedParts(bytes: ArrayBuffer | Uint8Array, sheets: SheetData[]): Promise<void> {
  const zip = await JSZip.loadAsync(bytes);
  const parser = new DOMParser();
  const parse = (text: string) => parser.parseFromString(text.replace(/^\uFEFF/, ''), 'application/xml');
  const readXml = async (path: string) => parse(await zip.file(path)?.async('string') || '<empty/>');
  const resolve = (base: string, target: string) => new URL(target, `https://package/${base}`).pathname.slice(1);
  const getRelId = (el: Element): string | null =>
    el.getAttribute('r:id') || el.getAttributeNS(relationNS, 'id');
  const relsPathFor = (path: string) => {
    const slash = path.lastIndexOf('/');
    return `${path.slice(0, slash)}/_rels/${path.slice(slash + 1)}.rels`;
  };
  const relationships = async (path: string) => {
    const rPath = relsPathFor(path);
    if (!zip.file(rPath)) return new Map<string | null, { path: string; type: string }>();
    const doc = await readXml(rPath);
    return new Map(Array.from(doc.getElementsByTagNameNS('*', 'Relationship'))
      .filter((rel) => rel.getAttribute('TargetMode') !== 'External')
      .map((rel) => [rel.getAttribute('Id'), {
        path: resolve(path, rel.getAttribute('Target') ?? ''),
        type: rel.getAttribute('Type') ?? '',
      }]));
  };
  const workbookXml = await readXml('xl/workbook.xml');
  const workbookRels = await relationships('xl/workbook.xml');
  for (const sheetNode of Array.from(workbookXml.getElementsByTagNameNS('*', 'sheet'))) {
    const sheet = sheets.find((s) => s.name === sheetNode.getAttribute('name'));
    const sheetPath = workbookRels.get(getRelId(sheetNode))?.path;
    if (!sheet || !sheetPath) continue;
    const sheetRels = await relationships(sheetPath);
    const relatedParts = Array.from(sheetRels.values());
    const notes = relatedParts.find((rel) => rel.type.endsWith('/comments'));
    if (notes) readSheetNotes(await readXml(notes.path), sheet);
    // Notes can belong to blank cells and can be read without parsing the worksheet grid.
    if (!relatedParts.some((rel) => rel.type.endsWith('/drawing'))) continue;
    const sheetXml = await readXml(sheetPath);
    for (const drawing of Array.from(sheetXml.getElementsByTagNameNS('*', 'drawing'))) {
      const drawingPath = sheetRels.get(getRelId(drawing))?.path;
      if (!drawingPath) continue;
      const drawingXml = await readXml(drawingPath);
      const drawingRels = await relationships(drawingPath);
      for (const reference of Array.from(drawingXml.getElementsByTagNameNS(chartNS, 'chart'))) {
        const chartPath = drawingRels.get(getRelId(reference))?.path;
        if (!chartPath) continue;
        const chart = await readXml(chartPath);
        const spec = chart.getElementsByTagNameNS('urn:forma:chart', 'spec')[0];
        if (spec?.textContent) {
          const original = JSON.parse(spec.textContent) as ChartSpec;
          if (parseRange(original.dataRange)) sheet.charts.push({ ...original, id: uid('chart'), sheetId: sheet.id });
          continue;
        }

        // Standard OOXML chart fallback (Excel / OpenXML SDK / LibreOffice / Google Sheets)
        const type =
          chart.getElementsByTagNameNS('*', 'pieChart').length > 0
            ? 'pie'
            : chart.getElementsByTagNameNS('*', 'lineChart').length > 0
              ? 'line'
              : chart.getElementsByTagNameNS('*', 'areaChart').length > 0
                ? 'area'
                : 'bar';
        const titleEl = chart.getElementsByTagNameNS('*', 'title')[0];
        const titleTexts = titleEl
          ? Array.from(titleEl.getElementsByTagNameNS('*', 't'))
              .map((t) => t.textContent ?? '')
              .join('')
              .trim()
          : '';
        const title = titleTexts || 'Chart';

        let minRow = Infinity;
        let minCol = Infinity;
        let maxRow = -1;
        let maxCol = -1;
        for (const ser of Array.from(chart.getElementsByTagNameNS('*', 'ser'))) {
          for (const fNode of Array.from(ser.getElementsByTagNameNS('*', 'f'))) {
            const rawRef = (fNode.textContent ?? '').trim();
            const parsed = parseRange(rawRef);
            if (!parsed) continue;
            // Ignore single-cell series title refs when computing data table range if multi-row ranges exist
            minRow = Math.min(minRow, parsed.start.row, parsed.end.row);
            minCol = Math.min(minCol, parsed.start.col, parsed.end.col);
            maxRow = Math.max(maxRow, parsed.start.row, parsed.end.row);
            maxCol = Math.max(maxCol, parsed.start.col, parsed.end.col);
          }
        }
        if (maxRow < 0 || maxCol < 0 || !Number.isFinite(minRow) || !Number.isFinite(minCol)) {
          continue;
        }
        if (minRow > 0) {
          const hdrAddr = coordToAddress(minRow - 1, maxCol);
          const hdrRaw = sheet.cells[hdrAddr]?.raw?.trim() ?? '';
          if (hdrRaw && Number.isNaN(Number(hdrRaw)) && !hdrRaw.startsWith('=')) {
            minRow -= 1;
          }
        }
        const dataRange = `${coordToAddress(minRow, minCol)}:${coordToAddress(maxRow, maxCol)}`;

        // Estimate canvas placement from twoCellAnchor or absoluteAnchor if present
        let x = 520;
        let y = 56;
        let width = 440;
        let height = 280;
        const twoCell = drawingXml.getElementsByTagNameNS('*', 'twoCellAnchor')[0];
        if (twoCell) {
          const fromEl = twoCell.getElementsByTagNameNS('*', 'from')[0];
          const toEl = twoCell.getElementsByTagNameNS('*', 'to')[0];
          const fromCol = parseInt(fromEl?.getElementsByTagNameNS('*', 'col')[0]?.textContent || '', 10);
          const fromRow = parseInt(fromEl?.getElementsByTagNameNS('*', 'row')[0]?.textContent || '', 10);
          const toCol = parseInt(toEl?.getElementsByTagNameNS('*', 'col')[0]?.textContent || '', 10);
          const toRow = parseInt(toEl?.getElementsByTagNameNS('*', 'row')[0]?.textContent || '', 10);
          if (!Number.isNaN(fromCol) && !Number.isNaN(fromRow)) {
            let pxX = 0;
            for (let c = 0; c < fromCol; c++) pxX += sheet.colWidths[c] ?? 108;
            let pxY = 0;
            for (let r = 0; r < fromRow; r++) pxY += sheet.rowHeights[r] ?? 26;
            x = Math.max(24, pxX);
            y = Math.max(16, pxY);
            if (!Number.isNaN(toCol) && toCol > fromCol) {
              let w = 0;
              for (let c = fromCol; c < toCol; c++) w += sheet.colWidths[c] ?? 108;
              width = Math.max(300, Math.min(720, w));
            }
            if (!Number.isNaN(toRow) && toRow > fromRow) {
              let h = 0;
              for (let r = fromRow; r < toRow; r++) h += sheet.rowHeights[r] ?? 26;
              height = Math.max(220, Math.min(520, h));
            }
          }
        }

        sheet.charts.push({
          id: uid('chart'),
          sheetId: sheet.id,
          type,
          title,
          dataRange,
          x,
          y,
          width,
          height,
        });
      }
    }
  }
}
