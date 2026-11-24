import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorState } from '@tiptap/pm/state';
import { StandaloneAppKind, WorkspaceFileKind } from './types/office';
import { WorkbookData } from './types/spreadsheet';
import { FormaDocument } from './types/document';
import type { DocumentEditorHandle } from './components/docs/DocsApp';
import { FormaPdfRecord } from './types/pdf';
import { PresentationData } from './types/slides';
import { LabFolderWorkspace, NotebookData } from './types/notebook';
import { CanvasData, CanvasTemplateId } from './types/canvas';
import { CANVASES_KEY } from './storage/canvasStore';
import { createBlankCanvas, createCanvasFromTemplate } from './engine/canvas/canvasTemplates';
import {
  exportCanvasToExcalidraw,
  exportCanvasToFcanvas,
  exportCanvasToPdf,
  exportCanvasToPng,
  exportCanvasToSvg,
  importCanvasFromExcalidraw,
  importCanvasFromFcanvas,
} from './engine/canvas/canvasCodec';
import type { CanvasHistoryEntry, CanvasTransferPayload } from './components/canvas/CanvasApp';
import {
  DOCS_KEY,
  WORKBOOKS_KEY,
  listWorkspaceFiles,
  loadDocuments,
  loadWorkbooks,
  openNativeFileDialog,
  openNativeNewWindow,
  triggerFileDownload,
  wasNativeSaveCancelled,
} from './storage/workspaceStore';
import {
  SLIDES_KEY,
  loadPresentations,
} from './storage/slidesStore';
import {
  NOTEBOOKS_KEY,
  createWorkspaceNotebook,
  findFirstNotebookInTree,
  isNativeWorkspaceAvailable,
  listLabFolder,
  loadNotebooks,
  loadSavedLabFolderPath,
  pickLabFolder,
  readWorkspaceFile,
  saveLabFolderPath,
  writeBinaryWorkspaceFile,
  writeWorkspaceFile,
} from './storage/notebookStore';
import {
  PDFS_KEY,
  clearPdfStreamUrl,
  deletePdfBytes,
  getPdfStreamUrl,
  loadPdfBytes,
  loadPdfRecords,
  resolveNativePdfPath,
  savePdfBytes,
  setPdfStreamUrl,
} from './storage/pdfBlobStore';
import { createBlankWorkbook, uid } from './engine/spreadsheet/workbookOps';
import { createWorkbookFromTemplate, SheetTemplateId } from './engine/spreadsheet/templates';
import {
  createBlankDocument,
  createDocumentFromTemplate,
  DocTemplateId,
} from './engine/document/sampleDocs';
import {
  createBlankPresentation,
  createPresentationFromTemplate,
  SlideTemplateId,
} from './engine/slides/slideTemplates';
import {
  createBlankNotebook,
  createNotebookFromTemplate,
  NotebookTemplateId,
} from './engine/notebook/notebookTemplates';
import {
  exportNotebookToIpynb,
  exportNotebookToMarkdown,
  exportNotebookToPython,
  importNotebookFromIpynb,
} from './engine/notebook/ipynbCodec';
import {
  exportSheetToDelimited,
  importWorkbookFromDelimited,
} from './engine/spreadsheet/formats/csvCodec';
import {
  exportDocumentToMarkdown,
  importDocumentFromMarkdown,
} from './engine/document/formats/markdownCodec';
import { importDocumentFromHtml } from './engine/document/formats/htmlCodec';
import { AppHeader, OpenTabItem } from './components/common/AppHeader';
import { CommandPalette, CommandPaletteCommand } from './components/common/CommandPalette';
import { LocalAiCopilot } from './components/common/LocalAiCopilot';
import {
  flushAllWorkspaceSaves,
  initializeWorkspace,
  loadRecords,
  useStoredRecords,
} from './storage/recordStore';
import {
  extractCanvasIndexText,
  extractDocumentIndexText,
  extractNotebookIndexText,
  extractPdfIndexText,
  extractPresentationIndexText,
  extractWorkbookIndexText,
  isNativeAiAvailable,
  makeWorkspaceIndexInput,
  type WorkspaceIndexEntry,
  indexWorkspaceDocument,
  removeIndexedDocument,
} from './storage/aiSemanticStore';
import { parseRange } from './engine/spreadsheet/address';
import { createWorkbookEvaluator } from './engine/spreadsheet/formulaEngine';
import { rangeToHTMLTable } from './engine/spreadsheet/workbookOps';
import { loadWorkspaceSession, saveWorkspaceSession } from './storage/sessionStore';
import { HomeHub } from './components/common/HomeHub';
import { IndexedFoldersDialog } from './components/common/IndexedFoldersDialog';
import type { SpreadsheetEditorHandle, TableTransferSource, WorkbookHistoryEntry } from './components/sheets/SheetsApp';

// Route-level code splitting so each standalone macOS app only parses its own chunk on cold start
const SheetsApp = lazy(() =>
  import('./components/sheets/SheetsApp').then((m) => ({ default: m.SheetsApp }))
);
const DocsApp = lazy(() =>
  import('./components/docs/DocsApp').then((m) => ({ default: m.DocsApp }))
);
const SlidesApp = lazy(() =>
  import('./components/slides/SlidesApp').then((m) => ({ default: m.SlidesApp }))
);
const PdfApp = lazy(() =>
  import('./components/pdf/PdfApp').then((m) => ({ default: m.PdfApp }))
);
const NotebookApp = lazy(() =>
  import('./components/notebook/NotebookApp').then((m) => ({ default: m.NotebookApp }))
);
const CanvasApp = lazy(() =>
  import('./components/canvas/CanvasApp').then((m) => ({ default: m.CanvasApp }))
);

interface OpenTabRef {
  id: string;
  kind: WorkspaceFileKind;
}

function readStartupParams(): { standaloneKind: StandaloneAppKind; initialFileId: string | null } {
  try {
    const params = new URLSearchParams(window.location.search);
    const app = params.get('app')?.toLowerCase();
    const standaloneKind: StandaloneAppKind =
      app === 'sheets'
        ? 'sheets'
        : app === 'docs'
          ? 'docs'
          : app === 'slides'
            ? 'slides'
            : app === 'pdf'
              ? 'pdf'
              : app === 'lab'
                ? 'lab'
                : app === 'canvas'
                  ? 'canvas'
                  : null;
    const initialFileId = params.get('file') || null;
    return { standaloneKind, initialFileId };
  } catch {
    return { standaloneKind: null, initialFileId: null };
  }
}

export const App: React.FC = () => {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    initializeWorkspace([WORKBOOKS_KEY, DOCS_KEY, SLIDES_KEY, NOTEBOOKS_KEY, PDFS_KEY, CANVASES_KEY])
      .then(() => { if (!cancelled) setReady(true); })
      .catch((err) => { if (!cancelled) setError(String(err.message)); });
    return () => { cancelled = true; };
  }, [attempt]);
  if (!ready) return <div className="h-screen flex flex-col gap-4 items-center justify-center">
    <p>{error || 'Opening your workspace…'}</p>
    {error && <button onClick={() => { setError(''); setAttempt(attempt + 1); }}>Retry</button>}
  </div>;
  return <WorkspaceApp />;
};

