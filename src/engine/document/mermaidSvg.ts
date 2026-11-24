import katex from 'katex';

type FlowDirection = 'TD' | 'TB' | 'BT' | 'LR' | 'RL';
type NodeShape = 'rect' | 'round' | 'stadium' | 'diamond' | 'circle';

interface FlowNode {
  id: string;
  label: string;
  shape: NodeShape;
  explicitShape: boolean;
  layer: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FlowEdge {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
  thick?: boolean;
  directed: boolean;
}

interface SeqParticipant {
  id: string;
  label: string;
  kind: 'participant' | 'actor';
}

interface SeqMessage {
  from: string;
  to: string;
  label: string;
  dashed: boolean;
  crossEnd: boolean;
}

export interface ExtractedDocVisual {
  id: string;
  kind: 'mermaid' | 'math-display' | 'math-inline';
  label: string;
  source: string;
  html: string;
  svg?: string;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripOuterQuotes(label: string): string {
  const trimmed = label.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseNodeToken(raw: string): { id: string; label: string; shape: NodeShape; explicitShape: boolean } | null {
  const token = raw.trim();
  if (!token) return null;

  // Match id + optional shape wrapper: ((...)), ([...]), [...], (...), {...}
  const m =
    /^([A-Za-z0-9_.-]+)\s*(?:(\(\()([\s\S]+?)(\)\))|(\(\[)([\s\S]+?)(\]\))|(\[)([\s\S]+?)(\])|(\()([\s\S]+?)(\))|(\{)([\s\S]+?)(\}))?$/.exec(
      token
    );
  if (!m) {
    const cleanId = token.replace(/[^A-Za-z0-9_.-]/g, '_');
    if (!cleanId) return null;
    return { id: cleanId, label: token, shape: 'rect', explicitShape: false };
  }

  const id = m[1];
  if (m[2]) {
    return { id, label: stripOuterQuotes(m[3]), shape: 'circle', explicitShape: true };
  }
  if (m[5]) {
    return { id, label: stripOuterQuotes(m[6]), shape: 'stadium', explicitShape: true };
  }
  if (m[8]) {
    return { id, label: stripOuterQuotes(m[9]), shape: 'rect', explicitShape: true };
  }
  if (m[11]) {
    return { id, label: stripOuterQuotes(m[12]), shape: 'round', explicitShape: true };
  }
  if (m[14]) {
    return { id, label: stripOuterQuotes(m[15]), shape: 'diamond', explicitShape: true };
  }
  return { id, label: id, shape: 'rect', explicitShape: false };
}

function measureLabelLines(label: string, maxChars = 24): string[] {
  const explicitLines = label.replace(/<br\s*\/?>/gi, '\n').split('\n');
  const wrapped: string[] = [];
  for (const line of explicitLines) {
    const words = line.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    let current = words[0];
    for (let i = 1; i < words.length; i++) {
      if ((current + ' ' + words[i]).length <= maxChars) {
        current += ' ' + words[i];
      } else {
        wrapped.push(current);
        current = words[i];
      }
    }
    wrapped.push(current);
  }
  return wrapped.length > 0 ? wrapped : [label || ' '];
}

function renderFallbackCard(code: string, reason = 'Mermaid Diagram'): string {
  const lines = code
    .trim()
    .split('\n')
    .slice(0, 12);
  const maxLen = Math.max(28, ...lines.map((l) => l.length));
  const width = Math.min(640, Math.max(340, maxLen * 7.6 + 48));
  const height = Math.max(108, 56 + lines.length * 18 + 20);

  const lineEls = lines
    .map(
      (line, idx) =>
        `<text x="20" y="${64 + idx * 18}" fill="#334155" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">${escapeXml(
          line.slice(0, 76)
        )}</text>`
    )
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(reason)}">
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="12" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.5"/>
  <rect x="1" y="1" width="${width - 2}" height="34" rx="12" fill="#eff6ff"/>
  <rect x="1" y="20" width="${width - 2}" height="15" fill="#eff6ff"/>
  <line x1="1" y1="35" x2="${width - 1}" y2="35" stroke="#bfdbfe" stroke-width="1"/>
  <circle cx="18" cy="18" r="4.5" fill="#2563eb"/>
  <text x="30" y="22" fill="#1e3a8a" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="12" font-weight="600">${escapeXml(reason)}</text>
  ${lineEls}
</svg>`;
}

function renderFlowchartSvg(direction: FlowDirection, bodyLines: string[]): string | null {
  const nodeMap = new Map<string, FlowNode>();
  const nodeOrder: string[] = [];
  const edges: FlowEdge[] = [];

  const upsertNode = (token: { id: string; label: string; shape: NodeShape; explicitShape: boolean }): FlowNode => {
    const existing = nodeMap.get(token.id);
    if (existing) {
      if (token.explicitShape && !existing.explicitShape) {
        existing.label = token.label;
        existing.shape = token.shape;
        existing.explicitShape = true;
      }
      return existing;
    }
    const created: FlowNode = {
      id: token.id,
      label: token.label,
      shape: token.shape,
      explicitShape: token.explicitShape,
      layer: 0,
      x: 0,
      y: 0,
      width: 120,
      height: 44,
    };
    nodeMap.set(token.id, created);
    nodeOrder.push(token.id);
    return created;
  };

  // Edge connector regex matching Mermaid arrow variants (including inline labels and |label| labels)
  const edgeRegex =
    /\s*(-->\s*\|[^|]*\||-\.->\s*\|[^|]*\||==>\s*\|[^|]*\||---\s*\|[^|]*\||--\s+[^-\n>]+?\s+-->|-\.\s+[^.\n>]+?\s+\.->|==\s+[^=\n>]+?\s+==>|-\.->|-->|==>|---|->)\s*/g;

  const statements = bodyLines
    .map((line) => line.replace(/%%.*$/, '').trim())
    .filter(Boolean)
    .flatMap((line) => line.split(';').map((s) => s.trim()).filter(Boolean));

  for (const stmt of statements) {
    if (
      /^(subgraph|end|classDef|class|style|linkStyle|click|direction)\b/i.test(stmt)
    ) {
      continue;
    }

    edgeRegex.lastIndex = 0;
    const parts: string[] = [];
    const connectors: string[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = edgeRegex.exec(stmt)) !== null) {
      parts.push(stmt.slice(lastIndex, match.index).trim());
      connectors.push(match[1].trim());
      lastIndex = match.index + match[0].length;
    }
    parts.push(stmt.slice(lastIndex).trim());

    if (connectors.length === 0) {
      const single = parseNodeToken(parts[0]);
      if (single) upsertNode(single);
      continue;
    }

    for (let i = 0; i < connectors.length; i++) {
      const leftTok = parseNodeToken(parts[i]);
      const rightTok = parseNodeToken(parts[i + 1]);
      if (!leftTok || !rightTok) continue;
      const fromNode = upsertNode(leftTok);
      const toNode = upsertNode(rightTok);
      const conn = connectors[i];

      let edgeLabel: string | undefined;
      const pipeMatch = /\|([^|]*)\|/.exec(conn);
      if (pipeMatch) {
        edgeLabel = stripOuterQuotes(pipeMatch[1]);
      } else {
        const inlineMatch = /^(?:--|-\.|==)\s+(.+?)\s+(?:-->|\.->|==>)$/.exec(conn);
        if (inlineMatch) {
          edgeLabel = stripOuterQuotes(inlineMatch[1]);
        }
      }

      edges.push({
        from: fromNode.id,
        to: toNode.id,
        label: edgeLabel || undefined,
        dashed: conn.includes('-.'),
        thick: conn.includes('=='),
        directed: conn.includes('>'),
      });
    }
  }

  if (nodeOrder.length === 0) return null;

  // Compute node sizes
  for (const id of nodeOrder) {
    const node = nodeMap.get(id)!;
    const lines = measureLabelLines(node.label, node.shape === 'diamond' ? 16 : 22);
    const longest = Math.max(4, ...lines.map((l) => l.length));
    if (node.shape === 'circle') {
      const diam = Math.max(64, Math.min(132, longest * 8 + 28, Math.max(64, lines.length * 18 + 30)));
      node.width = Math.max(diam, longest * 7.8 + 26);
      node.height = Math.max(64, lines.length * 18 + 28);
    } else if (node.shape === 'diamond') {
      node.width = Math.max(124, Math.min(240, longest * 9 + 52));
      node.height = Math.max(68, lines.length * 18 + 38);
    } else {
      node.width = Math.max(114, Math.min(240, longest * 7.8 + 34));
      node.height = Math.max(42, lines.length * 18 + 22);
    }
  }

  // Topological / longest-path layering (cycle-safe)
  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const id of nodeOrder) {
    inDegree.set(id, 0);
    outgoing.set(id, []);
  }
  for (const e of edges) {
    if (e.from === e.to) continue;
    outgoing.get(e.from)!.push(e.to);
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }

  const roots = nodeOrder.filter((id) => (inDegree.get(id) ?? 0) === 0);
  const queue: string[] = roots.length > 0 ? [...roots] : [nodeOrder[0]];
  const visitedCount = new Map<string, number>();
  const maxPasses = nodeOrder.length + 1;

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const currNode = nodeMap.get(curr)!;
    for (const next of outgoing.get(curr) ?? []) {
      const nextNode = nodeMap.get(next)!;
      const visits = visitedCount.get(next) ?? 0;
      if (visits < maxPasses && nextNode.layer < currNode.layer + 1) {
        nextNode.layer = currNode.layer + 1;
        visitedCount.set(next, visits + 1);
        queue.push(next);
      }
    }
  }

  const maxLayer = Math.max(0, ...nodeOrder.map((id) => nodeMap.get(id)!.layer));
  const layers: FlowNode[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const id of nodeOrder) {
    const n = nodeMap.get(id)!;
    layers[n.layer].push(n);
  }

  const isHorizontal = direction === 'LR' || direction === 'RL';
  const isReversed = direction === 'RL' || direction === 'BT';
  if (isReversed) layers.reverse();

  const padX = 36;
  const padY = 32;
  const gapPrimary = isHorizontal ? 78 : 58;
  const gapSecondary = isHorizontal ? 28 : 34;

  let svgWidth = 0;
  let svgHeight = 0;

  if (!isHorizontal) {
    // Top-Down / Bottom-Top
    const layerWidths = layers.map(
      (grp) => grp.reduce((sum, n) => sum + n.width, 0) + Math.max(0, grp.length - 1) * gapSecondary
    );
    const maxContentW = Math.max(240, ...layerWidths);
    svgWidth = Math.round(maxContentW + padX * 2);

    let cursorY = padY;
    layers.forEach((grp, idx) => {
      const rowH = Math.max(44, ...grp.map((n) => n.height));
      const totalW = layerWidths[idx];
      let cursorX = (svgWidth - totalW) / 2;
      for (const n of grp) {
        n.x = cursorX + n.width / 2;
        n.y = cursorY + rowH / 2;
        cursorX += n.width + gapSecondary;
      }
      cursorY += rowH + (idx < layers.length - 1 ? gapPrimary : 0);
    });
    svgHeight = Math.round(cursorY + padY);
  } else {
    // Left-Right / Right-Left
    const layerHeights = layers.map(
      (grp) => grp.reduce((sum, n) => sum + n.height, 0) + Math.max(0, grp.length - 1) * gapSecondary
    );
    const maxContentH = Math.max(160, ...layerHeights);
    svgHeight = Math.round(maxContentH + padY * 2);

    let cursorX = padX;
    layers.forEach((grp, idx) => {
      const colW = Math.max(116, ...grp.map((n) => n.width));
      const totalH = layerHeights[idx];
      let cursorY = (svgHeight - totalH) / 2;
      for (const n of grp) {
        n.x = cursorX + colW / 2;
        n.y = cursorY + n.height / 2;
        cursorY += n.height + gapSecondary;
      }
      cursorX += colW + (idx < layers.length - 1 ? gapPrimary : 0);
    });
    svgWidth = Math.round(cursorX + padX);
  }

  // Render edges
  const edgeSvg: string[] = [];
  for (const e of edges) {
    const src = nodeMap.get(e.from);
    const dst = nodeMap.get(e.to);
    if (!src || !dst) continue;

    let pathD = '';
    let labelX = 0;
    let labelY = 0;

    if (src.id === dst.id) {
      const sx = src.x + src.width / 2;
      const sy = src.y - 8;
      const ex = src.x + src.width / 2;
      const ey = src.y + 8;
      pathD = `M ${sx} ${sy} C ${sx + 44} ${sy - 24}, ${ex + 44} ${ey + 24}, ${ex} ${ey}`;
      labelX = sx + 38;
      labelY = src.y;
    } else if (!isHorizontal) {
      const goingDown = dst.y >= src.y;
      const sx = src.x;
      const sy = goingDown ? src.y + src.height / 2 : src.y - src.height / 2;
      const ex = dst.x;
      const ey = goingDown ? dst.y - dst.height / 2 : dst.y + dst.height / 2;
      const dy = Math.abs(ey - sy);

      if (!goingDown && Math.abs(src.x - dst.x) < 40) {
        // Back-edge curve around the side
        const offset = Math.max(src.width, dst.width) / 2 + 38;
        const cx = Math.max(src.x, dst.x) + offset;
        pathD = `M ${src.x + src.width / 2} ${src.y} C ${cx} ${src.y}, ${cx} ${dst.y}, ${dst.x + dst.width / 2} ${dst.y}`;
        labelX = cx - 4;
        labelY = (src.y + dst.y) / 2;
      } else {
        const ctrl = Math.max(24, dy * 0.45);
        const c1y = goingDown ? sy + ctrl : sy - ctrl;
        const c2y = goingDown ? ey - ctrl : ey + ctrl;
        pathD = `M ${sx} ${sy} C ${sx} ${c1y}, ${ex} ${c2y}, ${ex} ${ey}`;
        labelX = (sx + ex) / 2;
        labelY = (sy + ey) / 2;
      }
    } else {
      const goingRight = dst.x >= src.x;
      const sx = goingRight ? src.x + src.width / 2 : src.x - src.width / 2;
      const sy = src.y;
      const ex = goingRight ? dst.x - dst.width / 2 : dst.x + dst.width / 2;
      const ey = dst.y;
      const dx = Math.abs(ex - sx);

      if (!goingRight && Math.abs(src.y - dst.y) < 36) {
        const offset = Math.max(src.height, dst.height) / 2 + 34;
        const cy = Math.min(src.y, dst.y) - offset;
        pathD = `M ${src.x} ${src.y - src.height / 2} C ${src.x} ${cy}, ${dst.x} ${cy}, ${dst.x} ${dst.y - dst.height / 2}`;
        labelX = (src.x + dst.x) / 2;
        labelY = cy + 4;
      } else {
        const ctrl = Math.max(24, dx * 0.45);
        const c1x = goingRight ? sx + ctrl : sx - ctrl;
        const c2x = goingRight ? ex - ctrl : ex + ctrl;
        pathD = `M ${sx} ${sy} C ${c1x} ${sy}, ${c2x} ${ey}, ${ex} ${ey}`;
        labelX = (sx + ex) / 2;
        labelY = (sy + ey) / 2;
      }
    }

    const strokeWidth = e.thick ? 2.5 : 1.65;
    const dashAttr = e.dashed ? ' stroke-dasharray="5,4"' : '';
    const markerAttr = e.directed ? ' marker-end="url(#forma-mermaid-arrow)"' : '';
    edgeSvg.push(
      `<path d="${pathD}" fill="none" stroke="#64748b" stroke-width="${strokeWidth}"${dashAttr}${markerAttr}/>`
    );

    if (e.label) {
      const pillW = Math.max(30, e.label.length * 6.8 + 14);
      const pillH = 20;
      edgeSvg.push(
        `<rect x="${(labelX - pillW / 2).toFixed(1)}" y="${(labelY - pillH / 2).toFixed(
          1
        )}" width="${pillW.toFixed(1)}" height="${pillH}" rx="10" fill="#ffffff" stroke="#cbd5e1" stroke-width="1"/>`
      );
      edgeSvg.push(
        `<text x="${labelX.toFixed(1)}" y="${(labelY + 3.5).toFixed(
          1
        )}" text-anchor="middle" fill="#475569" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="11" font-weight="500">${escapeXml(
          e.label
        )}</text>`
      );
    }
  }

  // Render nodes
  const nodeSvg: string[] = [];
  for (const id of nodeOrder) {
    const n = nodeMap.get(id)!;
    const left = n.x - n.width / 2;
    const top = n.y - n.height / 2;
    const lines = measureLabelLines(n.label, n.shape === 'diamond' ? 16 : 22);

    if (n.shape === 'diamond') {
      const pts = `${n.x},${top} ${left + n.width},${n.y} ${n.x},${top + n.height} ${left},${n.y}`;
      nodeSvg.push(
        `<polygon points="${pts}" fill="#eff6ff" stroke="#2563eb" stroke-width="1.75" filter="url(#forma-mermaid-shadow)"/>`
      );
    } else if (n.shape === 'circle') {
      nodeSvg.push(
        `<ellipse cx="${n.x}" cy="${n.y}" rx="${(n.width / 2).toFixed(1)}" ry="${(n.height / 2).toFixed(
          1
        )}" fill="#f0f9ff" stroke="#0284c7" stroke-width="1.75" filter="url(#forma-mermaid-shadow)"/>`
      );
    } else {
      const rx = n.shape === 'stadium' ? Math.round(n.height / 2) : n.shape === 'round' ? 12 : 8;
      const isRoot = (inDegree.get(n.id) ?? 0) === 0;
      const fill = isRoot ? '#eff6ff' : '#ffffff';
      const stroke = isRoot ? '#2563eb' : '#94a3b8';
      nodeSvg.push(
        `<rect x="${left.toFixed(1)}" y="${top.toFixed(1)}" width="${n.width.toFixed(
          1
        )}" height="${n.height.toFixed(1)}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1.65" filter="url(#forma-mermaid-shadow)"/>`
      );
    }

    const lineHeight = 16;
    const startY = n.y - ((lines.length - 1) * lineHeight) / 2 + 4;
    lines.forEach((line, idx) => {
      nodeSvg.push(
        `<text x="${n.x.toFixed(1)}" y="${(startY + idx * lineHeight).toFixed(
          1
        )}" text-anchor="middle" fill="#0f172a" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="12.5" font-weight="500">${escapeXml(
          line
        )}</text>`
      );
    });
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${svgHeight}" width="${svgWidth}" height="${svgHeight}" role="img" aria-label="Mermaid Flowchart">
  <defs>
    <marker id="forma-mermaid-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="#64748b"/>
    </marker>
    <filter id="forma-mermaid-shadow" x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx="0" dy="1.5" stdDeviation="2" flood-color="#0f172a" flood-opacity="0.08"/>
    </filter>
  </defs>
  <rect width="${svgWidth}" height="${svgHeight}" rx="12" fill="#f8fafc"/>
  ${edgeSvg.join('\n  ')}
  ${nodeSvg.join('\n  ')}
</svg>`;
}

function renderSequenceSvg(bodyLines: string[]): string | null {
  const participants: SeqParticipant[] = [];
  const participantMap = new Map<string, SeqParticipant>();
  const messages: SeqMessage[] = [];

  const ensureParticipant = (id: string, label?: string, kind: 'participant' | 'actor' = 'participant') => {
    const key = id.trim();
    const existing = participantMap.get(key);
    if (existing) {
      if (label) existing.label = label;
      return existing;
    }
    const created: SeqParticipant = { id: key, label: label || key, kind };
    participantMap.set(key, created);
    participants.push(created);
    return created;
  };

  for (const raw of bodyLines) {
    const line = raw.replace(/%%.*$/, '').trim();
    if (!line) continue;

    const decl = /^(participant|actor)\s+([^\s]+)(?:\s+as\s+(.+))?$/i.exec(line);
    if (decl) {
      ensureParticipant(
        decl[2],
        decl[3]?.trim() || decl[2],
        decl[1].toLowerCase() === 'actor' ? 'actor' : 'participant'
      );
      continue;
    }

    const msgMatch = /^([^:\-\s]+)\s*(-->>|->>|-->|->|--x|-x)[+-]?\s*([^:\s]+)\s*:\s*(.*)$/.exec(line);
    if (msgMatch) {
      const from = msgMatch[1].trim();
      const arrow = msgMatch[2];
      const to = msgMatch[3].trim();
      const text = msgMatch[4].trim();
      ensureParticipant(from);
      ensureParticipant(to);
      messages.push({
        from,
        to,
        label: text,
        dashed: arrow.startsWith('--'),
        crossEnd: arrow.endsWith('x'),
      });
    }
  }

  if (participants.length === 0) return null;

  const colSpacing = Math.max(168, Math.min(220, Math.max(...participants.map((p) => p.label.length * 8.2 + 52))));
  const boxH = 38;
  const padX = 36;
  const padTop = 26;
  const msgStartY = padTop + boxH + 34;
  const rowH = 48;
  const bottomBoxY = msgStartY + Math.max(1, messages.length) * rowH + 16;

  const svgWidth = Math.round(padX * 2 + Math.max(1, participants.length - 1) * colSpacing + 140);
  const svgHeight = Math.round(bottomBoxY + boxH + 26);

  const centerX = new Map<string, number>();
  participants.forEach((p, idx) => {
    centerX.set(p.id, padX + 70 + idx * colSpacing);
  });

  const lifelineEls: string[] = [];
  const headerBoxes: string[] = [];
  const footerBoxes: string[] = [];

  for (const p of participants) {
    const cx = centerX.get(p.id)!;
    const bw = Math.max(106, Math.min(164, p.label.length * 7.8 + 30));
    const bx = cx - bw / 2;

    lifelineEls.push(
      `<line x1="${cx}" y1="${padTop + boxH}" x2="${cx}" y2="${bottomBoxY}" stroke="#cbd5e1" stroke-width="1.5" stroke-dasharray="5,5"/>`
    );

    const renderBox = (y: number) => `
      <rect x="${bx.toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${boxH}" rx="8" fill="#eff6ff" stroke="#2563eb" stroke-width="1.5"/>
      <text x="${cx}" y="${y + 23}" text-anchor="middle" fill="#1e3a8a" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="12.5" font-weight="600">${escapeXml(
        p.label
      )}</text>`;

    headerBoxes.push(renderBox(padTop));
    footerBoxes.push(renderBox(bottomBoxY));
  }

  const msgEls: string[] = [];
  messages.forEach((m, idx) => {
    const y = msgStartY + idx * rowH;
    const x1 = centerX.get(m.from)!;
    const x2 = centerX.get(m.to)!;
    const dashAttr = m.dashed ? ' stroke-dasharray="6,4"' : '';

    if (m.from === m.to) {
      const loopW = 54;
      const loopH = 22;
      msgEls.push(
        `<path d="M ${x1} ${y} L ${x1 + loopW} ${y} L ${x1 + loopW} ${y + loopH} L ${x1 + 4} ${y + loopH}" fill="none" stroke="#334155" stroke-width="1.6"${dashAttr} marker-end="url(#forma-seq-arrow)"/>`
      );
      if (m.label) {
        msgEls.push(
          `<text x="${x1 + loopW + 8}" y="${y + 15}" fill="#0f172a" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="11.5" font-weight="500">${escapeXml(
            m.label
          )}</text>`
        );
      }
    } else {
      const dir = x2 > x1 ? 1 : -1;
      const endX = x2 - dir * 4;
      const marker = m.crossEnd ? '' : ' marker-end="url(#forma-seq-arrow)"';
      msgEls.push(
        `<line x1="${x1}" y1="${y}" x2="${endX}" y2="${y}" stroke="#334155" stroke-width="1.6"${dashAttr}${marker}/>`
      );
      if (m.crossEnd) {
        msgEls.push(
          `<path d="M ${endX - 5} ${y - 5} L ${endX + 5} ${y + 5} M ${endX + 5} ${y - 5} L ${endX - 5} ${y + 5}" stroke="#dc2626" stroke-width="1.8"/>`
        );
      }
      if (m.label) {
        const mx = (x1 + x2) / 2;
        const lblW = Math.min(Math.abs(x2 - x1) - 12, m.label.length * 6.8 + 14);
        msgEls.push(
          `<rect x="${(mx - lblW / 2).toFixed(1)}" y="${y - 22}" width="${Math.max(24, lblW).toFixed(
            1
          )}" height="18" rx="4" fill="#f8fafc"/>`
        );
        msgEls.push(
          `<text x="${mx.toFixed(1)}" y="${y - 9}" text-anchor="middle" fill="#0f172a" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="11.5" font-weight="500">${escapeXml(
            m.label
          )}</text>`
        );
      }
    }
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${svgHeight}" width="${svgWidth}" height="${svgHeight}" role="img" aria-label="Mermaid Sequence Diagram">
  <defs>
    <marker id="forma-seq-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="#334155"/>
    </marker>
  </defs>
  <rect width="${svgWidth}" height="${svgHeight}" rx="12" fill="#f8fafc"/>
  ${lifelineEls.join('\n  ')}
  ${headerBoxes.join('\n  ')}
  ${msgEls.join('\n  ')}
  ${footerBoxes.join('\n  ')}
