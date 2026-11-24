import { NotebookCell } from '../../types/notebook';
import { tokenizePython } from './pythonHighlight';

export interface CellParameterSlider {
  name: string;
  lineIndex: number; // 0-based line number
  value: number;
  min: number;
  max: number;
  step: number;
  isInt: boolean;
  explicit: boolean; // true if declared with `# @slider ...`
}

export interface CellDepEdge {
  cellId: string;
  symbols: string[];
}

export interface NotebookDependencyGraph {
  definesByCell: Record<string, string[]>;
  upstreamByCell: Record<string, CellDepEdge[]>;
  downstreamByCell: Record<string, CellDepEdge[]>;
  /** All downstream cell IDs (transitively) in notebook top-to-bottom order */
  getTransitiveDownstream: (cellId: string) => string[];
  /** Symbols shared between any edited/stale upstream cells and this cell */
  getStaleUpstreamSymbols: (cellId: string, staleCellIds: Set<string>) => string[];
}

const SKIP_IDENT = new Set([
  'True',
  'False',
  'None',
  'self',
  'cls',
  'print',
  'len',
  'range',
  'enumerate',
  'zip',
  'map',
  'filter',
  'sum',
  'min',
  'max',
  'abs',
  'round',
  'sorted',
  'list',
  'dict',
  'set',
  'tuple',
  'str',
  'int',
  'float',
  'bool',
  'type',
  'isinstance',
  'open',
  'super',
  'Exception',
  'ValueError',
  'TypeError',
]);

/** Extract top-level defined symbols and referenced symbols from a Python code cell. */
export function extractCellSymbols(source: string): { defines: Set<string>; uses: Set<string> } {
  const defines = new Set<string>();
  const uses = new Set<string>();

  const lines = source.split('\n');
  for (const rawLine of lines) {
    // Only consider top-level definitions (no leading whitespace)
    if (rawLine.startsWith(' ') || rawLine.startsWith('\t')) continue;
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    // def foo(...) or async def foo(...)
    const defMatch = line.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
    if (defMatch) {
      defines.add(defMatch[1]);
      continue;
    }

    // class Bar...
    const clsMatch = line.match(/^class\s+([A-Za-z_]\w*)\b/);
    if (clsMatch) {
      defines.add(clsMatch[1]);
      continue;
    }

    // import a as b, c
    const impMatch = line.match(/^import\s+(.+)$/);
    if (impMatch) {
      for (const part of impMatch[1].split(',')) {
        const alias = part.trim().match(/^[\w.]+\s+as\s+([A-Za-z_]\w*)$/);
        if (alias) defines.add(alias[1]);
        else {
          const base = part.trim().split('.')[0];
          if (/^[A-Za-z_]\w*$/.test(base)) defines.add(base);
        }
      }
      continue;
    }

    // from x import y as z, w
    const fromMatch = line.match(/^from\s+[\w.]+\s+import\s+(.+)$/);
    if (fromMatch) {
      const cleaned = fromMatch[1].replace(/[()]/g, '');
      for (const part of cleaned.split(',')) {
        const alias = part.trim().match(/^[A-Za-z_]\w*\s+as\s+([A-Za-z_]\w*)$/);
        if (alias) defines.add(alias[1]);
        else {
          const name = part.trim();
          if (/^[A-Za-z_]\w*$/.test(name)) defines.add(name);
        }
      }
      continue;
    }

    // for i, x in ...
    const forMatch = line.match(/^for\s+([A-Za-z_][\w\s,]*?)\s+in\b/);
    if (forMatch) {
      for (const v of forMatch[1].split(',')) {
        const trimmed = v.trim();
        if (/^[A-Za-z_]\w*$/.test(trimmed) && trimmed !== '_') defines.add(trimmed);
      }
      continue;
    }

    // Top-level assignment: x = ..., x: float = ..., a, b = ...
    // Exclude ==, !=, <=, >=
    const assignMatch = line.match(
      /^([A-Za-z_][\w\s,]*?)(?:\s*:\s*[^=]+)?\s*(?<![=!<>+\-*/%])=(?!=)/
    );
    if (assignMatch) {
      for (const v of assignMatch[1].split(',')) {
        const trimmed = v.trim();
        if (/^[A-Za-z_]\w*$/.test(trimmed) && trimmed !== '_') {
          defines.add(trimmed);
        }
      }
    }
  }

  // Tokenize to find identifier references cleanly (skipping comments, strings, keywords, attr lookups after '.')
  const tokens = tokenizePython(source);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.kind !== 'plain' && tok.kind !== 'builtin' && tok.kind !== 'defname') continue;
    // Match individual identifiers inside plain chunks
    const prev = i > 0 ? tokens[i - 1].value.trimEnd() : '';
    const isAfterDot = prev.endsWith('.');
    if (isAfterDot) continue;

    const regex = /\b([A-Za-z_]\w*)\b/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(tok.value)) !== null) {
      const name = m[1];
      if (SKIP_IDENT.has(name)) continue;
      // Check if preceded by '.' within the same plain token
      if (m.index > 0 && tok.value[m.index - 1] === '.') continue;
      // Check if it's a keyword arg like `step=0.1`
      const after = tok.value.slice(m.index + name.length);
      if (/^\s*=(?!=)/.test(after)) continue;
      uses.add(name);
    }
  }

  return { defines, uses };
}

