import { FastZip } from '../../../utils/fastZip';
import type { DocumentPageSettings } from '../../../types/document';

type PageText = Pick<DocumentPageSettings, 'headerText' | 'footerText'>;

function zipPartPath(from: string, target: string): string | undefined {
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return undefined;
  const parent = from.slice(0, from.lastIndexOf('/') + 1);
  const parts: string[] = [];
  for (const segment of (target.startsWith('/') ? target : parent + target).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!parts.length) return undefined;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join('/');
}

function readXml(zip: FastZip, path: string): XMLDocument | undefined {
  const xml = zip.readText(path);
  if (!xml) return undefined;
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return doc.getElementsByTagName('parsererror').length ? undefined : doc;
}

function relationships(doc?: XMLDocument): Element[] {
  return doc ? Array.from(doc.getElementsByTagNameNS('*', 'Relationship')) : [];
}

function partText(doc?: XMLDocument): string | undefined {
  const ns = doc?.documentElement.namespaceURI;
  if (!doc || !ns) return undefined;
  return Array.from(doc.getElementsByTagNameNS(ns, 'p'))
    .map((p) => Array.from(p.getElementsByTagNameNS(ns, 't')).map((t) => t.textContent ?? '').join(''))
    .join('\n').trim() || undefined;
}

export async function readDocxLayout(bytes: ArrayBuffer): Promise<{ bytes: ArrayBuffer; pageText: PageText }> {
  const zip = FastZip.load(bytes);
  const documentRel = relationships(readXml(zip, '_rels/.rels')).find((rel) =>
    rel.getAttribute('Type')?.endsWith('/officeDocument') && rel.getAttribute('TargetMode') !== 'External'
  );
  const documentPath = zipPartPath('', documentRel?.getAttribute('Target') ?? '') ?? 'word/document.xml';
  const document = readXml(zip, documentPath);
  const ns = document?.documentElement.namespaceURI;
  const pageText: PageText = {};
  if (!document || !ns) return { bytes, pageText };

  // Forma has one page layout. Load the first section's default header and footer.
  const section = document.getElementsByTagNameNS(ns, 'sectPr')[0];
  if (section) {
    const relsPath = documentPath.replace(/([^/]+)$/, '_rels/$1.rels');
    const rels = relationships(readXml(zip, relsPath));
    for (const kind of ['header', 'footer'] as const) {
      const ref = Array.from(section.children).find((el) =>
        el.namespaceURI === ns && el.localName === `${kind}Reference` &&
        (el.getAttributeNS(ns, 'type') ?? 'default') === 'default'
      );
      const id = ref && Array.from(ref.attributes).find((attr) =>
        attr.localName === 'id' && attr.namespaceURI?.endsWith('/relationships')
      )?.value;
      const rel = id && rels.find((item) => item.getAttribute('Id') === id &&
        item.getAttribute('Type')?.endsWith(`/${kind}`) && item.getAttribute('TargetMode') !== 'External');
      const part = rel && zipPartPath(documentPath, rel.getAttribute('Target') ?? '');
      if (part) pageText[`${kind}Text`] = partText(readXml(zip, part));
    }
  }

  // Mammoth reads explicit page breaks, but ignores pageBreakBefore paragraph properties.
  let inserted = false;
  for (const property of Array.from(document.getElementsByTagNameNS(ns, 'pageBreakBefore'))) {
    const properties = property.parentElement;
    const paragraph = properties?.parentElement;
    const value = property.getAttributeNS(ns, 'val');
    if (properties?.localName !== 'pPr' || paragraph?.localName !== 'p' ||
        value === '0' || value === 'false' || value === 'off') continue;
    const run = document.createElementNS(ns, 'w:r');
    const br = document.createElementNS(ns, 'w:br');
    br.setAttributeNS(ns, 'w:type', 'page');
    run.appendChild(br);
    paragraph.insertBefore(run, properties.nextSibling);
    inserted = true;
  }

  if (!inserted) return { bytes, pageText };
  zip.writeText(documentPath, new XMLSerializer().serializeToString(document));
  return { bytes: zip.toArrayBuffer(), pageText };
}
