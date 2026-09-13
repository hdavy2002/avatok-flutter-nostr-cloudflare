// AgentLiveSocket — the browser⇄room WebSocket for an AI voice agent talk
// session (`[AGENT-LIVE-1]`, BUILD SPEC §6/§11 M9, R2 §3.1-3.3).
//
// Protocol (R2 §3.2, verbatim — the worker's `AgentLiveRoom` DO is the other
// end): JSON control frames carry `v:1`, `type`, `connectionGeneration`;
// server events also carry a monotonically increasing `seq`. Binary frames
// are raw PCM16 LE — 24 kHz mono both ways, no envelope, no base64 (that
// re-encoding happens only between the DO and OpenAI, never on this leg).
//
//   browser → room   hello | mute | ping | playback | end
//   room → browser   ready | caption | timer | image_ack | playback_clear |
//                     pong | ended
//
// This class owns exactly one WebSocket for exactly one connection attempt.
// Reconnection (R2 §3.3: 45s grace, re-prejoin for a fresh token) is the
// caller's job (`AgentTalkRoom`) — this class only reports `onClose` with
// enough information (whether `ready` was ever seen, the last known
// `serverSeq`) to make that decision well.
export type AgentLiveEndReason =
  | 'slot_complete'
  | 'customer_end'
  | 'disconnect_timeout'
  | 'provider_error'
  | 'capacity'
  | 'platform_error'
  | 'emergency_stop'
  | 'no_show';

export type AgentLiveMoneyOutcome = 'full_charge' | 'refund_pending' | 'refunded';

export interface AgentLiveReadyMsg {
  type: 'ready';
  seq: number;
  connectionGeneration: number;
  sessionGeneration: number;
  sampleRate: 24000;
  channels: 1;
  format: 'pcm16le';
  startsAt: number;
  endsAt: number;
  serverNow: number;
}

export interface AgentLiveCaptionMsg {
  type: 'caption';
  seq: number;
  connectionGeneration: number;
  speaker: 'customer' | 'agent';
  delta: string;
  startMs: number;
  endMs: number;
}

export interface AgentLiveTimerMsg {
  type: 'timer';
  seq: number;
  connectionGeneration: number;
  serverNow: number;
  endsAt: number;
  remainingMs: number;
}

export interface AgentLiveImageAckMsg {
  type: 'image_ack';
  seq: number;
  connectionGeneration: number;
  imageId: string;
  status: 'accepted' | 'analyzing' | 'ready' | 'failed';
  code?: string;
}

export interface AgentLiveEndedMsg {
  type: 'ended';
  seq: number;
  connectionGeneration: number;
  reason: AgentLiveEndReason;
  money: AgentLiveMoneyOutcome;
}

export interface AgentLiveSocketHandlers {
  onReady?: (m: AgentLiveReadyMsg) => void;
  onCaption?: (m: AgentLiveCaptionMsg) => void;
  onTimer?: (m: AgentLiveTimerMsg) => void;
  onImageAck?: (m: AgentLiveImageAckMsg) => void;
  onPlaybackClear?: () => void;
  onPong?: (id: string) => void;
  onEnded?: (m: AgentLiveEndedMsg) => void;
  /** Binary frame from the room — raw PCM16 LE @ 24 kHz mono. */
  onAudio?: (pcm: ArrayBuffer) => void;
  onStatus?: (s: 'connecting' | 'open' | 'closed') => void;
  /** Fired once, on close, with whatever this attempt learned. */
  onClose?: (info: { sawReady: boolean; lastSeq: number; clean: boolean }) => void;
}

export interface AgentLiveSocketOptions {
  /** Fresh per connection attempt — bumped by the caller across a reconnect. */
  connectionGeneration: number;
  /** The visitor's IANA timezone, sent in `hello`. */
  timezone: string;
  /** Highest `seq` this browser has already processed (0 on a first connect). */
  lastServerSeq?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object';
}

export class AgentLiveSocket {
  private sock: WebSocket | null = null;
  private readonly h: AgentLiveSocketHandlers;
  private readonly opts: AgentLiveSocketOptions;
  private sawReady = false;
  private lastSeq: number;
  private closedByUs = false;

