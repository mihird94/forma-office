import type { CanvasData } from '../types/canvas';
import type { FormaDocument } from '../types/document';
import type { NotebookData } from '../types/notebook';
import type { WorkspaceFileKind } from '../types/office';
import type { FormaPdfRecord } from '../types/pdf';
import type { PresentationData } from '../types/slides';
import type { WorkbookData } from '../types/spreadsheet';

// MARK: - Public Types

export interface SemanticSearchHit {
  docId: string;
  kind: WorkspaceFileKind | string;
  title: string;
  path?: string;
  sectionLabel?: string;
  snippet: string;
  score: number;
  matchType: 'hybrid' | 'lexical';
}

export interface SemanticIndexStatus {
  ollamaOnline: boolean;
  embedOnline?: boolean;
  embedBackend?: 'forma-embedded' | 'ollama' | 'lexical';
  chatOnline?: boolean;
  embedModel: string;
  multimodal?: boolean;
  chatModels: string[];
  activeChatModel?: string;
  indexedDocs: number;
  indexedChunks: number;
  backend: 'native-sqlite' | 'browser-memory';
}

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OcrTextLine {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrPageResult {
  ok: boolean;
  pageIndex: number;
  text: string;
  lines: OcrTextLine[];
  error?: string;
}

export interface IndexDocumentImage {
  sectionLabel: string;
  caption?: string;
  base64: string;
}

export interface IndexDocumentInput {
  docId: string;
  kind: WorkspaceFileKind | string;
  title: string;
  text: string;
  path?: string;
  images?: IndexDocumentImage[];
}

export type WorkspaceIndexEntry =
  | { kind: 'document'; record: FormaDocument }
  | { kind: 'spreadsheet'; record: WorkbookData }
  | { kind: 'slides'; record: PresentationData }
  | { kind: 'pdf'; record: FormaPdfRecord }
  | { kind: 'notebook'; record: NotebookData }
  | { kind: 'canvas'; record: CanvasData };

export function makeWorkspaceIndexInput({ kind, record }: WorkspaceIndexEntry): IndexDocumentInput {
  const entry = { kind, docId: record.id, title: record.title, path: record.nativePath };
  switch (kind) {
    case 'document': return { ...entry, text: extractDocumentIndexText(record), images: extractDocumentIndexImages(record) };
    case 'spreadsheet': return { ...entry, text: extractWorkbookIndexText(record) };
    case 'slides': return { ...entry, text: extractPresentationIndexText(record), images: extractPresentationIndexImages(record) };
    case 'pdf': return { ...entry, text: extractPdfIndexText(record) };
    case 'notebook': return { ...entry, text: extractNotebookIndexText(record), images: extractNotebookIndexImages(record) };
    case 'canvas': return { ...entry, text: extractCanvasIndexText(record), images: extractCanvasIndexImages(record) };
  }
}

export interface IndexedFolderConfig {
  folders: Array<{ path: string; fileCount: number }>;
  includeStandaloneImages: boolean;
  lastFullSyncAt: number;
  indexedDocs: number;
  indexedChunks: number;
  backend: 'forma-embedded' | 'lexical';
  embedModel: string;
  multimodal: boolean;
}

export interface IndexedDocumentChunk {
  index: number;
  sectionLabel: string;
  text: string;
}

export interface HybridChunkCandidate {
  docId: string;
  kind: string;
  title: string;
  path?: string;
  sectionLabel?: string;
  text: string;
  embedding?: number[] | Float32Array | null;
}

export interface HybridSearchOptions {
  queryEmbedding?: number[] | Float32Array | null;
  kindFilter?: string;
  limit?: number;
}

// MARK: - Native WebKit Message Handler Bridge

const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_EMBED_MODEL = 'embeddinggemma-2';
const PREFERRED_EMBED_MODELS = ['embeddinggemma-2', 'embeddinggemma', 'qwen3-embedding:0.6b'];
const PREFERRED_CHAT_MODELS = ['qwen3.5:9b', 'qwen3:8b', 'qwen2.5-coder:7b'];
const EMBED_KEYWORDS = ['embed', 'nomic', 'bge', 'mxbai'];

export function isMultimodalEmbedModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.includes('embeddinggemma-2') || lower.includes('embeddinggemma2');
}

interface NativeFormaBridge {
  formaAI?: {
    postMessage: (payload: Record<string, unknown>) => void;
  };
  formaPdfOcr?: {
    postMessage: (payload: Record<string, unknown>) => void;
  };
}

type BridgeWindow = {
  webkit?: { messageHandlers?: NativeFormaBridge };
  __formaAIEvent?: (payload: Record<string, unknown>) => void;
  __formaOcrEvent?: (payload: Record<string, unknown>) => void;
};

const pendingAiResolvers = new Map<string, (payload: Record<string, unknown>) => void>();
const pendingOcrResolvers = new Map<string, (payload: Record<string, unknown>) => void>();

function getBridgeWindow(): BridgeWindow | null {
  if (typeof window === 'undefined') return null;
  return window as unknown as BridgeWindow;
}

function ensureAiCallbackHook(): void {
  const w = getBridgeWindow();
  if (!w) return;
  if (!w.__formaAIEvent) {
    w.__formaAIEvent = (payload: Record<string, unknown>) => {
      const reqId = typeof payload?.reqId === 'string' ? payload.reqId : '';
      const resolver = pendingAiResolvers.get(reqId);
      if (resolver) {
        pendingAiResolvers.delete(reqId);
        resolver(payload);
      }
    };
  }
}

