import { Extension } from '@tiptap/core';
import { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet, EditorView } from '@tiptap/pm/view';
import katex from 'katex';
import { sanitizeDocumentHtml } from '../../utils/documentSecurity';

export interface LatexBlockParagraphMeta {
  pos: number;
  size: number;
  contentFrom: number;
  contentTo: number;
  isDelimiterOnly: boolean;
}

export interface LatexSpan {
  from: number;
  to: number;
  innerFrom: number;
  widgetPos: number;
  expr: string;
  displayMode: boolean;
  blockParagraphs?: LatexBlockParagraphMeta[];
}

const katexCache = new Map<string, string>();
const MAX_KATEX_CACHE = 500;

/**
 * Render LaTeX to sanitized KaTeX HTML with bounded memoization.
 */
export function renderLatexToSanitizedHtml(expr: string, displayMode: boolean): string {
  const key = `${displayMode ? 'D' : 'I'}:${expr}`;
  const cached = katexCache.get(key);
  if (cached !== undefined) return cached;

  let rawHtml: string;
  try {
    rawHtml = katex.renderToString(expr, {
      displayMode,
      throwOnError: false,
      strict: false,
    });
  } catch {
    const escaped = expr
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    rawHtml = `<code>${escaped}</code>`;
  }

  const clean = sanitizeDocumentHtml(rawHtml);
  if (katexCache.size >= MAX_KATEX_CACHE) {
    const firstKey = katexCache.keys().next().value;
    if (firstKey !== undefined) katexCache.delete(firstKey);
  }
  katexCache.set(key, clean);
  return clean;
}

function collectMultiParagraphSpans(
  parent: ProseMirrorNode,
  contentStartPos: number,
  spans: LatexSpan[],
  consumedParagraphs: Set<number>
): void {
  const children: Array<{ node: ProseMirrorNode; pos: number; text: string }> = [];
  let offset = 0;
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    const childPos = contentStartPos + offset;
    children.push({ node: child, pos: childPos, text: child.textContent });
    offset += child.nodeSize;
  }

  let i = 0;
  while (i < children.length) {
    const open = children[i];
    if (open.node.type.name === 'paragraph') {
      const openTrim = open.text.trim();
      const closeDelimiter = openTrim === '$$' ? '$$' : openTrim === '\\[' ? '\\]' : null;
      if (closeDelimiter) {
        let closeIdx = -1;
        for (let j = i + 1; j < children.length; j++) {
          const candidate = children[j];
          if (candidate.node.type.name !== 'paragraph') break;
          if (candidate.text.trim() === closeDelimiter) {
            closeIdx = j;
            break;
          }
        }
        if (closeIdx > i + 1) {
          const innerLines = children.slice(i + 1, closeIdx).map((c) => c.text);
          const expr = innerLines.join('\n').trim();
          if (expr.length > 0) {
            const close = children[closeIdx];
            const firstInner = children[i + 1];
            const blockParagraphs: LatexBlockParagraphMeta[] = [];
            for (let k = i; k <= closeIdx; k++) {
              const p = children[k];
              consumedParagraphs.add(p.pos);
              blockParagraphs.push({
                pos: p.pos,
                size: p.node.nodeSize,
                contentFrom: p.pos + 1,
                contentTo: p.pos + 1 + p.node.content.size,
                isDelimiterOnly: k === i || k === closeIdx,
              });
            }
            spans.push({
              from: open.pos + 1,
              to: close.pos + 1 + close.node.content.size,
              innerFrom: firstInner.pos + 1,
              widgetPos: close.pos + close.node.nodeSize,
              expr,
              displayMode: true,
              blockParagraphs,
            });
            i = closeIdx + 1;
            continue;
          }
        }
      }
    }

    if (!open.node.isLeaf && !open.node.isTextblock && open.node.childCount > 0) {
      collectMultiParagraphSpans(open.node, open.pos + 1, spans, consumedParagraphs);
    }
    i += 1;
  }
}

