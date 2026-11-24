import React, { useState } from 'react';
import {
  AlignCenter,
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyStart,
  Bold,
  Circle,
  Copy,
  Download,
  FileCode2,
  Image as ImageIcon,
  Italic,
  Layers,
  Minus,
  Palette,
  Play,
  Plus,
  Redo2,
  Square,
  Table2,
  Trash2,
  Type,
  Underline,
  Undo2,
  Upload,
} from 'lucide-react';
import { ShapeVariant, SlideElement, SlideLayoutType } from '../../types/slides';
import { SLIDE_THEMES } from '../../engine/slides/slideTemplates';

export type SlideElementAlignMode = 'left' | 'center' | 'right' | 'top' | 'middle';

interface SlidesRibbonProps {
  selectedElement: SlideElement | null;
  selectedCount: number;
  activeThemeId: string;
  canUndo: boolean;
  canRedo: boolean;
  showMarkdownDrawer: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onAddSlide: (layout: SlideLayoutType) => void;
  onAddText: () => void;
  onAddShape: (variant: ShapeVariant) => void;
  onAddTable: () => void;
  onAddImageFile: (file: File) => void;
  onUpdateSelected: (patch: Partial<SlideElement>) => void;
  onAlignElements: (mode: SlideElementAlignMode) => void;
  onBringToFront: () => void;
  onSendToBack: () => void;
  onDuplicateSelected: () => void;
  onDeleteSelected: () => void;
  onApplyTheme: (themeId: string) => void;
  onToggleMarkdownDrawer: () => void;
  onPresent: () => void;
  onImportDeck: (file: File) => void;
  onExportDeck: (fmt: 'pptx' | 'odp' | 'pdf') => void;
}

const SWATCHES = ['#0f172a', '#ffffff', '#f59e0b', '#ea580c', '#10b981', '#2563eb', '#e11d48', '#7c3aed', '#64748b'];

