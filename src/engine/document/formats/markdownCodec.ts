import { marked } from 'marked';
import { FormaDocument } from '../../../types/document';
import { uid } from '../../spreadsheet/workbookOps';
import { sanitizeDocumentHtml } from '../../../utils/documentSecurity';

function inlineHtmlToMd(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? '';
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  const inner = Array.from(el.childNodes).map(inlineHtmlToMd).join('');

  switch (tag) {
    case 'strong':
    case 'b':
      return `**${inner}**`;
    case 'em':
    case 'i':
      return `*${inner}*`;
    case 's':
    case 'del':
      return `~~${inner}~~`;
    case 'code':
      return `\`${inner}\``;
    case 'a': {
      const href = el.getAttribute('href') || '';
      return `[${inner}](${href})`;
    }
    case 'img': {
      const src = el.getAttribute('src') || '';
      const alt = el.getAttribute('alt') || '';
      return `![${alt}](${src})`;
    }
    case 'br':
      return '  \n';
    default:
      return inner;
  }
}

function collectListItemText(li: Element): { text: string; nestedLists: Element[] } {
  const nestedLists: Element[] = [];
  const pieces: string[] = [];
  for (const child of Array.from(li.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      const cTag = el.tagName.toLowerCase();
      if (cTag === 'ul' || cTag === 'ol') {
        nestedLists.push(el);
        continue;
      }
      if (cTag === 'p' || cTag === 'div') {
        const innerClone = el.cloneNode(true) as Element;
        for (const sub of Array.from(innerClone.querySelectorAll('ul, ol'))) {
          nestedLists.push(sub);
          sub.remove();
        }
        pieces.push(inlineHtmlToMd(innerClone));
        continue;
      }
    }
    pieces.push(inlineHtmlToMd(child));
  }
  return { text: pieces.join('').trim(), nestedLists };
}

function listHtmlToMd(el: Element, indentLevel = 0): string {
  const tag = el.tagName.toLowerCase();
  const isTaskList = el.getAttribute('data-type') === 'taskList';
  const items = Array.from(el.children).filter((c) => c.tagName.toLowerCase() === 'li');
  const indent = '  '.repeat(indentLevel);
  return items
    .map((li, idx) => {
      const { text, nestedLists } = collectListItemText(li);
      let line: string;
      if (isTaskList || li.getAttribute('data-type') === 'taskItem') {
        const checked =
          li.getAttribute('data-checked') === 'true' ||
          Boolean(li.querySelector('input[type="checkbox"][checked]'));
        line = `${indent}- [${checked ? 'x' : ' '}] ${text}`;
      } else {
        const checkbox = li.querySelector(':scope > input[type="checkbox"]');
        if (checkbox) {
          const checked = checkbox.hasAttribute('checked') || (checkbox as HTMLInputElement).checked;
          const clone = li.cloneNode(true) as HTMLElement;
          clone.querySelector(':scope > input[type="checkbox"]')?.remove();
          const { text: cleanText } = collectListItemText(clone);
          line = `${indent}- [${checked ? 'x' : ' '}] ${cleanText}`;
        } else {
          const prefix = tag === 'ol' ? `${idx + 1}. ` : '- ';
          line = `${indent}${prefix}${text}`;
        }
      }
      if (nestedLists.length > 0) {
        const subMd = nestedLists.map((sub) => listHtmlToMd(sub, indentLevel + 1)).join('\n');
        return `${line}\n${subMd}`;
      }
      return line;
    })
    .join('\n');
}

function blockHtmlToMd(el: Element): string {
  const tag = el.tagName.toLowerCase();

  if (tag === 'h1') return `# ${inlineHtmlToMd(el).trim()}`;
  if (tag === 'h2') return `## ${inlineHtmlToMd(el).trim()}`;
  if (tag === 'h3') return `### ${inlineHtmlToMd(el).trim()}`;
  if (tag === 'h4') return `#### ${inlineHtmlToMd(el).trim()}`;
  if (tag === 'h5') return `##### ${inlineHtmlToMd(el).trim()}`;
  if (tag === 'h6') return `###### ${inlineHtmlToMd(el).trim()}`;

  if (tag === 'p') return inlineHtmlToMd(el).trim();

  if (tag === 'hr') return '---';

  if (tag === 'blockquote') {
    const inner = Array.from(el.children)
      .map(blockHtmlToMd)
      .join('\n') || inlineHtmlToMd(el);
    return inner
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n');
  }

  if (tag === 'pre') {
    const codeEl = el.querySelector('code');
    const langClass = codeEl?.getAttribute('class') || '';
    const langMatch = /language-([A-Za-z0-9_+-]+)/.exec(langClass);
    const lang = langMatch ? langMatch[1] : '';
    const code = el.textContent ?? '';
    return `\`\`\`${lang}\n${code.replace(/\n$/, '')}\n\`\`\``;
  }

  if (tag === 'ul' || tag === 'ol') {
    return listHtmlToMd(el, 0);
  }

  if (tag === 'table') {
    const rows = Array.from(el.querySelectorAll('tr')).map((tr) =>
      Array.from(tr.children)
        .filter((c) => c.tagName.toLowerCase() === 'td' || c.tagName.toLowerCase() === 'th')
        .map((c) => inlineHtmlToMd(c).trim().replace(/\|/g, '\\|').replace(/\n+/g, ' '))
    );
    if (rows.length === 0) return '';
    const colCount = Math.max(...rows.map((r) => r.length));
    const padRow = (r: string[]) => {
      const padded = [...r];
      while (padded.length < colCount) padded.push('');
      return `| ${padded.join(' | ')} |`;
    };
    const header = padRow(rows[0]);
    const sep = `| ${Array(colCount).fill('---').join(' | ')} |`;
    const body = rows.slice(1).map(padRow);
    return [header, sep, ...body].join('\n');
  }

  if (el.children.length === 0) {
    return inlineHtmlToMd(el).trim();
  }
  return Array.from(el.children).map(blockHtmlToMd).join('\n\n');
}