/**
 * Scan a ProseMirror document for inline ($...$, \(...\)) and display ($$...$$, \[...\])
 * LaTeX equations, ignoring code blocks, inline code marks, currency ($100), and escaped \$.
 */
export function findLatexSpansInDoc(doc: ProseMirrorNode): LatexSpan[] {
  const spans: LatexSpan[] = [];
  const consumedParagraphs = new Set<number>();

  // 1. Multi-paragraph display blocks (paragraph "$$" ... paragraph "$$")
  collectMultiParagraphSpans(doc, 0, spans, consumedParagraphs);

  // 2. Single-textblock pass (inline & display within a single paragraph/heading/etc.)
  doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock') return false;
    if (!node.isTextblock) return true;
    if (consumedParagraphs.has(pos)) return false;

    let text = '';
    const posMap: number[] = [];
    const isProtected: boolean[] = [];

    node.forEach((child, offset) => {
      const childStart = pos + 1 + offset;
      if (child.isText && child.text) {
        const hasCodeMark = child.marks.some((m) => m.type.name === 'code');
        const str = child.text;
        for (let k = 0; k < str.length; k++) {
          text += str[k];
          posMap.push(childStart + k);
          isProtected.push(hasCodeMark);
        }
      } else if (child.type.name === 'hardBreak') {
        text += '\n';
        posMap.push(childStart);
        isProtected.push(false);
      } else {
        text += '\ufffc';
        posMap.push(childStart);
        isProtected.push(true);
      }
    });

    if (!text) return false;
    // Fast skip when text contains neither '$' nor '\'
    if (!text.includes('$') && !text.includes('\\')) return false;

    const usedRanges: Array<[number, number]> = [];
    const hasOverlap = (start: number, end: number) =>
      usedRanges.some(([s, e]) => start < e && end > s);
    const containsProtected = (start: number, end: number) => {
      for (let idx = start; idx < end; idx++) {
        if (isProtected[idx]) return true;
      }
      return false;
    };

    // 2a. Display math: $$...$$ or \[...\]
    const displayRegex = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g;
    let m: RegExpExecArray | null;
    while ((m = displayRegex.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      const rawInner = m[1] ?? m[2] ?? '';
      const expr = rawInner.trim();
      if (!expr || containsProtected(start, end)) continue;

      const from = posMap[start];
      const to = posMap[end - 1] + 1;
      const innerStartIdx = Math.min(start + 2, end - 1);
      usedRanges.push([start, end]);
      spans.push({
        from,
        to,
        innerFrom: posMap[innerStartIdx],
        widgetPos: to,
        expr,
        displayMode: true,
      });
    }

    // 2b. Inline math: $...$ or \(...\) (avoids currency like "$100 to $200" and escaped \$)
    const inlineRegex = /(?<!\\)\$(?!\s|\d+(?:[.,]\d+)?\s)([^\n$]+?)(?<!\s|\\)\$(?!\d)|\\\(([^\n]+?)\\\)/g;
    while ((m = inlineRegex.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (hasOverlap(start, end) || containsProtected(start, end)) continue;

      const isParen = m[2] !== undefined;
      const rawInner = m[1] ?? m[2] ?? '';
      const expr = rawInner.trim();
      if (!expr) continue;

      const from = posMap[start];
      const to = posMap[end - 1] + 1;
      const innerStartIdx = Math.min(start + (isParen ? 2 : 1), end - 1);
      usedRanges.push([start, end]);
      spans.push({
        from,
        to,
        innerFrom: posMap[innerStartIdx],
        widgetPos: to,
        expr,
        displayMode: false,
      });
    }

    return false;
  });

  spans.sort((a, b) => a.from - b.from);
  return spans;
}

function selectionIntersectsSpan(selection: Selection, span: LatexSpan): boolean {
  return selection.from <= span.to && selection.to >= span.from;
}

