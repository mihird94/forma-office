import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Extension } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { EditorState } from '@tiptap/pm/state';
import { findText, searchKey, SearchHighlights } from '../../engine/document/findText';
import { LiveLatexMath } from '../../engine/document/liveLatex';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import TextStyle from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import FontFamily from '@tiptap/extension-font-family';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import CharacterCount from '@tiptap/extension-character-count';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Link2,
  PenTool,
  RefreshCw,
  Sparkles,
  Table as TableIcon,
} from 'lucide-react';
import {
  DocComment,
  DocsViewMode,
  DocumentPageSettings,
  FormaDocument,
  OutlineHeading,
} from '../../types/document';
import { LabFolderWorkspace } from '../../types/notebook';
import { DocumentExportFormat } from '../../types/office';
import {
  exportDocumentToMarkdown,
  importDocumentFromMarkdown,
  parseMarkdownToTiptapHtml,
} from '../../engine/document/formats/markdownCodec';
import {
  exportDocumentToHtml,
  exportRawHtmlWithComments,
  importDocumentFromHtml,
} from '../../engine/document/formats/htmlCodec';
import { extractDocVisuals } from '../../engine/document/mermaidSvg';
import { uid } from '../../engine/spreadsheet/workbookOps';
import {
  isNativeWorkspaceAvailable,
  writeBinaryWorkspaceFile,
  writeWorkspaceFile,
} from '../../storage/notebookStore';
import { triggerFileDownload, wasNativeSaveCancelled } from '../../storage/workspaceStore';
import { loadFilePosition, saveFilePosition } from '../../storage/sessionStore';
import { DocsRibbon } from './DocsRibbon';
import { DocsOutline } from './DocsOutline';
import { DocsCommentsPanel } from './DocsCommentsPanel';
import { HtmlReviewWorkspace } from './HtmlReviewWorkspace';
import { FindReplaceBar } from './FindReplaceBar';
import { ContextMenu, ContextMenuItem } from '../common/ContextMenu';
import {
  READING_THEME_STYLES,
  ReadingTheme,
  loadReadingTheme,
} from '../common/ReadingModePicker';
import { ZoomControl } from '../common/ZoomControl';
import { useAppZoom } from '../../utils/useAppZoom';
import { sanitizeDocumentHtml } from '../../utils/documentSecurity';

const DocumentPageBreaks = Extension.create({
  name: 'formaPageBreaks',
  addGlobalAttributes() {
    return [{
      types: ['hardBreak', 'horizontalRule'],
      attributes: {
        pageBreak: {
          default: false,
          parseHTML: (el: HTMLElement) => el.classList.contains('page-break'),
          renderHTML: (attributes: { pageBreak?: boolean }) => attributes.pageBreak ? { class: 'page-break' } : {},
        },
      },
    }];
  },
});

const LinkedTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      formaSource: {
        default: null,
        parseHTML: (el: HTMLElement) =>
          el.getAttribute('data-forma-source') ??
          el.closest('[data-forma-source]')?.getAttribute('data-forma-source') ??
          null,
        renderHTML: (attrs: { formaSource?: string | null }) =>
          attrs.formaSource ? { 'data-forma-source': attrs.formaSource } : {},
      },
    };
  },
});

const LinkedImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      formaCanvas: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-forma-canvas') ?? null,
        renderHTML: (attrs: { formaCanvas?: string | null }) =>
          attrs.formaCanvas ? { 'data-forma-canvas': attrs.formaCanvas } : {},
      },
    };
  },
});

function parseCanvasTag(tag: string): { canvasId: string; title: string } {
  const colonIdx = tag.indexOf(':');
  if (colonIdx === -1) return { canvasId: tag.trim(), title: tag.trim() };
  const canvasId = tag.slice(0, colonIdx).trim();
  const title = tag.slice(colonIdx + 1).trim() || canvasId;
  return { canvasId, title };
}

function extractLinkedCanvasTags(html: string): string[] {
  if (!html || !html.includes('data-forma-canvas')) return [];
  const seenIds = new Set<string>();
  const out: string[] = [];
  const regex = /data-forma-canvas="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    const val = m[1].trim();
    if (!val) continue;
    const { canvasId } = parseCanvasTag(val);
    if (canvasId && !seenIds.has(canvasId)) {
      seenIds.add(canvasId);
      out.push(val);
    }
  }
  return out;
}

function replaceLinkedCanvasHtml(
  currentHtml: string,
  canvasId: string,
  freshSrc: string,
  freshTitle: string
): string {
  const parser = new DOMParser();
  const parsed = parser.parseFromString(currentHtml || '<p></p>', 'text/html');
  const nextTag = `${canvasId}:${freshTitle}`;
  const imgs = Array.from(parsed.body.querySelectorAll('img[data-forma-canvas]'));
  for (const img of imgs) {
    const rawTag = img.getAttribute('data-forma-canvas') ?? '';
    if (parseCanvasTag(rawTag).canvasId === canvasId) {
      img.setAttribute('src', freshSrc);
      img.setAttribute('alt', freshTitle);
      img.setAttribute('data-forma-canvas', nextTag);
    }
  }
  return parsed.body.innerHTML;
}

function escapeSimpleHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function propagateFormaSourceToTables(html: string, fallbackSourceTag?: string): string {
  if (!html) return html;
  try {
    const parser = new DOMParser();
    const parsed = parser.parseFromString(html, 'text/html');
    const wrappers = Array.from(parsed.body.querySelectorAll('[data-forma-source]'));
    for (const el of wrappers) {
      const tag = el.getAttribute('data-forma-source');
      if (!tag) continue;
      if (el.tagName.toLowerCase() !== 'table') {
        const innerTable = el.querySelector('table');
        if (innerTable && !innerTable.getAttribute('data-forma-source')) {
          innerTable.setAttribute('data-forma-source', tag);
        }
      }
    }
    if (fallbackSourceTag) {
      const hasTagged = parsed.body.querySelector('table[data-forma-source]');
      if (!hasTagged) {
        const firstTable = parsed.body.querySelector('table');
        if (firstTable) {
          firstTable.setAttribute('data-forma-source', fallbackSourceTag);
        }
      }
    }
    return parsed.body.innerHTML;
  } catch {
    return html;
  }
}

function extractLinkedSources(html: string): string[] {
  if (!html || !html.includes('data-forma-source')) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const regex = /data-forma-source="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    const val = m[1].trim();
    if (val && !seen.has(val)) {
      seen.add(val);
      out.push(val);
    }
  }
  return out;
}

function replaceLinkedSourceHtml(currentHtml: string, sourceTag: string, freshHtml: string): string {
  const parser = new DOMParser();
  const parsed = parser.parseFromString(currentHtml || '<p></p>', 'text/html');
  const normalizedFresh = propagateFormaSourceToTables(freshHtml, sourceTag);
  const freshParsed = parser.parseFromString(normalizedFresh, 'text/html');
  const freshTable = freshParsed.body.querySelector('table');

  const matches = Array.from(parsed.body.querySelectorAll('[data-forma-source]')).filter(
    (el) => el.getAttribute('data-forma-source') === sourceTag
  );

  // Prefer replacing the outermost matched element if nested (e.g. div wrapping table)
  const topMatches = matches.filter(
    (el) => !matches.some((other) => other !== el && other.contains(el))
  );

  for (const target of topMatches) {
    if (target.tagName.toLowerCase() === 'table' && freshTable) {
      const replacement = freshTable.cloneNode(true) as HTMLElement;
      replacement.setAttribute('data-forma-source', sourceTag);
      target.replaceWith(replacement);
    } else {
      const frag = parsed.createDocumentFragment();
      for (const child of Array.from(freshParsed.body.childNodes)) {
        frag.appendChild(child.cloneNode(true));
      }
      target.replaceWith(frag);
    }
  }

  return parsed.body.innerHTML;
}