export const SlidesRibbon: React.FC<SlidesRibbonProps> = ({
  selectedElement,
  selectedCount,
  activeThemeId,
  canUndo,
  canRedo,
  showMarkdownDrawer,
  onUndo,
  onRedo,
  onAddSlide,
  onAddText,
  onAddShape,
  onAddTable,
  onAddImageFile,
  onUpdateSelected,
  onAlignElements,
  onBringToFront,
  onSendToBack,
  onDuplicateSelected,
  onDeleteSelected,
  onApplyTheme,
  onToggleMarkdownDrawer,
  onPresent,
  onImportDeck,
  onExportDeck,
}) => {
  const [openMenu, setOpenMenu] = useState<'slide' | 'shape' | 'theme' | 'textColor' | 'fillColor' | 'export' | null>(null);

  const btn = (active?: boolean) =>
    `px-2 py-1 rounded text-xs transition flex items-center gap-1 ${
      active ? 'bg-amber-100 text-amber-900 font-medium' : 'text-slate-700 hover:bg-slate-100'
    }`;

  return (
    <div className="no-print bg-white border-b border-slate-200 px-2 py-1.5 flex flex-wrap items-center gap-1 shrink-0 select-none">
      {/* Undo / Redo */}
      <button disabled={!canUndo} onClick={onUndo} title="Undo (⌘Z)" className={`${btn()} disabled:opacity-35`}>
        <Undo2 className="w-3.5 h-3.5" />
      </button>
      <button disabled={!canRedo} onClick={onRedo} title="Redo (⇧⌘Z)" className={`${btn()} disabled:opacity-35`}>
        <Redo2 className="w-3.5 h-3.5" />
      </button>

      <div className="h-5 w-px bg-slate-200 mx-0.5" />

      {/* New Slide with Layout Picker */}
      <div className="relative">
        <button
          onClick={() => setOpenMenu(openMenu === 'slide' ? null : 'slide')}
          className="px-2.5 py-1 rounded-md text-xs font-semibold bg-amber-50 text-amber-800 hover:bg-amber-100 border border-amber-200/80 flex items-center gap-1 transition"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New Slide</span>
        </button>
        {openMenu === 'slide' && (
          <div className="absolute left-0 top-8 z-40 w-48 bg-white border border-slate-200 rounded-xl shadow-xl py-1.5 text-xs">
            {(
              [
                ['title', 'Title Slide'],
                ['content', 'Title & Bullets'],
                ['twoColumn', 'Two Column'],
                ['metric', 'Metric Callouts'],
                ['blank', 'Blank Slide'],
              ] as Array<[SlideLayoutType, string]>
            ).map(([layout, label]) => (
              <button
                key={layout}
                onClick={() => {
                  onAddSlide(layout);
                  setOpenMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-amber-50 text-slate-700 font-medium"
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Insert Text / Shape / Image */}
      <button title="Insert Text Box" onClick={onAddText} className={btn()}>
        <Type className="w-3.5 h-3.5" />
        <span className="hidden lg:inline">Text</span>
      </button>

      <div className="relative">
        <button
          title="Insert Shape"
          onClick={() => setOpenMenu(openMenu === 'shape' ? null : 'shape')}
          className={btn()}
        >
          <Square className="w-3.5 h-3.5" />
          <span className="hidden lg:inline">Shape</span>
        </button>
        {openMenu === 'shape' && (
          <div className="absolute left-0 top-8 z-40 w-44 bg-white border border-slate-200 rounded-xl shadow-xl py-1.5 text-xs">
            <button
              onClick={() => {
                onAddShape('rect');
                setOpenMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-100 flex items-center gap-2"
            >
              <Square className="w-3.5 h-3.5" /> Rectangle
            </button>
            <button
              onClick={() => {
                onAddShape('roundRect');
                setOpenMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-100 flex items-center gap-2"
            >
              <Square className="w-3.5 h-3.5 rounded" /> Rounded Card
            </button>
            <button
              onClick={() => {
                onAddShape('ellipse');
                setOpenMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-100 flex items-center gap-2"
            >
              <Circle className="w-3.5 h-3.5" /> Circle / Oval
            </button>
            <button
              onClick={() => {
                onAddShape('line');
                setOpenMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-100 flex items-center gap-2"
            >
              <Minus className="w-3.5 h-3.5" /> Accent Divider
            </button>
          </div>
        )}
      </div>

      <button title="Insert Table" onClick={onAddTable} className={btn()}>
        <Table2 className="w-3.5 h-3.5" />
        <span className="hidden lg:inline">+ Table</span>
      </button>

      <label
        title="Insert Image"
        className="px-2 py-1 rounded text-xs text-slate-700 hover:bg-slate-100 cursor-pointer flex items-center gap-1 transition"
      >
        <ImageIcon className="w-3.5 h-3.5" />
        <span className="hidden lg:inline">Image</span>
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onAddImageFile(f);
            e.target.value = '';
          }}
        />
      </label>

      {/* Theme Picker */}
      <div className="relative">
        <button
          title="Slide Theme"
          onClick={() => setOpenMenu(openMenu === 'theme' ? null : 'theme')}
          className={btn()}
        >
          <Palette className="w-3.5 h-3.5" />
          <span className="hidden xl:inline">Theme</span>
        </button>
        {openMenu === 'theme' && (
          <div className="absolute left-0 top-8 z-40 w-56 bg-white border border-slate-200 rounded-xl shadow-xl p-2 grid grid-cols-2 gap-1.5 text-xs">
            {SLIDE_THEMES.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  onApplyTheme(t.id);
                  setOpenMenu(null);
                }}
                style={{ backgroundColor: t.bg, color: t.titleColor }}
                className={`p-2 rounded-lg border text-left transition ${
                  activeThemeId === t.id ? 'border-amber-500 ring-2 ring-amber-400/50' : 'border-slate-300'
                }`}
              >
                <div className="w-5 h-1 rounded-full mb-1" style={{ background: t.accent }} />
                <div className="text-[11px] font-semibold truncate">{t.name}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Contextual Formatting when an element is selected */}
      {selectedElement && (
        <>
          <div className="h-5 w-px bg-slate-200 mx-0.5" />

          {selectedElement.kind !== 'image' && (
            <>
              <select
                aria-label="Font Size"
                value={selectedElement.fontSize ?? 20}
                onChange={(e) => onUpdateSelected({ fontSize: Number(e.target.value) })}
                className="h-7 w-14 px-1 text-xs bg-slate-50 border border-slate-200 rounded text-slate-700"
              >
                {[12, 14, 16, 18, 20, 24, 28, 32, 36, 44, 52, 64].map((sz) => (
                  <option key={sz} value={sz}>
                    {sz}
                  </option>
                ))}
              </select>

              <button
                title="Bold"
                onClick={() => onUpdateSelected({ bold: !selectedElement.bold })}
                className={btn(selectedElement.bold)}
              >
                <Bold className="w-3.5 h-3.5" />
              </button>
              <button
                title="Italic"
                onClick={() => onUpdateSelected({ italic: !selectedElement.italic })}
                className={btn(selectedElement.italic)}
              >
                <Italic className="w-3.5 h-3.5" />
              </button>
              <button
                title="Underline"
                onClick={() => onUpdateSelected({ underline: !selectedElement.underline })}
                className={btn(selectedElement.underline)}
              >
                <Underline className="w-3.5 h-3.5" />
              </button>

              <button
                title="Align Left"
                onClick={() => onUpdateSelected({ align: 'left' })}
                className={btn(selectedElement.align === 'left')}
              >
                <AlignLeft className="w-3.5 h-3.5" />
              </button>
              <button
                title="Align Center"
                onClick={() => onUpdateSelected({ align: 'center' })}
                className={btn(selectedElement.align === 'center')}
              >
                <AlignCenter className="w-3.5 h-3.5" />
              </button>
              <button
                title="Align Right"
                onClick={() => onUpdateSelected({ align: 'right' })}
                className={btn(selectedElement.align === 'right')}
              >
                <AlignRight className="w-3.5 h-3.5" />
              </button>

              {/* Text Color */}
              <div className="relative">
                <button
                  title="Text Color"
                  onClick={() => setOpenMenu(openMenu === 'textColor' ? null : 'textColor')}
                  className={btn()}
                >
                  <span className="font-bold text-xs leading-none">A</span>
                  <span
                    className="w-3 h-1 rounded-full block"
                    style={{ background: selectedElement.color ?? '#0f172a' }}
                  />
                </button>
                {openMenu === 'textColor' && (
                  <div className="absolute left-0 top-8 z-40 bg-white border border-slate-200 rounded-lg shadow-xl p-2 flex gap-1.5">
                    {SWATCHES.map((c) => (
                      <button
                        key={c}
                        onClick={() => {
                          onUpdateSelected({ color: c });
                          setOpenMenu(null);
                        }}
                        style={{ background: c }}
                        className="w-5 h-5 rounded border border-slate-300 hover:scale-110 transition"
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* Fill Color */}
              <div className="relative">
                <button
                  title="Fill Color"
                  onClick={() => setOpenMenu(openMenu === 'fillColor' ? null : 'fillColor')}
                  className={btn()}
                >
                  <span
                    className="w-4 h-4 rounded border border-slate-300 inline-block"
                    style={{ background: selectedElement.fillColor || 'transparent' }}
                  />
                </button>
                {openMenu === 'fillColor' && (
                  <div className="absolute left-0 top-8 z-40 bg-white border border-slate-200 rounded-lg shadow-xl p-2 flex gap-1.5">
                    <button
                      onClick={() => {
                        onUpdateSelected({ fillColor: undefined });
                        setOpenMenu(null);
                      }}
                      className="w-5 h-5 rounded border border-slate-300 text-[10px] text-rose-500 font-bold"
                      title="Transparent"
                    >
                      /
                    </button>
                    {SWATCHES.map((c) => (
                      <button
                        key={c}
                        onClick={() => {
                          onUpdateSelected({ fillColor: c });
                          setOpenMenu(null);
                        }}
                        style={{ background: c }}
                        className="w-5 h-5 rounded border border-slate-300 hover:scale-110 transition"
                      />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          <div className="h-5 w-px bg-slate-200 mx-0.5" />

          {/* Element Alignment (multi-select or slide-relative) */}
          <div className="flex items-center gap-0.5" title={selectedCount > 1 ? `Align ${selectedCount} selected elements` : 'Align element to slide'}>
            <button title="Align Objects Left" onClick={() => onAlignElements('left')} className={btn()}>
              <AlignHorizontalJustifyStart className="w-3.5 h-3.5" />
            </button>
            <button title="Align Objects Center" onClick={() => onAlignElements('center')} className={btn()}>
              <AlignHorizontalJustifyCenter className="w-3.5 h-3.5" />
            </button>
            <button title="Align Objects Right" onClick={() => onAlignElements('right')} className={btn()}>
              <AlignHorizontalJustifyEnd className="w-3.5 h-3.5" />
            </button>
            <button title="Align Objects Top" onClick={() => onAlignElements('top')} className={btn()}>
              <AlignVerticalJustifyStart className="w-3.5 h-3.5" />
            </button>
            <button title="Align Objects Middle" onClick={() => onAlignElements('middle')} className={btn()}>
              <AlignVerticalJustifyCenter className="w-3.5 h-3.5" />
            </button>
          </div>

          {selectedCount > 1 && (
            <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-semibold font-mono">
              {selectedCount} sel
            </span>
          )}

          <button title="Bring to Front" onClick={onBringToFront} className={btn()}>
            <Layers className="w-3.5 h-3.5" />
          </button>
          <button title="Send to Back" onClick={onSendToBack} className="px-1.5 py-1 rounded text-[10px] font-mono text-slate-600 hover:bg-slate-100">
            Back
          </button>
          <button title="Duplicate Element (⌘D)" onClick={onDuplicateSelected} className={btn()}>
            <Copy className="w-3.5 h-3.5" />
          </button>
          <button title="Delete Element (⌫)" onClick={onDeleteSelected} className="p-1.5 rounded text-rose-600 hover:bg-rose-50">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </>
      )}

      <div className="flex-1" />

      {/* Markdown-to-Deck Live Drawer Toggle */}
      <button
        onClick={onToggleMarkdownDrawer}
        title="Toggle Markdown-to-Deck live editor"
        className={`px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 transition border ${
          showMarkdownDrawer
            ? 'bg-amber-600 text-white border-amber-700 shadow-xs'
            : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
        }`}
      >
        <FileCode2 className="w-3.5 h-3.5" />
        <span className="hidden md:inline">Markdown Deck</span>
      </button>

      {/* Present Full-Screen */}
      <button
        onClick={onPresent}
        title="Start Slideshow (Present)"
        className="px-2.5 py-1 rounded-md text-xs font-semibold bg-slate-900 text-white hover:bg-slate-800 flex items-center gap-1.5 transition shadow-xs"
      >
        <Play className="w-3.5 h-3.5 fill-current" />
        <span>Present</span>
      </button>

      {/* Import */}
      <label className="px-2.5 py-1 rounded-md text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 cursor-pointer flex items-center gap-1.5 transition">
        <Upload className="w-3.5 h-3.5" />
        <span>Import</span>
        <input
          type="file"
          accept=".pptx,.odp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onImportDeck(f);
            e.target.value = '';
          }}
        />
      </label>

      {/* Export */}
      <div className="relative">
        <button
          onClick={() => setOpenMenu(openMenu === 'export' ? null : 'export')}
          className="px-2.5 py-1 rounded-md text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 flex items-center gap-1.5 transition shadow-xs"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Export</span>
        </button>
        {openMenu === 'export' && (
          <div className="absolute right-0 top-8 z-40 w-52 bg-white border border-slate-200 rounded-xl shadow-xl py-1.5 text-xs">
            <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Export As
            </div>
            <button
              onClick={() => {
                onExportDeck('pptx');
                setOpenMenu(null);
              }}
              className="w-full text-left px-3 py-2 hover:bg-amber-50 flex items-center justify-between"
            >
              <span className="font-medium text-slate-800">PowerPoint</span>
              <span className="text-[10px] text-amber-700 font-mono">.pptx</span>
            </button>
            <button
              onClick={() => {
                onExportDeck('odp');
                setOpenMenu(null);
              }}
              className="w-full text-left px-3 py-2 hover:bg-amber-50 flex items-center justify-between"
            >
              <span className="font-medium text-slate-800">OpenDocument</span>
              <span className="text-[10px] text-amber-700 font-mono">.odp</span>
            </button>
            <div className="my-1 border-t border-slate-100" />
            <button
              onClick={() => {
                onExportDeck('pdf');
                setOpenMenu(null);
              }}
              className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between"
            >
              <span className="text-slate-700">PDF Document</span>
              <span className="text-[10px] text-slate-400 font-mono">.pdf</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