function ensureOcrCallbackHook(): void {
  const w = getBridgeWindow();
  if (!w) return;
  if (!w.__formaOcrEvent) {
    w.__formaOcrEvent = (payload: Record<string, unknown>) => {
      const reqId = typeof payload?.reqId === 'string' ? payload.reqId : '';
      const resolver = pendingOcrResolvers.get(reqId);
      if (resolver) {
        pendingOcrResolvers.delete(reqId);
        resolver(payload);
      }
    };
  }
}

export function isNativeAiAvailable(): boolean {
  return Boolean(getBridgeWindow()?.webkit?.messageHandlers?.formaAI);
}

export function isNativeOcrAvailable(): boolean {
  return Boolean(getBridgeWindow()?.webkit?.messageHandlers?.formaPdfOcr);
}

function sendNativeAiRequest(
  payload: Record<string, unknown>,
  timeoutMs = 60000
): Promise<Record<string, unknown>> {
  ensureAiCallbackHook();
  const handler = getBridgeWindow()?.webkit?.messageHandlers?.formaAI;
  if (!handler) {
    return Promise.reject(new Error('Native Forma AI bridge unavailable'));
  }

  const reqId = `ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingAiResolvers.delete(reqId);
      reject(new Error(`Forma AI request timed out (${String(payload.action ?? 'unknown')})`));
    }, timeoutMs);

    pendingAiResolvers.set(reqId, (res) => {
      clearTimeout(timer);
      resolve(res);
    });

    handler.postMessage({ ...payload, reqId });
  });
}

function sendNativeOcrRequest(
  payload: Record<string, unknown>,
  timeoutMs = 45000
): Promise<Record<string, unknown>> {
  ensureOcrCallbackHook();
  const handler = getBridgeWindow()?.webkit?.messageHandlers?.formaPdfOcr;
  if (!handler) {
    return Promise.reject(new Error('Native Vision OCR bridge unavailable'));
  }

  const reqId = `ocr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingOcrResolvers.delete(reqId);
      reject(new Error('Vision OCR request timed out'));
    }, timeoutMs);

    pendingOcrResolvers.set(reqId, (res) => {
      clearTimeout(timer);
      resolve(res);
    });

    handler.postMessage({ ...payload, reqId });
  });
}

// MARK: - Pure Text Extractors for All 5 Forma File Types

function parseCellAddressOrder(addr: string): { row: number; col: number } {
  const match = /^([A-Za-z]+)(\d+)$/.exec(addr.trim());
  if (!match) return { row: Number.MAX_SAFE_INTEGER, col: Number.MAX_SAFE_INTEGER };
  const colStr = match[1].toUpperCase();
  let col = 0;
  for (let i = 0; i < colStr.length; i++) {
    col = col * 26 + (colStr.charCodeAt(i) - 64);
  }
  const row = Number.parseInt(match[2], 10);
  return { row, col };
}

export function extractWorkbookIndexText(wb: WorkbookData): string {
  const parts: string[] = [];
  if (wb.title) parts.push(`# ${wb.title}`);

  for (const sheet of wb.sheets ?? []) {
    parts.push(`## Sheet: ${sheet.name}`);
    const entries = Object.entries(sheet.cells ?? {})
      .filter(([, cell]) => Boolean(cell && (cell.raw?.trim() || cell.note?.trim())))
      .map(([addr, cell]) => ({ addr, cell, ...parseCellAddressOrder(addr) }))
      .sort((a, b) => (a.row !== b.row ? a.row - b.row : a.col - b.col));

    const byRow = new Map<number, string[]>();
    const notes: string[] = [];

    for (const item of entries) {
      const val = item.cell.raw?.trim() ?? '';
      if (val) {
        const list = byRow.get(item.row) ?? [];
        list.push(`${item.addr}: ${val}`);
        byRow.set(item.row, list);
      }
      if (item.cell.note?.trim()) {
        notes.push(`${item.addr} note: ${item.cell.note.trim()}`);
      }
    }

    for (const [, rowValues] of byRow) {
      parts.push(rowValues.join(' | '));
    }
    if (notes.length > 0) {
      parts.push(`Notes:\n${notes.join('\n')}`);
    }
    if (sheet.charts && sheet.charts.length > 0) {
      const chartSummary = sheet.charts
        .map((c) => `${c.title} (${c.type}, ${c.dataRange})`)
        .join('; ');
      parts.push(`Charts: ${chartSummary}`);
    }
  }

  return parts.join('\n').trim();
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number.parseInt(code, 10)));
}

function htmlToStructuredText(html: string): string {
  if (!html) return '';
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|blockquote|pre|section|article|h4|h5|h6)>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<[^>]+>/g, '');

  text = decodeHtmlEntities(text);
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractDocumentIndexText(doc: FormaDocument): string {
  const parts: string[] = [];
  if (doc.markdownSource && doc.markdownSource.trim().length > 0) {
    const md = doc.markdownSource.trim();
    if (doc.title && !md.startsWith('#')) {
      parts.push(`# ${doc.title}`);
    }
    parts.push(md);
    return parts.join('\n\n').trim();
  }

  if (doc.title) parts.push(`# ${doc.title}`);
  const plain = htmlToStructuredText(doc.html ?? '');
  if (plain) parts.push(plain);
  return parts.join('\n\n').trim();
}

