import React, { act, createRef, useState } from 'react';
import { createRoot, Root } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocsApp, DocumentEditorHandle } from '../components/docs/DocsApp';
import { SheetsApp, SpreadsheetEditorHandle } from '../components/sheets/SheetsApp';
import { FormaDocument } from '../types/document';
import { WorkbookData } from '../types/spreadsheet';
import { createBlankWorkbook } from '../engine/spreadsheet/workbookOps';
import { initializeWorkspace, useStoredRecords } from '../storage/recordStore';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const original: FormaDocument = {
  id: 'save-integrity-document', title: 'Save integrity', html: '<p>Original</p>',
  pageSettings: { pageSize: 'letter', margins: 'normal', fontFamily: 'Inter' },
  createdAt: 1, updatedAt: 1,
};

async function openDocument() {
  const handle = createRef<DocumentEditorHandle>();
  const changes = vi.fn();
  const pending = vi.fn();
  const states = new Map();
  function Harness() {
    const [doc, setDoc] = useState(original);
    return <DocsApp ref={handle} document={doc} editorStates={states}
      onChangeDocument={(next) => { changes(next); setDoc(next); }}
      onPendingChange={pending} onImportNewDocument={vi.fn()}
      onClearPendingInsert={vi.fn()} onNotify={vi.fn()} />;
  }
  await act(async () => { root.render(<Harness />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const editor = (host.querySelector('.forma-doc-editor') as HTMLElement & { editor: Editor }).editor;
  return { editor, handle, changes, pending };
}

describe('Save integrity at editor and storage boundaries', () => {
  it('captures the latest edit for an immediate Save before serialization runs', async () => {
    const { editor, handle, changes, pending } = await openDocument();
    await act(async () => { editor.commands.insertContent('Latest edit '); });
    expect(changes).not.toHaveBeenCalled();
    expect(pending).toHaveBeenLastCalledWith(original.id, true);

    let snapshot: FormaDocument | undefined;
    await act(async () => { snapshot = handle.current!.snapshot(); });
    expect(snapshot!.html).toContain('Latest edit');
    expect(changes).toHaveBeenLastCalledWith(snapshot);
    expect(pending).toHaveBeenLastCalledWith(original.id, false);
    expect(host.querySelector('.forma-doc-editor')!.textContent).toContain('Latest edit');
  });

  it('protects a pending edit on immediate close and flushes it to the workspace', async () => {
    const { editor, changes } = await openDocument();
    await act(async () => { editor.commands.insertContent('Before closing '); });
    const event = new Event('beforeunload', { cancelable: true });
    await act(async () => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(changes.mock.lastCall![0].html).toContain('Before closing');
  });

  it('reports a failed fallback write and retries without discarding the edit', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const key = 'forma-save-integrity-test';
    const write = Storage.prototype.setItem;
    let rejectWrite = true;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name, value) {
      if (name === key && rejectWrite) throw new DOMException('Storage is full', 'QuotaExceededError');
      write.call(this, name, value);
    });
    await initializeWorkspace([key]);
    let store!: ReturnType<typeof useStoredRecords<FormaDocument>>;
    function Harness() {
      store = useStoredRecords<FormaDocument>(key);
      return <span>{store.state(original.id)}</span>;
    }
    await act(async () => { root.render(<Harness />); });
    await act(async () => { store.setItems([original]); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(store.state(original.id)).toBe('error');
    expect(store.items[0]).toEqual(original);
    expect(localStorage.getItem(key)).toBeNull();

    rejectWrite = false;
    await act(async () => { store.retry(); });
    expect(store.state(original.id)).toBe('saved');
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([original]);
  });

  it('flushes an uncommitted spreadsheet cell edit synchronously via snapshot() for Cmd+S', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    const initialWb = createBlankWorkbook('Live Edit Sheet');
    const sheetHandle = createRef<SpreadsheetEditorHandle>();
    const onChanges = vi.fn();
    function SheetHarness() {
      const [wb, setWb] = useState<WorkbookData>(initialWb);
      return (
        <SheetsApp
          ref={sheetHandle}
          workbook={wb}
          onChangeWorkbook={(next) => {
            onChanges(next);
            setWb(next);
          }}
          onImportNewWorkbook={vi.fn()}
          onSendTableToDocs={vi.fn()}
          onNotify={vi.fn()}
        />
      );
    }
    await act(async () => { root.render(<SheetHarness />); });
    const formulaInput = host.querySelector('input[aria-label="Formula bar"], input[placeholder*="formula"], input[placeholder*="Formula"]') as HTMLInputElement | null;
    // Double click cell A1 to open inline editor and type without pressing Enter
    const cellA1 = host.querySelector('td[data-cell="A1"]') as HTMLElement;
    expect(cellA1).toBeTruthy();
    await act(async () => {
      cellA1.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    const inlineInput = cellA1.querySelector('input') as HTMLInputElement | null;
    const activeInput = inlineInput ?? formulaInput;
    expect(activeInput).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(activeInput, '98765');
      activeInput!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    let snap: WorkbookData | undefined;
    await act(async () => {
      snap = sheetHandle.current!.snapshot();
    });
    expect(snap!.sheets[0].cells['A1']?.raw).toBe('98765');
    expect(onChanges).toHaveBeenCalled();
  });
});
