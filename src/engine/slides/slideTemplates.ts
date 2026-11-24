import {
  PresentationData,
  SlideData,
  SlideLayoutType,
  SlideThemePreset,
} from '../../types/slides';
import { uid } from '../spreadsheet/workbookOps';

export type SlideTemplateId = 'blank' | 'pitch' | 'qbr' | 'tech';

export interface SlideTemplateMeta {
  id: SlideTemplateId;
  name: string;
  subtitle: string;
}

export const SLIDE_TEMPLATES: SlideTemplateMeta[] = [
  { id: 'blank', name: 'Blank Presentation', subtitle: 'Clean 16:9 title slide ready to design' },
  { id: 'pitch', name: 'Startup Pitch Deck', subtitle: '5-slide narrative: Vision, Problem, Solution, Traction, Ask' },
  { id: 'qbr', name: 'Quarterly Business Review', subtitle: 'KPI callouts, revenue highlights & roadmap' },
  { id: 'tech', name: 'Architecture Review', subtitle: 'System design talk with callout cards & takeaways' },
];

export const SLIDE_THEMES: SlideThemePreset[] = [
  {
    id: 'midnight',
    name: 'Midnight Executive',
    bg: '#0f172a',
    surface: '#1e293b',
    titleColor: '#f8fafc',
    bodyColor: '#cbd5e1',
    accent: '#f59e0b',
  },
  {
    id: 'daylight',
    name: 'Clean Daylight',
    bg: '#ffffff',
    surface: '#f1f5f9',
    titleColor: '#0f172a',
    bodyColor: '#334155',
    accent: '#ea580c',
  },
  {
    id: 'editorial',
    name: 'Warm Editorial',
    bg: '#faf6ee',
    surface: '#efe6d5',
    titleColor: '#292017',
    bodyColor: '#4a3d2e',
    accent: '#b45309',
  },
  {
    id: 'emerald',
    name: 'Emerald Slate',
    bg: '#062c22',
    surface: '#0d4335',
    titleColor: '#ecfdf5',
    bodyColor: '#a7f3d0',
    accent: '#34d399',
  },
  {
    id: 'sapphire',
    name: 'Royal Sapphire',
    bg: '#0c1e3d',
    surface: '#16315e',
    titleColor: '#f8fafc',
    bodyColor: '#bfdbfe',
    accent: '#38bdf8',
  },
  {
    id: 'crimson',
    name: 'Crimson Modern',
    bg: '#1c1218',
    surface: '#2e1c25',
    titleColor: '#fff1f2',
    bodyColor: '#fecdd3',
    accent: '#fb7185',
  },
];

export function getThemeById(themeId: string): SlideThemePreset {
  return SLIDE_THEMES.find((t) => t.id === themeId) ?? SLIDE_THEMES[1];
}