/**
 * Convert `marked` GFM task list HTML (`<ul><li><input type="checkbox">...</li></ul>`)
 * into TipTap TaskList/TaskItem schema attributes (`data-type="taskList"`, `data-type="taskItem"`).
 */
export function normalizeMarkdownHtmlForTiptap(rawHtml: string): string {
  if (!rawHtml.includes('type="checkbox"')) return sanitizeDocumentHtml(rawHtml);
  const parser = new DOMParser();
  const doc = parser.parseFromString(rawHtml, 'text/html');
  for (const ul of Array.from(doc.querySelectorAll('ul'))) {
    const liChildren = Array.from(ul.children).filter((c) => c.tagName.toLowerCase() === 'li');
    if (
      liChildren.length > 0 &&
      liChildren.some((li) => Boolean(li.querySelector(':scope > input[type="checkbox"]')))
    ) {
      ul.setAttribute('data-type', 'taskList');
      for (const li of liChildren) {
        const cb = li.querySelector(':scope > input[type="checkbox"]');
        if (cb) {
          const checked = cb.hasAttribute('checked') || (cb as HTMLInputElement).checked;
          cb.remove();
          li.setAttribute('data-type', 'taskItem');
          li.setAttribute('data-checked', checked ? 'true' : 'false');
          const innerHtml = li.innerHTML.trim();
          li.innerHTML = `<p>${innerHtml}</p>`;
        }
      }
    }
  }
  return sanitizeDocumentHtml(doc.body.innerHTML);
}

function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Parse GFM Markdown into TipTap-compatible sanitized HTML while preserving raw LaTeX
 * ($...$, \(...\), $$...$$, \[...\]) intact so underscores (`_`), backslashes (`\\`),
 * and delimiters are never mangled by `marked` before live KaTeX rendering.
 */
export function parseMarkdownToTiptapHtml(md: string): string {
  const cleanMd = md.replace(/^\uFEFF/, '');
  const codeTokens: string[] = [];
  const mathTokens: string[] = [];

  // 1. Protect fenced code blocks & inline code spans so `$` inside code is untouched.
  let text = cleanMd.replace(/```[\s\S]*?```|`[^`\n]+`/g, (match) => {
    const idx = codeTokens.length;
    codeTokens.push(match);
    return `FORMACODETOKEN${idx}X`;
  });

  // 2. Protect display math ($$...$$ and \[...\]) before `marked`.
  text = text.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (fullMatch) => {
    const idx = mathTokens.length;
    const escaped = escapeHtmlText(fullMatch).replace(/\r?\n/g, '<br>');
    mathTokens.push(escaped);
    return `FORMAMATHTOKEN${idx}X`;
  });

  // 3. Protect inline math ($...$ and \(...\)) before `marked`.
  text = text.replace(
    /(?<!\\)\$(?!\s|\d+(?:[.,]\d+)?\s)([^\n$]+?)(?<!\s|\\)\$(?!\d)|\\\(([^\n]+?)\\\)/g,
    (fullMatch) => {
      const idx = mathTokens.length;
      mathTokens.push(escapeHtmlText(fullMatch));
      return `FORMAMATHTOKEN${idx}X`;
    }
  );

  // 4. Restore code blocks so `marked` renders them normally.
  text = text.replace(/FORMACODETOKEN(\d+)X/g, (_, idx) => codeTokens[Number(idx)] ?? '');

  // 5. Parse Markdown & normalize GFM task lists.
  const rawHtml = (marked.parse(text, { gfm: true, breaks: false }) as string) || '<p></p>';
  let html = normalizeMarkdownHtmlForTiptap(rawHtml);

  // 6. Restore raw LaTeX delimiters intact inside the sanitized HTML.
  html = html.replace(/FORMAMATHTOKEN(\d+)X/g, (_, idx) => mathTokens[Number(idx)] ?? '');
  return html;
}

/**
 * Export a Forma Document to GitHub-Flavored Markdown (.md).
 */
export function exportDocumentToMarkdown(doc: FormaDocument): string {
  const parser = new DOMParser();
  const parsed = parser.parseFromString(doc.html || '', 'text/html');
  const blocks = Array.from(parsed.body.children)
    .map(blockHtmlToMd)
    .filter((b) => b.trim() !== '');
  return blocks.join('\n\n') + '\n';
}

/**
 * Import a GitHub-Flavored Markdown (.md) file into a Forma Document.
 */
export function importDocumentFromMarkdown(md: string, filename = 'Imported Markdown'): FormaDocument {
  const cleanMd = md.replace(/^\uFEFF/, '');
  const html = parseMarkdownToTiptapHtml(cleanMd);
  const now = Date.now();
  return {
    id: uid('doc'),
    title: filename.replace(/\.(md|markdown)$/i, ''),
    html: html || '<p></p>',
    markdownSource: cleanMd,
    sourceFormat: 'md',
    pageSettings: {
      pageSize: 'letter',
      margins: 'normal',
      fontFamily: 'Inter',
    },
    createdAt: now,
    updatedAt: now,
  };
}