/** Build a live top-to-bottom dependency graph across all code cells in a notebook. */
export function buildNotebookDependencyGraph(cells: NotebookCell[]): NotebookDependencyGraph {
  const codeCells = cells.filter((c) => c.cell_type === 'code');
  const definesByCell: Record<string, string[]> = {};
  const upstreamByCell: Record<string, CellDepEdge[]> = {};
  const downstreamByCell: Record<string, CellDepEdge[]> = {};

  const lastDefiner = new Map<string, string>(); // symbol -> most recent upstream cellId

  for (const cell of codeCells) {
    upstreamByCell[cell.id] = [];
    downstreamByCell[cell.id] = [];
  }

  for (const cell of codeCells) {
    const { defines, uses } = extractCellSymbols(cell.source);
    definesByCell[cell.id] = Array.from(defines);

    // Resolve upstream dependencies from symbols defined in earlier cells
    const upstreamMap = new Map<string, string[]>();
    for (const sym of uses) {
      const providerId = lastDefiner.get(sym);
      if (!providerId || providerId === cell.id) continue;
      // If this cell defines `sym` purely on its own without reading it from upstream?
      // Still allow if `sym` appears on RHS or earlier; common case `x = x + 1` or reading `lr`.
      const list = upstreamMap.get(providerId) ?? [];
      if (!list.includes(sym)) list.push(sym);
      upstreamMap.set(providerId, list);
    }

    for (const [providerId, symbols] of upstreamMap.entries()) {
      upstreamByCell[cell.id].push({ cellId: providerId, symbols });
      downstreamByCell[providerId].push({ cellId: cell.id, symbols });
    }

    // Register this cell as the latest provider of its defined symbols
    for (const sym of defines) {
      lastDefiner.set(sym, cell.id);
    }
  }

  const orderIndex = new Map<string, number>();
  codeCells.forEach((c, idx) => orderIndex.set(c.id, idx));

  const getTransitiveDownstream = (startCellId: string): string[] => {
    const visited = new Set<string>();
    const queue = [startCellId];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const edge of downstreamByCell[cur] ?? []) {
        if (!visited.has(edge.cellId) && edge.cellId !== startCellId) {
          visited.add(edge.cellId);
          queue.push(edge.cellId);
        }
      }
    }
    return Array.from(visited).sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0));
  };

  const getStaleUpstreamSymbols = (cellId: string, staleCellIds: Set<string>): string[] => {
    if (staleCellIds.size === 0) return [];
    const syms = new Set<string>();
    // Walk upstream edges from cellId; if any ancestor is stale, collect linking symbols
    const visited = new Set<string>();
    const dfs = (id: string, topSymbols?: string[]) => {
      for (const edge of upstreamByCell[id] ?? []) {
        const directSyms = topSymbols ?? edge.symbols;
        if (staleCellIds.has(edge.cellId)) {
          directSyms.forEach((s) => syms.add(s));
        }
        if (!visited.has(edge.cellId)) {
          visited.add(edge.cellId);
          dfs(edge.cellId, directSyms);
        }
      }
    };
    dfs(cellId);
    return Array.from(syms);
  };

  return {
    definesByCell,
    upstreamByCell,
    downstreamByCell,
    getTransitiveDownstream,
    getStaleUpstreamSymbols,
  };
}

