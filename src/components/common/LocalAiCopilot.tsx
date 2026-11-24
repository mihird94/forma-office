import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Bot,
  Check,
  Copy,
  Cpu,
  Database,
  FileBadge2,
  FileSpreadsheet,
  FileText,
  FlaskConical,
  Loader2,
  PenTool,
  Presentation,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  AiChatMessage,
  chatWithLocalAi,
  getSemanticStatus,
  SemanticIndexStatus,
  SemanticSearchHit,
  semanticSearchWorkspace,
} from '../../storage/aiSemanticStore';
import { WorkspaceFileKind } from '../../types/office';

export interface LocalAiCopilotProps {
  isOpen: boolean;
  onClose: () => void;
  activeFileKind?: WorkspaceFileKind | null;
  activeFileTitle?: string;
  activeFileContext?: string;
  onSelectFile?: (id: string, kind: WorkspaceFileKind) => void;
  onOpenExternalPath?: (path: string) => void;
  onInsertText?: (text: string) => void;
}

interface CopilotTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  citations?: SemanticSearchHit[];
  error?: boolean;
  timestamp: number;
}

interface QuickAction {
  label: string;
  prompt: string;
}

const DEFAULT_CHAT_MODELS = ['qwen3.5:9b', 'qwen3:8b', 'qwen2.5-coder:7b'];

function normalizeKind(kind: string): WorkspaceFileKind {
  switch (kind) {
    case 'spreadsheet':
    case 'document':
    case 'slides':
    case 'pdf':
    case 'notebook':
    case 'canvas':
      return kind;
    default:
      return 'document';
  }
}

function renderKindIcon(kind: string, className = 'w-3.5 h-3.5 shrink-0') {
  switch (kind) {
    case 'spreadsheet':
      return <FileSpreadsheet className={`${className} text-emerald-600`} />;
    case 'document':
      return <FileText className={`${className} text-blue-600`} />;
    case 'slides':
      return <Presentation className={`${className} text-amber-600`} />;
    case 'notebook':
      return <FlaskConical className={`${className} text-violet-600`} />;
    case 'pdf':
      return <FileBadge2 className={`${className} text-rose-600`} />;
    case 'canvas':
      return <PenTool className={`${className} text-cyan-600`} />;
    default:
      return <FileText className={`${className} text-slate-500`} />;
  }
}

function getQuickActions(kind?: WorkspaceFileKind | null): QuickAction[] {
  switch (kind) {
    case 'spreadsheet':
      return [
        {
          label: 'Write Formula',
          prompt:
            'Help me write an Excel-compatible spreadsheet formula for the active sheet. Suggest the most useful summary formulas based on the current columns and explain each formula clearly.',
        },
        {
          label: 'Explain Sheet',
          prompt:
            'Explain the structure, key metrics, formulas, and any notable patterns or potential issues in this spreadsheet.',
        },
        {
          label: 'Spot Anomalies',
          prompt:
            'Review the values and formulas in this sheet and point out any potential outliers, formula errors, or missing checks.',
        },
      ];
    case 'document':
      return [
        {
          label: 'Summarize',
          prompt:
            'Provide a concise executive summary of this document with key takeaways as bullet points.',
        },
        {
          label: 'Polish Tone',
          prompt:
            'Rewrite and polish the core sections of this document for clarity, conciseness, and crisp executive tone while preserving all facts.',
        },
        {
          label: 'Action Items',
          prompt:
            'Extract all concrete action items, owners (if mentioned), open questions, and next steps from this document.',
        },
      ];
    case 'slides':
      return [
        {
          label: 'Draft Slide Outline',
          prompt:
            'Draft an improved slide-by-slide outline with sharp headlines and concise 3-bullet talking points for this presentation.',
        },
        {
          label: 'Speaker Notes',
          prompt:
            'Write clear, natural speaker notes for the slides in this deck so the narrative flows smoothly.',
        },
      ];
    case 'pdf':
      return [
        {
          label: 'Summarize & Cite',
          prompt:
            'Summarize the main arguments, findings, and data in this PDF, citing page numbers or sections whenever available.',
        },
        {
          label: 'Key Takeaways',
          prompt:
            'List the 5 most important takeaways and definitions from this PDF document.',
        },
      ];
    case 'notebook':
      return [
        {
          label: 'Explain / Fix Code',
          prompt:
            'Review the code cells and outputs in this notebook. Explain what the pipeline does and suggest fixes for any bugs, errors, or edge cases.',
        },
        {
          label: 'Optimize & Test',
          prompt:
            'Suggest cleaner vectorization, performance improvements, and quick verification assertions for the code in this notebook.',
        },
      ];
    case 'canvas':
      return [
        {
          label: 'Draft Architecture (Mermaid)',
          prompt:
            'Generate a clean Mermaid flowchart (`graph LR` or `graph TD`) that expands or refines this canvas architecture diagram so I can import it directly into Forma Canvas.',
        },
        {
          label: 'Brainstorm Sticky Notes',
          prompt:
            'Based on the elements and frames on this canvas board, propose 6-8 concise sticky notes covering risks, missing components, and next milestones.',
        },
        {
          label: 'Summarize Board',
          prompt:
            'Summarize the architecture, visual sections, and key decisions represented on this whiteboard canvas in crisp bullet points.',
        },
      ];
    default:
      return [
        {
          label: 'Workspace Overview',
          prompt:
            'Search across my indexed workspace documents and summarize the main topics, projects, and open items.',
        },
        {
          label: 'Find Key Numbers',
          prompt:
            'Search my workspace documents and list the most important metrics, dates, and assumptions you find, with source citations.',
        },
      ];
  }
}

