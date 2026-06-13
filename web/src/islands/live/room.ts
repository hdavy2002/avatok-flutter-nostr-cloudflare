// Live interaction-room socket — one WS to the StreamSessionDO (`live:<id>`),
// reached via GET /api/live/:id/room?token=<room_token> (PHASE-C §5).
//
// Protocol confirmed by reading worker/src/do/stream_session.ts (read-only):
//   • On connect the DO sends one un-coalesced `welcome` frame:
//       { type:'welcome', watching, slow_mode_sec, pinned, ends_at, starts_at,
//         host_live, donations_total, donations_count }
//   • All later broadcasts are COALESCED into a `batch` frame (≥250 ms window):
//       { type:'batch', events: Event[] }
//     where Event.type ∈ viewers | chat | fly | reaction | sticker | donation |
//       presence | pinned | slow_mode | mod | host_connected | host_reconnecting |
//       session_ended  (consult-only `track` is ignored here).
//   • Direct-to-sender `warn` { type:'warn', reason } on rate-limit / profanity.
// Client → server messages: { type:'chat', text } and { type:'reaction', emoji }.
//
// This module is transport-only: a single socket with exponential-backoff
// reconnect. The React hook `useLiveRoom` adapts it to component state.

import { useEffect, useRef, useState, useCallback } from 'react';
import { ws } from '../../lib/apiClient';

export interface ChatMessage {
  id: string;
  from: string;
  text: string;
  uid?: string;
  /** true for reaction/sticker/system rows the chat renders inline. */
  kind: 'chat' | 'system';
}

export interface DonationBanner {
  id: string;
  name: string;
  amount: number;
  net?: number;
}

export type RoomConnState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface RoomState {
  conn: RoomConnState;
  viewers: number;
  hostLive: boolean;
  pinned: string | null;
  donationsTotal: number;
  donationsCount: number;
  /** Latest donation banner (consumed/cleared by the UI). */
  lastDonation: DonationBanner | null;
  messages: ChatMessage[];
  /** Flips true when the DO broadcasts session_ended. */
  ended: boolean;
  /** Last `warn` reason (slow-mode / blocked); cleared by the UI. */
  warn: string | null;
}

const MAX_MESSAGES = 200;
const BACKOFF_BASE_MS = 800;
const BACKOFF_MAX_MS = 15_000;

let _seq = 0;
const nextId = () => `m${Date.now().toString(36)}_${(_seq++).toString(36)}`;

interface RawEvent {
  type: string;
  [k: string]: unknown;
}

/**
 * Subscribe to the live room. Returns reactive room state plus `sendChat` /
 * `sendReaction`. Reconnects with exponential backoff while `ended` is false.
 */
