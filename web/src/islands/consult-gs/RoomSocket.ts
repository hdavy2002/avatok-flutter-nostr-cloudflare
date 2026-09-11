/*
 * RoomSocket (GetStream waiting-room lane) — a copy of
 * `web/src/islands/consult/RoomSocket.ts`, adapted for
 * [WAITROOM-WEB-1 2026-09-11]. It rides the same `StreamSessionDO`
 * (`worker/src/do/stream_session.ts`), but connects straight to the fully
 * -formed `room_ws` URL the WP4 prejoin contract hands back
 * (`…/api/consult/<bookingId>/room?token=<room_token>`, token already
 * embedded) instead of building the URL from a bare booking id + token —
 * that is the one deliberate difference from the legacy file.
 *
 *  ← server → client
 *    { type:"welcome", starts_at, ends_at, host_live }
 *    { type:"roster", host:boolean, attendee:boolean }      (WP2, on welcome
 *                                                             + every presence change)
 *    { type:"presence", uid, name, role:'host'|'attendee', joined }
 *    { type:"chat", from, text, at }                         (WP2, ≤500 chars)
 *    { type:"session_ended" }
 *    { type:"batch", events:[ … one of the above … ] }
 *
 *  → client → server
 *    { type:"chat", text }
 *
 * The client never decides check-in or billing from any of this — it is
 * display only (RULEBOOK-PAID-SESSIONS §3, §5).
 */

export interface WelcomeMsg {
  type: 'welcome';
  starts_at: number;
  ends_at: number;
  host_live?: boolean;
  [k: string]: unknown;
}

export interface RosterMsg {
  type: 'roster';
  host: boolean;
  attendee: boolean;
}

export interface ChatMsg {
  type: 'chat';
  from: string;
  text: string;
  at?: number;
}

export interface RoomEvent {
  type: string;
  uid?: string;
  name?: string;
  role?: string;
  joined?: boolean;
  text?: string;
  from?: string;
  at?: number;
  host?: boolean;
  attendee?: boolean;
  reason?: string;
  [k: string]: unknown;
}

export interface RoomSocketHandlers {
  onWelcome?: (m: WelcomeMsg) => void;
  /** WP2 `roster` — sent on welcome and on every presence change. */
  onRoster?: (m: RosterMsg) => void;
  /** WP2 `chat` — relayed waiting-room chat (≤ 500 chars). */
  onChat?: (m: ChatMsg) => void;
  /** Catch-all for anything not specifically typed above (e.g. `session_ended`, `presence`). */
  onEvent?: (e: RoomEvent) => void;
  onOpen?: () => void;
  onStatus?: (s: 'connecting' | 'open' | 'reconnecting' | 'closed') => void;
}

const BASE_BACKOFF_MS = 800;
const MAX_BACKOFF_MS = 12_000;
const CHAT_MAX_LEN = 500; // WP2 contract: chat relayed "(≤ 500 chars)"

export class RoomSocket {
  private readonly url: string;
  private readonly h: RoomSocketHandlers;
  private sock: WebSocket | null = null;
  private retries = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closedByUs = false;

  /** `url` is the server-issued `room_ws` — a full wss URL, token already embedded. */
  constructor(url: string, handlers: RoomSocketHandlers) {
    this.url = url;
    this.h = handlers;
  }

  connect(): void {
    this.closedByUs = false;
    this.open();
  }

  private dispatch(e: RoomEvent): void {
    if (e.type === 'roster') {
      this.h.onRoster?.({ type: 'roster', host: !!e.host, attendee: !!e.attendee });
      return;
    }
    if (e.type === 'chat' && typeof e.text === 'string') {
      this.h.onChat?.({ type: 'chat', from: String(e.from ?? 'Guest'), text: e.text, at: typeof e.at === 'number' ? e.at : undefined });
      return;
    }
    this.h.onEvent?.(e);
  }

  private open(): void {
    this.h.onStatus?.(this.retries === 0 ? 'connecting' : 'reconnecting');
    let sock: WebSocket;
    try {
      sock = new WebSocket(this.url);
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
      const events = m.events;
      if (m.type === 'batch' && Array.isArray(events)) {
        for (const e of events as RoomEvent[]) this.dispatch(e);
        return;
      }
      this.dispatch(m);
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

  chat(text: string): void {
    const t = text.trim().slice(0, CHAT_MAX_LEN);
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

export default RoomSocket;
