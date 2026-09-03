// GsChat — Stream Chat-powered chat for the GetStream live viewer.
//
// The message transport is now the official Stream Chat SDK instead of the
// temporary in-call custom event buffer. The room identity still comes from the
// server-minted join response: no client-side guessing, no extra auth roundtrip.
import { useEffect, useMemo, useRef, useState } from 'react';
import { StreamChat } from 'stream-chat';

export interface GsChatMessage {
  id: string;
  from: string;
  text: string;
  mine: boolean;
  createdAt: number;
}

export interface GsChatProps {
  apiKey: string;
  userId: string;
  token: string;
  channelId: string;
  channelType?: string;
  myName: string;
  disabled?: boolean;
}

const MAX_MESSAGES = 200;
const MAX_CHARS = 200;
const RATE_LIMIT_WINDOW_MS = 8000;
const RATE_LIMIT_BURST = 4;

let _seq = 0;
const nextId = () => `c${Date.now().toString(36)}_${(_seq++).toString(36)}`;

const clientCache = new Map<string, StreamChat>();

function clientKey(apiKey: string, userId: string) {
  return `${apiKey}:${userId}`;
}

function getClient(apiKey: string, userId: string) {
  const key = clientKey(apiKey, userId);
  const cached = clientCache.get(key);
  if (cached) return cached;
  const client = StreamChat.getInstance(apiKey, { timeout: 6000 });
  clientCache.set(key, client);
  return client;
}

function trimMessages(next: GsChatMessage[]) {
  return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next;
}

