import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  MessageSquarePlus,
  Quote,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { DocComment } from '../../types/document';

interface DocsCommentsPanelProps {
  comments: DocComment[];
  selectedQuote?: string;
  onAddComment: (comment: { author: string; text: string; quote?: string }) => void;
  onToggleResolve: (id: string) => void;
  onDeleteComment: (id: string) => void;
  onJumpToQuote?: (quote: string) => void;
  onClose: () => void;
}

function formatCommentTime(ts: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const DocsCommentsPanel: React.FC<DocsCommentsPanelProps> = ({
  comments,
  selectedQuote,
  onAddComment,
  onToggleResolve,
  onDeleteComment,
  onJumpToQuote,
  onClose,
}) => {
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [author, setAuthor] = useState('You');
  const [draftText, setDraftText] = useState('');
  const [capturedQuote, setCapturedQuote] = useState<string>(selectedQuote?.trim() ?? '');

  useEffect(() => {
    const next = selectedQuote?.trim() ?? '';
    if (next) {
      setCapturedQuote(next);
    }
  }, [selectedQuote]);

  const openCount = comments.filter((c) => !c.resolved).length;
  const visibleComments =
    filter === 'open' ? comments.filter((c) => !c.resolved) : comments;

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const cleaned = draftText.trim();
    if (!cleaned) return;
    onAddComment({
      author: author.trim() || 'You',
      text: cleaned,
      quote: capturedQuote.trim() || undefined,
    });
    setDraftText('');
    setCapturedQuote('');
  };

  return (
    <aside
      aria-label="Review Comments"
      className="no-print w-72 bg-white border-l border-slate-200 flex flex-col shrink-0"
    >
      {/* Header */}
      <div className="px-3.5 py-3 border-b border-slate-100 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <MessageSquarePlus className="w-4 h-4 text-blue-600 shrink-0" />
          <span className="text-xs font-semibold text-slate-800 truncate">Comments</span>
          <span className="px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 text-[10px] font-semibold font-mono">
            {openCount}
          </span>
        </div>
        <button
          onClick={onClose}
          title="Close Comments Panel"
          className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Filter Tabs */}
      <div className="px-3.5 py-2 border-b border-slate-100 flex items-center gap-1 bg-slate-50/60">
        <button
          onClick={() => setFilter('open')}
          className={`flex-1 py-1 px-2 rounded-md text-[11px] font-medium transition ${
            filter === 'open'
              ? 'bg-white text-blue-700 shadow-2xs border border-slate-200'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Open ({openCount})
        </button>
        <button
          onClick={() => setFilter('all')}
          className={`flex-1 py-1 px-2 rounded-md text-[11px] font-medium transition ${
            filter === 'all'
              ? 'bg-white text-blue-700 shadow-2xs border border-slate-200'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          All ({comments.length})
        </button>
      </div>

      {/* New Comment Composer */}
      <form onSubmit={handleSubmit} className="p-3 border-b border-slate-200 bg-slate-50/40 space-y-2">
        {capturedQuote && (
          <div className="flex items-start gap-1.5 px-2 py-1.5 rounded-md bg-amber-50 border border-amber-200/80 text-[11px] text-amber-900">
            <Quote className="w-3 h-3 text-amber-600 shrink-0 mt-0.5" />
            <span className="flex-1 line-clamp-2 italic">“{capturedQuote}”</span>
            <button
              type="button"
              onClick={() => setCapturedQuote('')}
              title="Remove captured quote"
              className="text-amber-500 hover:text-amber-800 shrink-0"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-medium text-slate-400">As</span>
          <input
            type="text"
            aria-label="Comment Author"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="Your name"
            className="flex-1 h-6 px-2 text-[11px] bg-white border border-slate-200 rounded text-slate-700 focus:outline-none focus:border-blue-500"
          />
        </div>

        <textarea
          aria-label="Add review comment"
          rows={3}
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              handleSubmit();
            }
          }}
          placeholder={
            capturedQuote
              ? 'Comment on selected text… (⌘Enter to post)'
              : 'Select text to quote or write a review comment… (⌘Enter)'
          }
          className="w-full p-2 text-xs bg-white border border-slate-200 rounded-md text-slate-800 placeholder:text-slate-400 resize-none focus:outline-none focus:border-blue-500"
        />

        <div className="flex items-center justify-between">
          <span className="text-[10px] text-slate-400">
            {capturedQuote ? 'Selection quoted' : 'Select text to quote'}
          </span>
          <button
            type="submit"
            disabled={!draftText.trim()}
            className="px-2.5 py-1 rounded-md bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-[11px] font-semibold transition"
          >
            Comment
          </button>
        </div>
      </form>

      {/* Comments List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {visibleComments.length === 0 ? (
          <div className="text-center py-8 px-2 text-xs text-slate-400">
            {filter === 'open' && comments.length > 0
              ? 'All comments are resolved.'
              : 'No review comments yet. Select text in the document to add a quoted note.'}
          </div>
        ) : (
          visibleComments.map((c) => (
            <div
              key={c.id}
              className={`rounded-lg border p-2.5 space-y-1.5 transition ${
                c.resolved
                  ? 'bg-slate-50/70 border-slate-200/80 opacity-75'
                  : 'bg-white border-slate-200 shadow-2xs'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[11px] font-semibold text-slate-800 truncate">
                    {c.author}
                  </span>
                  <span className="text-[10px] text-slate-400 shrink-0">
                    {formatCommentTime(c.createdAt)}
                  </span>
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  <button
                    onClick={() => onToggleResolve(c.id)}
                    title={c.resolved ? 'Reopen comment' : 'Mark as resolved'}
                    className={`p-1 rounded transition ${
                      c.resolved
                        ? 'text-emerald-600 hover:bg-emerald-50'
                        : 'text-slate-400 hover:text-emerald-600 hover:bg-emerald-50'
                    }`}
                  >
                    {c.resolved ? (
                      <RotateCcw className="w-3.5 h-3.5" />
                    ) : (
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    )}
                  </button>
                  <button
                    onClick={() => onDeleteComment(c.id)}
                    title="Delete comment"
                    className="p-1 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {c.quote && (
                <button
                  type="button"
                  onClick={() => onJumpToQuote?.(c.quote!)}
                  title="Jump to quoted text"
                  className="w-full text-left px-2 py-1 rounded bg-amber-50/90 border-l-2 border-amber-400 text-[11px] text-amber-900 italic line-clamp-2 hover:bg-amber-100/70 transition"
                >
                  “{c.quote}”
                </button>
              )}

              <p className="text-xs text-slate-700 whitespace-pre-wrap break-words leading-relaxed">
                {c.text}
              </p>

              {c.resolved && (
                <div className="text-[10px] font-medium text-emerald-700 flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" />
                  <span>Resolved</span>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  );
};
