// GsChat — chat for the GetStream-transported live viewer. [WEB-GS-LIVE-1]
//
// The commercial join response (getstream.ts `CommercialJoinCredentials`) carries
// no chat room token — there is no server-side chat channel for this lane yet,
// unlike the Cloudflare `/watch` lane's StreamSessionDO room socket. Rather than
// invent a worker/ endpoint (out of scope — this workstream does not touch
// worker/), chat here rides the GetStream call's own custom-event channel
// (`call.sendCustomEvent` / `call.on('custom', ...)`), which every participant
// already has a connection to once joined. This is in-call signalling, not a
// persisted chat log: messages are not stored and do not survive a reload. If a
// persisted, moderated chat is wanted for this lane, that is server work for a
// follow-up, not something this island can add on its own.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCall } from '@stream-io/video-react-sdk';

export interface GsChatMessage {
  id: string;
  from: string;
  text: string;
  mine: boolean;
}

const MAX_MESSAGES = 200;
let _seq = 0;
const nextId = () => `c${Date.now().toString(36)}_${(_seq++).toString(36)}`;

export interface GsChatProps {
  /** Display name to attach to messages this viewer sends. */
  myName: string;
  disabled?: boolean;
}

export function GsChat({ myName, disabled }: GsChatProps) {
  const call = useCall();
  const [messages, setMessages] = useState<GsChatMessage[]>([]);
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);
  const pinnedBottom = useRef(true);

  useEffect(() => {
    if (!call) return;
    const unsub = call.on('custom', (event: any) => {
      const custom = event?.custom;
      if (!custom || custom.kind !== 'chat') return;
      const from = String(custom.from ?? event?.user?.name ?? event?.user?.id ?? 'Someone');
      const t = String(custom.text ?? '').slice(0, 200);
      if (!t) return;
      setMessages((prev) => {
        const out = prev.length >= MAX_MESSAGES ? prev.slice(prev.length - MAX_MESSAGES + 1) : prev.slice();
        out.push({ id: nextId(), from, text: t, mine: false });
        return out;
      });
    });
    return () => unsub();
  }, [call]);

  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    pinnedBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const submit = useCallback(() => {
    const t = text.trim().slice(0, 200);
    if (!t || disabled || !call) return;
    call.sendCustomEvent({ kind: 'chat', from: myName, text: t }).catch(() => {
      // Best-effort — a dropped chat message is not worth surfacing over the
      // stream itself.
    });
    setMessages((prev) => {
      const out = prev.length >= MAX_MESSAGES ? prev.slice(prev.length - MAX_MESSAGES + 1) : prev.slice();
      out.push({ id: nextId(), from: myName, text: t, mine: true });
      return out;
    });
    setText('');
    pinnedBottom.current = true;
  }, [text, disabled, call, myName]);

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
          messages.map((m) => (
            <p key={m.id} className="font-body text-[14px] leading-snug text-ink">
              <span className={['font-display font-semibold', m.mine ? 'text-mintInk' : 'text-blueInk'].join(' ')}>
                {m.from}
              </span>{' '}
              <span className="font-bold text-inkSoft">{m.text}</span>
            </p>
          ))
        )}
      </div>

      <div className="flex items-center gap-2 border-t-zine border-ink bg-card px-2 py-2">
        <input
          value={text}
          disabled={disabled}
          maxLength={200}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder={disabled ? 'Chat unavailable' : 'Send a message'}
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

export default GsChat;
