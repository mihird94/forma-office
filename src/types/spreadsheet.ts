import type { DataValidation, TableProperties } from 'exceljs';

export type HorizontalAlign = 'left' | 'center' | 'right';
export type VerticalAlign = 'top' | 'middle' | 'bottom';

export type NumberFormatType =
  | 'general'
  | 'number'
  | 'currency'
  | 'percent'
  | 'date'
  | 'integer'
  | 'scientific';

export interface CellBorder {
  top?: boolean;
  right?: boolean;
  bottom?: boolean;
  left?: boolean;
  color?: string;
}

export interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  backgroundColor?: string;
  align?: HorizontalAlign;
  valign?: VerticalAlign;
  wrap?: boolean;
  numFmt?: NumberFormatType;
  decimals?: number;
  border?: CellBorder;
}

export type CellScalar = string | number | boolean | null;

export interface CellData {
  /** Raw input: either a formula starting with '=' or a raw literal string */
  raw: string;
  /** Optional cell formatting */
  style?: CellStyle;
  /** Optional comment / note */
  note?: string;
}

export interface ComputedCell {
  value: CellScalar;
  error?: string;
  formatted: string;
  /** Address of the dynamic array origin cell if this value spilled from another formula */
  spilledFrom?: string;
}

export type ConditionalFormatKind =
  | 'greaterThan'
  | 'lessThan'
  | 'equals'
  | 'contains'
  | 'colorScale'
  | 'dataBar';

export interface ConditionalFormatRule {
  id: string;
  range: string;
  kind: ConditionalFormatKind;
  value?: string;
  color?: string;
  backgroundColor?: string;
}

export interface SheetFilterState {
  enabled: boolean;
  headerRow: number;
  /** Maps 0-based column index -> excluded formatted values */
  hiddenValues: Record<number, string[]>;
}

export type PivotAggregation = 'sum' | 'avg' | 'count' | 'min' | 'max';

export interface PivotTableSpec {
  sourceRange: string;
  rowField: number;
  colField?: number;
  valueField: number;
  agg: PivotAggregation;
}

export interface MergeRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export type ChartType = 'bar' | 'line' | 'area' | 'pie';

export interface ChartSpec {
  id: string;
  title: string;
  type: ChartType;
  /** e.g., "A1:E6" where first col is labels and subsequent cols are series */
  dataRange: string;
  sheetId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** XLSX definitions are kept separately from editable cell values. */
export type XlsxTableDefinition = Omit<TableProperties, 'ref' | 'rows'> & {
  tableRef: string;
  autoFilterRef?: string;
};

export interface XlsxSheetMetadata {
  tables: XlsxTableDefinition[];
  validations: Record<string, DataValidation>;
}

export interface SheetData {
  id: string;
  name: string;
  rowCount: number;
  colCount: number;
  /** Keyed by A1 address, e.g. "B4" */
  cells: Record<string, CellData>;
  colWidths: Record<number, number>;
  rowHeights: Record<number, number>;
  frozenRows: number;
  frozenCols: number;
  merges: MergeRange[];
  charts: ChartSpec[];
  xlsxMetadata?: XlsxSheetMetadata;
  conditionalFormats?: ConditionalFormatRule[];
  filter?: SheetFilterState;
}

export type SpreadsheetSourceFormat = 'xlsx' | 'ods' | 'csv' | 'tsv';

export interface WorkbookData {
  id: string;
  title: string;
  sheets: SheetData[];
  activeSheetId: string;
  sourceFormat?: SpreadsheetSourceFormat;
  nativePath?: string;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
}

export interface CellCoord {
  row: number; // 0-based
  col: number; // 0-based
}

export interface CellSelection {
  anchor: CellCoord;
  focus: CellCoord;
}

export interface NormalizedRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}
