import { execFile } from 'node:child_process';
import { lstat, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { IndexerWorker } from './indexerWorker.mjs';

let creatorsPromise;
const loadCreators = () => (creatorsPromise ??= import('./creators.mjs'));

const execute = promisify(execFile);
const binary = process.env.FORMA_INDEXER_BIN || join(
  homedir(), 'Library', 'Application Support', 'FormaOffice', 'bin', 'forma-indexer'
);
const worker = process.env.FORMA_MCP_PERSISTENT === '0' ? null : new IndexerWorker(binary);
const kinds = z.enum(['document', 'spreadsheet', 'slides', 'pdf', 'notebook', 'canvas', 'image']);
const safeString = (max) => z.string().min(1).max(max).refine(
  value => value.trim().length > 0 && !value.includes('\0'), 'Enter a non-empty string'
);
const filePath = safeString(4096).refine(isAbsolute, 'Use an absolute path');
const readOnly = { readOnlyHint: true, openWorldHint: false };
const localWrite = { readOnlyHint: false, openWorldHint: false };
const allowFolderChanges = process.env.FORMA_MCP_ALLOW_FOLDER_CHANGES === '1';
const apps = new Map([
  ...['docx', 'odt', 'md', 'markdown', 'txt', 'html', 'htm'].map(ext => [ext, 'Forma Docs']),
  ...['xlsx', 'ods', 'csv', 'tsv'].map(ext => [ext, 'Forma Sheets']),
  ...['pptx', 'odp'].map(ext => [ext, 'Forma Slides']),
  ...['fcanvas', 'excalidraw'].map(ext => [ext, 'Forma Canvas']),
  ['pdf', 'Forma PDF'],
  ['ipynb', 'Forma Lab'],
]);

function result(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(payload.ok === false && { isError: true }),
  };
}

function parseIndexerOutput(stdout) {
  const payload = JSON.parse(stdout);
  if (!payload || typeof payload.ok !== 'boolean') throw new Error('Invalid forma-indexer response');
  return result(payload);
}

async function indexer(args, signal) {
  try {
    const payload = await worker?.request(args, signal);
    if (payload) return result(payload);
    const { stdout } = await execute(binary, [...args, '--json'], { signal, maxBuffer: 8 * 1024 * 1024 });
    return parseIndexerOutput(stdout);
  } catch (error) {
    if (error.stdout) {
      try { return parseIndexerOutput(error.stdout); } catch { /* Fall through to the execution error. */ }
    }
    return result({
      ok: false,
      error: error.code === 'ENOENT'
        ? 'forma-indexer is missing. Build Forma with npm run build:mac.'
        : signal?.aborted ? 'Forma request cancelled.' : 'forma-indexer did not return a valid response.',
    });
  }
}

function isWithinWatchedRoots(canonical, roots) {
  return roots.some(root => {
    if (canonical === root) return true;
    const prefix = root === '/' ? root : root + '/';
    return canonical.startsWith(prefix) && !canonical.slice(prefix.length).split('/').some(part => part.startsWith('.'));
  });
}

async function scopedPath(path, signal) {
  const config = await indexer(['folders', 'list'], signal);
  if (config.isError) return config;
  const roots = config.structuredContent?.watchedFolders ?? [];
  const canonical = await realpath(path).catch(() => null);
  if (canonical && isWithinWatchedRoots(canonical, roots)) {
    return canonical;
  }
  return result({ ok: false, error: 'Choose a path inside a folder watched by Forma.' });
}

async function scopedCreatePath(targetPath, allowedExts, signal) {
  const ext = extname(targetPath).slice(1).toLowerCase();
  if (!allowedExts.includes(ext)) {
    return result({
      ok: false,
      error: `Unsupported extension ".${ext}". Allowed: ${allowedExts.map(e => '.' + e).join(', ')}.`,
    });
  }
  const fileName = basename(targetPath);
  if (!fileName || fileName === '.' || fileName === '..' || fileName.startsWith('.')) {
    return result({ ok: false, error: 'Choose a non-hidden filename inside a folder watched by Forma.' });
  }
  const config = await indexer(['folders', 'list'], signal);
  if (config.isError) return config;
  const roots = config.structuredContent?.watchedFolders ?? [];
  const canonicalParent = await realpath(dirname(targetPath)).catch(() => null);
  if (!canonicalParent || !isWithinWatchedRoots(canonicalParent, roots)) {
    return result({ ok: false, error: 'Choose a path inside a folder watched by Forma.' });
  }
  const parentInfo = await stat(canonicalParent).catch(() => null);
  if (!parentInfo?.isDirectory()) {
    return result({ ok: false, error: 'Choose a path inside a folder watched by Forma.' });
  }
  const canonicalTarget = join(canonicalParent, fileName);
  if (!isWithinWatchedRoots(canonicalTarget, roots)) {
    return result({ ok: false, error: 'Choose a path inside a folder watched by Forma.' });
  }
  try {
    const existing = await lstat(canonicalTarget);
    if (existing.isSymbolicLink()) {
      return result({ ok: false, error: 'Refusing to write to a symbolic link.' });
    }
    if (existing.isDirectory()) {
      return result({ ok: false, error: 'Choose a file path, not a directory.' });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return result({ ok: false, error: 'Could not inspect the target path.' });
    }
  }
  return canonicalTarget;
}