const WorkspaceApp: React.FC = () => {
  const { standaloneKind, initialFileId } = useMemo(() => readStartupParams(), []);

  const editorStates = useRef(new Map<string, { html: string; state: EditorState }>());
  const documentEditor = useRef<DocumentEditorHandle>(null);
  const sheetHistories = useRef(new Map<string, WorkbookHistoryEntry>());
  const canvasHistories = useRef(new Map<string, CanvasHistoryEntry>());
  const spreadsheetEditor = useRef<SpreadsheetEditorHandle>(null);
  const [pendingDocumentId, setPendingDocumentId] = useState<string | null>(null);
  const handlePendingDocumentChange = useCallback((id: string, pending: boolean) => {
    setPendingDocumentId((current) => pending ? id : current === id ? null : current);
  }, []);
  const workbooksStore = useStoredRecords<WorkbookData>(WORKBOOKS_KEY);
  const { items: workbooks, setItems: setWorkbooks } = workbooksStore;
  const getWorkbookSnapshot = useCallback((id: string) =>
    spreadsheetEditor.current?.id === id
      ? spreadsheetEditor.current.snapshot()
      : workbooks.find((item) => item.id === id), [workbooks]);
  const documentsStore = useStoredRecords<FormaDocument>(DOCS_KEY);
  const { items: documents, setItems: setDocuments } = documentsStore;
  const getDocumentSnapshot = useCallback((id: string) =>
    documentEditor.current?.id === id
      ? documentEditor.current.snapshot()
      : documents.find((item) => item.id === id), [documents]);
  const presentationsStore = useStoredRecords<PresentationData>(SLIDES_KEY);
  const { items: presentations, setItems: setPresentations } = presentationsStore;
  const notebooksStore = useStoredRecords<NotebookData>(NOTEBOOKS_KEY);
  const { items: notebooks, setItems: setNotebooks } = notebooksStore;
  const [labFolder, setLabFolder] = useState<LabFolderWorkspace | null>(null);
  const pdfsStore = useStoredRecords<FormaPdfRecord>(PDFS_KEY);
  const { items: pdfs, setItems: setPdfs } = pdfsStore;
  const canvasesStore = useStoredRecords<CanvasData>(CANVASES_KEY);
  const { items: canvases, setItems: setCanvases } = canvasesStore;

  const initialStartupTab = useMemo<OpenTabRef | null>(() => {
    if (!initialFileId) return null;
    if (workbooks.some((w) => w.id === initialFileId)) {
      return { id: initialFileId, kind: 'spreadsheet' };
    }
    if (documents.some((d) => d.id === initialFileId)) {
      return { id: initialFileId, kind: 'document' };
    }
    if (presentations.some((p) => p.id === initialFileId)) {
      return { id: initialFileId, kind: 'slides' };
    }
    if (notebooks.some((n) => n.id === initialFileId)) {
      return { id: initialFileId, kind: 'notebook' };
    }
    if (canvases.some((c) => c.id === initialFileId)) {
      return { id: initialFileId, kind: 'canvas' };
    }
    if (pdfs.some((p) => p.id === initialFileId)) {
      return { id: initialFileId, kind: 'pdf' };
    }
    return null;
  }, [initialFileId, workbooks, documents, presentations, notebooks, canvases, pdfs]);

  const sessionScope = standaloneKind ?? 'suite';
  const restoredSession = useMemo(() => {
    if (initialStartupTab) return null;
    const saved = loadWorkspaceSession(sessionScope);
    if (!saved) return null;
    const exists = (ref: OpenTabRef) => {
      if (ref.kind === 'spreadsheet') return workbooks.some((w) => w.id === ref.id);
      if (ref.kind === 'document') return documents.some((d) => d.id === ref.id);
      if (ref.kind === 'slides') return presentations.some((p) => p.id === ref.id);
      if (ref.kind === 'notebook') return notebooks.some((n) => n.id === ref.id);
      if (ref.kind === 'canvas') return canvases.some((c) => c.id === ref.id);
      return pdfs.some((p) => p.id === ref.id);
    };
    const validTabs = saved.openTabs.filter(exists);
    if (validTabs.length === 0) return null;
    const validActive =
      saved.activeTabId && validTabs.some((t) => t.id === saved.activeTabId)
        ? saved.activeTabId
        : validTabs[0].id;
    return {
      openTabs: validTabs,
      activeTabId: validActive,
      showingHub: saved.showingHub,
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [openTabs, setOpenTabs] = useState<OpenTabRef[]>(() =>
    initialStartupTab ? [initialStartupTab] : restoredSession?.openTabs ?? []
  );
  const [activeTabId, setActiveTabId] = useState<string | null>(() =>
    initialStartupTab ? initialStartupTab.id : restoredSession?.activeTabId ?? null
  );
  const [showingHub, setShowingHub] = useState<boolean>(() =>
    initialStartupTab ? false : restoredSession ? restoredSession.showingHub : true
  );
  const [pdfReadingMode, setPdfReadingMode] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showIndexedFolders, setShowIndexedFolders] = useState(false);
  const workspaceIndexLaunchTime = useRef(Date.now());
  const indexedVersions = useRef(new Map<string, number>());
  const [showAiCopilot, setShowAiCopilot] = useState(false);
  const [externalChangedPath, setExternalChangedPath] = useState<string | null>(null);
  const [pdfBlobStatus, setPdfBlobStatus] = useState<
    Record<string, 'saving' | 'persisted' | 'session-only' | 'save-failed'>
  >({});
  const pdfRetryFilesRef = useRef(new Map<string, File>());
  const [pendingDocInsert, setPendingDocInsert] = useState<{
    html: string;
    label: string;
    nonce: number;
    kind?: 'table' | 'canvas';
  } | null>(null);
  const [pendingTableTransfer, setPendingTableTransfer] = useState<{
    htmlTable: string;
    label: string;
    meta?: TableTransferSource;
  } | null>(null);
  const [pendingCanvasTransfer, setPendingCanvasTransfer] = useState<CanvasTransferPayload | null>(null);

  useEffect(() => {
    saveWorkspaceSession(sessionScope, { openTabs, activeTabId, showingHub });
  }, [sessionScope, openTabs, activeTabId, showingHub]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  const openFileInTab = useCallback((id: string, kind: WorkspaceFileKind) => {
    setOpenTabs((prev) => (prev.some((t) => t.id === id) ? prev : [...prev, { id, kind }]));
    setActiveTabId(id);
    setShowingHub(false);
  }, []);

  const handleCloseTab = useCallback(
    (id: string) => {
      setOpenTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === id);
        if (idx === -1) return prev;
        const next = prev.filter((t) => t.id !== id);
        if (activeTabId === id) {
          if (next.length === 0) {
            setActiveTabId(null);
            setShowingHub(true);
          } else {
            const fallback = next[Math.min(idx, next.length - 1)];
            setActiveTabId(fallback.id);
          }
        }
        return next;
      });
    },
    [activeTabId]
  );

  const handleCloseOtherTabs = useCallback((keepId: string) => {
    setOpenTabs((prev) => prev.filter((t) => t.id === keepId));
    setActiveTabId(keepId);
    setShowingHub(false);
  }, []);

  const handleUpdateWorkbook = useCallback((updated: WorkbookData) => {
    setWorkbooks((prev) => prev.map((w) => (w.id === updated.id ? updated : w)));
  }, []);

  const handleUpdateDocument = useCallback((updated: FormaDocument) => {
    setDocuments((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
  }, []);

  const handleUpdatePresentation = useCallback((updated: PresentationData) => {
    setPresentations((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  }, []);

  const handleUpdateNotebook = useCallback((updated: NotebookData) => {
    setNotebooks((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
  }, []);

  const handleUpdateCanvas = useCallback((updated: CanvasData) => {
    setCanvases((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
  }, []);

  // Restore last opened Forma Lab folder workspace on launch
  useEffect(() => {
    if (!isNativeWorkspaceAvailable()) return;
    if (standaloneKind && standaloneKind !== 'lab') return;
    const saved = loadSavedLabFolderPath();
    if (!saved) return;
    void listLabFolder(saved)
      .then((ws) => {
        if (ws) setLabFolder(ws);
      })
      .catch(() => {});
  }, [standaloneKind]);

  const handleOpenFolderNotebook = useCallback(
    async (filePath: string) => {
      const existing = notebooks.find((n) => n.nativePath === filePath);
      if (existing) {
        openFileInTab(existing.id, 'notebook');
        return;
      }
      try {
        const res = await readWorkspaceFile(filePath);
        if (!res) {
          notify(`Could not read ${filePath.split('/').pop()}`);
          return;
        }
        const nb = importNotebookFromIpynb(res.content, res.name);
        nb.nativePath = res.path;
        setNotebooks((prev) => [nb, ...prev]);
        openFileInTab(nb.id, 'notebook');
        notify(`Opened ${res.name}`);
      } catch (err) {
        notify(`Could not open notebook: ${(err as Error).message}`);
      }
    },
    [notebooks, openFileInTab, notify]
  );

  const activateLabFolderWorkspace = useCallback(
    async (ws: LabFolderWorkspace) => {
      setLabFolder(ws);
      saveLabFolderPath(ws.rootPath);
      const firstNb = findFirstNotebookInTree(ws.entries);
      if (firstNb) {
        await handleOpenFolderNotebook(firstNb.path);
      } else {
        // Ensure Lab workspace view is visible so user sees the folder tree immediately
        const existingNb = notebooks[0];
        if (existingNb) {
          openFileInTab(existingNb.id, 'notebook');
        } else {
          const blank = createBlankNotebook(`${ws.rootName} Scratchpad`);
          setNotebooks((prev) => [blank, ...prev]);
          openFileInTab(blank.id, 'notebook');
        }
        notify(`Opened folder "${ws.rootName}"`);
      }
    },
    [handleOpenFolderNotebook, notebooks, openFileInTab, notify]
  );

  const handlePickLabFolder = useCallback(async () => {
    if (!isNativeWorkspaceAvailable()) {
      notify('Open Folder is available inside the native Forma Lab.app');
      return;
    }
    try {
      const ws = await pickLabFolder();
      if (!ws) return;
      await activateLabFolderWorkspace(ws);
    } catch (err) {
      notify(`Could not open folder: ${(err as Error).message}`);
    }
  }, [activateLabFolderWorkspace, notify]);

  const handleOpenNativeFolderPath = useCallback(
    async (folderPath: string) => {
      if (!isNativeWorkspaceAvailable()) return;
      try {
        const ws = await listLabFolder(folderPath);
        if (ws) await activateLabFolderWorkspace(ws);
      } catch (err) {
        notify(`Could not open folder: ${(err as Error).message}`);
      }
    },
    [activateLabFolderWorkspace, notify]
  );

  const handleRefreshLabFolder = useCallback(async () => {
    if (!labFolder || !isNativeWorkspaceAvailable()) return;
    try {
      const ws = await listLabFolder(labFolder.rootPath);
      if (ws) {
        setLabFolder(ws);
        notify(`Refreshed ${ws.rootName}`);
      }
    } catch {
      // ignore
    }
  }, [labFolder, notify]);

  const handleCreateNotebookInDir = useCallback(
    async (dirPath: string) => {
      const raw = window.prompt('New notebook filename:', 'untitled.ipynb')?.trim();
      if (!raw) return;
      const title = raw.replace(/\.ipynb$/i, '') || 'untitled';
      const blank = createBlankNotebook(title);
      try {
        const created = await createWorkspaceNotebook(dirPath, raw, exportNotebookToIpynb(blank));
        if (!created) {
          notify('Could not create notebook in folder');
          return;
        }
        blank.nativePath = created.path;
        setNotebooks((prev) => [blank, ...prev]);
        openFileInTab(blank.id, 'notebook');
        if (labFolder) {
          const refreshed = await listLabFolder(labFolder.rootPath);
          if (refreshed) setLabFolder(refreshed);
        }
        notify(`Created ${created.name}`);
      } catch (err) {
        notify(`Create failed: ${(err as Error).message}`);
      }
    },
    [labFolder, openFileInTab, notify]
  );

  const handleUpdatePdf = useCallback((updated: FormaPdfRecord) => {
    setPdfs((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  }, []);

  const addPdfRecordFromStream = useCallback(
    (streamUrl: string, title: string, sizeBytes: number, nativePath?: string, id = uid('pdf')) => {
      // If same native file is already in Recent list, reopen it directly
      if (nativePath) {
        const existing = pdfs.find((p) => p.nativePath === nativePath);
        if (existing) {
          setPdfStreamUrl(existing.id, streamUrl);
          openFileInTab(existing.id, 'pdf');
          return existing;
        }
      }
      setPdfStreamUrl(id, streamUrl);
      const now = Date.now();
      const rec: FormaPdfRecord = {
        id,
        title,
        pageCount: 0, // populated instantaneously by pdf.js from trailer
        sizeBytes,
        annotations: [],
        createdAt: now,
        updatedAt: now,
        nativePath,
      };
      setPdfs((prev) => [rec, ...prev]);
      openFileInTab(id, 'pdf');
      return rec;
    },
    [pdfs, openFileInTab]
  );

  const addPdfRecordFromBytes = useCallback(
    async (bytes: Uint8Array, title: string) => {
      const id = uid('pdf');
      const { getPdfPageCount } = await import('./engine/pdf/pdfEngine');
      const pageCount = await getPdfPageCount(bytes);
      await savePdfBytes(id, bytes);
      const now = Date.now();
      const rec: FormaPdfRecord = {
        id,
        title,
        pageCount,
        sizeBytes: bytes.byteLength,
        annotations: [],
        createdAt: now,
        updatedAt: now,
      };
      setPdfs((prev) => [rec, ...prev]);
      openFileInTab(id, 'pdf');
      return rec;
    },
    [openFileInTab]
  );

  const handleCreateSheetTemplate = useCallback(
    (templateId: SheetTemplateId) => {
      const wb = createWorkbookFromTemplate(templateId);
      setWorkbooks((prev) => [wb, ...prev]);
      openFileInTab(wb.id, 'spreadsheet');
      notify(`Created ${wb.title}`);
    },
    [openFileInTab, notify]
  );

  const handleCreateDocTemplate = useCallback(
    (templateId: DocTemplateId) => {
      const doc = createDocumentFromTemplate(templateId);
      setDocuments((prev) => [doc, ...prev]);
      openFileInTab(doc.id, 'document');
      notify(`Created ${doc.title}`);
    },
    [openFileInTab, notify]
  );

  const handleCreateSlideTemplate = useCallback(
    (templateId: SlideTemplateId) => {
      const deck = createPresentationFromTemplate(templateId);
      setPresentations((prev) => [deck, ...prev]);
      openFileInTab(deck.id, 'slides');
      notify(`Created ${deck.title}`);
    },
    [openFileInTab, notify]
  );

  const handleCreateNotebookTemplate = useCallback(
    (templateId: NotebookTemplateId) => {
      const nb = createNotebookFromTemplate(templateId);
      setNotebooks((prev) => [nb, ...prev]);
      openFileInTab(nb.id, 'notebook');
      notify(`Created ${nb.title}`);
    },
    [openFileInTab, notify]
  );

  const handleCreateCanvasTemplate = useCallback(
    (templateId: CanvasTemplateId) => {
      const canvas = createCanvasFromTemplate(templateId);
      setCanvases((prev) => [canvas, ...prev]);
      openFileInTab(canvas.id, 'canvas');
      notify(`Created ${canvas.title}`);
    },
    [openFileInTab, notify]
  );

  const handleCreatePdfTemplate = useCallback(
    async (templateId: 'blank' | 'report') => {
      try {
        const { createBlankPdfBytes, createSampleReportPdfBytes } = await import('./engine/pdf/pdfEngine');
        const bytes =
          templateId === 'report'
            ? await createSampleReportPdfBytes()
            : await createBlankPdfBytes();
        const title =
          templateId === 'report' ? 'Q4 Executive Report' : `Untitled PDF${pdfs.length > 0 ? ` ${pdfs.length + 1}` : ''}`;
        await addPdfRecordFromBytes(bytes, title);
        notify(`Created ${title}`);
      } catch (err) {
        notify(`Could not create PDF: ${(err as Error).message}`);
      }
    },
    [addPdfRecordFromBytes, pdfs.length, notify]
  );

  const handleMergePdfFiles = useCallback(
    async (fileList: File[]) => {
      try {
        const { mergePdfBytes } = await import('./engine/pdf/pdfEngine');
        const byteArrays = await Promise.all(
          fileList.map(async (f) => new Uint8Array(await f.arrayBuffer()))
        );
        const merged = await mergePdfBytes(byteArrays);
        await addPdfRecordFromBytes(merged, `Merged PDF (${fileList.length} files)`);
        notify(`Merged ${fileList.length} PDF files`);
      } catch (err) {
        notify(`Merge failed: ${(err as Error).message}`);
      }
    },
    [addPdfRecordFromBytes, notify]
  );

  const handleCreateBlank = useCallback(
    (kind: WorkspaceFileKind) => {
      if (kind === 'spreadsheet') {
        const wb = createBlankWorkbook(
          `Untitled Workbook${workbooks.length > 0 ? ` ${workbooks.length + 1}` : ''}`
        );
        setWorkbooks((prev) => [wb, ...prev]);
        openFileInTab(wb.id, 'spreadsheet');
      } else if (kind === 'document') {
        const doc = createBlankDocument(
          `Untitled Document${documents.length > 0 ? ` ${documents.length + 1}` : ''}`
        );
        setDocuments((prev) => [doc, ...prev]);
        openFileInTab(doc.id, 'document');
      } else if (kind === 'slides') {
        const deck = createBlankPresentation(
          `Untitled Presentation${presentations.length > 0 ? ` ${presentations.length + 1}` : ''}`
        );
        setPresentations((prev) => [deck, ...prev]);
        openFileInTab(deck.id, 'slides');
      } else if (kind === 'notebook') {
        const nb = createBlankNotebook(
          `Untitled Notebook${notebooks.length > 0 ? ` ${notebooks.length + 1}` : ''}`
        );
        setNotebooks((prev) => [nb, ...prev]);
        openFileInTab(nb.id, 'notebook');
      } else if (kind === 'canvas') {
        const canvas = createBlankCanvas(
          `Untitled Canvas${canvases.length > 0 ? ` ${canvases.length + 1}` : ''}`
        );
        setCanvases((prev) => [canvas, ...prev]);
        openFileInTab(canvas.id, 'canvas');
      } else {
        // For PDFs, "+" opens the native Open PDF dialog (or Hub in browser) rather than an empty Untitled PDF
        if (!openNativeFileDialog()) {
          setShowingHub(true);
        }
      }
    },
    [workbooks.length, documents.length, presentations.length, notebooks.length, canvases.length, openFileInTab]
  );

  const handleImportNewWorkbook = useCallback(
    (wb: WorkbookData) => {
      if (wb.nativePath) {
        const existing = workbooks.find((w) => w.nativePath === wb.nativePath);
        if (existing) {
          sheetHistories.current.delete(existing.id);
          const merged: WorkbookData = {
            ...wb,
            id: existing.id,
            pinned: existing.pinned,
            createdAt: existing.createdAt,
            updatedAt: Date.now(),
          };
          setWorkbooks((prev) => prev.map((w) => (w.id === existing.id ? merged : w)));
          openFileInTab(existing.id, 'spreadsheet');
          return;
        }
      }
      setWorkbooks((prev) => [wb, ...prev]);
      openFileInTab(wb.id, 'spreadsheet');
    },
    [workbooks, openFileInTab]
  );

  const handleImportNewPresentation = useCallback(
    (deck: PresentationData) => {
      if (deck.nativePath) {
        const existing = presentations.find((p) => p.nativePath === deck.nativePath);
        if (existing) {
          const merged: PresentationData = {
            ...deck,
            id: existing.id,
            pinned: existing.pinned,
            createdAt: existing.createdAt,
            updatedAt: Date.now(),
          };
          setPresentations((prev) => prev.map((p) => (p.id === existing.id ? merged : p)));
          openFileInTab(existing.id, 'slides');
          return;
        }
      }
      setPresentations((prev) => [deck, ...prev]);
      openFileInTab(deck.id, 'slides');
    },
    [presentations, openFileInTab]
  );

  const handleImportNewDocument = useCallback(
    (doc: FormaDocument) => {
      if (doc.nativePath) {
        const existing = documents.find((d) => d.nativePath === doc.nativePath);
        if (existing) {
          editorStates.current.delete(existing.id);
          const merged: FormaDocument = {
            ...doc,
            id: existing.id,
            pinned: existing.pinned,
            createdAt: existing.createdAt,
            updatedAt: Date.now(),
          };
          setDocuments((prev) => prev.map((d) => (d.id === existing.id ? merged : d)));
          openFileInTab(existing.id, 'document');
          return;
        }
      }
      setDocuments((prev) => [doc, ...prev]);
      openFileInTab(doc.id, 'document');
    },
    [documents, openFileInTab]
  );

  const handleImportNewCanvas = useCallback(
    (canvas: CanvasData) => {
      if (canvas.nativePath) {
        const existing = canvases.find((c) => c.nativePath === canvas.nativePath);
        if (existing) {
          canvasHistories.current.delete(existing.id);
          const merged: CanvasData = {
            ...canvas,
            id: existing.id,
            pinned: existing.pinned,
            createdAt: existing.createdAt,
            updatedAt: Date.now(),
          };
          setCanvases((prev) => prev.map((c) => (c.id === existing.id ? merged : c)));
          openFileInTab(existing.id, 'canvas');
          return;
        }
      }
      setCanvases((prev) => [canvas, ...prev]);
      openFileInTab(canvas.id, 'canvas');
    },
    [canvases, openFileInTab]
  );

  const handleImportAnyFile = useCallback(
    async (file: File, nativePath?: string) => {
      const ext = file.name.split('.').pop()?.toLowerCase();
      try {
        if (ext === 'xlsx') {
          const { importWorkbookFromXlsx } = await import('./engine/spreadsheet/formats/xlsxCodec');
          const wb = await importWorkbookFromXlsx(await file.arrayBuffer(), file.name);
          wb.sourceFormat = 'xlsx';
          if (nativePath) wb.nativePath = nativePath;
          handleImportNewWorkbook(wb);
        } else if (ext === 'ods') {
          const { importWorkbookFromOds } = await import('./engine/spreadsheet/formats/odsCodec');
          const wb = await importWorkbookFromOds(await file.arrayBuffer(), file.name);
          wb.sourceFormat = 'ods';
          if (nativePath) wb.nativePath = nativePath;
          handleImportNewWorkbook(wb);
        } else if (ext === 'csv') {
          const wb = importWorkbookFromDelimited(await file.text(), file.name, ',');
          wb.sourceFormat = 'csv';
          if (nativePath) wb.nativePath = nativePath;
          handleImportNewWorkbook(wb);
        } else if (ext === 'tsv') {
          const wb = importWorkbookFromDelimited(await file.text(), file.name, '\t');
          wb.sourceFormat = 'tsv';
          if (nativePath) wb.nativePath = nativePath;
          handleImportNewWorkbook(wb);
        } else if (ext === 'docx') {
          const { importDocumentFromDocx } = await import('./engine/document/formats/docxCodec');
          const doc = await importDocumentFromDocx(await file.arrayBuffer(), file.name);
          if (nativePath) doc.nativePath = nativePath;
          handleImportNewDocument(doc);
        } else if (ext === 'odt') {
          const { importDocumentFromOdt } = await import('./engine/document/formats/odtCodec');
          const doc = await importDocumentFromOdt(await file.arrayBuffer(), file.name);
          if (nativePath) doc.nativePath = nativePath;
          handleImportNewDocument(doc);
        } else if (ext === 'md' || ext === 'markdown') {
          const doc = importDocumentFromMarkdown(await file.text(), file.name);
          if (nativePath) doc.nativePath = nativePath;
          handleImportNewDocument(doc);
        } else if (ext === 'html' || ext === 'htm') {
          const doc = importDocumentFromHtml(await file.text(), file.name);
          if (nativePath) doc.nativePath = nativePath;
          handleImportNewDocument(doc);
        } else if (ext === 'pptx') {
          const { importPresentationFromPptx } = await import('./engine/slides/formats/pptxCodec');
          const deck = await importPresentationFromPptx(await file.arrayBuffer(), file.name);
          deck.sourceFormat = 'pptx';
          if (nativePath) deck.nativePath = nativePath;
          handleImportNewPresentation(deck);
        } else if (ext === 'odp') {
          const { importPresentationFromOdp } = await import('./engine/slides/formats/odpCodec');
          const deck = await importPresentationFromOdp(await file.arrayBuffer(), file.name);
          deck.sourceFormat = 'odp';
          if (nativePath) deck.nativePath = nativePath;
          handleImportNewPresentation(deck);
        } else if (ext === 'ipynb') {
          if (nativePath) {
            const existing = notebooks.find((n) => n.nativePath === nativePath);
            if (existing) {
              openFileInTab(existing.id, 'notebook');
              notify(`Opened ${file.name}`);
              return;
            }
          }
          const nb = importNotebookFromIpynb(await file.text(), file.name);
          if (nativePath) nb.nativePath = nativePath;
          setNotebooks((prev) => [nb, ...prev]);
          openFileInTab(nb.id, 'notebook');
        } else if (ext === 'fcanvas') {
          const canvas = importCanvasFromFcanvas(await file.text(), file.name);
          canvas.sourceFormat = 'fcanvas';
          if (nativePath) canvas.nativePath = nativePath;
          handleImportNewCanvas(canvas);
        } else if (ext === 'excalidraw') {
          const canvas = importCanvasFromExcalidraw(await file.text(), file.name);
          canvas.sourceFormat = 'excalidraw';
          if (nativePath) canvas.nativePath = nativePath;
          handleImportNewCanvas(canvas);
        } else if (ext === 'pdf') {
          // Instant zero-copy open via Blob URL (skip pdf-lib full parse and IDB blocking on open!)
          const id = uid('pdf');
          const blobUrl = URL.createObjectURL(file);
          addPdfRecordFromStream(blobUrl, file.name.replace(/\.pdf$/i, ''), file.size, nativePath, id);
          if (!nativePath) {
            if (file.size <= 40 * 1024 * 1024) {
              pdfRetryFilesRef.current.set(id, file);
              setPdfBlobStatus((prev) => ({ ...prev, [id]: 'saving' }));
              void file
                .arrayBuffer()
                .then((ab) => savePdfBytes(id, new Uint8Array(ab)))
                .then(() => {
                  pdfRetryFilesRef.current.delete(id);
                  setPdfBlobStatus((prev) => ({ ...prev, [id]: 'persisted' }));
                })
                .catch(() => {
                  setPdfBlobStatus((prev) => ({ ...prev, [id]: 'save-failed' }));
                });
            } else {
              setPdfBlobStatus((prev) => ({ ...prev, [id]: 'session-only' }));
            }
          }
        } else {
          notify(`Unsupported file extension: .${ext}`);
          return;
        }
        notify(`Opened ${file.name}`);
      } catch (err) {
        notify(`Could not open ${file.name}: ${(err as Error).message}`);
      }
    },
    [
      handleImportNewWorkbook,
      handleImportNewDocument,
      handleImportNewPresentation,
      handleImportNewCanvas,
      addPdfRecordFromStream,
      notebooks,
      openFileInTab,
      notify,
    ]
  );

  // Keep latest handlers in a ref so the native macOS bridge registers ONCE (no churn on state updates)
  const nativeBridgeRef = useRef({
    handleImportAnyFile,
    addPdfRecordFromStream,
    handleCreateBlank,
    handlePickLabFolder,
    handleOpenNativeFolderPath,
    showingHub,
    activeTabId,
    handleCloseTab,
    notify,
  });
  nativeBridgeRef.current = {
    handleImportAnyFile,
    addPdfRecordFromStream,
    handleCreateBlank,
    handlePickLabFolder,
    handleOpenNativeFolderPath,
    showingHub,
    activeTabId,
    handleCloseTab,
    notify,
  };

  // Native macOS Menu Bar & Finder Open Hooks (registered once on mount)
  useEffect(() => {
    const w = window as unknown as {
      __formaOpenNativeFile?: (filename: string, base64: string, filePath?: string) => void;
      __formaOpenNativeStream?: (
        streamUrl: string,
        filename: string,
        _fileSize: number,
        filePath: string
      ) => void;
      __formaOpenNativePdfStream?: (
        streamUrl: string,
        filename: string,
        fileSize: number,
        filePath: string
      ) => void;
      __formaFlushBeforeClose?: () => Promise<boolean>;
      __formaExternalFileChanged?: (path: string) => void;
      __formaCreateNew?: (kind: WorkspaceFileKind) => void;
      __formaShowHub?: () => void;
      __formaCloseActiveTab?: () => boolean;
      __formaOpenFolder?: () => void;
      __formaOpenNativeFolder?: (folderPath: string) => void;
      __formaPendingNativeFiles?: Array<{ filename: string; base64: string; filePath?: string }>;
      webkit?: {
        messageHandlers?: {
          formaAppReady?: { postMessage: (payload: { ready: boolean }) => void };
        };
      };
    };

    const openBase64File = (filename: string, base64: string, filePath?: string) => {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], filename);
      void nativeBridgeRef.current.handleImportAnyFile(file, filePath);
    };

    w.__formaOpenNativeFile = openBase64File;
    w.__formaOpenNativeStream = (
      streamUrl: string,
      filename: string,
      _fileSize: number,
      filePath: string
    ) => {
      void fetch(streamUrl)
        .then(async (resp) => {
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const blob = await resp.blob();
          const file = new File([blob], filename);
          await nativeBridgeRef.current.handleImportAnyFile(file, filePath);
        })
        .catch((err) => {
          nativeBridgeRef.current.notify(`Could not open ${filename}: ${(err as Error).message}`);
        });
    };
    w.__formaOpenNativePdfStream = (
      streamUrl: string,
      filename: string,
      fileSize: number,
      filePath: string
    ) => {
      nativeBridgeRef.current.addPdfRecordFromStream(
        streamUrl,
        filename.replace(/\.pdf$/i, ''),
        fileSize,
        filePath
      );
      nativeBridgeRef.current.notify(`Opened ${filename}`);
    };
    w.__formaFlushBeforeClose = async () => {
      try {
        documentEditor.current?.snapshot();
        spreadsheetEditor.current?.snapshot();
        return await flushAllWorkspaceSaves();
      } catch {
        return false;
      }
    };
    w.__formaExternalFileChanged = (filePath: string) => {
      setExternalChangedPath(filePath);
    };
    w.__formaCreateNew = (kind: WorkspaceFileKind) => {
      nativeBridgeRef.current.handleCreateBlank(kind);
    };
    w.__formaShowHub = () => {
      setShowingHub(true);
    };
    w.__formaCloseActiveTab = () => {
      const cur = nativeBridgeRef.current;
      if (!cur.showingHub && cur.activeTabId) {
        cur.handleCloseTab(cur.activeTabId);
        return true;
      }
      return false;
    };
    w.__formaOpenFolder = () => {
      void nativeBridgeRef.current.handlePickLabFolder();
    };
    w.__formaOpenNativeFolder = (folderPath: string) => {
      void nativeBridgeRef.current.handleOpenNativeFolderPath(folderPath);
    };

    if (Array.isArray(w.__formaPendingNativeFiles) && w.__formaPendingNativeFiles.length > 0) {
      const queued = w.__formaPendingNativeFiles.splice(0);
      queued.forEach((item) => openBase64File(item.filename, item.base64, item.filePath));
    }

    w.webkit?.messageHandlers?.formaAppReady?.postMessage({ ready: true });

    return () => {
      delete w.__formaOpenNativeFile;
      delete w.__formaOpenNativeStream;
      delete w.__formaOpenNativePdfStream;
      delete w.__formaFlushBeforeClose;
      delete w.__formaExternalFileChanged;
      delete w.__formaCreateNew;
      delete w.__formaShowHub;
      delete w.__formaCloseActiveTab;
      delete w.__formaOpenFolder;
      delete w.__formaOpenNativeFolder;
    };
  }, []);

  // Tab switching keyboard shortcuts (Cmd/Ctrl + 1..9)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        const num = parseInt(e.key, 10);
        if (num >= 1 && num <= 9 && openTabs[num - 1]) {
          e.preventDefault();
          const t = openTabs[num - 1];
          setActiveTabId(t.id);
          setShowingHub(false);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openTabs]);

  const handleRenameFile = useCallback(
    (id: string, kind: WorkspaceFileKind, nextTitle?: string) => {
      const current =
        kind === 'spreadsheet'
          ? workbooks.find((w) => w.id === id)?.title
          : kind === 'document'
            ? documents.find((d) => d.id === id)?.title
            : kind === 'slides'
              ? presentations.find((p) => p.id === id)?.title
              : kind === 'notebook'
                ? notebooks.find((n) => n.id === id)?.title
                : kind === 'canvas'
                  ? canvases.find((c) => c.id === id)?.title
                  : pdfs.find((p) => p.id === id)?.title;
      const finalTitle =
        nextTitle !== undefined ? nextTitle : window.prompt('Rename file:', current ?? '')?.trim();
      if (!finalTitle) return;
      if (kind === 'spreadsheet') {
        const snap = getWorkbookSnapshot(id);
        setWorkbooks((prev) =>
          prev.map((w) => (w.id === id ? { ...(snap ?? w), title: finalTitle, updatedAt: Date.now() } : w))
        );
      } else if (kind === 'document') {
        const snap = getDocumentSnapshot(id);
        setDocuments((prev) =>
          prev.map((d) =>
            d.id === id ? { ...(snap ?? d), title: finalTitle, updatedAt: Date.now() } : d
          )
        );
      } else if (kind === 'slides') {
        setPresentations((prev) =>
          prev.map((p) => (p.id === id ? { ...p, title: finalTitle, updatedAt: Date.now() } : p))
        );
      } else if (kind === 'notebook') {
        setNotebooks((prev) =>
          prev.map((n) => (n.id === id ? { ...n, title: finalTitle, updatedAt: Date.now() } : n))
        );
      } else if (kind === 'canvas') {
        setCanvases((prev) =>
          prev.map((c) => (c.id === id ? { ...c, title: finalTitle, updatedAt: Date.now() } : c))
        );
      } else {
        setPdfs((prev) =>
          prev.map((p) => (p.id === id ? { ...p, title: finalTitle, updatedAt: Date.now() } : p))
        );
      }
    },
    [workbooks, documents, presentations, notebooks, canvases, pdfs]
  );

  const handleDuplicateFile = useCallback(
    async (id: string, kind: WorkspaceFileKind) => {
      const now = Date.now();
      if (kind === 'spreadsheet') {
        const orig = getWorkbookSnapshot(id);
        if (!orig) return;
        const copy: WorkbookData = {
          ...JSON.parse(JSON.stringify(orig)),
          id: uid('wb'),
          nativePath: undefined,
          title: `${orig.title} (Copy)`,
          createdAt: now,
          updatedAt: now,
          pinned: false,
        };
        setWorkbooks((prev) => [copy, ...prev]);
        openFileInTab(copy.id, 'spreadsheet');
        notify(`Duplicated "${orig.title}"`);
      } else if (kind === 'document') {
        const orig = getDocumentSnapshot(id);
        if (!orig) return;
        const copy: FormaDocument = {
          ...JSON.parse(JSON.stringify(orig)),
          id: uid('doc'),
          nativePath: undefined,
          title: `${orig.title} (Copy)`,
          createdAt: now,
          updatedAt: now,
          pinned: false,
        };
        setDocuments((prev) => [copy, ...prev]);
        openFileInTab(copy.id, 'document');
        notify(`Duplicated "${orig.title}"`);
      } else if (kind === 'slides') {
        const orig = presentations.find((p) => p.id === id);
        if (!orig) return;
        const copy: PresentationData = {
          ...JSON.parse(JSON.stringify(orig)),
          id: uid('deck'),
          nativePath: undefined,
          title: `${orig.title} (Copy)`,
          createdAt: now,
          updatedAt: now,
          pinned: false,
        };
        setPresentations((prev) => [copy, ...prev]);
        openFileInTab(copy.id, 'slides');
        notify(`Duplicated "${orig.title}"`);
      } else if (kind === 'notebook') {
        const orig = notebooks.find((n) => n.id === id);
        if (!orig) return;
        const cloned: NotebookData = JSON.parse(JSON.stringify(orig));
        const copy: NotebookData = {
          ...cloned,
          id: uid('nb'),
          nativePath: undefined,
          cells: cloned.cells.map((c) => ({ ...c, id: uid('cell') })),
          title: `${orig.title} (Copy)`,
          createdAt: now,
          updatedAt: now,
          pinned: false,
        };
        setNotebooks((prev) => [copy, ...prev]);
        openFileInTab(copy.id, 'notebook');
        notify(`Duplicated "${orig.title}"`);
      } else if (kind === 'canvas') {
        const orig = canvases.find((c) => c.id === id);
        if (!orig) return;
        const copy: CanvasData = {
          ...JSON.parse(JSON.stringify(orig)),
          id: uid('canvas'),
          nativePath: undefined,
          title: `${orig.title} (Copy)`,
          createdAt: now,
          updatedAt: now,
          pinned: false,
        };
        setCanvases((prev) => [copy, ...prev]);
        openFileInTab(copy.id, 'canvas');
        notify(`Duplicated "${orig.title}"`);
      } else {
        const orig = pdfs.find((p) => p.id === id);
        if (!orig) return;
        let bytes = await loadPdfBytes(orig.blobId ?? orig.id);
        if (!bytes) {
          const { getPdfStreamUrl, resolveNativePdfPath } = await import('./storage/pdfBlobStore');
          const url =
            getPdfStreamUrl(orig.id) ??
            (orig.nativePath ? await resolveNativePdfPath(orig.nativePath) : null);
          if (url) {
            const resp = await fetch(url);
            if (resp.ok) bytes = new Uint8Array(await resp.arrayBuffer());
          }
        }
        if (!bytes) {
          notify(`Could not load "${orig.title}" to duplicate`);
          return;
        }
        const copyId = uid('pdf');
        await savePdfBytes(copyId, bytes);
        const copy: FormaPdfRecord = {
          ...JSON.parse(JSON.stringify(orig)),
          id: copyId,
          blobId: copyId,
          nativePath: undefined,
          title: `${orig.title} (Copy)`,
          createdAt: now,
          updatedAt: now,
          pinned: false,
        };
        setPdfs((prev) => [copy, ...prev]);
        openFileInTab(copy.id, 'pdf');
        notify(`Duplicated "${orig.title}"`);
      }
    },
    [workbooks, getDocumentSnapshot, presentations, notebooks, canvases, pdfs, openFileInTab, notify]
  );

  const handleTogglePinFile = useCallback((id: string, kind: WorkspaceFileKind) => {
    if (kind === 'spreadsheet') {
      setWorkbooks((prev) => prev.map((w) => (w.id === id ? { ...w, pinned: !w.pinned } : w)));
    } else if (kind === 'document') {
      setDocuments((prev) => prev.map((d) => (d.id === id ? { ...d, pinned: !d.pinned } : d)));
    } else if (kind === 'slides') {
      setPresentations((prev) => prev.map((p) => (p.id === id ? { ...p, pinned: !p.pinned } : p)));
    } else if (kind === 'notebook') {
      setNotebooks((prev) => prev.map((n) => (n.id === id ? { ...n, pinned: !n.pinned } : n)));
    } else if (kind === 'canvas') {
      setCanvases((prev) => prev.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c)));
    } else {
      setPdfs((prev) => prev.map((p) => (p.id === id ? { ...p, pinned: !p.pinned } : p)));
    }
  }, []);

  const handleExportFromHub = useCallback(
    async (id: string, kind: WorkspaceFileKind, fmt: string) => {
      try {
        if (kind === 'spreadsheet') {
          const wb = getWorkbookSnapshot(id);
          if (!wb) return;
          const safe = wb.title.replace(/[^a-zA-Z0-9._ -]/g, '_') || 'Workbook';
          let savedPath: string | undefined;
          if (fmt === 'xlsx') {
            const { exportWorkbookToXlsx } = await import('./engine/spreadsheet/formats/xlsxCodec');
            savedPath = await triggerFileDownload(
              await exportWorkbookToXlsx(wb),
              `${safe}.xlsx`,
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            );
          } else if (fmt === 'ods') {
            const { exportWorkbookToOds } = await import('./engine/spreadsheet/formats/odsCodec');
            savedPath = await triggerFileDownload(
              await exportWorkbookToOds(wb),
              `${safe}.ods`,
              'application/vnd.oasis.opendocument.spreadsheet'
            );
          } else {
            savedPath = await triggerFileDownload(
              exportSheetToDelimited(wb, wb.activeSheetId, ','),
              `${safe}.csv`,
              'text/csv;charset=utf-8'
            );
          }
          if (wasNativeSaveCancelled(savedPath)) return;
          if (savedPath && (fmt === 'xlsx' || fmt === 'ods' || fmt === 'csv' || fmt === 'tsv')) {
            setWorkbooks((prev) =>
              prev.map((w) =>
                w.id === wb.id
                  ? { ...wb, nativePath: savedPath, sourceFormat: fmt, updatedAt: Date.now() }
                  : w
              )
            );
          }
          notify(`Saved ${savedPath ? savedPath.split('/').pop() : `${safe}.${fmt}`}`);
        } else if (kind === 'document') {
          const doc = getDocumentSnapshot(id);
          if (!doc) return;
          const safe = doc.title.replace(/[^a-zA-Z0-9._ -]/g, '_') || 'Document';
          let savedPath: string | undefined;
          if (fmt === 'docx') {
            const { exportDocumentToDocx } = await import('./engine/document/formats/docxCodec');
            savedPath = await triggerFileDownload(
              await exportDocumentToDocx(doc),
              `${safe}.docx`,
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            );
          } else if (fmt === 'odt') {
            const { exportDocumentToOdt } = await import('./engine/document/formats/odtCodec');
            savedPath = await triggerFileDownload(
              await exportDocumentToOdt(doc),
              `${safe}.odt`,
              'application/vnd.oasis.opendocument.text'
            );
          } else if (fmt === 'html') {
            const { exportDocumentToHtml } = await import('./engine/document/formats/htmlCodec');
            savedPath = await triggerFileDownload(
              exportDocumentToHtml(doc),
              `${safe}.html`,
              'text/html;charset=utf-8'
            );
          } else {
            const mdText = doc.markdownSource ?? exportDocumentToMarkdown(doc);
            savedPath = await triggerFileDownload(
              mdText,
              `${safe}.md`,
              'text/markdown;charset=utf-8'
            );
          }
          if (wasNativeSaveCancelled(savedPath)) return;
          if (savedPath) {
            setDocuments((prev) =>
              prev.map((d) =>
                d.id === doc.id
                  ? {
                      ...d,
                      nativePath: savedPath,
                      sourceFormat: (fmt === 'docx' || fmt === 'odt' || fmt === 'html' ? fmt : 'md'),
                      updatedAt: Date.now(),
                    }
                  : d
              )
            );
          }
          notify(`Saved ${savedPath ? savedPath.split('/').pop() : `${safe}.${fmt}`}`);
        } else if (kind === 'slides') {
          const deck = presentations.find((p) => p.id === id);
          if (!deck) return;
          const safe = deck.title.replace(/[^a-zA-Z0-9._ -]/g, '_') || 'Presentation';
          let savedPath: string | undefined;
          if (fmt === 'pptx') {
            const { exportPresentationToPptx } = await import('./engine/slides/formats/pptxCodec');
            savedPath = await triggerFileDownload(
              await exportPresentationToPptx(deck),
              `${safe}.pptx`,
              'application/vnd.openxmlformats-officedocument.presentationml.presentation'
            );
          } else if (fmt === 'odp') {
            const { exportPresentationToOdp } = await import('./engine/slides/formats/odpCodec');
            savedPath = await triggerFileDownload(
              await exportPresentationToOdp(deck),
              `${safe}.odp`,
              'application/vnd.oasis.opendocument.presentation'
            );
          } else {
            const { exportPresentationToPdf } = await import('./engine/slides/formats/slidePdfCodec');
            savedPath = await triggerFileDownload(await exportPresentationToPdf(deck), `${safe}.pdf`, 'application/pdf');
          }
          if (wasNativeSaveCancelled(savedPath)) return;
          if (savedPath && (fmt === 'pptx' || fmt === 'odp')) {
            setPresentations((prev) =>
              prev.map((p) =>
                p.id === deck.id
                  ? { ...deck, nativePath: savedPath, sourceFormat: fmt, updatedAt: Date.now() }
                  : p
              )
            );
          }
          notify(`Saved ${savedPath ? savedPath.split('/').pop() : `${safe}.${fmt}`}`);
        } else if (kind === 'notebook') {
          const nb = notebooks.find((n) => n.id === id);
          if (!nb) return;
          const safe = nb.title.replace(/[^a-zA-Z0-9._ -]/g, '_') || 'Notebook';
          let savedPath: string | undefined;
          if (fmt === 'ipynb') {
            savedPath = await triggerFileDownload(
              exportNotebookToIpynb(nb),
              `${safe}.ipynb`,
              'application/x-ipynb+json;charset=utf-8'
            );
            if (wasNativeSaveCancelled(savedPath)) return;
            if (savedPath) setNotebooks((current) => current.map((item) => item.id === id ? { ...item, nativePath: savedPath } : item));
          } else if (fmt === 'py') {
            savedPath = await triggerFileDownload(
              exportNotebookToPython(nb),
              `${safe}.py`,
              'text/x-python;charset=utf-8'
            );
          } else {
            savedPath = await triggerFileDownload(
              exportNotebookToMarkdown(nb),
              `${safe}.md`,
              'text/markdown;charset=utf-8'
            );
          }
          if (wasNativeSaveCancelled(savedPath)) return;
          notify(`Saved ${savedPath ? savedPath.split('/').pop() : `${safe}.${fmt}`}`);
        } else if (kind === 'canvas') {
          const canvas = canvases.find((c) => c.id === id);
          if (!canvas) return;
          const safe = canvas.title.replace(/[^a-zA-Z0-9._ -]/g, '_') || 'Canvas';
          let savedPath: string | undefined;
          if (fmt === 'fcanvas') {
            savedPath = await triggerFileDownload(
              exportCanvasToFcanvas(canvas),
              `${safe}.fcanvas`,
              'application/json;charset=utf-8'
            );
          } else if (fmt === 'excalidraw') {
            savedPath = await triggerFileDownload(
              exportCanvasToExcalidraw(canvas),
              `${safe}.excalidraw`,
              'application/json;charset=utf-8'
            );
          } else if (fmt === 'svg') {
            savedPath = await triggerFileDownload(
              exportCanvasToSvg(canvas),
              `${safe}.svg`,
              'image/svg+xml;charset=utf-8'
            );
          } else if (fmt === 'png') {
            savedPath = await triggerFileDownload(
              await exportCanvasToPng(canvas),
              `${safe}.png`,
              'image/png'
            );
          } else {
            savedPath = await triggerFileDownload(
              await exportCanvasToPdf(canvas),
              `${safe}.pdf`,
              'application/pdf'
            );
          }
          if (wasNativeSaveCancelled(savedPath)) return;
          if (savedPath && (fmt === 'fcanvas' || fmt === 'excalidraw')) {
            setCanvases((prev) =>
              prev.map((c) =>
                c.id === canvas.id
                  ? { ...c, nativePath: savedPath, sourceFormat: fmt, updatedAt: Date.now() }
                  : c
              )
            );
          }
          notify(`Saved ${savedPath ? savedPath.split('/').pop() : `${safe}.${fmt}`}`);
        } else {
          const pdf = pdfs.find((p) => p.id === id);
          if (!pdf) return;
          let bytes = await loadPdfBytes(pdf.blobId ?? pdf.id);
          if (!bytes) {
            const { getPdfStreamUrl, resolveNativePdfPath } = await import('./storage/pdfBlobStore');
            const url = getPdfStreamUrl(pdf.id) ?? (pdf.nativePath ? await resolveNativePdfPath(pdf.nativePath) : null);
            if (url) {
              const resp = await fetch(url);
              if (resp.ok) bytes = new Uint8Array(await resp.arrayBuffer());
            }
          }
          if (!bytes) return;
          const { bakeAnnotationsIntoPdf } = await import('./engine/pdf/pdfEngine');
          const baked = await bakeAnnotationsIntoPdf(bytes, pdf.annotations);
          const safe = pdf.title.replace(/[^a-zA-Z0-9._ -]/g, '_') || 'Document';
          const savedPath = await triggerFileDownload(baked, `${safe}.pdf`, 'application/pdf');
          if (wasNativeSaveCancelled(savedPath)) return;
          notify(`Saved ${savedPath ? savedPath.split('/').pop() : `${safe}.pdf`}`);
        }
      } catch (err) {
        notify(`Export failed: ${(err as Error).message}`);
      }
    },
    [getWorkbookSnapshot, getDocumentSnapshot, presentations, notebooks, canvases, pdfs, notify]
  );

  const handleDeleteFile = useCallback(
    (id: string, kind: WorkspaceFileKind) => {
      handleCloseTab(id);
      if (kind === 'spreadsheet') {
        sheetHistories.current.delete(id);
        setWorkbooks((prev) => prev.filter((w) => w.id !== id));
      } else if (kind === 'document') {
        editorStates.current.delete(id);
        setDocuments((prev) => prev.filter((d) => d.id !== id));
      } else if (kind === 'slides') {
        setPresentations((prev) => prev.filter((p) => p.id !== id));
      } else if (kind === 'notebook') {
        setNotebooks((prev) => prev.filter((n) => n.id !== id));
      } else if (kind === 'canvas') {
        canvasHistories.current.delete(id);
        setCanvases((prev) => prev.filter((c) => c.id !== id));
      } else {
        const target = pdfs.find((p) => p.id === id);
        setPdfs((prev) => prev.filter((p) => p.id !== id));
        clearPdfStreamUrl(id);
        pdfRetryFilesRef.current.delete(id);
        setPdfBlobStatus((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        if (target?.blobId) void deletePdfBytes(target.blobId);
        void deletePdfBytes(id);
      }
      void removeIndexedDocument(id);
      notify('Deleted file');
    },
    [handleCloseTab, notify]
  );

  const files = useMemo(
    () => listWorkspaceFiles(workbooks, documents, pdfs, presentations, notebooks, canvases),
    [workbooks, documents, pdfs, presentations, notebooks, canvases]
  );

  const resolvedOpenTabs = useMemo<OpenTabItem[]>(() => {
    const items: OpenTabItem[] = [];
    for (const ref of openTabs) {
      if (ref.kind === 'spreadsheet') {
        const wb = workbooks.find((w) => w.id === ref.id);
        if (wb) items.push({ id: wb.id, kind: 'spreadsheet', title: wb.title });
      } else if (ref.kind === 'document') {
        const doc = documents.find((d) => d.id === ref.id);
        if (doc) items.push({ id: doc.id, kind: 'document', title: doc.title });
      } else if (ref.kind === 'slides') {
        const pr = presentations.find((p) => p.id === ref.id);
        if (pr) items.push({ id: pr.id, kind: 'slides', title: pr.title });
      } else if (ref.kind === 'notebook') {
        const nb = notebooks.find((n) => n.id === ref.id);
        if (nb) items.push({ id: nb.id, kind: 'notebook', title: nb.title });
      } else if (ref.kind === 'canvas') {
        const c = canvases.find((item) => item.id === ref.id);
        if (c) items.push({ id: c.id, kind: 'canvas', title: c.title });
      } else {
        const pdf = pdfs.find((p) => p.id === ref.id);
        if (pdf) items.push({ id: pdf.id, kind: 'pdf', title: pdf.title });
      }
    }
    return items;
  }, [openTabs, workbooks, documents, presentations, notebooks, canvases, pdfs]);

  const activeTab = useMemo(
    () => resolvedOpenTabs.find((t) => t.id === activeTabId) ?? null,
    [resolvedOpenTabs, activeTabId]
  );

  const activeWorkbook = useMemo(
    () =>
      activeTab?.kind === 'spreadsheet'
        ? workbooks.find((w) => w.id === activeTab.id) ?? null
        : null,
    [activeTab, workbooks]
  );

  const activeDocument = useMemo(
    () =>
      activeTab?.kind === 'document'
        ? documents.find((d) => d.id === activeTab.id) ?? null
        : null,
    [activeTab, documents]
  );

  const activePresentation = useMemo(
    () =>
      activeTab?.kind === 'slides'
        ? presentations.find((p) => p.id === activeTab.id) ?? null
        : null,
    [activeTab, presentations]
  );

  const activeNotebook = useMemo(
    () =>
      activeTab?.kind === 'notebook'
        ? notebooks.find((n) => n.id === activeTab.id) ?? null
        : null,
    [activeTab, notebooks]
  );

  const activeCanvas = useMemo(
    () =>
      activeTab?.kind === 'canvas'
        ? canvases.find((c) => c.id === activeTab.id) ?? null
        : null,
    [activeTab, canvases]
  );

  const activePdf = useMemo(
    () => (activeTab?.kind === 'pdf' ? pdfs.find((p) => p.id === activeTab.id) ?? null : null),
    [activeTab, pdfs]
  );

  // Dynamic Native macOS Window Title (reflects active file name)
  useEffect(() => {
    const appLabel =
      standaloneKind === 'sheets'
        ? 'Forma Sheets'
        : standaloneKind === 'docs'
          ? 'Forma Docs'
          : standaloneKind === 'slides'
            ? 'Forma Slides'
            : standaloneKind === 'pdf'
              ? 'Forma PDF'
              : standaloneKind === 'lab'
                ? 'Forma Lab'
                : standaloneKind === 'canvas'
                  ? 'Forma Canvas'
                  : 'Forma Office';
    const nextTitle = !showingHub && activeTab ? `${activeTab.title} — ${appLabel}` : appLabel;
    document.title = nextTitle;
    const webkit = (
      window as unknown as {
        webkit?: { messageHandlers?: { formaWindowTitle?: { postMessage: (p: { title: string }) => void } } };
      }
    ).webkit;
    webkit?.messageHandlers?.formaWindowTitle?.postMessage({ title: nextTitle });
  }, [standaloneKind, showingHub, activeTab]);

  const queueWorkspaceIndex = useCallback(async (entry: WorkspaceIndexEntry, force = false) => {
    const { id, updatedAt } = entry.record;
    const queuedVersion = indexedVersions.current.get(id);
    if (queuedVersion !== undefined && (queuedVersion > updatedAt || (!force && queuedVersion === updatedAt))) return;
    indexedVersions.current.set(id, updatedAt);
    // Let the direct save path serialize its snapshot before extracting search content.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (indexedVersions.current.get(id) !== updatedAt) return;
    try {
      if ((await indexWorkspaceDocument(makeWorkspaceIndexInput(entry))).ok) return;
    } catch {
      // Allow a later edit or explicit save to retry a failed index.
    }
    if (indexedVersions.current.get(id) === updatedAt) indexedVersions.current.delete(id);
  }, []);

  // Universal Save (⌘S / File → Save…)
  const handleSaveActive = useCallback(async () => {
    if (showingHub || !activeTab) return;
    if (activeTab.kind === 'notebook') {
      const nb = notebooks.find((n) => n.id === activeTab.id);
      if (nb) void queueWorkspaceIndex({ kind: 'notebook', record: nb });
      if (nb?.nativePath) {
        const ok = await writeWorkspaceFile(nb.nativePath, exportNotebookToIpynb(nb));
        if (ok) {
          notify(`Saved ${nb.nativePath.split('/').pop()}`);
          return;
        }
      }
      await handleExportFromHub(activeTab.id, 'notebook', 'ipynb');
      return;
    }
    if (activeTab.kind === 'document') {
      const doc = getDocumentSnapshot(activeTab.id);
      if (!doc) return;
      void queueWorkspaceIndex({ kind: 'document', record: doc });
      const isMdPath = Boolean(doc.nativePath && /\.(md|markdown)$/i.test(doc.nativePath));
      const isHtmlPath = Boolean(doc.nativePath && /\.(html|htm)$/i.test(doc.nativePath));
      const docFmt =
        doc.sourceFormat ??
        (isMdPath ? 'md' : doc.nativePath?.endsWith('.odt') ? 'odt' : isHtmlPath ? 'html' : 'docx');
      if (docFmt === 'md' && doc.nativePath && isNativeWorkspaceAvailable()) {
        const mdOut = doc.markdownSource ?? exportDocumentToMarkdown(doc);
        const ok = await writeWorkspaceFile(doc.nativePath, mdOut);
        if (ok) {
          notify(`Saved ${doc.nativePath.split('/').pop()}`);
          return;
        }
      }
      if (docFmt === 'html' && doc.nativePath && isNativeWorkspaceAvailable()) {
        const { exportDocumentToHtml } = await import('./engine/document/formats/htmlCodec');
        const ok = await writeWorkspaceFile(doc.nativePath, exportDocumentToHtml(doc));
        if (ok) {
          notify(`Saved ${doc.nativePath.split('/').pop()}`);
          return;
        }
      }
      if ((docFmt === 'docx' || docFmt === 'odt') && doc.nativePath && isNativeWorkspaceAvailable()) {
        const bytes =
          docFmt === 'docx'
            ? await (await import('./engine/document/formats/docxCodec')).exportDocumentToDocx(doc)
            : await (await import('./engine/document/formats/odtCodec')).exportDocumentToOdt(doc);
        const ok = await writeBinaryWorkspaceFile(doc.nativePath, bytes);
        if (ok) {
          notify(`Saved ${doc.nativePath.split('/').pop()}`);
          return;
        }
      }
      await handleExportFromHub(activeTab.id, 'document', docFmt);
      return;
    }
    if (activeTab.kind === 'spreadsheet') {
      const wb = getWorkbookSnapshot(activeTab.id);
      if (!wb) return;
      void queueWorkspaceIndex({ kind: 'spreadsheet', record: wb });
      const fmt =
        wb.sourceFormat ??
        (wb.nativePath?.endsWith('.ods')
          ? 'ods'
          : wb.nativePath?.endsWith('.csv')
            ? 'csv'
            : wb.nativePath?.endsWith('.tsv')
              ? 'tsv'
              : 'xlsx');
      if (wb.nativePath && isNativeWorkspaceAvailable()) {
        if (fmt === 'csv' || fmt === 'tsv') {
          const text = exportSheetToDelimited(wb, wb.activeSheetId, fmt === 'tsv' ? '\t' : ',');
          const ok = await writeWorkspaceFile(wb.nativePath, text);
          if (ok) {
            notify(`Saved ${wb.nativePath.split('/').pop()}`);
            return;
          }
        } else {
          const bytes =
            fmt === 'ods'
              ? await (await import('./engine/spreadsheet/formats/odsCodec')).exportWorkbookToOds(wb)
              : await (await import('./engine/spreadsheet/formats/xlsxCodec')).exportWorkbookToXlsx(wb);
          const ok = await writeBinaryWorkspaceFile(wb.nativePath, bytes);
          if (ok) {
            notify(`Saved ${wb.nativePath.split('/').pop()}`);
            return;
          }
        }
      }
      await handleExportFromHub(activeTab.id, 'spreadsheet', fmt);
      return;
    }
    if (activeTab.kind === 'slides') {
      const deck = presentations.find((p) => p.id === activeTab.id);
      if (!deck) return;
      void queueWorkspaceIndex({ kind: 'slides', record: deck });
      const fmt = deck.sourceFormat ?? (deck.nativePath?.endsWith('.odp') ? 'odp' : 'pptx');
      if (deck.nativePath && isNativeWorkspaceAvailable()) {
        const bytes =
          fmt === 'odp'
            ? await (await import('./engine/slides/formats/odpCodec')).exportPresentationToOdp(deck)
            : await (await import('./engine/slides/formats/pptxCodec')).exportPresentationToPptx(deck);
        const ok = await writeBinaryWorkspaceFile(deck.nativePath, bytes);
        if (ok) {
          notify(`Saved ${deck.nativePath.split('/').pop()}`);
          return;
        }
      }
      await handleExportFromHub(activeTab.id, 'slides', fmt);
      return;
    }
    if (activeTab.kind === 'canvas') {
      const canvas = canvases.find((c) => c.id === activeTab.id);
      if (!canvas) return;
      void queueWorkspaceIndex({ kind: 'canvas', record: canvas });
      const fmt =
        canvas.sourceFormat ?? (canvas.nativePath?.endsWith('.excalidraw') ? 'excalidraw' : 'fcanvas');
      if (canvas.nativePath && isNativeWorkspaceAvailable()) {
        const text =
          fmt === 'excalidraw' ? exportCanvasToExcalidraw(canvas) : exportCanvasToFcanvas(canvas);
        const ok = await writeWorkspaceFile(canvas.nativePath, text);
        if (ok) {
          notify(`Saved ${canvas.nativePath.split('/').pop()}`);
          return;
        }
      }
      await handleExportFromHub(activeTab.id, 'canvas', fmt);
      return;
    }
    if (activePdf) void queueWorkspaceIndex({ kind: 'pdf', record: activePdf });
    const wSave = window as unknown as { __formaSaveActivePdf?: () => Promise<void> };
    if (wSave.__formaSaveActivePdf) {
      await wSave.__formaSaveActivePdf();
      return;
    }
    await handleExportFromHub(activeTab.id, activeTab.kind, 'pdf');
  }, [showingHub, activeTab, notebooks, presentations, canvases, getDocumentSnapshot, getWorkbookSnapshot, handleExportFromHub, notify, activePdf, queueWorkspaceIndex]);

  useEffect(() => {
    const w = window as unknown as { __formaSaveActive?: () => void };
    const triggerSave = () => {
      void handleSaveActive();
    };
    w.__formaSaveActive = triggerSave;

    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        if (!showingHub && activeTab) {
          e.preventDefault();
          void handleSaveActive();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (w.__formaSaveActive === triggerSave) delete w.__formaSaveActive;
    };
  }, [showingHub, activeTab, handleSaveActive]);

  const handleGlobalDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDraggingFiles(false);
      const dropped = Array.from(e.dataTransfer?.files ?? []);
      dropped.forEach((f) => void handleImportAnyFile(f));
    },
    [handleImportAnyFile]
  );

  const activeStore = activeTab?.kind === 'spreadsheet' ? workbooksStore
    : activeTab?.kind === 'document' ? documentsStore
    : activeTab?.kind === 'slides' ? presentationsStore
    : activeTab?.kind === 'notebook' ? notebooksStore
    : activeTab?.kind === 'canvas' ? canvasesStore : pdfsStore;
  const storageError = [workbooksStore, documentsStore, presentationsStore, notebooksStore, canvasesStore, pdfsStore].find((store) => store.error);
  const activeSaveState = activeTabId ? activeStore.state(activeTabId) : 'saved';

  // Truthful PDF storage indicator when browser-imported PDFs exceed 40 MiB or fail IDB persistence
  const activePdfStorageNotice = useMemo(() => {
    if (showingHub || activeTab?.kind !== 'pdf' || !activePdf) return null;
    if (activePdf.nativePath) return null;
    const st = pdfBlobStatus[activePdf.id];
    if (st === 'session-only') {
      return { label: 'Session-only (>40 MB · Relink on restart)', tone: 'amber' as const };
    }
    if (st === 'save-failed') {
      const retryFile = pdfRetryFilesRef.current.get(activePdf.id);
      return {
        label: 'PDF bytes not saved',
        tone: 'rose' as const,
        onRetry: retryFile
          ? () => {
              setPdfBlobStatus((prev) => ({ ...prev, [activePdf.id]: 'saving' }));
              void retryFile
                .arrayBuffer()
                .then((ab) => savePdfBytes(activePdf.id, new Uint8Array(ab)))
                .then(() => {
                  pdfRetryFilesRef.current.delete(activePdf.id);
                  setPdfBlobStatus((prev) => ({ ...prev, [activePdf.id]: 'persisted' }));
                  notify('Saved PDF bytes to workspace');
                })
                .catch(() => {
                  setPdfBlobStatus((prev) => ({ ...prev, [activePdf.id]: 'save-failed' }));
                });
            }
          : undefined,
      };
    }
    if (st === 'saving') {
      return { label: 'Saving PDF bytes…', tone: 'amber' as const };
    }
    return null;
  }, [showingHub, activeTab?.kind, activePdf, pdfBlobStatus, notify]);

  // Native macOS dirty-dot indicator on window close button
  useEffect(() => {
    const isDirty = activeSaveState === 'saving' || Boolean(activeTabId && pendingDocumentId === activeTabId);
    const webkit = (
      window as unknown as {
        webkit?: { messageHandlers?: { formaSetDirty?: { postMessage: (p: { dirty: boolean }) => void } } };
      }
    ).webkit;
    webkit?.messageHandlers?.formaSetDirty?.postMessage({ dirty: isDirty });
  }, [activeSaveState, activeTabId, pendingDocumentId]);

  // Native macOS external file-change watcher for currently active disk-backed file
  const activeNativePath =
    activeTab?.kind === 'document'
      ? activeDocument?.nativePath
      : activeTab?.kind === 'spreadsheet'
        ? activeWorkbook?.nativePath
        : activeTab?.kind === 'slides'
          ? activePresentation?.nativePath
          : activeTab?.kind === 'notebook'
            ? activeNotebook?.nativePath
            : activeTab?.kind === 'canvas'
              ? activeCanvas?.nativePath
              : activeTab?.kind === 'pdf'
                ? activePdf?.nativePath
                : undefined;

  useEffect(() => {
    if (!activeNativePath) return;
    const webkit = (
      window as unknown as {
        webkit?: { messageHandlers?: { formaWatchFile?: { postMessage: (p: { path: string }) => void } } };
      }
    ).webkit;
    webkit?.messageHandlers?.formaWatchFile?.postMessage({ path: activeNativePath });
  }, [activeNativePath]);

  // Global Cmd+K (Command Palette & Semantic Search) & Cmd+J (Local Ollama AI Copilot)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        const key = e.key.toLowerCase();
        if (key === 'k') {
          e.preventDefault();
          setShowCommandPalette((v) => !v);
        } else if (key === 'j') {
          e.preventDefault();
          setShowAiCopilot((v) => !v);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const indexAllWorkspaceFiles = useCallback(async () => {
    const entries: WorkspaceIndexEntry[] = [
      ...documents.map((record) => ({ kind: 'document' as const, record })),
      ...workbooks.map((record) => ({ kind: 'spreadsheet' as const, record })),
      ...presentations.map((record) => ({ kind: 'slides' as const, record })),
      ...notebooks.map((record) => ({ kind: 'notebook' as const, record })),
      ...pdfs.map((record) => ({ kind: 'pdf' as const, record })),
      ...canvases.map((record) => ({ kind: 'canvas' as const, record })),
    ];
    for (const entry of entries) await queueWorkspaceIndex(entry, true);
  }, [documents, workbooks, presentations, notebooks, pdfs, canvases, queueWorkspaceIndex]);

  const activeIndexEntry = useMemo<WorkspaceIndexEntry | null>(() => {
    if (showingHub) return null;
    if (activeDocument) return { kind: 'document', record: activeDocument };
    if (activeWorkbook) return { kind: 'spreadsheet', record: activeWorkbook };
    if (activePresentation) return { kind: 'slides', record: activePresentation };
    if (activeNotebook) return { kind: 'notebook', record: activeNotebook };
    if (activePdf) return { kind: 'pdf', record: activePdf };
    if (activeCanvas) return { kind: 'canvas', record: activeCanvas };
    return null;
  }, [showingHub, activeDocument, activeWorkbook, activePresentation, activeNotebook, activePdf, activeCanvas]);

  useEffect(() => {
    if (!activeIndexEntry || activeIndexEntry.record.updatedAt <= workspaceIndexLaunchTime.current) return;
    const idle = setTimeout(() => void queueWorkspaceIndex(activeIndexEntry), 15_000);
    return () => clearTimeout(idle);
  }, [activeIndexEntry, queueWorkspaceIndex]);

  const handleOpenExternalPath = useCallback(
    async (filePath: string) => {
      const name = filePath.split('/').pop() || 'Document';
      const ext = name.split('.').pop()?.toLowerCase() ?? '';
      try {
        if (ext === 'ipynb') {
          await handleOpenFolderNotebook(filePath);
          return;
        }
        if (ext === 'fcanvas' || ext === 'excalidraw') {
          const read = await readWorkspaceFile(filePath);
          if (!read) {
            notify(`Could not read ${name}`);
            return;
          }
          const canvas =
            ext === 'excalidraw'
              ? importCanvasFromExcalidraw(read.content, read.name)
              : importCanvasFromFcanvas(read.content, read.name);
          canvas.sourceFormat = ext === 'excalidraw' ? 'excalidraw' : 'fcanvas';
          canvas.nativePath = read.path;
          handleImportNewCanvas(canvas);
          notify(`Opened ${read.name}`);
          return;
        }
        if (ext === 'md' || ext === 'markdown' || ext === 'txt' || ext === 'html' || ext === 'htm') {
          const read = await readWorkspaceFile(filePath);
          if (!read) {
            notify(`Could not read ${name}`);
            return;
          }
          const doc =
            ext === 'html' || ext === 'htm'
              ? importDocumentFromHtml(read.content, read.name)
              : importDocumentFromMarkdown(read.content, read.name);
          doc.nativePath = read.path;
          handleImportNewDocument(doc);
          notify(`Opened ${read.name}`);
          return;
        }
        const streamUrl = await resolveNativePdfPath(filePath);
        if (!streamUrl) {
          notify(`Could not locate ${name} on disk`);
          return;
        }
        if (ext === 'pdf') {
          addPdfRecordFromStream(streamUrl, name.replace(/\.pdf$/i, ''), 0, filePath);
          notify(`Opened ${name}`);
          return;
        }
        const resp = await fetch(streamUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        await handleImportAnyFile(new File([blob], name), filePath);
      } catch (err) {
        notify(`Could not open ${name}: ${(err as Error).message}`);
      }
    },
    [handleOpenFolderNotebook, handleImportNewDocument, handleImportNewCanvas, addPdfRecordFromStream, handleImportAnyFile, notify]
  );

  const handleOpenWikilink = useCallback(
    (targetTitle: string) => {
      const clean = targetTitle.trim();
      if (!clean) return;
      const existing = documents.find((d) => d.title.trim().toLowerCase() === clean.toLowerCase());
      if (existing) {
        openFileInTab(existing.id, 'document');
        notify(`Opened [[${existing.title}]]`);
        return;
      }
      const created = createBlankDocument(clean);
      created.sourceFormat = 'md';
      created.markdownSource = `# ${clean}\n\n`;
      created.html = `<h1>${clean}</h1><p></p>`;
      setDocuments((prev) => [created, ...prev]);
      openFileInTab(created.id, 'document');
      notify(`Created [[${clean}]]`);
    },
    [documents, openFileInTab, notify]
  );

  const handleRefreshLinkedTable = useCallback(
    (sourceTag: string): string | null => {
      const colonIdx = sourceTag.indexOf(':');
      if (colonIdx === -1) return null;
      const wbId = sourceTag.slice(0, colonIdx);
      const rest = sourceTag.slice(colonIdx + 1);
      const bangIdx = rest.lastIndexOf('!');
      if (bangIdx === -1) return null;
      const sheetName = rest.slice(0, bangIdx);
      const rangeA1 = rest.slice(bangIdx + 1);
      const wb = getWorkbookSnapshot(wbId);
      if (!wb) return null;
      const sheet = wb.sheets.find((s) => s.name === sheetName) ?? wb.sheets[0];
      const parsed = parseRange(rangeA1);
      if (!sheet || !parsed) return null;
      const evalFn = createWorkbookEvaluator();
      const computedSheet = evalFn(wb)[sheet.id] ?? {};
      const norm = {
        startRow: Math.min(parsed.start.row, parsed.end.row),
        startCol: Math.min(parsed.start.col, parsed.end.col),
        endRow: Math.max(parsed.start.row, parsed.end.row),
        endCol: Math.max(parsed.start.col, parsed.end.col),
      };
      const htmlTable = rangeToHTMLTable(computedSheet, norm);
      const sourceLabel = `${wb.title} — ${sheet.name}!${rangeA1}`;
      return `<div data-forma-source="${sourceTag}">${htmlTable}<p><em>Source: ${sourceLabel} (refreshed)</em></p></div>`;
    },
    [getWorkbookSnapshot]
  );

  const handleRefreshLinkedCanvas = useCallback(
    (canvasId: string): { src: string; title: string } | null => {
      const target = canvases.find((c) => c.id === canvasId);
      if (!target) return null;
      const svg = exportCanvasToSvg(target);
      const bytes = new TextEncoder().encode(svg);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return {
        src: `data:image/svg+xml;base64,${btoa(binary)}`,
        title: target.title,
      };
    },
    [canvases]
  );

  const activeFileContext = useMemo(() => {
    if (showingHub || !activeTab) return '';
    if (activeTab.kind === 'spreadsheet' && activeWorkbook) {
      return extractWorkbookIndexText(activeWorkbook).slice(0, 10000);
    }
    if (activeTab.kind === 'document' && activeDocument) {
      return extractDocumentIndexText(activeDocument).slice(0, 10000);
    }
    if (activeTab.kind === 'slides' && activePresentation) {
      return extractPresentationIndexText(activePresentation).slice(0, 10000);
    }
    if (activeTab.kind === 'notebook' && activeNotebook) {
      return extractNotebookIndexText(activeNotebook).slice(0, 10000);
    }
    if (activeTab.kind === 'canvas' && activeCanvas) {
      return extractCanvasIndexText(activeCanvas).slice(0, 10000);
    }
    if (activeTab.kind === 'pdf' && activePdf) {
      return extractPdfIndexText(activePdf).slice(0, 10000);
    }
    return '';
  }, [showingHub, activeTab, activeWorkbook, activeDocument, activePresentation, activeNotebook, activeCanvas, activePdf]);

  const paletteCommands = useMemo<CommandPaletteCommand[]>(
    () => [
      { id: 'cmd_new_sheet', label: 'New Blank Workbook', category: 'Create', onRun: () => handleCreateBlank('spreadsheet') },
      { id: 'cmd_new_doc', label: 'New Blank Document', category: 'Create', onRun: () => handleCreateBlank('document') },
      { id: 'cmd_new_slides', label: 'New Blank Presentation', category: 'Create', onRun: () => handleCreateBlank('slides') },
      { id: 'cmd_new_nb', label: 'New Blank Python Notebook', category: 'Create', onRun: () => handleCreateBlank('notebook') },
      { id: 'cmd_new_canvas', label: 'New Blank Canvas Whiteboard', category: 'Create', onRun: () => handleCreateBlank('canvas') },
      { id: 'cmd_open_file', label: 'Open File from Disk…', category: 'File', shortcut: '⌘O', onRun: () => { openNativeFileDialog(); } },
      { id: 'cmd_save', label: 'Save Active File', category: 'File', shortcut: '⌘S', onRun: () => void handleSaveActive() },
      { id: 'cmd_ai', label: 'Toggle Local Ollama AI Copilot', category: 'AI', shortcut: '⌘J', onRun: () => setShowAiCopilot((v) => !v) },
      { id: 'cmd_reindex', label: 'Reindex All Docs for Semantic Search', category: 'AI', onRun: () => { notify('Reindexing workspace embeddings…'); void indexAllWorkspaceFiles().then(() => notify('Semantic index updated')); } },
      { id: 'cmd_hub', label: 'Go to Start Hub', category: 'Navigation', shortcut: '⇧⌘H', onRun: () => setShowingHub(true) },
    ],
    [handleCreateBlank, handleSaveActive, indexAllWorkspaceFiles, notify]
  );

  const lazyFallback = (
    <div className="flex-1 flex items-center justify-center bg-slate-50 text-xs text-slate-400">
      Loading workspace…
    </div>
  );

  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes('Files')) {
          e.preventDefault();
          if (!draggingFiles) setDraggingFiles(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDraggingFiles(false);
      }}
      onDrop={handleGlobalDrop}
      className="relative h-full flex flex-col bg-slate-50 overflow-hidden"
    >
      {!(pdfReadingMode && !showingHub && activePdf) && (
        <AppHeader
          saveState={activeSaveState !== 'error' && activeTabId && pendingDocumentId === activeTabId ? 'saving' : activeSaveState}
          storageNotice={activePdfStorageNotice}
          onRetrySave={activeStore.retry}
          standaloneKind={standaloneKind}
          showingHub={showingHub || !activeTab}
          openTabs={resolvedOpenTabs}
          activeTabId={activeTabId}
          onShowHub={() => setShowingHub(true)}
          onSelectTab={(id, kind) => openFileInTab(id, kind)}
          onCloseTab={handleCloseTab}
          onCloseOtherTabs={handleCloseOtherTabs}
          onRenameTab={(id, kind, nextTitle) => handleRenameFile(id, kind, nextTitle)}
          onDuplicateTab={(id, kind) => void handleDuplicateFile(id, kind)}
          onOpenTabInNewWindow={(id) => openNativeNewWindow(id)}
          onCreateBlank={handleCreateBlank}
          onOpenCommandPalette={() => setShowCommandPalette(true)}
          onToggleCopilot={() => setShowAiCopilot((v) => !v)}
          copilotOpen={showAiCopilot}
        />
      )}

      {externalChangedPath && (
        <div role="status" className="no-print bg-amber-50 border-b border-amber-200 text-amber-900 px-4 py-1.5 text-xs flex items-center gap-3">
          <span>
            External edit detected on <strong>{externalChangedPath.split('/').pop()}</strong>.
          </span>
          <button
            onClick={() => {
              const p = externalChangedPath;
              setExternalChangedPath(null);
              void handleOpenExternalPath(p);
            }}
            className="px-2 py-0.5 rounded bg-amber-600 text-white font-medium hover:bg-amber-700"
          >
            Reload from Disk
          </button>
          <button
            onClick={() => setExternalChangedPath(null)}
            className="text-amber-700 hover:underline ml-auto"
          >
            Dismiss
          </button>
        </div>
      )}

      {(showingHub || !activeTab) && (
        <HomeHub
          standaloneKind={standaloneKind}
          files={files}
          openFileIds={openTabs.map((t) => t.id)}
          onOpenFile={openFileInTab}
          onOpenInNewWindow={(id) => openNativeNewWindow(id)}
          onCreateSheetTemplate={handleCreateSheetTemplate}
          onCreateDocTemplate={handleCreateDocTemplate}
          onCreateSlideTemplate={handleCreateSlideTemplate}
          onCreateNotebookTemplate={handleCreateNotebookTemplate}
          onCreateCanvasTemplate={handleCreateCanvasTemplate}
          labFolder={labFolder}
          onOpenLabFolder={() => void handlePickLabFolder()}
          onCreatePdfTemplate={(t) => void handleCreatePdfTemplate(t)}
          onMergePdfFiles={(fl) => void handleMergePdfFiles(fl)}
          onRenameFile={(id, kind) => handleRenameFile(id, kind)}
          onDuplicateFile={(id, kind) => void handleDuplicateFile(id, kind)}
          onTogglePinFile={handleTogglePinFile}
          onExportFile={(id, kind, fmt) => void handleExportFromHub(id, kind, fmt)}
          onDeleteFile={handleDeleteFile}
          onImportAnyFile={(f) => void handleImportAnyFile(f)}
          onOpenIndexedFolders={isNativeAiAvailable() ? () => setShowIndexedFolders(true) : undefined}
        />
      )}

      {storageError && <div role="alert" className="bg-rose-50 text-rose-900 px-4 py-2 text-sm flex gap-3">
        <span>{storageError.error}</span><button className="underline" onClick={storageError.retry}>Retry save</button>
      </div>}
      <Suspense fallback={lazyFallback}>
        {!showingHub && activeWorkbook && (
          <SheetsApp
            key={activeWorkbook.id}
            ref={spreadsheetEditor}
            historyMap={sheetHistories.current}
            workbook={activeWorkbook}
            onChangeWorkbook={handleUpdateWorkbook}
            onImportNewWorkbook={handleImportNewWorkbook}
            onSendTableToDocs={(htmlTable, label, meta) => {
              if (standaloneKind === 'sheets') {
                try {
                  const blob = new Blob([htmlTable], { type: 'text/html' });
                  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
                    const items: Record<string, Blob> = { 'text/html': blob };
                    if (meta?.plainText) {
                      items['text/plain'] = new Blob([meta.plainText], { type: 'text/plain' });
                    }
                    void navigator.clipboard.write([new ClipboardItem(items)]);
                  }
                } catch {
                  // fallback silently
                }
                notify(`Copied ${label} as formatted table — paste into Forma Docs or Slides (⌘V)`);
              } else {
                setPendingTableTransfer({ htmlTable, label, meta });
              }
            }}
            onNotify={notify}
          />
        )}

        {!showingHub && activeDocument && (
          <DocsApp
            key={activeDocument.id}
            ref={documentEditor}
            editorStates={editorStates.current}
            document={activeDocument}
            docsFolder={labFolder}
            onPickDocsFolder={() => void handlePickLabFolder()}
            onOpenFolderDoc={(p) => void handleOpenExternalPath(p)}
            onOpenWikilink={handleOpenWikilink}
            onRefreshLinkedTable={handleRefreshLinkedTable}
            onRefreshLinkedCanvas={handleRefreshLinkedCanvas}
            onChangeDocument={handleUpdateDocument}
            onPendingChange={handlePendingDocumentChange}
            onImportNewDocument={handleImportNewDocument}
            pendingInsertedHtml={pendingDocInsert}
            onClearPendingInsert={() => setPendingDocInsert(null)}
            onNotify={notify}
          />
        )}

        {!showingHub && activePresentation && (
          <SlidesApp
            key={activePresentation.id}
            deck={activePresentation}
            onChangeDeck={handleUpdatePresentation}
            onImportDeckFile={(f) => void handleImportAnyFile(f)}
            onRefreshLinkedCanvas={handleRefreshLinkedCanvas}
            onNotify={notify}
          />
        )}

        {!showingHub && activeNotebook && (
          <NotebookApp
            key={activeNotebook.id}
            notebook={activeNotebook}
            labFolder={labFolder}
            onChangeNotebook={handleUpdateNotebook}
            onImportNotebookFile={(f) => void handleImportAnyFile(f)}
            onPickLabFolder={() => void handlePickLabFolder()}
            onRefreshLabFolder={() => void handleRefreshLabFolder()}
            onOpenFolderNotebook={(p) => void handleOpenFolderNotebook(p)}
            onCreateNotebookInDir={(dir) => void handleCreateNotebookInDir(dir)}
            onNotify={notify}
          />
        )}

        {!showingHub && activeCanvas && (
          <CanvasApp
            key={activeCanvas.id}
            canvas={activeCanvas}
            historyMap={canvasHistories.current}
            onChangeCanvas={handleUpdateCanvas}
            onImportCanvasFile={(f) => void handleImportAnyFile(f)}
            onSendCanvasToSuite={(payload) => {
              if (standaloneKind === 'canvas') {
                try {
                  void navigator.clipboard?.writeText(payload.svgText);
                } catch {
                  // ignore clipboard fallback
                }
                notify(`Copied "${payload.title}" SVG to clipboard`);
              } else {
                setPendingCanvasTransfer(payload);
              }
            }}
            onNotify={notify}
          />
        )}

        {!showingHub && activePdf && (
          <PdfApp
            key={activePdf.id}
            record={activePdf}
            onChangeRecord={handleUpdatePdf}
            onImportNewPdf={(f) => void handleImportAnyFile(f)}
            onReadingModeChange={setPdfReadingMode}
            onNotify={notify}
          />
        )}
      </Suspense>

      <CommandPalette
        isOpen={showCommandPalette}
        onClose={() => setShowCommandPalette(false)}
        files={files}
        commands={paletteCommands}
        onSelectFile={(id, kind) => openFileInTab(id, kind)}
        onOpenExternalPath={(p) => void handleOpenExternalPath(p)}
        onReindexAll={async () => {
          notify('Reindexing workspace embeddings…');
          await indexAllWorkspaceFiles();
          notify('Semantic index updated');
        }}
        onOpenIndexedFolders={isNativeAiAvailable() ? () => {
          setShowCommandPalette(false);
          setShowIndexedFolders(true);
        } : undefined}
      />

      {showIndexedFolders && <IndexedFoldersDialog onClose={() => setShowIndexedFolders(false)} />}

      <LocalAiCopilot
        isOpen={showAiCopilot}
        onClose={() => setShowAiCopilot(false)}
        activeFileKind={showingHub ? null : activeTab?.kind ?? null}
        activeFileTitle={showingHub ? undefined : activeTab?.title}
        activeFileContext={activeFileContext}
        onSelectFile={(id, kind) => openFileInTab(id, kind)}
        onOpenExternalPath={(p) => void handleOpenExternalPath(p)}
      />

      {draggingFiles && (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => setDraggingFiles(false)}
          onDrop={handleGlobalDrop}
          className="fixed inset-0 z-[100] bg-slate-900/45 backdrop-blur-xs flex items-center justify-center p-8"
        >
          <div className="bg-white/95 border-2 border-dashed border-slate-400 rounded-2xl px-10 py-8 text-center shadow-2xl space-y-1.5">
            <div className="text-sm font-bold text-slate-900">Drop file to open in Forma</div>
            <div className="text-xs text-slate-500">
              Supports .xlsx · .ods · .csv · .docx · .odt · .md · .pptx · .odp · .pdf · .ipynb · .fcanvas · .excalidraw
            </div>
          </div>
        </div>
      )}

      {pendingTableTransfer && (
        <div
          onClick={() => setPendingTableTransfer(null)}
          className="no-print fixed inset-0 z-[110] bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-6"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden text-xs"
          >
            <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
              <div>
                <div className="text-sm font-bold text-slate-900">Send Table to…</div>
                <div className="text-[11px] text-slate-500 truncate max-w-[330px]">
                  Source: {pendingTableTransfer.label}
                </div>
              </div>
              <button
                onClick={() => setPendingTableTransfer(null)}
                className="px-2 py-1 rounded text-slate-500 hover:bg-slate-200"
              >
                Close
              </button>
            </div>

            <div className="p-4 space-y-4 max-h-[65vh] overflow-y-auto">
              {/* Clipboard option */}
              <button
                onClick={() => {
                  try {
                    const items: Record<string, Blob> = {
                      'text/html': new Blob([pendingTableTransfer.htmlTable], { type: 'text/html' }),
                    };
                    if (pendingTableTransfer.meta?.plainText) {
                      items['text/plain'] = new Blob([pendingTableTransfer.meta.plainText], {
                        type: 'text/plain',
                      });
                    }
                    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
                      void navigator.clipboard.write([new ClipboardItem(items)]);
                    }
                  } catch {
                    // ignore
                  }
                  notify(`Copied ${pendingTableTransfer.label} to clipboard`);
                  setPendingTableTransfer(null);
                }}
                className="w-full text-left px-3 py-2 rounded-lg border border-slate-200 hover:border-emerald-500 hover:bg-emerald-50/50 font-medium text-slate-800 transition"
              >
                Copy Formatted Table to Clipboard
              </button>

              {/* Docs destinations */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                    Forma Docs
                  </span>
                  <button
                    onClick={() => {
                      const doc = createBlankDocument(
                        pendingTableTransfer.meta?.workbookTitle
                          ? `${pendingTableTransfer.meta.workbookTitle} Report`
                          : 'Untitled Document'
                      );
                      setDocuments((prev) => [doc, ...prev]);
                      setPendingDocInsert({
                        html: pendingTableTransfer.htmlTable,
                        label: pendingTableTransfer.label,
                        nonce: Date.now(),
                      });
                      openFileInTab(doc.id, 'document');
                      setPendingTableTransfer(null);
                    }}
                    className="text-[11px] font-semibold text-blue-700 hover:underline"
                  >
                    + New Document
                  </button>
                </div>
                {documents.slice(0, 6).map((doc) => (
                  <button
                    key={doc.id}
                    onClick={() => {
                      setPendingDocInsert({
                        html: pendingTableTransfer.htmlTable,
                        label: pendingTableTransfer.label,
                        nonce: Date.now(),
                      });
                      openFileInTab(doc.id, 'document');
                      setPendingTableTransfer(null);
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg border border-slate-200 hover:border-blue-500 hover:bg-blue-50/50 flex items-center justify-between transition"
                  >
                    <span className="font-medium text-slate-800 truncate">{doc.title}</span>
                    <span className="text-[10px] text-blue-700 font-mono">Insert</span>
                  </button>
                ))}
              </div>

              {/* Slides destinations */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                    Forma Slides
                  </span>
                  <button
                    onClick={() => {
                      const deck = createBlankPresentation(
                        pendingTableTransfer.meta?.workbookTitle
                          ? `${pendingTableTransfer.meta.workbookTitle} Deck`
                          : 'Untitled Presentation'
                      );
                      const tableText =
                        pendingTableTransfer.meta?.plainText || pendingTableTransfer.label;
                      deck.slides[0].elements = [
                        {
                          id: uid('el'),
                          kind: 'text',
                          x: 56,
                          y: 44,
                          width: 848,
                          height: 54,
                          text: pendingTableTransfer.label,
                          fontSize: 28,
                          bold: true,
                          color: '#0f172a',
                        },
                        {
                          id: uid('el'),
                          kind: 'text',
                          x: 56,
                          y: 116,
                          width: 848,
                          height: 360,
                          text: tableText,
                          fontSize: 16,
                          fontFamily: 'JetBrains Mono, monospace',
                          color: '#1e293b',
                          fillColor: '#f8fafc',
                        },
                      ];
                      deck.slides[0].notes = `Source: ${pendingTableTransfer.label}`;
                      setPresentations((prev) => [deck, ...prev]);
                      openFileInTab(deck.id, 'slides');
                      notify(`Inserted table into new deck "${deck.title}"`);
                      setPendingTableTransfer(null);
                    }}
                    className="text-[11px] font-semibold text-amber-700 hover:underline"
                  >
                    + New Slide Deck
                  </button>
                </div>
                {presentations.slice(0, 6).map((deck) => (
                  <button
                    key={deck.id}
                    onClick={() => {
                      const tableText =
                        pendingTableTransfer.meta?.plainText || pendingTableTransfer.label;
                      const newSlide = {
                        id: uid('slide'),
                        backgroundColor: '#ffffff',
                        notes: `Source: ${pendingTableTransfer.label}`,
                        elements: [
                          {
                            id: uid('el'),
                            kind: 'text' as const,
                            x: 56,
                            y: 44,
                            width: 848,
                            height: 54,
                            text: pendingTableTransfer.label,
                            fontSize: 28,
                            bold: true,
                            color: '#0f172a',
                          },
                          {
                            id: uid('el'),
                            kind: 'text' as const,
                            x: 56,
                            y: 116,
                            width: 848,
                            height: 360,
                            text: tableText,
                            fontSize: 16,
                            fontFamily: 'JetBrains Mono, monospace',
                            color: '#1e293b',
                            fillColor: '#f8fafc',
                          },
                        ],
                      };
                      handleUpdatePresentation({
                        ...deck,
                        slides: [...deck.slides, newSlide],
                        updatedAt: Date.now(),
                      });
                      openFileInTab(deck.id, 'slides');
                      notify(`Added table slide to "${deck.title}"`);
                      setPendingTableTransfer(null);
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg border border-slate-200 hover:border-amber-500 hover:bg-amber-50/50 flex items-center justify-between transition"
                  >
                    <span className="font-medium text-slate-800 truncate">{deck.title}</span>
                    <span className="text-[10px] text-amber-800 font-mono">Add Slide</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {pendingCanvasTransfer && (
        <div
          onClick={() => setPendingCanvasTransfer(null)}
          className="no-print fixed inset-0 z-[110] bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-6"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden text-xs"
          >
            <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
              <div>
                <div className="text-sm font-bold text-slate-900">Embed Canvas Diagram in…</div>
                <div className="text-[11px] text-slate-500 truncate max-w-[330px]">
                  Live link: {pendingCanvasTransfer.title}
                </div>
              </div>
              <button
                onClick={() => setPendingCanvasTransfer(null)}
                className="px-2 py-1 rounded text-slate-500 hover:bg-slate-200"
              >
                Close
              </button>
            </div>

            <div className="p-4 space-y-4 max-h-[65vh] overflow-y-auto">
              {/* Preview */}
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-2 flex items-center justify-center max-h-36 overflow-hidden">
                <img
                  src={pendingCanvasTransfer.svgDataUrl}
                  alt={pendingCanvasTransfer.title}
                  className="max-h-32 max-w-full object-contain"
                />
              </div>

              {/* Clipboard option */}
              <button
                onClick={() => {
                  try {
                    void navigator.clipboard?.writeText(pendingCanvasTransfer.svgText);
                  } catch {
                    // ignore
                  }
                  notify(`Copied "${pendingCanvasTransfer.title}" SVG to clipboard`);
                  setPendingCanvasTransfer(null);
                }}
                className="w-full text-left px-3 py-2 rounded-lg border border-slate-200 hover:border-cyan-500 hover:bg-cyan-50/50 font-medium text-slate-800 transition"
              >
                Copy Vector SVG to Clipboard
              </button>

              {/* Docs destinations */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                    Forma Docs (live refreshable)
                  </span>
                  <button
                    onClick={() => {
                      const safeTitle = pendingCanvasTransfer.title.replace(/"/g, '&quot;');
                      const tag = `${pendingCanvasTransfer.canvasId}:${pendingCanvasTransfer.title}`.replace(/"/g, '&quot;');
                      const html = `<p><img src="${pendingCanvasTransfer.svgDataUrl}" alt="${safeTitle}" data-forma-canvas="${tag}" /></p>`;
                      const doc = createBlankDocument(`${pendingCanvasTransfer.title} Notes`);
                      setDocuments((prev) => [doc, ...prev]);
                      setPendingDocInsert({
                        html,
                        label: pendingCanvasTransfer.title,
                        nonce: Date.now(),
                        kind: 'canvas',
                      });
                      openFileInTab(doc.id, 'document');
                      setPendingCanvasTransfer(null);
                    }}
                    className="text-[11px] font-semibold text-blue-700 hover:underline"
                  >
                    + New Document
                  </button>
                </div>
                {documents.slice(0, 6).map((doc) => (
                  <button
                    key={doc.id}
                    onClick={() => {
                      const safeTitle = pendingCanvasTransfer.title.replace(/"/g, '&quot;');
                      const tag = `${pendingCanvasTransfer.canvasId}:${pendingCanvasTransfer.title}`.replace(/"/g, '&quot;');
                      const html = `<p><img src="${pendingCanvasTransfer.svgDataUrl}" alt="${safeTitle}" data-forma-canvas="${tag}" /></p>`;
                      setPendingDocInsert({
                        html,
                        label: pendingCanvasTransfer.title,
                        nonce: Date.now(),
                        kind: 'canvas',
                      });
                      openFileInTab(doc.id, 'document');
                      setPendingCanvasTransfer(null);
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg border border-slate-200 hover:border-blue-500 hover:bg-blue-50/50 flex items-center justify-between transition"
                  >
                    <span className="font-medium text-slate-800 truncate">{doc.title}</span>
                    <span className="text-[10px] text-blue-700 font-mono">Embed</span>
                  </button>
                ))}
              </div>

              {/* Slides destinations */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                    Forma Slides (live refreshable)
                  </span>
                  <button
                    onClick={() => {
                      const deck = createBlankPresentation(`${pendingCanvasTransfer.title} Deck`);
                      deck.slides[0].elements = [
                        {
                          id: uid('el'),
                          kind: 'text',
                          x: 56,
                          y: 36,
                          width: 848,
                          height: 48,
                          text: pendingCanvasTransfer.title,
                          fontSize: 28,
                          bold: true,
                          color: '#0f172a',
                        },
                        {
                          id: uid('el'),
                          kind: 'image',
                          x: 72,
                          y: 102,
                          width: 816,
                          height: 396,
                          src: pendingCanvasTransfer.svgDataUrl,
                          linkedCanvasId: pendingCanvasTransfer.canvasId,
                          linkedCanvasTitle: pendingCanvasTransfer.title,
                        },
                      ];
                      deck.slides[0].notes = `Linked Forma Canvas: ${pendingCanvasTransfer.title}`;
                      setPresentations((prev) => [deck, ...prev]);
                      openFileInTab(deck.id, 'slides');
                      notify(`Embedded canvas into new deck "${deck.title}"`);
                      setPendingCanvasTransfer(null);
                    }}
                    className="text-[11px] font-semibold text-amber-700 hover:underline"
                  >
                    + New Slide Deck
                  </button>
                </div>
                {presentations.slice(0, 6).map((deck) => (
                  <button
                    key={deck.id}
                    onClick={() => {
                      const newSlide = {
                        id: uid('slide'),
                        backgroundColor: '#ffffff',
                        notes: `Linked Forma Canvas: ${pendingCanvasTransfer.title}`,
                        elements: [
                          {
                            id: uid('el'),
                            kind: 'text' as const,
                            x: 56,
                            y: 36,
                            width: 848,
                            height: 48,
                            text: pendingCanvasTransfer.title,
                            fontSize: 28,
                            bold: true,
                            color: '#0f172a',
                          },
                          {
                            id: uid('el'),
                            kind: 'image' as const,
                            x: 72,
                            y: 102,
                            width: 816,
                            height: 396,
                            src: pendingCanvasTransfer.svgDataUrl,
                            linkedCanvasId: pendingCanvasTransfer.canvasId,
                            linkedCanvasTitle: pendingCanvasTransfer.title,
                          },
                        ],
                      };
                      handleUpdatePresentation({
                        ...deck,
                        slides: [...deck.slides, newSlide],
                        updatedAt: Date.now(),
                      });
                      openFileInTab(deck.id, 'slides');
                      notify(`Added live canvas slide to "${deck.title}"`);
                      setPendingCanvasTransfer(null);
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg border border-slate-200 hover:border-amber-500 hover:bg-amber-50/50 flex items-center justify-between transition"
                  >
                    <span className="font-medium text-slate-800 truncate">{deck.title}</span>
                    <span className="text-[10px] text-amber-800 font-mono">Add Slide</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="no-print fixed bottom-12 right-5 z-50 bg-slate-900 text-white text-xs font-medium px-3.5 py-2 rounded-xl shadow-xl border border-slate-700">
          {toast}
        </div>
      )}
    </div>
  );
};

export default App;