export function extractPresentationIndexText(deck: PresentationData): string {
  const parts: string[] = [];
  if (deck.title) parts.push(`# ${deck.title}`);

  (deck.slides ?? []).forEach((slide, idx) => {
    const slideLines: string[] = [`## Slide ${idx + 1}`];
    const sortedElements = [...(slide.elements ?? [])].sort((a, b) =>
      Math.abs(a.y - b.y) > 12 ? a.y - b.y : a.x - b.x
    );
    for (const el of sortedElements) {
      const txt = el.text?.trim();
      if (txt) slideLines.push(txt);
      else if (el.kind === 'table' && Array.isArray(el.tableData)) {
        for (const row of el.tableData) {
          const line = row.map((c) => c.trim()).filter(Boolean).join(' | ');
          if (line) slideLines.push(line);
        }
      }
    }
    if (slide.notes?.trim()) {
      slideLines.push(`Speaker Notes: ${slide.notes.trim()}`);
    }
    if (slideLines.length > 1) {
      parts.push(slideLines.join('\n'));
    }
  });

  return parts.join('\n\n').trim();
}

export function extractNotebookIndexText(nb: NotebookData): string {
  const parts: string[] = [];
  if (nb.title) parts.push(`# ${nb.title}`);

  (nb.cells ?? []).forEach((cell, idx) => {
    const cellLines: string[] = [`## Cell ${idx + 1} (${cell.cell_type})`];
    const src = cell.source?.trim();
    if (src) cellLines.push(src);

    for (const out of cell.outputs ?? []) {
      if (out.output_type === 'stream' && out.text?.trim()) {
        cellLines.push(out.text.trim().slice(0, 600));
      } else if (
        (out.output_type === 'execute_result' || out.output_type === 'display_data') &&
        out.data?.['text/plain']?.trim()
      ) {
        cellLines.push(out.data['text/plain'].trim().slice(0, 600));
      } else if (out.output_type === 'error') {
        cellLines.push(`${out.ename}: ${out.evalue}`);
      }
    }

    if (cellLines.length > 1) {
      parts.push(cellLines.join('\n'));
    }
  });

  return parts.join('\n\n').trim();
}

export function extractPdfIndexText(pdf: FormaPdfRecord, extractedText?: string): string {
  const parts: string[] = [];
  if (pdf.title) parts.push(`# ${pdf.title}`);

  if (extractedText && extractedText.trim().length > 0) {
    parts.push(extractedText.trim());
  }

  const noteLines: string[] = [];
  for (const ann of pdf.annotations ?? []) {
    if ((ann.type === 'text' || ann.type === 'note') && ann.text?.trim()) {
      noteLines.push(`Page ${ann.pageIndex + 1} (${ann.type}): ${ann.text.trim()}`);
    }
  }
  if (noteLines.length > 0) {
    parts.push(`## Annotations\n${noteLines.join('\n')}`);
  }

  return parts.join('\n\n').trim();
}

export function extractCanvasIndexText(canvas: CanvasData): string {
  const parts: string[] = [];
  if (canvas.title) parts.push(`# ${canvas.title}`);

  const elements = [...(canvas.elements ?? [])].sort((a, b) =>
    Math.abs(a.y - b.y) > 24 ? a.y - b.y : a.x - b.x
  );

  const frames: string[] = [];
  const stickies: string[] = [];
  const shapesAndLabels: string[] = [];

  for (const el of elements) {
    const txt = el.text?.trim();
    if (!txt) continue;
    if (el.kind === 'frame') {
      frames.push(`## Frame: ${txt}`);
    } else if (el.kind === 'sticky') {
      stickies.push(`- [Sticky] ${txt}`);
    } else if (el.kind === 'arrow' || el.kind === 'line') {
      shapesAndLabels.push(`- [Connector] ${txt}`);
    } else {
      shapesAndLabels.push(`- [${el.kind}] ${txt}`);
    }
  }

  if (frames.length > 0) parts.push(frames.join('\n'));
  if (shapesAndLabels.length > 0) parts.push(`## Diagram Nodes & Labels\n${shapesAndLabels.join('\n')}`);
  if (stickies.length > 0) parts.push(`## Sticky Notes\n${stickies.join('\n')}`);

  return parts.join('\n\n').trim();
}

function stripDataUrlBase64(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('data:image/')) {
    const comma = trimmed.indexOf(',');
    if (comma === -1) return null;
    const payload = trimmed.slice(comma + 1).trim();
    return payload.length > 0 && payload.length <= 5_000_000 ? payload : null;
  }
  return trimmed.length <= 5_000_000 ? trimmed : null;
}

export function extractNotebookIndexImages(nb: NotebookData, maxImages = 6): IndexDocumentImage[] {
  const out: IndexDocumentImage[] = [];
  (nb.cells ?? []).forEach((cell, idx) => {
    if (out.length >= maxImages) return;
    for (const output of cell.outputs ?? []) {
      if (out.length >= maxImages) break;
      if (output.output_type !== 'display_data' && output.output_type !== 'execute_result') continue;
      const raw = output.data?.['image/png'] ?? output.data?.['image/jpeg'];
      if (typeof raw !== 'string') continue;
      const b64 = stripDataUrlBase64(raw);
      if (!b64) continue;
      out.push({
        sectionLabel: `Cell ${idx + 1} Chart`,
        caption: cell.source?.trim().split('\n')[0]?.slice(0, 120) ?? '',
        base64: b64,
      });
    }
  });
  return out;
}