function formatSourceTagLabel(sourceTag: string): string {
  const colonIdx = sourceTag.indexOf(':');
  return colonIdx >= 0 ? sourceTag.slice(colonIdx + 1) : sourceTag;
}

function resolveInitialDocHtml(doc: FormaDocument): string {
  if (
    doc.markdownSource &&
    (doc.sourceFormat === 'md' || /\$[^$\n]*<em>/.test(doc.html)) &&
    /\$[^$\n]*<em>/.test(doc.html)
  ) {
    return parseMarkdownToTiptapHtml(doc.markdownSource);
  }
  return sanitizeDocumentHtml(doc.html);
}

function extractWikilinks(html: string): string[] {
  if (!html || !html.includes('[[')) return [];
  const stripped = html
    .replace(/<(pre|code|script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const seen = new Set<string>();
  const out: string[] = [];
  const regex = /\[\[([^\]|\n]+?)(?:\|[^\]\n]+?)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(stripped)) !== null) {
    const title = m[1].trim();
    if (title && !seen.has(title)) {
      seen.add(title);
      out.push(title);
    }
  }
  return out;
}

function findWikilinkAtOffset(text: string, offset: number): string | null {
  if (!text || !text.includes('[[')) return null;
  const regex = /\[\[([^\]|\n]+?)(?:\|[^\]\n]+?)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (offset >= start && offset <= end) {
      const title = m[1].trim();
      return title || null;
    }
  }
  return null;
}

export interface DocsAppProps {
  document: FormaDocument;
  editorStates: Map<string, { html: string; state: EditorState }>;
  onChangeDocument: (doc: FormaDocument) => void;
  onPendingChange: (id: string, pending: boolean) => void;
  onImportNewDocument: (doc: FormaDocument) => void;
  pendingInsertedHtml?: { html: string; label: string; nonce: number; kind?: 'table' | 'canvas' } | null;
  onClearPendingInsert: () => void;
  onNotify: (msg: string) => void;
  docsFolder?: LabFolderWorkspace | null;
  onPickDocsFolder?: () => void;
  onOpenFolderDoc?: (path: string) => void;
  onOpenWikilink?: (title: string) => void;
  onRefreshLinkedTable?: (sourceTag: string) => string | null;
  onRefreshLinkedCanvas?: (canvasId: string) => { src: string; title: string } | null;
}

export interface DocumentEditorHandle {
  id: string;
  snapshot: () => FormaDocument;
}

