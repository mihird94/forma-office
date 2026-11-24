export type NotebookCellType = 'code' | 'markdown' | 'raw' | 'sql';
export type NotebookViewMode = 'lab' | 'study';

export interface FormaTablePayload {
  columns: string[];
  dtypes?: string[];
  rows: Array<Array<string | number | boolean | null>>;
  totalRows: number;
  totalCols: number;
  truncated?: boolean;
}

export interface StreamOutput {
  output_type: 'stream';
  name: 'stdout' | 'stderr';
  text: string;
}

export interface RichDataBundle {
  [mimeType: string]: unknown;
  'text/plain'?: string;
  'text/html'?: string;
  'image/png'?: string;
  'image/jpeg'?: string;
  'image/svg+xml'?: string;
  'text/latex'?: string;
  'application/vnd.forma.table+json'?: FormaTablePayload | string;
}

export interface ExecuteResultOutput {
  output_type: 'execute_result';
  execution_count: number | null;
  data: RichDataBundle;
  metadata?: Record<string, unknown>;
}

export interface DisplayDataOutput {
  output_type: 'display_data';
  data: RichDataBundle;
  metadata?: Record<string, unknown>;
}

export interface ErrorOutput {
  output_type: 'error';
  ename: string;
  evalue: string;
  traceback: string[];
}

export type NotebookOutput =
  | StreamOutput
  | ExecuteResultOutput
  | DisplayDataOutput
  | ErrorOutput;

export interface NotebookCell {
  id: string;
  cell_type: NotebookCellType;
  source: string;
  metadata?: Record<string, unknown>;
  attachments?: Record<string, RichDataBundle>;
  execution_count?: number | null;
  outputs?: NotebookOutput[];
  /** Forma Lab learning metadata (optional, safely preserved in cell.metadata) */
  collapsedCode?: boolean;
  collapsedOutput?: boolean;
  lastRunMs?: number;
  stale?: boolean;
  pinnedConcept?: boolean;
}

export interface LiveVariable {
  name: string;
  type: string;
  shape: string;
  preview: string;
  changed?: boolean;
}

export interface TraceStep {
  step: number;
  line: number;
  func: string;
  event: 'line' | 'return';
  stdout: string;
  locals: LiveVariable[];
}

export interface CellTraceData {
  steps: TraceStep[];
  truncated: boolean;
}

export interface PythonEnvInfo {
  path: string;
  label: string;
  version?: string;
}

export interface WorkspaceTreeNode {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  ext?: string;
  size?: number;
  children?: WorkspaceTreeNode[];
}

export interface LabFolderWorkspace {
  rootPath: string;
  rootName: string;
  entries: WorkspaceTreeNode[];
}

export interface NotebookData {
  id: string;
  title: string;
  cells: NotebookCell[];
  metadata?: Record<string, unknown>;
  kernelName?: string;
  pythonVersion?: string;
  nativePath?: string;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
}
