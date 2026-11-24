import {
  NotebookCell,
  NotebookCellType,
  NotebookData,
  NotebookOutput,
  RichDataBundle,
} from '../../types/notebook';
import { uid } from '../spreadsheet/workbookOps';

function joinSource(src: unknown): string {
  if (typeof src === 'string') return src;
  if (Array.isArray(src)) return src.map((s) => String(s)).join('');
  return '';
}

function splitSourceLines(src: string): string[] {
  if (!src) return [];
  const lines = src.split('\n');
  return lines.map((line, idx) => (idx < lines.length - 1 ? `${line}\n` : line));
}

function serializeDataBundle(bundle: RichDataBundle): Record<string, unknown> {
  const out: Record<string, unknown> = { ...bundle };
  const textKeys: Array<keyof RichDataBundle> = ['text/plain', 'text/html', 'text/latex', 'image/svg+xml'];
  for (const k of textKeys) {
    const val = bundle[k];
    if (typeof val === 'string') {
      out[k] = splitSourceLines(val);
    }
  }
  return out;
}

function normalizeDataBundle(raw: unknown): RichDataBundle {
  if (!raw || typeof raw !== 'object') return {};
  const rec = raw as Record<string, unknown>;
  const out: RichDataBundle = { ...rec };
  const keys: Array<keyof RichDataBundle> = [
    'text/plain',
    'text/html',
    'image/png',
    'image/jpeg',
    'image/svg+xml',
    'text/latex',
  ];
  for (const k of keys) {
    if (rec[k] !== undefined) {
      out[k] = joinSource(rec[k]);
    }
  }
  return out;
}

function normalizeOutput(raw: unknown): NotebookOutput | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const type = o.output_type;

  if (type === 'stream') {
    return {
      output_type: 'stream',
      name: o.name === 'stderr' ? 'stderr' : 'stdout',
      text: joinSource(o.text),
    };
  }
  if (type === 'execute_result') {
    return {
      output_type: 'execute_result',
      execution_count: typeof o.execution_count === 'number' ? o.execution_count : null,
      data: normalizeDataBundle(o.data),
      metadata: (o.metadata as Record<string, unknown>) ?? {},
    };
  }
  if (type === 'display_data') {
    return {
      output_type: 'display_data',
      data: normalizeDataBundle(o.data),
      metadata: (o.metadata as Record<string, unknown>) ?? {},
    };
  }
  if (type === 'error') {
    return {
      output_type: 'error',
      ename: String(o.ename ?? 'Error'),
      evalue: String(o.evalue ?? ''),
      traceback: Array.isArray(o.traceback) ? o.traceback.map(String) : [],
    };
  }
  return null;
}

/**
 * Import a standard Jupyter Notebook (.ipynb — nbformat v3 and v4.x JSON, stripping UTF-8 BOM).
 */
