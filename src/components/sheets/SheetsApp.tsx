import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Code2, Play, X } from 'lucide-react';
import {
  CellCoord,
  CellData,
  CellSelection,
  CellStyle,
  ChartSpec,
  ConditionalFormatRule,
  NormalizedRange,
  SheetData,
  WorkbookData,
} from '../../types/spreadsheet';
import { SpreadsheetExportFormat } from '../../types/office';
import {
  coordToAddress,
  normalizeSelection,
  parseAddress,
  rangeToA1,
  shiftFormulaReferences,
} from '../../engine/spreadsheet/address';
import { createWorkbookEvaluator } from '../../engine/spreadsheet/formulaEngine';
import { detectUsedRange } from '../../engine/spreadsheet/pivotEngine';
import {
  applyStyleToRange,
  clearRangeValues,
  createBlankSheet,
  fillRangeFromSource,
  mutateSheetStructure,
  rangeToHTMLTable,
  rangeToTSV,
  sortRangeByColumn,
  uid,
  updateSheetCell,
} from '../../engine/spreadsheet/workbookOps';
import {
  exportSheetToDelimited,
  importWorkbookFromDelimited,
  parseDelimitedRows,
} from '../../engine/spreadsheet/formats/csvCodec';
import { triggerFileDownload, wasNativeSaveCancelled } from '../../storage/workspaceStore';
import { executeKernelCode, isNativeKernelAvailable } from '../../storage/notebookStore';
import { SheetsRibbon } from './SheetsRibbon';
import { FormulaBar } from './FormulaBar';
import { GridContextAction, SpreadsheetGrid } from './SpreadsheetGrid';
import { SheetTabs } from './SheetTabs';
import { FunctionHelpModal } from './FunctionHelpModal';
import { ConditionalFormatModal } from './ConditionalFormatModal';
import { PivotModal } from './PivotModal';
import { useAppZoom } from '../../utils/useAppZoom';
import { loadFilePosition, saveFilePosition } from '../../storage/sessionStore';

export interface TableTransferSource {
  workbookId: string;
  workbookTitle: string;
  sheetName: string;
  rangeA1: string;
  plainText: string;
}

export interface SpreadsheetEditorHandle {
  id: string;
  snapshot: () => WorkbookData;
}

export interface WorkbookHistoryEntry {
  past: WorkbookData[];
  future: WorkbookData[];
}

interface SheetsAppProps {
  workbook: WorkbookData;
  historyMap?: Map<string, WorkbookHistoryEntry>;
  onChangeWorkbook: (wb: WorkbookData) => void;
  onImportNewWorkbook: (wb: WorkbookData) => void;
  onSendTableToDocs: (
    htmlTable: string,
    sourceTitle: string,
    meta?: TableTransferSource
  ) => void;
  onNotify: (msg: string) => void;
}

interface InternalClipboard {
  anchor: CellCoord;
  cells: Array<{ dRow: number; dCol: number; cell: CellData }>;
  tsv?: string;
}

