import { describe, expect, it } from 'vitest';
import { buildSandboxedHtmlSrcDoc, detectExternalHtmlOrigins, exportRawHtmlWithComments, extractHtmlReviewComments, formatCommentsForAgent, importDocumentFromHtml, registerNativeHtmlPreview, stripHtmlReviewComments } from '../engine/document/formats/htmlCodec';

describe('HTML review mode', () => {
  const comment = { id: '1', author: 'A', text: 'Close </script> safely', createdAt: 1, pin: { xPct: 20, yPct: 30 }, quote: 'hello' };
  it('round trips comments without closing the script and omits script when empty', () => {
    const clean = exportRawHtmlWithComments('<html><body>Hello</body></html>', []);
    expect(clean).not.toContain('forma-review-comments');
    const html = exportRawHtmlWithComments('<html><body>Hello</body></html>', [comment]);
    expect(html).toContain('<\\/script>');
    expect(extractHtmlReviewComments(html)).toEqual([comment]);
    expect(stripHtmlReviewComments(html)).not.toContain('forma-review-comments');
    expect(importDocumentFromHtml(html).comments).toEqual([comment]);
  });
  it('detects external origins and preserves doctype while enforcing opt-in', () => {
    const html = '<!doctype html><html><body><script src="https://cdn.example/a.js"></script><img src="https://photos.example/x.png"><style>x{background:url(https://img.example/a)}</style></body></html>';
    expect(detectExternalHtmlOrigins(html)).toEqual(['https://cdn.example', 'https://img.example', 'https://photos.example']);
    const offline = buildSandboxedHtmlSrcDoc(html, { allowExternalOrigins: [] });
    expect(offline.toLowerCase().startsWith('<!doctype html>')).toBe(true);
    expect(offline).toContain("connect-src blob: data:;");
    expect(buildSandboxedHtmlSrcDoc(html, { allowExternalOrigins: ['https://cdn.example'] })).toContain('connect-src blob: data: https://cdn.example');
    expect(buildSandboxedHtmlSrcDoc(html, { allowExternalOrigins: ['https://fonts.googleapis.com'] })).toContain('https://fonts.gstatic.com');
  });
  it('registers native forma-preview URL when webkit bridge is present', async () => {
    expect(await registerNativeHtmlPreview('<p>Hi</p>', [])).toBeNull();
    const w = window as unknown as {
      webkit?: { messageHandlers?: { formaRegisterHtmlPreview?: { postMessage: (p: { requestId: string }) => void } } };
      __formaResolveHtmlPreview?: (id: string, url: string) => void;
    };
    w.webkit = {
      messageHandlers: {
        formaRegisterHtmlPreview: {
          postMessage: ({ requestId }) => {
            queueMicrotask(() => w.__formaResolveHtmlPreview?.(requestId, 'forma-preview://doc/tok123'));
          },
        },
      },
    };
    try {
      expect(await registerNativeHtmlPreview('<p>Hi</p>', [])).toBe('forma-preview://doc/tok123');
    } finally {
      delete w.webkit;
      delete w.__formaResolveHtmlPreview;
    }
  });
  it('formats open comments for an agent', () => {
    expect(formatCommentsForAgent('Test', [comment, { ...comment, id: '2', text: 'resolved', resolved: true }])).toContain('[Pin 20%, 30%]');
    expect(formatCommentsForAgent('Test', [comment, { ...comment, id: '2', text: 'resolved', resolved: true }])).not.toContain('resolved');
  });
});

import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { HtmlReviewWorkspace } from '../components/docs/HtmlReviewWorkspace';
import { vi } from 'vitest';
import { listWorkspaceFiles } from '../storage/workspaceStore';

it('shows HTML as the format in the recent files list', () => {
  const doc = importDocumentFromHtml('<html><body><h1>Example</h1></body></html>', 'example.html');
  expect(listWorkspaceFiles([], [doc])[0].primaryFormat).toBe('.html');
});

