import { writeFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';

// ============================================================================
// Shared Helpers
// ============================================================================

let idCounter = 0;
function uid(prefix = 'el') {
  idCounter += 1;
  return `${prefix}_${idCounter.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function defaultTitle(filePath, fallback) {
  const base = basename(filePath, extname(filePath)).trim();
  return base || fallback;
}

// ============================================================================
// 1. Canvas (.fcanvas / .excalidraw) Creator + Mermaid Parser + Templates
// ============================================================================

function getAnchorPoint(el, side) {
  const x = el.width >= 0 ? el.x : el.x + el.width;
  const y = el.height >= 0 ? el.y : el.y + el.height;
  const w = Math.abs(el.width);
  const h = Math.abs(el.height);
  switch (side) {
    case 'top':
      return { x: x + w / 2, y };
    case 'right':
      return { x: x + w, y: y + h / 2 };
    case 'bottom':
      return { x: x + w / 2, y: y + h };
    case 'left':
      return { x, y: y + h / 2 };
    case 'center':
    default:
      return { x: x + w / 2, y: y + h / 2 };
  }
}

function resolveBoundEndpoints(el, all) {
  let start;
  let end;
  if (el.points && el.points.length >= 2) {
    const first = el.points[0];
    const last = el.points[el.points.length - 1];
    start = { x: el.x + first.x, y: el.y + first.y };
    end = { x: el.x + last.x, y: el.y + last.y };
  } else {
    start = { x: el.x, y: el.y };
    end = { x: el.x + el.width, y: el.y + el.height };
  }
  if (el.startBinding) {
    const target = all.find((item) => item.id === el.startBinding.elementId);
    if (target) start = getAnchorPoint(target, el.startBinding.anchor);
  }
  if (el.endBinding) {
    const target = all.find((item) => item.id === el.endBinding.elementId);
    if (target) end = getAnchorPoint(target, el.endBinding.anchor);
  }
  return { start, end };
}

function computeElementBounds(elements) {
  if (!elements.length) {
    return { minX: 0, minY: 0, maxX: 800, maxY: 600, width: 800, height: 600 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (x, y) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const el of elements) {
    if (el.kind === 'arrow' || el.kind === 'line') {
      const { start, end } = resolveBoundEndpoints(el, elements);
      include(start.x, start.y);
      include(end.x, end.y);
    } else {
      include(Math.min(el.x, el.x + el.width), Math.min(el.y, el.y + el.height));
      include(Math.max(el.x, el.x + el.width), Math.max(el.y, el.y + el.height));
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { minX: 0, minY: 0, maxX: 800, maxY: 600, width: 800, height: 600 };
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function isDarkHex(hex) {
  if (!hex || hex === 'transparent' || hex === 'none') return false;
  const raw = hex.replace('#', '').trim();
  if (raw.length !== 6) return false;
  const r = parseInt(raw.slice(0, 2), 16) / 255;
  const g = parseInt(raw.slice(2, 4), 16) / 255;
  const b = parseInt(raw.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.38;
}

function makeBoundArrow(from, fromAnchor, to, toAnchor, options = {}) {
  const start = getAnchorPoint(from, fromAnchor);
  const end = getAnchorPoint(to, toAnchor);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  return {
    id: uid('arr'),
    kind: options.isLine ? 'line' : 'arrow',
    x: start.x,
    y: start.y,
    width: Math.abs(dx),
    height: Math.abs(dy),
    points: [
      { x: 0, y: 0 },
      { x: dx, y: dy },
    ],
    startBinding: { elementId: from.id, anchor: fromAnchor },
    endBinding: { elementId: to.id, anchor: toAnchor },
    ...(options.text ? { text: options.text } : {}),
    fontSize: 12,
    fontFamily: 'sans',
    textAlign: 'center',
    stroke: options.stroke ?? '#475569',
    strokeWidth: 2,
    strokeStyle: options.strokeStyle ?? 'solid',
    roughness: 0,
    opacity: 1,
  };
}

function parseMermaidNodeToken(rawToken) {
  const token = rawToken.trim();
  if (!token) return null;

  const patterns = [
    { re: /^([A-Za-z0-9_-]+)\s*\(\(([\s\S]+?)\)\)$/, kind: 'ellipse', fill: '#fefce8', stroke: '#ca8a04' },
    { re: /^([A-Za-z0-9_-]+)\s*\(\[([\s\S]+?)\]\)$/, kind: 'roundRect', fill: '#eff6ff', stroke: '#2563eb' },
    { re: /^([A-Za-z0-9_-]+)\s*\[\(([\s\S]+?)\)\]$/, kind: 'ellipse', fill: '#f5f3ff', stroke: '#7c3aed' },
    { re: /^([A-Za-z0-9_-]+)\s*\{\{([\s\S]+?)\}\}$/, kind: 'diamond', fill: '#f0fdfa', stroke: '#0d9488' },
    { re: /^([A-Za-z0-9_-]+)\s*\{([\s\S]+?)\}$/, kind: 'diamond', fill: '#f0fdfa', stroke: '#0d9488' },
    { re: /^([A-Za-z0-9_-]+)\s*\(([\s\S]+?)\)$/, kind: 'roundRect', fill: '#ecfdf5', stroke: '#059669' },
    { re: /^([A-Za-z0-9_-]+)\s*\[([\s\S]+?)\]$/, kind: 'rect', fill: '#f8fafc', stroke: '#334155' },
  ];

  for (const p of patterns) {
    const m = p.re.exec(token);
    if (m) {
      const label = m[2].replace(/^["']|["']$/g, '').replace(/<br\s*\/?>/gi, '\n').trim();
      return { key: m[1], label: label || m[1], kind: p.kind, fill: p.fill, stroke: p.stroke };
    }
  }

  const bare = /^([A-Za-z0-9_-]+)$/.exec(token);
  if (bare) {
    return { key: bare[1], label: bare[1], kind: 'roundRect', fill: '#f8fafc', stroke: '#334155' };
  }
  return null;
}

export function parseMermaidToCanvasElements(mermaidCode) {
  const rawLines = String(mermaidCode)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/%%.*$/, '').trim())
    .filter((line) => line.length > 0);

  let direction = 'TD';
  const nodes = new Map();
  const nodeOrder = [];
  const edges = [];
  const subgraphStack = [];

  const registerNode = (parsed, explicitShape = false) => {
    if (!parsed) return null;
    const existing = nodes.get(parsed.key);
    if (!existing) {
      if (subgraphStack.length > 0) {
        parsed.subgraph = subgraphStack[subgraphStack.length - 1];
      }
      nodes.set(parsed.key, parsed);
      nodeOrder.push(parsed.key);
    } else {
      if (explicitShape || (existing.label === existing.key && parsed.label !== parsed.key)) {
        existing.label = parsed.label;
        existing.kind = parsed.kind;
        existing.fill = parsed.fill;
        existing.stroke = parsed.stroke;
      }
      if (!existing.subgraph && subgraphStack.length > 0) {
        existing.subgraph = subgraphStack[subgraphStack.length - 1];
      }
    }
    return parsed.key;
  };

  const edgeSplitRegex =
    /\s*(-->\s*\|([^|]+)\||-\.->\s*\|([^|]+)\||==>\s*\|([^|]+)\||--\s+([^->\n]+?)\s+-->|-\.\s+([^.\n]+?)\s+\.->|-.->|==>|-->|---)\s*/;

  for (const rawLine of rawLines) {
    const headerMatch = /^(?:flowchart|graph)\s+(TD|TB|LR|RL|BT)\b/i.exec(rawLine);
    if (headerMatch) {
      direction = headerMatch[1].toUpperCase();
      continue;
    }

    const subMatch = /^subgraph\s+(.+)$/i.exec(rawLine);
    if (subMatch) {
      const title = subMatch[1]
        .replace(/^["']|["']$/g, '')
        .replace(/^[A-Za-z0-9_-]+\s*\[(.+)\]$/, '$1')
        .trim();
      subgraphStack.push(title || 'Group');
      continue;
    }
    if (/^end$/i.test(rawLine)) {
      subgraphStack.pop();
      continue;
    }

    if (/^(?:style|classDef|class|click|linkStyle)\b/i.test(rawLine)) {
      continue;
    }

    const statements = rawLine
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const stmt of statements) {
      if (edgeSplitRegex.test(stmt)) {
        let remaining = stmt;
        let prevKey = null;

        while (remaining.length > 0) {
          const match = edgeSplitRegex.exec(remaining);
          if (!match) {
            const tailNode = parseMermaidNodeToken(remaining);
            registerNode(tailNode, /[[\({]/.test(remaining));
            break;
          }

          const leftPart = remaining.slice(0, match.index).trim();
          const connector = match[1].trim();
          const label = (match[2] || match[3] || match[4] || match[5] || match[6] || '').trim() || undefined;
          const dashed = connector.includes('-.');
          const isLine = connector === '---';

          if (leftPart) {
            const leftNode = parseMermaidNodeToken(leftPart);
            const leftKey = registerNode(leftNode, /[[\({]/.test(leftPart));
            if (leftKey) prevKey = leftKey;
          }

          remaining = remaining.slice(match.index + match[0].length).trim();

          const nextMatch = edgeSplitRegex.exec(remaining);
          const rightPart = nextMatch ? remaining.slice(0, nextMatch.index).trim() : remaining;
          const rightNode = parseMermaidNodeToken(rightPart);
          const rightKey = registerNode(rightNode, /[[\({]/.test(rightPart));

          if (prevKey && rightKey) {
            edges.push({ from: prevKey, to: rightKey, label, dashed, isLine });
            prevKey = rightKey;
          }

          if (nextMatch) {
            remaining = remaining.slice(nextMatch.index).trim();
          } else {
            break;
          }
        }
      } else {
        const node = parseMermaidNodeToken(stmt);
        registerNode(node, /[[\({]/.test(stmt));
      }
    }
  }

  if (nodeOrder.length === 0) return [];

  const inDegree = new Map();
  const outgoing = new Map();
  for (const key of nodeOrder) {
    inDegree.set(key, 0);
    outgoing.set(key, []);
  }
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    outgoing.get(edge.from)?.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const layerOf = new Map();
  const queue = [];
  for (const key of nodeOrder) {
    if ((inDegree.get(key) ?? 0) === 0) {
      queue.push(key);
      layerOf.set(key, 0);
    }
  }
  if (queue.length === 0) {
    queue.push(nodeOrder[0]);
    layerOf.set(nodeOrder[0], 0);
  }

  let safety = 0;
  const maxSteps = nodeOrder.length * nodeOrder.length + 32;
  while (queue.length > 0 && safety < maxSteps) {
    safety += 1;
    const curr = queue.shift();
    const currLayer = layerOf.get(curr) ?? 0;
    for (const next of outgoing.get(curr) ?? []) {
      const existing = layerOf.get(next);
      if (existing === undefined || (existing < currLayer + 1 && currLayer + 1 < nodeOrder.length)) {
        layerOf.set(next, currLayer + 1);
        queue.push(next);
      }
    }
  }

  for (const key of nodeOrder) {
    if (!layerOf.has(key)) layerOf.set(key, 0);
  }

  const layers = new Map();
  let maxLayer = 0;
  for (const key of nodeOrder) {
    const l = layerOf.get(key) ?? 0;
    if (l > maxLayer) maxLayer = l;
    const bucket = layers.get(l) ?? [];
    bucket.push(key);
    layers.set(l, bucket);
  }

  const isHorizontal = direction === 'LR' || direction === 'RL';
  const isReversed = direction === 'RL' || direction === 'BT';
  const nodeW = 176;
  const nodeH = 74;
  const gapX = isHorizontal ? 255 : 220;
  const gapY = isHorizontal ? 128 : 138;

  const elementByKey = new Map();
  const createdNodes = [];

  let maxPerLayer = 1;
  for (const bucket of layers.values()) {
    if (bucket.length > maxPerLayer) maxPerLayer = bucket.length;
  }

  for (let l = 0; l <= maxLayer; l++) {
    const bucket = layers.get(l) ?? [];
    const effectiveLayer = isReversed ? maxLayer - l : l;
    const breadthOffset = ((maxPerLayer - bucket.length) * (isHorizontal ? gapY : gapX)) / 2;

    bucket.forEach((key, idx) => {
      const info = nodes.get(key);
      const w = info.kind === 'diamond' ? 164 : Math.max(nodeW, Math.min(240, info.label.length * 8 + 44));
      const h = info.kind === 'diamond' ? 96 : Math.max(nodeH, info.label.split('\n').length * 22 + 34);
      const x = isHorizontal
        ? 80 + effectiveLayer * gapX
        : 80 + breadthOffset + idx * gapX + (nodeW - w) / 2;
      const y = isHorizontal
        ? 80 + breadthOffset + idx * gapY + (nodeH - h) / 2
        : 80 + effectiveLayer * gapY;

      const el = {
        id: uid('mnode'),
        kind: info.kind,
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(w),
        height: Math.round(h),
        text: info.label,
        fontSize: 14,
        fontFamily: 'sans',
        textAlign: 'center',
        fill: info.fill,
        stroke: info.stroke,
        strokeWidth: 2,
        strokeStyle: 'solid',
        roughness: 0,
        opacity: 1,
      };
      elementByKey.set(key, el);
      createdNodes.push(el);
    });
  }

  const subgraphFrames = [];
  const subgraphMembers = new Map();
  for (const key of nodeOrder) {
    const info = nodes.get(key);
    if (info.subgraph) {
      const el = elementByKey.get(key);
      if (el) {
        const list = subgraphMembers.get(info.subgraph) ?? [];
        list.push(el);
        subgraphMembers.set(info.subgraph, list);
      }
    }
  }
  for (const [subTitle, members] of subgraphMembers.entries()) {
    const b = computeElementBounds(members);
    subgraphFrames.push({
      id: uid('mframe'),
      kind: 'frame',
      x: b.minX - 28,
      y: b.minY - 40,
      width: b.width + 56,
      height: b.height + 68,
      text: subTitle,
      fontSize: 13,
      fontFamily: 'sans',
      textAlign: 'left',
      fill: '#f8fafc',
      stroke: '#cbd5e1',
      strokeWidth: 1.5,
      strokeStyle: 'dashed',
      opacity: 1,
    });
  }

  const createdEdges = [];
  for (const edge of edges) {
    const fromEl = elementByKey.get(edge.from);
    const toEl = elementByKey.get(edge.to);
    if (!fromEl || !toEl) continue;

    const fromLayer = layerOf.get(edge.from) ?? 0;
    const toLayer = layerOf.get(edge.to) ?? 0;
    const isForward = isReversed ? fromLayer > toLayer : fromLayer < toLayer;

    let startAnchor;
    let endAnchor;
    if (isHorizontal) {
      startAnchor = isForward ? 'right' : 'bottom';
      endAnchor = isForward ? 'left' : 'bottom';
    } else {
      startAnchor = isForward ? 'bottom' : 'right';
      endAnchor = isForward ? 'top' : 'right';
    }

    createdEdges.push(
      makeBoundArrow(fromEl, startAnchor, toEl, endAnchor, {
        text: edge.label,
        stroke: '#475569',
        strokeStyle: edge.dashed ? 'dashed' : 'solid',
        isLine: edge.isLine,
      })
    );
  }

  return [...subgraphFrames, ...createdNodes, ...createdEdges];
}

function buildTemplateElements(template) {
  if (template === 'architecture') {
    const frame = {
      id: uid('frm'),
      kind: 'frame',
      x: 310,
      y: 120,
      width: 780,
      height: 440,
      text: 'Core Platform VPC',
      fontSize: 13,
      fontFamily: 'sans',
      textAlign: 'left',
      fill: '#f8fafc',
      stroke: '#cbd5e1',
      strokeWidth: 1.5,
      strokeStyle: 'dashed',
      opacity: 1,
    };
    const client = {
      id: uid('node'),
      kind: 'roundRect',
      x: 60,
      y: 270,
      width: 180,
      height: 88,
      text: 'Client Apps\nWeb • macOS • iOS',
      fontSize: 14,
      fontFamily: 'sans',
      textAlign: 'center',
      fill: '#eff6ff',
      stroke: '#2563eb',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 0,
      opacity: 1,
    };
    const gateway = {
      id: uid('node'),
      kind: 'diamond',
      x: 350,
      y: 260,
      width: 170,
      height: 108,
      text: 'API Gateway\nTLS • Rate Limit',
      fontSize: 13,
      fontFamily: 'sans',
      textAlign: 'center',
      fill: '#f0fdfa',
      stroke: '#0d9488',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 0,
      opacity: 1,
    };
    const api = {
      id: uid('node'),
      kind: 'roundRect',
      x: 600,
      y: 270,
      width: 180,
      height: 88,
      text: 'Core API\nREST & GraphQL',
      fontSize: 14,
      fontFamily: 'sans',
      textAlign: 'center',
      fill: '#ecfdf5',
      stroke: '#059669',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 0,
      opacity: 1,
    };
    const db = {
      id: uid('node'),
      kind: 'ellipse',
      x: 865,
      y: 175,
      width: 180,
      height: 88,
      text: 'Postgres DB\nPrimary + Replica',
      fontSize: 14,
      fontFamily: 'sans',
      textAlign: 'center',
      fill: '#fefce8',
      stroke: '#ca8a04',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 0,
      opacity: 1,
    };
    const cache = {
      id: uid('node'),
      kind: 'roundRect',
      x: 865,
      y: 355,
      width: 180,
      height: 84,
      text: 'Redis Cache\nHot Keys & Sessions',
      fontSize: 14,
      fontFamily: 'sans',
      textAlign: 'center',
      fill: '#fff1f2',
      stroke: '#e11d48',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 0,
      opacity: 1,
    };
    return [
      frame,
      client,
      gateway,
      api,
      db,
      cache,
      makeBoundArrow(client, 'right', gateway, 'left', { text: 'HTTPS', stroke: '#2563eb' }),
      makeBoundArrow(gateway, 'right', api, 'left', { text: 'Route', stroke: '#0d9488' }),
      makeBoundArrow(api, 'top', db, 'left', { text: 'SQL', stroke: '#ca8a04' }),
      makeBoundArrow(api, 'bottom', cache, 'left', { text: 'Cache', stroke: '#e11d48' }),
    ];
  }

  if (template === 'mindmap') {
    const center = {
      id: uid('node'),
      kind: 'roundRect',
      x: 450,
      y: 260,
      width: 210,
      height: 96,
      text: 'Central Topic',
      fontSize: 18,
      fontFamily: 'sans',
      textAlign: 'center',
      fill: '#0f172a',
      stroke: '#0d9488',
      strokeWidth: 2.5,
      strokeStyle: 'solid',
      roughness: 0,
      opacity: 1,
    };
    const branches = [
      { x: 160, y: 120, text: 'Goals & Vision', fill: '#dbeafe', stroke: '#2563eb', from: 'left', to: 'right' },
      { x: 760, y: 120, text: 'Key Initiatives', fill: '#ccfbf1', stroke: '#0d9488', from: 'right', to: 'left' },
      { x: 160, y: 420, text: 'Risks & Open Qs', fill: '#ede9fe', stroke: '#7c3aed', from: 'left', to: 'right' },
      { x: 760, y: 420, text: 'Milestones', fill: '#ffe4e6', stroke: '#e11d48', from: 'right', to: 'left' },
    ];
    const nodes = [center];
    const arrows = [];
    for (const b of branches) {
      const node = {
        id: uid('br'),
        kind: 'roundRect',
        x: b.x,
        y: b.y,
        width: 180,
        height: 68,
        text: b.text,
        fontSize: 15,
        fontFamily: 'sans',
        textAlign: 'center',
        fill: b.fill,
        stroke: b.stroke,
        strokeWidth: 2,
        strokeStyle: 'solid',
        roughness: 0,
        opacity: 1,
      };
      nodes.push(node);
      arrows.push(makeBoundArrow(center, b.from, node, b.to, { stroke: b.stroke }));
    }
    return [...nodes, ...arrows];
  }

  if (template === 'kanban') {
    const cols = [
      { x: 60, text: 'Backlog', fill: '#f8fafc', stroke: '#cbd5e1', note: 'Capture ideas\nand prioritize' },
      { x: 396, text: 'In Progress', fill: '#f0fdfa', stroke: '#99f6e4', note: 'Active work\nin current sprint' },
      { x: 732, text: 'Done', fill: '#f0fdf4', stroke: '#bbf7d0', note: 'Verified and\nshipped items' },
    ];
    const elements = [];
    for (const c of cols) {
      elements.push({
        id: uid('frm'),
        kind: 'frame',
        x: c.x,
        y: 80,
        width: 300,
        height: 460,
        text: c.text,
        fontSize: 15,
        fontFamily: 'sans',
        textAlign: 'left',
        fill: c.fill,
        stroke: c.stroke,
        strokeWidth: 1.5,
        strokeStyle: 'solid',
        opacity: 1,
      });
      elements.push({
        id: uid('st'),
        kind: 'sticky',
        x: c.x + 24,
        y: 124,
        width: 252,
        height: 120,
        text: c.note,
        fontSize: 14,
        fontFamily: 'hand',
        textAlign: 'left',
        fill: '#fef08a',
        stroke: '#eab308',
        strokeWidth: 1.5,
        opacity: 1,
      });
    }
    return elements;
  }

  return [];
}

function toExcalidrawPayload(elements, background = 'dots') {
  const now = Date.now();
  const out = [];

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (el.kind === 'image') continue;

    const base = {
      id: el.id,
      type: 'rectangle',
      x: el.x,
      y: el.y,
      width: Math.abs(el.width),
      height: Math.abs(el.height),
      angle: 0,
      strokeColor: el.stroke || '#0f172a',
      backgroundColor: el.fill && el.fill !== 'none' ? el.fill : 'transparent',
      fillStyle: 'solid',
      strokeWidth: el.strokeWidth ?? 2,
      strokeStyle: el.strokeStyle ?? 'solid',
      roughness: el.roughness === 1 ? 1 : 0,
      opacity: Math.round((el.opacity ?? 1) * 100),
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 1000 + i * 37,
      version: 1,
      versionNonce: 2000 + i * 19,
      isDeleted: false,
      boundElements: null,
      updated: now,
      link: null,
      locked: Boolean(el.locked),
    };

    if (el.kind === 'rect') {
      base.type = 'rectangle';
    } else if (el.kind === 'roundRect' || el.kind === 'sticky') {
      base.type = 'rectangle';
      base.roundness = { type: 3 };
    } else if (el.kind === 'diamond') {
      base.type = 'diamond';
    } else if (el.kind === 'ellipse') {
      base.type = 'ellipse';
    } else if (el.kind === 'frame') {
      base.type = 'frame';
      base.name = el.text ?? 'Frame';
    } else if (el.kind === 'text') {
      base.type = 'text';
      base.text = el.text ?? '';
      base.originalText = el.text ?? '';
      base.fontSize = el.fontSize ?? 18;
      base.fontFamily = el.fontFamily === 'hand' ? 1 : el.fontFamily === 'mono' ? 3 : 2;
      base.textAlign = el.textAlign ?? 'left';
      base.verticalAlign = 'top';
      base.containerId = null;
    } else if (el.kind === 'arrow' || el.kind === 'line') {
      const { start, end } = resolveBoundEndpoints(el, elements);
      base.type = el.kind;
      base.x = start.x;
      base.y = start.y;
      base.width = Math.abs(end.x - start.x);
      base.height = Math.abs(end.y - start.y);
      base.points = [
        [0, 0],
        [end.x - start.x, end.y - start.y],
      ];
      base.startBinding = el.startBinding ? { elementId: el.startBinding.elementId, focus: 0, gap: 4 } : null;
      base.endBinding = el.endBinding ? { elementId: el.endBinding.elementId, focus: 0, gap: 4 } : null;
      base.startArrowhead = null;
      base.endArrowhead = el.kind === 'arrow' ? 'arrow' : null;
    }

    if (el.text && el.text.trim().length > 0 && el.kind !== 'text' && el.kind !== 'frame') {
      const textId = `${el.id}_label`;
      base.boundElements = [{ id: textId, type: 'text' }];
      out.push(base);

      const fontSize = el.fontSize ?? 14;
      const labelW = Math.max(40, base.width - 16);
      const labelH = Math.max(24, fontSize * 1.4 * el.text.split('\n').length);
      const textColor = el.kind === 'arrow' || el.kind === 'line'
        ? (el.stroke || '#334155')
        : isDarkHex(el.fill) ? '#f8fafc' : '#0f172a';
      out.push({
        id: textId,
        type: 'text',
        x: base.x + (base.width - labelW) / 2,
        y: base.y + (base.height - labelH) / 2,
        width: labelW,
        height: labelH,
        angle: 0,
        strokeColor: textColor,
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: 1,
        strokeStyle: 'solid',
        roughness: 0,
        opacity: base.opacity,
        groupIds: [],
        frameId: null,
        roundness: null,
        seed: 5000 + i * 29,
        version: 1,
        versionNonce: 6000 + i * 17,
        isDeleted: false,
        boundElements: null,
        updated: now,
        link: null,
        locked: Boolean(el.locked),
        text: el.text,
        originalText: el.text,
        fontSize,
        fontFamily: el.fontFamily === 'hand' ? 1 : el.fontFamily === 'mono' ? 3 : 2,
        textAlign: el.textAlign ?? 'center',
        verticalAlign: 'middle',
        containerId: el.id,
      });
    } else {
      out.push(base);
    }
  }

  return {
    type: 'excalidraw',
    version: 2,
    source: 'forma-canvas',
    elements: out,
    appState: {
      viewBackgroundColor: '#ffffff',
      gridSize: background === 'grid' ? 20 : null,
    },
    files: {},
  };
}

export async function createCanvasFile({ path, title, mermaid, template = 'blank' }) {
  const ext = extname(path).slice(1).toLowerCase();
  if (ext !== 'fcanvas' && ext !== 'excalidraw') {
    throw new Error('Canvas files must use .fcanvas or .excalidraw extension.');
  }

  const resolvedTitle = title?.trim() || defaultTitle(path, 'Untitled Canvas');
  const elements = mermaid && mermaid.trim().length > 0
    ? parseMermaidToCanvasElements(mermaid)
    : buildTemplateElements(template);

  const background = template === 'architecture' && !mermaid ? 'grid' : 'dots';
  const payload = ext === 'excalidraw'
    ? toExcalidrawPayload(elements, background)
    : {
        format: 'forma-canvas',
        version: 1,
        title: resolvedTitle,
        background,
        theme: 'light',
        viewport: { x: 0, y: 0, zoom: 1 },
        elements,
      };

  const json = JSON.stringify(payload, null, 2);
  await writeFile(path, json, 'utf8');
  return {
    format: ext,
    title: resolvedTitle,
    elementCount: elements.length,
    bytes: Buffer.byteLength(json, 'utf8'),
  };
}

// ============================================================================
// 2. Spreadsheet (.xlsx / .csv) Creator
// ============================================================================

function sanitizeSheetName(name, usedNames) {
  let clean = String(name || 'Sheet')
    .replace(/[*?:\\/\[\]]/g, ' ')
    .trim()
    .slice(0, 31);
  if (!clean) clean = 'Sheet';
  let candidate = clean;
  let n = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    const suffix = ` ${n}`;
    candidate = `${clean.slice(0, 31 - suffix.length)}${suffix}`;
    n += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function escapeCsvCell(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function createSheetFile({ path, title, sheets }) {
  const ext = extname(path).slice(1).toLowerCase();
  if (ext !== 'xlsx' && ext !== 'csv') {
    throw new Error('Spreadsheet files must use .xlsx or .csv extension.');
  }
  if (!Array.isArray(sheets) || sheets.length === 0) {
    throw new Error('Provide at least one sheet.');
  }

  const resolvedTitle = title?.trim() || defaultTitle(path, 'Untitled Spreadsheet');

  if (ext === 'csv') {
    const first = sheets[0];
    const rows = Array.isArray(first.rows) ? first.rows : [];
    const csv = rows.map((row) => row.map(escapeCsvCell).join(',')).join('\n') + (rows.length ? '\n' : '');
    await writeFile(path, csv, 'utf8');
    return {
      format: 'csv',
      title: resolvedTitle,
      sheetCount: 1,
      rowCount: rows.length,
      bytes: Buffer.byteLength(csv, 'utf8'),
    };
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Forma MCP';
  workbook.created = new Date();
  workbook.title = resolvedTitle;

  const usedNames = new Set();
  let totalRows = 0;

  for (const sheetSpec of sheets) {
    const sheetName = sanitizeSheetName(sheetSpec.name, usedNames);
    const worksheet = workbook.addWorksheet(sheetName);
    const rows = Array.isArray(sheetSpec.rows) ? sheetSpec.rows : [];
    totalRows += rows.length;

    const colWidths = [];

    rows.forEach((rawRow, rowIdx) => {
      const excelRow = worksheet.getRow(rowIdx + 1);
      rawRow.forEach((val, colIdx) => {
        const cell = excelRow.getCell(colIdx + 1);
        if (typeof val === 'string' && val.startsWith('=') && val.length > 1) {
          cell.value = { formula: val.slice(1) };
        } else {
          cell.value = val ?? null;
        }

        const displayLen = val === null || val === undefined ? 0 : String(val).length;
        colWidths[colIdx] = Math.max(colWidths[colIdx] ?? 10, Math.min(48, displayLen + 4));
      });

      if (rowIdx === 0 && rawRow.length > 0) {
        excelRow.font = { bold: true, color: { argb: 'FF0F172A' } };
        excelRow.eachCell({ includeEmpty: false }, (cell) => {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF1F5F9' },
          };
          cell.border = {
            bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          };
        });
      }
      excelRow.commit();
    });

    colWidths.forEach((width, idx) => {
      worksheet.getColumn(idx + 1).width = Math.max(10, Math.min(48, width));
    });
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  const buffer = Buffer.from(arrayBuffer);
  await writeFile(path, buffer);

  return {
    format: 'xlsx',
    title: resolvedTitle,
    sheetCount: sheets.length,
    rowCount: totalRows,
    bytes: buffer.length,
  };
}

// ============================================================================
// 3. Presentation (.pptx) Creator
// ============================================================================

const SLIDE_THEMES = {
  light: {
    bg: 'FFFFFF',
    title: '0F172A',
    subtitle: '475569',
    body: '1E293B',
    accent: '2563EB',
    rule: 'E2E8F0',
    muted: '94A3B8',
  },
  dark: {
    bg: '0F172A',
    title: 'F8FAFC',
    subtitle: '94A3B8',
    body: 'E2E8F0',
    accent: '38BDF8',
    rule: '334155',
    muted: '64748B',
  },
  ocean: {
    bg: '0C2D48',
    title: 'F0F9FF',
    subtitle: 'BAE6FD',
    body: 'E0F2FE',
    accent: '14B8A6',
    rule: '1E4E75',
    muted: '7DD3FC',
  },
};

export async function createSlidesFile({ path, title, theme = 'light', slides }) {
  const ext = extname(path).slice(1).toLowerCase();
  if (ext !== 'pptx') {
    throw new Error('Presentation files must use .pptx extension.');
  }
  if (!Array.isArray(slides) || slides.length === 0) {
    throw new Error('Provide at least one slide.');
  }

  const palette = SLIDE_THEMES[theme] ?? SLIDE_THEMES.light;
  const resolvedTitle = title?.trim() || slides[0]?.title?.trim() || defaultTitle(path, 'Untitled Deck');

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = 'Forma MCP';
  pptx.title = resolvedTitle;

  slides.forEach((spec, idx) => {
    const slide = pptx.addSlide();
    slide.background = { color: palette.bg };

    // Top accent bar
    slide.addShape(pptx.ShapeType.rect, {
      x: 0,
      y: 0,
      w: 10,
      h: 0.08,
      fill: { color: palette.accent },
      line: { color: palette.accent, width: 0 },
    });

    const bullets = Array.isArray(spec.bullets) ? spec.bullets.filter((b) => String(b).trim().length > 0) : [];
    const isCover = idx === 0 && bullets.length === 0;

    if (isCover) {
      // Accent pill bar
      slide.addShape(pptx.ShapeType.rect, {
        x: 0.8,
        y: 1.75,
        w: 1.1,
        h: 0.08,
        fill: { color: palette.accent },
        line: { color: palette.accent, width: 0 },
      });

      slide.addText(spec.title, {
        x: 0.8,
        y: 2.0,
        w: 8.4,
        h: 1.3,
        fontFace: 'Helvetica Neue',
        fontSize: 36,
        bold: true,
        color: palette.title,
        valign: 'top',
      });

      if (spec.subtitle && spec.subtitle.trim()) {
        slide.addText(spec.subtitle.trim(), {
          x: 0.8,
          y: 3.35,
          w: 8.4,
          h: 0.9,
          fontFace: 'Helvetica Neue',
          fontSize: 18,
          color: palette.subtitle,
          valign: 'top',
        });
      }
    } else {
      slide.addText(spec.title, {
        x: 0.7,
        y: 0.42,
        w: 8.6,
        h: 0.72,
        fontFace: 'Helvetica Neue',
        fontSize: 26,
        bold: true,
        color: palette.title,
        valign: 'middle',
      });

      let contentTop = 1.25;
      if (spec.subtitle && spec.subtitle.trim()) {
        slide.addText(spec.subtitle.trim(), {
          x: 0.7,
          y: 1.12,
          w: 8.6,
          h: 0.42,
          fontFace: 'Helvetica Neue',
          fontSize: 14,
          color: palette.subtitle,
          valign: 'top',
        });
        contentTop = 1.65;
      }

      slide.addShape(pptx.ShapeType.rect, {
        x: 0.7,
        y: contentTop - 0.1,
        w: 8.6,
        h: 0.02,
        fill: { color: palette.rule },
        line: { color: palette.rule, width: 0 },
      });

      if (bullets.length > 0) {
        const bulletRuns = bullets.map((item) => ({
          text: String(item).trim(),
          options: {
            bullet: { code: '2022', color: palette.accent },
            paraSpaceAfter: 10,
            breakLine: true,
          },
        }));

        slide.addText(bulletRuns, {
          x: 0.75,
          y: contentTop + 0.12,
          w: 8.5,
          h: 5.1 - contentTop,
          fontFace: 'Helvetica Neue',
          fontSize: 18,
          color: palette.body,
          valign: 'top',
        });
      }
    }

    // Subtle footer slide number
    slide.addText(`${idx + 1} / ${slides.length}`, {
      x: 8.5,
      y: 5.2,
      w: 0.9,
      h: 0.3,
      fontFace: 'Helvetica Neue',
      fontSize: 10,
      color: palette.muted,
      align: 'right',
    });

    if (spec.notes && spec.notes.trim()) {
      slide.addNotes(spec.notes.trim());
    }
  });

  const buffer = await pptx.write({ outputType: 'nodebuffer' });
  await writeFile(path, buffer);

  return {
    format: 'pptx',
    title: resolvedTitle,
    theme,
    slideCount: slides.length,
    bytes: buffer.length,
  };
}

// ============================================================================
// 4. Document (.docx / .md) Creator + Markdown Parser
// ============================================================================

function parseInlineRuns(text) {
  const runs = [];
  const tokenRegex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      runs.push(new TextRun({ text: text.slice(lastIndex, match.index) }));
    }
    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      runs.push(new TextRun({ text: token.slice(2, -2), bold: true }));
    } else if (token.startsWith('*') && token.endsWith('*')) {
      runs.push(new TextRun({ text: token.slice(1, -1), italics: true }));
    } else if (token.startsWith('`') && token.endsWith('`')) {
      runs.push(new TextRun({ text: token.slice(1, -1), font: 'Courier New', size: 20 }));
    } else if (match[2] !== undefined) {
      runs.push(new TextRun({ text: `${match[2]} (${match[3]})`, color: '2563EB' }));
    }
    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    runs.push(new TextRun({ text: text.slice(lastIndex) }));
  }
  if (runs.length === 0) {
    runs.push(new TextRun({ text: '' }));
  }
  return runs;
}

function splitPipeRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

function isTableSeparatorLine(line) {
  const cells = splitPipeRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

function buildDocxTable(headerCells, bodyRows) {
  const colCount = Math.max(headerCells.length, ...bodyRows.map((r) => r.length), 1);
  const cellBorder = {
    top: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
    left: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
    right: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
  };

  const makeRow = (cells, isHeader) =>
    new TableRow({
      tableHeader: isHeader,
      children: Array.from({ length: colCount }, (_, idx) => {
        const text = cells[idx] ?? '';
        return new TableCell({
          borders: cellBorder,
          shading: isHeader
            ? { type: ShadingType.CLEAR, color: 'auto', fill: 'F1F5F9' }
            : undefined,
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
          children: [
            new Paragraph({
              children: isHeader
                ? [new TextRun({ text, bold: true, color: '0F172A' })]
                : parseInlineRuns(text),
            }),
          ],
        });
      }),
    });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [makeRow(headerCells, true), ...bodyRows.map((r) => makeRow(r, false))],
  });
}

function markdownToDocxChildren(markdown) {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const children = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // Fenced code block
    if (trimmed.startsWith('```')) {
      i += 1;
      const codeLines = [];
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length && lines[i].trim().startsWith('```')) {
        i += 1;
      }
      const codeContent = codeLines.length > 0 ? codeLines : [''];
      codeContent.forEach((codeLine, idx) => {
        children.push(
          new Paragraph({
            spacing: {
              before: idx === 0 ? 120 : 0,
              after: idx === codeContent.length - 1 ? 120 : 0,
            },
            indent: { left: 240, right: 240 },
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F8FAFC' },
            border: {
              left: { style: BorderStyle.SINGLE, size: 12, color: 'CBD5E1', space: 8 },
            },
            children: [
              new TextRun({
                text: codeLine || ' ',
                font: 'Courier New',
                size: 19,
                color: '1E293B',
              }),
            ],
          })
        );
      });
      continue;
    }

    // Pipe table
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1])) {
      const headerCells = splitPipeRow(line);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && lines[i].trim().includes('|') && lines[i].trim().length > 0) {
        bodyRows.push(splitPipeRow(lines[i]));
        i += 1;
      }
      children.push(buildDocxTable(headerCells, bodyRows));
      children.push(new Paragraph({ text: '', spacing: { after: 80 } }));
      continue;
    }

    // Headings (#, ##, ###, ####)
    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      const levelMap = {
        1: HeadingLevel.HEADING_1,
        2: HeadingLevel.HEADING_2,
        3: HeadingLevel.HEADING_3,
        4: HeadingLevel.HEADING_4,
      };
      children.push(
        new Paragraph({
          heading: levelMap[headingMatch[1].length],
          spacing: { before: 200, after: 100 },
          children: parseInlineRuns(headingMatch[2].trim()),
        })
      );
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^(?:---+|\*\*\*+|___+)$/.test(trimmed)) {
      children.push(
        new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CBD5E1', space: 4 } },
          spacing: { before: 120, after: 120 },
          children: [],
        })
      );
      i += 1;
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('> ')) {
      children.push(
        new Paragraph({
          indent: { left: 360 },
          border: { left: { style: BorderStyle.SINGLE, size: 12, color: '94A3B8', space: 8 } },
          spacing: { before: 80, after: 80 },
          children: [new TextRun({ text: trimmed.slice(2).trim(), italics: true, color: '475569' })],
        })
      );
      i += 1;
      continue;
    }

    // Unordered bullet list
    const bulletMatch = /^(\s*)[-*+]\s+(.+)$/.exec(line);
    if (bulletMatch) {
      const level = Math.min(2, Math.floor(bulletMatch[1].length / 2));
      children.push(
        new Paragraph({
          bullet: { level },
          spacing: { after: 60 },
          children: parseInlineRuns(bulletMatch[2].trim()),
        })
      );
      i += 1;
      continue;
    }

    // Ordered numbered list
    const orderedMatch = /^(\s*)\d+[.)]\s+(.+)$/.exec(line);
    if (orderedMatch) {
      const level = Math.min(2, Math.floor(orderedMatch[1].length / 2));
      children.push(
        new Paragraph({
          numbering: { reference: 'forma-ordered', level },
          spacing: { after: 60 },
          children: parseInlineRuns(orderedMatch[2].trim()),
        })
      );
      i += 1;
      continue;
    }

    // Regular paragraph (merge consecutive plain lines)
    const paraLines = [trimmed];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim().length > 0 &&
      !/^(?:#{1,4}\s|```|>\s|\s*[-*+]\s|\s*\d+[.)]\s|(?:---+|\*\*\*+|___+)$)/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1]))
    ) {
      paraLines.push(lines[i].trim());
      i += 1;
    }
    children.push(
      new Paragraph({
        spacing: { after: 120 },
        children: parseInlineRuns(paraLines.join(' ')),
      })
    );
  }

  return children;
}