export function createSlideFromLayout(layout: SlideLayoutType, theme: SlideThemePreset): SlideData {
  if (layout === 'blank') {
    return { id: uid('slide'), backgroundColor: theme.bg, elements: [], notes: '' };
  }

  if (layout === 'title') {
    return {
      id: uid('slide'),
      backgroundColor: theme.bg,
      notes: '',
      elements: [
        {
          id: uid('el'),
          kind: 'shape',
          shape: 'rect',
          x: 72,
          y: 168,
          width: 72,
          height: 6,
          fillColor: theme.accent,
        },
        {
          id: uid('el'),
          kind: 'text',
          x: 72,
          y: 192,
          width: 816,
          height: 92,
          text: 'Presentation Title',
          fontSize: 44,
          bold: true,
          color: theme.titleColor,
          align: 'left',
        },
        {
          id: uid('el'),
          kind: 'text',
          x: 72,
          y: 294,
          width: 720,
          height: 54,
          text: 'Click to add subtitle, presenter name, or date',
          fontSize: 20,
          color: theme.bodyColor,
          align: 'left',
        },
      ],
    };
  }

  if (layout === 'twoColumn') {
    return {
      id: uid('slide'),
      backgroundColor: theme.bg,
      notes: '',
      elements: [
        {
          id: uid('el'),
          kind: 'text',
          x: 60,
          y: 42,
          width: 840,
          height: 56,
          text: 'Two-Column Comparison',
          fontSize: 32,
          bold: true,
          color: theme.titleColor,
        },
        {
          id: uid('el'),
          kind: 'shape',
          shape: 'roundRect',
          x: 60,
          y: 120,
          width: 404,
          height: 356,
          fillColor: theme.surface,
        },
        {
          id: uid('el'),
          kind: 'text',
          x: 84,
          y: 144,
          width: 356,
          height: 308,
          text: 'Left Column\n\n• Key point one\n• Key point two\n• Supporting evidence',
          fontSize: 18,
          color: theme.bodyColor,
        },
        {
          id: uid('el'),
          kind: 'shape',
          shape: 'roundRect',
          x: 496,
          y: 120,
          width: 404,
          height: 356,
          fillColor: theme.surface,
        },
        {
          id: uid('el'),
          kind: 'text',
          x: 520,
          y: 144,
          width: 356,
          height: 308,
          text: 'Right Column\n\n• Tradeoff or alternative\n• Key benchmark\n• Next milestone',
          fontSize: 18,
          color: theme.bodyColor,
        },
      ],
    };
  }

  if (layout === 'metric') {
    return {
      id: uid('slide'),
      backgroundColor: theme.bg,
      notes: '',
      elements: [
        {
          id: uid('el'),
          kind: 'text',
          x: 60,
          y: 42,
          width: 840,
          height: 54,
          text: 'Key Metrics Snapshot',
          fontSize: 32,
          bold: true,
          color: theme.titleColor,
        },
        ...[0, 1, 2].flatMap((idx) => {
          const x = 60 + idx * 290;
          const vals = ['$1.43M', '32.5%', '118%'];
          const labels = ['FY2026 Revenue', 'Operating Margin', 'Net Dollar Retention'];
          return [
            {
              id: uid('el'),
              kind: 'shape' as const,
              shape: 'roundRect' as const,
              x,
              y: 150,
              width: 262,
              height: 230,
              fillColor: theme.surface,
            },
            {
              id: uid('el'),
              kind: 'text' as const,
              x: x + 20,
              y: 200,
              width: 222,
              height: 70,
              text: vals[idx],
              fontSize: 44,
              bold: true,
              color: theme.accent,
              align: 'center' as const,
            },
            {
              id: uid('el'),
              kind: 'text' as const,
              x: x + 20,
              y: 282,
              width: 222,
              height: 50,
              text: labels[idx],
              fontSize: 16,
              color: theme.bodyColor,
              align: 'center' as const,
            },
          ];
        }),
      ],
    };
  }

  // Default: 'content'
  return {
    id: uid('slide'),
    backgroundColor: theme.bg,
    notes: '',
    elements: [
      {
        id: uid('el'),
        kind: 'text',
        x: 64,
        y: 46,
        width: 832,
        height: 56,
        text: 'Slide Heading',
        fontSize: 32,
        bold: true,
        color: theme.titleColor,
      },
      {
        id: uid('el'),
        kind: 'shape',
        shape: 'rect',
        x: 64,
        y: 108,
        width: 832,
        height: 2,
        fillColor: theme.accent,
      },
      {
        id: uid('el'),
        kind: 'text',
        x: 64,
        y: 136,
        width: 832,
        height: 340,
        text: '• First core takeaway\n• Second supporting point with data\n• Clear decision or next step',
        fontSize: 21,
        color: theme.bodyColor,
      },
    ],
  };
}

export function createBlankPresentation(title = 'Untitled Presentation'): PresentationData {
  const theme = getThemeById('daylight');
  const now = Date.now();
  return {
    id: uid('deck'),
    title,
    themeId: theme.id,
    slides: [createSlideFromLayout('title', theme)],
    createdAt: now,
    updatedAt: now,
  };
}

