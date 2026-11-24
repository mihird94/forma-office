// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { LiveLatexMath, findLatexSpansInDoc } from '../engine/document/liveLatex';
import { parseMarkdownToTiptapHtml } from '../engine/document/formats/markdownCodec';

function createLatexEditor(html: string): Editor {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return new Editor({
    element: host,
    extensions: [StarterKit, LiveLatexMath],
    content: html,
  });
}

describe('Forma Docs Live LaTeX / KaTeX rendering', () => {
  it('preserves raw LaTeX delimiters, subscripts, and backslashes across Markdown parsing', () => {
    const md = [
      '# Math Notes',
      '',
      'Inline $x_1 + x_2 = y_n$ and paren \\(a_i \\cdot b_j\\).',
      '',
      '$$',
      '\\begin{aligned}',
      'f(x) &= x_1^2 + x_2^2 \\\\',
      'g(x) &= \\frac{a}{b}',
      '\\end{aligned}',
      '$$',
      '',
      'Bracket \\[\\alpha + \\beta = \\gamma\\].',
      '',
      '```bash',
      'echo "$HOME" && echo "$x_1$"',
      '```',
    ].join('\n');

    const html = parseMarkdownToTiptapHtml(md);
    // Underscores in math must never be mangled into <em>
    expect(html).not.toContain('<em>');
    expect(html).toContain('$x_1 + x_2 = y_n$');
    expect(html).toContain('\\(a_i \\cdot b_j\\)');
    expect(html).toContain('\\begin{aligned}');
    expect(html).toContain('\\\\');
    expect(html).toContain('\\[\\alpha + \\beta = \\gamma\\]');
    // Fenced code blocks remain untouched
    expect(html).toContain('$HOME');
  });

  it('renders inline and display KaTeX widgets in-place when cursor is outside and skips currency/code', () => {
    const html = [
      '<p>Cursor start paragraph</p>',
      '<p>Energy $E = mc^2$ and cost $100 to $200 with code <code>$x^2$</code>.</p>',
      '<p>$$\\frac{a}{b}$$</p>',
    ].join('');

    const editor = createLatexEditor(html);
    try {
      // Place cursor in the first paragraph (outside both equations)
      editor.commands.setTextSelection(2);

      const spans = findLatexSpansInDoc(editor.state.doc);
      expect(spans).toHaveLength(2);
      expect(spans[0].expr).toBe('E = mc^2');
      expect(spans[0].displayMode).toBe(false);
      expect(spans[1].expr).toBe('\\frac{a}{b}');
      expect(spans[1].displayMode).toBe(true);

      const dom = editor.view.dom;
      const inlineWidgets = dom.querySelectorAll('.forma-latex-widget.forma-latex-inline');
      const displayWidgets = dom.querySelectorAll('.forma-latex-widget.forma-latex-display');
      expect(inlineWidgets.length).toBe(1);
      expect(displayWidgets.length).toBe(1);
      expect(dom.querySelectorAll('.katex').length).toBe(2);

      // Currency & inline code must not produce KaTeX widgets
      expect(dom.textContent).toContain('$100 to $200');
      const codeEl = dom.querySelector('code');
      expect(codeEl?.textContent).toBe('$x^2$');
      expect(codeEl?.querySelector('.katex')).toBeNull();
    } finally {
      editor.destroy();
    }
  });

  it('reveals raw LaTeX source with live preview when cursor moves inside the equation', () => {
    const html = '<p>Outside</p><p>Formula $a^2 + b^2 = c^2$ done.</p>';
    const editor = createLatexEditor(html);
    try {
      // Cursor outside initially
      editor.commands.setTextSelection(2);
      expect(editor.view.dom.querySelectorAll('.forma-latex-widget').length).toBe(1);
      expect(editor.view.dom.querySelectorAll('.forma-latex-source-editing').length).toBe(0);

      // Move cursor inside the inline equation
      const spans = findLatexSpansInDoc(editor.state.doc);
      expect(spans).toHaveLength(1);
      editor.commands.setTextSelection(spans[0].innerFrom + 1);

      expect(editor.view.dom.querySelectorAll('.forma-latex-source-editing').length).toBe(1);
      expect(editor.view.dom.querySelectorAll('.forma-latex-live-preview').length).toBe(1);
      expect(editor.view.dom.querySelectorAll('.forma-latex-widget').length).toBe(0);
    } finally {
      editor.destroy();
    }
  });

  it('supports multi-paragraph display math blocks bounded by $$ paragraphs', () => {
    const html = '<p>Lead</p><p>$$</p><p>\\int_0^1 x^2 \\, dx = \\frac{1}{3}</p><p>$$</p>';
    const editor = createLatexEditor(html);
    try {
      editor.commands.setTextSelection(2);
      const spans = findLatexSpansInDoc(editor.state.doc);
      expect(spans).toHaveLength(1);
      expect(spans[0].displayMode).toBe(true);
      expect(spans[0].blockParagraphs?.length).toBe(3);

      const displayWidgets = editor.view.dom.querySelectorAll('.forma-latex-widget.forma-latex-display .katex');
      expect(displayWidgets.length).toBe(1);
      expect(editor.view.dom.querySelectorAll('.forma-latex-block-hidden').length).toBe(2);
    } finally {
      editor.destroy();
    }
  });

  it('renders Attention & Transformers (D2L) equations in-place with zero mangled subscripts', () => {
    const d2lMarkdown = [
      '# Attention & Transformers (D2L)',
      '',
      'Leading paragraph outside math.',
      '',
      '- **Core Formula**: $\\text{Attention}(\\mathbf{q}, \\mathcal{D}) = \\sum_{i=1}^m \\text{softmax}(a(\\mathbf{q}, \\mathbf{k}_i)) \\mathbf{v}_i$',
      '- **Scaled Dot-Product**: $a(\\mathbf{q}, \\mathbf{k}_i) = \\frac{\\mathbf{q}^\\top \\mathbf{k}_i}{\\sqrt{d}}$',
      '- **Stability**: The $\\sqrt{d}$ factor keeps variance at $1$.',
      '- **Mechanism**: Projects $d$-dimensional vectors into $h$ subspaces.',
      '- **Complexity**: $O(n^2 d)$ complexity for sequence length ($n$).',
    ].join('\n');

    const html = parseMarkdownToTiptapHtml(d2lMarkdown);
    expect(html).not.toContain('<em>');

    const editor = createLatexEditor(html);
    try {
      editor.commands.setTextSelection(2);
      const spans = findLatexSpansInDoc(editor.state.doc);
      expect(spans).toHaveLength(8);
      expect(spans.every((s) => !s.displayMode)).toBe(true);

      const inlineWidgets = editor.view.dom.querySelectorAll('.forma-latex-widget.forma-latex-inline .katex');
      expect(inlineWidgets.length).toBe(8);
    } finally {
      editor.destroy();
    }
  });
});