export function GsChat({ apiKey, userId, token, channelId, channelType = 'messaging', myName, disabled }: GsChatProps) {
  const [messages, setMessages] = useState<GsChatMessage[]>([]);
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [notice, setNotice] = useState<string | null>(null);
  const [reportingId, setReportingId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pinnedBottom = useRef(true);
  const rateWindowRef = useRef<number[]>([]);
  const channelRef = useRef<Awaited<ReturnType<StreamChat['channel']>> | null>(null);
  const client = useMemo(() => getClient(apiKey, userId), [apiKey, userId]);

  useEffect(() => {
    let cancelled = false;
    let offConnection: (() => void) | null = null;
    let offMessage: (() => void) | null = null;

    const connect = async () => {
      setStatus('connecting');
      try {
        const maybeCurrent = (client as { user?: { id?: string } | null }).user?.id;
        if (maybeCurrent !== userId) {
          await client.disconnectUser().catch(() => {});
          await client.connectUser({ id: userId, name: myName }, token);
        } else if (!(client as { wsConnection?: { isHealthy?: boolean } }).wsConnection?.isHealthy) {
          await client.openConnection();
        }
        const channel = client.channel(channelType, channelId, {
          members: [userId],
        });
        await channel.watch();
        channelRef.current = channel;
        if (cancelled) return;

        const syncMessages = () => {
          const next = (channel.state.messages ?? [])
            .slice(-MAX_MESSAGES)
            .map((m) => ({
              id: String(m.id ?? nextId()),
              from: String(m.user?.name ?? m.user?.id ?? 'Someone'),
              text: String(m.text ?? ''),
              mine: String(m.user?.id ?? '') === userId,
              createdAt: m.created_at ? new Date(m.created_at).getTime() : Date.now(),
            }))
            .filter((m) => m.text.length > 0);
          setMessages(next);
        };

        syncMessages();
        const messageSub = channel.on('message.new', syncMessages);
        const connectionSub = client.on('connection.changed', (event: { online?: boolean }) => {
          setStatus(event.online ? 'online' : 'offline');
        });
        offMessage = () => messageSub.unsubscribe();
        offConnection = () => connectionSub.unsubscribe();
        setStatus('online');
      } catch {
        if (!cancelled) {
          setStatus('offline');
          setNotice('Chat is reconnecting.');
        }
      }
    };

    void connect();

    return () => {
      cancelled = true;
      offMessage?.();
      offConnection?.();
      const channel = channelRef.current;
      channelRef.current = null;
      if (channel) {
        void channel.stopWatching().catch(() => {});
      }
    };
  }, [client, channelId, channelType, myName, token, userId]);

  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    pinnedBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const rateLimited = () => {
    const now = Date.now();
    rateWindowRef.current = rateWindowRef.current.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
    if (rateWindowRef.current.length >= RATE_LIMIT_BURST) return true;
    rateWindowRef.current.push(now);
    return false;
  };

  const submit = async () => {
    const t = text.trim().slice(0, MAX_CHARS);
    const channel = channelRef.current;
    if (!t || disabled || !channel) return;
    if (rateLimited()) {
      setNotice('Slow down a bit. Chat rate limit is active.');
      return;
    }
    try {
      await channel.sendMessage({
        text: t,
        extraData: {
          live_room: channelId,
          live_lane: 'commercial',
        } as Record<string, unknown>,
      } as any);
      setMessages((prev) =>
        trimMessages([
          ...prev,
          { id: nextId(), from: myName, text: t, mine: true, createdAt: Date.now() },
        ]),
      );
      setText('');
      pinnedBottom.current = true;
    } catch {
      setNotice('Message could not be sent right now.');
    }
  };

  const reportMessage = async (messageId: string) => {
    try {
      setReportingId(messageId);
      await client.flagMessage(messageId, { reason: 'reported from live chat' });
      setNotice('Message reported for moderation.');
    } catch {
      setNotice('Could not report that message right now.');
    } finally {
      setReportingId(null);
    }
  };

  const reconnect = async () => {
    try {
      setStatus('connecting');
      await client.openConnection();
      await channelRef.current?.watch();
      setStatus('online');
      setNotice('Chat reconnected.');
    } catch {
      setStatus('offline');
      setNotice('Chat is still offline.');
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b-zine border-ink px-3 py-2">
        <div className="font-mono font-bold uppercase text-[14px] tracking-[0.06em] text-inkSoft">
          Chat
        </div>
        <div className="flex items-center gap-2">
          <span className={[
            'rounded-full border-zine px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.06em]',
            status === 'online' ? 'border-ink bg-lime text-ink' : status === 'connecting' ? 'border-ink bg-card text-inkSoft' : 'border-coral bg-card text-coral',
          ].join(' ')}>
            {status}
          </span>
          {status !== 'online' && (
            <button
              type="button"
              onClick={() => void reconnect()}
              className="rounded-full border-zine border-ink bg-card px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-ink"
            >
              Retry
            </button>
          )}
        </div>
      </div>

      <div
        ref={listRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 space-y-2 overflow-y-auto px-3 py-3 [scrollbar-width:thin]"
      >
        {messages.length === 0 ? (
          <p className="px-1 py-2 font-body font-bold text-[13px] text-inkMute">
            Say hi 👋 - chat appears here.
          </p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className="group flex items-start gap-2">
              <button
                type="button"
                onClick={() => void reportMessage(m.id)}
                disabled={reportingId === m.id}
                className="mt-0.5 rounded-full border-zine border-ink bg-paper px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-ink opacity-0 transition-opacity group-hover:opacity-100 disabled:opacity-40"
                title="Report for moderation"
              >
                {reportingId === m.id ? '...' : '!'}
              </button>
              <p className="font-body text-[14px] leading-snug text-ink">
                <span className={['font-display font-semibold', m.mine ? 'text-mintInk' : 'text-blueInk'].join(' ')}>
                  {m.from}
                </span>{' '}
                <span className="font-bold text-inkSoft">{m.text}</span>
              </p>
            </div>
          ))
        )}
      </div>

      {notice && (
        <div className="mx-3 mb-2 rounded-zineSm border-zine border-ink bg-coral px-3 py-1.5 font-mono text-[13px] uppercase tracking-[0.04em] text-white shadow-zine-xs font-bold">
          {notice}
        </div>
      )}

      <div className="flex items-center gap-2 border-t-zine border-ink bg-card px-2 py-2">
        <input
          value={text}
          disabled={disabled || status !== 'online'}
          maxLength={MAX_CHARS}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
          placeholder={disabled ? 'Chat unavailable' : status !== 'online' ? 'Reconnecting…' : 'Send a message'}
          className="min-w-0 flex-1 rounded-zineField border-zine border-ink bg-paper px-3 py-2 font-body font-bold text-[14px] text-ink placeholder:text-placeholder focus:outline-none focus:shadow-zine-focus disabled:bg-paper2 disabled:text-inkMute"
        />
        <button
          type="button"
          disabled={disabled || status !== 'online' || !text.trim()}
          onClick={() => void submit()}
          className="shrink-0 rounded-full border-zine border-ink bg-lime px-4 py-2 font-display font-semibold text-[15px] text-ink shadow-zine-sm transition-transform duration-zine active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed disabled:border-inkMute disabled:bg-paper2 disabled:text-inkMute disabled:shadow-none"
        >
          Send
        </button>
      </div>
    </div>
  );
}

export default GsChat;
