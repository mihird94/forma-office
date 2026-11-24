// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasApp } from '../components/canvas/CanvasApp';
import { createBlankCanvas } from '../engine/canvas/canvasTemplates';
import { CanvasData } from '../types/canvas';

let host: HTMLDivElement;
let root: Root;

function CanvasHarness({ initial }: { initial: CanvasData }) {
  const [canvas, setCanvas] = useState<CanvasData>(initial);
  return (
    <div style={{ width: 1000, height: 700 }}>
      <CanvasApp
        canvas={canvas}
        onChangeCanvas={setCanvas}
        onImportCanvasFile={() => {}}
        onNotify={() => {}}
      />
    </div>
  );
}

function setNativeTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('Forma Canvas inline text rendering & editing for notes and boxes', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('renders sticky note and box text using native SVG <text> (no <foreignObject>)', async () => {
    const board = createBlankCanvas('Test Board');
    board.elements = [
      {
        id: 'box_1',
        kind: 'rect',
        x: 80,
        y: 80,
        width: 180,
        height: 90,
        text: 'Core API Box',
        fill: '#ffffff',
        stroke: '#0f172a',
      },
      {
        id: 'note_1',
        kind: 'sticky',
        x: 320,
        y: 80,
        width: 180,
        height: 150,
        text: 'Sticky Note Idea',
        fill: '#fef08a',
        stroke: '#eab308',
      },
    ];

    await act(async () => {
      root.render(<CanvasHarness initial={board} />);
    });

    expect(host.querySelectorAll('foreignObject').length).toBe(0);
    const svgTexts = Array.from(host.querySelectorAll('svg text')).map((el) => el.textContent ?? '');
    expect(svgTexts.some((t) => t.includes('Core API Box'))).toBe(true);
    expect(svgTexts.some((t) => t.includes('Sticky Note Idea'))).toBe(true);
  });

  it('opens inline editor on double-click of a box and commits typed text', async () => {
    const board = createBlankCanvas('Box Edit Board');
    board.elements = [
      {
        id: 'box_1',
        kind: 'roundRect',
        x: 100,
        y: 100,
        width: 180,
        height: 90,
        text: 'Old Box Label',
        fill: '#ffffff',
        stroke: '#0f172a',
      },
    ];

    await act(async () => {
      root.render(<CanvasHarness initial={board} />);
    });

    const rectEl = host.querySelector('svg g rect[width="180"]');
    expect(rectEl).not.toBeNull();

    // Two rapid clicks on the box trigger double-tap inline text editing
    await act(async () => {
      rectEl!.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, detail: 1, clientX: 150, clientY: 140 })
      );
      rectEl!.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, detail: 2, clientX: 150, clientY: 140 })
      );
    });

    const textarea = host.querySelector('textarea') as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    expect(textarea?.value).toBe('Old Box Label');

    await act(async () => {
      setNativeTextareaValue(textarea!, 'Updated Gateway Box');
    });
    await act(async () => {
      textarea!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    });

    expect(host.querySelector('textarea')).toBeNull();
    const svgTexts = Array.from(host.querySelectorAll('svg text')).map((el) => el.textContent ?? '');
    expect(svgTexts.some((t) => t.includes('Updated Gateway Box'))).toBe(true);
  });

  it('opens inline editor via Enter key or Inspector Edit Text button on a sticky note', async () => {
    const board = createBlankCanvas('Sticky Edit Board');
    board.elements = [
      {
        id: 'note_1',
        kind: 'sticky',
        x: 100,
        y: 100,
        width: 190,
        height: 156,
        text: 'Initial Note',
        fill: '#fef08a',
        stroke: '#eab308',
      },
    ];

    await act(async () => {
      root.render(<CanvasHarness initial={board} />);
    });

    const noteRect = host.querySelector('svg g rect[width="190"]');
    expect(noteRect).not.toBeNull();

    await act(async () => {
      noteRect!.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, detail: 1, clientX: 160, clientY: 150 })
      );
    });

    // Floating inspector should expose the "Edit Text" button
    const buttons = Array.from(host.querySelectorAll('button'));
    const editBtn = buttons.find((b) => /edit text/i.test(b.textContent ?? ''));
    expect(editBtn).toBeDefined();

    // Pressing Enter while selected opens the inline textarea
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    });

    const textarea = host.querySelector('textarea') as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    expect(textarea?.value).toBe('Initial Note');

    await act(async () => {
      setNativeTextareaValue(textarea!, 'Ship Canvas Text Fix');
    });
    await act(async () => {
      textarea!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', metaKey: true }));
    });

    expect(host.querySelector('textarea')).toBeNull();
    const svgTexts = Array.from(host.querySelectorAll('svg text')).map((el) => el.textContent ?? '');
    expect(svgTexts.some((t) => t.includes('Ship Canvas Text Fix'))).toBe(true);
  });
});