async function finalizeCreatedFile(canonicalPath, meta, shouldOpen, signal) {
  let indexed = false;
  try {
    const indexRes = await indexer(['index', canonicalPath], signal);
    indexed = !indexRes.isError;
  } catch {
    indexed = false;
  }
  if (!shouldOpen) {
    return result({ ok: true, path: canonicalPath, ...meta, indexed });
  }
  const app = apps.get(extname(canonicalPath).slice(1).toLowerCase());
  if (!app) {
    return result({ ok: true, path: canonicalPath, ...meta, indexed, opened: false });
  }
  try {
    await execute('/usr/bin/open', ['-a', app, canonicalPath], { signal });
    return result({ ok: true, path: canonicalPath, ...meta, indexed, opened: true, app });
  } catch {
    return result({
      ok: true,
      path: canonicalPath,
      ...meta,
      indexed,
      opened: false,
      app,
      openError: 'Could not open the file in ' + app + '.',
    });
  }
}

const server = new McpServer({ name: 'forma-mcp', version: '1.0.0' });
const closeWorker = () => worker?.close();
process.stdin.once('end', closeWorker);
process.stdin.once('close', closeWorker);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  closeWorker();
  const child = worker?.child;
  if (!child) process.exit(0);
  else {
    child.once('exit', () => process.exit(0));
    setTimeout(() => process.exit(0), 3500).unref();
  }
});
server.server.onclose = closeWorker;

server.registerTool('forma_search', {
  description: 'Search the shared Forma index for matching document sections.',
  inputSchema: { query: safeString(4000), kind: kinds.optional(), limit: z.number().int().min(1).max(50).optional() },
  annotations: readOnly,
}, ({ query, kind, limit }, { signal }) => indexer([
  'search', '--', query, ...(kind ? ['--kind', kind] : []), ...(limit ? ['--limit', String(limit)] : []),
], signal));

server.registerTool('forma_read', {
  description: 'Read an indexed document by ID or a supported file in a watched folder. Can use local Vision OCR for PDFs.',
  inputSchema: { target: safeString(4096), maxChars: z.number().int().min(1).max(250_000).optional(), ocr: z.boolean().optional() },
  annotations: readOnly,
}, async ({ target, maxChars, ocr }, { signal }) => {
  const approved = isAbsolute(target) ? await scopedPath(target, signal) : target;
  if (typeof approved !== 'string') return approved;
  return indexer(['read', '--', approved, ...(maxChars ? ['--max-chars', String(maxChars)] : []), ...(ocr ? ['--ocr'] : [])], signal);
});

server.registerTool('forma_index', {
  description: 'Index a file or subfolder inside a watched folder, or sync all watched folders when no path is provided.',
  inputSchema: { path: filePath.optional(), force: z.boolean().optional() },
  annotations: localWrite,
}, async ({ path, force }, { signal }) => {
  const approved = path ? await scopedPath(path, signal) : undefined;
  if (approved && typeof approved !== 'string') return approved;
  return indexer([...(approved ? ['index', approved] : ['sync']), ...(force ? ['--force'] : [])], signal);
});

server.registerTool('forma_status', {
  description: 'Show index counts, watched folders, the embedding backend, and the last full sync time.',
  inputSchema: {},
  annotations: readOnly,
}, (_args, { signal }) => indexer(['status'], signal));

server.registerTool('forma_folders', {
  description: allowFolderChanges
    ? 'List, add, or remove watched folders. Removing a folder prunes its index entries.'
    : 'List watched folders. Manage folder access in Forma.',
  inputSchema: z.object({ action: z.enum(['list', 'add', 'remove']), path: filePath.optional() }).refine(
    ({ action, path }) => action === 'list' ? path === undefined : path !== undefined,
    { path: ['path'], message: 'Provide a folder path for add or remove only' }
  ),
  annotations: allowFolderChanges ? { ...localWrite, destructiveHint: true } : readOnly,
}, ({ action, path }, { signal }) => {
  if (action !== 'list' && !allowFolderChanges) {
    return result({ ok: false, error: 'Manage watched folders in Forma or with the local forma-indexer CLI.' });
  }
  return indexer(['folders', action, ...(path ? [path] : [])], signal);
});

