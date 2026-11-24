import { describe, expect, it } from 'vitest';
import {
  CANVAS_TEMPLATES,
  createBlankCanvas,
  createCanvasFromTemplate,
} from '../engine/canvas/canvasTemplates';
import {
  computeElementBounds,
  exportCanvasToExcalidraw,
  exportCanvasToFcanvas,
  exportCanvasToPdf,
  exportCanvasToSvg,
  importCanvasFromExcalidraw,
  importCanvasFromFcanvas,
  importMermaidToCanvas,
  resolveBoundEndpoints,
} from '../engine/canvas/canvasCodec';
import {
  extractCanvasIndexImages,
  extractCanvasIndexText,
  extractNotebookIndexImages,
  isMultimodalEmbedModel,
} from '../storage/aiSemanticStore';
import { createBlankNotebook } from '../engine/notebook/notebookTemplates';
import { listWorkspaceFiles } from '../storage/workspaceStore';
import { CanvasElement } from '../types/canvas';

describe('Forma Canvas templates, codecs & semantic extraction', () => {
  it('builds all 4 built-in templates with valid geometry and bound connectors', () => {
    expect(CANVAS_TEMPLATES.map((t) => t.id)).toEqual([
      'blank',
      'architecture',
      'mindmap',
      'kanban',
    ]);

    const blank = createBlankCanvas('Empty Board');
    expect(blank.title).toBe('Empty Board');
    expect(blank.elements).toHaveLength(0);

    const arch = createCanvasFromTemplate('architecture');
    expect(arch.elements.length).toBeGreaterThan(8);
    expect(arch.elements.some((e) => e.kind === 'frame')).toBe(true);
    const boundArrow = arch.elements.find((e) => e.kind === 'arrow' && e.startBinding && e.endBinding);
    expect(boundArrow).toBeDefined();
    if (boundArrow) {
      const endpoints = resolveBoundEndpoints(boundArrow, arch.elements);
      expect(Number.isFinite(endpoints.start.x)).toBe(true);
      expect(Number.isFinite(endpoints.end.x)).toBe(true);
      expect(endpoints.start.x !== endpoints.end.x || endpoints.start.y !== endpoints.end.y).toBe(true);
    }

    const mindmap = createCanvasFromTemplate('mindmap');
    expect(mindmap.elements.some((e) => e.kind === 'ellipse' || e.kind === 'roundRect')).toBe(true);
    expect(mindmap.elements.some((e) => e.kind === 'sticky')).toBe(true);

    const kanban = createCanvasFromTemplate('kanban');
    expect(kanban.elements.filter((e) => e.kind === 'frame').length).toBeGreaterThanOrEqual(3);
    expect(kanban.elements.filter((e) => e.kind === 'sticky').length).toBeGreaterThanOrEqual(3);
  });

  it('round-trips .fcanvas JSON losslessly including bindings, roughness, frames & viewport', () => {
    const arch = createCanvasFromTemplate('architecture');
    arch.viewport = { x: -120, y: 45, zoom: 1.25 };
    arch.background = 'grid';
    arch.theme = 'dark';
    arch.elements.push({
      id: 'free_1',
      kind: 'freehand',
      x: 50,
      y: 80,
      width: 100,
      height: 40,
      points: [
        { x: 0, y: 0 },
        { x: 50, y: 20 },
        { x: 100, y: 40 },
      ],
      stroke: '#0ea5e9',
      strokeWidth: 3,
      roughness: 1,
      opacity: 0.9,
    });

    const json = exportCanvasToFcanvas(arch);
    const parsed = importCanvasFromFcanvas(json, 'System Diagram.fcanvas');

    expect(parsed.title).toBe(arch.title);
    expect(parsed.background).toBe('grid');
    expect(parsed.theme).toBe('dark');
    expect(parsed.viewport).toEqual({ x: -120, y: 45, zoom: 1.25 });
    expect(parsed.elements).toHaveLength(arch.elements.length);

    const importedFree = parsed.elements.find((e) => e.id === 'free_1');
    expect(importedFree?.kind).toBe('freehand');
    expect(importedFree?.points).toHaveLength(3);
    expect(importedFree?.roughness).toBe(1);

    const origBound = arch.elements.find((e) => e.startBinding && e.endBinding);
    const impBound = parsed.elements.find((e) => e.id === origBound?.id);
    expect(impBound?.startBinding).toEqual(origBound?.startBinding);
    expect(impBound?.endBinding).toEqual(origBound?.endBinding);
  });

  it('exports and re-imports Excalidraw v2 (.excalidraw) files cleanly', () => {
    const board = createCanvasFromTemplate('architecture');
    const excalidrawJson = exportCanvasToExcalidraw(board);
    const raw = JSON.parse(excalidrawJson) as { type: string; version: number; elements: unknown[] };

    expect(raw.type).toBe('excalidraw');
    expect(raw.version).toBe(2);
    expect(raw.elements.length).toBeGreaterThan(0);

    const reimported = importCanvasFromExcalidraw(excalidrawJson, 'Imported Board.excalidraw');
    expect(reimported.title).toBe('Imported Board');
    expect(reimported.elements.length).toBeGreaterThan(5);
    expect(reimported.elements.some((e) => e.kind === 'arrow')).toBe(true);
    expect(
      reimported.elements.some((e) => (e.text ?? '').toLowerCase().includes('gateway'))
    ).toBe(true);

    // Auto-detection via importCanvasFromFcanvas should also accept .excalidraw payloads
    const autoDetected = importCanvasFromFcanvas(excalidrawJson, 'Auto.excalidraw');
    expect(autoDetected.elements.length).toBe(reimported.elements.length);
  });

  it('converts Mermaid flowcharts (subgraphs, decision diamonds, labeled edges) into bound Canvas elements', () => {
    const mermaid = `
      graph LR
        subgraph Edge Layer
          A[Web Client] -->|HTTPS| B(API Gateway)
        end
        B --> C{Auth Valid?}
        C -->|Yes| D((Core Engine))
        C -->|No| E[401 Error]
    `;
    const elements = importMermaidToCanvas(mermaid);
    expect(elements.length).toBeGreaterThanOrEqual(9);

    const nodes = elements.filter((e) => e.kind !== 'arrow' && e.kind !== 'frame');
    const arrows = elements.filter((e) => e.kind === 'arrow');
    const frames = elements.filter((e) => e.kind === 'frame');

    expect(nodes.some((n) => n.text === 'Web Client')).toBe(true);
    expect(nodes.some((n) => n.kind === 'diamond' && n.text === 'Auth Valid?')).toBe(true);
    expect(nodes.some((n) => n.kind === 'ellipse' && n.text === 'Core Engine')).toBe(true);
    expect(frames.some((f) => f.text === 'Edge Layer')).toBe(true);

    expect(arrows).toHaveLength(4);
    expect(arrows.every((a) => Boolean(a.startBinding && a.endBinding))).toBe(true);
    expect(arrows.some((a) => a.text === 'HTTPS')).toBe(true);
  });

  it('exports valid SVG markup and vector PDF bytes', async () => {
    const board = createCanvasFromTemplate('mindmap');
    const svg = exportCanvasToSvg(board);
    expect(svg).toContain('<svg');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('</svg>');

    const bounds = computeElementBounds(board.elements);
    expect(bounds.width).toBeGreaterThan(100);
    expect(bounds.height).toBeGreaterThan(100);

    const pdfBytes = await exportCanvasToPdf(board);
    expect(pdfBytes.byteLength).toBeGreaterThan(500);
    const header = new TextDecoder().decode(pdfBytes.slice(0, 5));
    expect(header).toBe('%PDF-');
  });

  it('extracts structured semantic index text and lists canvas boards in workspaceStore', () => {
    const board = createBlankCanvas('Q4 Distributed Search Plan');
    const els: CanvasElement[] = [
      { id: 'f1', kind: 'frame', x: 0, y: 0, width: 400, height: 300, text: 'Embedding Pipeline' },
      { id: 'r1', kind: 'roundRect', x: 20, y: 40, width: 160, height: 60, text: 'Ollama qwen3-embedding' },
      { id: 's1', kind: 'sticky', x: 220, y: 40, width: 150, height: 120, text: 'Add SQLite vector cache' },
    ];
    board.elements = els;

    const indexText = extractCanvasIndexText(board);
    expect(indexText).toContain('# Q4 Distributed Search Plan');
    expect(indexText).toContain('## Frame: Embedding Pipeline');
    expect(indexText).toContain('Ollama qwen3-embedding');
    expect(indexText).toContain('Add SQLite vector cache');

    const summaries = listWorkspaceFiles([], [], [], [], [], [board]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].kind).toBe('canvas');
    expect(summaries[0].primaryFormat).toBe('.fcanvas / .excalidraw');
    expect(summaries[0].previewText).toContain('3 objects');
  });

  it('extracts multimodal visual payloads for EmbeddingGemma 2 across Canvas & Lab', () => {
    expect(isMultimodalEmbedModel('embeddinggemma-2:latest')).toBe(true);
    expect(isMultimodalEmbedModel('qwen3-embedding:0.6b')).toBe(false);

    const board = createBlankCanvas('Visual Board');
    board.elements = [
      {
        id: 'img_1',
        kind: 'image',
        x: 0,
        y: 0,
        width: 200,
        height: 150,
        src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      },
    ];
    const canvasImgs = extractCanvasIndexImages(board);
    expect(canvasImgs).toHaveLength(1);
    expect(canvasImgs[0].sectionLabel).toBe('Canvas Image 1');
    expect(canvasImgs[0].base64.startsWith('iVBORw0KGgo')).toBe(true);

    const nb = createBlankNotebook('Charts Notebook');
    nb.cells[0] = {
      id: 'c1',
      cell_type: 'code',
      source: 'plt.bar([1,2,3], [10,20,30])',
      execution_count: 1,
      outputs: [
        {
          output_type: 'display_data',
          data: { 'image/png': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
        },
      ],
    };
    const nbImgs = extractNotebookIndexImages(nb);
    expect(nbImgs).toHaveLength(1);
    expect(nbImgs[0].sectionLabel).toBe('Cell 1 Chart');
    expect(nbImgs[0].caption).toContain('plt.bar');
  });
});
