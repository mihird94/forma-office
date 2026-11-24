import katex from 'katex';
import { marked } from 'marked';
import { highlightPythonToHtml } from './pythonHighlight';

/**
 * Render Markdown + LaTeX math ($$...$$ display & $...$ inline) cleanly via KaTeX + marked.
 * Preserves code blocks so `$` inside code spans is never treated as math.
 */
export function renderMathMarkdown(source: string): string {
  if (!source.trim()) return '<p class="text-slate-400 italic">Empty markdown cell — double-click to edit</p>';

  const placeholders: string[] = [];
  const stash = (html: string): string => {
    const idx = placeholders.length;
    placeholders.push(html);
    return `@@FORMA_MATH_${idx}@@`;
  };

  // 1. Protect fenced code blocks & inline code first so $ inside code isn't touched
  const codeTokens: string[] = [];
  let text = source.replace(/```[\s\S]*?```|`[^`\n]+`/g, (match) => {
    const idx = codeTokens.length;
    codeTokens.push(match);
    return `@@FORMA_CODE_${idx}@@`;
  });

  // 2. Display math: $$ ... $$ or \[ ... \]
  text = text.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_, m1, m2) => {
    const expr = (m1 ?? m2 ?? '').trim();
    try {
      const rendered = katex.renderToString(expr, { displayMode: true, throwOnError: false });
      return stash(`<div class="my-3 overflow-x-auto">${rendered}</div>`);
    } catch {
      return stash(`<pre>${expr}</pre>`);
    }
  });

  // 3. Inline math: $ ... $ or \( ... \) (avoid matching currency pairs like "$100 to $200")
  text = text.replace(/(?<!\\)\$(?!\s|\d+\s)([^\n$]+?)(?<!\s|\\)\$(?!\d)|\\\(([^\n]+?)\\\)/g, (_, m1, m2) => {
    const expr = (m1 ?? m2 ?? '').trim();
    try {
      return stash(katex.renderToString(expr, { displayMode: false, throwOnError: false }));
    } catch {
      return stash(`<code>${expr}</code>`);
    }
  });

  // 4. Restore code blocks before Markdown parsing
  text = text.replace(/@@FORMA_CODE_(\d+)@@/g, (_, idx) => codeTokens[Number(idx)] ?? '');

  // 5. Parse Markdown (GFM)
  let html = marked.parse(text, { gfm: true, breaks: false }) as string;

  // 5b. Syntax-highlight Python fenced code blocks inside Markdown cells
  html = html.replace(
    /<pre><code class="language-(?:python|py)">([\s\S]*?)<\/code><\/pre>/g,
    (_, rawCode: string) => {
      const decoded = rawCode
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
      return `<pre class="forma-py-dark"><code class="language-python">${highlightPythonToHtml(decoded)}</code></pre>`;
    }
  );

  // 6. Restore KaTeX HTML placeholders
  html = html.replace(/@@FORMA_MATH_(\d+)@@/g, (_, idx) => placeholders[Number(idx)] ?? '');

  return html;
}

/** Render standalone LaTeX output from a Python cell (text/latex) */
export function renderLatexOutput(latex: string): string {
  const cleaned = latex.replace(/^\$\$?|\$\$?$/g, '').trim();
  try {
    return katex.renderToString(cleaned, { displayMode: true, throwOnError: false });
  } catch {
    return `<code>${cleaned}</code>`;
  }
}