function renderMessageBody(
  content: string,
  onCopySnippet: (text: string) => void
): React.ReactNode {
  const segments = content.split(/(```[\s\S]*?```)/g);
  return (
    <div className="space-y-2 text-xs leading-relaxed text-slate-800 break-words">
      {segments.map((seg, idx) => {
        if (seg.startsWith('```') && seg.endsWith('```')) {
          const inner = seg.slice(3, -3);
          const newlineIdx = inner.indexOf('\n');
          const lang = newlineIdx > -1 ? inner.slice(0, newlineIdx).trim() : '';
          const code = newlineIdx > -1 ? inner.slice(newlineIdx + 1) : inner;
          return (
            <div
              key={idx}
              className="rounded-lg bg-slate-900 text-slate-100 overflow-hidden border border-slate-800"
            >
              <div className="px-2.5 py-1 bg-slate-800/90 flex items-center justify-between text-[10px] text-slate-400">
                <span className="font-mono uppercase">{lang || 'code'}</span>
                <button
                  type="button"
                  onClick={() => onCopySnippet(code.trim())}
                  className="inline-flex items-center gap-1 hover:text-white transition"
                >
                  <Copy className="w-3 h-3" />
                  <span>Copy</span>
                </button>
              </div>
              <pre className="p-2.5 overflow-x-auto text-[11px] font-mono leading-relaxed">
                <code>{code.trim()}</code>
              </pre>
            </div>
          );
        }

        const paragraphs = seg
          .split(/\n{2,}/)
          .map((p) => p.trim())
          .filter(Boolean);

        return (
          <React.Fragment key={idx}>
            {paragraphs.map((para, pIdx) => (
              <p key={pIdx} className="whitespace-pre-wrap">
                {para}
              </p>
            ))}
          </React.Fragment>
        );
      })}
    </div>
  );
}

