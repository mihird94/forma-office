import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  GripHorizontal,
  Pause,
  PenTool,
  Play,
  RefreshCw,
  RotateCcw,
  StickyNote,
  X,
} from 'lucide-react';
import {
  PresentationData,
  SLIDE_H,
  SLIDE_W,
  ShapeVariant,
  SlideData,
  SlideElement,
  SlideLayoutType,
  SlideThemePreset,
} from '../../types/slides';
import { createSlideFromLayout, getThemeById } from '../../engine/slides/slideTemplates';
import { exportPresentationToPptx } from '../../engine/slides/formats/pptxCodec';
import { exportPresentationToOdp } from '../../engine/slides/formats/odpCodec';
import { exportPresentationToPdf } from '../../engine/slides/formats/slidePdfCodec';
import { uid } from '../../engine/spreadsheet/workbookOps';
import { triggerFileDownload, wasNativeSaveCancelled } from '../../storage/workspaceStore';
import { SlideElementAlignMode, SlidesRibbon } from './SlidesRibbon';
import { ContextMenu, ContextMenuItem } from '../common/ContextMenu';
import { ZoomControl } from '../common/ZoomControl';
import { useAppZoom } from '../../utils/useAppZoom';
import { loadFilePosition, saveFilePosition } from '../../storage/sessionStore';

interface SnapGuide {
  axis: 'x' | 'y';
  pos: number;
  kind: 'center' | 'edge';
}

function formatTableSearchText(rows: string[][]): string {
  return rows.map((r) => r.join('  |  ')).join('\n');
}

function deckToMarkdown(deck: PresentationData): string {
  return deck.slides
    .map((slide) => {
      const blocks: string[] = [];
      const sorted = [...slide.elements].sort((a, b) => a.y - b.y || a.x - b.x);
      let emittedTitle = false;
      for (const el of sorted) {
        if (el.kind === 'table' && el.tableData && el.tableData.length > 0) {
          const cols = Math.max(1, ...el.tableData.map((r) => r.length));
          const header = el.tableData[0] ?? [];
          const headerLine = `| ${Array.from({ length: cols }, (_, i) => header[i] ?? '').join(' | ')} |`;
          const sepLine = `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`;
          const bodyLines = el.tableData
            .slice(1)
            .map((r) => `| ${Array.from({ length: cols }, (_, i) => r[i] ?? '').join(' | ')} |`);
          blocks.push([headerLine, sepLine, ...bodyLines].join('\n'));
        } else if (el.kind === 'text' && el.text?.trim()) {
          const raw = el.text.trim();
          if (!emittedTitle && ((el.fontSize ?? 20) >= 30 || el.bold)) {
            emittedTitle = true;
            blocks.push(`# ${raw.replace(/\n+/g, ' ')}`);
          } else {
            const lines = raw.split('\n').map((ln) => {
              const t = ln.trim();
              if (t.startsWith('• ')) return `- ${t.slice(2)}`;
              if (t.startsWith('· ')) return `- ${t.slice(2)}`;
              return t;
            });
            blocks.push(lines.join('\n'));
          }
        }
      }
      if (slide.notes?.trim()) {
        blocks.push(`Notes: ${slide.notes.trim()}`);
      }
      return blocks.join('\n\n');
    })
    .join('\n\n---\n\n');
}

function markdownToSlides(md: string, theme: SlideThemePreset): SlideData[] {
  const sections = md.split(/^\s*---\s*$/m);
  const slides: SlideData[] = [];

  for (const rawSection of sections) {
    const lines = rawSection.replace(/\r\n/g, '\n').split('\n');
    let titleText = '';
    let subtitleText = '';
    const bullets: string[] = [];
    const paragraphs: string[] = [];
    const tableRows: string[][] = [];
    const noteLines: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/^notes\s*:/i.test(line)) {
        noteLines.push(line.replace(/^notes\s*:/i, '').trim());
      } else if (/^<!--\s*notes\s*:([\s\S]*?)-->$/i.test(line)) {
        const m = /^<!--\s*notes\s*:([\s\S]*?)-->$/i.exec(line);
        if (m) noteLines.push(m[1].trim());
      } else if (line.startsWith('# ')) {
        const heading = line.slice(2).trim();
        if (!titleText) titleText = heading;
        else paragraphs.push(heading);
      } else if (line.startsWith('## ')) {
        const sub = line.slice(3).trim();
        if (!subtitleText) subtitleText = sub;
        else paragraphs.push(sub);
      } else if (/^[-*+]\s+/.test(line)) {
        bullets.push(`• ${line.replace(/^[-*+]\s+/, '').trim()}`);
      } else if (line.startsWith('|') && line.endsWith('|')) {
        const cells = line
          .slice(1, -1)
          .split('|')
          .map((c) => c.trim());
        const isSeparator = cells.every((c) => /^:?-{2,}:?$/.test(c));
        if (!isSeparator && cells.length > 0) {
          tableRows.push(cells);
        }
      } else {
        paragraphs.push(line);
      }
    }

    const elements: SlideElement[] = [];
    const isTitleOnly =
      Boolean(titleText) && bullets.length === 0 && paragraphs.length === 0 && tableRows.length === 0;

    if (isTitleOnly) {
      elements.push({
        id: uid('el'),
        kind: 'shape',
        shape: 'rect',
        x: 80,
        y: 170,
        width: 72,
        height: 6,
        fillColor: theme.accent,
      });
      elements.push({
        id: uid('el'),
        kind: 'text',
        x: 80,
        y: 196,
        width: 800,
        height: 92,
        text: titleText,
        fontSize: 44,
        bold: true,
        color: theme.titleColor,
        align: 'left',
      });
      if (subtitleText) {
        elements.push({
          id: uid('el'),
          kind: 'text',
          x: 80,
          y: 296,
          width: 760,
          height: 64,
          text: subtitleText,
          fontSize: 22,
          color: theme.bodyColor,
          align: 'left',
        });
      }
    } else {
      let cursorY = 48;
      if (titleText) {
        elements.push({
          id: uid('el'),
          kind: 'text',
          x: 64,
          y: cursorY,
          width: 832,
          height: 60,
          text: titleText,
          fontSize: 34,
          bold: true,
          color: theme.titleColor,
          align: 'left',
        });
        cursorY += 72;
      }
      if (subtitleText) {
        elements.push({
          id: uid('el'),
          kind: 'text',
          x: 64,
          y: cursorY,
          width: 832,
          height: 40,
          text: subtitleText,
          fontSize: 20,
          color: theme.bodyColor,
          align: 'left',
        });
        cursorY += 46;
      }
      const bodyLines = [...bullets, ...paragraphs];
      if (bodyLines.length > 0) {
        const bodyH = tableRows.length > 0 ? Math.min(180, Math.max(90, bodyLines.length * 34)) : 340;
        elements.push({
          id: uid('el'),
          kind: 'text',
          x: 64,
          y: cursorY,
          width: 832,
          height: Math.min(SLIDE_H - cursorY - 24, bodyH),
          text: bodyLines.join('\n'),
          fontSize: 20,
          color: theme.bodyColor,
          align: 'left',
        });
        cursorY += bodyH + 16;
      }
      if (tableRows.length > 0) {
        const tblH = Math.min(SLIDE_H - cursorY - 24, Math.max(120, tableRows.length * 42));
        elements.push({
          id: uid('el'),
          kind: 'table',
          x: 64,
          y: Math.min(cursorY, SLIDE_H - 150),
          width: 832,
          height: Math.max(110, tblH),
          tableData: tableRows,
          headerRow: true,
          text: formatTableSearchText(tableRows),
          fontSize: 14,
          color: theme.titleColor,
          fillColor: theme.accent,
          borderColor: '#cbd5e1',
        });
      }
    }

    slides.push({
      id: uid('slide'),
      backgroundColor: theme.bg,
      elements,
      notes: noteLines.join('\n'),
    });
  }

  return slides.length > 0
    ? slides
    : [{ id: uid('slide'), backgroundColor: theme.bg, elements: [], notes: '' }];
}

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

interface SlidesAppProps {
  deck: PresentationData;
  onChangeDeck: (updated: PresentationData) => void;
  onImportDeckFile: (file: File) => void;
  onRefreshLinkedCanvas?: (canvasId: string) => { src: string; title: string } | null;
  onNotify: (msg: string) => void;
}

