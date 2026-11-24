import React from 'react';
import { BookOpen, Moon, Sun } from 'lucide-react';

export type ReadingTheme = 'light' | 'paperwhite' | 'sepia' | 'dark';

const STORAGE_KEY = 'forma_reading_theme_v1';

export function loadReadingTheme(): ReadingTheme {
  try {
    const val = localStorage.getItem(STORAGE_KEY);
    if (val === 'light' || val === 'paperwhite' || val === 'sepia' || val === 'dark') {
      return val;
    }
  } catch {
    // ignore
  }
  return 'light';
}

export function saveReadingTheme(theme: ReadingTheme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // ignore
  }
}

export const READING_THEME_STYLES: Record<
  ReadingTheme,
  {
    label: string;
    backdropBg: string;
    paperBg: string;
    paperBorder: string;
    pdfFilter: string;
    pdfMultiplyTint?: string;
    docTextClass: string;
  }
> = {
  light: {
    label: 'Light',
    backdropBg: '#e2e8f0',
    paperBg: '#ffffff',
    paperBorder: '#cbd5e1',
    pdfFilter: 'none',
    docTextClass: '',
  },
  paperwhite: {
    label: 'Paperwhite',
    backdropBg: '#e5e3da',
    paperBg: '#f6f5ef',
    paperBorder: '#d6d3c8',
    pdfFilter: 'brightness(0.97) contrast(0.95) sepia(0.08)',
    pdfMultiplyTint: 'rgba(246, 245, 239, 0.45)',
    docTextClass: 'forma-theme-paperwhite',
  },
  sepia: {
    label: 'Sepia',
    backdropBg: '#e2d7be',
    paperBg: '#f4ecd8',
    paperBorder: '#d5c5a3',
    pdfFilter: 'sepia(0.36) brightness(0.95) contrast(0.95)',
    pdfMultiplyTint: 'rgba(244, 232, 200, 0.52)',
    docTextClass: 'forma-theme-sepia',
  },
  dark: {
    label: 'Night',
    backdropBg: '#0f1218',
    paperBg: '#1b1f27',
    paperBorder: '#2e3440',
    pdfFilter: 'invert(0.89) hue-rotate(180deg) brightness(0.96) contrast(0.95)',
    docTextClass: 'forma-theme-dark',
  },
};

interface ReadingModePickerProps {
  value: ReadingTheme;
  onChange: (next: ReadingTheme) => void;
  compact?: boolean;
}

export const ReadingModePicker: React.FC<ReadingModePickerProps> = ({ value, onChange, compact = false }) => {
  const options: Array<{
    id: ReadingTheme;
    title: string;
    swatch: string;
    icon?: React.ReactNode;
  }> = [
    { id: 'light', title: 'Light Mode', swatch: '#ffffff', icon: <Sun className="w-3 h-3 text-slate-600" /> },
    { id: 'paperwhite', title: 'Paperwhite (Matte E-Ink)', swatch: '#f6f5ef' },
    { id: 'sepia', title: 'Sepia (Warm Book Paper)', swatch: '#f2e4c4', icon: <BookOpen className="w-3 h-3 text-amber-900" /> },
    { id: 'dark', title: 'Night Reading Mode', swatch: '#1e2430', icon: <Moon className="w-3 h-3 text-slate-200" /> },
  ];

  return (
    <div
      title="Reading Theme (Light / Paperwhite / Sepia / Night)"
      className={`flex items-center gap-0.5 rounded-lg p-0.5 border ${
        compact ? 'bg-slate-800/80 border-slate-700' : 'bg-slate-100 border-slate-200'
      }`}
    >
      {options.map((opt) => {
        const active = value === opt.id;
        return (
          <button
            key={opt.id}
            title={opt.title}
            onClick={() => {
              saveReadingTheme(opt.id);
              onChange(opt.id);
            }}
            style={{ background: opt.swatch }}
            className={`h-6 px-1.5 rounded-md flex items-center gap-1 text-[10px] font-semibold transition border ${
              active
                ? 'border-slate-800 ring-1 ring-slate-400 shadow-xs'
                : 'border-slate-300/80 opacity-80 hover:opacity-100'
            } ${opt.id === 'dark' ? 'text-slate-100' : opt.id === 'sepia' ? 'text-amber-950' : 'text-slate-700'}`}
          >
            {opt.icon}
            {!compact && (
              <span className="hidden 2xl:inline">
                {opt.id === 'paperwhite' ? 'Paper' : READING_THEME_STYLES[opt.id].label}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
