export type PdfTool = 'select' | 'highlight' | 'text' | 'ink' | 'note' | 'redact';

interface BaseAnnotation {
  id: string;
  pageIndex: number; // 0-based
  color: string;
}

export interface PdfHighlightAnnotation extends BaseAnnotation {
  type: 'highlight';
  /** Normalized 0..1 coordinates from top-left of page */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfTextAnnotation extends BaseAnnotation {
  type: 'text';
  x: number;
  y: number;
  text: string;
  fontSize: number; // in PDF points (e.g. 14)
}

export interface PdfInkAnnotation extends BaseAnnotation {
  type: 'ink';
  /** Normalized 0..1 points along the stroke */
  points: Array<{ x: number; y: number }>;
  strokeWidth: number;
}

export interface PdfNoteAnnotation extends BaseAnnotation {
  type: 'note';
  x: number;
  y: number;
  text: string;
}

export interface PdfRedactAnnotation {
  id: string;
  type: 'redact';
  pageIndex: number; // 0-based
  /** Normalized 0..1 coordinates from top-left of page */
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
}

export type PdfAnnotation =
  | PdfHighlightAnnotation
  | PdfTextAnnotation
  | PdfInkAnnotation
  | PdfNoteAnnotation
  | PdfRedactAnnotation;

export interface FormaPdfRecord {
  id: string;
  title: string;
  pageCount: number;
  sizeBytes: number;
  annotations: PdfAnnotation[];
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  /** Original disk path when opened in native macOS Forma PDF.app (enables instant zero-copy HTTP 206 Range streaming) */
  nativePath?: string;
  /** Immutable edited PDF bytes, committed before the metadata referencing them. */
  blobId?: string;
}