export function extractCanvasIndexImages(canvas: CanvasData, maxImages = 6): IndexDocumentImage[] {
  const out: IndexDocumentImage[] = [];
  let imgIdx = 0;
  for (const el of canvas.elements ?? []) {
    if (out.length >= maxImages) break;
    if (el.kind === 'image' && el.src) {
      const b64 = stripDataUrlBase64(el.src);
      if (!b64) continue;
      imgIdx += 1;
      out.push({
        sectionLabel: `Canvas Image ${imgIdx}`,
        caption: el.text?.trim() ?? '',
        base64: b64,
      });
    }
  }
  return out;
}

export function extractPresentationIndexImages(
  deck: PresentationData,
  maxImages = 6
): IndexDocumentImage[] {
  const out: IndexDocumentImage[] = [];
  (deck.slides ?? []).forEach((slide, sIdx) => {
    if (out.length >= maxImages) return;
    for (const el of slide.elements ?? []) {
      if (out.length >= maxImages) break;
      if (el.kind === 'image' && el.src) {
        const b64 = stripDataUrlBase64(el.src);
        if (!b64) continue;
        out.push({
          sectionLabel: `Slide ${sIdx + 1} Image`,
          caption: el.text?.trim() ?? '',
          base64: b64,
        });
      }
    }
  });
  return out;
}

export function extractDocumentIndexImages(doc: FormaDocument, maxImages = 4): IndexDocumentImage[] {
  const out: IndexDocumentImage[] = [];
  if (!doc.html) return out;
  const regex = /<img[^>]+src=["'](data:image\/(?:png|jpeg|jpg|webp);base64,[^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  let idx = 0;
  while ((match = regex.exec(doc.html)) !== null && out.length < maxImages) {
    const b64 = stripDataUrlBase64(match[1]);
    if (!b64) continue;
    idx += 1;
    out.push({
      sectionLabel: `Embedded Image ${idx}`,
      base64: b64,
    });
  }
  return out;
}

// MARK: - Pure JS Chunking, Cosine Similarity & Hybrid Search

export function chunkTextForEmbedding(
  input: string,
  maxChunkChars = 900,
  overlapChars = 140,
  maxChunks = 80
): IndexedDocumentChunk[] {
  const normalized = input.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const lines = normalized.split('\n');
  const sections: Array<{ label: string; body: string }> = [];
  let currentLabel = '';
  let currentLines: string[] = [];

  const flushSection = () => {
    const body = currentLines.join('\n').trim();
    if (body) {
      sections.push({ label: currentLabel, body });
    }
    currentLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      flushSection();
      currentLabel = trimmed.replace(/^#+\s*/, '').slice(0, 80).trim();
      currentLines.push(line);
    } else {
      currentLines.push(line);
    }
  }
  flushSection();

  if (sections.length === 0) {
    sections.push({ label: '', body: normalized });
  }

  const chunks: IndexedDocumentChunk[] = [];
  for (const section of sections) {
    if (chunks.length >= maxChunks) break;
    if (section.body.length <= maxChunkChars) {
      chunks.push({
        index: chunks.length,
        sectionLabel: section.label,
        text: section.body,
      });
      continue;
    }

    let start = 0;
    while (start < section.body.length && chunks.length < maxChunks) {
      let end = Math.min(start + maxChunkChars, section.body.length);
      if (end < section.body.length) {
        const minBreak = Math.max(start + Math.floor(maxChunkChars / 2), end - 140);
        for (let pos = end - 1; pos >= minBreak; pos--) {
          const ch = section.body[pos];
          if (ch === '\n' || ch === ' ' || ch === '.') {
            end = pos + 1;
            break;
          }
        }
      }
      const slice = section.body.slice(start, end).trim();
      if (slice) {
        chunks.push({
          index: chunks.length,
          sectionLabel: section.label,
          text: slice,
        });
      }
      if (end >= section.body.length) break;
      start = Math.max(end - overlapChars, start + 1);
    }
  }

  return chunks;
}

export function cosineSimilarity(
  a: ArrayLike<number>,
  b: ArrayLike<number>
): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 1e-8 ? dot / denom : 0;
}

function l2Normalize(vec: number[]): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq);
  const out = new Float32Array(vec.length);
  if (norm <= 1e-8) {
    for (let i = 0; i < vec.length; i++) out[i] = vec[i];
    return out;
  }
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

function tokenizeText(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9_]{2,}/g);
  return matches ?? [];
}

function makeSnippet(text: string, queryTerms: string[], maxChars = 240): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return collapsed;

  const lower = collapsed.toLowerCase();
  let bestIdx = -1;
  for (const term of queryTerms) {
    const idx = lower.indexOf(term);
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
      bestIdx = idx;
    }
  }

  if (bestIdx === -1) {
    return `${collapsed.slice(0, maxChars).trim()}…`;
  }

  const start = Math.max(0, bestIdx - 60);
  const end = Math.min(collapsed.length, start + maxChars);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < collapsed.length ? '…' : '';
  return `${prefix}${collapsed.slice(start, end).trim()}${suffix}`;
}

