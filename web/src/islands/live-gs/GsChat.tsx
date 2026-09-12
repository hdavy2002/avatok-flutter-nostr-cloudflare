// GsChat — Stream Chat-powered chat for the GetStream live viewer.
//
// The message transport is now the official Stream Chat SDK instead of the
// temporary in-call custom event buffer. The room identity still comes from the
// server-minted join response: no client-side guessing, no extra auth roundtrip.
import { useEffect, useMemo, useRef, useState } from 'react';
import { StreamChat } from 'stream-chat';
import { capture } from '../../lib/analytics';
import {
  ATTACHMENT_ACCEPT,
  AttachmentError,
  fmtBytes,
  isImageAttachment,
  uploadChatAttachment,
  type ChatAttachment,
} from '../../lib/sessionUpload';

export interface GsChatMessage {
  id: string;
  from: string;
  text: string;
  mine: boolean;
  createdAt: number;
  /** [APP-ONLY-TX-1 2026-09-12] Optional file attachment (RULEBOOK §7). */
  attachment?: ChatAttachment | null;
}

export interface GsChatProps {
  apiKey: string;
  userId: string;
  token: string;
  channelId: string;
  channelType?: string;
  myName: string;
  disabled?: boolean;
  /**
   * [APP-ONLY-TX-1 2026-09-12] Resolves the viewer's session JWT so the attach
   * button can upload via `/upload/public`. Omit and the button is hidden —
   * chat still works. RULEBOOK-PAID-SESSIONS §7: the customer's browser may
   * view, listen, talk, chat AND upload.
   */
  getJwt?: () => Promise<string | null>;
  /** For `session_chat_attachment_sent`. */
  listingId?: string | null;
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

/** The message shape the DO lane uses, mirrored onto Stream Chat's extraData so
 *  both lanes read the same `{url,name,size,mime}` descriptor. */
function readAttachment(raw: unknown): ChatAttachment | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  const url = typeof a.url === 'string' ? a.url : '';
  if (!/^https:\/\//i.test(url)) return null;
  return {
    url,
    name: typeof a.name === 'string' && a.name ? a.name.slice(0, 120) : 'file',
    size: typeof a.size === 'number' && Number.isFinite(a.size) ? a.size : 0,
    mime: typeof a.mime === 'string' ? a.mime.slice(0, 128) : '',
  };
}

export function GsChat({ apiKey, userId, token, channelId, channelType = 'messaging', myName, disabled, getJwt, listingId }: GsChatProps) {
  const [messages, setMessages] = useState<GsChatMessage[]>([]);
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [notice, setNotice] = useState<string | null>(null);
  const [reportingId, setReportingId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
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
              // [APP-ONLY-TX-1] same descriptor as the DO lane's `attachment`.
              attachment: readAttachment((m as unknown as { attachment?: unknown }).attachment),
            }))
            .filter((m) => m.text.length > 0 || m.attachment);
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

  const submit = async (attachment?: ChatAttachment | null) => {
    const t = text.trim().slice(0, MAX_CHARS);
    const channel = channelRef.current;
    // [APP-ONLY-TX-1] A file with no caption is a legitimate message.
    if ((!t && !attachment) || disabled || !channel) return;
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
          ...(attachment ? { attachment } : {}),
        } as Record<string, unknown>,
      } as any);
      setMessages((prev) =>
        trimMessages([
          ...prev,
          { id: nextId(), from: myName, text: t, mine: true, createdAt: Date.now(), attachment: attachment ?? null },
        ]),
      );
      setText('');
      pinnedBottom.current = true;
    } catch {
      setNotice('Message could not be sent right now.');
    }
  };

  // [APP-ONLY-TX-1 2026-09-12] Attach a file: upload to `/upload/public` as
  // this viewer (his own session JWT), then send the descriptor on the message.
  const pickFile = async (files: FileList | null) => {
    const file = files?.[0];
    if (fileRef.current) fileRef.current.value = '';
    if (!file || disabled || uploading || !getJwt) return;
    setUploading(true);
    try {
      const jwt = await getJwt();
      if (!jwt) {
        setNotice('Please reload the page and try that upload again.');
        return;
      }
      const attachment = await uploadChatAttachment(file, jwt);
      await submit(attachment);
      try {
        capture('session_chat_attachment_sent', {
          booking_id: null,
          listing_id: listingId ?? null,
          surface: 'live_viewer',
          role: 'viewer',
          mime: attachment.mime,
          bytes: attachment.size,
          is_image: isImageAttachment(attachment.mime),
        });
      } catch {
        /* best-effort */
      }
    } catch (e) {
      setNotice(e instanceof AttachmentError ? e.message : 'Could not upload that file.');
    } finally {
      setUploading(false);
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
                className="mt-0.5 rounded-full border-zine border-ink bg-paper px-2 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-ink opacity-0 transition-opacity group-hover:opacity-100 disabled:opacity-40"
                title="Report for moderation"
              >
                {reportingId === m.id ? '...' : '!'}
              </button>
              <div className="min-w-0 flex-1">
                <p className="font-body text-[14px] leading-snug text-ink">
                  <span className={['font-display font-semibold', m.mine ? 'text-mintInk' : 'text-blueInk'].join(' ')}>
                    {m.from}
                  </span>{' '}
                  <span className="font-bold text-inkSoft">{m.text || (m.attachment ? 'sent a file' : '')}</span>
                </p>
                {m.attachment && (
                  <a
                    href={m.attachment.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 flex max-w-full items-center gap-2 rounded-zineSm border-zine border-ink bg-paper px-2 py-1.5 no-underline shadow-zine-xs"
                  >
                    {isImageAttachment(m.attachment.mime) ? (
                      <img src={m.attachment.url} alt={m.attachment.name} loading="lazy" className="h-10 w-10 shrink-0 rounded-zineSm border-zine border-ink object-cover" />
                    ) : (
                      <span aria-hidden className="text-[16px] leading-none">📎</span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-body text-[13px] font-bold text-blueInk underline">{m.attachment.name}</span>
                      {m.attachment.size > 0 && (
                        <span className="block font-mono text-[11px] font-bold uppercase tracking-[0.04em] text-inkMute">{fmtBytes(m.attachment.size)}</span>
                      )}
                    </span>
                  </a>
                )}
              </div>
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
        {getJwt && (
          <>
            <input ref={fileRef} type="file" accept={ATTACHMENT_ACCEPT} hidden onChange={(e) => void pickFile(e.target.files)} />
            <button
              type="button"
              aria-label="Attach a file"
              title="Attach a file (max 25 MB)"
              disabled={disabled || status !== 'online' || uploading}
              onClick={() => fileRef.current?.click()}
              className="shrink-0 rounded-full border-zine border-ink bg-paper px-3 py-2 font-mono text-[14px] font-bold text-ink shadow-zine-xs disabled:opacity-50"
            >
              {uploading ? '…' : '📎'}
            </button>
          </>
        )}
        <input
          value={text}
          disabled={disabled || status !== 'online'}
          maxLength={MAX_CHARS}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit(null)}
          placeholder={disabled ? 'Chat unavailable' : status !== 'online' ? 'Reconnecting…' : 'Send a message'}
          className="min-w-0 flex-1 rounded-zineField border-zine border-ink bg-paper px-3 py-2 font-body font-bold text-[14px] text-ink placeholder:text-placeholder focus:outline-none focus:shadow-zine-focus disabled:bg-paper2 disabled:text-inkMute"
        />
        <button
          type="button"
          disabled={disabled || status !== 'online' || !text.trim()}
          onClick={() => void submit(null)}
          className="shrink-0 rounded-full border-zine border-ink bg-lime px-4 py-2 font-display font-semibold text-[15px] text-ink shadow-zine-sm transition-transform duration-zine active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed disabled:border-inkMute disabled:bg-paper2 disabled:text-inkMute disabled:shadow-none"
        >
          Send
        </button>
      </div>
    </div>
  );
}

export default GsChat;
