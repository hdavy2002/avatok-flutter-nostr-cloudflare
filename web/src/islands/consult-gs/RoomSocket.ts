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
  /**
   * [WAITROOM-WEB-2 fix 6/7] Epoch ms of the creator's first socket open,
   * server-recorded. ADDITIVE — the worker is adding this field; until it
   * lands, it is simply absent and callers fall back to observing `roster`
   * transitions themselves (see ConsultRoomGS's `hostCheckedInAtRef`).
   */
  host_checked_in_at?: number;
  [k: string]: unknown;
}

export interface RosterMsg {
  type: 'roster';
  host: boolean;
  attendee: boolean;
  /** [WAITROOM-WEB-2 fix 6/7] Same additive field as on `welcome`, above. */
  host_checked_in_at?: number;
}

export interface ChatMsg {
  type: 'chat';
  from: string;
  text: string;
  at?: number;
  /**
   * [WAITROOM-WEB-2 fix 11] The DO event's sender uid. ADDITIVE — the worker
   * is adding `uid` to the `chat` event; until it lands this is `undefined`
   * and callers fall back to matching on `from` (display name).
   */
  uid?: string;
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
  /**
   * [WAITROOM-WEB-2 fix 16 / WAITROOM-WEB-4] Fired once the socket has
   * given up: either `MAX_NEVER_OPENED_FAILURES` consecutive attempts in a
   * row never reached `open` at all (the closest signal a browser
   * WebSocket exposes for "the server is refusing this token with 403",
   * since the WebSocket API never surfaces the handshake's HTTP status to
   * JS), or `MAX_POST_OPEN_FAILURES` consecutive reconnects failed after
   * having opened successfully before (ordinary flakiness given a much
   * more tolerant budget). Either counter resets to 0 on the next
   * successful open. The socket stops retrying once this fires; the caller
   * is expected to fall back to a direct join.
   */
  onAuthFailed?: () => void;
}

const BASE_BACKOFF_MS = 800;
const MAX_BACKOFF_MS = 12_000;
const CHAT_MAX_LEN = 500; // WP2 contract: chat relayed "(≤ 500 chars)"
// [WAITROOM-WEB-2 fix 16] Cap consecutive attempts that never even reached
// `open` at 3 before giving up and calling `onAuthFailed` — a good token
// opens on the first or second try, so three straight never-opened failures
// is the bad-token signature. Counted per ATTEMPT (a fresh WebSocket each
// time `open()` runs), not per close event: an attempt whose own `open`
// fired before it later closed does NOT count here, no matter how quickly
// it closed — see `openedThisAttempt` in `open()`.
const MAX_NEVER_OPENED_FAILURES = 3;
// [WAITROOM-WEB-4] A drop AFTER a successful open is ordinary network
// flakiness (a 3-5s Wi-Fi blip can easily burn through 2-3 quick reconnect
// attempts on backoff before the network recovers) — it must never be held
// to the same 3-try bad-token cap as a socket that never opened at all, or
// an ordinary blip abandons the waiting-room socket outright (GetStream
// media joins alone, and a later Leave has nothing to return to but
// "ended"). This is a separate, much more tolerant counter for that case.
const MAX_POST_OPEN_FAILURES = 8;

