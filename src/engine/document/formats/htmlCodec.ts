import { DocComment, FormaDocument } from '../../../types/document';
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
    rawHtmlSource: stripHtmlReviewComments(html),
    comments: extractHtmlReviewComments(html),
    pageSettings: {
      pageSize: 'letter',
      margins: 'normal',
      fontFamily: 'Inter',
    },
    createdAt: now,
    updatedAt: now,
  };
}

const reviewScript = /<script\b(?=[^>]*\bid\s*=\s*["']forma-review-comments["'])(?=[^>]*\btype\s*=\s*["']application\/forma-comments\+json["'])[^>]*>[\s\S]*?<\/script\s*>/gi;

export function stripHtmlReviewComments(rawHtml: string): string {
  return rawHtml.replace(reviewScript, '');
}
export function extractHtmlReviewComments(rawHtml: string): DocComment[] {
  const match = rawHtml.match(reviewScript)?.[0];
  if (!match) return [];
  try {
    const value: unknown = JSON.parse(match.replace(/^<script\b[^>]*>/i, '').replace(/<\/script\s*>$/i, ''));
    return Array.isArray(value) ? value.filter((c): c is DocComment => c && typeof c.id === 'string' && typeof c.text === 'string' && typeof c.author === 'string' && typeof c.createdAt === 'number') : [];
  } catch { return []; }
}
export function exportRawHtmlWithComments(rawHtml: string, comments: DocComment[] = []): string {
  const clean = stripHtmlReviewComments(rawHtml);
  if (comments.length === 0) return clean;
  const block = `<script type="application/forma-comments+json" id="forma-review-comments">${JSON.stringify(comments).replace(/<\/script/gi, '<\\/script')}</script>`;
  return /<\/body\s*>/i.test(clean) ? clean.replace(/<\/body\s*>/i, () => `${block}\n</body>`) : clean + '\n' + block;
}
export function detectExternalHtmlOrigins(rawHtml: string): string[] {
  const origins = new Set<string>();
  const hints = rawHtml.matchAll(/(?:<(?:script|img)\b[^>]*\bsrc\s*=\s*["']|<link\b[^>]*\bhref\s*=\s*["']|url\(\s*["']?|(?:import|fetch)\s*\(\s*["']|\bfrom\s*["']|\bimport\s*["']|@import\s*["'])(https?:\/\/[^\s"')<>]+)/gi);
  for (const m of hints) { try { origins.add(new URL(m[1]).origin); } catch { /* malformed URL */ } }
  return [...origins].sort();
}

// Exact HTTPS origins only. Unknown hosts still require an explicit opt-in.
export const DEFAULT_HTML_CDN_ORIGINS = new Set([
  'https://cdn.tailwindcss.com',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
  'https://cdnjs.cloudflare.com',
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
]);
function normalizeExternalOrigins(allowExternalOrigins: string[]): string[] {
  const out = new Set<string>();
  for (const origin of allowExternalOrigins) {
    try {
      const u = new URL(origin);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin === origin) {
        out.add(u.origin);
        if (u.origin.toLowerCase() === 'https://fonts.googleapis.com') {
          out.add('https://fonts.gstatic.com');
        }
      }
    } catch { /* ignore invalid origin */ }
  }
  return [...out].sort();
}

function injectHtmlHeadMarkup(clean: string, injection: string): string {
  if (/<head\b[^>]*>/i.test(clean)) return clean.replace(/<head\b[^>]*>/i, (head) => head + injection);
  if (/<html\b[^>]*>/i.test(clean)) return clean.replace(/<html\b[^>]*>/i, (htmlTag) => `${htmlTag}<head>${injection}</head>`);
  if (/^\s*<!doctype\b[^>]*>/i.test(clean)) return clean.replace(/^\s*<!doctype\b[^>]*>\s*/i, (doctype) => `${doctype}${injection}`);
  return injection + clean;
}

const SELECTION_BRIDGE_SCRIPT = `<script>window.addEventListener('mouseup',function(){var quote=String(window.getSelection()||'').trim();if(quote)window.parent.postMessage({type:'forma-html-selection',quote:quote},'*')});</script>`;

export function buildHtmlPreviewDocument(rawHtml: string, opts: { includeSelectionBridge?: boolean } = {}): string {
  const clean = stripHtmlReviewComments(rawHtml);
  if (opts.includeSelectionBridge === false) return clean;
  return injectHtmlHeadMarkup(clean, SELECTION_BRIDGE_SCRIPT);
}

export function buildSandboxedHtmlSrcDoc(rawHtml: string, opts: { allowExternalOrigins: string[] }): string {
  const origins = normalizeExternalOrigins(opts.allowExternalOrigins).join(' ');
  const extra = origins ? ` ${origins}` : '';
  const csp = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: data:${extra}; style-src 'unsafe-inline' blob: data:${extra}; img-src data: blob:${extra}; font-src data: blob:${extra}; connect-src blob: data:${extra}; worker-src blob:; child-src blob:; media-src data: blob:${extra}; base-uri 'none'; form-action 'none';`;
  const injection = `<meta http-equiv="Content-Security-Policy" content="${csp}">${SELECTION_BRIDGE_SCRIPT}`;
  return injectHtmlHeadMarkup(stripHtmlReviewComments(rawHtml), injection);
}

const previewWaiters = new Map<string, (url: string) => void>();

export function registerNativeHtmlPreview(html: string, allowedOrigins: string[]): Promise<string | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  const w = window as unknown as {
    webkit?: {
      messageHandlers?: {
        formaRegisterHtmlPreview?: {
          postMessage: (payload: { requestId: string; html: string; allowedOrigins: string[] }) => void;
        };
      };
    };
    __formaResolveHtmlPreview?: (requestId: string, previewUrl: string) => void;
  };
  const handler = w.webkit?.messageHandlers?.formaRegisterHtmlPreview;
  if (!handler) return Promise.resolve(null);
  if (!w.__formaResolveHtmlPreview) {
    w.__formaResolveHtmlPreview = (requestId: string, previewUrl: string) => {
      const resolve = previewWaiters.get(requestId);
      if (resolve) {
        previewWaiters.delete(requestId);
        resolve(previewUrl);
      }
    };
  }
  const requestId = `hp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (previewWaiters.delete(requestId)) resolve(null);
    }, 3000);
    previewWaiters.set(requestId, (previewUrl) => {
      clearTimeout(timer);
      resolve(previewUrl || null);
    });
    handler.postMessage({
      requestId,
      html,
      allowedOrigins: normalizeExternalOrigins(allowedOrigins),
    });
  });
}
export function formatCommentsForAgent(title: string, comments: DocComment[]): string {
  const entries = comments.filter(c => !c.resolved).map(c => `${c.pin ? `[Pin ${c.pin.xPct}%, ${c.pin.yPct}%] ` : ''}${c.author}: ${c.text}${c.quote ? `\n> ${c.quote.replace(/\n/g, '\n> ')}` : ''}`);
  return `# Review Comments: ${title}\n\n${entries.join('\n\n')}`;
}