export const SheetsApp = forwardRef<SpreadsheetEditorHandle, SheetsAppProps>(({
  workbook,
  historyMap,
  onChangeWorkbook,
  onImportNewWorkbook,
  onSendTableToDocs,
  onNotify,
}, ref) => {
  const [selection, setSelection] = useState<CellSelection>(() => {
    const pos = loadFilePosition(workbook.id);
    const row = pos?.cellRow ?? 0;
    const col = pos?.cellCol ?? 0;
    return { anchor: { row, col }, focus: { row, col } };
  });
  const [editingCoord, setEditingCoord] = useState<CellCoord | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [editSource, setEditSource] = useState<'cell' | 'formulaBar'>('cell');
  const [showFnModal, setShowFnModal] = useState(false);
  const [showCondFormatModal, setShowCondFormatModal] = useState(false);
  const [showPivotModal, setShowPivotModal] = useState(false);
  const [showPythonModal, setShowPythonModal] = useState(false);
  const [pythonExpr, setPythonExpr] = useState('df.describe().reset_index()');
  const [pythonRunning, setPythonRunning] = useState(false);
  const [pythonError, setPythonError] = useState<string | null>(null);
  const [showFind, setShowFind] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findIdx, setFindIdx] = useState(0);
  const canRunPython = useMemo(() => isNativeKernelAvailable(), []);
  const { zoom, zoomIn, zoomOut, zoomReset } = useAppZoom({
    initial: 1.0,
    min: 0.6,
    max: 1.75,
    step: 0.1,
  });

  // Undo / Redo stacks (persisted per workbook across tab switches via historyMap)
  const [past, setPast] = useState<WorkbookData[]>(() => historyMap?.get(workbook.id)?.past ?? []);
  const [future, setFuture] = useState<WorkbookData[]>(() => historyMap?.get(workbook.id)?.future ?? []);
  const clipboardRef = useRef<InternalClipboard | null>(null);

  useEffect(() => {
    if (!historyMap) return;
    historyMap.set(workbook.id, { past, future });
  }, [historyMap, workbook.id, past, future]);

  // Restore history & active cell when switching workbook id
  const prevWbId = useRef(workbook.id);
  useEffect(() => {
    if (prevWbId.current !== workbook.id) {
      prevWbId.current = workbook.id;
      const saved = historyMap?.get(workbook.id);
      setPast(saved?.past ?? []);
      setFuture(saved?.future ?? []);
      setEditingCoord(null);
      const pos = loadFilePosition(workbook.id);
      const row = pos?.cellRow ?? 0;
      const col = pos?.cellCol ?? 0;
      setSelection({ anchor: { row, col }, focus: { row, col } });
    }
  }, [workbook.id, historyMap]);

  useEffect(() => {
    saveFilePosition(workbook.id, {
      sheetId: workbook.activeSheetId,
      cellRow: selection.anchor.row,
      cellCol: selection.anchor.col,
    });
  }, [workbook.id, workbook.activeSheetId, selection.anchor.row, selection.anchor.col]);

  const activeSheet = useMemo(
    () => workbook.sheets.find((s) => s.id === workbook.activeSheetId) ?? workbook.sheets[0],
    [workbook]
  );

  const evaluate = useMemo(() => createWorkbookEvaluator(), []);
  const computedWorkbook = useMemo(() => evaluate(workbook), [evaluate, workbook.sheets]);
  const computedSheet = computedWorkbook[activeSheet.id] ?? {};

  const findMatches = useMemo<CellCoord[]>(() => {
    const q = findQuery.trim().toLowerCase();
    if (!q) return [];
    const hits: CellCoord[] = [];
    for (const [addr, cell] of Object.entries(activeSheet.cells)) {
      const comp = computedSheet[addr];
      const text = `${cell.raw ?? ''} ${comp?.value ?? ''}`.toLowerCase();
      if (text.includes(q)) {
        const parsed = parseAddress(addr);
        if (parsed) hits.push(parsed);
      }
    }
    hits.sort((a, b) => (a.row !== b.row ? a.row - b.row : a.col - b.col));
    return hits;
  }, [activeSheet.cells, computedSheet, findQuery]);

  const jumpToFindMatch = useCallback(
    (nextIndex: number) => {
      if (findMatches.length === 0) return;
      const wrapped = ((nextIndex % findMatches.length) + findMatches.length) % findMatches.length;
      setFindIdx(wrapped);
      const coord = findMatches[wrapped];
      setSelection({ anchor: coord, focus: coord });
    },
    [findMatches]
  );

  // Ref-backed synchronous flush so tab switch, unmount, sheet switch, or Export never loses an uncommitted cell edit
  const pendingEditRef = useRef({
    workbook,
    activeSheetId: activeSheet.id,
    editingCoord,
    editDraft,
    onChangeWorkbook,
  });
  pendingEditRef.current = {
    workbook,
    activeSheetId: activeSheet.id,
    editingCoord,
    editDraft,
    onChangeWorkbook,
  };

  const commitWorkbook = useCallback(
    (next: WorkbookData, recordHistory = true) => {
      const base = pendingEditRef.current.workbook;
      if (recordHistory) {
        setPast((p) => [...p.slice(-39), base]);
        setFuture([]);
      }
      const stamped = { ...next, updatedAt: Date.now() };
      pendingEditRef.current.workbook = stamped;
      onChangeWorkbook(stamped);
    },
    [onChangeWorkbook]
  );

  const pushUndoSnapshot = useCallback(() => {
    const base = pendingEditRef.current.workbook;
    setPast((p) => [...p.slice(-39), base]);
    setFuture([]);
  }, []);

  const updateActiveSheet = useCallback(
    (updater: (sheet: SheetData) => SheetData, recordHistory = true) => {
      const { workbook: curWb, activeSheetId, editingCoord: coord, editDraft: draft } =
        pendingEditRef.current;
      let baseWb = curWb;
      if (coord) {
        const addr = coordToAddress(coord.row, coord.col);
        const curSheet = curWb.sheets.find((s) => s.id === activeSheetId) ?? curWb.sheets[0];
        const prevRaw = curSheet?.cells[addr]?.raw ?? '';
        setEditingCoord(null);
        pendingEditRef.current.editingCoord = null;
        if (draft !== prevRaw) {
          baseWb = {
            ...curWb,
            sheets: curWb.sheets.map((s) =>
              s.id === curSheet.id
                ? updateSheetCell(s, addr, (prev) => ({ ...(prev ?? { raw: '' }), raw: draft }))
                : s
            ),
          };
        }
      }
      const nextSheets = baseWb.sheets.map((s) => (s.id === activeSheetId ? updater(s) : s));
      commitWorkbook({ ...baseWb, sheets: nextSheets }, recordHistory);
    },
    [commitWorkbook]
  );

  const handleUndo = useCallback(() => {
    if (past.length === 0) return;
    setEditingCoord(null);
    pendingEditRef.current.editingCoord = null;
    const prev = past[past.length - 1];
    setPast((p) => p.slice(0, -1));
    setFuture((f) => [pendingEditRef.current.workbook, ...f.slice(0, 39)]);
    onChangeWorkbook(prev);
  }, [past, onChangeWorkbook]);

  const handleRedo = useCallback(() => {
    if (future.length === 0) return;
    setEditingCoord(null);
    pendingEditRef.current.editingCoord = null;
    const next = future[0];
    setFuture((f) => f.slice(1));
    setPast((p) => [...p.slice(-39), pendingEditRef.current.workbook]);
    onChangeWorkbook(next);
  }, [future, onChangeWorkbook]);

  const normRange = useMemo(() => normalizeSelection(selection), [selection]);
  const anchorAddress = coordToAddress(selection.anchor.row, selection.anchor.col);
  const anchorCell = activeSheet.cells[anchorAddress];
  const anchorComputed = computedSheet[anchorAddress];

  const startEdit = useCallback(
    (coord: CellCoord, initialText?: string, source: 'cell' | 'formulaBar' = 'cell') => {
      const addr = coordToAddress(coord.row, coord.col);
      setEditSource(source);
      setEditingCoord(coord);
      setEditDraft(initialText !== undefined ? initialText : activeSheet.cells[addr]?.raw ?? '');
    },
    [activeSheet.cells]
  );

  const commitEdit = useCallback(
    (moveDir: 'down' | 'right' | 'none' = 'none') => {
      if (!editingCoord) return;
      const addr = coordToAddress(editingCoord.row, editingCoord.col);
      const prevRaw = activeSheet.cells[addr]?.raw ?? '';
      if (editDraft !== prevRaw) {
        updateActiveSheet((s) =>
          updateSheetCell(s, addr, (prev) => ({
            ...(prev ?? { raw: '' }),
            raw: editDraft,
          }))
        );
      }
      setEditingCoord(null);
      if (moveDir === 'down') {
        const nextRow = Math.min(activeSheet.rowCount - 1, editingCoord.row + 1);
        setSelection({
          anchor: { row: nextRow, col: editingCoord.col },
          focus: { row: nextRow, col: editingCoord.col },
        });
      } else if (moveDir === 'right') {
        const nextCol = Math.min(activeSheet.colCount - 1, editingCoord.col + 1);
        setSelection({
          anchor: { row: editingCoord.row, col: nextCol },
          focus: { row: editingCoord.row, col: nextCol },
        });
      }
    },
    [editingCoord, editDraft, activeSheet, updateActiveSheet]
  );

  const flushPendingEdit = useCallback((): WorkbookData => {
    const { workbook: curWb, activeSheetId, editingCoord: coord, editDraft: draft, onChangeWorkbook: emit } =
      pendingEditRef.current;
    if (!coord) return curWb;
    const addr = coordToAddress(coord.row, coord.col);
    const curSheet = curWb.sheets.find((s) => s.id === activeSheetId) ?? curWb.sheets[0];
    const prevRaw = curSheet?.cells[addr]?.raw ?? '';
    setEditingCoord(null);
    pendingEditRef.current.editingCoord = null;
    if (draft === prevRaw) return curWb;
    const updated: WorkbookData = {
      ...curWb,
      updatedAt: Date.now(),
      sheets: curWb.sheets.map((s) =>
        s.id === curSheet.id
          ? updateSheetCell(s, addr, (prev) => ({ ...(prev ?? { raw: '' }), raw: draft }))
          : s
      ),
    };
    setPast((p) => [...p.slice(-39), curWb]);
    setFuture([]);
    pendingEditRef.current.workbook = updated;
    emit(updated);
    return updated;
  }, []);

  useImperativeHandle(
    ref,
    () => ({ id: workbook.id, snapshot: flushPendingEdit }),
    [workbook.id, flushPendingEdit]
  );

  useEffect(() => {
    return () => {
      flushPendingEdit();
    };
  }, [flushPendingEdit]);

  // Clamp selection within bounds when switching sheets
  useEffect(() => {
    setSelection((prev) => {
      const maxR = Math.max(0, activeSheet.rowCount - 1);
      const maxC = Math.max(0, activeSheet.colCount - 1);
      if (
        prev.anchor.row <= maxR &&
        prev.anchor.col <= maxC &&
        prev.focus.row <= maxR &&
        prev.focus.col <= maxC
      ) {
        return prev;
      }
      return {
        anchor: { row: Math.min(prev.anchor.row, maxR), col: Math.min(prev.anchor.col, maxC) },
        focus: { row: Math.min(prev.focus.row, maxR), col: Math.min(prev.focus.col, maxC) },
      };
    });
  }, [activeSheet.id, activeSheet.rowCount, activeSheet.colCount]);

  const cancelEdit = useCallback(() => {
    setEditingCoord(null);
    setEditDraft('');
  }, []);

  // Copy & Paste (interoperates with system clipboard TSV + preserves internal formulas!)
  const handleCopy = useCallback(async () => {
    const items: InternalClipboard['cells'] = [];
    for (let r = normRange.startRow; r <= normRange.endRow; r++) {
      for (let c = normRange.startCol; c <= normRange.endCol; c++) {
        const cell = activeSheet.cells[coordToAddress(r, c)];
        if (cell) {
          items.push({
            dRow: r - normRange.startRow,
            dCol: c - normRange.startCol,
            cell: { ...cell, style: cell.style ? { ...cell.style } : undefined },
          });
        }
      }
    }
    const tsv = rangeToTSV(activeSheet, computedSheet, normRange, true);
    clipboardRef.current = {
      anchor: { row: normRange.startRow, col: normRange.startCol },
      cells: items,
      tsv,
    };

    try {
      await navigator.clipboard.writeText(tsv);
    } catch {
      // Clipboard API may be blocked in non-HTTPS contexts
    }
    onNotify(`Copied ${rangeToA1(normRange)}`);
  }, [activeSheet, computedSheet, normRange, onNotify]);

  const handlePaste = useCallback(async () => {
    const targetRow = selection.anchor.row;
    const targetCol = selection.anchor.col;

    // Try system clipboard first if it differs from internal copy
    let externalText = '';
    try {
      externalText = await navigator.clipboard.readText();
    } catch {
      // fallback to internal clipboard
    }

    const useInternal =
      clipboardRef.current &&
      clipboardRef.current.cells.length > 0 &&
      (!externalText || externalText === clipboardRef.current.tsv);

    if (useInternal && clipboardRef.current) {
      const clip = clipboardRef.current;
      const dRowShift = targetRow - clip.anchor.row;
      const dColShift = targetCol - clip.anchor.col;
      updateActiveSheet((s) => {
        const nextCells = { ...s.cells };
        for (const item of clip.cells) {
          const r = targetRow + item.dRow;
          const c = targetCol + item.dCol;
          if (r >= s.rowCount || c >= s.colCount) continue;
          const newRaw = item.cell.raw.startsWith('=')
            ? shiftFormulaReferences(item.cell.raw, dRowShift, dColShift)
            : item.cell.raw;
          nextCells[coordToAddress(r, c)] = {
            ...item.cell,
            raw: newRaw,
            style: item.cell.style ? { ...item.cell.style } : undefined,
          };
        }
        return { ...s, cells: nextCells };
      });
      return;
    }

    if (externalText) {
      const rows = parseDelimitedRows(externalText, '\t');
      updateActiveSheet((s) => {
        const nextCells = { ...s.cells };
        rows.forEach((cols, dr) => {
          cols.forEach((val, dc) => {
            const r = targetRow + dr;
            const c = targetCol + dc;
            if (r < s.rowCount && c < s.colCount) {
              nextCells[coordToAddress(r, c)] = { raw: val };
            }
          });
        });
        return { ...s, cells: nextCells };
      });
    }
  }, [selection.anchor, updateActiveSheet]);

  // Global Keyboard Navigation & Excel Shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInputFocused =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT';
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setShowFind((v) => !v);
        return;
      }

      if (isInputFocused || editingCoord) return;

      if (meta && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
        return;
      }
      if (meta && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        handleRedo();
        return;
      }
      if (meta && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        handleCopy();
        return;
      }
      if (meta && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        handlePaste();
        return;
      }
      if (meta && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        updateActiveSheet((s) =>
          applyStyleToRange(s, normRange, { bold: !anchorCell?.style?.bold })
        );
        return;
      }
      if (meta && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        updateActiveSheet((s) =>
          applyStyleToRange(s, normRange, { italic: !anchorCell?.style?.italic })
        );
        return;
      }
      if (meta && e.key.toLowerCase() === 'u') {
        e.preventDefault();
        updateActiveSheet((s) =>
          applyStyleToRange(s, normRange, { underline: !anchorCell?.style?.underline })
        );
        return;
      }

      if (e.key === 'F2') {
        e.preventDefault();
        startEdit(selection.anchor);
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        updateActiveSheet((s) => clearRangeValues(s, normRange));
        return;
      }

      const move = (dr: number, dc: number) => {
        e.preventDefault();
        if (e.shiftKey) {
          const nextRow = Math.max(0, Math.min(activeSheet.rowCount - 1, selection.focus.row + dr));
          const nextCol = Math.max(0, Math.min(activeSheet.colCount - 1, selection.focus.col + dc));
          setSelection({ anchor: selection.anchor, focus: { row: nextRow, col: nextCol } });
        } else {
          const nextRow = Math.max(0, Math.min(activeSheet.rowCount - 1, selection.anchor.row + dr));
          const nextCol = Math.max(0, Math.min(activeSheet.colCount - 1, selection.anchor.col + dc));
          setSelection({ anchor: { row: nextRow, col: nextCol }, focus: { row: nextRow, col: nextCol } });
        }
      };

      if (e.key === 'ArrowUp') return move(-1, 0);
      if (e.key === 'ArrowDown') return move(1, 0);
      if (e.key === 'ArrowLeft') return move(0, -1);
      if (e.key === 'ArrowRight') return move(0, 1);
      if (e.key === 'Tab') return move(0, e.shiftKey ? -1 : 1);
      if (e.key === 'Enter') return move(e.shiftKey ? -1 : 1, 0);

      // Start typing directly into the selected cell
      if (!meta && !e.altKey && e.key.length === 1) {
        e.preventDefault();
        startEdit(selection.anchor, e.key);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    editingCoord,
    selection,
    normRange,
    activeSheet,
    anchorCell,
    handleUndo,
    handleRedo,
    handleCopy,
    handlePaste,
    startEdit,
    updateActiveSheet,
  ]);

  // Selection Live Status Bar Stats (SUM, AVG, COUNT, MIN, MAX)
  const selectionStats = useMemo(() => {
    let count = 0;
    let numericCount = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;

    for (let r = normRange.startRow; r <= normRange.endRow; r++) {
      for (let c = normRange.startCol; c <= normRange.endCol; c++) {
        const comp = computedSheet[coordToAddress(r, c)];
        if (comp && comp.value !== null && comp.value !== '') {
          count++;
          if (typeof comp.value === 'number' && Number.isFinite(comp.value)) {
            numericCount++;
            sum += comp.value;
            if (comp.value < min) min = comp.value;
            if (comp.value > max) max = comp.value;
          }
        }
      }
    }
    return {
      count,
      numericCount,
      sum,
      avg: numericCount > 0 ? sum / numericCount : 0,
      min: numericCount > 0 ? min : 0,
      max: numericCount > 0 ? max : 0,
    };
  }, [normRange, computedSheet]);

  const handleStylePatch = (patch: Partial<CellStyle>) => {
    updateActiveSheet((s) => applyStyleToRange(s, normRange, patch));
  };

  const handleAdjustDecimals = (delta: 1 | -1) => {
    const current = anchorCell?.style?.decimals ?? 2;
    const next = Math.max(0, Math.min(6, current + delta));
    handleStylePatch({ decimals: next });
  };

  const handleToggleBorders = () => {
    const hasBorder = Boolean(anchorCell?.style?.border);
    handleStylePatch({
      border: hasBorder
        ? undefined
        : { top: true, right: true, bottom: true, left: true, color: '#94a3b8' },
    });
  };

  const handleToggleMerge = () => {
    if (normRange.startRow === normRange.endRow && normRange.startCol === normRange.endCol) return;
    updateActiveSheet((s) => {
      const existingIdx = s.merges.findIndex(
        (m) =>
          m.startRow === normRange.startRow &&
          m.startCol === normRange.startCol &&
          m.endRow === normRange.endRow &&
          m.endCol === normRange.endCol
      );
      if (existingIdx !== -1) {
        return { ...s, merges: s.merges.filter((_, i) => i !== existingIdx) };
      }
      return { ...s, merges: [...s.merges, { ...normRange }] };
    });
  };

  const handleInsertChart = () => {
    const rangeLabel = rangeToA1(normRange);
    const chart: ChartSpec = {
      id: uid('chart'),
      title: `${activeSheet.name} (${rangeLabel})`,
      type: 'bar',
      dataRange: rangeLabel,
      sheetId: activeSheet.id,
      x: 48 + activeSheet.charts.length * 24,
      y: 280 + activeSheet.charts.length * 24,
      width: 520,
      height: 265,
    };
    updateActiveSheet((s) => ({ ...s, charts: [...s.charts, chart] }));
    onNotify(`Inserted live chart for ${rangeLabel}`);
  };

  const handleSendToDocs = () => {
    const snapWb = flushPendingEdit();
    const snapSheet = snapWb.sheets.find((s) => s.id === snapWb.activeSheetId) ?? activeSheet;
    const snapComputed = snapWb === workbook ? computedSheet : evaluate(snapWb)[snapSheet.id] ?? {};
    const rangeA1 = rangeToA1(normRange);
    const htmlTable = rangeToHTMLTable(snapComputed, normRange);
    const plainText = rangeToTSV(snapSheet, snapComputed, normRange);
    const sourceLabel = `${snapWb.title} — ${snapSheet.name}!${rangeA1}`;
    const taggedHtml = `<div data-forma-source="${snapWb.id}:${snapSheet.name}!${rangeA1}">${htmlTable}<p><em>Source: ${sourceLabel}</em></p></div>`;
    onSendTableToDocs(taggedHtml, sourceLabel, {
      workbookId: snapWb.id,
      workbookTitle: snapWb.title,
      sheetName: snapSheet.name,
      rangeA1,
      plainText,
    });
  };

  const handleImportFile = async (file: File) => {
    try {
      const ext = file.name.split('.').pop()?.toLowerCase();
      let imported: WorkbookData;
      if (ext === 'xlsx') {
        const ab = await file.arrayBuffer();
        const { importWorkbookFromXlsx } = await import('../../engine/spreadsheet/formats/xlsxCodec');
        imported = await importWorkbookFromXlsx(ab, file.name);
      } else if (ext === 'ods') {
        const ab = await file.arrayBuffer();
        const { importWorkbookFromOds } = await import('../../engine/spreadsheet/formats/odsCodec');
        imported = await importWorkbookFromOds(ab, file.name);
      } else if (ext === 'tsv') {
        const text = await file.text();
        imported = importWorkbookFromDelimited(text, file.name, '\t');
      } else {
        const text = await file.text();
        imported = importWorkbookFromDelimited(text, file.name, ',');
      }
      onImportNewWorkbook(imported);
      onNotify(`Imported ${file.name} (${imported.sheets.length} sheet${imported.sheets.length > 1 ? 's' : ''})`);
    } catch (err) {
      onNotify(`Import failed: ${(err as Error).message}`);
    }
  };

  const handleExport = async (format: SpreadsheetExportFormat) => {
    const snapWb = flushPendingEdit();
    const safeName = snapWb.title.replace(/[^a-zA-Z0-9._ -]/g, '_') || 'Workbook';
    try {
      let savedPath: string | undefined;
      if (format === 'xlsx') {
        const { exportWorkbookToXlsx } = await import('../../engine/spreadsheet/formats/xlsxCodec');
        const bytes = await exportWorkbookToXlsx(snapWb);
        savedPath = await triggerFileDownload(
          bytes,
          `${safeName}.xlsx`,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
      } else if (format === 'ods') {
        const { exportWorkbookToOds } = await import('../../engine/spreadsheet/formats/odsCodec');
        const bytes = await exportWorkbookToOds(snapWb);
        savedPath = await triggerFileDownload(
          bytes,
          `${safeName}.ods`,
          'application/vnd.oasis.opendocument.spreadsheet'
        );
      } else if (format === 'csv') {
        const csv = exportSheetToDelimited(snapWb, activeSheet.id, ',');
        savedPath = await triggerFileDownload(csv, `${safeName}.csv`, 'text/csv;charset=utf-8');
      } else {
        const tsv = exportSheetToDelimited(snapWb, activeSheet.id, '\t');
        savedPath = await triggerFileDownload(
          tsv,
          `${safeName}.tsv`,
          'text/tab-separated-values;charset=utf-8'
        );
      }
      if (wasNativeSaveCancelled(savedPath)) return;
      onNotify(`Saved ${savedPath ? savedPath.split('/').pop() : `${safeName}.${format}`}`);
    } catch (err) {
      onNotify(`Export failed: ${(err as Error).message}`);
    }
  };

  const handleContextAction = (action: GridContextAction) => {
    switch (action) {
      case 'cut':
        void handleCopy().then(() => updateActiveSheet((s) => clearRangeValues(s, normRange)));
        break;
      case 'copy':
        void handleCopy();
        break;
      case 'paste':
        void handlePaste();
        break;
      case 'clear':
        updateActiveSheet((s) => clearRangeValues(s, normRange));
        break;
      case 'insertRowAbove':
        updateActiveSheet((s) => mutateSheetStructure(s, 'row', normRange.startRow, 1));
        break;
      case 'insertRowBelow':
        updateActiveSheet((s) => mutateSheetStructure(s, 'row', normRange.endRow + 1, 1));
        break;
      case 'deleteRow':
        updateActiveSheet((s) => mutateSheetStructure(s, 'row', normRange.startRow, -1));
        break;
      case 'insertColLeft':
        updateActiveSheet((s) => mutateSheetStructure(s, 'col', normRange.startCol, 1));
        break;
      case 'insertColRight':
        updateActiveSheet((s) => mutateSheetStructure(s, 'col', normRange.endCol + 1, 1));
        break;
      case 'deleteCol':
        updateActiveSheet((s) => mutateSheetStructure(s, 'col', normRange.startCol, -1));
        break;
      case 'sortAsc':
      case 'sortDesc': {
        const targetRange: NormalizedRange =
          normRange.startRow === normRange.endRow
            ? { startRow: 1, startCol: 0, endRow: activeSheet.rowCount - 1, endCol: activeSheet.colCount - 1 }
            : normRange;
        updateActiveSheet((s) =>
          sortRangeByColumn(
            {
              ...pendingEditRef.current.workbook,
              sheets: pendingEditRef.current.workbook.sheets.map((sh) => (sh.id === s.id ? s : sh)),
            },
            s.id,
            targetRange,
            selection.anchor.col,
            action === 'sortAsc' ? 'asc' : 'desc'
          )
        );
        break;
      }
      case 'formatCurrency':
        handleStylePatch({ numFmt: 'currency', decimals: 2 });
        break;
      case 'formatPercent':
        handleStylePatch({ numFmt: 'percent', decimals: 1 });
        break;
      case 'toggleMerge':
        handleToggleMerge();
        break;
      case 'insertChart':
        handleInsertChart();
        break;
      case 'sendToDocs':
        handleSendToDocs();
        break;
    }
  };

  // AutoFilter: compute hidden row indices based on activeSheet.filter
  const hiddenRows = useMemo<Set<number> | undefined>(() => {
    const filter = activeSheet.filter;
    if (!filter?.enabled) return undefined;
    const activeCols = Object.entries(filter.hiddenValues).filter(([, vals]) => vals.length > 0);
    if (activeCols.length === 0) return undefined;

    let maxRow = filter.headerRow;
    for (const [addr, cell] of Object.entries(activeSheet.cells)) {
      if (!cell || cell.raw === '') continue;
      const p = parseAddress(addr);
      if (p && p.row > maxRow) maxRow = p.row;
    }
    for (const [addr, comp] of Object.entries(computedSheet)) {
      if (!comp || comp.formatted === '') continue;
      const p = parseAddress(addr);
      if (p && p.row > maxRow) maxRow = p.row;
    }

    const hidden = new Set<number>();
    const excludedByCol = activeCols.map(([colStr, vals]) => ({
      col: Number(colStr),
      excluded: new Set(vals),
    }));

    for (let r = filter.headerRow + 1; r <= maxRow; r++) {
      for (const { col, excluded } of excludedByCol) {
        const formatted = computedSheet[coordToAddress(r, col)]?.formatted ?? '';
        const display = formatted === '' ? '(Blanks)' : formatted;
        if (excluded.has(display) || excluded.has(formatted)) {
          hidden.add(r);
          break;
        }
      }
    }
    return hidden.size > 0 ? hidden : undefined;
  }, [activeSheet.filter, activeSheet.cells, computedSheet]);

  const handleToggleFilter = () => {
    if (activeSheet.filter?.enabled) {
      updateActiveSheet((s) => ({ ...s, filter: undefined }));
      onNotify('AutoFilter disabled');
    } else {
      const headerRow = normRange.startRow;
      updateActiveSheet((s) => ({
        ...s,
        filter: { enabled: true, headerRow, hiddenValues: {} },
      }));
      onNotify(`AutoFilter enabled on row ${headerRow + 1}`);
    }
  };

  const handleUpdateColumnFilter = (col: number, hiddenValues: string[]) => {
    updateActiveSheet((s) => {
      if (!s.filter?.enabled) return s;
      const nextHidden = { ...s.filter.hiddenValues };
      if (hiddenValues.length === 0) {
        delete nextHidden[col];
      } else {
        nextHidden[col] = hiddenValues;
      }
      return {
        ...s,
        filter: { ...s.filter, hiddenValues: nextHidden },
      };
    });
  };

  const handleSortByFilterColumn = (col: number, dir: 'asc' | 'desc') => {
    const headerRow = activeSheet.filter?.enabled ? activeSheet.filter.headerRow : 0;
    const used = detectUsedRange(activeSheet);
    const endRow = Math.max(headerRow + 1, used?.endRow ?? activeSheet.rowCount - 1);
    const startCol = used?.startCol ?? 0;
    const endCol = Math.max(col, used?.endCol ?? activeSheet.colCount - 1);
    const targetRange: NormalizedRange = {
      startRow: headerRow + 1,
      startCol,
      endRow,
      endCol,
    };
    updateActiveSheet((s) =>
      sortRangeByColumn(
        {
          ...pendingEditRef.current.workbook,
          sheets: pendingEditRef.current.workbook.sheets.map((sh) => (sh.id === s.id ? s : sh)),
        },
        s.id,
        targetRange,
        col,
        dir
      )
    );
  };

  const handleAddCondFormatRule = (rule: ConditionalFormatRule) => {
    updateActiveSheet((s) => ({
      ...s,
      conditionalFormats: [...(s.conditionalFormats ?? []), rule],
    }));
    onNotify(`Added conditional formatting rule on ${rule.range}`);
  };

  const handleDeleteCondFormatRule = (id: string) => {
    updateActiveSheet((s) => ({
      ...s,
      conditionalFormats: (s.conditionalFormats ?? []).filter((r) => r.id !== id),
    }));
  };

  const handleCreatePivotSheet = (pivotSheet: SheetData) => {
    const snapWb = flushPendingEdit();
    const existingNames = new Set(snapWb.sheets.map((s) => s.name.toLowerCase()));
    let finalName = pivotSheet.name;
    let suffix = 2;
    while (existingNames.has(finalName.toLowerCase())) {
      finalName = `${pivotSheet.name} (${suffix++})`;
    }
    const namedSheet: SheetData = { ...pivotSheet, name: finalName };
    commitWorkbook({
      ...snapWb,
      sheets: [...snapWb.sheets, namedSheet],
      activeSheetId: namedSheet.id,
    });
    onNotify(`Created pivot sheet "${finalName}"`);
  };

  const pivotInitialRangeA1 = useMemo(() => {
    const isMultiCell = normRange.endRow > normRange.startRow || normRange.endCol > normRange.startCol;
    if (isMultiCell) return rangeToA1(normRange);
    const used = detectUsedRange(activeSheet);
    return used ? rangeToA1(used) : rangeToA1(normRange);
  }, [normRange, activeSheet]);

  const handleRunPythonTransform = async () => {
    const expr = pythonExpr.trim();
    if (!expr) return;
    setPythonRunning(true);
    setPythonError(null);
    try {
      const snapWb = flushPendingEdit();
      const snapSheet = snapWb.sheets.find((s) => s.id === snapWb.activeSheetId) ?? activeSheet;
      const csvData = exportSheetToDelimited(snapWb, snapSheet.id, ',');
      const code = [
        'import io, json, pandas as pd',
        `__forma_csv_in = ${JSON.stringify(csvData)}`,
        'df = pd.read_csv(io.StringIO(__forma_csv_in))',
        `__forma_res = (${expr})`,
        'if not isinstance(__forma_res, pd.DataFrame):',
        '    __forma_res = pd.DataFrame(__forma_res)',
        'print("__FORMA_CSV_START__")',
        'print(__forma_res.to_csv(index=False))',
        'print("__FORMA_CSV_END__")',
      ].join('\n');

      const res = await executeKernelCode(code);
      if (!res.ok) {
        const errOut = res.outputs.find((o) => o.output_type === 'error');
        const msg =
          res.error ||
          (errOut && errOut.output_type === 'error' ? `${errOut.ename}: ${errOut.evalue}` : 'Python execution failed');
        setPythonError(msg);
        return;
      }

      const stdout = res.outputs
        .filter((o): o is { output_type: 'stream'; name: 'stdout' | 'stderr'; text: string } => o.output_type === 'stream')
        .map((o) => o.text)
        .join('');
      const match = /__FORMA_CSV_START__\r?\n([\s\S]*?)__FORMA_CSV_END__/.exec(stdout);
      if (!match) {
        setPythonError('Transform did not return tabular DataFrame output.');
        return;
      }
      const imported = importWorkbookFromDelimited(match[1].trim(), `${snapSheet.name} (Py)`, ',');
      const outSheet: SheetData = {
        ...imported.sheets[0],
        id: uid('sheet'),
        name: `${snapSheet.name} (Py)`,
      };
      handleCreatePivotSheet(outSheet);
      setShowPythonModal(false);
    } catch (err) {
      setPythonError((err as Error).message);
    } finally {
      setPythonRunning(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <SheetsRibbon
        activeStyle={anchorCell?.style ?? {}}
        canUndo={past.length > 0}
        canRedo={future.length > 0}
        hasFrozenHeader={activeSheet.frozenRows > 0 || activeSheet.frozenCols > 0}
        isFilterEnabled={Boolean(activeSheet.filter?.enabled)}
        condFormatCount={activeSheet.conditionalFormats?.length ?? 0}
        canRunPython={canRunPython}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onStylePatch={handleStylePatch}
        onAdjustDecimals={handleAdjustDecimals}
        onToggleBorders={handleToggleBorders}
        onToggleMerge={handleToggleMerge}
        onToggleFreeze={() =>
          updateActiveSheet((s) => ({
            ...s,
            frozenRows: s.frozenRows > 0 ? 0 : Math.max(1, selection.anchor.row + 1),
            frozenCols: s.frozenCols > 0 ? 0 : selection.anchor.col > 0 ? 1 : 0,
          }))
        }
        onToggleFilter={handleToggleFilter}
        onOpenCondFormat={() => setShowCondFormatModal(true)}
        onOpenPivot={() => setShowPivotModal(true)}
        onOpenPythonTransform={() => {
          setPythonError(null);
          setShowPythonModal(true);
        }}
        onSort={(dir) => {
          const targetRange: NormalizedRange =
            normRange.startRow === normRange.endRow
              ? { startRow: 1, startCol: 0, endRow: activeSheet.rowCount - 1, endCol: activeSheet.colCount - 1 }
              : normRange;
          updateActiveSheet((s) =>
            sortRangeByColumn(
              {
                ...pendingEditRef.current.workbook,
                sheets: pendingEditRef.current.workbook.sheets.map((sh) => (sh.id === s.id ? s : sh)),
              },
              s.id,
              targetRange,
              selection.anchor.col,
              dir
            )
          );
        }}
        onInsertRow={() =>
          updateActiveSheet((s) => mutateSheetStructure(s, 'row', selection.anchor.row, 1))
        }
        onDeleteRow={() =>
          updateActiveSheet((s) => mutateSheetStructure(s, 'row', selection.anchor.row, -1))
        }
        onInsertCol={() =>
          updateActiveSheet((s) => mutateSheetStructure(s, 'col', selection.anchor.col, 1))
        }
        onDeleteCol={() =>
          updateActiveSheet((s) => mutateSheetStructure(s, 'col', selection.anchor.col, -1))
        }
        onInsertChart={handleInsertChart}
        onCopyToDocs={handleSendToDocs}
        onImportFile={handleImportFile}
        onExport={handleExport}
      />

      <FormulaBar
        addressLabel={rangeToA1(normRange)}
        formulaValue={editingCoord ? editDraft : anchorCell?.raw ?? ''}
        isEditing={editingCoord !== null}
        errorText={anchorComputed?.error}
        onJumpToAddress={(addr) => {
          const parsed = parseAddress(addr);
          if (parsed && parsed.row < activeSheet.rowCount && parsed.col < activeSheet.colCount) {
            setSelection({
              anchor: { row: parsed.row, col: parsed.col },
              focus: { row: parsed.row, col: parsed.col },
            });
          }
        }}
        onStartEdit={() => startEdit(selection.anchor, undefined, 'formulaBar')}
        onChange={setEditDraft}
        onCommit={() => commitEdit('none')}
        onCancel={cancelEdit}
        onOpenFunctionCatalog={() => setShowFnModal(true)}
      />

      {showFind && (
        <div className="no-print bg-slate-50 border-b border-slate-200 px-3 py-1.5 flex items-center gap-2 text-xs">
          <input
            autoFocus
            value={findQuery}
            onChange={(e) => {
              setFindQuery(e.target.value);
              setFindIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                jumpToFindMatch(findIdx + (e.shiftKey ? -1 : 1));
              } else if (e.key === 'Escape') {
                setShowFind(false);
              }
            }}
            placeholder="Find in sheet (values or formulas)…"
            className="w-60 px-2.5 py-1 bg-white border border-slate-300 rounded-md focus:outline-none focus:border-emerald-500"
          />
          <span className="font-mono text-[11px] text-slate-500 min-w-[60px]">
            {findQuery.trim()
              ? findMatches.length > 0
                ? `${Math.min(findIdx + 1, findMatches.length)} / ${findMatches.length}`
                : '0 matches'
              : ''}
          </span>
          <button
            disabled={findMatches.length === 0}
            onClick={() => jumpToFindMatch(findIdx - 1)}
            className="px-2 py-0.5 rounded bg-white border border-slate-200 hover:bg-slate-100 disabled:opacity-40"
          >
            Prev
          </button>
          <button
            disabled={findMatches.length === 0}
            onClick={() => jumpToFindMatch(findIdx + 1)}
            className="px-2 py-0.5 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
          >
            Next
          </button>
          <div className="flex-1" />
          <button
            onClick={() => setShowFind(false)}
            className="px-2 py-0.5 rounded text-slate-500 hover:bg-slate-200"
          >
            Close
          </button>
        </div>
      )}

      <div style={{ zoom }} className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <SpreadsheetGrid
          sheet={activeSheet}
          computed={computedSheet}
          selection={selection}
          editingCoord={editingCoord}
          editDraft={editDraft}
          shouldFocusCellInput={editSource === 'cell'}
          hiddenRows={hiddenRows}
          zoom={zoom}
          onSelect={setSelection}
          onStartEdit={(coord, initialText) => startEdit(coord, initialText, 'cell')}
          onChangeDraft={setEditDraft}
          onCommitEdit={commitEdit}
          onCancelEdit={cancelEdit}
          onFillRange={(src, dst) => updateActiveSheet((s) => fillRangeFromSource(s, src, dst))}
          onBeginStructureDrag={pushUndoSnapshot}
          onResizeCol={(col, width) =>
            updateActiveSheet((s) => ({ ...s, colWidths: { ...s.colWidths, [col]: width } }), false)
          }
          onResizeRow={(row, height) =>
            updateActiveSheet((s) => ({ ...s, rowHeights: { ...s.rowHeights, [row]: height } }), false)
          }
          onContextAction={handleContextAction}
          onUpdateChart={(updated, recordHistory = false) =>
            updateActiveSheet(
              (s) => ({ ...s, charts: s.charts.map((c) => (c.id === updated.id ? updated : c)) }),
              recordHistory
            )
          }
          onDeleteChart={(id) =>
            updateActiveSheet((s) => ({ ...s, charts: s.charts.filter((c) => c.id !== id) }))
          }
          onUpdateColumnFilter={handleUpdateColumnFilter}
          onSortColumn={handleSortByFilterColumn}
        />
      </div>

      <SheetTabs
        sheets={workbook.sheets}
        activeSheetId={activeSheet.id}
        stats={selectionStats}
        zoom={zoom}
        onZoomOut={zoomOut}
        onZoomIn={zoomIn}
        onZoomReset={zoomReset}
        onSelectSheet={(id) => {
          const snapWb = flushPendingEdit();
          onChangeWorkbook({ ...snapWb, activeSheetId: id });
        }}
        onAddSheet={() => {
          const newSheet = createBlankSheet(`Sheet${workbook.sheets.length + 1}`);
          commitWorkbook({
            ...workbook,
            sheets: [...workbook.sheets, newSheet],
            activeSheetId: newSheet.id,
          });
        }}
        onRenameSheet={(id, name) => {
          commitWorkbook({
            ...workbook,
            sheets: workbook.sheets.map((s) => (s.id === id ? { ...s, name } : s)),
          });
        }}
        onDuplicateSheet={(id) => {
          const src = workbook.sheets.find((s) => s.id === id);
          if (!src) return;
          const copy: SheetData = {
            ...JSON.parse(JSON.stringify(src)),
            id: uid('sheet'),
            name: `${src.name} (Copy)`,
          };
          commitWorkbook({
            ...workbook,
            sheets: [...workbook.sheets, copy],
            activeSheetId: copy.id,
          });
        }}
        onDeleteSheet={(id) => {
          if (workbook.sheets.length <= 1) return;
          const remaining = workbook.sheets.filter((s) => s.id !== id);
          commitWorkbook({
            ...workbook,
            sheets: remaining,
            activeSheetId:
              workbook.activeSheetId === id ? remaining[0].id : workbook.activeSheetId,
          });
        }}
      />

      {showFnModal && (
        <FunctionHelpModal
          onInsert={(template) => startEdit(selection.anchor, template, 'cell')}
          onClose={() => setShowFnModal(false)}
        />
      )}

      {showCondFormatModal && (
        <ConditionalFormatModal
          selectedRangeA1={rangeToA1(normRange)}
          rules={activeSheet.conditionalFormats ?? []}
          onAddRule={handleAddCondFormatRule}
          onDeleteRule={handleDeleteCondFormatRule}
          onClose={() => setShowCondFormatModal(false)}
        />
      )}

      {showPivotModal && (
        <PivotModal
          sheet={activeSheet}
          computed={computedSheet}
          initialRangeA1={pivotInitialRangeA1}
          onCreatePivotSheet={handleCreatePivotSheet}
          onClose={() => setShowPivotModal(false)}
        />
      )}

      {showPythonModal && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[1px] flex items-center justify-center p-4"
          onClick={() => !pythonRunning && setShowPythonModal(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-violet-50 text-violet-700 flex items-center justify-center">
                  <Code2 className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-semibold text-slate-900 text-sm">Python Pandas Transform</h3>
                  <p className="text-xs text-slate-500">
                    Run a pandas expression on <code className="font-mono text-violet-700">df</code> and insert the result as a new sheet
                  </p>
                </div>
              </div>
              <button
                onClick={() => !pythonRunning && setShowPythonModal(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <label className="block text-[11px] font-semibold text-slate-600">
                Expression returning a DataFrame
              </label>
              <textarea
                rows={3}
                value={pythonExpr}
                onChange={(e) => setPythonExpr(e.target.value)}
                placeholder="df.describe().reset_index()"
                className="w-full px-3 py-2 font-mono text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500"
              />
              {pythonError && (
                <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-700 font-mono whitespace-pre-wrap">
                  {pythonError}
                </div>
              )}
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  disabled={pythonRunning}
                  onClick={() => setShowPythonModal(false)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100"
                >
                  Cancel
                </button>
                <button
                  disabled={pythonRunning || !pythonExpr.trim()}
                  onClick={() => void handleRunPythonTransform()}
                  className="px-4 py-1.5 rounded-lg text-xs font-semibold text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-40 flex items-center gap-1.5 transition"
                >
                  <Play className="w-3.5 h-3.5" />
                  {pythonRunning ? 'Running…' : 'Run & Insert Sheet'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