export class RoomSocket {
  private readonly url: string;
  private readonly h: RoomSocketHandlers;
  private sock: WebSocket | null = null;
  private retries = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closedByUs = false;
  // [WAITROOM-WEB-2 fix 16 / WAITROOM-WEB-4] Two independent streaks, each
  // reset to 0 on the next successful open: attempts that never reached
  // `open` at all, and reconnects that failed after having opened
  // successfully at some point before. Kept separate because they mean very
  // different things — one is a rejected token, the other is a Wi-Fi blip.
  private neverOpenedFailures = 0;
  private postOpenFailures = 0;
  private authFailed = false;

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
      this.h.onRoster?.({
        type: 'roster',
        host: !!e.host,
        attendee: !!e.attendee,
        host_checked_in_at: typeof e.host_checked_in_at === 'number' ? e.host_checked_in_at : undefined,
      });
      return;
    }
    if (e.type === 'chat' && typeof e.text === 'string') {
      this.h.onChat?.({
        type: 'chat',
        from: String(e.from ?? 'Guest'),
        text: e.text,
        at: typeof e.at === 'number' ? e.at : undefined,
        uid: typeof e.uid === 'string' ? e.uid : undefined,
      });
      return;
    }
    this.h.onEvent?.(e);
  }

  private open(): void {
    if (this.authFailed) return;
    this.h.onStatus?.(this.retries === 0 ? 'connecting' : 'reconnecting');
    let sock: WebSocket;
    try {
      sock = new WebSocket(this.url);
    } catch {
      // Never even got a WebSocket instance — this attempt's `open` could
      // not possibly have fired.
      this.scheduleReconnect(false);
      return;
    }
    this.sock = sock;
    // [WAITROOM-WEB-4] Scoped to THIS attempt (a fresh WebSocket each time
    // `open()` runs) — whether ITS OWN `open` event fired before it later
    // closed. This is what `close` reads below, not any lifetime state, so
    // a socket that opened fine and then dropped is never mistaken for one
    // that never opened at all, no matter how quickly after opening it
    // closed (a 3-5s Wi-Fi blip can close within a second of opening).
    let openedThisAttempt = false;

    sock.addEventListener('open', () => {
      openedThisAttempt = true;
      this.retries = 0;
      // Reset on EVERY successful open, not just the first — a socket that
      // opened fine 10 times and then starts failing (e.g. a token rotated
      // mid-session) still deserves its own fresh budget, not one carried
      // over (or exhausted) from a lifetime ago.
      this.neverOpenedFailures = 0;
      this.postOpenFailures = 0;
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
      this.scheduleReconnect(openedThisAttempt);
    });
    sock.addEventListener('error', () => {
      try {
        sock.close();
      } catch {
        /* close handler drives reconnect */
      }
    });
  }

  /**
   * @param openedBeforeClose whether the JUST-CLOSED attempt's own `open`
   * event fired before it closed — `false` from the `catch` in `open()`
   * (never even got a WebSocket instance) or from a `close` whose attempt
   * never opened; `true` from a `close` on an attempt that had opened.
   */
  private scheduleReconnect(openedBeforeClose: boolean): void {
    if (this.closedByUs || this.authFailed) return;
    // [WAITROOM-WEB-4] Two separate, differently-tolerant streaks. A
    // never-opened attempt is the bad-token signature (3 in a row gives
    // up); a drop after a successful open is ordinary flakiness — a 3-5s
    // Wi-Fi blip can burn through several quick reconnect attempts on
    // backoff before the network recovers, so this budget is far larger.
    if (openedBeforeClose) {
      this.postOpenFailures += 1;
      if (this.postOpenFailures >= MAX_POST_OPEN_FAILURES) {
        this.authFailed = true;
        this.h.onStatus?.('closed');
        // eslint-disable-next-line no-console
        console.warn(
          `[WAITROOM-WEB-4] waiting-room socket dropped and failed to reconnect ${MAX_POST_OPEN_FAILURES} times in a row after opening successfully — giving up and falling back to a direct join.`,
        );
        this.h.onAuthFailed?.();
        return;
      }
    } else {
      this.neverOpenedFailures += 1;
      if (this.neverOpenedFailures >= MAX_NEVER_OPENED_FAILURES) {
        this.authFailed = true;
        this.h.onStatus?.('closed');
        // eslint-disable-next-line no-console
        console.warn(
          `[WAITROOM-WEB-2 fix 16] waiting-room socket never opened after ${MAX_NEVER_OPENED_FAILURES} tries in a row (likely a rejected/bad token) — giving up and falling back to a direct join.`,
        );
        this.h.onAuthFailed?.();
        return;
      }
    }
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