function createRenderedMathWidget(span: LatexSpan): (view: EditorView) => HTMLElement {
  return (view: EditorView) => {
    const tag = span.displayMode ? 'div' : 'span';
    const el = document.createElement(tag);
    el.className = span.displayMode
      ? 'forma-latex-widget forma-latex-display'
      : 'forma-latex-widget forma-latex-inline';
    el.setAttribute('contenteditable', 'false');
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '-1');
    el.title = 'Click to edit LaTeX';
    el.innerHTML = renderLatexToSanitizedHtml(span.expr, span.displayMode);

    el.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const maxPos = view.state.doc.content.size;
      const targetPos = Math.max(0, Math.min(span.innerFrom, maxPos));
      const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, targetPos));
      view.dispatch(tr);
      view.focus();
    });

    return el;
  };
}

function createLivePreviewWidget(span: LatexSpan): () => HTMLElement {
  return () => {
    const tag = span.displayMode ? 'div' : 'span';
    const el = document.createElement(tag);
    el.className = span.displayMode
      ? 'forma-latex-live-preview forma-latex-live-preview-display no-print'
      : 'forma-latex-live-preview forma-latex-live-preview-inline no-print';
    el.setAttribute('contenteditable', 'false');
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = renderLatexToSanitizedHtml(span.expr, span.displayMode);
    return el;
  };
}

function buildLatexDecorations(doc: ProseMirrorNode, selection: Selection): DecorationSet {
  const spans = findLatexSpansInDoc(doc);
  if (spans.length === 0) return DecorationSet.empty;

  const decorations: Decoration[] = [];

  for (const span of spans) {
    const editing = selectionIntersectsSpan(selection, span);
    if (editing) {
      if (span.blockParagraphs) {
        for (const p of span.blockParagraphs) {
          if (p.contentFrom < p.contentTo) {
            decorations.push(
              Decoration.inline(p.contentFrom, p.contentTo, {
                class: 'forma-latex-source-editing',
              })
            );
          }
        }
      } else {
        decorations.push(
          Decoration.inline(span.from, span.to, {
            class: 'forma-latex-source-editing',
          })
        );
      }

      decorations.push(
        Decoration.widget(span.widgetPos, createLivePreviewWidget(span), {
          side: 1,
          ignoreSelection: true,
          key: `latex-preview:${span.from}:${span.displayMode ? 'D' : 'I'}:${span.expr}`,
        })
      );
    } else {
      if (span.blockParagraphs) {
        for (const p of span.blockParagraphs) {
          if (p.contentFrom < p.contentTo) {
            decorations.push(
              Decoration.inline(p.contentFrom, p.contentTo, {
                class: 'forma-latex-source-hidden',
              })
            );
          }
          if (p.isDelimiterOnly) {
            decorations.push(
              Decoration.node(p.pos, p.pos + p.size, {
                class: 'forma-latex-block-hidden',
              })
            );
          }
        }
      } else {
        decorations.push(
          Decoration.inline(span.from, span.to, {
            class: 'forma-latex-source-hidden',
          })
        );
      }

      decorations.push(
        Decoration.widget(span.widgetPos, createRenderedMathWidget(span), {
          side: 1,
          ignoreSelection: true,
          key: `latex-widget:${span.from}:${span.displayMode ? 'D' : 'I'}:${span.expr}`,
        })
      );
    }
  }

  return DecorationSet.create(doc, decorations);
}

export const liveLatexKey = new PluginKey<DecorationSet>('formaLiveLatex');

export const LiveLatexMath = Extension.create({
  name: 'formaLiveLatex',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: liveLatexKey,
        state: {
          init: (_config, state) => buildLatexDecorations(state.doc, state.selection),
          apply: (tr, oldSet, _oldState, newState) => {
            if (!tr.docChanged && !tr.selectionSet) return oldSet;
            return buildLatexDecorations(newState.doc, newState.selection);
          },
        },
        props: {
          decorations(state) {
            return liveLatexKey.getState(state) ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});
