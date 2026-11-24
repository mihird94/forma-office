import {
  CanvasAnchorSide,
  CanvasData,
  CanvasElement,
  CanvasTemplateId,
} from '../../types/canvas';

function makeId(prefix = 'el'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function anchorPoint(el: CanvasElement, side: CanvasAnchorSide): { x: number; y: number } {
  switch (side) {
    case 'top':
      return { x: el.x + el.width / 2, y: el.y };
    case 'right':
      return { x: el.x + el.width, y: el.y + el.height / 2 };
    case 'bottom':
      return { x: el.x + el.width / 2, y: el.y + el.height };
    case 'left':
      return { x: el.x, y: el.y + el.height / 2 };
    case 'center':
    default:
      return { x: el.x + el.width / 2, y: el.y + el.height / 2 };
  }
}

function makeBoundArrow(
  from: CanvasElement,
  fromAnchor: CanvasAnchorSide,
  to: CanvasElement,
  toAnchor: CanvasAnchorSide,
  options?: {
    text?: string;
    stroke?: string;
    strokeStyle?: 'solid' | 'dashed' | 'dotted';
    roughness?: 0 | 1;
  }
): CanvasElement {
  const start = anchorPoint(from, fromAnchor);
  const end = anchorPoint(to, toAnchor);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  return {
    id: makeId('arr'),
    kind: 'arrow',
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
    text: options?.text,
    fontSize: 12,
    fontFamily: 'sans',
    textAlign: 'center',
    stroke: options?.stroke ?? '#475569',
    strokeWidth: 2,
    strokeStyle: options?.strokeStyle ?? 'solid',
    roughness: options?.roughness ?? 0,
    opacity: 1,
  };
}

export function createBlankCanvas(title = 'Untitled Canvas'): CanvasData {
  const now = Date.now();
  return {
    id: makeId('canvas'),
    title,
    elements: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    background: 'dots',
    theme: 'light',
    sourceFormat: 'fcanvas',
    createdAt: now,
    updatedAt: now,
  };
}

function buildArchitectureTemplate(): CanvasData {
  const now = Date.now();

  const titleEl: CanvasElement = {
    id: makeId('txt'),
    kind: 'text',
    x: 60,
    y: 36,
    width: 460,
    height: 44,
    text: 'Platform System Architecture',
    fontSize: 26,
    fontFamily: 'sans',
    textAlign: 'left',
    stroke: '#0f172a',
    fill: 'transparent',
    opacity: 1,
  };

  const subtitleEl: CanvasElement = {
    id: makeId('txt'),
    kind: 'text',
    x: 60,
    y: 78,
    width: 520,
    height: 28,
    text: 'Edge ingress, stateless services, low-latency cache, and async workers',
    fontSize: 13,
    fontFamily: 'sans',
    textAlign: 'left',
    stroke: '#64748b',
    fill: 'transparent',
    opacity: 1,
  };

  const backendFrame: CanvasElement = {
    id: makeId('frm'),
    kind: 'frame',
    x: 310,
    y: 128,
    width: 790,
    height: 470,
    text: 'Cloud VPC — Core Platform',
    fontSize: 13,
    fontFamily: 'sans',
    textAlign: 'left',
    fill: '#f8fafc',
    stroke: '#cbd5e1',
    strokeWidth: 1.5,
    strokeStyle: 'dashed',
    roughness: 0,
    opacity: 1,
  };

  const clientApps: CanvasElement = {
    id: makeId('node'),
    kind: 'roundRect',
    x: 60,
    y: 290,
    width: 180,
    height: 92,
    text: 'Client Apps\nWeb • macOS • iOS',
    fontSize: 15,
    fontFamily: 'sans',
    textAlign: 'center',
    fill: '#eff6ff',
    stroke: '#2563eb',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 1,
  };

  const apiGateway: CanvasElement = {
    id: makeId('node'),
    kind: 'diamond',
    x: 350,
    y: 280,
    width: 170,
    height: 112,
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

  const authService: CanvasElement = {
    id: makeId('node'),
    kind: 'roundRect',
    x: 605,
    y: 180,
    width: 185,
    height: 84,
    text: 'Auth Service\nOIDC • JWT • RBAC',
    fontSize: 14,
    fontFamily: 'sans',
    textAlign: 'center',
    fill: '#f5f3ff',
    stroke: '#7c3aed',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 1,
  };

  const coreApi: CanvasElement = {
    id: makeId('node'),
    kind: 'roundRect',
    x: 605,
    y: 350,
    width: 185,
    height: 92,
    text: 'Core API\nREST & GraphQL',
    fontSize: 15,
    fontFamily: 'sans',
    textAlign: 'center',
    fill: '#ecfdf5',
    stroke: '#059669',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 1,
  };

  const postgresDb: CanvasElement = {
    id: makeId('node'),
    kind: 'ellipse',
    x: 880,
    y: 172,
    width: 180,
    height: 92,
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

  const redisCache: CanvasElement = {
    id: makeId('node'),
    kind: 'roundRect',
    x: 880,
    y: 318,
    width: 180,
    height: 82,
    text: 'Redis Cache\nSessions & Hot Keys',
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

  const workerQueue: CanvasElement = {
    id: makeId('node'),
    kind: 'rect',
    x: 880,
    y: 454,
    width: 180,
    height: 84,
    text: 'Worker Queue\nAsync Jobs & Emails',
    fontSize: 14,
    fontFamily: 'sans',
    textAlign: 'center',
    fill: '#fff7ed',
    stroke: '#ea580c',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 1,
  };

  const arrows: CanvasElement[] = [
    makeBoundArrow(clientApps, 'right', apiGateway, 'left', {
      text: 'HTTPS',
      stroke: '#2563eb',
    }),
    makeBoundArrow(apiGateway, 'top', authService, 'left', {
      text: 'Verify JWT',
      stroke: '#7c3aed',
    }),
    makeBoundArrow(apiGateway, 'right', coreApi, 'left', {
      text: 'Route',
      stroke: '#0d9488',
    }),
    makeBoundArrow(authService, 'right', postgresDb, 'left', {
      text: 'Users',
      stroke: '#64748b',
      strokeStyle: 'dashed',
    }),
    makeBoundArrow(coreApi, 'top', postgresDb, 'bottom', {
      text: 'SQL R/W',
      stroke: '#ca8a04',
    }),
    makeBoundArrow(coreApi, 'right', redisCache, 'left', {
      text: 'Cache',
      stroke: '#e11d48',
    }),
    makeBoundArrow(coreApi, 'bottom', workerQueue, 'left', {
      text: 'Enqueue',
      stroke: '#ea580c',
    }),
  ];

  return {
    id: makeId('canvas'),
    title: 'System Architecture',
    elements: [
      backendFrame,
      titleEl,
      subtitleEl,
      clientApps,
      apiGateway,
      authService,
      coreApi,
      postgresDb,
      redisCache,
      workerQueue,
      ...arrows,
    ],
    viewport: { x: 20, y: 20, zoom: 0.92 },
    background: 'grid',
    theme: 'light',
    sourceFormat: 'fcanvas',
    createdAt: now,
    updatedAt: now,
  };
}

function buildMindmapTemplate(): CanvasData {
  const now = Date.now();

  const centerNode: CanvasElement = {
    id: makeId('node'),
    kind: 'roundRect',
    x: 470,
    y: 280,
    width: 210,
    height: 100,
    text: 'Product Strategy\nH2 Roadmap',
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

  // Top-left branch: Growth
  const growthBranch: CanvasElement = {
    id: makeId('br'),
    kind: 'roundRect',
    x: 210,
    y: 120,
    width: 170,
    height: 68,
    text: 'Growth & Adoption',
    fontSize: 15,
    fontFamily: 'sans',
    textAlign: 'center',
    fill: '#dbeafe',
    stroke: '#2563eb',
    strokeWidth: 2,
    opacity: 1,
  };

  const growthNote1: CanvasElement = {
    id: makeId('st'),
    kind: 'sticky',
    x: 20,
    y: 40,
    width: 150,
    height: 112,
    text: 'Template gallery\nwith 1-click starters\nfor teams',
    fontSize: 13,
    fontFamily: 'hand',
    textAlign: 'left',
    fill: '#bfdbfe',
    stroke: '#60a5fa',
    strokeWidth: 1.5,
    opacity: 1,
  };

  const growthNote2: CanvasElement = {
    id: makeId('st'),
    kind: 'sticky',
    x: 20,
    y: 178,
    width: 150,
    height: 108,
    text: 'Interactive sharing\nlinks + instant\nSVG/PDF exports',
    fontSize: 13,
    fontFamily: 'hand',
    textAlign: 'left',
    fill: '#fef08a',
    stroke: '#eab308',
    strokeWidth: 1.5,
    opacity: 1,
  };

  // Top-right branch: AI Workflows
  const aiBranch: CanvasElement = {
    id: makeId('br'),
    kind: 'roundRect',
    x: 770,
    y: 120,
    width: 170,
    height: 68,
    text: 'AI Diagramming',
    fontSize: 15,
    fontFamily: 'sans',
    textAlign: 'center',
    fill: '#ccfbf1',
    stroke: '#0d9488',
    strokeWidth: 2,
    opacity: 1,
  };

  const aiNote1: CanvasElement = {
    id: makeId('st'),
    kind: 'sticky',
    x: 990,
    y: 40,
    width: 155,
    height: 112,
    text: 'Mermaid & prompt\nto editable vector\narchitecture flows',
    fontSize: 13,
    fontFamily: 'hand',
    textAlign: 'left',
    fill: '#bbf7d0',
    stroke: '#22c55e',
    strokeWidth: 1.5,
    opacity: 1,
  };

  const aiNote2: CanvasElement = {
    id: makeId('st'),
    kind: 'sticky',
    x: 990,
    y: 178,
    width: 155,
    height: 108,
    text: 'Auto-cluster sticky\nnotes into sprint\nthemes',
    fontSize: 13,
    fontFamily: 'hand',
    textAlign: 'left',
    fill: '#fef08a',
    stroke: '#eab308',
    strokeWidth: 1.5,
    opacity: 1,
  };

  // Bottom-left branch: Platform
  const platformBranch: CanvasElement = {
    id: makeId('br'),
    kind: 'roundRect',
    x: 210,
    y: 470,
    width: 170,
    height: 68,
    text: 'Local-First Core',
    fontSize: 15,
    fontFamily: 'sans',
    textAlign: 'center',
    fill: '#ede9fe',
    stroke: '#7c3aed',
    strokeWidth: 2,
    opacity: 1,
  };

  const platformNote1: CanvasElement = {
    id: makeId('st'),
    kind: 'sticky',
    x: 20,
    y: 445,
    width: 155,
    height: 115,
    text: 'Open .excalidraw &\n.fcanvas files\nwith zero lock-in',
    fontSize: 13,
    fontFamily: 'hand',
    textAlign: 'left',
    fill: '#ddd6fe',
    stroke: '#8b5cf6',
    strokeWidth: 1.5,
    opacity: 1,
  };

  // Bottom-right branch: Enterprise
  const enterpriseBranch: CanvasElement = {
    id: makeId('br'),
    kind: 'roundRect',
    x: 770,
    y: 470,
    width: 170,
    height: 68,
    text: 'Enterprise Ready',
    fontSize: 15,
    fontFamily: 'sans',
    textAlign: 'center',
    fill: '#ffe4e6',
    stroke: '#e11d48',
    strokeWidth: 2,
    opacity: 1,
  };

  const enterpriseNote1: CanvasElement = {
    id: makeId('st'),
    kind: 'sticky',
    x: 990,
    y: 445,
    width: 155,
    height: 115,
    text: 'Offline privacy,\nSSO policies &\nauditable exports',
    fontSize: 13,
    fontFamily: 'hand',
    textAlign: 'left',
    fill: '#fecdd3',
    stroke: '#fb7185',
    strokeWidth: 1.5,
    opacity: 1,
  };

  const arrows: CanvasElement[] = [
    makeBoundArrow(centerNode, 'left', growthBranch, 'bottom', { stroke: '#2563eb' }),
    makeBoundArrow(centerNode, 'right', aiBranch, 'bottom', { stroke: '#0d9488' }),
    makeBoundArrow(centerNode, 'left', platformBranch, 'top', { stroke: '#7c3aed' }),
    makeBoundArrow(centerNode, 'right', enterpriseBranch, 'top', { stroke: '#e11d48' }),
    makeBoundArrow(growthBranch, 'left', growthNote1, 'right', {
      stroke: '#60a5fa',
      strokeStyle: 'dashed',
    }),
    makeBoundArrow(growthBranch, 'left', growthNote2, 'right', {
      stroke: '#60a5fa',
      strokeStyle: 'dashed',
    }),
    makeBoundArrow(aiBranch, 'right', aiNote1, 'left', {
      stroke: '#14b8a6',
      strokeStyle: 'dashed',
    }),
    makeBoundArrow(aiBranch, 'right', aiNote2, 'left', {
      stroke: '#14b8a6',
      strokeStyle: 'dashed',
    }),
    makeBoundArrow(platformBranch, 'left', platformNote1, 'right', {
      stroke: '#8b5cf6',
      strokeStyle: 'dashed',
    }),
    makeBoundArrow(enterpriseBranch, 'right', enterpriseNote1, 'left', {
      stroke: '#fb7185',
      strokeStyle: 'dashed',
    }),
  ];

  return {
    id: makeId('canvas'),
    title: 'Product Strategy Mind Map',
    elements: [
      centerNode,
      growthBranch,
      growthNote1,
      growthNote2,
      aiBranch,
      aiNote1,
      aiNote2,
      platformBranch,
      platformNote1,
      enterpriseBranch,
      enterpriseNote1,
      ...arrows,
    ],
    viewport: { x: 20, y: 20, zoom: 0.9 },
    background: 'dots',
    theme: 'light',
    sourceFormat: 'fcanvas',
    createdAt: now,
    updatedAt: now,
  };
}

function buildKanbanTemplate(): CanvasData {
  const now = Date.now();

  const header: CanvasElement = {
    id: makeId('txt'),
    kind: 'text',
    x: 60,
    y: 36,
    width: 440,
    height: 40,
    text: 'Sprint 14 — Brainstorm & Delivery Board',
    fontSize: 24,
    fontFamily: 'sans',
    textAlign: 'left',
    stroke: '#0f172a',
    fill: 'transparent',
    opacity: 1,
  };

  const colIdeas: CanvasElement = {
    id: makeId('frm'),
    kind: 'frame',
    x: 60,
    y: 100,
    width: 300,
    height: 520,
    text: 'Ideas',
    fontSize: 15,
    fontFamily: 'sans',
    textAlign: 'left',
    fill: '#f8fafc',
    stroke: '#cbd5e1',
    strokeWidth: 1.5,
    strokeStyle: 'solid',
    opacity: 1,
  };

  const colProgress: CanvasElement = {
    id: makeId('frm'),
    kind: 'frame',
    x: 396,
    y: 100,
    width: 300,
    height: 520,
    text: 'In Progress',
    fontSize: 15,
    fontFamily: 'sans',
    textAlign: 'left',
    fill: '#f0fdfa',
    stroke: '#99f6e4',
    strokeWidth: 1.5,
    strokeStyle: 'solid',
    opacity: 1,
  };

  const colShipped: CanvasElement = {
    id: makeId('frm'),
    kind: 'frame',
    x: 732,
    y: 100,
    width: 300,
    height: 520,
    text: 'Shipped',
    fontSize: 15,
    fontFamily: 'sans',
    textAlign: 'left',
    fill: '#f0fdf4',
    stroke: '#bbf7d0',
    strokeWidth: 1.5,
    strokeStyle: 'solid',
    opacity: 1,
  };

  const stickies: CanvasElement[] = [
    // Ideas
    {
      id: makeId('st'),
      kind: 'sticky',
      x: 84,
      y: 136,
      width: 252,
      height: 126,
      text: 'Voice-to-sticky capture\nQuickly dictate ideas during\ndesign critiques',
      fontSize: 14,
      fontFamily: 'hand',
      textAlign: 'left',
      fill: '#fef08a',
      stroke: '#eab308',
      strokeWidth: 1.5,
      opacity: 1,
    },
    {
      id: makeId('st'),
      kind: 'sticky',
      x: 84,
      y: 284,
      width: 252,
      height: 126,
      text: 'Component library\nReusable AWS, K8s, and\nUI wireframe stencils',
      fontSize: 14,
      fontFamily: 'hand',
      textAlign: 'left',
      fill: '#fed7aa',
      stroke: '#f97316',
      strokeWidth: 1.5,
      opacity: 1,
    },
    {
      id: makeId('st'),
      kind: 'sticky',
      x: 84,
      y: 432,
      width: 252,
      height: 120,
      text: 'Presentation frames\nStep through frames like\nslides in fullscreen',
      fontSize: 14,
      fontFamily: 'hand',
      textAlign: 'left',
      fill: '#ddd6fe',
      stroke: '#8b5cf6',
      strokeWidth: 1.5,
      opacity: 1,
    },
    // In Progress
    {
      id: makeId('st'),
      kind: 'sticky',
      x: 420,
      y: 136,
      width: 252,
      height: 130,
      text: 'Smart arrow binding\nSnap arrows to shape\nanchors & auto-follow',
      fontSize: 14,
      fontFamily: 'hand',
      textAlign: 'left',
      fill: '#bfdbfe',
      stroke: '#3b82f6',
      strokeWidth: 1.5,
      opacity: 1,
    },
    {
      id: makeId('st'),
      kind: 'sticky',
      x: 420,
      y: 288,
      width: 252,
      height: 130,
      text: 'Mermaid diagram import\nConvert flowchart syntax\ninto native shapes',
      fontSize: 14,
      fontFamily: 'hand',
      textAlign: 'left',
      fill: '#fef08a',
      stroke: '#eab308',
      strokeWidth: 1.5,
      opacity: 1,
    },
    // Shipped
    {
      id: makeId('st'),
      kind: 'sticky',
      x: 756,
      y: 136,
      width: 252,
      height: 126,
      text: 'Excalidraw v2 codec\nBidirectional import &\nexport with bound labels',
      fontSize: 14,
      fontFamily: 'hand',
      textAlign: 'left',
      fill: '#bbf7d0',
      stroke: '#22c55e',
      strokeWidth: 1.5,
      opacity: 1,
    },
    {
      id: makeId('st'),
      kind: 'sticky',
      x: 756,
      y: 284,
      width: 252,
      height: 126,
      text: 'Vector SVG, 2x PNG &\nPDF export pipeline\nwith sketchy strokes',
      fontSize: 14,
      fontFamily: 'hand',
      textAlign: 'left',
      fill: '#bbf7d0',
      stroke: '#22c55e',
      strokeWidth: 1.5,
      opacity: 1,
    },
    {
      id: makeId('st'),
      kind: 'sticky',
      x: 756,
      y: 432,
      width: 252,
      height: 120,
      text: 'Infinite zoom & pan\nTrackpad gestures + 6px\nalignment snap guides',
      fontSize: 14,
      fontFamily: 'hand',
      textAlign: 'left',
      fill: '#fecdd3',
      stroke: '#f43f5e',
      strokeWidth: 1.5,
      opacity: 1,
    },
  ];

  return {
    id: makeId('canvas'),
    title: 'Brainstorm & Sprint Board',
    elements: [colIdeas, colProgress, colShipped, header, ...stickies],
    viewport: { x: 20, y: 20, zoom: 0.92 },
    background: 'dots',
    theme: 'light',
    sourceFormat: 'fcanvas',
    createdAt: now,
    updatedAt: now,
  };
}

export const CANVAS_TEMPLATES: Array<{
  id: CanvasTemplateId;
  name: string;
  subtitle: string;
}> = [
  {
    id: 'blank',
    name: 'Blank Canvas',
    subtitle: 'Infinite dotted whiteboard for diagrams, sketches & stickies',
  },
  {
    id: 'architecture',
    name: 'System Architecture',
    subtitle: 'Microservices, gateway, Postgres, Redis & bound connectors',
  },
  {
    id: 'mindmap',
    name: 'Product Mindmap',
    subtitle: 'Central strategy hub with color-coded branches & notes',
  },
  {
    id: 'kanban',
    name: 'Sprint & Brainstorm',
    subtitle: 'Ideas, In Progress & Shipped frames with sticky notes',
  },
];

export function createCanvasFromTemplate(templateId: CanvasTemplateId): CanvasData {
  switch (templateId) {
    case 'architecture':
      return buildArchitectureTemplate();
    case 'mindmap':
      return buildMindmapTemplate();
    case 'kanban':
      return buildKanbanTemplate();
    case 'blank':
    default:
      return createBlankCanvas('Untitled Canvas');
  }
}