export const DocsApp = forwardRef<DocumentEditorHandle, DocsAppProps>(({
  document: doc,
  editorStates,
  onChangeDocument,
  onPendingChange,
  onImportNewDocument,
  pendingInsertedHtml,
  onClearPendingInsert,
  onNotify,
  docsFolder,
  onPickDocsFolder,
  onOpenFolderDoc,
  onOpenWikilink,
  onRefreshLinkedTable,
  onRefreshLinkedCanvas,
}, ref) => {
  const [showFindReplace, setShowFindReplace] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<'outline' | 'folder'>(() =>
    docsFolder ? 'folder' : 'outline'
  );
  const [showComments, setShowComments] = useState(false);
  const [showVisualsTray, setShowVisualsTray] = useState(true);
  const [selectedQuote, setSelectedQuote] = useState('');
  const [pendingPin, setPendingPin] = useState<DocComment['pin']>();
  const [selectedComment, setSelectedComment] = useState<string>();
  const [viewMode, setViewMode] = useState<DocsViewMode>(
    () => loadFilePosition(doc.id)?.docsViewMode ?? 'preview'
  );
  const [markdownText, setMarkdownText] = useState<string>(
    () => doc.markdownSource ?? exportDocumentToMarkdown(doc)
  );
  const [headings, setHeadings] = useState<OutlineHeading[]>([]);
  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);
  const [readingTheme, setReadingTheme] = useState<ReadingTheme>(() => loadReadingTheme());
  const { zoom, zoomIn, zoomOut, zoomReset } = useAppZoom({
    initial: 1.0,
    min: 0.6,
    max: 2.0,
    step: 0.1,
  });
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [findQuery, setFindQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const [docRevision, setDocRevision] = useState(0);

  const docRef = useRef(doc);
  docRef.current = doc;
  const onChangeDocRef = useRef(onChangeDocument);
  onChangeDocRef.current = onChangeDocument;
  const onOpenWikilinkRef = useRef(onOpenWikilink);
  onOpenWikilinkRef.current = onOpenWikilink;
  const prevDocsFolderRef = useRef<LabFolderWorkspace | null | undefined>(docsFolder);
  const lastSyncedHtmlRef = useRef(doc.html);
  const mdTextRef = useRef(markdownText);
  mdTextRef.current = markdownText;
  const mdTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dirtyUpdateRef = useRef(false);
  const dirtyMdRef = useRef(false);
  const applyingMdToEditorRef = useRef(false);
  const updateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const metaTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchActiveRef = useRef(false);

  const refreshDocMeta = (ed: NonNullable<ReturnType<typeof useEditor>>) => {
    const found: OutlineHeading[] = [];
    let idx = 0;
    ed.state.doc.descendants((node, pos) => {
      if (node.type.name === 'heading' && node.attrs.level <= 3) {
        const text = node.textContent.trim();
        if (text) {
          found.push({
            id: `h_${idx++}_${pos}`,
            level: node.attrs.level as 1 | 2 | 3,
            text,
            pos,
          });
        }
      }
    });
    setHeadings(found);
    setWordCount(ed.storage.characterCount?.words?.() ?? 0);
    setCharCount(ed.storage.characterCount?.characters?.() ?? 0);
  };

  const flushPendingHtml = (ed: ReturnType<typeof useEditor>) => {
    if (updateTimerRef.current) {
      clearTimeout(updateTimerRef.current);
      updateTimerRef.current = null;
    }
    if (mdTimerRef.current) {
      clearTimeout(mdTimerRef.current);
      mdTimerRef.current = null;
    }
    if (dirtyMdRef.current) {
      dirtyMdRef.current = false;
      dirtyUpdateRef.current = false;
      const rawMd = mdTextRef.current;
      const html = parseMarkdownToTiptapHtml(rawMd);
      lastSyncedHtmlRef.current = html;
      if (ed) {
        applyingMdToEditorRef.current = true;
        ed.commands.setContent(html, false);
        ed.view.updateState(EditorState.create({ doc: ed.state.doc, plugins: ed.state.plugins }));
        applyingMdToEditorRef.current = false;
        editorStates.set(docRef.current.id, { state: ed.state, html });
        refreshDocMeta(ed);
        if (searchActiveRef.current) setDocRevision((v) => v + 1);
      }
      const snapshot: FormaDocument = {
        ...docRef.current,
        html,
        markdownSource: rawMd,
        sourceFormat: docRef.current.sourceFormat ?? 'md',
        updatedAt: Date.now(),
      };
      docRef.current = snapshot;
      onChangeDocRef.current(snapshot);
      onPendingChange(snapshot.id, false);
      return snapshot;
    }
    if (!ed || !dirtyUpdateRef.current) return docRef.current;
    dirtyUpdateRef.current = false;
    const html = ed.getHTML();
    lastSyncedHtmlRef.current = html;
    editorStates.set(docRef.current.id, { state: ed.state, html });
    const nextMd = exportDocumentToMarkdown({ ...docRef.current, html });
    mdTextRef.current = nextMd;
    setMarkdownText(nextMd);
    const snapshot: FormaDocument = {
      ...docRef.current,
      html,
      markdownSource:
        docRef.current.sourceFormat === 'md' || docRef.current.markdownSource !== undefined
          ? nextMd
          : docRef.current.markdownSource,
      updatedAt: Date.now(),
    };
    docRef.current = snapshot;
    onChangeDocRef.current(snapshot);
    onPendingChange(snapshot.id, false);
    return snapshot;
  };

  const editor = useEditor({
    extensions: [
      StarterKit,
      DocumentPageBreaks,
      SearchHighlights,
      LiveLatexMath,
      Underline,
      TextStyle,
      Color,
      FontFamily,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      LinkedTable.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      TaskList,
      TaskItem.configure({ nested: true }),
      Link.configure({ openOnClick: false }),
      LinkedImage.configure({ allowBase64: true }),
      Subscript,
      Superscript,
      CharacterCount,
      Placeholder.configure({
        placeholder: 'Start typing your document, or import .docx / .odt / .md...',
      }),
    ],
    content: resolveInitialDocHtml(doc),
    editorProps: {
      attributes: {
        class: 'forma-doc-editor',
      },
      handleDOMEvents: {
        click: (view, event) => {
          if (!(event.metaKey || event.ctrlKey)) return false;
          const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
          if (!coords) return false;
          const $pos = view.state.doc.resolve(coords.pos);
          const title = findWikilinkAtOffset($pos.parent.textContent, $pos.parentOffset);
          if (title) {
            event.preventDefault();
            onOpenWikilinkRef.current?.(title);
            return true;
          }
          return false;
        },
      },
    },
    onCreate: ({ editor: ed }) => {
      const cached = editorStates.get(doc.id);
      if (cached?.html === doc.html) ed.view.updateState(cached.state);
      lastSyncedHtmlRef.current = doc.html;
      refreshDocMeta(ed);
    },
    onSelectionUpdate: ({ editor: ed }) => {
      const { from, to } = ed.state.selection;
      if (from !== to) {
        const snippet = ed.state.doc.textBetween(from, to, ' ').trim();
        if (snippet) {
          setSelectedQuote(snippet.slice(0, 240));
        }
      }
    },
    onTransaction: ({ editor: ed }) => {
      // O(1) snapshot of EditorState (preserves per-doc Undo stack without expensive getHTML())
      editorStates.set(docRef.current.id, { state: ed.state, html: lastSyncedHtmlRef.current });
    },
    onUpdate: ({ editor: ed }) => {
      if (applyingMdToEditorRef.current) return;
      if (!dirtyUpdateRef.current) onPendingChange(docRef.current.id, true);
      dirtyUpdateRef.current = true;
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
      updateTimerRef.current = setTimeout(() => {
        updateTimerRef.current = null;
        flushPendingHtml(ed);
      }, 220);

      if (metaTimerRef.current) clearTimeout(metaTimerRef.current);
      metaTimerRef.current = setTimeout(() => {
        metaTimerRef.current = null;
        refreshDocMeta(ed);
        if (searchActiveRef.current) setDocRevision((v) => v + 1);
      }, 280);
    },
  });

  // Auto-open Folder sidebar when a local docsFolder is attached
  useEffect(() => {
    if (docsFolder && docsFolder !== prevDocsFolderRef.current) {
      setShowSidebar(true);
      setSidebarTab('folder');
    }
    prevDocsFolderRef.current = docsFolder;
  }, [docsFolder]);

  // Save/export callers need the live editor snapshot even during the debounce.
  useImperativeHandle(ref, () => ({ id: doc.id, snapshot: () => flushPendingHtml(editor) }));

  // Flush any debounced edit synchronously on unmount (tab switch) or window close
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyUpdateRef.current || dirtyMdRef.current) {
        event.preventDefault();
        event.returnValue = '';
      }
      flushPendingHtml(editor);
    };
    const onVisibilityChange = () => {
      if (window.document.visibilityState === 'hidden') flushPendingHtml(editor);
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.document.removeEventListener('visibilitychange', onVisibilityChange);
      if (metaTimerRef.current) {
        clearTimeout(metaTimerRef.current);
        metaTimerRef.current = null;
      }
      flushPendingHtml(editor);
    };
  }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!editor) return;
    // Skip expensive editor.getHTML() when doc.html matches what we ourselves last emitted
    if (doc.html !== lastSyncedHtmlRef.current) {
      const nextContentHtml = resolveInitialDocHtml(doc);
      if (editor.getHTML() !== nextContentHtml) {
        applyingMdToEditorRef.current = true;
        editor.commands.setContent(nextContentHtml, false);
        // An external revision starts a fresh history for this document.
        editor.view.updateState(EditorState.create({ doc: editor.state.doc, plugins: editor.state.plugins }));
        applyingMdToEditorRef.current = false;
      }
      lastSyncedHtmlRef.current = doc.html;
      const nextMd = doc.markdownSource ?? exportDocumentToMarkdown(doc);
      mdTextRef.current = nextMd;
      setMarkdownText(nextMd);
      editorStates.set(doc.id, { state: editor.state, html: doc.html });
      refreshDocMeta(editor);
    }
  }, [doc.id, doc.html, doc.markdownSource, editor, editorStates]);

  // Handle cross-app table / canvas diagram insert from Forma Sheets & Forma Canvas
  useEffect(() => {
    if (!editor || !pendingInsertedHtml) return;
    const cached = editorStates.get(doc.id);
    if (cached?.html === doc.html) {
      editor.view.updateState(cached.state);
    }
    if (pendingInsertedHtml.kind === 'canvas') {
      const safeLabel = escapeSimpleHtml(pendingInsertedHtml.label);
      const snippet = `<h3>${safeLabel}</h3>${pendingInsertedHtml.html}<p></p>`;
      editor.chain().focus('end').insertContent(sanitizeDocumentHtml(snippet)).run();
      onNotify(`Embedded canvas diagram "${pendingInsertedHtml.label}"`);
    } else {
      const normalizedTableHtml = propagateFormaSourceToTables(pendingInsertedHtml.html);
      const snippet = `<h3>Table from ${escapeSimpleHtml(pendingInsertedHtml.label)}</h3>${normalizedTableHtml}<p></p>`;
      editor.chain().focus('end').insertContent(snippet).run();
      onNotify(`Inserted table from ${pendingInsertedHtml.label}`);
    }
    onClearPendingInsert();
  }, [editor, pendingInsertedHtml, onClearPendingInsert, onNotify]);

  // Cmd/Ctrl+F opens Find & Replace
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setShowFindReplace(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const paperWidthClass = useMemo(
    () => (doc.pageSettings.pageSize === 'a4' ? 'max-w-[794px]' : 'max-w-[816px]'),
    [doc.pageSettings.pageSize]
  );

  const paperPaddingClass = useMemo(() => {
    switch (doc.pageSettings.margins) {
      case 'narrow':
        return 'px-10 py-10';
      case 'wide':
        return 'px-24 py-16';
      default:
        return 'px-16 py-14';
    }
  }, [doc.pageSettings.margins]);

  const handleUpdatePageSettings = (patch: Partial<DocumentPageSettings>) => {
    const snapshot = flushPendingHtml(editor);
    onChangeDocument({
      ...snapshot,
      pageSettings: { ...snapshot.pageSettings, ...patch },
      updatedAt: Date.now(),
    });
  };

  useEffect(() => {
    setViewMode(loadFilePosition(doc.id)?.docsViewMode ?? 'preview');
  }, [doc.id]);

  const activeQuery = showFindReplace ? findQuery : '';
  const richQuery = viewMode === 'markdown' ? '' : activeQuery;
  searchActiveRef.current = Boolean(activeQuery);
  const matches = useMemo(() => {
    if (!activeQuery) return [];
    if (viewMode === 'markdown') {
      const needle = activeQuery.toLowerCase();
      const hay = markdownText.toLowerCase();
      const out: { from: number; to: number }[] = [];
      let idx = 0;
      while (idx <= hay.length - needle.length) {
        const hit = hay.indexOf(needle, idx);
        if (hit === -1) break;
        out.push({ from: hit, to: hit + activeQuery.length });
        idx = hit + Math.max(1, needle.length);
      }
      return out;
    }
    return editor ? findText(editor.state.doc, activeQuery) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, activeQuery, viewMode, markdownText, docRevision]);
  const currentMatch = matches.length ? Math.min(matchIndex, matches.length - 1) : 0;
  const hadSearchHighlightRef = useRef(false);
  useEffect(() => {
    if (!editor) return;
    if (!richQuery && !hadSearchHighlightRef.current) return;
    hadSearchHighlightRef.current = Boolean(richQuery);
    editor.view.dispatch(editor.state.tr.setMeta(searchKey, { query: richQuery, active: currentMatch }));
  }, [editor, richQuery, currentMatch]);

  const navigateMatch = (direction: number) => {
    if (!matches.length) return;
    const next = (currentMatch + direction + matches.length) % matches.length;
    setMatchIndex(next);
    if (viewMode === 'markdown') {
      const ta = mdTextareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(matches[next].from, matches[next].to);
      }
      return;
    }
    if (!editor) return;
    editor.commands.setTextSelection(matches[next]);
    editor.commands.scrollIntoView();
  };

  const handleReplaceAll = (findValue: string, replacement: string): number => {
    if (!findValue) return 0;
    if (viewMode === 'markdown') {
      const needle = findValue.toLowerCase();
      const src = mdTextRef.current;
      const lower = src.toLowerCase();
      let idx = 0;
      let count = 0;
      let rebuilt = '';
      while (idx < src.length) {
        const hit = lower.indexOf(needle, idx);
        if (hit === -1) {
          rebuilt += src.slice(idx);
          break;
        }
        rebuilt += src.slice(idx, hit) + replacement;
        idx = hit + findValue.length;
        count += 1;
      }
      if (count > 0) {
        mdTextRef.current = rebuilt;
        setMarkdownText(rebuilt);
        dirtyMdRef.current = true;
        flushPendingHtml(editor);
      }
      setMatchIndex(0);
      return count;
    }
    if (!editor) return 0;
    flushPendingHtml(editor);
    const found = findText(editor.state.doc, findValue);
    const tr = editor.state.tr;
    for (const match of [...found].reverse()) tr.insertText(replacement, match.from, match.to);
    editor.view.dispatch(tr);
    flushPendingHtml(editor);
    setMatchIndex(0);
    return found.length;
  };

  const handleImportFile = async (file: File) => {
    try {
      const ext = file.name.split('.').pop()?.toLowerCase();
      let imported: FormaDocument;
      if (ext === 'docx') {
        const ab = await file.arrayBuffer();
        const { importDocumentFromDocx } = await import('../../engine/document/formats/docxCodec');
        imported = await importDocumentFromDocx(ab, file.name);
      } else if (ext === 'odt') {
        const ab = await file.arrayBuffer();
        const { importDocumentFromOdt } = await import('../../engine/document/formats/odtCodec');
        imported = await importDocumentFromOdt(ab, file.name);
      } else if (ext === 'md' || ext === 'markdown') {
        const text = await file.text();
        imported = importDocumentFromMarkdown(text, file.name);
      } else {
        const text = await file.text();
        imported = importDocumentFromHtml(text, file.name);
      }
      onImportNewDocument(imported);
      onNotify(`Imported ${file.name}`);
    } catch (err) {
      onNotify(`Import failed: ${(err as Error).message}`);
    }
  };

  const handleChangeViewMode = (nextMode: DocsViewMode) => {
    const snapshot = flushPendingHtml(editor);
    if (nextMode !== 'preview') {
      const md = snapshot.markdownSource ?? exportDocumentToMarkdown(snapshot);
      mdTextRef.current = md;
      setMarkdownText(md);
    }
    setViewMode(nextMode);
    saveFilePosition(snapshot.id, { docsViewMode: nextMode });
  };

  const handleMarkdownSourceChange = (nextMd: string) => {
    mdTextRef.current = nextMd;
    setMarkdownText(nextMd);
    if (!dirtyMdRef.current) onPendingChange(docRef.current.id, true);
    dirtyMdRef.current = true;
    if (mdTimerRef.current) clearTimeout(mdTimerRef.current);
    mdTimerRef.current = setTimeout(() => {
      mdTimerRef.current = null;
      flushPendingHtml(editor);
    }, 180);
  };

  const handleExport = async (format: DocumentExportFormat) => {
    const snapshot = flushPendingHtml(editor);
    const safeName = snapshot.title.replace(/[^a-zA-Z0-9._ -]/g, '_') || 'Document';
    try {
      let savedPath: string | undefined;
      if (format === 'docx') {
        const { exportDocumentToDocx } = await import('../../engine/document/formats/docxCodec');
        const bytes = await exportDocumentToDocx(snapshot);
        savedPath = await triggerFileDownload(
          bytes,
          `${safeName}.docx`,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        );
      } else if (format === 'odt') {
        const { exportDocumentToOdt } = await import('../../engine/document/formats/odtCodec');
        const bytes = await exportDocumentToOdt(snapshot);
        savedPath = await triggerFileDownload(
          bytes,
          `${safeName}.odt`,
          'application/vnd.oasis.opendocument.text'
        );
      } else if (format === 'md') {
        const md = snapshot.markdownSource ?? exportDocumentToMarkdown(snapshot);
        savedPath = await triggerFileDownload(md, `${safeName}.md`, 'text/markdown;charset=utf-8');
      } else {
        const html = snapshot.rawHtmlSource !== undefined ? exportRawHtmlWithComments(snapshot.rawHtmlSource, snapshot.comments) : exportDocumentToHtml(snapshot);
        savedPath = await triggerFileDownload(html, `${safeName}.html`, 'text/html;charset=utf-8');
      }
      if (wasNativeSaveCancelled(savedPath)) return;
      if (savedPath) {
        const updated: FormaDocument = {
          ...snapshot,
          nativePath: savedPath,
          sourceFormat: format,
          updatedAt: Date.now(),
        };
        docRef.current = updated;
        onChangeDocRef.current(updated);
      }
      onNotify(`Saved ${savedPath ? savedPath.split('/').pop() : `${safeName}.${format}`}`);
    } catch (err) {
      onNotify(`Export failed: ${(err as Error).message}`);
    }
  };

  const handleSavePrimary = async () => {
    const snapshot = flushPendingHtml(editor);
    const isMdPath = Boolean(snapshot.nativePath && /\.(md|markdown)$/i.test(snapshot.nativePath));
    const isHtmlPath = Boolean(snapshot.nativePath && /\.(html|htm)$/i.test(snapshot.nativePath));
    const fmt: DocumentExportFormat =
      snapshot.sourceFormat ??
      (isMdPath
        ? 'md'
        : snapshot.nativePath?.endsWith('.odt')
          ? 'odt'
          : isHtmlPath
            ? 'html'
            : 'docx');

    if (fmt === 'md' && snapshot.nativePath && isNativeWorkspaceAvailable()) {
      const mdOut = snapshot.markdownSource ?? exportDocumentToMarkdown(snapshot);
      const ok = await writeWorkspaceFile(snapshot.nativePath, mdOut);
      if (ok) {
        onNotify(`Saved ${snapshot.nativePath.split('/').pop()}`);
        return;
      }
    }
    if (fmt === 'html' && snapshot.nativePath && isNativeWorkspaceAvailable()) {
      const htmlOut = snapshot.rawHtmlSource !== undefined ? exportRawHtmlWithComments(snapshot.rawHtmlSource, snapshot.comments) : exportDocumentToHtml(snapshot);
      const ok = await writeWorkspaceFile(snapshot.nativePath, htmlOut);
      if (ok) {
        onNotify(`Saved ${snapshot.nativePath.split('/').pop()}`);
        return;
      }
    }
    if ((fmt === 'docx' || fmt === 'odt') && snapshot.nativePath && isNativeWorkspaceAvailable()) {
      const bytes =
        fmt === 'docx'
          ? await (await import('../../engine/document/formats/docxCodec')).exportDocumentToDocx(snapshot)
          : await (await import('../../engine/document/formats/odtCodec')).exportDocumentToOdt(snapshot);
      const ok = await writeBinaryWorkspaceFile(snapshot.nativePath, bytes);
      if (ok) {
        onNotify(`Saved ${snapshot.nativePath.split('/').pop()}`);
        return;
      }
    }
    await handleExport(fmt);
  };

  const comments: DocComment[] = doc.comments ?? [];
  const openCommentCount = useMemo(
    () => comments.filter((c) => !c.resolved).length,
    [comments]
  );

  const wikilinks = useMemo(() => extractWikilinks(doc.html), [doc.html]);
  const linkedSources = useMemo(() => extractLinkedSources(doc.html), [doc.html]);
  const linkedCanvases = useMemo(() => extractLinkedCanvasTags(doc.html), [doc.html]);
  const docVisuals = useMemo(
    () => extractDocVisuals(doc.html, viewMode === 'preview' ? undefined : markdownText),
    [doc.html, markdownText, viewMode]
  );
  const docDiagrams = useMemo(
    () => docVisuals.filter((v) => v.kind === 'mermaid'),
    [docVisuals]
  );

  const handleAddComment = (payload: { author: string; text: string; quote?: string; pin?: DocComment['pin'] }) => {
    const snapshot = flushPendingHtml(editor);
    const nextComment: DocComment = {
      id: uid('cmt'),
      author: payload.author,
      text: payload.text,
      quote: payload.quote,
      pin: payload.pin,
      resolved: false,
      createdAt: Date.now(),
    };
    const updated: FormaDocument = {
      ...snapshot,
      comments: [nextComment, ...(snapshot.comments ?? [])],
      updatedAt: Date.now(),
    };
    docRef.current = updated;
    onChangeDocument(updated);
    setSelectedQuote('');
    setPendingPin(undefined);
    onNotify('Added review comment');
  };

  const handleToggleResolveComment = (id: string) => {
    const snapshot = flushPendingHtml(editor);
    const updated: FormaDocument = {
      ...snapshot,
      comments: (snapshot.comments ?? []).map((c) =>
        c.id === id ? { ...c, resolved: !c.resolved } : c
      ),
      updatedAt: Date.now(),
    };
    docRef.current = updated;
    onChangeDocument(updated);
  };

  const handleDeleteComment = (id: string) => {
    const snapshot = flushPendingHtml(editor);
    const updated: FormaDocument = {
      ...snapshot,
      comments: (snapshot.comments ?? []).filter((c) => c.id !== id),
      updatedAt: Date.now(),
    };
    docRef.current = updated;
    onChangeDocument(updated);
  };

  const handleJumpToQuote = (quote: string) => {
    if (!editor || !quote.trim()) return;
    const found = findText(editor.state.doc, quote.trim());
    if (found.length > 0) {
      editor.chain().focus().setTextSelection(found[0]).scrollIntoView().run();
    }
  };

  const handleRefreshLinkedTableClick = (sourceTag: string) => {
    if (!onRefreshLinkedTable) {
      onNotify('Linked table refresh is not connected in standalone mode');
      return;
    }
    const freshHtml = onRefreshLinkedTable(sourceTag);
    if (!freshHtml) {
      onNotify(`Could not refresh ${formatSourceTagLabel(sourceTag)} — source sheet unavailable`);
      return;
    }
    const snapshot = flushPendingHtml(editor);
    const updatedHtml = replaceLinkedSourceHtml(snapshot.html, sourceTag, freshHtml);
    lastSyncedHtmlRef.current = updatedHtml;
    if (editor) {
      applyingMdToEditorRef.current = true;
      editor.commands.setContent(updatedHtml, false);
      applyingMdToEditorRef.current = false;
      editorStates.set(snapshot.id, { state: editor.state, html: updatedHtml });
      refreshDocMeta(editor);
    }
    const nextMd = exportDocumentToMarkdown({ ...snapshot, html: updatedHtml });
    mdTextRef.current = nextMd;
    setMarkdownText(nextMd);
    const updated: FormaDocument = {
      ...snapshot,
      html: updatedHtml,
      markdownSource:
        snapshot.sourceFormat === 'md' || snapshot.markdownSource !== undefined
          ? nextMd
          : snapshot.markdownSource,
      updatedAt: Date.now(),
    };
    docRef.current = updated;
    onChangeDocument(updated);
    onNotify(`Refreshed linked table (${formatSourceTagLabel(sourceTag)})`);
  };

  const handleRefreshLinkedCanvasClick = (canvasTag: string) => {
    const { canvasId, title } = parseCanvasTag(canvasTag);
    if (!onRefreshLinkedCanvas) {
      onNotify('Linked canvas refresh is not connected in standalone mode');
      return;
    }
    const fresh = onRefreshLinkedCanvas(canvasId);
    if (!fresh) {
      onNotify(`Could not refresh "${title}" — source canvas unavailable`);
      return;
    }
    const snapshot = flushPendingHtml(editor);
    const updatedHtml = replaceLinkedCanvasHtml(snapshot.html, canvasId, fresh.src, fresh.title);
    lastSyncedHtmlRef.current = updatedHtml;
    if (editor) {
      applyingMdToEditorRef.current = true;
      editor.commands.setContent(sanitizeDocumentHtml(updatedHtml), false);
      applyingMdToEditorRef.current = false;
      editorStates.set(snapshot.id, { state: editor.state, html: updatedHtml });
      refreshDocMeta(editor);
    }
    const nextMd = exportDocumentToMarkdown({ ...snapshot, html: updatedHtml });
    mdTextRef.current = nextMd;
    setMarkdownText(nextMd);
    const updated: FormaDocument = {
      ...snapshot,
      html: updatedHtml,
      markdownSource:
        snapshot.sourceFormat === 'md' || snapshot.markdownSource !== undefined
          ? nextMd
          : snapshot.markdownSource,
      updatedAt: Date.now(),
    };
    docRef.current = updated;
    onChangeDocument(updated);
    onNotify(`Refreshed linked canvas "${fresh.title}"`);
  };

  const handleClickFolderButton = () => {
    if (docsFolder) {
      if (showSidebar && sidebarTab === 'folder') {
        setSidebarTab('outline');
      } else {
        setShowSidebar(true);
        setSidebarTab('folder');
      }
    } else {
      setShowSidebar(true);
      setSidebarTab('folder');
      onPickDocsFolder?.();
    }
  };

  const handleCopySvg = async (svg: string) => {
    try {
      await navigator.clipboard.writeText(svg);
      onNotify('Copied Mermaid SVG to clipboard');
    } catch {
      onNotify('Could not copy SVG to clipboard');
    }
  };

  useEffect(() => {
    const w = window as unknown as { __formaToggleReadingMode?: () => void };
    const toggle = () => setShowSidebar((v) => !v);
    w.__formaToggleReadingMode = toggle;

    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        setShowSidebar((v) => !v);
      } else if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        if (e.shiftKey) {
          handleChangeViewMode(viewMode === 'split' ? 'preview' : 'split');
        } else {
          handleChangeViewMode(viewMode === 'preview' ? 'markdown' : 'preview');
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (w.__formaToggleReadingMode === toggle) delete w.__formaToggleReadingMode;
    };
  }, [viewMode]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <DocsRibbon
        editor={editor}
        fontFamily={doc.pageSettings.fontFamily}
        onChangeFontFamily={(fontFamily) => handleUpdatePageSettings({ fontFamily })}
        viewMode={viewMode}
        onChangeViewMode={handleChangeViewMode}
        sourceFormat={doc.sourceFormat}
        nativePath={doc.nativePath}
        onSavePrimary={() => void handleSavePrimary()}
        showFindReplace={showFindReplace}
        onToggleFindReplace={() => setShowFindReplace((v) => !v)}
        readingTheme={readingTheme}
        onSelectReadingTheme={setReadingTheme}
        onImportFile={handleImportFile}
        onExport={handleExport}
        showComments={showComments}
        openCommentCount={openCommentCount}
        onToggleComments={() => setShowComments((v) => !v)}
        hasDocsFolder={Boolean(docsFolder)}
        folderSidebarActive={showSidebar && sidebarTab === 'folder'}
        onClickFolderButton={handleClickFolderButton}
        onPrintPdf={() => {
          const webkit = (
            window as unknown as {
              webkit?: { messageHandlers?: { formaPrint?: { postMessage: (p: { title: string }) => void } } };
            }
          ).webkit;
          if (webkit?.messageHandlers?.formaPrint) {
            webkit.messageHandlers.formaPrint.postMessage({ title: doc.title });
          } else {
            window.print();
          }
        }}
      />

      {showFindReplace && (
        <FindReplaceBar
          query={findQuery}
          onQueryChange={(value) => { setFindQuery(value); setMatchIndex(0); }}
          matchCount={matches.length}
          matchIndex={currentMatch}
          onNavigate={navigateMatch}
          onReplaceAll={handleReplaceAll}
          onClose={() => setShowFindReplace(false)}
        />
      )}

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {showSidebar && (
          <DocsOutline
            headings={headings}
            pageSettings={doc.pageSettings}
            wordCount={wordCount}
            charCount={charCount}
            onJumpToPos={(pos) => {
              if (!editor) return;
              editor.chain().focus().setTextSelection(pos + 1).run();
              const domNode = editor.view.nodeDOM(pos) as HTMLElement | null;
              if (domNode && typeof domNode.scrollIntoView === 'function') {
                domNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
            }}
            onUpdatePageSettings={handleUpdatePageSettings}
            docsFolder={docsFolder}
            activeNativePath={doc.nativePath}
            sidebarTab={sidebarTab}
            onChangeSidebarTab={setSidebarTab}
            onPickDocsFolder={onPickDocsFolder}
            onOpenFolderDoc={onOpenFolderDoc}
            wikilinks={wikilinks}
            onOpenWikilink={onOpenWikilink}
          />
        )}

        {doc.rawHtmlSource !== undefined ? <HtmlReviewWorkspace
          key={doc.id}
          source={doc.rawHtmlSource}
          comments={comments}
          selectedComment={selectedComment}
          onSourceChange={(source) => {
            const snapshot = flushPendingHtml(editor);
            const html = sanitizeDocumentHtml(new DOMParser().parseFromString(source, 'text/html').body.innerHTML);
            const updated = { ...snapshot, rawHtmlSource: source, html, updatedAt: Date.now() };
            docRef.current = updated; onChangeDocument(updated);
          }}
          onPin={(pin) => { setPendingPin(pin); setShowComments(true); }}
          onSelection={(quote) => { setSelectedQuote(quote); setShowComments(true); }}
          onSelectComment={(id) => { setSelectedComment(id); setShowComments(true); }}
          onConvert={() => {
            if (!window.confirm('Convert this HTML to an editable document? Interactive content will be removed.')) return;
            const snapshot = flushPendingHtml(editor);
            const html = sanitizeDocumentHtml(new DOMParser().parseFromString(snapshot.rawHtmlSource ?? '', 'text/html').body.innerHTML);
            editor?.commands.setContent(html, false);
            lastSyncedHtmlRef.current = html;
            const updated = { ...snapshot, html, rawHtmlSource: undefined, updatedAt: Date.now() };
            docRef.current = updated; onChangeDocument(updated);
          }}
        /> : <>
        {/* Raw Markdown Source Editor Pane (shown in 'markdown' and 'split' modes) */}
        {(viewMode === 'markdown' || viewMode === 'split') && (
          <section
            style={{
              backgroundColor: readingTheme === 'dark' ? '#0f172a' : READING_THEME_STYLES[readingTheme].paperBg,
              borderColor: READING_THEME_STYLES[readingTheme].paperBorder,
            }}
            className={`${
              viewMode === 'split' ? 'w-1/2 border-r' : 'flex-1'
            } flex flex-col min-h-0 overflow-hidden transition-colors duration-200`}
          >
            <div className="px-4 py-1.5 border-b border-slate-200/70 bg-slate-100/60 flex items-center justify-between text-[11px] text-slate-500 select-none">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono font-semibold text-slate-700">MARKDOWN SOURCE</span>
                {doc.nativePath && (
                  <span className="truncate font-mono text-[10px] text-slate-400" title={doc.nativePath}>
                    {doc.nativePath}
                  </span>
                )}
              </div>
              <span className="text-[10px] font-mono text-slate-400">
                {markdownText.split('\n').length} lines · ⌘E toggle preview · ⌘S save
              </span>
            </div>
            <textarea
              ref={mdTextareaRef}
              aria-label="Markdown Source Editor"
              value={markdownText}
              onChange={(e) => handleMarkdownSourceChange(e.target.value)}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey) {
                  const title = findWikilinkAtOffset(markdownText, e.currentTarget.selectionStart);
                  if (title) {
                    e.preventDefault();
                    onOpenWikilink?.(title);
                  }
                }
              }}
              onSelect={(e) => {
                const start = e.currentTarget.selectionStart;
                const end = e.currentTarget.selectionEnd;
                if (end > start) {
                  const snippet = markdownText.slice(start, end).trim();
                  if (snippet) setSelectedQuote(snippet.slice(0, 240));
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Tab') {
                  e.preventDefault();
                  const target = e.currentTarget;
                  const start = target.selectionStart;
                  const end = target.selectionEnd;
                  const next = `${markdownText.slice(0, start)}  ${markdownText.slice(end)}`;
                  handleMarkdownSourceChange(next);
                  requestAnimationFrame(() => {
                    target.selectionStart = target.selectionEnd = start + 2;
                  });
                }
              }}
              spellCheck={false}
              placeholder="# Write Markdown here..."
              style={{
                color: readingTheme === 'dark' ? '#e2e8f0' : '#0f172a',
                fontSize: `${Math.round(13.5 * zoom)}px`,
              }}
              className="flex-1 w-full p-6 font-mono leading-relaxed resize-none focus:outline-none bg-transparent overflow-y-auto"
            />
          </section>
        )}

        {/* Paginated Paper Workspace (shown in 'preview' and 'split' modes) */}
        <main
          style={{ backgroundColor: READING_THEME_STYLES[readingTheme].backdropBg }}
          className={`${
            viewMode === 'markdown' ? 'hidden' : 'flex-1'
          } overflow-y-auto py-8 px-4 transition-colors duration-200 ${READING_THEME_STYLES[readingTheme].docTextClass}`}
          onContextMenu={(e) => {
            e.preventDefault();
            setContextMenu({ x: e.clientX, y: e.clientY });
          }}
        >
          {/* Live Linked Sheet Tables Refresh Banner */}
          {linkedSources.length > 0 && (
            <div
              className={`no-print mx-auto w-full ${paperWidthClass} mb-3 px-3.5 py-2 rounded-lg bg-emerald-50/95 border border-emerald-200 flex flex-wrap items-center justify-between gap-2 text-xs text-emerald-900 shadow-2xs`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <TableIcon className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span className="font-semibold">
                  {linkedSources.length === 1
                    ? 'Linked Forma Sheets Table'
                    : `${linkedSources.length} Linked Forma Sheets Tables`}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {linkedSources.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => handleRefreshLinkedTableClick(tag)}
                    title={`Refresh linked range ${formatSourceTagLabel(tag)}`}
                    className="px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-semibold flex items-center gap-1.5 shadow-2xs transition"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>
                      Refresh Linked Sheet Table
                      {linkedSources.length > 1 ? ` (${formatSourceTagLabel(tag)})` : ''}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Live Linked Canvas Diagrams Refresh Banner */}
          {linkedCanvases.length > 0 && (
            <div
              className={`no-print mx-auto w-full ${paperWidthClass} mb-3 px-3.5 py-2 rounded-lg bg-cyan-50/95 border border-cyan-200 flex flex-wrap items-center justify-between gap-2 text-xs text-cyan-900 shadow-2xs`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <PenTool className="w-3.5 h-3.5 text-cyan-600 shrink-0" />
                <span className="font-semibold">
                  {linkedCanvases.length === 1
                    ? 'Linked Forma Canvas Diagram'
                    : `${linkedCanvases.length} Linked Forma Canvas Diagrams`}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {linkedCanvases.map((tag) => {
                  const { title } = parseCanvasTag(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => handleRefreshLinkedCanvasClick(tag)}
                      title={`Refresh linked canvas diagram "${title}"`}
                      className="px-2.5 py-1 rounded-md bg-cyan-600 hover:bg-cyan-700 text-white text-[11px] font-semibold flex items-center gap-1.5 shadow-2xs transition"
                    >
                      <RefreshCw className="w-3 h-3" />
                      <span>
                        Refresh Canvas{linkedCanvases.length > 1 ? ` (${title})` : `: ${title}`}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Paginated Paper Sheet */}
          <div
            style={{
              fontFamily: doc.pageSettings.fontFamily,
              backgroundColor: READING_THEME_STYLES[readingTheme].paperBg,
              borderColor: READING_THEME_STYLES[readingTheme].paperBorder,
              zoom,
            }}
            className={`print-paper mx-auto w-full ${paperWidthClass} ${paperPaddingClass} border shadow-md rounded-sm min-h-[1040px] flex flex-col transition-colors duration-200`}
          >
            {doc.pageSettings.headerText?.trim() && (
              <header className="forma-page-header mb-6 pb-2 border-b border-slate-200/80 text-right text-[11px] text-slate-400 tracking-wide whitespace-pre-line print:text-slate-600 print:border-slate-300 select-none">
                {doc.pageSettings.headerText.trim()}
              </header>
            )}

            <div className="flex-1">
              <EditorContent editor={editor} />
            </div>

            {(doc.pageSettings.footerText?.trim() || doc.pageSettings.showPageNumbers) && (
              <footer className="forma-page-footer mt-8 pt-2.5 border-t border-slate-200/80 flex items-center justify-between gap-4 text-[11px] text-slate-400 print:text-slate-600 print:border-slate-300 select-none">
                <span className="whitespace-pre-line break-words">{doc.pageSettings.footerText?.trim() || ''}</span>
                {doc.pageSettings.showPageNumbers && (
                  <span className="font-mono shrink-0">Page 1</span>
                )}
              </footer>
            )}
          </div>

          {/* Clickable [[Wikilinks]] Footer Pills */}
          {wikilinks.length > 0 && (
            <div
              className={`no-print mx-auto w-full ${paperWidthClass} mt-3 px-3.5 py-2 rounded-lg bg-white/90 border border-slate-200/90 flex flex-wrap items-center gap-1.5 text-xs shadow-2xs`}
            >
              <span className="flex items-center gap-1 text-[11px] font-semibold text-slate-500 mr-1">
                <Link2 className="w-3.5 h-3.5 text-blue-600" />
                <span>Linked Notes:</span>
              </span>
              {wikilinks.map((title) => (
                <button
                  key={title}
                  type="button"
                  onClick={() => onOpenWikilink?.(title)}
                  title={`Open [[${title}]] (or ⌘+Click in editor)`}
                  className="px-2 py-0.5 rounded-full bg-blue-50 hover:bg-blue-100 border border-blue-200 text-[11px] font-medium text-blue-700 transition"
                >
                  [[{title}]]
                </button>
              ))}
            </div>
          )}

          {/* Live Mermaid Diagrams Rendered Visuals Tray */}
          {docDiagrams.length > 0 && (
            <section
              aria-label="Live Mermaid Diagrams Preview"
              className={`no-print mx-auto w-full ${paperWidthClass} mt-4 rounded-xl bg-white border border-slate-200 shadow-xs overflow-hidden`}
            >
              <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200/80 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-blue-600" />
                  <span className="text-xs font-semibold text-slate-800">
                    Live Mermaid Diagrams
                  </span>
                  <span className="px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 text-[10px] font-semibold font-mono">
                    {docDiagrams.length}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowVisualsTray((v) => !v)}
                  className="text-[11px] font-medium text-slate-500 hover:text-slate-800 flex items-center gap-1 transition"
                >
                  <span>{showVisualsTray ? 'Collapse' : 'Expand'}</span>
                  {showVisualsTray ? (
                    <ChevronUp className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>

              {showVisualsTray && (
                <div className="p-4 space-y-4">
                  {docDiagrams.map((item) => (
                    <div
                      key={item.id}
                      className="rounded-lg border border-slate-200/90 bg-slate-50/50 overflow-hidden"
                    >
                      <div className="px-3 py-1.5 border-b border-slate-200/70 bg-white flex items-center justify-between gap-2 text-[11px]">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className={`px-1.5 py-0.5 rounded font-semibold text-[10px] ${
                              item.kind === 'mermaid'
                                ? 'bg-indigo-50 text-indigo-700'
                                : 'bg-emerald-50 text-emerald-700'
                            }`}
                          >
                            {item.label}
                          </span>
                          {item.kind !== 'mermaid' && (
                            <code className="text-[10px] text-slate-400 font-mono truncate">
                              {item.source}
                            </code>
                          )}
                        </div>
                        {item.kind === 'mermaid' && item.svg && (
                          <button
                            type="button"
                            onClick={() => void handleCopySvg(item.svg!)}
                            title="Copy rendered SVG markup"
                            className="px-2 py-0.5 rounded bg-slate-100 hover:bg-blue-50 hover:text-blue-700 text-slate-600 font-medium flex items-center gap-1 transition shrink-0"
                          >
                            <Copy className="w-3 h-3" />
                            <span>Copy SVG</span>
                          </button>
                        )}
                      </div>
                      <div className="p-3 overflow-x-auto flex justify-center bg-white/80">
                        <div
                          className="max-w-full"
                          dangerouslySetInnerHTML={{ __html: sanitizeDocumentHtml(item.html) }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </main>
        </>}

        {/* Review Comments Right Sidebar */}
        {showComments && (
          <DocsCommentsPanel
            comments={comments}
            selectedQuote={selectedQuote}
            title={doc.title}
            pendingPin={pendingPin}
            onClearPendingPin={() => setPendingPin(undefined)}
            selectedComment={selectedComment}
            onSelectComment={setSelectedComment}
            onAddComment={handleAddComment}
            onToggleResolve={handleToggleResolveComment}
            onDeleteComment={handleDeleteComment}
            onJumpToQuote={handleJumpToQuote}
            onClose={() => setShowComments(false)}
          />
        )}
      </div>

      {/* Word-Style Right-Click Context Menu */}
      {contextMenu && editor && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={(() => {
            const inTable = editor.isActive('table');
            const items: ContextMenuItem[] = [
              {
                id: 'cut',
                label: 'Cut',
                shortcut: '⌘X',
                onClick: () => document.execCommand('cut'),
              },
              {
                id: 'copy',
                label: 'Copy',
                shortcut: '⌘C',
                onClick: () => document.execCommand('copy'),
              },
              {
                id: 'paste',
                label: 'Paste',
                shortcut: '⌘V',
                onClick: async () => {
                  try {
                    const txt = await navigator.clipboard.readText();
                    if (txt) editor.chain().focus().insertContent(txt).run();
                  } catch {
                    document.execCommand('paste');
                  }
                },
              },
              { id: 'd1', divider: true },
              {
                id: 'bold',
                label: editor.isActive('bold') ? 'Remove Bold' : 'Bold',
                shortcut: '⌘B',
                onClick: () => editor.chain().focus().toggleBold().run(),
              },
              {
                id: 'italic',
                label: editor.isActive('italic') ? 'Remove Italic' : 'Italic',
                shortcut: '⌘I',
                onClick: () => editor.chain().focus().toggleItalic().run(),
              },
              {
                id: 'underline',
                label: editor.isActive('underline') ? 'Remove Underline' : 'Underline',
                shortcut: '⌘U',
                onClick: () => editor.chain().focus().toggleUnderline().run(),
              },
              {
                id: 'highlight',
                label: editor.isActive('highlight') ? 'Remove Highlight' : 'Highlight',
                onClick: () => editor.chain().focus().toggleHighlight({ color: '#fef08a' }).run(),
              },
              {
                id: 'link',
                label: editor.isActive('link') ? 'Edit / Remove Link…' : 'Insert Link…',
                onClick: () => {
                  const prev = editor.getAttributes('link').href || '';
                  const url = window.prompt('Enter URL (blank to remove):', prev);
                  if (url === null) return;
                  if (url.trim() === '') editor.chain().focus().extendMarkRange('link').unsetLink().run();
                  else editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
                },
              },
              {
                id: 'clearFmt',
                label: 'Clear Formatting',
                onClick: () => editor.chain().focus().unsetAllMarks().clearNodes().run(),
              },
              { id: 'd2', divider: true },
              ...(inTable
                ? [
                    {
                      id: 'addRowBefore',
                      label: 'Insert Row Above',
                      onClick: () => editor.chain().focus().addRowBefore().run(),
                    },
                    {
                      id: 'addRowAfter',
                      label: 'Insert Row Below',
                      onClick: () => editor.chain().focus().addRowAfter().run(),
                    },
                    {
                      id: 'delRow',
                      label: 'Delete Row',
                      danger: true,
                      onClick: () => editor.chain().focus().deleteRow().run(),
                    },
                    {
                      id: 'addColBefore',
                      label: 'Insert Column Left',
                      onClick: () => editor.chain().focus().addColumnBefore().run(),
                    },
                    {
                      id: 'addColAfter',
                      label: 'Insert Column Right',
                      onClick: () => editor.chain().focus().addColumnAfter().run(),
                    },
                    {
                      id: 'delCol',
                      label: 'Delete Column',
                      danger: true,
                      onClick: () => editor.chain().focus().deleteColumn().run(),
                    },
                    {
                      id: 'delTable',
                      label: 'Delete Table',
                      danger: true,
                      onClick: () => editor.chain().focus().deleteTable().run(),
                    },
                  ]
                : [
                    {
                      id: 'insTable',
                      label: 'Insert 3×3 Table',
                      onClick: () =>
                        editor
                          .chain()
                          .focus()
                          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                          .run(),
                    },
                    {
                      id: 'insTask',
                      label: 'Insert Checklist',
                      onClick: () => editor.chain().focus().toggleTaskList().run(),
                    },
                  ]),
              { id: 'd3', divider: true },
              {
                id: 'addComment',
                label: 'Add Comment…',
                onClick: () => {
                  const { from, to } = editor.state.selection;
                  if (from !== to) {
                    const snippet = editor.state.doc.textBetween(from, to, ' ').trim();
                    if (snippet) setSelectedQuote(snippet.slice(0, 240));
                  }
                  setShowComments(true);
                },
              },
              {
                id: 'find',
                label: 'Find & Replace…',
                shortcut: '⌘F',
                onClick: () => setShowFindReplace(true),
              },
              {
                id: 'print',
                label: 'Print / Save as PDF…',
                shortcut: '⌘P',
                onClick: () => {
                  const webkit = (
                    window as unknown as {
                      webkit?: { messageHandlers?: { formaPrint?: { postMessage: (p: { title: string }) => void } } };
                    }
                  ).webkit;
                  if (webkit?.messageHandlers?.formaPrint) {
                    webkit.messageHandlers.formaPrint.postMessage({ title: doc.title });
                  } else {
                    window.print();
                  }
                },
              },
            ];
            return items;
          })()}
        />
      )}

      {/* Bottom Status Bar */}
      <div className="no-print h-8 bg-slate-100 border-t border-slate-200 px-4 flex items-center justify-between text-[11px] text-slate-500 shrink-0">
        <div className="flex items-center gap-4">
          <button
            onClick={() => setShowSidebar((v) => !v)}
            title="Toggle Outline Sidebar (⌘\)"
            className="text-slate-600 hover:text-blue-700 font-medium transition"
          >
            {showSidebar ? 'Hide Outline' : 'Show Outline'}
          </button>
          <span>
            Words: <strong className="text-slate-800 font-mono">{wordCount.toLocaleString()}</strong>
          </span>
          <span>
            Chars: <strong className="text-slate-800 font-mono">{charCount.toLocaleString()}</strong>
          </span>
          <span>
            ~<strong className="text-slate-700 font-mono">{Math.max(1, Math.ceil(wordCount / 220))}</strong> min read
          </span>
          <span className="capitalize">
            Page: <strong className="text-slate-700">{doc.pageSettings.pageSize.toUpperCase()}</strong> ({doc.pageSettings.margins})
          </span>
        </div>
        <div className="flex items-center gap-3">
          <ZoomControl zoom={zoom} onZoomOut={zoomOut} onZoomIn={zoomIn} onZoomReset={zoomReset} />
        </div>
      </div>
    </div>
  );
});
