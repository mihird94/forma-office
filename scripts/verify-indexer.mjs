import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Document, Packer, Paragraph } from 'docx';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import PptxGenJS from 'pptxgenjs';

function png(linePlot) {
  const width = 512;
  const height = 352;
  const rows = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;

  function rectangle(x, y, w, h, color) {
    for (let j = y; j < y + h; j++) {
      for (let i = x; i < x + w; i++) {
        const p = j * (width * 3 + 1) + i * 3 + 1;
        for (let channel = 0; channel < 3; channel++) rows[p + channel] = color[channel];
      }
    }
  }

  function chunk(type, data) {
    const content = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    const header = Buffer.alloc(4);
    header.writeUInt32BE(data.length);
    const footer = Buffer.alloc(4);
    footer.writeUInt32BE((~crc) >>> 0);
    return Buffer.concat([header, content, footer]);
  }

  for (let y = 75; y < 310; y += 47) rectangle(52, y, 410, 1, [198, 205, 210]);
  rectangle(52, 37, 3, 270, [25, 29, 35]);
  rectangle(52, 305, 410, 3, [25, 29, 35]);
  if (linePlot) {
    for (let x = 67; x < 457; x++) {
      rectangle(x, Math.round(280 - (x - 67) * 0.49 + 28 * Math.sin(x / 24)), 2, 8, [8, 104, 227]);
    }
  } else {
    rectangle(82, 222, 78, 83, [231, 44, 51]);
    rectangle(204, 148, 78, 157, [250, 149, 26]);
    rectangle(326, 68, 78, 237, [38, 159, 68]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function writeOdf(root, name, mime, markup) {
  const zip = new JSZip();
  zip.file('mimetype', mime);
  zip.file('content.xml', '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"><office:body>' + markup + '</office:body></office:document-content>');
  await writeFile(join(root, name), await zip.generateAsync({ type: 'nodebuffer' }));
}

async function createFixtures(root) {
  const text = {
    docx: 'Tamarind alveolar continuity sensor',
    xlsx: 'Saffron osmium procurement ledger',
    pptx: 'Cobalt fenwick orbital roadmap',
  };
  const document = new Document({ sections: [{ children: [new Paragraph(text.docx)] }] });
  await writeFile(join(root, 'summary.docx'), await Packer.toBuffer(document));
  const book = new ExcelJS.Workbook();
  book.addWorksheet('Procurement').addRow([text.xlsx, 42]);
  await book.xlsx.writeFile(join(root, 'ledger.xlsx'));
  const slides = new PptxGenJS();
  const slide = slides.addSlide();
  slide.addText(text.pptx, { x: 1, y: 1, w: 7, h: 1 });
  slide.addNotes(['Hydraulic gantry speaker notes']);
  await slides.writeFile({ fileName: join(root, 'briefing.pptx') });
  const textPdf = await PDFDocument.create();
  textPdf.addPage().drawText('Mistletoe cadastral survey report', { x: 64, y: 656, size: 18 });
  await writeFile(join(root, 'reference.pdf'), await textPdf.save());
  const scannedPdf = await PDFDocument.create();
  const page = scannedPdf.addPage([512, 352]);
  const bars = await scannedPdf.embedPng(png(false));
  page.drawImage(bars, { x: 0, y: 0, width: 512, height: 352 });
  await writeFile(join(root, 'scan.pdf'), await scannedPdf.save());
  await writeFile(join(root, 'example.ipynb'), JSON.stringify({
    nbformat: 4, nbformat_minor: 5, metadata: {},
    cells: [{
      id: 'example', cell_type: 'code', source: ['result = 12'], metadata: {}, execution_count: 1,
      outputs: [{ output_type: 'display_data', data: { 'image/png': png(true).toString('base64') }, metadata: {} }],
    }],
  }));
  await writeFile(join(root, 'graph.fcanvas'), JSON.stringify({
    format: 'forma-canvas', version: 1, title: 'Workflow outline',
    elements: [{ kind: 'frame', text: 'Intake' }, { kind: 'sticky', text: 'Seafoam route guidance' }],
  }));
  await writeFile(join(root, 'diagram.excalidraw'), JSON.stringify({
    type: 'excalidraw', elements: [{ type: 'text', text: 'Excalidraw whiteboard canary' }], files: {},
  }));
  await writeFile(join(root, 'overview.md'), '# Markdown checklist\n\nCheck the saltmarsh zone.');
  await writeFile(join(root, 'memo.txt'), 'Plain text appendix');
  await writeFile(join(root, 'rows.csv'), 'Label,Value\nWind,5\n');
  await writeFile(join(root, 'rows.tsv'), 'Label\tValue\nRain\t8\n');
  await writeOdf(root, 'memo.odt', 'application/vnd.oasis.opendocument.text',
    '<office:text><text:p>OpenDocument text canary</text:p></office:text>');
  await writeOdf(root, 'data.ods', 'application/vnd.oasis.opendocument.spreadsheet',
    '<office:spreadsheet><table:table table:name="ODF sheet"><table:table-row><table:table-cell><text:p>ODS row canary</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet>');
  await writeOdf(root, 'deck.odp', 'application/vnd.oasis.opendocument.presentation',
    '<office:presentation><draw:page><text:p>ODP slide canary</text:p></draw:page></office:presentation>');
  await writeFile(join(root, 'standalone.png'), png(false));
  return text;
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function llamaProcessesOn(port) {
  let processes;
  try { processes = execFileSync('/usr/bin/pgrep', ['-x', 'llama-server'], { encoding: 'utf8' }).trim().split('\n'); }
  catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
  return processes.filter(pid => {
    try {
      const command = execFileSync('/bin/ps', ['-ww', '-p', pid, '-o', 'command='], { encoding: 'utf8' });
      const words = command.trim().split(/\s+/);
      const flag = words.indexOf('--host');
      return flag >= 0 && words[flag + 1] === `/private/tmp/forma-embed-${process.getuid()}/${port}.sock`;
    } catch (error) {
      if (error.status === 1) return false;
      throw error;
    }
  });
}

const execute = promisify(execFile);
const support = join(homedir(), 'Library', 'Application Support', 'FormaOffice');
const binary = process.env.FORMA_INDEXER_BIN || join(support, 'bin', 'forma-indexer');
const runtime = process.env.FORMA_INDEX_RUNTIME_DIR || support;
const scratch = await mkdtemp(join(tmpdir(), 'forma-indexer-check-'));
const root = join(scratch, 'Fixture Folder');
const state = join(scratch, 'state');
const port = await reservePort();
const env = {
  ...process.env, FORMA_INDEXER_BIN: binary, FORMA_INDEX_RUNTIME_DIR: runtime,
  FORMA_INDEX_SUPPORT_DIR: state, FORMA_INDEX_EMBED_PORT: String(port), OLLAMA_HOST: 'http://127.0.0.1:1',
};
let client;
const sql = statement => execFileSync('/usr/bin/sqlite3', [
  '-readonly', join(state, 'semantic_index.sqlite'), statement,
], { encoding: 'utf8' }).trim();

async function run(args, override = {}) {
  const start = performance.now();
  const { stdout } = await execute(binary, [...args, '--json'], { env: { ...env, ...override }, maxBuffer: 4 * 1024 * 1024 });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true, JSON.stringify(result));
  return { ...result, elapsedMs: Math.round(performance.now() - start) };
}

try {
  await mkdir(root);
  const canaries = await createFixtures(root);
  await writeFile(join(scratch, 'outside.md'), 'This path is outside the watched folder.');
  await symlink(join(scratch, 'outside.md'), join(root, 'outside-link.md'));
  const initial = await run(['folders', 'list']);
  for (const path of initial.watchedFolders) await run(['folders', 'remove', path]);
  await run(['folders', 'add', root]);
  assert.deepEqual(llamaProcessesOn(port), [], 'Embedding test port is already in use');
  const first = await run(['sync']);
  assert.equal(first.backend, 'forma-embedded');
  assert.equal(first.multimodal, true);
  assert.equal(first.indexedCount, 15, JSON.stringify(first));
  assert.equal(first.skippedCount, 0);
  assert.deepEqual(llamaProcessesOn(port), [], 'The CLI left an embedding server running');
  assert.equal(sql('SELECT count(*) FROM chunk_search;'), sql('SELECT count(*) FROM chunks;'));
  console.log(JSON.stringify({ check: 'embedded sync', ...first }));

  const idle = join(scratch, 'idle-runtime');
  await mkdir(join(idle, 'bin'), { recursive: true });
  await symlink(join(runtime, 'models'), join(idle, 'models'));
  const sentinel = join(idle, 'booted');
  const stub = join(idle, 'bin', 'llama-server');
  await writeFile(stub, '#!/bin/sh\ntouch "$(dirname "$0")/../booted"\nexit 1\n');
  await chmod(stub, 0o755);
  const second = await run(['sync'], { FORMA_INDEX_RUNTIME_DIR: idle });
  assert.equal(second.skippedCount, second.totalScanned);
  assert.ok(second.elapsedMs < 250, JSON.stringify(second));
  await assert.rejects(readFile(sentinel), { code: 'ENOENT' });
  console.log(JSON.stringify({ check: 'unchanged scan without model boot', ...second }));

  await rm(join(root, 'overview.md'));
  const pruned = await run(['sync']);
  assert.equal(pruned.prunedCount, 1);
  assert.equal((await run(['status'])).indexedDocs, 14);
  assert.equal(sql("SELECT count(*) FROM chunk_search WHERE chunk_search MATCH 'saltmarsh';"), '0');
  console.log(JSON.stringify({ check: 'deleted file pruned', ...pruned }));

  for (const [ext, title] of Object.entries({ docx: 'summary.docx', xlsx: 'ledger.xlsx', pptx: 'briefing.pptx' })) {
    const search = await run(['search', canaries[ext], '--limit', '1']);
    assert.equal(search.hits[0]?.title, title, JSON.stringify(search.hits));
    assert.equal(search.hits[0]?.matchType, 'hybrid');
    console.log(JSON.stringify({ check: ext + ' top-1', match: search.hits[0].title }));
  }
  const visualCases = [
    ['a bar graph with three red orange and green bars increasing in height', 'pdf', 'scan.pdf'],
    ['a rising blue wavy line plotted against a white grid', 'notebook', 'example.ipynb'],
  ];
  for (const [query, kind, filename] of visualCases) {
    const visual = await run(['search', query, '--kind', kind, '--limit', '1']);
    assert.equal(visual.hits[0]?.title, filename, JSON.stringify(visual.hits));
    assert.match(visual.hits[0]?.snippet ?? '', /Visual/);
    console.log(JSON.stringify({ check: kind + ' visual top-1', match: visual.hits[0].title }));
  }
  assert.deepEqual(llamaProcessesOn(port), [], 'A search left a child process running');

  const transport = new StdioClientTransport({
    command: process.execPath, args: ['mcp/forma-mcp/index.mjs'], env, stderr: 'pipe',
  });
  transport.stderr?.pipe(process.stderr);
  client = new Client({ name: 'forma-acceptance', version: '1.0.0' });
  await client.connect(transport);
  const listed = (await client.listTools()).tools;
  assert.deepEqual(listed.map(tool => tool.name).sort(), [
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
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.structuredContent?.ok, true, JSON.stringify(result));
    return result.structuredContent;
  };
  assert.equal((await call('forma_status', {})).indexedDocs, 14);
  assert.equal((await call('forma_search', { query: canaries.docx, limit: 1 })).hits[0].title, 'summary.docx');
  assert.ok((await call('forma_read', { target: join(root, 'summary.docx') })).text.includes(canaries.docx));
  const createdCanvas = await call('forma_create_canvas', {
    path: join(root, 'mcp-architecture.fcanvas'),
    title: 'MCP Acceptance Flow',
    mermaid: 'flowchart LR\n  A[Helios Gateway] --> B[Nebula Indexer]',
  });
  assert.equal(createdCanvas.indexed, true);
  assert.equal((await call('forma_search', { query: 'Helios Gateway', kind: 'canvas', limit: 1 })).hits[0].title, 'MCP Acceptance Flow');
  assert.deepEqual(llamaProcessesOn(port), [], 'An MCP search left a child process running');
  console.log(JSON.stringify({ check: 'MCP initialize, list, status, search, read, create', toolCount: listed.length }));

  const revised = join(root, 'memo.txt');
  assert.equal(sql("SELECT count(*) FROM chunk_search WHERE chunk_search MATCH 'appendix';"), '1');
  await writeFile(revised, 'Replacement synapse tracking memorandum.');
  await run(['index', revised]);
  assert.equal(sql("SELECT count(*) FROM chunk_search WHERE chunk_search MATCH 'appendix';"), '0');
  assert.equal(sql("SELECT count(*) FROM chunk_search WHERE chunk_search MATCH 'synapse';"), '1');
  assert.equal(sql('SELECT count(*) FROM chunk_search;'), sql('SELECT count(*) FROM chunks;'));
  console.log(JSON.stringify({ check: 'full-text search index follows edits and deletions' }));
} finally {
  await client?.close();
  if (process.env.FORMA_KEEP_INDEXER_FIXTURES) console.log('Fixture workspace: ' + scratch);
  else await rm(scratch, { recursive: true, force: true });
}
