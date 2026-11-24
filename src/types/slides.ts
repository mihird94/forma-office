export type SlideElementKind = 'text' | 'shape' | 'image' | 'table';
export type ShapeVariant = 'rect' | 'roundRect' | 'ellipse' | 'line';
export type SlideAlign = 'left' | 'center' | 'right';
export type SlideLayoutType = 'title' | 'content' | 'twoColumn' | 'metric' | 'blank';

export interface SlideElement {
  id: string;
  kind: SlideElementKind;
  /** Logical 16:9 canvas coordinates (960 x 540) */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Text content (for text boxes & optional shape label) */
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  align?: SlideAlign;
  /** Shape properties */
  shape?: ShapeVariant;
  fillColor?: string;
  borderColor?: string;
  borderWidth?: number;
  opacity?: number;
  /** Image data URL or external URL */
  src?: string;
  /** Optional live link to a Forma Canvas diagram for one-click refresh */
  linkedCanvasId?: string;
  linkedCanvasTitle?: string;
  /** Native editable table data (rows x cols) when kind === 'table' */
  tableData?: string[][];
  headerRow?: boolean;
}

export interface SlideData {
  id: string;
  backgroundColor: string;
  elements: SlideElement[];
  notes: string;
}

export interface SlideThemePreset {
  id: string;
  name: string;
  bg: string;
  surface: string;
  titleColor: string;
  bodyColor: string;
  accent: string;
}

export type SlidesSourceFormat = 'pptx' | 'odp';

export interface PresentationData {
  id: string;
  title: string;
  themeId: string;
  slides: SlideData[];
  sourceFormat?: SlidesSourceFormat;
  nativePath?: string;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
}

export const SLIDE_W = 960;
export const SLIDE_H = 540;
