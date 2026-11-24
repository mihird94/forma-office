/** @vitest-environment node */
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('Forma MCP tool schemas and CLI dispatch', () => {
  let scratch = '';
  let watched = '';
  let outside = '';
  let client: Client;
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'forma-mcp-test-'));
    const watchPath = join(scratch, 'Watched folder');
    await mkdir(watchPath);
    watched = await realpath(watchPath);
    outside = join(scratch, 'outside.md');
    await writeFile(outside, 'A regular test document in a different folder.');
    const binary = join(scratch, 'forma-indexer');
    await writeFile(binary, '#!/usr/bin/env node\nconst args=process.argv.slice(2);const config=args[0]==="folders"&&args[1]==="list"?{watchedFolders:[process.env.TEST_WATCHED_FOLDER]}:{};\nconsole.log(JSON.stringify({ok:true,args,...config}));\n');
    await chmod(binary, 0o755);
    client = new Client({ name: 'forma-mcp-tests', version: '1.0.0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: ['mcp/forma-mcp/index.mjs'],
      env: { FORMA_INDEXER_BIN: binary, TEST_WATCHED_FOLDER: watched, FORMA_MCP_ALLOW_FOLDER_CHANGES: '0' },
    }));
  });

  afterAll(async () => {
    await client?.close();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it('registers all ten tools and sends structured CLI arguments', async () => {
    const { tools } = await client.listTools();
    expect(tools.map(({ name }) => name).sort()).toEqual([
      'forma_create_canvas',
      'forma_create_doc',
      'forma_create_sheet',
      'forma_create_slides',
      'forma_folders',
      'forma_index',
      'forma_open',
      'forma_read',
      'forma_search',
      'forma_status',
    ]);
    const cases = [
      ['forma_search', { query: 'two words; one argument', kind: 'pdf', limit: 5 },
        ['search', '--', 'two words; one argument', '--kind', 'pdf', '--limit', '5', '--json']],
      ['forma_search', { query: 'chart screenshot', kind: 'image', limit: 3 },
        ['search', '--', 'chart screenshot', '--kind', 'image', '--limit', '3', '--json']],
      ['forma_read', { target: 'file:/test folder/file.pdf', maxChars: 100, ocr: true },
        ['read', '--', 'file:/test folder/file.pdf', '--max-chars', '100', '--ocr', '--json']],
      ['forma_index', { force: true }, ['sync', '--force', '--json']],
      ['forma_index', { path: watched }, ['index', watched, '--json']],
      ['forma_folders', { action: 'list' }, ['folders', 'list', '--json']],
      ['forma_status', {}, ['status', '--json']],
    ] as const;
    for (const [name, args, argv] of cases) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.structuredContent).toMatchObject({ ok: true, args: argv });
    }
  });

  it('rejects invalid values and missing folder arguments', async () => {
    const invalid = [
      ['forma_search', { query: '', kind: 'unsupported', limit: 51 }],
      ['forma_read', { target: 'id', maxChars: 0 }],
      ['forma_folders', { action: 'remove' }],
      ['forma_index', { path: 'relative/path' }],
      ['forma_open', { path: '/test/unknown.zip' }],
      ['forma_create_sheet', { path: join(watched, 'bad.xlsx'), sheets: [] }],
      ['forma_create_slides', { path: join(watched, 'bad.pptx'), slides: [] }],
      ['forma_create_slides', { path: join(watched, 'wrong.txt'), slides: [{ title: 'Hi' }] }],
    ] as const;
    for (const [name, args] of invalid) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
    }
  });

  it('limits direct paths to watched folders and protects folder settings by default', async () => {
    for (const name of ['forma_read', 'forma_index', 'forma_open']) {
      const arguments_ = name === 'forma_read' ? { target: outside } : { path: outside };
      const result = await client.callTool({ name, arguments: arguments_ });
      expect(result.structuredContent).toMatchObject({ ok: false, error: expect.stringContaining('watched') });
    }
    const add = await client.callTool({ name: 'forma_folders', arguments: { action: 'add', path: scratch } });
    expect(add.structuredContent).toMatchObject({ ok: false, error: expect.stringContaining('Manage watched folders') });
  });

  it('creates valid canvas, sheet, slides, and doc files inside watched folders', async () => {
    // 1. Canvas (.fcanvas with Mermaid + .excalidraw with template)
    const fcanvasPath = join(watched, 'architecture.fcanvas');
    const canvasRes = await client.callTool({
      name: 'forma_create_canvas',
      arguments: {
        path: fcanvasPath,
        title: 'API Flow',
        mermaid: [
          'flowchart LR',
          '  subgraph Edge',
          '    A[Client] -->|HTTPS| B(API Gateway)',
          '  end',
          '  B --> C{Auth OK?}',
          '  C -->|Yes| D((Database))',
        ].join('\n'),
      },
    });
    expect(canvasRes.isError).toBeFalsy();
    expect(canvasRes.structuredContent).toMatchObject({ ok: true, format: 'fcanvas', indexed: true });
    const fcanvasJson = JSON.parse(await readFile(fcanvasPath, 'utf8'));
    expect(fcanvasJson.format).toBe('forma-canvas');
    expect(fcanvasJson.version).toBe(1);
    expect(fcanvasJson.title).toBe('API Flow');
    expect(fcanvasJson.elements.some((el: { kind: string }) => el.kind === 'frame')).toBe(true);
    expect(fcanvasJson.elements.some((el: { kind: string }) => el.kind === 'diamond')).toBe(true);
    expect(fcanvasJson.elements.some((el: { kind: string }) => el.kind === 'ellipse')).toBe(true);
    const arrows = fcanvasJson.elements.filter((el: { kind: string }) => el.kind === 'arrow');
    expect(arrows.length).toBe(3);
    expect(arrows[0].startBinding?.elementId).toBeTruthy();
    expect(arrows[0].endBinding?.elementId).toBeTruthy();

    const excalPath = join(watched, 'board.excalidraw');
    const excalRes = await client.callTool({
      name: 'forma_create_canvas',
      arguments: { path: excalPath, template: 'kanban' },
    });
    expect(excalRes.isError).toBeFalsy();
    const excalJson = JSON.parse(await readFile(excalPath, 'utf8'));
    expect(excalJson.type).toBe('excalidraw');
    expect(excalJson.version).toBe(2);
    expect(excalJson.elements.length).toBeGreaterThan(0);

    // 2. Sheet (.xlsx with formula)
    const xlsxPath = join(watched, 'budget.xlsx');
    const sheetRes = await client.callTool({
      name: 'forma_create_sheet',
      arguments: {
        path: xlsxPath,
        title: 'Q4 Budget',
        sheets: [
          {
            name: 'Summary',
            rows: [
              ['Item', 'Amount'],
              ['Hosting', 1200],
              ['Storage', 350],
              ['Total', '=SUM(B2:B3)'],
            ],
          },
        ],
      },
    });
    expect(sheetRes.isError).toBeFalsy();
    expect(sheetRes.structuredContent).toMatchObject({ ok: true, format: 'xlsx', sheetCount: 1, indexed: true });
    const xlsxBuf = await readFile(xlsxPath);
    expect(xlsxBuf[0]).toBe(0x50); // 'P'
    expect(xlsxBuf[1]).toBe(0x4b); // 'K'
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(xlsxPath);
    const ws = wb.getWorksheet('Summary');
    expect(ws).toBeDefined();
    expect(ws?.getRow(1).font?.bold).toBe(true);
    expect(ws?.getCell('B4').value).toMatchObject({ formula: 'SUM(B2:B3)' });

    // 3. Slides (.pptx)
    const pptxPath = join(watched, 'roadmap.pptx');
    const slidesRes = await client.callTool({
      name: 'forma_create_slides',
      arguments: {
        path: pptxPath,
        title: 'Product Roadmap',
        theme: 'ocean',
        slides: [
          { title: 'Product Roadmap', subtitle: 'H2 Strategy & Milestones', notes: 'Welcome everyone.' },
          { title: 'Key Deliverables', bullets: ['Forma MCP Creators', 'Local-first indexing', 'Mermaid diagrams'] },
        ],
      },
    });
    expect(slidesRes.isError).toBeFalsy();
    expect(slidesRes.structuredContent).toMatchObject({ ok: true, format: 'pptx', theme: 'ocean', slideCount: 2, indexed: true });
    const pptxBuf = await readFile(pptxPath);
    expect(pptxBuf[0]).toBe(0x50);
    expect(pptxBuf[1]).toBe(0x4b);
    const pptxZip = await JSZip.loadAsync(pptxBuf);
    expect(pptxZip.file('ppt/slides/slide1.xml')).toBeTruthy();
    expect(pptxZip.file('ppt/slides/slide2.xml')).toBeTruthy();

    // 4. Doc (.docx with headings, lists, code block, and table)
    const docxPath = join(watched, 'spec.docx');
    const docRes = await client.callTool({
      name: 'forma_create_doc',
      arguments: {
        path: docxPath,
        title: 'Design Spec',
        markdown: [
          '# Design Spec',
          '',
          '## Goals',
          '- Fast **local** creation',
          '- Safe watched-folder boundaries',
          '',
          '### Steps',
          '1. Validate path',
          '2. Generate file',
          '',
          '```ts',
          'const ok = true;',
          '```',
          '',
          '| Tool | Format |',
          '| --- | --- |',
          '| Canvas | .fcanvas |',
          '| Sheet | .xlsx |',
        ].join('\n'),
      },
    });
    expect(docRes.isError).toBeFalsy();
    expect(docRes.structuredContent).toMatchObject({ ok: true, format: 'docx', indexed: true });
    const docxBuf = await readFile(docxPath);
    expect(docxBuf[0]).toBe(0x50);
    expect(docxBuf[1]).toBe(0x4b);
    const docxZip = await JSZip.loadAsync(docxBuf);
    const docXml = await docxZip.file('word/document.xml')?.async('string');
    expect(docXml).toContain('Design Spec');
    expect(docXml).toContain('const ok = true;');
    expect(docXml).toContain('<w:tbl>');
  });

  it('rejects file creation outside watched folders, hidden files, and symlink targets', async () => {
    const outsideCases = [
      ['forma_create_canvas', { path: join(scratch, 'evil.fcanvas'), template: 'blank' }],
      ['forma_create_sheet', { path: join(scratch, 'evil.xlsx'), sheets: [{ name: 'S1', rows: [['A']] }] }],
      ['forma_create_slides', { path: join(scratch, 'evil.pptx'), slides: [{ title: 'T' }] }],
      ['forma_create_doc', { path: join(scratch, 'evil.docx'), markdown: '# Nope' }],
    ] as const;
    for (const [name, args] of outsideCases) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: false, error: expect.stringContaining('watched') });
    }

    // Hidden filename inside watched folder must be rejected
    const hiddenRes = await client.callTool({
      name: 'forma_create_doc',
      arguments: { path: join(watched, '.hidden.docx'), markdown: '# Hidden' },
    });
    expect(hiddenRes.isError).toBe(true);

    // Symlink inside watched folder pointing outside must be rejected
    const symlinkTarget = join(watched, 'linked.md');
    await symlink(outside, symlinkTarget);
    const symlinkRes = await client.callTool({
      name: 'forma_create_doc',
      arguments: { path: symlinkTarget, markdown: '# Overwrite attempt' },
    });
    expect(symlinkRes.isError).toBe(true);
    expect(symlinkRes.structuredContent).toMatchObject({ ok: false, error: expect.stringContaining('symbolic link') });
  });
});