function createPitchDeck(): PresentationData {
  const theme = getThemeById('midnight');
  const now = Date.now();
  return {
    id: uid('deck'),
    title: 'Startup Pitch Deck',
    themeId: theme.id,
    createdAt: now,
    updatedAt: now,
    slides: [
      {
        id: uid('slide'),
        backgroundColor: theme.bg,
        notes: 'Introduce the company vision in one crisp sentence.',
        elements: [
          { id: uid('el'), kind: 'shape', shape: 'rect', x: 72, y: 150, width: 84, height: 6, fillColor: theme.accent },
          { id: uid('el'), kind: 'text', x: 72, y: 174, width: 816, height: 96, text: 'Forma Office', fontSize: 52, bold: true, color: theme.titleColor },
          { id: uid('el'), kind: 'text', x: 72, y: 274, width: 760, height: 68, text: 'Local-First, Open-Format Productivity Suite for Modern Teams', fontSize: 22, color: theme.bodyColor },
          { id: uid('el'), kind: 'text', x: 72, y: 454, width: 400, height: 32, text: 'Seed Presentation · 2026', fontSize: 14, color: theme.accent, bold: true },
        ],
      },
      {
        id: uid('slide'),
        backgroundColor: theme.bg,
        notes: 'Highlight vendor lock-in and cloud latency pain points.',
        elements: [
          { id: uid('el'), kind: 'text', x: 64, y: 46, width: 832, height: 54, text: 'The Problem', fontSize: 34, bold: true, color: theme.titleColor },
          { id: uid('el'), kind: 'shape', shape: 'roundRect', x: 64, y: 132, width: 832, height: 332, fillColor: theme.surface },
          {
            id: uid('el'),
            kind: 'text',
            x: 96,
            y: 164,
            width: 768,
            height: 268,
            text: '• Legacy office suites bundle 10+ GB of bloat and expensive subscriptions\n\n• Cloud-only tools create privacy exposure and fail offline\n\n• Proprietary file extensions break interoperability across workflows',
            fontSize: 21,
            color: theme.bodyColor,
          },
        ],
      },
      {
        id: uid('slide'),
        backgroundColor: theme.bg,
        notes: 'Walk through the four native apps and open standards.',
        elements: [
          { id: uid('el'), kind: 'text', x: 64, y: 46, width: 832, height: 54, text: 'Our Solution: Native Open-Format Suite', fontSize: 32, bold: true, color: theme.titleColor },
          ...[
            { title: 'Sheets', desc: '.xlsx · .ods · .csv\n55+ Excel formulas', color: '#10b981' },
            { title: 'Docs', desc: '.docx · .odt · .md\nPaginated WYSIWYG', color: '#3b82f6' },
            { title: 'Slides', desc: '.pptx · .odp · .pdf\nWidescreen decks', color: '#f59e0b' },
            { title: 'PDF', desc: 'ISO 32000 .pdf\nAnnotate, Sign, Merge', color: '#f43f5e' },
          ].flatMap((card, idx) => {
            const x = 64 + idx * 212;
            return [
              { id: uid('el'), kind: 'shape' as const, shape: 'roundRect' as const, x, y: 150, width: 194, height: 260, fillColor: theme.surface },
              { id: uid('el'), kind: 'shape' as const, shape: 'rect' as const, x, y: 150, width: 194, height: 8, fillColor: card.color },
              { id: uid('el'), kind: 'text' as const, x: x + 16, y: 186, width: 162, height: 42, text: card.title, fontSize: 24, bold: true, color: theme.titleColor },
              { id: uid('el'), kind: 'text' as const, x: x + 16, y: 244, width: 162, height: 130, text: card.desc, fontSize: 15, color: theme.bodyColor },
            ];
          }),
        ],
      },
      createSlideFromLayout('metric', theme),
      {
        id: uid('slide'),
        backgroundColor: theme.bg,
        notes: 'Close with clear next steps and Q&A.',
        elements: [
          { id: uid('el'), kind: 'text', x: 80, y: 190, width: 800, height: 84, text: 'Thank You — Questions?', fontSize: 46, bold: true, color: theme.titleColor, align: 'center' },
          { id: uid('el'), kind: 'text', x: 160, y: 294, width: 640, height: 48, text: 'Export this deck anytime as .pptx, .odp, or .pdf', fontSize: 19, color: theme.accent, align: 'center' },
        ],
      },
    ],
  };
}

function createQbrDeck(): PresentationData {
  const theme = getThemeById('daylight');
  const now = Date.now();
  return {
    id: uid('deck'),
    title: 'Q4 Business Review',
    themeId: theme.id,
    createdAt: now,
    updatedAt: now,
    slides: [
      {
        ...createSlideFromLayout('title', theme),
        elements: [
          { id: uid('el'), kind: 'shape', shape: 'rect', x: 72, y: 168, width: 72, height: 6, fillColor: theme.accent },
          { id: uid('el'), kind: 'text', x: 72, y: 192, width: 816, height: 92, text: 'Q4 2026 Business Review', fontSize: 44, bold: true, color: theme.titleColor },
          { id: uid('el'), kind: 'text', x: 72, y: 294, width: 720, height: 54, text: 'Performance, Key Wins & FY2027 Priorities', fontSize: 20, color: theme.bodyColor },
        ],
      },
      createSlideFromLayout('metric', theme),
      createSlideFromLayout('twoColumn', theme),
    ],
  };
}

function createTechTalkDeck(): PresentationData {
  const theme = getThemeById('sapphire');
  const now = Date.now();
  return {
    id: uid('deck'),
    title: 'Architecture Review',
    themeId: theme.id,
    createdAt: now,
    updatedAt: now,
    slides: [
      {
        ...createSlideFromLayout('title', theme),
        elements: [
          { id: uid('el'), kind: 'shape', shape: 'rect', x: 72, y: 168, width: 72, height: 6, fillColor: theme.accent },
          { id: uid('el'), kind: 'text', x: 72, y: 192, width: 816, height: 92, text: 'System Architecture Review', fontSize: 44, bold: true, color: theme.titleColor },
          { id: uid('el'), kind: 'text', x: 72, y: 294, width: 720, height: 54, text: 'Design Goals, Tradeoffs & Scaling Plan', fontSize: 20, color: theme.bodyColor },
        ],
      },
      createSlideFromLayout('content', theme),
      createSlideFromLayout('twoColumn', theme),
    ],
  };
}

export function createPresentationFromTemplate(templateId: SlideTemplateId): PresentationData {
  switch (templateId) {
    case 'pitch':
      return createPitchDeck();
    case 'qbr':
      return createQbrDeck();
    case 'tech':
      return createTechTalkDeck();
    case 'blank':
    default:
      return createBlankPresentation();
  }
}