export async function createDocFile({ path, title, markdown }) {
  const ext = extname(path).slice(1).toLowerCase();
  if (ext !== 'docx' && ext !== 'md') {
    throw new Error('Document files must use .docx or .md extension.');
  }

  const resolvedTitle = title?.trim() || defaultTitle(path, 'Untitled Document');

  if (ext === 'md') {
    const text = String(markdown ?? '');
    await writeFile(path, text, 'utf8');
    return {
      format: 'md',
      title: resolvedTitle,
      bytes: Buffer.byteLength(text, 'utf8'),
    };
  }

  const children = markdownToDocxChildren(markdown ?? '');
  if (children.length === 0) {
    children.push(new Paragraph({ text: '' }));
  }

  const doc = new Document({
    creator: 'Forma MCP',
    title: resolvedTitle,
    numbering: {
      config: [
        {
          reference: 'forma-ordered',
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: '%1.',
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
            {
              level: 1,
              format: LevelFormat.LOWER_LETTER,
              text: '%2.',
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 1440, hanging: 360 } } },
            },
            {
              level: 2,
              format: LevelFormat.LOWER_ROMAN,
              text: '%3.',
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 2160, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  await writeFile(path, buffer);

  return {
    format: 'docx',
    title: resolvedTitle,
    bytes: buffer.length,
  };
}