export const LocalAiCopilot: React.FC<LocalAiCopilotProps> = ({
  isOpen,
  onClose,
  activeFileKind,
  activeFileTitle,
  activeFileContext,
  onSelectFile,
  onOpenExternalPath,
  onInsertText,
}) => {
  const [status, setStatus] = useState<SemanticIndexStatus | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_CHAT_MODELS[0]);
  const [ragEnabled, setRagEnabled] = useState<boolean>(true);
  const [input, setInput] = useState<string>('');
  const [turns, setTurns] = useState<CopilotTurn[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const availableModels = useMemo(() => {
    const ordered: string[] = [];
    for (const m of status?.chatModels ?? []) {
      if (m && !ordered.includes(m)) ordered.push(m);
    }
    for (const def of DEFAULT_CHAT_MODELS) {
      if (!ordered.includes(def)) ordered.push(def);
    }
    return ordered;
  }, [status]);

  const quickActions = useMemo(() => getQuickActions(activeFileKind), [activeFileKind]);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await getSemanticStatus();
      setStatus(next);
      if (next.activeChatModel) {
        setSelectedModel((prev) => {
          if (next.chatModels.length > 0 && !next.chatModels.includes(prev)) {
            return next.activeChatModel ?? next.chatModels[0];
          }
          return prev;
        });
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    refreshStatus();
    const timer = setTimeout(() => inputRef.current?.focus(), 40);
    return () => clearTimeout(timer);
  }, [isOpen, refreshStatus]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns, loading]);

  const copyText = useCallback((text: string, markerId?: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(text);
    }
    if (markerId) {
      setCopiedId(markerId);
      setTimeout(() => {
        setCopiedId((prev) => (prev === markerId ? null : prev));
      }, 1500);
    }
  }, []);

  const handleCitationClick = (hit: SemanticSearchHit) => {
    const isExternal = hit.docId.startsWith('file:') || (!onSelectFile && Boolean(hit.path));
    if (isExternal && onOpenExternalPath) {
      const targetPath = hit.path || hit.docId.replace(/^file:/, '');
      if (targetPath) {
        onOpenExternalPath(targetPath);
        return;
      }
    }
    if (onSelectFile) {
      onSelectFile(hit.docId, normalizeKind(hit.kind));
    }
  };

  const sendPrompt = async (rawPrompt: string) => {
    const prompt = rawPrompt.trim();
    if (!prompt || loading) return;

    const userTurn: CopilotTurn = {
      id: `u_${Date.now()}`,
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    };

    const nextHistory = [...turns, userTurn];
    setTurns(nextHistory);
    setInput('');
    setLoading(true);

    try {
      // Optional cross-workspace RAG retrieval
      let citations: SemanticSearchHit[] = [];
      if (ragEnabled) {
        try {
          const ragQuery = activeFileTitle ? `${prompt} ${activeFileTitle}` : prompt;
          citations = await semanticSearchWorkspace(ragQuery, undefined, 5);
        } catch {
          citations = [];
        }
      }

      const systemParts: string[] = [
        'You are Forma Local AI Copilot running privately on the user’s Mac via Ollama.',
        'Be concise, accurate, and directly actionable. Use plain formatting or fenced code blocks for formulas and code.',
      ];

      if (activeFileTitle || activeFileContext) {
        const trimmedContext = (activeFileContext ?? '').trim().slice(0, 7500);
        systemParts.push(
          `Active document: "${activeFileTitle || 'Untitled'}" (${activeFileKind ?? 'workspace'}).\n` +
            (trimmedContext ? `--- ACTIVE DOCUMENT CONTENT ---\n${trimmedContext}\n--- END ACTIVE DOCUMENT ---` : '')
        );
      }

      if (citations.length > 0) {
        const ragContext = citations
          .map((hit, i) => {
            const loc = hit.sectionLabel ? ` [${hit.sectionLabel}]` : '';
            return `[Source ${i + 1}] ${hit.title}${loc} (${hit.kind}):\n${hit.snippet}`;
          })
          .join('\n\n');
        systemParts.push(
          `Relevant snippets retrieved from across the user's Forma workspace (cite them by title/source number when helpful):\n${ragContext}`
        );
      }

      const apiMessages: AiChatMessage[] = [
        { role: 'system', content: systemParts.join('\n\n') },
        ...nextHistory.slice(-10).map((t) => ({
          role: t.role,
          content: t.content,
        })),
      ];

      const res = await chatWithLocalAi(apiMessages, selectedModel);

      if (res.ok && res.content) {
        setTurns((prev) => [
          ...prev,
          {
            id: `a_${Date.now()}`,
            role: 'assistant',
            content: res.content,
            model: res.model,
            citations: citations.length > 0 ? citations : undefined,
            timestamp: Date.now(),
          },
        ]);
      } else {
        setTurns((prev) => [
          ...prev,
          {
            id: `e_${Date.now()}`,
            role: 'assistant',
            content:
              res.error ||
              'Could not reach local Ollama. Make sure Ollama is running (`ollama serve`) and the selected model is pulled.',
            model: res.model,
            error: true,
            timestamp: Date.now(),
          },
        ]);
      }
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <aside
      aria-label="Forma Local AI Copilot"
      className="fixed inset-y-0 right-0 z-40 w-full sm:w-[420px] bg-white border-l border-slate-200 shadow-2xl flex flex-col"
    >
      {/* Header */}
      <div className="px-4 py-3 bg-slate-900 text-white flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-violet-500/20 border border-violet-400/30 flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4 text-violet-300" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h2 className="text-xs font-semibold tracking-tight truncate">Local AI Copilot</h2>
              <span
                className={`inline-block w-1.5 h-1.5 rounded-full ${
                  status?.ollamaOnline ? 'bg-emerald-400' : 'bg-amber-400'
                }`}
                title={status?.ollamaOnline ? 'Ollama connected' : 'Ollama offline'}
              />
            </div>
            <p className="text-[10px] text-slate-400 truncate">
              100% private · Ollama on 127.0.0.1
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {turns.length > 0 && (
            <button
              type="button"
              onClick={() => setTurns([])}
              title="Clear chat"
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={refreshStatus}
            title="Refresh local Ollama models"
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Close Copilot (⌘J)"
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Model Selector + Search All Docs (RAG) Toggle */}
      <div className="px-3.5 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <Cpu className="w-3.5 h-3.5 text-slate-500 shrink-0" />
          <select
            aria-label="Local Ollama model"
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="w-full max-w-[185px] text-xs font-medium bg-white border border-slate-200 rounded-lg px-2 py-1 text-slate-800 focus:outline-none focus:border-violet-500 truncate"
          >
            {availableModels.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={ragEnabled}
          onClick={() => setRagEnabled((prev) => !prev)}
          title="Automatically retrieve relevant snippets from all indexed workspace documents and cite sources"
          className={`h-7 px-2.5 rounded-lg text-[11px] font-medium border flex items-center gap-1.5 transition shrink-0 ${
            ragEnabled
              ? 'bg-violet-600 border-violet-600 text-white shadow-xs'
              : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-100'
          }`}
        >
          <Database className="w-3 h-3" />
          <span>Search All Docs (RAG)</span>
        </button>
      </div>

      {/* Active File Context + Quick Action Pills */}
      <div className="px-3.5 py-2 bg-white border-b border-slate-100 space-y-2 shrink-0">
        {activeFileTitle && (
          <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
            {renderKindIcon(activeFileKind ?? 'document', 'w-3.5 h-3.5 shrink-0')}
            <span className="truncate">
              Context: <strong className="font-semibold text-slate-700">{activeFileTitle}</strong>
            </span>
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          {quickActions.map((action) => (
            <button
              key={action.label}
              type="button"
              disabled={loading}
              onClick={() => void sendPrompt(action.prompt)}
              className="px-2.5 py-1 rounded-full text-[11px] font-medium bg-slate-100 text-slate-700 hover:bg-violet-50 hover:text-violet-700 border border-slate-200/70 hover:border-violet-200 disabled:opacity-50 transition"
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>

      {/* Chat Messages Thread */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3.5 py-4 space-y-4 bg-slate-50/40">
        {turns.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-4 py-8 space-y-3">
            <div className="w-11 h-11 rounded-2xl bg-violet-100 text-violet-600 flex items-center justify-center">
              <Bot className="w-6 h-6" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-semibold text-slate-800">
                Ask anything about your {activeFileKind ? `${activeFileKind}` : 'workspace'}
              </p>
              <p className="text-xs text-slate-500 max-w-xs leading-relaxed">
                Runs completely locally on Ollama. Enable{' '}
                <span className="font-medium text-violet-700">Search All Docs (RAG)</span> to pull
                grounded citations from across Sheets, Docs, Slides, PDFs, and Notebooks.
              </p>
            </div>
            {status && !status.ollamaOnline && (
              <div className="w-full rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 text-left text-[11px] text-amber-800">
                Ollama was not detected at <code className="font-mono">127.0.0.1:11434</code>. Run{' '}
                <code className="font-mono font-semibold">ollama serve</code> to enable local AI
                replies.
              </div>
            )}
          </div>
        ) : (
          turns.map((turn) => (
            <div
              key={turn.id}
              className={`flex flex-col ${turn.role === 'user' ? 'items-end' : 'items-start'}`}
            >
              <div
                className={`max-w-[92%] rounded-2xl px-3.5 py-2.5 shadow-2xs ${
                  turn.role === 'user'
                    ? 'bg-slate-900 text-white text-xs leading-relaxed'
                    : turn.error
                      ? 'bg-rose-50 border border-rose-200 text-rose-800 text-xs leading-relaxed'
                      : 'bg-white border border-slate-200/90 text-slate-800'
                }`}
              >
                {turn.role === 'user' ? (
                  <p className="whitespace-pre-wrap">{turn.content}</p>
                ) : (
                  <>
                    {renderMessageBody(turn.content, (txt) => copyText(txt))}

                    {/* Assistant message actions */}
                    {!turn.error && (
                      <div className="mt-2.5 pt-2 border-t border-slate-100 flex items-center justify-between gap-2 text-[10px] text-slate-400">
                        <span className="font-mono truncate">{turn.model ?? selectedModel}</span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {onInsertText && (
                            <button
                              type="button"
                              onClick={() => onInsertText(turn.content)}
                              className="px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 hover:bg-violet-100 font-medium transition"
                            >
                              Insert
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => copyText(turn.content, turn.id)}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition"
                          >
                            {copiedId === turn.id ? (
                              <>
                                <Check className="w-3 h-3 text-emerald-600" />
                                <span className="text-emerald-600">Copied</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3 h-3" />
                                <span>Copy</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Clickable RAG Source Citations */}
                    {turn.citations && turn.citations.length > 0 && (
                      <div className="mt-2.5 pt-2 border-t border-slate-100 space-y-1.5">
                        <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                          <BookOpen className="w-3 h-3 text-violet-500" />
                          <span>Sources ({turn.citations.length})</span>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {turn.citations.map((hit, idx) => (
                            <button
                              key={`${hit.docId}:${idx}`}
                              type="button"
                              onClick={() => handleCitationClick(hit)}
                              title={`${hit.title}${hit.sectionLabel ? ` — ${hit.sectionLabel}` : ''}\n${hit.snippet}`}
                              className="max-w-full inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-slate-50 hover:bg-violet-50 border border-slate-200 hover:border-violet-300 text-[11px] text-slate-700 hover:text-violet-800 transition text-left"
                            >
                              {renderKindIcon(hit.kind, 'w-3 h-3 shrink-0')}
                              <span className="font-medium truncate max-w-[160px]">
                                {hit.title}
                              </span>
                              {hit.sectionLabel && (
                                <span className="text-[10px] text-slate-400 truncate max-w-[90px]">
                                  · {hit.sectionLabel}
                                </span>
                              )}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          ))
        )}

        {loading && (
          <div className="flex items-center gap-2 text-xs text-slate-500 bg-white border border-slate-200 rounded-2xl px-3.5 py-2.5 w-fit shadow-2xs">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-600" />
            <span>
              {ragEnabled ? 'Searching docs & thinking locally…' : `Thinking with ${selectedModel}…`}
            </span>
          </div>
        )}
      </div>

      {/* Composer */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void sendPrompt(input);
        }}
        className="p-3 bg-white border-t border-slate-200 shrink-0"
      >
        <div className="rounded-xl border border-slate-300 focus-within:border-violet-500 focus-within:ring-2 focus-within:ring-violet-500/15 bg-white flex items-end gap-2 p-2 transition">
          <textarea
            ref={inputRef}
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void sendPrompt(input);
              }
            }}
            placeholder={
              ragEnabled
                ? 'Ask across all your workspace docs… (Enter to send)'
                : 'Ask about this file… (Enter to send)'
            }
            className="flex-1 resize-none text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none max-h-32 leading-relaxed"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            title="Send message"
            className="h-8 w-8 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:bg-slate-200 disabled:text-slate-400 flex items-center justify-center transition shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[10px] text-slate-400 px-0.5">
          <span>
            {status
              ? `${status.indexedDocs} indexed docs · ${status.indexedChunks} chunks`
              : 'Local index ready'}
          </span>
          <span>⇧Enter for newline · ⌘J to toggle</span>
        </div>
      </form>
    </aside>
  );
};