export function useLiveRoom(roomUrl: string | null): RoomState & {
  sendChat: (text: string) => void;
  sendReaction: (emoji: string) => void;
  clearDonation: () => void;
  clearWarn: () => void;
} {
  const [state, setState] = useState<RoomState>({
    conn: 'connecting',
    viewers: 0,
    hostLive: false,
    pinned: null,
    donationsTotal: 0,
    donationsCount: 0,
    lastDonation: null,
    messages: [],
    ended: false,
    warn: null,
  });

  const sockRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endedRef = useRef(false);
  const closedRef = useRef(false);

  const applyEvent = useCallback((e: RawEvent) => {
    setState((prev) => {
      const next = { ...prev };
      switch (e.type) {
        case 'viewers':
          next.viewers = Math.max(0, Number(e.n ?? prev.viewers));
          break;
        case 'host_connected':
          next.hostLive = true;
          break;
        case 'host_reconnecting':
          next.hostLive = false;
          break;
        case 'pinned':
          next.pinned = (e.text as string) ?? null;
          break;
        case 'slow_mode':
          // surfaced only as a system note
          next.messages = pushMsg(prev.messages, {
            id: nextId(), from: 'Live', kind: 'system',
            text: Number(e.sec) > 0 ? `Slow mode: 1 message / ${e.sec}s` : 'Slow mode off',
          });
          break;
        case 'chat':
        case 'fly':
          next.messages = pushMsg(prev.messages, {
            id: nextId(), from: String(e.from ?? 'Someone'), text: String(e.text ?? ''),
            uid: e.uid ? String(e.uid) : undefined, kind: 'chat',
          });
          break;
        case 'reaction':
          next.messages = pushMsg(prev.messages, {
            id: nextId(), from: String(e.from ?? 'Someone'), kind: 'system',
            text: `reacted ${String(e.emoji ?? '❤️')}`,
          });
          break;
        case 'sticker':
          next.messages = pushMsg(prev.messages, {
            id: nextId(), from: String(e.from ?? 'Someone'), kind: 'system',
            text: 'sent a sticker',
          });
          break;
        case 'donation': {
          const amount = Number(e.amount ?? 0);
          const name = String(e.name ?? 'Someone');
          next.donationsCount = prev.donationsCount + 1;
          next.donationsTotal = prev.donationsTotal + amount;
          next.lastDonation = { id: nextId(), name, amount, net: Number(e.net ?? amount) };
          next.messages = pushMsg(prev.messages, {
            id: nextId(), from: name, kind: 'system', text: `donated ${amount} AvaCoins ✨`,
          });
          break;
        }
        case 'presence':
          if (e.joined) {
            next.messages = pushMsg(prev.messages, {
              id: nextId(), from: String(e.name ?? 'Someone'), kind: 'system', text: 'joined',
            });
          }
          break;
        case 'session_ended':
          endedRef.current = true;
          next.ended = true;
          break;
        default:
          break; // mod / track / unknown — ignored by the viewer
      }
      return next;
    });
  }, []);

  const applyWelcome = useCallback((m: RawEvent) => {
    setState((prev) => ({
      ...prev,
      viewers: Math.max(0, Number(m.watching ?? prev.viewers)),
      hostLive: m.host_live === true,
      pinned: (m.pinned as string) ?? null,
      donationsTotal: Number(m.donations_total ?? prev.donationsTotal),
      donationsCount: Number(m.donations_count ?? prev.donationsCount),
    }));
  }, []);

  useEffect(() => {
    if (!roomUrl) return;
    closedRef.current = false;
    endedRef.current = false;

    const connect = () => {
      if (closedRef.current || endedRef.current) return;
      setState((p) => ({ ...p, conn: attemptRef.current === 0 ? 'connecting' : 'reconnecting' }));
      let sock: WebSocket;
      try {
        sock = new WebSocket(roomUrl);
      } catch {
        scheduleReconnect();
        return;
      }
      sockRef.current = sock;

      sock.onopen = () => {
        attemptRef.current = 0;
        setState((p) => ({ ...p, conn: 'open' }));
      };
      sock.onmessage = (ev) => {
        let m: RawEvent;
        try {
          m = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        } catch {
          return;
        }
        if (m.type === 'welcome') applyWelcome(m);
        else if (m.type === 'batch' && Array.isArray(m.events)) (m.events as RawEvent[]).forEach(applyEvent);
        else if (m.type === 'warn') setState((p) => ({ ...p, warn: String(m.reason ?? 'blocked') }));
        else applyEvent(m); // tolerate un-batched events
      };
      sock.onclose = () => {
        if (closedRef.current) return;
        if (endedRef.current) {
          setState((p) => ({ ...p, conn: 'closed' }));
          return;
        }
        scheduleReconnect();
      };
      sock.onerror = () => {
        try { sock.close(); } catch { /* ignore */ }
      };
    };

    const scheduleReconnect = () => {
      if (closedRef.current || endedRef.current) return;
      setState((p) => ({ ...p, conn: 'reconnecting' }));
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attemptRef.current) + Math.random() * 400;
      attemptRef.current += 1;
      timerRef.current = setTimeout(connect, delay);
    };

    connect();
    return () => {
      closedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      try { sockRef.current?.close(); } catch { /* ignore */ }
      sockRef.current = null;
    };
  }, [roomUrl, applyEvent, applyWelcome]);

  const send = useCallback((payload: object) => {
    const s = sockRef.current;
    if (s && s.readyState === WebSocket.OPEN) {
      try { s.send(JSON.stringify(payload)); } catch { /* dropped */ }
    }
  }, []);

  const sendChat = useCallback((text: string) => {
    const t = text.trim().slice(0, 120);
    if (t) send({ type: 'chat', text: t });
  }, [send]);

  const sendReaction = useCallback((emoji: string) => send({ type: 'reaction', emoji }), [send]);
  const clearDonation = useCallback(() => setState((p) => ({ ...p, lastDonation: null })), []);
  const clearWarn = useCallback(() => setState((p) => ({ ...p, warn: null })), []);

  return { ...state, sendChat, sendReaction, clearDonation, clearWarn };
}

function pushMsg(list: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  const out = list.length >= MAX_MESSAGES ? list.slice(list.length - MAX_MESSAGES + 1) : list.slice();
  out.push(msg);
  return out;
}

/** Build the signed room WS URL from a listing id + room_token (from /join). */
export function roomUrlFor(listingId: string, roomToken: string): string {
  return ws(`/api/live/${encodeURIComponent(listingId)}/room`, roomToken);
}
