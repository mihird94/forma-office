import { CellData, CellStyle, SheetData, WorkbookData } from '../../types/spreadsheet';
import { createBlankWorkbook, createSampleWorkbook, uid } from './workbookOps';

export type SheetTemplateId = 'blank' | 'budget' | 'saas' | 'tracker';

export interface SheetTemplateMeta {
  id: SheetTemplateId;
  name: string;
  subtitle: string;
  accent: string;
}

export const SHEET_TEMPLATES: SheetTemplateMeta[] = [
  {
    id: 'blank',
    name: 'Blank Workbook',
    subtitle: 'Empty spreadsheet ready for data & formulas',
    accent: 'emerald',
  },
  {
    id: 'budget',
    name: 'Monthly Budget',
    subtitle: 'Income, categories, variance & savings rate',
    accent: 'teal',
  },
  {
    id: 'saas',
    name: 'SaaS Financial Model',
    subtitle: 'Multi-sheet P&L, cross-sheet refs & live chart',
    accent: 'amber',
  },
  {
    id: 'tracker',
    name: 'Project Tracker',
    subtitle: 'Milestones, owners, progress & completion stats',
    accent: 'indigo',
  },
];

function createBudgetWorkbook(): WorkbookData {
  const now = Date.now();
  const sId = uid('sheet');
  const hdr: CellStyle = { bold: true, backgroundColor: '#0f172a', color: '#ffffff', align: 'center' };
  const cur: CellStyle = { numFmt: 'currency', decimals: 0, align: 'right' };
  const pct: CellStyle = { numFmt: 'percent', decimals: 1, align: 'right' };
  const tot: CellStyle = {
    bold: true,
    backgroundColor: '#f0fdf4',
    color: '#14532d',
    numFmt: 'currency',
    decimals: 0,
    border: { top: true, bottom: true, color: '#16a34a' },
  };

  const cells: Record<string, CellData> = {
    A1: { raw: 'Monthly Personal / Team Budget', style: { bold: true, fontSize: 15 } },
    A3: { raw: 'Category', style: { ...hdr, align: 'left' } },
    B3: { raw: 'Planned', style: hdr },
    C3: { raw: 'Actual', style: hdr },
    D3: { raw: 'Variance', style: hdr },
    E3: { raw: '% of Plan', style: hdr },

    A4: { raw: 'Housing / Rent' },
    B4: { raw: '2800', style: cur },
    C4: { raw: '2800', style: cur },
    D4: { raw: '=B4-C4', style: cur },
    E4: { raw: '=IFERROR(C4/B4,0)', style: pct },

    A5: { raw: 'Groceries & Dining' },
    B5: { raw: '900', style: cur },
    C5: { raw: '845', style: cur },
    D5: { raw: '=B5-C5', style: cur },
    E5: { raw: '=IFERROR(C5/B5,0)', style: pct },

    A6: { raw: 'Transportation' },
    B6: { raw: '350', style: cur },
    C6: { raw: '310', style: cur },
    D6: { raw: '=B6-C6', style: cur },
    E6: { raw: '=IFERROR(C6/B6,0)', style: pct },

    A7: { raw: 'Utilities & Internet' },
    B7: { raw: '260', style: cur },
    C7: { raw: '275', style: cur },
    D7: { raw: '=B7-C7', style: cur },
    E7: { raw: '=IFERROR(C7/B7,0)', style: pct },

    A8: { raw: 'Software & Cloud' },
    B8: { raw: '180', style: cur },
    C8: { raw: '165', style: cur },
    D8: { raw: '=B8-C8', style: cur },
    E8: { raw: '=IFERROR(C8/B8,0)', style: pct },

    A9: { raw: 'Savings & Investments', style: { bold: true } },
    B9: { raw: '2000', style: cur },
    C9: { raw: '2200', style: cur },
    D9: { raw: '=C9-B9', style: cur },
    E9: { raw: '=IFERROR(C9/B9,0)', style: pct },

    A10: { raw: 'Total', style: { ...tot, align: 'left', numFmt: 'general' } },
    B10: { raw: '=SUM(B4:B9)', style: tot },
    C10: { raw: '=SUM(C4:C9)', style: tot },
    D10: { raw: '=B10-C10', style: tot },
    E10: { raw: '=IFERROR(C10/B10,0)', style: { ...tot, numFmt: 'percent', decimals: 1 } },
  };

  const sheet: SheetData = {
    id: sId,
    name: 'Monthly Budget',
    rowCount: 60,
    colCount: 20,
    cells,
    colWidths: { 0: 210, 1: 115, 2: 115, 3: 115, 4: 110 },
    rowHeights: { 0: 30, 2: 28 },
    frozenRows: 3,
    frozenCols: 1,
    merges: [],
    charts: [],
  };

  return {
    id: uid('wb'),
    title: 'Monthly Budget',
    sheets: [sheet],
    activeSheetId: sId,
    createdAt: now,
    updatedAt: now,
  };
}