</svg>`;
}

/**
 * Zero-dependency lightweight Mermaid diagram-to-SVG renderer.
 * Supports `flowchart`/`graph` (TD/TB/BT/LR/RL) and `sequenceDiagram`,
 * with a clean styled fallback SVG card for unsupported diagram types.
 */
export function renderMermaidToSvg(code: string): string {
  const trimmed = (code || '').trim();
  if (!trimmed) {
    return renderFallbackCard('(empty diagram)', 'Mermaid Diagram');
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('%%'));

  if (lines.length === 0) {
    return renderFallbackCard(trimmed, 'Mermaid Diagram');
  }

  const header = lines[0];
  const flowMatch = /^(?:flowchart|graph)(?:\s+(TD|TB|BT|LR|RL))?\s*;?$/i.exec(header);
  if (flowMatch) {
    const dir = (flowMatch[1]?.toUpperCase() as FlowDirection | undefined) ?? 'TD';
    const svg = renderFlowchartSvg(dir, lines.slice(1));
    if (svg) return svg;
  }

  if (/^sequenceDiagram\b/i.test(header)) {
    const svg = renderSequenceSvg(lines.slice(1));
    if (svg) return svg;
  }

  const kindLabel = header.split(/\s+/)[0] || 'Mermaid';
  return renderFallbackCard(trimmed, `Mermaid · ${kindLabel}`);
}

function isLikelyMermaidSource(source: string): boolean {
  const first = source
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('%%'));
  if (!first) return false;
  return /^(?:flowchart|graph)\b/i.test(first) || /^sequenceDiagram\b/i.test(first);
}

/**
 * Transform an HTML document string by rendering Mermaid code blocks into inline SVGs
 * and LaTeX math expressions (`$$...$$`, `\[...\]`, `$...$`, `\(...\)`) via KaTeX.
 * Never mutates non-mermaid code/pre blocks.
 */
export function renderDocMathAndDiagrams(html: string): string {
  if (!html) return html;

  // 1. Replace Mermaid fenced code blocks with SVG containers
  let out = html.replace(
    /<pre[^>]*>\s*<code([^>]*)>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (fullMatch, attrs: string, rawCode: string) => {
      const hasMermaidClass = /language-mermaid/i.test(attrs);
      const decoded = decodeHtmlEntities(rawCode).trim();
      if (!hasMermaidClass && !isLikelyMermaidSource(decoded)) {
        return fullMatch;
      }
      const svg = renderMermaidToSvg(decoded);
      return `<div class="forma-mermaid-diagram" data-forma-mermaid="true">${svg}</div>`;
    }
  );

  // 2. Protect <pre>, <code>, <svg>, <script>, <style> and HTML tags while rendering LaTeX math
  const protectedBlocks: string[] = [];
  const stashBlock = (segment: string) => {
    const idx = protectedBlocks.length;
    protectedBlocks.push(segment);
    return `@@FORMA_PROT_${idx}@@`;
  };

  out = out.replace(
    /<(pre|code|svg|script|style)\b[^>]*>[\s\S]*?<\/\1>|<[^>]+>/gi,
    (segment) => stashBlock(segment)
  );

  // Display math: $$...$$ or \[...\]
  out = out.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_, m1, m2) => {
    const expr = decodeHtmlEntities((m1 ?? m2 ?? '').trim());
    if (!expr) return '';
    try {
      const rendered = katex.renderToString(expr, { displayMode: true, throwOnError: false });
      return stashBlock(`<div class="forma-math-display my-2 overflow-x-auto">${rendered}</div>`);
    } catch {
      return stashBlock(`<code>${escapeXml(expr)}</code>`);
    }
  });

  // Inline math: $...$ or \(...\) (avoid currency like "$100 to $200")
  out = out.replace(
    /(?<!\\)\$(?!\s|\d+(?:[.,]\d+)?\s)([^\n$]+?)(?<!\s|\\)\$(?!\d)|\\\(([^\n]+?)\\\)/g,
    (_, m1, m2) => {
      const expr = decodeHtmlEntities((m1 ?? m2 ?? '').trim());
      if (!expr) return '';
      try {
        const rendered = katex.renderToString(expr, { displayMode: false, throwOnError: false });
        return stashBlock(`<span class="forma-math-inline">${rendered}</span>`);
      } catch {
        return stashBlock(`<code>${escapeXml(expr)}</code>`);
      }
    }
  );

  // Restore stashed blocks (may be nested once)
  out = out.replace(/@@FORMA_PROT_(\d+)@@/g, (_, idx) => protectedBlocks[Number(idx)] ?? '');
  out = out.replace(/@@FORMA_PROT_(\d+)@@/g, (_, idx) => protectedBlocks[Number(idx)] ?? '');

  return out;
}

/**
 * Extract rendered Mermaid diagrams and LaTeX math formulas from a Forma Document
 * for live side-by-side / tray preview without touching TipTap's ProseMirror DOM.
 */
export function extractDocVisuals(html: string, markdownSource?: string): ExtractedDocVisual[] {
  const visuals: ExtractedDocVisual[] = [];
  const seenMermaid = new Set<string>();
  const seenMath = new Set<string>();

  let mermaidIdx = 0;
  let mathIdx = 0;

  const pushMermaid = (source: string) => {
    const trimmed = source.trim();
    if (!trimmed || seenMermaid.has(trimmed)) return;
    seenMermaid.add(trimmed);
    mermaidIdx += 1;
    const svg = renderMermaidToSvg(trimmed);
    visuals.push({
      id: `mermaid_${mermaidIdx}`,
      kind: 'mermaid',
      label: `Diagram ${mermaidIdx}`,
      source: trimmed,
      html: svg,
      svg,
    });
  };

  const pushMath = (expr: string, displayMode: boolean) => {
    const cleaned = expr.trim();
    if (!cleaned) return;
    const key = `${displayMode ? 'D' : 'I'}:${cleaned}`;
    if (seenMath.has(key)) return;
    seenMath.add(key);
    mathIdx += 1;
    let rendered = '';
    try {
      rendered = katex.renderToString(cleaned, { displayMode, throwOnError: false });
    } catch {
      rendered = `<code>${escapeXml(cleaned)}</code>`;
    }
    visuals.push({
      id: `math_${mathIdx}`,
      kind: displayMode ? 'math-display' : 'math-inline',
      label: displayMode ? `Equation ${mathIdx}` : `Math ${mathIdx}`,
      source: cleaned,
      html: rendered,
    });
  };

  // 1. Extract Mermaid blocks from HTML <pre><code>
  const codeBlockRegex = /<pre[^>]*>\s*<code([^>]*)>([\s\S]*?)<\/code>\s*<\/pre>/gi;
  let codeMatch: RegExpExecArray | null;
  while ((codeMatch = codeBlockRegex.exec(html || '')) !== null) {
    const attrs = codeMatch[1] || '';
    const decoded = decodeHtmlEntities(codeMatch[2] || '').trim();
    if (/language-mermaid/i.test(attrs) || isLikelyMermaidSource(decoded)) {
      pushMermaid(decoded);
    }
  }

  // Also scan raw markdown source for ```mermaid fences (useful while typing in Markdown mode)
  if (markdownSource) {
    const mdFenceRegex = /```mermaid[ \t]*\r?\n([\s\S]*?)```/gi;
    let mdMatch: RegExpExecArray | null;
    while ((mdMatch = mdFenceRegex.exec(markdownSource)) !== null) {
      pushMermaid(mdMatch[1]);
    }
  }

  // 2. Extract LaTeX math from non-code text
  const strippedHtml = (html || '')
    .replace(/<(pre|code|script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, '\n');
  const plainText = decodeHtmlEntities(strippedHtml);

  // Display math $$...$$ and \[...\]
  let remaining = plainText.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_, m1, m2) => {
    pushMath(m1 ?? m2 ?? '', true);
    return ' ';
  });

  // Inline math $...$ and \(...\)
  remaining = remaining.replace(
    /(?<!\\)\$(?!\s|\d+(?:[.,]\d+)?\s)([^\n$]+?)(?<!\s|\\)\$(?!\d)|\\\(([^\n]+?)\\\)/g,
    (_, m1, m2) => {
      pushMath(m1 ?? m2 ?? '', false);
      return ' ';
    }
  );
  void remaining;

  return visuals;
}
