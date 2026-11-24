import { FormaDocument } from '../../../types/document';
import { uid } from '../../spreadsheet/workbookOps';
import { sanitizeDocumentHtml } from '../../../utils/documentSecurity';

/** Export a self-contained, cleanly styled HTML5 document */
export function exportDocumentToHtml(doc: FormaDocument): string {
  const safeTitle = doc.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fontFamily = /^[a-z\d _,\-]+$/i.test(doc.pageSettings.fontFamily) ? doc.pageSettings.fontFamily : 'system-ui';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    body { max-width: 780px; margin: 48px auto; padding: 0 24px; font-family: ${fontFamily}, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.7; color: #1e293b; }
    h1 { font-size: 2rem; color: #0f172a; margin-bottom: 0.75rem; }
    h2 { font-size: 1.45rem; color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.25rem; margin-top: 1.75rem; }
    h3 { font-size: 1.15rem; color: #1e293b; margin-top: 1.25rem; }
    blockquote { border-left: 3.5px solid #2563eb; background: #f8fafc; padding: 0.65rem 1rem; margin: 1rem 0; color: #334155; font-style: italic; }
    pre { background: #0f172a; color: #e2e8f0; padding: 1rem; border-radius: 8px; overflow-x: auto; font-family: ui-monospace, monospace; font-size: 0.85rem; }
    code { background: #f1f5f9; color: #be123c; padding: 0.1rem 0.35rem; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 0.88em; }
    pre code { background: transparent; color: inherit; padding: 0; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th, td { border: 1px solid #cbd5e1; padding: 0.5rem 0.75rem; text-align: left; }
    th { background: #f1f5f9; font-weight: 600; }
  </style>
</head>
<body>
${sanitizeDocumentHtml(doc.html)}
</body>
</html>
`;
}

export function importDocumentFromHtml(html: string, filename = 'Imported HTML'): FormaDocument {
  const parser = new DOMParser();
  const parsed = parser.parseFromString(html, 'text/html');
  const title = parsed.title?.trim() || filename.replace(/\.html?$/i, '');
  const now = Date.now();
  return {
    id: uid('doc'),
    title,
    html: sanitizeDocumentHtml(parsed.body?.innerHTML || html),
    sourceFormat: 'html',
    pageSettings: {
      pageSize: 'letter',
      margins: 'normal',
      fontFamily: 'Inter',
    },
    createdAt: now,
    updatedAt: now,
  };
}