export function importNotebookFromIpynb(
  jsonText: string,
  filename = 'Imported Notebook'
): NotebookData {
  const parsed = JSON.parse(jsonText.replace(/^\uFEFF/, '')) as {
    cells?: Array<Record<string, unknown>>;
    worksheets?: Array<{ cells?: Array<Record<string, unknown>> }>;
    metadata?: {
      kernelspec?: { display_name?: string; name?: string };
      language_info?: { version?: string };
    };
  };

  const rawCells = Array.isArray(parsed.cells)
    ? parsed.cells
    : Array.isArray(parsed.worksheets)
      ? parsed.worksheets.flatMap((ws) => (Array.isArray(ws?.cells) ? ws.cells : []))
      : [];
  const cells: NotebookCell[] = rawCells.map((c) => {
    const isHeading = c.cell_type === 'heading';
    const cType: NotebookCellType =
      c.cell_type === 'markdown' || isHeading
        ? 'markdown'
        : c.cell_type === 'raw'
          ? 'raw'
          : 'code';
    const meta = (c.metadata as Record<string, unknown>) ?? {};
    const formaMeta = (meta.forma as Record<string, unknown>) ?? {};

    const outputs =
      cType === 'code' && Array.isArray(c.outputs)
        ? c.outputs.map(normalizeOutput).filter((x): x is NotebookOutput => x !== null)
        : [];

    const rawSource = joinSource(c.source ?? c.input);
    const headingLevel =
      isHeading && typeof c.level === 'number' ? Math.max(1, Math.min(6, c.level)) : 1;
    const source = isHeading ? `${'#'.repeat(headingLevel)} ${rawSource}` : rawSource;
    const execCount =
      typeof c.execution_count === 'number'
        ? c.execution_count
        : typeof c.prompt_number === 'number'
          ? c.prompt_number
          : null;

    return {
      id: typeof c.id === 'string' && c.id ? c.id : uid('cell'),
      cell_type: cType,
      source,
      execution_count: cType === 'code' ? execCount : null,
      outputs,
      metadata: meta,
      attachments: c.attachments as Record<string, RichDataBundle> | undefined,
      collapsedCode: Boolean(formaMeta.collapsedCode),
      collapsedOutput: Boolean(formaMeta.collapsedOutput),
      pinnedConcept: Boolean(formaMeta.pinnedConcept),
    };
  });

  if (cells.length === 0) {
    cells.push({
      id: uid('cell'),
      cell_type: 'code',
      source: '',
      execution_count: null,
      outputs: [],
    });
  }

  const now = Date.now();
  return {
    id: uid('nb'),
    title: filename.replace(/\.ipynb$/i, ''),
    cells,
    metadata: parsed.metadata,
    kernelName:
      parsed.metadata?.kernelspec?.display_name ??
      parsed.metadata?.kernelspec?.name ??
      'Python 3',
    pythonVersion: parsed.metadata?.language_info?.version,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Export a Forma Lab notebook to spec-compliant Jupyter nbformat v4.5 JSON (.ipynb).
 */
export function exportNotebookToIpynb(nb: NotebookData): string {
  const ipynb = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      ...nb.metadata,
      kernelspec: {
        display_name: nb.kernelName || 'Python 3',
        language: 'python',
        name: 'python3',
        ...(nb.metadata?.kernelspec as Record<string, unknown>),
      },
      language_info: {
        name: 'python',
        version: nb.pythonVersion || '3.12',
        mimetype: 'text/x-python',
        file_extension: '.py',
        ...(nb.metadata?.language_info as Record<string, unknown>),
      },
    },
    cells: nb.cells.map((cell) => {
      const formaMeta: Record<string, boolean> = {};
      if (cell.collapsedCode) formaMeta.collapsedCode = true;
      if (cell.collapsedOutput) formaMeta.collapsedOutput = true;
      if (cell.pinnedConcept) formaMeta.pinnedConcept = true;

      const baseMeta = { ...cell.metadata, forma: { ...(cell.metadata?.forma as object), ...formaMeta } };
      for (const key of ['collapsedCode', 'collapsedOutput', 'pinnedConcept'] as const) {
        baseMeta.forma[key] = Boolean(cell[key]);
      }

      if (cell.cell_type === 'code') {
        return {
          id: cell.id,
          cell_type: 'code',
          execution_count: cell.execution_count ?? null,
          metadata: baseMeta,
          source: splitSourceLines(cell.source),
          outputs: (cell.outputs ?? []).map((o) => {
            if (o.output_type === 'stream') {
              return {
                output_type: 'stream',
                name: o.name,
                text: splitSourceLines(o.text),
              };
            }
            if (o.output_type === 'execute_result') {
              return {
                output_type: 'execute_result',
                execution_count: o.execution_count ?? null,
                data: serializeDataBundle(o.data),
                metadata: o.metadata ?? {},
              };
            }
            if (o.output_type === 'display_data') {
              return {
                output_type: 'display_data',
                data: serializeDataBundle(o.data),
                metadata: o.metadata ?? {},
              };
            }
            return {
              output_type: 'error',
              ename: o.ename,
              evalue: o.evalue,
              traceback: o.traceback,
            };
          }),
        };
      }

      return {
        id: cell.id,
        cell_type: cell.cell_type,
        attachments: cell.attachments,
        metadata: baseMeta,
        source: splitSourceLines(cell.source),
      };
    }),
  };

  return JSON.stringify(ipynb, null, 2) + '\n';
}

/** Export notebook as a clean Jupytext / VS Code percent-format Python script (.py) */
export function exportNotebookToPython(nb: NotebookData): string {
  const parts: string[] = [`# ${nb.title}\n# Exported from Forma Lab\n`];
  for (const cell of nb.cells) {
    if (cell.cell_type === 'markdown' || cell.cell_type === 'raw') {
      const tag = cell.cell_type === 'raw' ? 'raw' : 'markdown';
      const commented = cell.source
        .split('\n')
        .map((l) => (l ? `# ${l}` : '#'))
        .join('\n');
      parts.push(`# %% [${tag}]\n${commented}\n`);
    } else if (cell.cell_type === 'code') {
      parts.push(`# %%\n${cell.source}\n`);
    }
  }
  return parts.join('\n');
}

/** Export notebook as clean Markdown with LaTeX math and fenced Python blocks (.md) */
export function exportNotebookToMarkdown(nb: NotebookData): string {
  const parts: string[] = [];
  for (const cell of nb.cells) {
    if (cell.cell_type === 'markdown') {
      parts.push(cell.source.trim());
    } else if (cell.cell_type === 'raw') {
      if (cell.source.trim()) parts.push(`\`\`\`text\n${cell.source}\n\`\`\``);
    } else if (cell.cell_type === 'code') {
      parts.push(`\`\`\`python\n${cell.source}\n\`\`\``);
    }
  }
  return parts.filter(Boolean).join('\n\n') + '\n';
}
