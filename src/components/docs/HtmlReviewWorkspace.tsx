import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DocComment } from '../../types/document';
import { buildSandboxedHtmlSrcDoc, detectExternalHtmlOrigins } from '../../engine/document/formats/htmlCodec';

interface Props {
  source: string;
  comments: DocComment[];
  selectedComment?: string;
  onSourceChange: (source: string) => void;
  onPin: (pin: NonNullable<DocComment['pin']>) => void;
  onSelection: (quote: string) => void;
  onSelectComment: (id: string) => void;
  onConvert: () => void;
}

export const HtmlReviewWorkspace: React.FC<Props> = ({
  source,
  comments,
  selectedComment,
  onSourceChange,
  onPin,
  onSelection,
  onSelectComment,
  onConvert,
}) => {
  const [view, setView] = useState<'preview' | 'split' | 'source'>('preview');
  const [pinMode, setPinMode] = useState(false);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [draftSource, setDraftSource] = useState(source);
  const iframe = useRef<HTMLIFrameElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommittedRef = useRef(source);

  useEffect(() => {
    if (source !== lastCommittedRef.current) {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      lastCommittedRef.current = source;
      setDraftSource(source);
    }
  }, [source]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleDraftChange = (next: string) => {
    setDraftSource(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      lastCommittedRef.current = next;
      onSourceChange(next);
    }, 150);
  };

  const flushDraft = () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
      lastCommittedRef.current = draftSource;
      onSourceChange(draftSource);
    }
  };

  const origins = useMemo(() => detectExternalHtmlOrigins(draftSource), [draftSource]);
  const srcDoc = useMemo(
    () => buildSandboxedHtmlSrcDoc(draftSource, { allowExternalOrigins: allowed }),
    [draftSource, allowed]
  );
  const openPins = useMemo(
    () => comments.filter((c): c is DocComment & { pin: NonNullable<DocComment['pin']> } => !c.resolved && Boolean(c.pin)),
    [comments]
  );

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source === iframe.current?.contentWindow &&
        event.data?.type === 'forma-html-selection' &&
        typeof event.data.quote === 'string'
      ) {
        onSelection(event.data.quote.slice(0, 1000));
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [onSelection]);

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      <div className="flex flex-wrap items-center gap-2 p-2 border-b bg-slate-50">
        {([
          ['preview', 'Live Preview'],
          ['split', 'Split'],
          ['source', 'HTML Source'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`px-2.5 py-1 rounded text-xs font-medium transition ${
              view === id ? 'bg-blue-600 text-white' : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
            }`}
            onClick={() => setView(id)}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          className={`px-2.5 py-1 rounded text-xs font-medium transition ${
            pinMode ? 'bg-blue-600 text-white' : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
          }`}
          onClick={() => setPinMode((v) => !v)}
        >
          Drop Pin Comment
        </button>
        <button
          type="button"
          className="px-2.5 py-1 rounded bg-white border border-slate-200 text-slate-700 hover:bg-slate-100 text-xs font-medium transition ml-auto"
          onClick={() => {
            flushDraft();
            onConvert();
          }}
        >
          Convert to Editable Doc
        </button>
      </div>
      {origins.some((origin) => !allowed.includes(origin)) && (
        <div className="px-3 py-1.5 bg-amber-50 border-b border-amber-200 text-xs text-amber-900 flex flex-wrap items-center gap-2">
          <span>External libraries are blocked in Offline Sandbox.</span>
          <button
            type="button"
            className="underline font-medium hover:text-amber-700"
            onClick={() => setAllowed(origins)}
          >
            Load External Libraries ({origins.join(', ')})
          </button>
        </div>
      )}
      <div className="flex flex-1 min-h-0 min-w-0">
        {view !== 'preview' && (
          <textarea
            aria-label="HTML Source Editor"
            className="flex-1 min-w-0 p-3 font-mono text-xs resize-none border-r border-slate-200 focus:outline-none bg-white text-slate-900"
            spellCheck={false}
            value={draftSource}
            onChange={(e) => handleDraftChange(e.target.value)}
            onBlur={flushDraft}
          />
        )}
        {view !== 'source' && (
          <div className="relative flex-1 min-w-0 bg-white">
            <iframe
              ref={iframe}
              title="Live HTML Preview"
              sandbox="allow-scripts"
              srcDoc={srcDoc}
              className="w-full h-full border-0"
            />
            {pinMode && (
              <div
                aria-label="Place pin"
                className="absolute inset-0 cursor-crosshair bg-blue-500/5"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  if (r.width && r.height) {
                    onPin({
                      xPct: Math.max(0, Math.min(100, Math.round(((e.clientX - r.left) / r.width) * 100))),
                      yPct: Math.max(0, Math.min(100, Math.round(((e.clientY - r.top) / r.height) * 100))),
                    });
                  }
                  setPinMode(false);
                }}
              />
            )}
            {openPins.map((c, i) => (
              <button
                key={c.id}
                type="button"
                aria-label={`Pin ${i + 1}`}
                title={`${c.author}: ${c.text}`}
                onClick={() => onSelectComment(c.id)}
                style={{ left: `${c.pin.xPct}%`, top: `${c.pin.yPct}%` }}
                className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full w-6 h-6 text-white text-xs font-semibold shadow transition ${
                  selectedComment === c.id
                    ? 'bg-amber-500 ring-4 ring-amber-200 scale-110'
                    : 'bg-blue-600 hover:bg-blue-700'
                }`}
              >
                {i + 1}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
