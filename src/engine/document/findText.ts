import { Extension } from '@tiptap/core';
import { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface TextMatch { from: number; to: number }

export function findText(doc: ProseMirrorNode, query: string): TextMatch[] {
  if (!query) return [];
  const matches: TextMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    // Leaf placeholders retain ProseMirror offsets across inline images and breaks.
    const text = node.textBetween(0, node.content.size, '', '\ufffc').toLocaleLowerCase();
    const needle = query.toLocaleLowerCase();
    let offset = text.indexOf(needle);
    while (offset !== -1) {
      matches.push({ from: pos + 1 + offset, to: pos + 1 + offset + query.length });
      offset = text.indexOf(needle, offset + needle.length);
    }
    return false;
  });
  return matches;
}

export const searchKey = new PluginKey<{query: string; active: number}>('formaSearch');
export const SearchHighlights = Extension.create({
  name: 'formaSearch',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: searchKey,
      state: {
        init: () => ({ query: '', active: 0 }),
        apply: (tr, value) => tr.getMeta(searchKey) ?? value,
      },
      props: {
        decorations(state) {
          const search = searchKey.getState(state);
          if (!search?.query) return DecorationSet.empty;
          return DecorationSet.create(state.doc, findText(state.doc, search.query).map((match, i) =>
            Decoration.inline(match.from, match.to, { class: i === search.active ? 'forma-find-active' : 'forma-find-match' })
          ));
        },
      },
    })];
  },
});
