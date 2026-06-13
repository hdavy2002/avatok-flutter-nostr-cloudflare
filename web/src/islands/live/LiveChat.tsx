// Live chat — renders messages from the shared room socket and sends new ones.
// Chat + reactions travel over the same WS (room.ts). PHASE-C §5.
import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from './room';

export interface LiveChatProps {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  onReact: (emoji: string) => void;
  /** Slow-mode / blocked notice from a `warn` frame; auto-clears. */
  warn?: string | null;
  onWarnSeen?: () => void;
  disabled?: boolean;
}

const QUICK_REACTIONS = ['❤️', '🔥', '👏', '😂', '🎉'];

export function LiveChat({ messages, onSend, onReact, warn, onWarnSeen, disabled }: LiveChatProps) {
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);
  const pinnedBottom = useRef(true);

  // Auto-scroll only when the user is already near the bottom.
  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (!warn) return;
    const t = setTimeout(() => onWarnSeen?.(), 3500);
    return () => clearTimeout(t);
  }, [warn, onWarnSeen]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    pinnedBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const submit = () => {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText('');
    pinnedBottom.current = true;
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={listRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 space-y-1.5 overflow-y-auto px-3 py-3 [scrollbar-width:thin]"
      >
        {messages.length === 0 ? (
          <p className="px-1 py-2 font-body font-bold text-[13px] text-inkMute">
            Say hi 👋 — chat appears here.
          </p>
        ) : (
          messages.map((m) =>
            m.kind === 'system' ? (
              <p key={m.id} className="font-mono text-[11px] uppercase tracking-[0.04em] text-inkMute">
                <span className="text-blueInk">{m.from}</span> {m.text}
              </p>
            ) : (
              <p key={m.id} className="font-body text-[14px] leading-snug text-ink">
                <span className="font-display font-semibold text-blueInk">{m.from}</span>{' '}
                <span className="font-bold text-inkSoft">{m.text}</span>
              </p>
            ),
          )
        )}
      </div>

      {warn && (
        <div className="mx-3 mb-2 rounded-zineSm border-zine border-ink bg-coral px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.04em] text-white shadow-zine-xs">
          {warn}
        </div>
      )}

      <div className="flex items-center gap-1.5 border-t-zine border-ink px-2 py-2">
        {QUICK_REACTIONS.map((e) => (
          <button
            key={e}
            type="button"
            disabled={disabled}
            onClick={() => onReact(e)}
            className="rounded-full px-1.5 py-1 text-[18px] leading-none transition-transform duration-zine active:translate-y-[1px] disabled:opacity-40"
            aria-label={`React ${e}`}
          >
            {e}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2 border-t-zine border-ink bg-card px-2 py-2">
        <input
          value={text}
          disabled={disabled}
          maxLength={120}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder={disabled ? 'Join to chat' : 'Send a message'}
          className="min-w-0 flex-1 rounded-zineField border-zine border-ink bg-paper px-3 py-2 font-body font-bold text-[14px] text-ink placeholder:text-placeholder focus:outline-none focus:shadow-zine-focus disabled:bg-paper2 disabled:text-inkMute"
        />
        <button
          type="button"
          disabled={disabled || !text.trim()}
          onClick={submit}
          className="shrink-0 rounded-full border-zine border-ink bg-lime px-4 py-2 font-display font-semibold text-[15px] text-ink shadow-zine-sm transition-transform duration-zine active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed disabled:border-inkMute disabled:bg-paper2 disabled:text-inkMute disabled:shadow-none"
        >
          Send
        </button>
      </div>
    </div>
  );
}

export default LiveChat;