it('enables known CDN origins by default while requiring opt-in for other hosts', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const source = '<script src="https://cdn.tailwindcss.com"></script><script src="https://unknown.example/lib.js"></script>';
  try {
    await act(async () => { root.render(<HtmlReviewWorkspace source={source} comments={[]} onSourceChange={() => {}} onPin={() => {}} onSelection={() => {}} onSelectComment={() => {}} onConvert={() => {}} />); });
    const frame = host.querySelector('iframe')!;
    const policy = () => frame.srcdoc.match(/content="([^"]+)"/)![1];
    expect(policy()).toContain('https://cdn.tailwindcss.com');
    expect(policy()).not.toContain('https://unknown.example');
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Load CDNs'))!.click(); });
    expect(policy()).toContain('https://unknown.example');
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent?.includes('CDNs Active'))!.click(); });
    expect(policy()).not.toContain('https://cdn.tailwindcss.com');
    expect(policy()).not.toContain('https://unknown.example');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('places pins, receives preview selection, and requests conversion', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const onPin = vi.fn(), onSelection = vi.fn(), onConvert = vi.fn();
  await act(async () => { root.render(<HtmlReviewWorkspace source="<p>Hello</p>" comments={[]} onSourceChange={() => {}} onPin={onPin} onSelection={onSelection} onSelectComment={() => {}} onConvert={onConvert} />); });
  const buttons = [...host.querySelectorAll('button')];
  await act(async () => { buttons.find(b => b.textContent === 'Drop Pin Comment')!.click(); });
  const overlay = host.querySelector('[aria-label="Place pin"]') as HTMLElement;
  overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON() {} });
  await act(async () => { overlay.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 25, clientY: 50 })); });
  expect(onPin).toHaveBeenCalledWith({ xPct: 25, yPct: 50 });
  const frame = host.querySelector('iframe[aria-label="Live HTML Preview"]') as HTMLIFrameElement;
  expect(frame).toBeTruthy();
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
  expect(frame.hasAttribute('title')).toBe(false);
  await act(async () => { window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'forma-html-selection', quote: 'Hello' } })); });
  expect(onSelection).toHaveBeenCalledWith('Hello');
  await act(async () => { buttons.find(b => b.textContent === 'Convert to Editable Doc')!.click(); });
  expect(onConvert).toHaveBeenCalled();
  await act(async () => root.unmount());
  host.remove();
});

import { DocsApp } from '../components/docs/DocsApp';
import type { FormaDocument } from '../types/document';

it('converts live HTML into a sanitized editable TipTap document', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const initial: FormaDocument = {
    id: 'convert-test', title: 'Convert', html: '<p>Fallback</p>',
    rawHtmlSource: '<html><body><p>Editable content</p><script>window.bad = true</script></body></html>',
    sourceFormat: 'html', pageSettings: { pageSize: 'letter', margins: 'normal', fontFamily: 'Inter' }, createdAt: 1, updatedAt: 1,
  };
  const changed = vi.fn();
  const states = new Map();
  function Harness() {
    const [doc, setDoc] = React.useState(initial);
    return <DocsApp document={doc} editorStates={states} onChangeDocument={next => { changed(next); setDoc(next); }} onPendingChange={() => {}} onImportNewDocument={() => {}} onClearPendingInsert={() => {}} onNotify={() => {}} />;
  }
  try {
    await act(async () => { root.render(<Harness />); });
    expect(host.querySelector('iframe[aria-label="Live HTML Preview"]')).toBeTruthy();
    expect(host.textContent).not.toContain('Page Layout');
    expect(host.textContent).not.toContain('US Letter');
    const convert = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Convert to Editable Doc'))!;
    await act(async () => { convert.click(); });
    expect(changed).toHaveBeenCalled();
    const updated: FormaDocument = changed.mock.lastCall![0];
    expect(updated.rawHtmlSource).toBeUndefined();
    expect(updated.html).toContain('Editable content');
    expect(updated.html).not.toContain('<script');
    expect(host.querySelector('iframe[aria-label="Live HTML Preview"]')).toBeNull();
    expect(host.textContent).toContain('Page Layout');
    expect(host.querySelector('.forma-doc-editor')?.textContent).toContain('Editable content');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