export function scoreHybridSearch(
  query: string,
  candidates: HybridChunkCandidate[],
  options: HybridSearchOptions = {}
): SemanticSearchHit[] {
  const trimmedQuery = query.trim();
  if (!trimmedQuery || candidates.length === 0) return [];

  const kindFilter = options.kindFilter?.trim();
  const activeKind = kindFilter && kindFilter !== 'all' ? kindFilter : undefined;
  const limit = Math.max(1, Math.min(options.limit ?? 12, 50));
  const queryEmbedding = options.queryEmbedding ?? null;

  const filtered = activeKind
    ? candidates.filter((c) => c.kind === activeKind)
    : candidates;
  if (filtered.length === 0) return [];

  const queryLower = trimmedQuery.toLowerCase();
  const queryTerms = Array.from(new Set(tokenizeText(trimmedQuery)));

  const dfMap = new Map<string, number>();
  const docTokenLists: string[][] = [];
  let totalTokens = 0;

  for (const cand of filtered) {
    const tokens = tokenizeText(`${cand.title} ${cand.sectionLabel ?? ''} ${cand.text}`);
    docTokenLists.push(tokens);
    totalTokens += tokens.length;
    if (queryTerms.length > 0) {
      const tokenSet = new Set(tokens);
      for (const term of queryTerms) {
        if (tokenSet.has(term)) {
          dfMap.set(term, (dfMap.get(term) ?? 0) + 1);
        }
      }
    }
  }

  const totalDocs = Math.max(1, filtered.length);
  const avgDocLen = Math.max(1, totalTokens / totalDocs);
  const k1 = 1.5;
  const b = 0.75;

  const rawLexical: number[] = new Array(filtered.length).fill(0);
  let maxLexical = 0;

  for (let i = 0; i < filtered.length; i++) {
    const cand = filtered[i];
    const tokens = docTokenLists[i];
    const titleLower = cand.title.toLowerCase();
    const sectionLower = (cand.sectionLabel ?? '').toLowerCase();
    const textLower = cand.text.toLowerCase();

    const tfMap = new Map<string, number>();
    for (const tok of tokens) {
      tfMap.set(tok, (tfMap.get(tok) ?? 0) + 1);
    }

    const dl = Math.max(1, tokens.length);
    let bm25 = 0;
    let matchedTerms = 0;

    for (const term of queryTerms) {
      const tf = tfMap.get(term) ?? 0;
      if (tf > 0) {
        matchedTerms += 1;
        const df = dfMap.get(term) ?? 1;
        const idf = Math.log(((totalDocs - df + 0.5) / (df + 0.5)) + 1);
        bm25 += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgDocLen))));
      } else if (
        titleLower.includes(term) ||
        sectionLower.includes(term) ||
        textLower.includes(term)
      ) {
        matchedTerms += 1;
        bm25 += 0.35;
      }
    }

    let score = 0;
    if (matchedTerms > 0) {
      score = bm25 + (matchedTerms / Math.max(1, queryTerms.length)) * 0.8;
      if (queryLower.length >= 3) {
        if (titleLower.includes(queryLower)) score += 1.6;
        if (sectionLower.includes(queryLower)) score += 0.9;
        if (textLower.includes(queryLower)) score += 0.7;
      }
    }

    rawLexical[i] = score;
    if (score > maxLexical) maxLexical = score;
  }

  const scored: Array<{ cand: HybridChunkCandidate; score: number; matchType: 'hybrid' | 'lexical' }> = [];

  for (let i = 0; i < filtered.length; i++) {
    const cand = filtered[i];
    const lexNorm = maxLexical > 0 ? Math.min(1, rawLexical[i] / Math.max(maxLexical, 1)) : 0;

    if (
      queryEmbedding &&
      cand.embedding &&
      queryEmbedding.length > 0 &&
      queryEmbedding.length === cand.embedding.length
    ) {
      const cos = Math.max(0, cosineSimilarity(queryEmbedding, cand.embedding));
      const combined = 0.75 * cos + 0.25 * lexNorm;
      if (combined > 0.05) {
        scored.push({ cand, score: combined, matchType: 'hybrid' });
      }
    } else if (rawLexical[i] > 0) {
      scored.push({ cand, score: lexNorm, matchType: 'lexical' });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const perDocCount = new Map<string, number>();
  const hits: SemanticSearchHit[] = [];

  for (const item of scored) {
    const existing = perDocCount.get(item.cand.docId) ?? 0;
    if (existing >= 2) continue;
    perDocCount.set(item.cand.docId, existing + 1);

    hits.push({
      docId: item.cand.docId,
      kind: item.cand.kind,
      title: item.cand.title,
      path: item.cand.path || undefined,
      sectionLabel: item.cand.sectionLabel || undefined,
      snippet: makeSnippet(item.cand.text, queryTerms, 240),
      score: Math.round(item.score * 1000) / 1000,
      matchType: item.matchType,
    });
    if (hits.length >= limit) break;
  }

  return hits;
}

export function stripThinkTags(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// MARK: - Browser-Mode Fallback (In-Memory Vector/Lexical Index + Local Ollama Fetch)

interface MemoryDocRecord {
  docId: string;
  kind: string;
  title: string;
  path?: string;
  contentHash: string;
  embedModel: string;
  chunks: Array<{
    index: number;
    sectionLabel: string;
    text: string;
    embedding: Float32Array | null;
  }>;
}

const memoryIndex = new Map<string, MemoryDocRecord>();

export function clearInMemorySemanticIndex(): void {
  memoryIndex.clear();
}

function quickHash(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}`;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function browserDiscoverOllama(): Promise<{
  online: boolean;
  embedModel: string;
  chatModels: string[];
  activeChatModel: string;
}> {
  if (typeof fetch === 'undefined') {
    return {
      online: false,
      embedModel: DEFAULT_EMBED_MODEL,
      chatModels: [],
      activeChatModel: PREFERRED_CHAT_MODELS[0],
    };
  }

  try {
    const res = await fetchWithTimeout(`${OLLAMA_BASE_URL}/api/tags`, { method: 'GET' }, 2500);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    const names = (data.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);

    const embedModel =
      PREFERRED_EMBED_MODELS.map((pref) =>
        names.find(
          (n) => n === pref || n.startsWith(`${pref}:`) || n.toLowerCase().startsWith(pref)
        )
      ).find((hit): hit is string => Boolean(hit)) ??
      names.find((n) => EMBED_KEYWORDS.some((kw) => n.toLowerCase().includes(kw))) ??
      DEFAULT_EMBED_MODEL;

    const nonEmbed = names.filter(
      (n) => !EMBED_KEYWORDS.some((kw) => n.toLowerCase().includes(kw))
    );

    const orderedChat: string[] = [];
    for (const pref of PREFERRED_CHAT_MODELS) {
      const hit = nonEmbed.find((n) => n === pref || n.startsWith(pref));
      if (hit && !orderedChat.includes(hit)) orderedChat.push(hit);
    }
    for (const n of nonEmbed) {
      if (!orderedChat.includes(n)) orderedChat.push(n);
    }

    return {
      online: true,
      embedModel,
      chatModels: orderedChat,
      activeChatModel: orderedChat[0] ?? PREFERRED_CHAT_MODELS[0],
    };
  } catch {
    return {
      online: false,
      embedModel: DEFAULT_EMBED_MODEL,
      chatModels: [],
      activeChatModel: PREFERRED_CHAT_MODELS[0],
    };
  }
}

async function browserEmbedTexts(
  texts: string[],
  model: string
): Promise<Float32Array[] | null> {
  if (typeof fetch === 'undefined' || texts.length === 0) return null;

  try {
    const res = await fetchWithTimeout(
      `${OLLAMA_BASE_URL}/api/embed`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: texts }),
      },
      25000
    );
    if (res.ok) {
      const json = (await res.json()) as { embeddings?: number[][] };
      if (Array.isArray(json.embeddings) && json.embeddings.length === texts.length) {
        return json.embeddings.map((row) => l2Normalize(row));
      }
    }
  } catch {
    // fall through to legacy endpoint
  }

  try {
    const vectors: Float32Array[] = [];
    for (const prompt of texts) {
      const res = await fetchWithTimeout(
        `${OLLAMA_BASE_URL}/api/embeddings`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, prompt }),
        },
        20000
      );
      if (!res.ok) return null;
      const json = (await res.json()) as { embedding?: number[] };
      if (!Array.isArray(json.embedding)) return null;
      vectors.push(l2Normalize(json.embedding));
    }
    return vectors;
  } catch {
    return null;
  }
}

// MARK: - High-Level Public API

export async function getSemanticStatus(): Promise<SemanticIndexStatus> {
  if (isNativeAiAvailable()) {
    try {
      const res = await sendNativeAiRequest({ action: 'status' }, 8000);
      const embedModel = typeof res.embedModel === 'string' ? res.embedModel : DEFAULT_EMBED_MODEL;
      const embedBackend =
        res.embedBackend === 'forma-embedded' ||
        res.embedBackend === 'ollama' ||
        res.embedBackend === 'lexical'
          ? res.embedBackend
          : Boolean(res.ollamaOnline)
            ? 'ollama'
            : 'lexical';
      return {
        ollamaOnline: Boolean(res.ollamaOnline),
        embedOnline:
          typeof res.embedOnline === 'boolean' ? res.embedOnline : Boolean(res.ollamaOnline),
        embedBackend,
        chatOnline:
          typeof res.chatOnline === 'boolean' ? res.chatOnline : Boolean(res.ollamaOnline),
        embedModel,
        multimodal:
          typeof res.multimodal === 'boolean' ? res.multimodal : isMultimodalEmbedModel(embedModel),
        chatModels: Array.isArray(res.chatModels) ? (res.chatModels as string[]) : [],
        activeChatModel:
          typeof res.activeChatModel === 'string' ? res.activeChatModel : undefined,
        indexedDocs: typeof res.indexedDocs === 'number' ? res.indexedDocs : 0,
        indexedChunks: typeof res.indexedChunks === 'number' ? res.indexedChunks : 0,
        backend: 'native-sqlite',
      };
    } catch {
      // fall through to browser fallback if bridge fails
    }
  }

  const discovery = await browserDiscoverOllama();
  let chunkCount = 0;
  for (const doc of memoryIndex.values()) {
    chunkCount += doc.chunks.length;
  }
  return {
    ollamaOnline: discovery.online,
    embedModel: discovery.embedModel,
    multimodal: isMultimodalEmbedModel(discovery.embedModel),
    chatModels: discovery.chatModels,
    activeChatModel: discovery.activeChatModel,
    indexedDocs: memoryIndex.size,
    indexedChunks: chunkCount,
    backend: 'browser-memory',
  };
}

export async function listLocalAiModels(): Promise<{
  ollamaOnline: boolean;
  embedModel: string;
  chatModels: string[];
  activeChatModel: string;
}> {
  const status = await getSemanticStatus();
  return {
    ollamaOnline: status.ollamaOnline,
    embedModel: status.embedModel,
    chatModels: status.chatModels,
    activeChatModel: status.activeChatModel ?? status.chatModels[0] ?? PREFERRED_CHAT_MODELS[0],
  };
}

export async function indexWorkspaceDocument(
  input: IndexDocumentInput
): Promise<{ ok: boolean; skipped?: boolean; chunks?: number; embedded?: boolean }> {
  const { docId, kind, title, text, path = '', images } = input;
  if (!docId) return { ok: false };

  if (isNativeAiAvailable()) {
    try {
      const payload: Record<string, unknown> = {
        action: 'indexDocument',
        docId,
        kind,
        title,
        path,
        text,
      };
      if (images && images.length > 0) {
        payload.images = images;
      }
      const res = await sendNativeAiRequest(payload, 90000);
      return {
        ok: Boolean(res.ok),
        skipped: Boolean(res.skipped),
        chunks: typeof res.chunks === 'number' ? res.chunks : undefined,
        embedded: Boolean(res.embedded),
      };
    } catch {
      return { ok: false };
    }
  }

  // Browser / test in-memory fallback
  const trimmed = text.trim();
  if (!trimmed) {
    memoryIndex.delete(docId);
    return { ok: true, skipped: true, chunks: 0, embedded: false };
  }

  const contentHash = quickHash(`${title}\n${trimmed}`);
  const discovery = await browserDiscoverOllama();
  const existing = memoryIndex.get(docId);

  if (existing && existing.contentHash === contentHash) {
    const missingVecs = existing.chunks.some((c) => !c.embedding);
    if (!discovery.online || (!missingVecs && existing.embedModel === discovery.embedModel)) {
      return {
        ok: true,
        skipped: true,
        chunks: existing.chunks.length,
        embedded: !missingVecs && Boolean(existing.embedModel),
      };
    }
  }

  const rawChunks = chunkTextForEmbedding(trimmed, 900, 140, 80);
  const embeddings: Array<Float32Array | null> = new Array(rawChunks.length).fill(null);
  let usedModel = '';
  let embeddedAll = false;

  if (discovery.online && rawChunks.length > 0) {
    const batchSize = 12;
    let successCount = 0;
    for (let i = 0; i < rawChunks.length; i += batchSize) {
      const slice = rawChunks.slice(i, i + batchSize);
      const texts = slice.map((c) =>
        c.sectionLabel ? `${title} — ${c.sectionLabel}\n${c.text}` : `${title}\n${c.text}`
      );
      const vecs = await browserEmbedTexts(texts, discovery.embedModel);
      if (!vecs || vecs.length !== slice.length) break;
      for (let j = 0; j < vecs.length; j++) {
        embeddings[i + j] = vecs[j];
        successCount += 1;
      }
    }
    if (successCount > 0) {
      usedModel = discovery.embedModel;
      embeddedAll = successCount === rawChunks.length;
    }
  }

  memoryIndex.set(docId, {
    docId,
    kind,
    title,
    path: path || undefined,
    contentHash,
    embedModel: usedModel,
    chunks: rawChunks.map((c, idx) => ({
      index: c.index,
      sectionLabel: c.sectionLabel,
      text: c.text,
      embedding: embeddings[idx],
    })),
  });

  return {
    ok: true,
    skipped: false,
    chunks: rawChunks.length,
    embedded: embeddedAll,
  };
}

export async function removeIndexedDocument(docId: string): Promise<{ ok: boolean }> {
  if (!docId) return { ok: false };
  if (isNativeAiAvailable()) {
    try {
      const res = await sendNativeAiRequest({ action: 'removeDocument', docId }, 10000);
      return { ok: Boolean(res.ok) };
    } catch {
      return { ok: false };
    }
  }
  memoryIndex.delete(docId);
  return { ok: true };
}

export async function semanticSearchWorkspace(
  query: string,
  kind?: string,
  limit = 12,
  lexicalOnly = false
): Promise<SemanticSearchHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  if (isNativeAiAvailable()) {
    try {
      const res = await sendNativeAiRequest(
        { action: 'semanticSearch', query: trimmed, kindFilter: kind, limit, lexicalOnly },
        20000
      );
      if (Array.isArray(res.hits)) {
        return res.hits as SemanticSearchHit[];
      }
      return [];
    } catch {
      return [];
    }
  }

  // Browser / test in-memory hybrid search fallback
  const candidates: HybridChunkCandidate[] = [];
  let hasAnyEmbedding = false;
  for (const doc of memoryIndex.values()) {
    for (const chunk of doc.chunks) {
      if (chunk.embedding) hasAnyEmbedding = true;
      candidates.push({
        docId: doc.docId,
        kind: doc.kind,
        title: doc.title,
        path: doc.path,
        sectionLabel: chunk.sectionLabel,
        text: chunk.text,
        embedding: chunk.embedding,
      });
    }
  }

  let queryEmbedding: Float32Array | null = null;
  if (!lexicalOnly && hasAnyEmbedding) {
    const discovery = await browserDiscoverOllama();
    if (discovery.online) {
      const vecs = await browserEmbedTexts([trimmed], discovery.embedModel);
      if (vecs && vecs[0]) queryEmbedding = vecs[0];
    }
  }

  return scoreHybridSearch(trimmed, candidates, {
    queryEmbedding,
    kindFilter: kind,
    limit,
  });
}

async function requestIndexAction(
  action: string,
  options: Record<string, unknown> = {},
  timeout = 15_000
): Promise<Record<string, unknown>> {
  const response = await sendNativeAiRequest({ action, ...options }, timeout);
  if (!response.ok) {
    const detail = typeof response.error === 'string' ? response.error
      : Array.isArray(response.errors) ? response.errors.find((error) => typeof error === 'string') : undefined;
    throw new Error(detail || 'Forma could not update the index.');
  }
  return response;
}

function indexedFolderConfig(response: Record<string, unknown>): IndexedFolderConfig {
  return {
    folders: Array.isArray(response.folders) ? response.folders.filter((folder) =>
      typeof folder?.path === 'string' && typeof folder?.fileCount === 'number'
    ) : [],
    includeStandaloneImages: Boolean(response.includeStandaloneImages),
    lastFullSyncAt: (Number(response.lastFullSyncAt) || 0) * 1000,
    indexedDocs: Number(response.indexedDocs) || 0,
    indexedChunks: Number(response.indexedChunks) || 0,
    backend: response.backend === 'forma-embedded' ? 'forma-embedded' : 'lexical',
    embedModel: String(response.embedModel ?? ''),
    multimodal: Boolean(response.multimodal),
  };
}

export async function getIndexedFolderConfig(): Promise<IndexedFolderConfig> {
  return indexedFolderConfig(await requestIndexAction('getIndexConfig'));
}

export async function addIndexedFolder(): Promise<IndexedFolderConfig | null> {
  const response = await requestIndexAction('addWatchedFolder', {}, 180_000);
  return response.cancelled ? null : indexedFolderConfig(response);
}

export async function removeIndexedFolder(path: string): Promise<IndexedFolderConfig> {
  return indexedFolderConfig(await requestIndexAction('removeWatchedFolder', { path }, 900_000));
}

export async function setIndexedImages(enabled: boolean): Promise<IndexedFolderConfig> {
  return indexedFolderConfig(await requestIndexAction('toggleIndexImages', { enabled }, 900_000));
}

export async function syncIndexedFolders(): Promise<{ indexedCount: number; skippedCount: number; prunedCount: number }> {
  const response = await requestIndexAction('syncWatchedFolders', {}, 1_800_000);
  return {
    indexedCount: Number(response.indexedCount) || 0,
    skippedCount: Number(response.skippedCount) || 0,
    prunedCount: Number(response.prunedCount) || 0,
  };
}

export async function chatWithLocalAi(
  messages: AiChatMessage[],
  model?: string
): Promise<{ ok: boolean; content: string; model: string; error?: string }> {
  if (isNativeAiAvailable()) {
    try {
      const res = await sendNativeAiRequest(
        { action: 'chat', messages, model },
        125000
      );
      return {
        ok: Boolean(res.ok),
        content: typeof res.content === 'string' ? res.content : '',
        model: typeof res.model === 'string' ? res.model : (model ?? PREFERRED_CHAT_MODELS[0]),
        error: typeof res.error === 'string' ? res.error : undefined,
      };
    } catch (err) {
      return {
        ok: false,
        content: '',
        model: model ?? PREFERRED_CHAT_MODELS[0],
        error: err instanceof Error ? err.message : 'Local AI request failed',
      };
    }
  }

  // Browser fallback directly against local Ollama
  const discovery = await browserDiscoverOllama();
  if (!discovery.online) {
    return {
      ok: false,
      content: '',
      model: model ?? PREFERRED_CHAT_MODELS[0],
      error: 'Ollama is offline at http://127.0.0.1:11434. Start Ollama (`ollama serve`) to chat locally.',
    };
  }

  const chosenModel = model?.trim() || discovery.activeChatModel;

  const tryChat = async (includeThinkFlag: boolean) => {
    const payload: Record<string, unknown> = {
      model: chosenModel,
      messages,
      stream: false,
    };
    if (includeThinkFlag) payload.think = false;
    const res = await fetchWithTimeout(
      `${OLLAMA_BASE_URL}/api/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      120000
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      model?: string;
      message?: { content?: string };
    };
    if (typeof json.message?.content !== 'string') return null;
    return {
      ok: true,
      model: json.model ?? chosenModel,
      content: stripThinkTags(json.message.content),
    };
  };

  try {
    const first = await tryChat(true);
    if (first) return first;
    const fallback = await tryChat(false);
    if (fallback) return fallback;
    return {
      ok: false,
      content: '',
      model: chosenModel,
      error: `Ollama chat failed for model '${chosenModel}'.`,
    };
  } catch (err) {
    return {
      ok: false,
      content: '',
      model: chosenModel,
      error: err instanceof Error ? err.message : 'Local Ollama chat failed',
    };
  }
}

export async function ocrNativePdfPage(options: {
  path?: string;
  pageIndex: number;
  base64Pdf?: string;
}): Promise<OcrPageResult> {
  if (!isNativeOcrAvailable()) {
    return {
      ok: false,
      pageIndex: options.pageIndex,
      text: '',
      lines: [],
      error: 'Apple Vision OCR is only available inside the native macOS Forma PDF app.',
    };
  }

  try {
    const res = await sendNativeOcrRequest(
      {
        path: options.path,
        pageIndex: options.pageIndex,
        base64Pdf: options.base64Pdf,
      },
      45000
    );
    return {
      ok: Boolean(res.ok),
      pageIndex: typeof res.pageIndex === 'number' ? res.pageIndex : options.pageIndex,
      text: typeof res.text === 'string' ? res.text : '',
      lines: Array.isArray(res.lines) ? (res.lines as OcrTextLine[]) : [],
      error: typeof res.error === 'string' ? res.error : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      pageIndex: options.pageIndex,
      text: '',
      lines: [],
      error: err instanceof Error ? err.message : 'Vision OCR failed',
    };
  }
}