server.registerTool('forma_open', {
  description: 'Open a document in a watched folder in the associated native macOS Forma app.',
  inputSchema: { path: filePath },
  annotations: localWrite,
}, async ({ path }, { signal }) => {
  const app = apps.get(extname(path).slice(1).toLowerCase());
  if (!app) return result({ ok: false, error: 'No Forma app supports this extension.' });
  const approved = await scopedPath(path, signal);
  if (typeof approved !== 'string') return approved;
  try {
    if (!(await stat(approved)).isFile()) return result({ ok: false, error: 'Choose a file.' });
    await execute('/usr/bin/open', ['-a', app, approved], { signal });
    return result({ ok: true, path: approved, app });
  } catch {
    return result({ ok: false, error: 'Could not open the file in ' + app + '.' });
  }
});

server.registerTool('forma_create_canvas', {
  description: 'Create a Forma Canvas (.fcanvas) or Excalidraw (.excalidraw) diagram inside a watched folder from a Mermaid flowchart or starter template.',
  inputSchema: {
    path: filePath,
    title: safeString(200).optional(),
    mermaid: z.string().max(100_000).optional(),
    template: z.enum(['blank', 'architecture', 'mindmap', 'kanban']).optional(),
    open: z.boolean().optional(),
  },
  annotations: localWrite,
}, async ({ path, title, mermaid, template, open }, { signal }) => {
  const approved = await scopedCreatePath(path, ['fcanvas', 'excalidraw'], signal);
  if (typeof approved !== 'string') return approved;
  try {
    const { createCanvasFile } = await loadCreators();
    const meta = await createCanvasFile({ path: approved, title, mermaid, template });
    return finalizeCreatedFile(approved, meta, Boolean(open), signal);
  } catch (error) {
    return result({ ok: false, error: error instanceof Error ? error.message : 'Could not create canvas file.' });
  }
});

server.registerTool('forma_create_sheet', {
  description: 'Create an Excel (.xlsx) or CSV (.csv) spreadsheet inside a watched folder with optional formulas (values starting with "=") and styled headers.',
  inputSchema: {
    path: filePath,
    title: safeString(200).optional(),
    sheets: z.array(z.object({
      name: safeString(100),
      rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).max(50_000),
    })).min(1).max(50),
    open: z.boolean().optional(),
  },
  annotations: localWrite,
}, async ({ path, title, sheets, open }, { signal }) => {
  const approved = await scopedCreatePath(path, ['xlsx', 'csv'], signal);
  if (typeof approved !== 'string') return approved;
  try {
    const { createSheetFile } = await loadCreators();
    const meta = await createSheetFile({ path: approved, title, sheets });
    return finalizeCreatedFile(approved, meta, Boolean(open), signal);
  } catch (error) {
    return result({ ok: false, error: error instanceof Error ? error.message : 'Could not create spreadsheet file.' });
  }
});

server.registerTool('forma_create_slides', {
  description: 'Create a 16:9 PowerPoint (.pptx) presentation inside a watched folder with themed slides, bullets, and optional speaker notes.',
  inputSchema: {
    path: filePath,
    title: safeString(200).optional(),
    theme: z.enum(['light', 'dark', 'ocean']).optional(),
    slides: z.array(z.object({
      title: safeString(300),
      subtitle: z.string().max(500).optional(),
      bullets: z.array(z.string().max(1000)).max(30).optional(),
      notes: z.string().max(10_000).optional(),
    })).min(1).max(100),
    open: z.boolean().optional(),
  },
  annotations: localWrite,
}, async ({ path, title, theme, slides, open }, { signal }) => {
  const approved = await scopedCreatePath(path, ['pptx'], signal);
  if (typeof approved !== 'string') return approved;
  try {
    const { createSlidesFile } = await loadCreators();
    const meta = await createSlidesFile({ path: approved, title, theme, slides });
    return finalizeCreatedFile(approved, meta, Boolean(open), signal);
  } catch (error) {
    return result({ ok: false, error: error instanceof Error ? error.message : 'Could not create presentation file.' });
  }
});

server.registerTool('forma_create_doc', {
  description: 'Create a Word (.docx) or Markdown (.md) document inside a watched folder from Markdown content including headings, lists, code blocks, and tables.',
  inputSchema: {
    path: filePath,
    title: safeString(200).optional(),
    markdown: z.string().max(500_000),
    open: z.boolean().optional(),
  },
  annotations: localWrite,
}, async ({ path, title, markdown, open }, { signal }) => {
  const approved = await scopedCreatePath(path, ['docx', 'md'], signal);
  if (typeof approved !== 'string') return approved;
  try {
    const { createDocFile } = await loadCreators();
    const meta = await createDocFile({ path: approved, title, markdown });
    return finalizeCreatedFile(approved, meta, Boolean(open), signal);
  } catch (error) {
    return result({ ok: false, error: error instanceof Error ? error.message : 'Could not create document file.' });
  }
});

await server.connect(new StdioServerTransport());
