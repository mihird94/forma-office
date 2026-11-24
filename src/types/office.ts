export type AppMode = 'home' | 'sheets' | 'docs' | 'slides' | 'pdf' | 'lab' | 'canvas';
export type StandaloneAppKind = 'sheets' | 'docs' | 'slides' | 'pdf' | 'lab' | 'canvas' | null;
export type WorkspaceFileKind = 'spreadsheet' | 'document' | 'slides' | 'pdf' | 'notebook' | 'canvas';

export type SpreadsheetExportFormat = 'xlsx' | 'ods' | 'csv' | 'tsv';
export type DocumentExportFormat = 'docx' | 'odt' | 'md' | 'html';

export interface WorkspaceFileSummary {
  id: string;
  title: string;
  kind: WorkspaceFileKind;
  updatedAt: number;
  createdAt: number;
  primaryFormat: string;
  previewText?: string;
  pinned?: boolean;
}