/** Pure presentational slide renderer (reused for thumbnails, stage, and full-screen presentation) */
const StaticSlideView: React.FC<{ slide: SlideData; scale: number }> = ({ slide, scale }) => (
  <div
    style={{
      width: SLIDE_W * scale,
      height: SLIDE_H * scale,
      backgroundColor: slide.backgroundColor || '#ffffff',
    }}
    className="relative overflow-hidden select-none"
  >
    <div
      style={{
        width: SLIDE_W,
        height: SLIDE_H,
        transform: `scale(${scale})`,
        transformOrigin: 'top left',
      }}
      className="relative"
    >
      {slide.elements.map((el) => {
        if (el.kind === 'shape') {
          return (
            <div
              key={el.id}
              style={{
                left: el.x,
                top: el.y,
                width: el.width,
                height: el.height,
                backgroundColor: el.fillColor || '#e2e8f0',
                border: el.borderColor ? `${el.borderWidth ?? 1}px solid ${el.borderColor}` : undefined,
                borderRadius:
                  el.shape === 'ellipse' ? '9999px' : el.shape === 'roundRect' ? '14px' : '2px',
                color: el.color || '#0f172a',
                fontSize: el.fontSize ?? 18,
                fontWeight: el.bold ? 700 : 400,
                fontStyle: el.italic ? 'italic' : 'normal',
                textAlign: el.align ?? 'center',
              }}
              className="absolute flex items-center justify-center p-2 overflow-hidden whitespace-pre-wrap"
            >
              {el.text}
            </div>
          );
        }
        if (el.kind === 'image' && el.src) {
          return (
            <img
              key={el.id}
              src={el.src}
              alt=""
              style={{ left: el.x, top: el.y, width: el.width, height: el.height }}
              className="absolute object-contain pointer-events-none"
            />
          );
        }
        if (el.kind === 'table' && el.tableData && el.tableData.length > 0) {
          const hasHeader = el.headerRow ?? true;
          const headerBg = el.fillColor || '#1e293b';
          const borderColor = el.borderColor || '#cbd5e1';
          const colCount = Math.max(1, ...el.tableData.map((r) => r.length));
          return (
            <div
              key={el.id}
              style={{ left: el.x, top: el.y, width: el.width, height: el.height }}
              className="absolute overflow-hidden rounded-xs"
            >
              <table
                className="w-full h-full border-collapse table-fixed"
                style={{
                  fontSize: el.fontSize ?? 14,
                  fontFamily: el.fontFamily ?? 'Inter, sans-serif',
                  textAlign: el.align ?? 'left',
                }}
              >
                <tbody>
                  {el.tableData.map((row, rIdx) => {
                    const isHeader = hasHeader && rIdx === 0;
                    return (
                      <tr
                        key={rIdx}
                        style={{
                          backgroundColor: isHeader
                            ? headerBg
                            : rIdx % 2 === 0
                              ? '#f8fafc'
                              : '#ffffff',
                          color: isHeader ? '#ffffff' : el.color ?? '#0f172a',
                          fontWeight: isHeader || el.bold ? 700 : 400,
                          fontStyle: el.italic ? 'italic' : 'normal',
                        }}
                      >
                        {Array.from({ length: colCount }, (_, cIdx) => (
                          <td
                            key={cIdx}
                            style={{ border: `1px solid ${borderColor}` }}
                            className="px-2 py-1 truncate"
                          >
                            {row[cIdx] ?? ''}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        }
        return (
          <div
            key={el.id}
            style={{
              left: el.x,
              top: el.y,
              width: el.width,
              height: el.height,
              fontSize: el.fontSize ?? 20,
              fontFamily: el.fontFamily ?? 'Inter, sans-serif',
              fontWeight: el.bold ? 700 : 400,
              fontStyle: el.italic ? 'italic' : 'normal',
              textDecoration: el.underline ? 'underline' : undefined,
              color: el.color ?? '#0f172a',
              textAlign: el.align ?? 'left',
              backgroundColor: el.fillColor,
            }}
            className="absolute leading-snug whitespace-pre-wrap break-words p-1"
          >
            {el.text}
          </div>
        );
      })}
    </div>
  </div>
);

export const SlidesApp: React.FC<SlidesAppProps> = ({
  deck,
  onChangeDeck,
  onImportDeckFile,
  onRefreshLinkedCanvas,
  onNotify,
}) => {
  const [activeSlideIdx, setActiveSlideIdx] = useState(() => {
    const saved = loadFilePosition(deck.id)?.slideIndex ?? 0;
    return Math.max(0, Math.min(deck.slides.length - 1, saved));
  });
  const [selectedElIds, setSelectedElIds] = useState<string[]>([]);
  const [editingElId, setEditingElId] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(true);
  const [presenting, setPresenting] = useState(false);
  const [showPresenterNotes, setShowPresenterNotes] = useState(true);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [timerPaused, setTimerPaused] = useState(false);

  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
  const [showMarkdownDrawer, setShowMarkdownDrawer] = useState(false);
  const [markdownDraft, setMarkdownDraft] = useState('');
  const mdSnapshotTakenRef = useRef(false);

  const [past, setPast] = useState<PresentationData[]>([]);
  const [future, setFuture] = useState<PresentationData[]>([]);

  const [thumbMenu, setThumbMenu] = useState<{ x: number; y: number; idx: number } | null>(null);
  const [stageMenu, setStageMenu] = useState<{
    x: number;
    y: number;
    elId: string | null;
  } | null>(null);

  const stageContainerRef = useRef<HTMLDivElement>(null);
  const [fitScale, setFitScale] = useState(0.85);
  const { zoom, zoomIn, zoomOut, zoomReset } = useAppZoom({
    initial: 1.0,
    min: 0.5,
    max: 2.0,
    step: 0.1,
  });
  const stageScale = fitScale * zoom;
  const [presentScale, setPresentScale] = useState(1);

  const setSelectedElId = useCallback((id: string | null) => {
    setSelectedElIds(id ? [id] : []);
  }, []);

  const primarySelectedId = selectedElIds[selectedElIds.length - 1] ?? null;

  // Reset history & restore saved slide index when switching decks
  const prevDeckId = useRef(deck.id);
  useEffect(() => {
    if (prevDeckId.current !== deck.id) {
      prevDeckId.current = deck.id;
      setPast([]);
      setFuture([]);
      const saved = loadFilePosition(deck.id)?.slideIndex ?? 0;
      setActiveSlideIdx(Math.max(0, Math.min(deck.slides.length - 1, saved)));
      setSelectedElIds([]);
      setEditingElId(null);
      if (showMarkdownDrawer) {
        setMarkdownDraft(deckToMarkdown(deck));
      }
    }
  }, [deck, showMarkdownDrawer]);

  useEffect(() => {
    saveFilePosition(deck.id, { slideIndex: activeSlideIdx });
  }, [deck.id, activeSlideIdx]);

  // Presenter elapsed timer
  useEffect(() => {
    if (!presenting) {
      setElapsedSec(0);
      setTimerPaused(false);
      return;
    }
    if (timerPaused) return;
    const id = window.setInterval(() => {
      setElapsedSec((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, [presenting, timerPaused]);

  // Responsive 16:9 stage scaling
  useEffect(() => {
    const updateScale = () => {
      const container = stageContainerRef.current;
      if (container) {
        const availW = container.clientWidth - 64;
        const availH = container.clientHeight - 48;
        const sc = Math.max(0.35, Math.min(1.25, availW / SLIDE_W, availH / SLIDE_H));
        setFitScale(sc);
      }
      const pAvailW = showPresenterNotes ? Math.max(360, window.innerWidth - 360) : window.innerWidth - 48;
      const pAvailH = window.innerHeight - 96;
      setPresentScale(Math.max(0.3, Math.min(pAvailW / SLIDE_W, pAvailH / SLIDE_H)));
    };
    updateScale();
    window.addEventListener('resize', updateScale);
    const obs = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateScale) : null;
    if (obs && stageContainerRef.current) obs.observe(stageContainerRef.current);
    return () => {
      window.removeEventListener('resize', updateScale);
      obs?.disconnect();
    };
  }, [showNotes, showMarkdownDrawer, showPresenterNotes, presenting]);

  const safeIdx = Math.max(0, Math.min(deck.slides.length - 1, activeSlideIdx));
  const activeSlide = deck.slides[safeIdx] ?? deck.slides[0];
  const selectedElement = useMemo(
    () => activeSlide.elements.find((e) => e.id === primarySelectedId) ?? null,
    [activeSlide, primarySelectedId]
  );

  const linkedCanvasesOnSlide = useMemo(() => {
    const seen = new Set<string>();
    const items: Array<{ canvasId: string; title: string }> = [];
    for (const el of activeSlide.elements) {
      if (el.kind === 'image' && el.linkedCanvasId && !seen.has(el.linkedCanvasId)) {
        seen.add(el.linkedCanvasId);
        items.push({
          canvasId: el.linkedCanvasId,
          title: el.linkedCanvasTitle || 'Forma Canvas',
        });
      }
    }
    return items;
  }, [activeSlide.elements]);

  const commitDeck = useCallback(
    (next: PresentationData, recordHistory = true) => {
      if (recordHistory) {
        setPast((p) => [...p.slice(-39), deck]);
        setFuture([]);
      }
      onChangeDeck({ ...next, updatedAt: Date.now() });
    },
    [deck, onChangeDeck]
  );

  const updateActiveSlide = useCallback(
    (updater: (s: SlideData) => SlideData, recordHistory = true) => {
      const nextSlides = deck.slides.map((s, i) => (i === safeIdx ? updater(s) : s));
      commitDeck({ ...deck, slides: nextSlides }, recordHistory);
    },
    [deck, safeIdx, commitDeck]
  );

  const handleUndo = useCallback(() => {
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    setPast((p) => p.slice(0, -1));
    setFuture((f) => [deck, ...f.slice(0, 39)]);
    onChangeDeck(prev);
    if (showMarkdownDrawer) setMarkdownDraft(deckToMarkdown(prev));
  }, [past, deck, onChangeDeck, showMarkdownDrawer]);

  const handleRedo = useCallback(() => {
    if (future.length === 0) return;
    const next = future[0];
    setFuture((f) => f.slice(1));
    setPast((p) => [...p.slice(-39), deck]);
    onChangeDeck(next);
    if (showMarkdownDrawer) setMarkdownDraft(deckToMarkdown(next));
  }, [future, deck, onChangeDeck, showMarkdownDrawer]);

  const handleUpdateElement = useCallback(
    (elId: string, patch: Partial<SlideElement>, recordHistory = true) => {
      updateActiveSlide(
        (s) => ({
          ...s,
          elements: s.elements.map((el) => (el.id === elId ? { ...el, ...patch } : el)),
        }),
        recordHistory
      );
    },
    [updateActiveSlide]
  );

  const handleUpdateSelected = useCallback(
    (patch: Partial<SlideElement>, recordHistory = true) => {
      if (selectedElIds.length === 0) return;
      const idSet = new Set(selectedElIds);
      updateActiveSlide(
        (s) => ({
          ...s,
          elements: s.elements.map((el) => (idSet.has(el.id) ? { ...el, ...patch } : el)),
        }),
        recordHistory
      );
    },
    [selectedElIds, updateActiveSlide]
  );

  const handleAlignElements = useCallback(
    (mode: SlideElementAlignMode) => {
      if (selectedElIds.length === 0) return;
      const idSet = new Set(selectedElIds);
      const targets = activeSlide.elements.filter((el) => idSet.has(el.id));
      if (targets.length === 0) return;

      const isMulti = targets.length >= 2;
      const minX = isMulti ? Math.min(...targets.map((e) => e.x)) : 0;
      const maxX = isMulti ? Math.max(...targets.map((e) => e.x + e.width)) : SLIDE_W;
      const minY = isMulti ? Math.min(...targets.map((e) => e.y)) : 0;
      const maxY = isMulti ? Math.max(...targets.map((e) => e.y + e.height)) : SLIDE_H;
      const midX = (minX + maxX) / 2;
      const midY = (minY + maxY) / 2;

      updateActiveSlide((s) => ({
        ...s,
        elements: s.elements.map((el) => {
          if (!idSet.has(el.id)) return el;
          if (mode === 'left') return { ...el, x: Math.round(minX) };
          if (mode === 'center') return { ...el, x: Math.round(midX - el.width / 2) };
          if (mode === 'right') return { ...el, x: Math.round(maxX - el.width) };
          if (mode === 'top') return { ...el, y: Math.round(minY) };
          return { ...el, y: Math.round(midY - el.height / 2) };
        }),
      }));
    },
    [selectedElIds, activeSlide.elements, updateActiveSlide]
  );

  const handleDuplicateSelected = useCallback(() => {
    if (selectedElIds.length === 0) return;
    const idSet = new Set(selectedElIds);
    const copies: SlideElement[] = activeSlide.elements
      .filter((e) => idSet.has(e.id))
      .map((el) => ({
        ...el,
        tableData: el.tableData ? el.tableData.map((r) => [...r]) : undefined,
        id: uid('el'),
        x: Math.min(SLIDE_W - 60, el.x + 24),
        y: Math.min(SLIDE_H - 40, el.y + 24),
      }));
    if (copies.length === 0) return;
    updateActiveSlide((s) => ({ ...s, elements: [...s.elements, ...copies] }));
    setSelectedElIds(copies.map((c) => c.id));
  }, [selectedElIds, activeSlide.elements, updateActiveSlide]);

  const handleDeleteSelected = useCallback(() => {
    if (selectedElIds.length === 0) return;
    const idSet = new Set(selectedElIds);
    updateActiveSlide((s) => ({ ...s, elements: s.elements.filter((e) => !idSet.has(e.id)) }));
    setSelectedElIds([]);
    setEditingElId(null);
  }, [selectedElIds, updateActiveSlide]);

  // Table cell & row/col mutations
  const updateTableData = useCallback(
    (elId: string, updater: (rows: string[][]) => string[][], recordHistory = true) => {
      updateActiveSlide(
        (s) => ({
          ...s,
          elements: s.elements.map((el) => {
            if (el.id !== elId || el.kind !== 'table') return el;
            const current = el.tableData && el.tableData.length > 0 ? el.tableData : [['', '']];
            const nextRows = updater(current.map((r) => [...r]));
            return {
              ...el,
              tableData: nextRows,
              text: formatTableSearchText(nextRows),
            };
          }),
        }),
        recordHistory
      );
    },
    [updateActiveSlide]
  );

  // Keyboard shortcuts for editor & full-screen Presentation Mode
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (presenting) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setPresenting(false);
        } else if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
          e.preventDefault();
          setActiveSlideIdx((i) => Math.min(deck.slides.length - 1, i + 1));
        } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
          e.preventDefault();
          setActiveSlideIdx((i) => Math.max(0, i - 1));
        } else if (e.key.toLowerCase() === 'n') {
          e.preventDefault();
          setShowPresenterNotes((v) => !v);
        }
        return;
      }

      const target = e.target as HTMLElement | null;
      const inInput = target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT';
      const meta = e.metaKey || e.ctrlKey;

      if (meta && e.key.toLowerCase() === 'z' && !inInput) {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      } else if (meta && e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setPresenting(true);
      } else if (meta && e.key.toLowerCase() === 'd' && selectedElIds.length > 0 && !inInput) {
        e.preventDefault();
        handleDuplicateSelected();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedElIds.length > 0 && !inInput) {
        e.preventDefault();
        handleDeleteSelected();
      } else if (
        selectedElIds.length > 0 &&
        !inInput &&
        (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      ) {
        e.preventDefault();
        const step = e.shiftKey ? 12 : 2;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        const idSet = new Set(selectedElIds);
        updateActiveSlide((s) => ({
          ...s,
          elements: s.elements.map((el) =>
            idSet.has(el.id)
              ? {
                  ...el,
                  x: Math.round(Math.max(-el.width + 40, Math.min(SLIDE_W - 40, el.x + dx))),
                  y: Math.round(Math.max(-el.height + 24, Math.min(SLIDE_H - 24, el.y + dy))),
                }
              : el
          ),
        }));
      } else if (e.key === 'Escape') {
        setEditingElId(null);
        setSelectedElIds([]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    presenting,
    deck.slides.length,
    selectedElIds,
    handleUndo,
    handleRedo,
    handleDuplicateSelected,
    handleDeleteSelected,
    updateActiveSlide,
  ]);

  // Drag-to-move element(s) on the 16:9 canvas with Smart Alignment Snap Guides (6px threshold)
  const startDragElement = (e: React.MouseEvent, el: SlideElement) => {
    if (e.button !== 0 || editingElId === el.id) return;
    e.stopPropagation();

    let nextIds: string[];
    if (e.shiftKey) {
      if (selectedElIds.includes(el.id)) {
        nextIds = selectedElIds.filter((id) => id !== el.id);
        setSelectedElIds(nextIds);
        return;
      } else {
        nextIds = [...selectedElIds, el.id];
        setSelectedElIds(nextIds);
      }
    } else if (selectedElIds.includes(el.id) && selectedElIds.length > 1) {
      nextIds = selectedElIds;
    } else {
      nextIds = [el.id];
      setSelectedElIds(nextIds);
    }

    const movingIdSet = new Set(nextIds);
    const movingOrig = activeSlide.elements
      .filter((item) => movingIdSet.has(item.id))
      .map((item) => ({ id: item.id, x: item.x, y: item.y, width: item.width, height: item.height }));
    if (movingOrig.length === 0) return;

    const groupMinX = Math.min(...movingOrig.map((m) => m.x));
    const groupMaxX = Math.max(...movingOrig.map((m) => m.x + m.width));
    const groupMinY = Math.min(...movingOrig.map((m) => m.y));
    const groupMaxY = Math.max(...movingOrig.map((m) => m.y + m.height));
    const groupW = groupMaxX - groupMinX;
    const groupH = groupMaxY - groupMinY;

    const siblings = activeSlide.elements.filter((item) => !movingIdSet.has(item.id));
    const xTargets: Array<{ pos: number; kind: 'center' | 'edge' }> = [{ pos: SLIDE_W / 2, kind: 'center' }];
    const yTargets: Array<{ pos: number; kind: 'center' | 'edge' }> = [{ pos: SLIDE_H / 2, kind: 'center' }];
    for (const sib of siblings) {
      xTargets.push(
        { pos: sib.x, kind: 'edge' },
        { pos: sib.x + sib.width / 2, kind: 'edge' },
        { pos: sib.x + sib.width, kind: 'edge' }
      );
      yTargets.push(
        { pos: sib.y, kind: 'edge' },
        { pos: sib.y + sib.height / 2, kind: 'edge' },
        { pos: sib.y + sib.height, kind: 'edge' }
      );
    }

    const SNAP_THRESHOLD = 6;
    const startX = e.clientX;
    const startY = e.clientY;
    const preDragDeck = deck;
    let moved = false;

    const onMove = (ev: MouseEvent) => {
      let dx = (ev.clientX - startX) / stageScale;
      let dy = (ev.clientY - startY) / stageScale;
      if (!moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
        moved = true;
        setPast((p) => [...p.slice(-30), preDragDeck]);
        setFuture([]);
      }
      if (!moved) return;

      const curLeft = groupMinX + dx;
      const curCenterX = curLeft + groupW / 2;
      const curRight = curLeft + groupW;
      let bestSnapX: { delta: number; guide: SnapGuide } | null = null;
      for (const anchor of [curCenterX, curLeft, curRight]) {
        for (const t of xTargets) {
          const diff = t.pos - anchor;
          if (Math.abs(diff) <= SNAP_THRESHOLD) {
            if (!bestSnapX || Math.abs(diff) < Math.abs(bestSnapX.delta)) {
              bestSnapX = { delta: diff, guide: { axis: 'x', pos: t.pos, kind: t.kind } };
            }
          }
        }
      }

      const curTop = groupMinY + dy;
      const curCenterY = curTop + groupH / 2;
      const curBottom = curTop + groupH;
      let bestSnapY: { delta: number; guide: SnapGuide } | null = null;
      for (const anchor of [curCenterY, curTop, curBottom]) {
        for (const t of yTargets) {
          const diff = t.pos - anchor;
          if (Math.abs(diff) <= SNAP_THRESHOLD) {
            if (!bestSnapY || Math.abs(diff) < Math.abs(bestSnapY.delta)) {
              bestSnapY = { delta: diff, guide: { axis: 'y', pos: t.pos, kind: t.kind } };
            }
          }
        }
      }

      const guides: SnapGuide[] = [];
      if (bestSnapX) {
        dx += bestSnapX.delta;
        guides.push(bestSnapX.guide);
      }
      if (bestSnapY) {
        dy += bestSnapY.delta;
        guides.push(bestSnapY.guide);
      }
      setSnapGuides(guides);

      const posMap = new Map(
        movingOrig.map((m) => [
          m.id,
          {
            x: Math.round(Math.max(-m.width + 40, Math.min(SLIDE_W - 40, m.x + dx))),
            y: Math.round(Math.max(-m.height + 24, Math.min(SLIDE_H - 24, m.y + dy))),
          },
        ])
      );

      updateActiveSlide(
        (s) => ({
          ...s,
          elements: s.elements.map((item) => {
            const p = posMap.get(item.id);
            return p ? { ...item, x: p.x, y: p.y } : item;
          }),
        }),
        false
      );
    };
    const onUp = () => {
      setSnapGuides([]);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Drag corner handle to resize element
  const startResizeElement = (
    e: React.MouseEvent,
    el: SlideElement,
    corner: 'nw' | 'ne' | 'sw' | 'se'
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const { x: ox, y: oy, width: ow, height: oh } = el;
    const preResizeDeck = deck;
    let moved = false;

    const onMove = (ev: MouseEvent) => {
      const dx = (ev.clientX - startX) / stageScale;
      const dy = (ev.clientY - startY) / stageScale;
      if (!moved && (Math.abs(dx) > 1 || Math.abs(dy) > 1)) {
        moved = true;
        setPast((p) => [...p.slice(-30), preResizeDeck]);
        setFuture([]);
      }
      let nx = ox;
      let ny = oy;
      let nw = ow;
      let nh = oh;
      if (corner.includes('e')) nw = Math.max(40, ow + dx);
      if (corner.includes('s')) nh = Math.max(16, oh + dy);
      if (corner.includes('w')) {
        nw = Math.max(40, ow - dx);
        nx = ox + (ow - nw);
      }
      if (corner.includes('n')) {
        nh = Math.max(16, oh - dy);
        ny = oy + (oh - nh);
      }
      handleUpdateElement(
        el.id,
        { x: Math.round(nx), y: Math.round(ny), width: Math.round(nw), height: Math.round(nh) },
        false
      );
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Slide list operations
  const handleAddSlide = (layout: SlideLayoutType, afterIdx = safeIdx) => {
    const theme = getThemeById(deck.themeId);
    const slide = createSlideFromLayout(layout, theme);
    const nextSlides = [...deck.slides];
    nextSlides.splice(afterIdx + 1, 0, slide);
    commitDeck({ ...deck, slides: nextSlides });
    setActiveSlideIdx(afterIdx + 1);
    setSelectedElId(null);
  };

  const handleDuplicateSlide = (idx: number) => {
    const copy: SlideData = {
      ...JSON.parse(JSON.stringify(deck.slides[idx])),
      id: uid('slide'),
    };
    copy.elements = copy.elements.map((el) => ({ ...el, id: uid('el') }));
    const nextSlides = [...deck.slides];
    nextSlides.splice(idx + 1, 0, copy);
    commitDeck({ ...deck, slides: nextSlides });
    setActiveSlideIdx(idx + 1);
  };

  const handleMoveSlide = (from: number, to: number) => {
    if (to < 0 || to >= deck.slides.length || from === to) return;
    const nextSlides = [...deck.slides];
    const [moved] = nextSlides.splice(from, 1);
    nextSlides.splice(to, 0, moved);
    commitDeck({ ...deck, slides: nextSlides });
    setActiveSlideIdx(to);
  };

  const handleDeleteSlide = (idx: number) => {
    if (deck.slides.length <= 1) return;
    const nextSlides = deck.slides.filter((_, i) => i !== idx);
    commitDeck({ ...deck, slides: nextSlides });
    setActiveSlideIdx(Math.min(idx, nextSlides.length - 1));
    setSelectedElId(null);
  };

  const handleApplyTheme = (themeId: string) => {
    const theme = getThemeById(themeId);
    const nextSlides = deck.slides.map((s) => ({
      ...s,
      backgroundColor: theme.bg,
      elements: s.elements.map((el) => {
        if (el.kind === 'text') {
          return {
            ...el,
            color: (el.fontSize ?? 20) >= 28 ? theme.titleColor : theme.bodyColor,
          };
        }
        return el;
      }),
    }));
    commitDeck({ ...deck, themeId, slides: nextSlides });
    onNotify(`Applied "${theme.name}" theme`);
  };

  const handleAddText = () => {
    const theme = getThemeById(deck.themeId);
    const el: SlideElement = {
      id: uid('el'),
      kind: 'text',
      x: 160,
      y: 180,
      width: 420,
      height: 70,
      text: 'Double-click to edit text',
      fontSize: 22,
      color: theme.titleColor,
      align: 'left',
    };
    updateActiveSlide((s) => ({ ...s, elements: [...s.elements, el] }));
    setSelectedElId(el.id);
    setEditingElId(el.id);
  };

  const handleAddShape = (variant: ShapeVariant) => {
    const theme = getThemeById(deck.themeId);
    const el: SlideElement = {
      id: uid('el'),
      kind: 'shape',
      shape: variant,
      x: 240,
      y: 170,
      width: variant === 'line' ? 320 : 220,
      height: variant === 'line' ? 6 : 140,
      fillColor: variant === 'line' ? theme.accent : theme.surface,
      borderColor: variant === 'line' ? undefined : theme.accent,
      borderWidth: variant === 'line' ? 0 : 2,
      color: theme.titleColor,
    };
    updateActiveSlide((s) => ({ ...s, elements: [...s.elements, el] }));
    setSelectedElId(el.id);
  };

  const handleAddTable = () => {
    const theme = getThemeById(deck.themeId);
    const defaultData = [
      ['Metric', 'Q3', 'Q4'],
      ['Revenue', '$375K', '$440K'],
      ['Margin', '33.8%', '38.8%'],
    ];
    const el: SlideElement = {
      id: uid('el'),
      kind: 'table',
      x: 150,
      y: 150,
      width: 640,
      height: 210,
      tableData: defaultData,
      headerRow: true,
      text: formatTableSearchText(defaultData),
      fontSize: 15,
      color: theme.titleColor,
      fillColor: theme.accent,
      borderColor: '#cbd5e1',
      align: 'left',
    };
    updateActiveSlide((s) => ({ ...s, elements: [...s.elements, el] }));
    setSelectedElId(el.id);
    setEditingElId(null);
  };

  const handleToggleMarkdownDrawer = () => {
    setShowMarkdownDrawer((open) => {
      const next = !open;
      if (next) {
        setMarkdownDraft(deckToMarkdown(deck));
        mdSnapshotTakenRef.current = false;
      }
      return next;
    });
  };

  const handleMarkdownChange = (nextMd: string) => {
    setMarkdownDraft(nextMd);
    const theme = getThemeById(deck.themeId);
    const parsedSlides = markdownToSlides(nextMd, theme);
    const recordSnapshot = !mdSnapshotTakenRef.current;
    mdSnapshotTakenRef.current = true;
    commitDeck({ ...deck, slides: parsedSlides }, recordSnapshot);
    setActiveSlideIdx((idx) => Math.max(0, Math.min(parsedSlides.length - 1, idx)));
    setSelectedElIds([]);
    setEditingElId(null);
  };

  const handleAddImageFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      const el: SlideElement = {
        id: uid('el'),
        kind: 'image',
        x: 220,
        y: 110,
        width: 420,
        height: 280,
        src: reader.result,
      };
      updateActiveSlide((s) => ({ ...s, elements: [...s.elements, el] }));
      setSelectedElId(el.id);
    };
    reader.readAsDataURL(file);
  };

  const handleExportDeck = async (fmt: 'pptx' | 'odp' | 'pdf') => {
    const safe = deck.title.replace(/[^a-zA-Z0-9._ -]/g, '_') || 'Presentation';
    try {
      let savedPath: string | undefined;
      if (fmt === 'pptx') {
        const bytes = await exportPresentationToPptx(deck);
        savedPath = await triggerFileDownload(
          bytes,
          `${safe}.pptx`,
          'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        );
      } else if (fmt === 'odp') {
        const bytes = await exportPresentationToOdp(deck);
        savedPath = await triggerFileDownload(
          bytes,
          `${safe}.odp`,
          'application/vnd.oasis.opendocument.presentation'
        );
      } else {
        const bytes = await exportPresentationToPdf(deck);
        savedPath = await triggerFileDownload(bytes, `${safe}.pdf`, 'application/pdf');
      }
      if (wasNativeSaveCancelled(savedPath)) return;
      onNotify(`Saved ${savedPath ? savedPath.split('/').pop() : `${safe}.${fmt}`}`);
    } catch (err) {
      onNotify(`Export failed: ${(err as Error).message}`);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <SlidesRibbon
        selectedElement={selectedElement}
        selectedCount={selectedElIds.length}
        activeThemeId={deck.themeId}
        canUndo={past.length > 0}
        canRedo={future.length > 0}
        showMarkdownDrawer={showMarkdownDrawer}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onAddSlide={(l) => handleAddSlide(l)}
        onAddText={handleAddText}
        onAddShape={handleAddShape}
        onAddTable={handleAddTable}
        onAddImageFile={handleAddImageFile}
        onUpdateSelected={(patch) => handleUpdateSelected(patch)}
        onAlignElements={handleAlignElements}
        onBringToFront={() => {
          if (selectedElIds.length === 0) return;
          const idSet = new Set(selectedElIds);
          updateActiveSlide((s) => {
            const targets = s.elements.filter((e) => idSet.has(e.id));
            if (targets.length === 0) return s;
            return { ...s, elements: [...s.elements.filter((e) => !idSet.has(e.id)), ...targets] };
          });
        }}
        onSendToBack={() => {
          if (selectedElIds.length === 0) return;
          const idSet = new Set(selectedElIds);
          updateActiveSlide((s) => {
            const targets = s.elements.filter((e) => idSet.has(e.id));
            if (targets.length === 0) return s;
            return { ...s, elements: [...targets, ...s.elements.filter((e) => !idSet.has(e.id))] };
          });
        }}
        onDuplicateSelected={handleDuplicateSelected}
        onDeleteSelected={handleDeleteSelected}
        onApplyTheme={handleApplyTheme}
        onToggleMarkdownDrawer={handleToggleMarkdownDrawer}
        onPresent={() => setPresenting(true)}
        onImportDeck={onImportDeckFile}
        onExportDeck={(fmt) => void handleExportDeck(fmt)}
      />

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left Slide Filmstrip Sidebar */}
        <aside className="no-print w-52 bg-slate-100 border-r border-slate-200 overflow-y-auto p-3 space-y-2.5 shrink-0 select-none">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 px-1 flex justify-between">
            <span>Slides ({deck.slides.length})</span>
            <span className="font-normal text-slate-400">Right-click</span>
          </div>

          {deck.slides.map((s, idx) => {
            const active = idx === safeIdx;
            return (
              <div
                key={s.id}
                onClick={() => {
                  setActiveSlideIdx(idx);
                  setSelectedElId(null);
                  setEditingElId(null);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setThumbMenu({ x: e.clientX, y: e.clientY, idx });
                }}
                className={`p-1.5 rounded-xl cursor-pointer transition border ${
                  active
                    ? 'bg-amber-50 border-amber-500 ring-1 ring-amber-500/30'
                    : 'bg-white/75 border-slate-200 hover:border-slate-300'
                }`}
              >
                <div className="rounded overflow-hidden border border-slate-200/80 shadow-xs">
                  <StaticSlideView slide={s} scale={164 / SLIDE_W} />
                </div>
                <div className="mt-1 px-0.5 flex items-center justify-between text-[10px] font-mono text-slate-500">
                  <span>{idx + 1}</span>
                  {s.notes.trim() && <StickyNote className="w-3 h-3 text-amber-500" />}
                </div>
              </div>
            );
          })}
        </aside>

        {/* Center Stage + Speaker Notes */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
          {linkedCanvasesOnSlide.length > 0 && (
            <div className="no-print bg-cyan-50/95 border-b border-cyan-200 px-4 py-1.5 flex flex-wrap items-center justify-between gap-2 text-xs text-cyan-900">
              <div className="flex items-center gap-2 min-w-0">
                <PenTool className="w-3.5 h-3.5 text-cyan-600 shrink-0" />
                <span className="font-semibold">
                  {linkedCanvasesOnSlide.length === 1
                    ? 'Linked Forma Canvas Diagram'
                    : `${linkedCanvasesOnSlide.length} Linked Forma Canvas Diagrams`}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {linkedCanvasesOnSlide.map((item) => (
                  <button
                    key={item.canvasId}
                    type="button"
                    onClick={() => {
                      if (!onRefreshLinkedCanvas) {
                        onNotify('Linked canvas refresh is not connected in standalone mode');
                        return;
                      }
                      const fresh = onRefreshLinkedCanvas(item.canvasId);
                      if (!fresh) {
                        onNotify(`Could not refresh "${item.title}" — source canvas unavailable`);
                        return;
                      }
                      const nextSlides = deck.slides.map((s, i) =>
                        i !== safeIdx
                          ? s
                          : {
                              ...s,
                              elements: s.elements.map((el) =>
                                el.linkedCanvasId === item.canvasId
                                  ? { ...el, src: fresh.src, linkedCanvasTitle: fresh.title }
                                  : el
                              ),
                            }
                      );
                      commitDeck({ ...deck, slides: nextSlides });
                      onNotify(`Refreshed linked canvas "${fresh.title}"`);
                    }}
                    title={`Refresh linked canvas diagram "${item.title}"`}
                    className="px-2.5 py-1 rounded-md bg-cyan-600 hover:bg-cyan-700 text-white text-[11px] font-semibold flex items-center gap-1.5 shadow-2xs transition"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>Refresh Canvas: {item.title}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div
            ref={stageContainerRef}
            onMouseDown={() => {
              setSelectedElId(null);
              setEditingElId(null);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setStageMenu({ x: e.clientX, y: e.clientY, elId: null });
            }}
            className="flex-1 overflow-auto bg-slate-200/70 flex items-center justify-center p-6"
          >
            {/* Interactive 16:9 Slide Canvas */}
            <div
              style={{
                width: SLIDE_W * stageScale,
                height: SLIDE_H * stageScale,
                backgroundColor: activeSlide.backgroundColor || '#ffffff',
              }}
              className="relative shadow-2xl border border-slate-300/90 rounded-xs shrink-0 overflow-hidden"
            >
              <div
                style={{
                  width: SLIDE_W,
                  height: SLIDE_H,
                  transform: `scale(${stageScale})`,
                  transformOrigin: 'top left',
                }}
                className="relative"
              >
                {activeSlide.elements.map((el) => {
                  const isSelected = selectedElIds.includes(el.id);
                  const isEditing = el.id === editingElId;
                  const isTable = el.kind === 'table';
                  const tableRows = isTable && el.tableData && el.tableData.length > 0 ? el.tableData : [['', '']];
                  const tableCols = isTable ? Math.max(1, ...tableRows.map((r) => r.length)) : 0;
                  const hasHeader = el.headerRow ?? true;

                  return (
                    <div
                      key={el.id}
                      onMouseDown={(e) => startDragElement(e, el)}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        if (el.kind !== 'image' && el.kind !== 'table') {
                          setSelectedElId(el.id);
                          setEditingElId(el.id);
                        }
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!selectedElIds.includes(el.id)) setSelectedElId(el.id);
                        setStageMenu({ x: e.clientX, y: e.clientY, elId: el.id });
                      }}
                      style={{
                        left: el.x,
                        top: el.y,
                        width: el.width,
                        height: el.height,
                        backgroundColor:
                          el.kind === 'shape'
                            ? el.fillColor || '#e2e8f0'
                            : el.kind === 'table'
                              ? undefined
                              : el.fillColor,
                        border:
                          el.kind === 'shape' && el.borderColor
                            ? `${el.borderWidth ?? 1}px solid ${el.borderColor}`
                            : undefined,
                        borderRadius:
                          el.kind === 'shape'
                            ? el.shape === 'ellipse'
                              ? '9999px'
                              : el.shape === 'roundRect'
                                ? '14px'
                                : '2px'
                            : undefined,
                      }}
                      className={`absolute ${
                        isEditing ? 'cursor-text' : 'cursor-move'
                      } ${isSelected ? 'ring-2 ring-amber-500' : 'hover:ring-1 hover:ring-amber-400/60'}`}
                    >
                      {el.kind === 'image' && el.src ? (
                        <img
                          src={el.src}
                          alt=""
                          draggable={false}
                          className="w-full h-full object-contain pointer-events-none select-none"
                        />
                      ) : isTable ? (
                        <div className="relative w-full h-full">
                          {/* Table Mini-Toolbar (+Row, -Row, +Col, -Col) when selected */}
                          {isSelected && (
                            <div
                              onMouseDown={(e) => e.stopPropagation()}
                              className="no-print absolute -top-8 left-0 z-30 bg-slate-900 text-white rounded-lg shadow-lg px-1.5 py-0.5 flex items-center gap-1 text-[11px] whitespace-nowrap"
                            >
                              <span
                                onMouseDown={(e) => startDragElement(e, el)}
                                title="Drag table"
                                className="cursor-move px-1 text-slate-400 hover:text-white flex items-center"
                              >
                                <GripHorizontal className="w-3.5 h-3.5" />
                              </span>
                              <button
                                onClick={() =>
                                  updateTableData(el.id, (rows) => [
                                    ...rows,
                                    Array.from({ length: tableCols }, () => ''),
                                  ])
                                }
                                className="px-1.5 py-0.5 rounded hover:bg-slate-700 font-medium"
                              >
                                +Row
                              </button>
                              <button
                                disabled={tableRows.length <= 1}
                                onClick={() =>
                                  updateTableData(el.id, (rows) => (rows.length > 1 ? rows.slice(0, -1) : rows))
                                }
                                className="px-1.5 py-0.5 rounded hover:bg-slate-700 disabled:opacity-35 font-medium"
                              >
                                -Row
                              </button>
                              <div className="w-px h-3.5 bg-slate-700" />
                              <button
                                onClick={() =>
                                  updateTableData(el.id, (rows) => rows.map((r) => [...r, '']))
                                }
                                className="px-1.5 py-0.5 rounded hover:bg-slate-700 font-medium"
                              >
                                +Col
                              </button>
                              <button
                                disabled={tableCols <= 1}
                                onClick={() =>
                                  updateTableData(el.id, (rows) =>
                                    rows.map((r) => (r.length > 1 ? r.slice(0, -1) : r))
                                  )
                                }
                                className="px-1.5 py-0.5 rounded hover:bg-slate-700 disabled:opacity-35 font-medium"
                              >
                                -Col
                              </button>
                            </div>
                          )}
                          <table
                            className="w-full h-full border-collapse table-fixed"
                            style={{
                              fontSize: el.fontSize ?? 14,
                              fontFamily: el.fontFamily ?? 'Inter, sans-serif',
                              textAlign: el.align ?? 'left',
                            }}
                          >
                            <tbody>
                              {tableRows.map((row, rIdx) => {
                                const isHeader = hasHeader && rIdx === 0;
                                return (
                                  <tr
                                    key={rIdx}
                                    style={{
                                      backgroundColor: isHeader
                                        ? el.fillColor || '#1e293b'
                                        : rIdx % 2 === 0
                                          ? '#f8fafc'
                                          : '#ffffff',
                                      color: isHeader ? '#ffffff' : el.color ?? '#0f172a',
                                      fontWeight: isHeader || el.bold ? 700 : 400,
                                      fontStyle: el.italic ? 'italic' : 'normal',
                                    }}
                                  >
                                    {Array.from({ length: tableCols }, (_, cIdx) => (
                                      <td
                                        key={cIdx}
                                        style={{ border: `1px solid ${el.borderColor || '#cbd5e1'}` }}
                                        className="p-0 align-middle"
                                      >
                                        {isSelected ? (
                                          <input
                                            value={row[cIdx] ?? ''}
                                            onMouseDown={(e) => e.stopPropagation()}
                                            onFocus={() => {
                                              setPast((p) => [...p.slice(-30), deck]);
                                              setFuture([]);
                                            }}
                                            onChange={(e) => {
                                              const val = e.target.value;
                                              updateTableData(
                                                el.id,
                                                (rows) => {
                                                  while (rows[rIdx].length < tableCols) rows[rIdx].push('');
                                                  rows[rIdx][cIdx] = val;
                                                  return rows;
                                                },
                                                false
                                              );
                                            }}
                                            style={{
                                              color: isHeader ? '#ffffff' : el.color ?? '#0f172a',
                                              textAlign: el.align ?? 'left',
                                            }}
                                            className="w-full h-full bg-transparent px-2 py-1 focus:outline-none focus:bg-amber-400/15"
                                          />
                                        ) : (
                                          <div className="px-2 py-1 truncate select-none">
                                            {row[cIdx] ?? ''}
                                          </div>
                                        )}
                                      </td>
                                    ))}
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      ) : isEditing ? (
                        <textarea
                          autoFocus
                          value={el.text ?? ''}
                          onFocus={() => {
                            setPast((p) => [...p.slice(-30), deck]);
                            setFuture([]);
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                          onChange={(e) =>
                            handleUpdateElement(el.id, { text: e.target.value }, false)
                          }
                          onBlur={() => setEditingElId(null)}
                          style={{
                            fontSize: el.fontSize ?? 20,
                            fontFamily: el.fontFamily ?? 'Inter, sans-serif',
                            fontWeight: el.bold ? 700 : 400,
                            fontStyle: el.italic ? 'italic' : 'normal',
                            textDecoration: el.underline ? 'underline' : undefined,
                            color: el.color ?? '#0f172a',
                            textAlign: el.align ?? (el.kind === 'shape' ? 'center' : 'left'),
                          }}
                          className="w-full h-full bg-transparent resize-none focus:outline-none p-1 leading-snug"
                        />
                      ) : (
                        <div
                          style={{
                            fontSize: el.fontSize ?? 20,
                            fontFamily: el.fontFamily ?? 'Inter, sans-serif',
                            fontWeight: el.bold ? 700 : 400,
                            fontStyle: el.italic ? 'italic' : 'normal',
                            textDecoration: el.underline ? 'underline' : undefined,
                            color: el.color ?? '#0f172a',
                            textAlign: el.align ?? (el.kind === 'shape' ? 'center' : 'left'),
                          }}
                          className={`w-full h-full p-1 leading-snug whitespace-pre-wrap break-words overflow-hidden select-none ${
                            el.kind === 'shape' ? 'flex items-center justify-center' : ''
                          }`}
                        >
                          {el.text}
                        </div>
                      )}

                      {/* 4 Corner Resize Handles */}
                      {isSelected && !isEditing && selectedElIds.length === 1 && (
                        <>
                          {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                            <div
                              key={corner}
                              onMouseDown={(e) => startResizeElement(e, el, corner)}
                              className={`absolute w-3 h-3 bg-white border-2 border-amber-600 rounded-xs z-20 ${
                                corner === 'nw'
                                  ? '-left-1.5 -top-1.5 cursor-nwse-resize'
                                  : corner === 'ne'
                                    ? '-right-1.5 -top-1.5 cursor-nesw-resize'
                                    : corner === 'sw'
                                      ? '-left-1.5 -bottom-1.5 cursor-nesw-resize'
                                      : '-right-1.5 -bottom-1.5 cursor-nwse-resize'
                              }`}
                            />
                          ))}
                        </>
                      )}
                    </div>
                  );
                })}

                {/* Smart Alignment / Snap Guide Lines Overlay (Slide Center = Magenta, Sibling Edges = Cyan) */}
                {snapGuides.length > 0 && (
                  <svg
                    width={SLIDE_W}
                    height={SLIDE_H}
                    className="absolute inset-0 pointer-events-none z-40"
                  >
                    {snapGuides.map((g, idx) =>
                      g.axis === 'x' ? (
                        <line
                          key={`gx_${idx}`}
                          x1={g.pos}
                          y1={0}
                          x2={g.pos}
                          y2={SLIDE_H}
                          stroke={g.kind === 'center' ? '#ec4899' : '#06b6d4'}
                          strokeWidth={1.5}
                          strokeDasharray={g.kind === 'center' ? '6,4' : '4,3'}
                        />
                      ) : (
                        <line
                          key={`gy_${idx}`}
                          x1={0}
                          y1={g.pos}
                          x2={SLIDE_W}
                          y2={g.pos}
                          stroke={g.kind === 'center' ? '#ec4899' : '#06b6d4'}
                          strokeWidth={1.5}
                          strokeDasharray={g.kind === 'center' ? '6,4' : '4,3'}
                        />
                      )
                    )}
                  </svg>
                )}
              </div>
            </div>
          </div>

          {/* Collapsible Speaker Notes Drawer */}
          {showNotes && (
            <div className="no-print h-24 bg-white border-t border-slate-200 px-4 py-2 flex flex-col shrink-0">
              <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                <span>Speaker Notes (Slide {safeIdx + 1})</span>
                <button
                  onClick={() => setShowNotes(false)}
                  className="text-slate-400 hover:text-slate-600"
                >
                  Hide
                </button>
              </div>
              <textarea
                value={activeSlide.notes}
                onFocus={() => {
                  setPast((p) => [...p.slice(-30), deck]);
                  setFuture([]);
                }}
                onChange={(e) =>
                  updateActiveSlide((s) => ({ ...s, notes: e.target.value }), false)
                }
                placeholder="Click to add presenter notes for this slide (saved in .pptx & .odp)…"
                className="flex-1 text-xs text-slate-700 resize-none focus:outline-none"
              />
            </div>
          )}
        </div>

        {/* Right Side Drawer: Markdown-to-Deck Live Editor */}
        {showMarkdownDrawer && (
          <aside className="no-print w-80 lg:w-96 bg-white border-l border-slate-200 flex flex-col shrink-0">
            <div className="px-3 py-2 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div>
                <div className="text-xs font-semibold text-slate-800">Markdown Deck</div>
                <div className="text-[10px] text-slate-500">
                  Live sync · Separate slides with <code className="font-mono bg-slate-200/80 px-1 rounded">---</code>
                </div>
              </div>
              <button
                onClick={() => setShowMarkdownDrawer(false)}
                className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-200"
                title="Close Markdown Drawer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <textarea
              value={markdownDraft}
              onFocus={() => {
                mdSnapshotTakenRef.current = false;
              }}
              onChange={(e) => handleMarkdownChange(e.target.value)}
              spellCheck={false}
              placeholder={'# Slide Title\n\n- Bullet one\n- Bullet two\n\n---\n\n# Next Slide'}
              className="flex-1 p-3 text-xs font-mono leading-relaxed text-slate-800 bg-slate-50/40 resize-none focus:outline-none"
            />
            <div className="px-3 py-1.5 border-t border-slate-200 bg-slate-50 text-[10px] text-slate-500 flex items-center justify-between">
              <span># Title · - Bullet · | Table | · Notes:</span>
              <span className="font-mono text-amber-700">{deck.slides.length} slides</span>
            </div>
          </aside>
        )}
      </div>

      {/* Bottom Status Bar */}
      <div className="no-print h-8 bg-slate-100 border-t border-slate-200 px-4 flex items-center justify-between text-[11px] text-slate-500 shrink-0">
        <div className="flex items-center gap-4">
          <span>
            Slide <strong className="text-slate-800 font-mono">{safeIdx + 1}</strong> of{' '}
            <strong className="text-slate-800 font-mono">{deck.slides.length}</strong>
          </span>
          <button
            onClick={() => setShowNotes((v) => !v)}
            className="hover:text-slate-800 flex items-center gap-1"
          >
            <StickyNote className="w-3 h-3" />
            <span>{showNotes ? 'Hide Notes' : 'Show Notes'}</span>
          </button>
          <span className="hidden md:inline text-slate-400">
            Shift+click to multi-select · Drag to snap
          </span>
        </div>
        <div className="flex items-center gap-3">
          <ZoomControl zoom={zoom} onZoomOut={zoomOut} onZoomIn={zoomIn} onZoomReset={zoomReset} />
        </div>
      </div>

      {/* Enhanced Full-Screen Presenter Mode Overlay */}
      {presenting && (
        <div
          onClick={() => setActiveSlideIdx((i) => Math.min(deck.slides.length - 1, i + 1))}
          className="fixed inset-0 z-[200] bg-slate-950 flex flex-col select-none"
        >
          {/* Main Presenter Body */}
          <div className="flex-1 min-h-0 flex items-center justify-center gap-6 px-6 py-6 overflow-hidden">
            {/* Current Slide Stage */}
            <div className="flex-1 min-w-0 flex items-center justify-center">
              <div className="shadow-2xl rounded-xs overflow-hidden ring-1 ring-white/10">
                <StaticSlideView slide={activeSlide} scale={presentScale} />
              </div>
            </div>

            {/* Presenter Sidebar: Next-Slide Preview + Speaker Notes */}
            {showPresenterNotes && (
              <aside
                onClick={(e) => e.stopPropagation()}
                className="w-72 lg:w-80 h-full max-h-[82vh] bg-slate-900/90 border border-slate-800 rounded-2xl p-4 flex flex-col gap-4 text-slate-100 shrink-0"
              >
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-2 flex items-center justify-between">
                    <span>Next Slide</span>
                    <span className="font-mono">
                      {safeIdx + 1 < deck.slides.length ? `${safeIdx + 2} / ${deck.slides.length}` : 'End'}
                    </span>
                  </div>
                  {deck.slides[safeIdx + 1] ? (
                    <div
                      onClick={() => setActiveSlideIdx((i) => Math.min(deck.slides.length - 1, i + 1))}
                      className="rounded-lg overflow-hidden border border-slate-700 cursor-pointer hover:border-amber-500 transition flex justify-center bg-slate-950"
                    >
                      <StaticSlideView slide={deck.slides[safeIdx + 1]} scale={256 / SLIDE_W} />
                    </div>
                  ) : (
                    <div className="h-32 rounded-lg border border-dashed border-slate-700 flex items-center justify-center text-xs text-slate-500">
                      End of presentation
                    </div>
                  )}
                </div>

                <div className="flex-1 min-h-0 flex flex-col">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-400 mb-1.5 flex items-center gap-1.5">
                    <StickyNote className="w-3.5 h-3.5" />
                    <span>Speaker Notes</span>
                  </div>
                  <div className="flex-1 overflow-y-auto rounded-lg bg-slate-950/70 border border-slate-800 p-3 text-sm leading-relaxed text-slate-200 whitespace-pre-wrap select-text">
                    {activeSlide.notes?.trim() ? (
                      activeSlide.notes
                    ) : (
                      <span className="text-slate-500 italic text-xs">
                        No speaker notes on Slide {safeIdx + 1}.
                      </span>
                    )}
                  </div>
                </div>
              </aside>
            )}
          </div>

          {/* Bottom Presenter HUD: Timer, Slide Controls, Speaker Notes Toggle */}
          <div
            onClick={(e) => e.stopPropagation()}
            className="h-14 bg-slate-900/95 border-t border-slate-800 px-5 flex items-center justify-between text-white text-xs shrink-0"
          >
            {/* Elapsed Timer with Pause/Resume & Reset */}
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-800 border border-slate-700 font-mono text-sm text-amber-300">
                <Clock className="w-3.5 h-3.5 text-amber-400" />
                <span>{formatElapsed(elapsedSec)}</span>
              </div>
              <button
                onClick={() => setTimerPaused((p) => !p)}
                title={timerPaused ? 'Resume Timer' : 'Pause Timer'}
                className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center gap-1 transition"
              >
                {timerPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                <span>{timerPaused ? 'Resume' : 'Pause'}</span>
              </button>
              <button
                onClick={() => setElapsedSec(0)}
                title="Reset Timer"
                className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center gap-1 transition"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset</span>
              </button>
            </div>

            {/* Slide Navigation */}
            <div className="flex items-center gap-2">
              <button
                disabled={safeIdx <= 0}
                onClick={() => setActiveSlideIdx((i) => Math.max(0, i - 1))}
                className="p-1.5 rounded-lg hover:bg-slate-800 disabled:opacity-35"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="font-mono px-2">
                {safeIdx + 1} / {deck.slides.length}
              </span>
              <button
                disabled={safeIdx >= deck.slides.length - 1}
                onClick={() => setActiveSlideIdx((i) => Math.min(deck.slides.length - 1, i + 1))}
                className="p-1.5 rounded-lg hover:bg-slate-800 disabled:opacity-35"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            {/* Notes Panel Toggle & Exit */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowPresenterNotes((v) => !v)}
                title="Toggle Speaker Notes & Next Slide Panel (N)"
                className={`px-2.5 py-1 rounded-lg flex items-center gap-1.5 transition border ${
                  showPresenterNotes
                    ? 'bg-amber-600/20 border-amber-500/60 text-amber-300'
                    : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                }`}
              >
                <StickyNote className="w-3.5 h-3.5" />
                <span>{showPresenterNotes ? 'Hide Notes' : 'Speaker Notes'}</span>
              </button>
              <button
                onClick={() => setPresenting(false)}
                className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 flex items-center gap-1 text-slate-200 transition"
              >
                <X className="w-3.5 h-3.5" />
                <span>Esc</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Slide Thumbnail Context Menu */}
      {thumbMenu && (
        <ContextMenu
          x={thumbMenu.x}
          y={thumbMenu.y}
          onClose={() => setThumbMenu(null)}
          items={
            [
              { id: 'newAfter', label: 'New Slide After', onClick: () => handleAddSlide('content', thumbMenu.idx) },
              { id: 'dup', label: 'Duplicate Slide', onClick: () => handleDuplicateSlide(thumbMenu.idx) },
              { id: 'd1', divider: true },
              {
                id: 'up',
                label: 'Move Slide Up',
                disabled: thumbMenu.idx === 0,
                onClick: () => handleMoveSlide(thumbMenu.idx, thumbMenu.idx - 1),
              },
              {
                id: 'down',
                label: 'Move Slide Down',
                disabled: thumbMenu.idx >= deck.slides.length - 1,
                onClick: () => handleMoveSlide(thumbMenu.idx, thumbMenu.idx + 1),
              },
              { id: 'd2', divider: true },
              {
                id: 'del',
                label: 'Delete Slide',
                danger: true,
                disabled: deck.slides.length <= 1,
                onClick: () => handleDeleteSlide(thumbMenu.idx),
              },
            ] as ContextMenuItem[]
          }
        />
      )}

      {/* Stage / Element Context Menu */}
      {stageMenu && (
        <ContextMenu
          x={stageMenu.x}
          y={stageMenu.y}
          onClose={() => setStageMenu(null)}
          items={
            stageMenu.elId
              ? ([
                  {
                    id: 'edit',
                    label: 'Edit Text',
                    onClick: () => setEditingElId(stageMenu.elId),
                  },
                  {
                    id: 'dupEl',
                    label: 'Duplicate Element',
                    shortcut: '⌘D',
                    onClick: handleDuplicateSelected,
                  },
                  {
                    id: 'front',
                    label: 'Bring to Front',
                    onClick: () => {
                      updateActiveSlide((s) => {
                        const target = s.elements.find((e) => e.id === stageMenu.elId);
                        if (!target) return s;
                        return {
                          ...s,
                          elements: [...s.elements.filter((e) => e.id !== stageMenu.elId), target],
                        };
                      });
                    },
                  },
                  {
                    id: 'back',
                    label: 'Send to Back',
                    onClick: () => {
                      updateActiveSlide((s) => {
                        const target = s.elements.find((e) => e.id === stageMenu.elId);
                        if (!target) return s;
                        return {
                          ...s,
                          elements: [target, ...s.elements.filter((e) => e.id !== stageMenu.elId)],
                        };
                      });
                    },
                  },
                  { id: 'd1', divider: true },
                  {
                    id: 'delEl',
                    label: 'Delete Element',
                    shortcut: '⌫',
                    danger: true,
                    onClick: handleDeleteSelected,
                  },
                ] as ContextMenuItem[])
              : ([
                  { id: 'addT', label: 'Insert Text Box', onClick: handleAddText },
                  { id: 'addTbl', label: 'Insert Table', onClick: handleAddTable },
                  { id: 'addR', label: 'Insert Rounded Card', onClick: () => handleAddShape('roundRect') },
                  { id: 'addC', label: 'Insert Circle', onClick: () => handleAddShape('ellipse') },
                  { id: 'd1', divider: true },
                  { id: 'dupS', label: 'Duplicate This Slide', onClick: () => handleDuplicateSlide(safeIdx) },
                  { id: 'pres', label: 'Present From This Slide', onClick: () => setPresenting(true) },
                ] as ContextMenuItem[])
          }
        />
      )}
    </div>
  );
};