function smartRangeForNumber(val: number, isInt: boolean): { min: number; max: number; step: number } {
  if (isInt) {
    if (val === 0) return { min: 0, max: 20, step: 1 };
    if (val > 0 && val <= 10) return { min: 1, max: Math.max(20, val * 4), step: 1 };
    if (val > 0) return { min: 1, max: Math.max(50, Math.round(val * 3)), step: Math.max(1, Math.round(val / 20)) };
    return { min: Math.round(val * 3), max: Math.abs(Math.round(val * 3)), step: 1 };
  }
  const abs = Math.abs(val);
  if (val > 0 && val < 1) {
    const step = abs < 0.05 ? 0.005 : abs < 0.2 ? 0.01 : 0.05;
    return { min: step, max: Math.max(1, Number((val * 5).toFixed(2))), step };
  }
  if (abs === 0) return { min: -5, max: 5, step: 0.1 };
  const span = Math.max(2, Number((abs * 3).toFixed(2)));
  const step = Number((span / 100).toPrecision(1));
  return {
    min: val < 0 ? -span : 0,
    max: span,
    step: Math.max(0.01, step),
  };
}

/**
 * Detect interactive parameter sliders in a Python code cell.
 * Explicit syntax: `lr = 0.08  # @slider 0.01..1.2 step=0.01`
 * Auto-detected (when `includeAutoDetected = true`): any top-level `name = <number>` assignment.
 */
export function extractCellParameters(
  source: string,
  includeAutoDetected = false
): CellParameterSlider[] {
  const sliders: CellParameterSlider[] = [];
  const lines = source.split('\n');

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    // Top-level simple numeric assignment: `name = -3.14  # optional comment`
    const m = line.match(/^([A-Za-z_]\w*)\s*=\s*(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(?:\s*(#.*))?$/);
    if (!m) continue;
    const name = m[1];
    const numStr = m[2];
    const comment = m[3] ?? '';
    const value = Number(numStr);
    if (!Number.isFinite(value)) continue;
    const isInt = !numStr.includes('.') && !/[eE]/.test(numStr);

    const sliderSpec = comment.match(
      /@slider\s+(-?[\d.]+)\s*(?:\.\.|to|,)\s*(-?[\d.]+)(?:\s*(?:step\s*=|,)\s*([\d.]+))?/i
    );
    if (sliderSpec) {
      const min = Number(sliderSpec[1]);
      const max = Number(sliderSpec[2]);
      const explicitStep = sliderSpec[3] ? Number(sliderSpec[3]) : undefined;
      if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
        const step =
          explicitStep && explicitStep > 0
            ? explicitStep
            : isInt && Number.isInteger(min) && Number.isInteger(max)
              ? 1
              : Number(((max - min) / 100).toPrecision(2));
        sliders.push({
          name,
          lineIndex: idx,
          value,
          min,
          max,
          step,
          isInt: Number.isInteger(step) && isInt,
          explicit: true,
        });
      }
      continue;
    }

    if (includeAutoDetected) {
      const range = smartRangeForNumber(value, isInt);
      sliders.push({
        name,
        lineIndex: idx,
        value,
        min: range.min,
        max: range.max,
        step: range.step,
        isInt,
        explicit: false,
      });
    }
  }

  return sliders;
}

/** Replace the numeric literal on the parameter's line while preserving formatting & comments. */
export function updateParameterInSource(
  source: string,
  param: CellParameterSlider,
  nextValue: number
): string {
  const lines = source.split('\n');
  const target = lines[param.lineIndex];
  if (target === undefined) return source;

  const formatted = param.isInt
    ? String(Math.round(nextValue))
    : String(Number(nextValue.toFixed(6)));

  const updated = target.replace(
    /^([A-Za-z_]\w*\s*=\s*)(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/,
    `$1${formatted}`
  );
  lines[param.lineIndex] = updated;
  return lines.join('\n');
}
