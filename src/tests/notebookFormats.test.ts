import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  exportNotebookToIpynb,
  exportNotebookToMarkdown,
  exportNotebookToPython,
  importNotebookFromIpynb,
} from '../engine/notebook/ipynbCodec';
import { createNotebookFromTemplate } from '../engine/notebook/notebookTemplates';
import { renderMathMarkdown } from '../engine/notebook/mathMarkdown';
import { highlightPythonToHtml, tokenizePython } from '../engine/notebook/pythonHighlight';
import {
  buildNotebookDependencyGraph,
  extractCellParameters,
  updateParameterInSource,
} from '../engine/notebook/cellGraph';

describe('Forma Lab (.ipynb nbformat v4.5, KaTeX, Python Kernel)', () => {
  it('round-trips .ipynb preserving code, markdown, outputs, images, HTML tables, and metadata', () => {
    const nb = createNotebookFromTemplate('grad');
    nb.cells[1].execution_count = 3;
    nb.cells[1].outputs = [
      { output_type: 'stream', name: 'stdout', text: 'step=0 | loss=29.125\n' },
      {
        output_type: 'execute_result',
        execution_count: 3,
        data: { 'text/plain': '3.49', 'text/html': '<table><tr><td>3.49</td></tr></table>' },
      },
      {
        output_type: 'display_data',
        data: { 'image/png': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' },
      },
    ];

    const json = exportNotebookToIpynb(nb);
    const parsed = JSON.parse(json);
    expect(parsed.nbformat).toBe(4);
    expect(parsed.nbformat_minor).toBe(5);

    const reimported = importNotebookFromIpynb(json, 'GradLab.ipynb');
    expect(reimported.cells.length).toBe(nb.cells.length);
    expect(reimported.cells[0].pinnedConcept).toBe(true);
    expect(reimported.cells[1].execution_count).toBe(3);
    expect(reimported.cells[1].outputs?.length).toBe(3);
    expect(reimported.cells[1].outputs?.[2].output_type).toBe('display_data');
  });

  it('exports clean Jupytext .py and Markdown .md', () => {
    const nb = createNotebookFromTemplate('attention');
    const py = exportNotebookToPython(nb);
    expect(py).toContain('# %% [markdown]');
    expect(py).toContain('def softmax(xs):');

    const md = exportNotebookToMarkdown(nb);
    expect(md).toContain('```python');
    expect(md).toContain('\\text{Attention}(Q, K, V)');
  });

  it('renders KaTeX display and inline math cleanly while protecting code spans', () => {
    const html = renderMathMarkdown('Loss $\\mathcal{L}$ and `cost = $5`:\n\n$$x^2 + y^2 = z^2$$');
    expect(html).toContain('katex');
    expect(html).toContain('<code>cost = $5</code>');
  });

  it('executes persistent Python sessions in macos/forma_kernel.py', () => {
    const kernelPath = path.resolve(process.cwd(), 'macos/forma_kernel.py');
    const cmds = [
      JSON.stringify({ type: 'exec', reqId: 'r1', code: 'x = 21\nprint("hi")' }),
      JSON.stringify({ type: 'exec', reqId: 'r2', code: 'x * 2' }),
      JSON.stringify({ type: 'exec', reqId: 'r3', code: '1 / 0' }),
    ].join('\n') + '\n';

    const out = execFileSync('python3', [kernelPath], { input: cmds, encoding: 'utf8' });
    const lines = out.trim().split('\n').map((l) => JSON.parse(l));

    expect(lines[0].type).toBe('ready');
    // r1: stdout captured + variable x inspected
    expect(lines[1].reqId).toBe('r1');
    expect(lines[1].ok).toBe(true);
    expect(lines[1].outputs[0].text).toContain('hi');
    expect(lines[1].variables.some((v: { name: string }) => v.name === 'x')).toBe(true);
    // r2: persistent x * 2 -> execute_result 42
    expect(lines[2].reqId).toBe('r2');
    expect(lines[2].outputs[0].data['text/plain']).toBe('42');
    // r3: clean ZeroDivisionError traceback
    expect(lines[3].ok).toBe(false);
    expect(lines[3].outputs[0].ename).toBe('ZeroDivisionError');
  });

  it('tokenizes and highlights Python 3 syntax cleanly with HTML escaping', () => {
    const code = '@torch.no_grad\ndef step(x, lr=1e-3):\n    # update <weight>\n    return f"val={x}" if x is not None else 0';
    const tokens = tokenizePython(code);
    expect(tokens.some((t) => t.kind === 'decorator' && t.value === '@torch.no_grad')).toBe(true);
    expect(tokens.some((t) => t.kind === 'keyword' && t.value === 'def')).toBe(true);
    expect(tokens.some((t) => t.kind === 'defname' && t.value === 'step')).toBe(true);
    expect(tokens.some((t) => t.kind === 'number' && t.value === '1e-3')).toBe(true);
    expect(tokens.some((t) => t.kind === 'comment' && t.value.includes('<weight>'))).toBe(true);
    expect(tokens.some((t) => t.kind === 'string' && t.value === 'f"val={x}"')).toBe(true);
    expect(tokens.some((t) => t.kind === 'constant' && t.value === 'None')).toBe(true);

    const html = highlightPythonToHtml(code);
    expect(html).toContain('py-tok-keyword');
    expect(html).toContain('py-tok-decorator');
    expect(html).toContain('&lt;weight&gt;');
  });

  it('builds cell dependency DAG and parses/updates interactive parameter sliders', () => {
    const nb = createNotebookFromTemplate('grad');
    const graph = buildNotebookDependencyGraph(nb.cells);
    const cell1 = nb.cells[1]; // defines history
    const cell2 = nb.cells[3]; // uses history

    expect(graph.getTransitiveDownstream(cell1.id)).toEqual([cell2.id]);
    expect(graph.getStaleUpstreamSymbols(cell2.id, new Set([cell1.id]))).toContain('history');

    const sliders = extractCellParameters(cell1.source, false);
    expect(sliders.map((s) => s.name)).toEqual(['lr', 'num_steps']);
    expect(sliders[0].min).toBe(0.05);
    expect(sliders[0].max).toBe(2.05);

    const updated = updateParameterInSource(cell1.source, sliders[0], 0.85);
    expect(updated).toContain('lr = 0.85  # @slider 0.05..2.05 step=0.05');
  });

  it('traces Python cell execution step-by-step via sys.settrace in forma_kernel.py', () => {
    const kernelPath = path.resolve(process.cwd(), 'macos/forma_kernel.py');
    const code = 'total = 0\nfor i in range(3):\n    total += i + 1\n    print("i=", i)\ntotal';
    const cmd = JSON.stringify({ type: 'trace', reqId: 't1', code, max_steps: 50 }) + '\n';

    const out = execFileSync('python3', [kernelPath], { input: cmd, encoding: 'utf8' });
    const lines = out.trim().split('\n').map((l) => JSON.parse(l));
    const traceRes = lines[1];

    expect(traceRes.type).toBe('trace_result');
    expect(traceRes.ok).toBe(true);
    expect(traceRes.trace.truncated).toBe(false);
    expect(traceRes.trace.steps.length).toBeGreaterThanOrEqual(8);
    // Verify variable change diffs were tracked
    const hasChangedTotal = traceRes.trace.steps.some((s: { locals: Array<{ name: string; changed: boolean }> }) =>
      s.locals.some((v) => v.name === 'total' && v.changed)
    );
    expect(hasChangedTotal).toBe(true);
    // Final output is 6
    expect(traceRes.outputs.some((o: { data?: { 'text/plain'?: string } }) => o.data?.['text/plain'] === '6')).toBe(
      true
    );
  });
});
