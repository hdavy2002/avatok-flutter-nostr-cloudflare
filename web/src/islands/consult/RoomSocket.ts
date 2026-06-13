/*
 * RoomSocket — typed WebSocket wrapper for the consult session room
 *   GET /api/consult/:bookingId/room   (signed ?token=)
 * It rides the SAME StreamSessionDO that AvaLive uses
 * (worker/src/do/stream_session.ts), so the wire shapes are that DO's:
 *
 *  ← server → client
 *    { type:"welcome", watching, starts_at, ends_at, host_live, slow_mode_sec,
 *      pinned, donations_total, donations_count }            (sent once, un-batched)
 *    { type:"batch", events:[ … ] }  where each event is one of:
 *      { type:"viewers", n }
 *      { type:"presence", uid, name, role, joined }          attendance ("creator joined")
 *      { type:"chat",  text, from, uid }   |  { type:"fly", text, from, uid }
 *      { type:"track", uid, name, track, session }           SFU track announce (peer)
 *      { type:"host_connected" } | { type:"host_reconnecting" }
 *      { type:"session_ended" }                              authoritative end
 *      { type:"pinned", text } | { type:"slow_mode", sec } | { type:"warn", reason }
 *      { type:"donation", name, amount, net } | { type:"mod", … }
 *
 *  → client → server
 *    { type:"chat", text } | { type:"reaction", emoji } | { type:"sticker", id }
 *    { type:"track", track, session }                       announce our SFU tracks
 *
 * Countdown is derived client-side from the authoritative `ends_at` (welcome),
 * with `session_ended` as the hard stop.
 */
import { ws as wsUrl } from '../../lib/apiClient';

export interface WelcomeMsg {
  type: 'welcome';
  watching: number;
  starts_at: number;
  ends_at: number;
  host_live: boolean;
  slow_mode_sec: number;
  pinned: string | null;
  donations_total: number;
  donations_count: number;
}

export interface RoomEvent {
  type: string;
  // loosely-typed fields across the union (see header)
  n?: number;
  uid?: string;
  name?: string;
  role?: string;
  joined?: boolean;
  text?: string;
  from?: string;
  emoji?: string;
  track?: string;
  session?: string;
  reason?: string;
  amount?: number;
  net?: number;
  [k: string]: unknown;
}

export interface RoomSocketHandlers {
  onWelcome?: (m: WelcomeMsg) => void;
  onEvent?: (e: RoomEvent) => void;
  onOpen?: () => void;
  onStatus?: (s: 'connecting' | 'open' | 'reconnecting' | 'closed') => void;
}

const BASE_BACKOFF_MS = 800;
const MAX_BACKOFF_MS = 12_000;

export class RoomSocket {
  private readonly bookingId: string;
  private readonly token: string;
  private readonly h: RoomSocketHandlers;
  private sock: WebSocket | null = null;
  private retries = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closedByUs = false;

  constructor(bookingId: string, token: string, handlers: RoomSocketHandlers) {
    this.bookingId = bookingId;
    this.token = token;
    this.h = handlers;
  }

  connect(): void {
    this.closedByUs = false;
    this.open();
  }

  private open(): void {
    this.h.onStatus?.(this.retries === 0 ? 'connecting' : 'reconnecting');
    let sock: WebSocket;
    try {
      sock = new WebSocket(wsUrl(`/api/consult/${encodeURIComponent(this.bookingId)}/room`, this.token));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.sock = sock;

    sock.addEventListener('open', () => {
      this.retries = 0;
      this.h.onStatus?.('open');
      this.h.onOpen?.();
    });

    sock.addEventListener('message', (ev) => {
      let msg: unknown;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      const m = msg as RoomEvent;
      if (m.type === 'welcome') {
        this.h.onWelcome?.(m as unknown as WelcomeMsg);
        return;
      }
      const events = (m as RoomEvent).events;
      if (m.type === 'batch' && Array.isArray(events)) {
        for (const e of events as RoomEvent[]) this.h.onEvent?.(e);
        return;
      }
      // Some events may arrive un-batched.
      this.h.onEvent?.(m);
    });

    sock.addEventListener('close', () => {
      if (this.closedByUs) {
        this.h.onStatus?.('closed');
        return;
      }
      this.scheduleReconnect();
    });
    sock.addEventListener('error', () => {
      try {
        sock.close();
      } catch {
        /* close handler drives reconnect */
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.closedByUs) return;
    this.h.onStatus?.('reconnecting');
    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** this.retries) + Math.random() * 400;
    this.retries += 1;
    this.timer = setTimeout(() => this.open(), delay);
  }

  /** Best-effort send; silently no-ops if the socket isn't open. */
  send(obj: Record<string, unknown>): void {
    if (this.sock && this.sock.readyState === WebSocket.OPEN) {
      try {
        this.sock.send(JSON.stringify(obj));
      } catch {
        /* ignore */
      }
    }
  }

  /** Announce our SFU session + track names so the peer can pull them. */
  announceTracks(sessionId: string, audio: string | null, video: string | null): void {
    this.send({ type: 'track', session: sessionId, track: JSON.stringify({ a: audio, v: video }) });
  }

  chat(text: string): void {
    const t = text.trim().slice(0, 120);
    if (t) this.send({ type: 'chat', text: t });
  }

  close(): void {
    this.closedByUs = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      this.sock?.close();
    } catch {
      /* ignore */
    }
    this.sock = null;
  }
}

/** Parse a peer `track` event payload back into session + track names. */
export function parseTrackAnnounce(e: RoomEvent): { session: string; audio: string | null; video: string | null } | null {
  if (!e.session || typeof e.track !== 'string') return null;
  try {
    const obj = JSON.parse(e.track) as { a?: string | null; v?: string | null };
    return { session: e.session, audio: obj.a ?? null, video: obj.v ?? null };
  } catch {
    // Fallback: a bare track name string.
    return { session: e.session, audio: e.track || null, video: null };
  }
}

export default RoomSocket;