  constructor(
    private readonly wsUrl: string,
    handlers: AgentLiveSocketHandlers,
    opts: AgentLiveSocketOptions,
  ) {
    this.h = handlers;
    this.opts = opts;
    this.lastSeq = opts.lastServerSeq ?? 0;
  }

  connect(): void {
    this.closedByUs = false;
    this.h.onStatus?.('connecting');
    let sock: WebSocket;
    try {
      sock = new WebSocket(this.wsUrl);
    } catch {
      this.h.onStatus?.('closed');
      this.h.onClose?.({ sawReady: this.sawReady, lastSeq: this.lastSeq, clean: false });
      return;
    }
    sock.binaryType = 'arraybuffer';
    this.sock = sock;

    sock.addEventListener('open', () => {
      this.h.onStatus?.('open');
      this.sendJson({
        type: 'hello',
        timezone: this.opts.timezone,
        lastServerSeq: this.lastSeq,
      });
    });

    sock.addEventListener('message', (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        this.h.onAudio?.(ev.data);
        return;
      }
      if (typeof ev.data !== 'string') return;
      let msg: unknown;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!isRecord(msg) || typeof msg.type !== 'string') return;
      if (typeof msg.seq === 'number') this.lastSeq = Math.max(this.lastSeq, msg.seq);
      // The room is the authority on connectionGeneration (it increments on each
      // accepted upgrade); adopt whatever it stamps so control frames are never
      // dropped after a failed reconnect attempt desynced the local counter.
      if (typeof msg.connectionGeneration === 'number') this.opts.connectionGeneration = msg.connectionGeneration;
      switch (msg.type) {
        case 'ready':
          this.sawReady = true;
          this.h.onReady?.(msg as unknown as AgentLiveReadyMsg);
          break;
        case 'caption':
          this.h.onCaption?.(msg as unknown as AgentLiveCaptionMsg);
          break;
        case 'timer':
          this.h.onTimer?.(msg as unknown as AgentLiveTimerMsg);
          break;
        case 'image_ack':
          this.h.onImageAck?.(msg as unknown as AgentLiveImageAckMsg);
          break;
        case 'playback_clear':
          this.h.onPlaybackClear?.();
          break;
        case 'pong':
          if (typeof msg.id === 'string') this.h.onPong?.(msg.id);
          break;
        case 'ended':
          this.h.onEnded?.(msg as unknown as AgentLiveEndedMsg);
          break;
        default:
          break;
      }
    });

    sock.addEventListener('close', () => {
      this.h.onStatus?.('closed');
      if (!this.closedByUs) {
        this.h.onClose?.({ sawReady: this.sawReady, lastSeq: this.lastSeq, clean: false });
      }
    });
    sock.addEventListener('error', () => {
      try {
        sock.close();
      } catch {
        /* the close handler above drives onClose */
      }
    });
  }

  private sendJson(body: Record<string, unknown>): void {
    if (!this.sock || this.sock.readyState !== WebSocket.OPEN) return;
    try {
      this.sock.send(JSON.stringify({ v: 1, connectionGeneration: this.opts.connectionGeneration, ...body }));
    } catch {
      /* best-effort — a dropped control frame is not fatal */
    }
  }

  /** Send one 20 ms PCM16LE frame (960 bytes @ 24 kHz) up to the room. */
  sendAudio(pcm: ArrayBuffer): void {
    if (!this.sock || this.sock.readyState !== WebSocket.OPEN) return;
    try {
      this.sock.send(pcm);
    } catch {
      /* ignore — audio frames are not retried */
    }
  }

  setMuted(muted: boolean): void {
    this.sendJson({ type: 'mute', muted });
  }

  /** R2 §3.1/§3.2 backpressure telemetry — how much is scheduled locally. */
  reportPlayback(playedSamples: number, queuedSamples: number): void {
    this.sendJson({ type: 'playback', playedSamples, queuedSamples });
  }

  ping(id: string): void {
    this.sendJson({ type: 'ping', id });
  }

  /** Deliberate end — `permanent:true` per the envelope (R2 §3.2). */
  end(): void {
    this.sendJson({ type: 'end', permanent: true });
  }

  close(): void {
    this.closedByUs = true;
    try {
      this.sock?.close();
    } catch {
      /* ignore */
    }
    this.sock = null;
  }
}

export default AgentLiveSocket;