function createTrackerWorkbook(): WorkbookData {
  const now = Date.now();
  const sId = uid('sheet');
  const hdr: CellStyle = { bold: true, backgroundColor: '#1e293b', color: '#ffffff', align: 'center' };
  const pct: CellStyle = { numFmt: 'percent', decimals: 0, align: 'right' };

  const cells: Record<string, CellData> = {
    A1: { raw: 'Q4 Product Launch Tracker', style: { bold: true, fontSize: 15 } },
    A3: { raw: 'Milestone', style: { ...hdr, align: 'left' } },
    B3: { raw: 'Owner', style: hdr },
    C3: { raw: 'Status', style: hdr },
    D3: { raw: 'Progress', style: hdr },
    E3: { raw: 'Est. Hours', style: hdr },

    A4: { raw: 'Architecture & Open Format Spec' },
    B4: { raw: 'Alex' },
    C4: { raw: 'Done', style: { backgroundColor: '#dcfce7', color: '#166534', align: 'center', bold: true } },
    D4: { raw: '1', style: pct },
    E4: { raw: '16' },

    A5: { raw: 'Formula Engine & DAG Tests' },
    B5: { raw: 'Sam' },
    C5: { raw: 'Done', style: { backgroundColor: '#dcfce7', color: '#166534', align: 'center', bold: true } },
    D5: { raw: '1', style: pct },
    E5: { raw: '24' },

    A6: { raw: 'Native macOS Packaging' },
    B6: { raw: 'Jordan' },
    C6: { raw: 'In Progress', style: { backgroundColor: '#fef9c3', color: '#854d0e', align: 'center', bold: true } },
    D6: { raw: '0.75', style: pct },
    E6: { raw: '18' },

    A7: { raw: 'QA & Accessibility Audit' },
    B7: { raw: 'Taylor' },
    C7: { raw: 'Planned', style: { backgroundColor: '#f1f5f9', color: '#475569', align: 'center' } },
    D7: { raw: '0.2', style: pct },
    E7: { raw: '12' },

    A9: { raw: 'Summary', style: { bold: true } },
    B9: { raw: '=COUNTIF(C4:C7,"Done") & " / " & COUNTA(C4:C7) & " Done"', style: { bold: true, align: 'center' } },
    C9: { raw: 'Avg Progress', style: { align: 'right', color: '#64748b' } },
    D9: { raw: '=AVERAGE(D4:D7)', style: { ...pct, bold: true, backgroundColor: '#eff6ff', color: '#1d4ed8' } },
    E9: { raw: '=SUM(E4:E7)', style: { bold: true } },
  };

  const sheet: SheetData = {
    id: sId,
    name: 'Milestones',
    rowCount: 60,
    colCount: 16,
    cells,
    colWidths: { 0: 250, 1: 120, 2: 120, 3: 110, 4: 110 },
    rowHeights: { 0: 30, 2: 28 },
    frozenRows: 3,
    frozenCols: 0,
    merges: [],
    charts: [],
  };

  return {
    id: uid('wb'),
    title: 'Project Tracker',
    sheets: [sheet],
    activeSheetId: sId,
    createdAt: now,
    updatedAt: now,
  };
}

export function createWorkbookFromTemplate(templateId: SheetTemplateId): WorkbookData {
  switch (templateId) {
    case 'budget':
      return createBudgetWorkbook();
    case 'saas':
      return createSampleWorkbook();
    case 'tracker':
      return createTrackerWorkbook();
    case 'blank':
    default:
      return createBlankWorkbook('Untitled Workbook');
  }
}
