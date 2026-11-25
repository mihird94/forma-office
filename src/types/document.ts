export type PageSize = 'letter' | 'a4';
export type PageMarginPreset = 'normal' | 'narrow' | 'wide';
export type DocumentSourceFormat = 'docx' | 'odt' | 'md' | 'html';
export type DocsViewMode = 'preview' | 'markdown' | 'split';

export interface DocComment {
  id: string;
  author: string;
  text: string;
  quote?: string;
  pin?: { xPct: number; yPct: number; label?: string };
  resolved?: boolean;
  createdAt: number;
}

export interface DocumentPageSettings {
  pageSize: PageSize;
  margins: PageMarginPreset;
  fontFamily: string;
  headerText?: string;
  footerText?: string;
  showPageNumbers?: boolean;
}

export interface FormaDocument {
  id: string;
  title: string;
  /** Semantic HTML stored as canonical working state, lossless with TipTap */
  html: string;
  /** Raw Markdown source when opened from or edited as a .md file */
  markdownSource?: string;
  rawHtmlSource?: string;
  /** Format this document originated from or was last saved as */
  sourceFormat?: DocumentSourceFormat;
  /** Native file path on disk for in-place Cmd+S saving */
  nativePath?: string;
  pageSettings: DocumentPageSettings;
  comments?: DocComment[];
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
}

export interface OutlineHeading {
  id: string;
  level: 1 | 2 | 3;
  text: string;
  pos: number;
}
