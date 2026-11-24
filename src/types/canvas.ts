export type CanvasTool =
  | 'select'
  | 'hand'
  | 'rect'
  | 'roundRect'
  | 'diamond'
  | 'ellipse'
  | 'sticky'
  | 'text'
  | 'arrow'
  | 'line'
  | 'freehand'
  | 'frame';

export type CanvasElementKind =
  | 'rect'
  | 'roundRect'
  | 'diamond'
  | 'ellipse'
  | 'sticky'
  | 'text'
  | 'arrow'
  | 'line'
  | 'freehand'
  | 'frame'
  | 'image';

export type CanvasAnchorSide = 'top' | 'right' | 'bottom' | 'left' | 'center';

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasBinding {
  elementId: string;
  anchor: CanvasAnchorSide;
}

export interface CanvasElement {
  id: string;
  kind: CanvasElementKind;
  x: number;
  y: number;
  width: number;
  height: number;
  points?: CanvasPoint[];
  startBinding?: CanvasBinding;
  endBinding?: CanvasBinding;
  text?: string;
  fontSize?: number;
  fontFamily?: 'sans' | 'hand' | 'mono';
  textAlign?: 'left' | 'center' | 'right';
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  strokeStyle?: 'solid' | 'dashed' | 'dotted';
  roughness?: 0 | 1;
  opacity?: number;
  src?: string;
  locked?: boolean;
}

export type CanvasBackground = 'dots' | 'grid' | 'plain';

export type CanvasSourceFormat = 'fcanvas' | 'excalidraw';

export interface CanvasData {
  id: string;
  title: string;
  elements: CanvasElement[];
  viewport: { x: number; y: number; zoom: number };
  background: CanvasBackground;
  theme: 'light' | 'dark';
  sourceFormat?: CanvasSourceFormat;
  nativePath?: string;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
}

export type CanvasTemplateId = 'blank' | 'architecture' | 'mindmap' | 'kanban';
