/* [AUMFE-CONSULT-F3-1 2026-10-02] Real Consultants 1:1 audio call engine — plain WebRTC + the ConsultCallDO WebSocket.
 * Framework-agnostic: the desk in-call bar and the customer page /guides/session/[id] both drive this class.
 *
 * Flow (spec: Specs/SPEC-2026-10-02-REAL-CONSULTANTS-BUILD.md, "W3 call.ts + ws.ts"):
 *   start()  -> microphone (inside the click, so the browser lets it) -> POST ticket -> open ws_url -> {t:"hello"}
 *   state    -> {me, other_present, started_at, slot_end_ms, you_offer}. The CONSULTANT is always the offerer: when the
 *               other side becomes present it builds a fresh RTCPeerConnection and sends {t:"offer"}; the customer answers.
 *   ice      -> trickled both ways; candidates that arrive before the remote description are queued.
 *   failure  -> ICE "failed" / "disconnected" -> the offerer restarts ICE. WebSocket drop -> reconnect with a FRESH ticket
 *               (the call keeps playing meanwhile). Consultant "end" / slot over / admin -> {t:"ended"} and teardown.
 * Also: Wake Lock (re-acquired when the tab comes back), Media Session (lock-screen title + hang up / mute), setSinkId where
 * the browser supports it, tarot "reveal" both ways, and PostHog `consult_call_client` {role, event, ice_state}.
 * NOTE FOR AI: audio only — never ask for video. No recording. Do not log SDP or tickets (secrets). */
import { capture, captureException } from './analytics';
import type { CallClientMsg, CallServerMsg, CallTicketDTO } from './consultTypes';

export type CallStatus = 'idle' | 'starting' | 'connecting' | 'waiting' | 'connected' | 'reconnecting' | 'ended' | 'error';
export type CallErrorKind = 'mic_denied' | 'mic_missing' | 'mic_unsupported' | 'mic_failed' | 'ticket' | 'socket' | 'server';
export type CallEndReason = 'ended_by_consultant' | 'slot_over' | 'admin' | 'left' | 'dropped';
export interface CallError { kind: CallErrorKind; message: string; status?: number; code?: string }
export interface RevealedCard { id: number; reversed: boolean; position: string; at: number }

export interface CallState {
  status: CallStatus;
  role: 'customer' | 'consultant' | null;
  otherPresent: boolean;
  /** epoch ms both sides were present (server clock), null until then. */
  startedAt: number | null;
  slotEndMs: number | null;
  muted: boolean;
  iceState: string;
  endedReason: CallEndReason | null;
  error: CallError | null;
  reveals: RevealedCard[];
  speakerSupported: boolean;
  sinkId: string;
}

export interface ConsultCallOptions {
  /** Fetches a (single-use) ticket: POST /api/consultants/sessions/:id/ticket. Called again on every reconnect. */
  fetchTicket: () => Promise<CallTicketDTO>;
  /** Lock-screen / media-session text. */
  title: string;
  artist: string;
  artworkUrl?: string;
  /** Role hint for telemetry before the first state message. */
  role?: 'customer' | 'consultant';
}

const MAX_WS_RETRIES = 8;
const PING_MS = 25_000;
const DISCONNECT_GRACE_MS = 3_000;

type Listener = (s: CallState) => void;

interface WakeLockSentinelLike { release(): Promise<void>; addEventListener?: (t: string, f: () => void) => void }
type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void>; sinkId?: string };

function errName(e: unknown): string { return e instanceof DOMException ? e.name : ''; }

export class ConsultCall {
  private s: CallState;
  private listeners = new Set<Listener>();
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private audioEl: SinkAudio | null = null;
  private iceServers: RTCIceServer[] = [];
  private pendingIce: RTCIceCandidateInit[] = [];
  private youOffer = false;
  private lastOtherPresent = false;
  private offering = false;
  private everConnected = false;
  private closedByUs = false;
  private torn = false;
  private retries = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeLock: WakeLockSentinelLike | null = null;
  private onVisibility = () => { if (document.visibilityState === 'visible' && !this.torn) void this.acquireWakeLock(); };

  constructor(private readonly o: ConsultCallOptions) {
    this.s = {
      status: 'idle', role: o.role ?? null, otherPresent: false, startedAt: null, slotEndMs: null, muted: false, iceState: 'new',
      endedReason: null, error: null, reveals: [], sinkId: 'default',
      speakerSupported: typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype,
    };
  }

  /* ───────── public API ───────── */

  getState = (): CallState => this.s;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  /** Call straight from the click handler (microphone + audio playback both need the gesture). */
  async start(): Promise<void> {
    if (this.s.status !== 'idle' && this.s.status !== 'error' && this.s.status !== 'ended') return;
    this.resetForStart();
    this.set({ status: 'starting', error: null, endedReason: null });
    this.track('start');
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
      this.fail({ kind: 'mic_unsupported', message: 'This browser cannot do audio calls.' });
      return;
    }
    this.makeAudioElement();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (e) {
      const n = errName(e);
      if (n === 'NotAllowedError' || n === 'SecurityError') this.fail({ kind: 'mic_denied', message: 'Microphone permission was denied.' });
      else if (n === 'NotFoundError' || n === 'OverconstrainedError') this.fail({ kind: 'mic_missing', message: 'No microphone was found.' });
      else this.fail({ kind: 'mic_failed', message: 'The microphone could not be started.' });
      this.track('mic_error', { name: n });
      return;
    }
    this.stream.getAudioTracks().forEach((t) => { t.enabled = !this.s.muted; });
    void this.acquireWakeLock();
    document.addEventListener('visibilitychange', this.onVisibility);
    this.setupMediaSession();
    await this.openSocket();
  }

  /** Consultant: ends the session for both. Customer: just leaves (the consultant may still be there). */
  end(): void {
    if (this.torn) return;
    if (this.s.role === 'consultant') this.send({ t: 'end' });
    this.closedByUs = true;
    this.track('end_clicked');
    this.teardown('ended', this.s.role === 'consultant' ? 'ended_by_consultant' : 'left');
  }

  setMuted(muted: boolean): void {
    this.stream?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    this.set({ muted });
    this.updateMediaSessionState();
  }
  toggleMute(): void { this.setMuted(!this.s.muted); }

  /** Lists audio outputs (needs a granted mic permission to show labels). Empty when the browser cannot choose. */
  async listOutputs(): Promise<{ id: string; label: string }[]> {
    if (!this.s.speakerSupported || !navigator.mediaDevices?.enumerateDevices) return [];
    try {
      const d = await navigator.mediaDevices.enumerateDevices();
      return d.filter((x) => x.kind === 'audiooutput').map((x, i) => ({ id: x.deviceId, label: x.label || `Speaker ${i + 1}` }));
    } catch { return []; }
  }

  async setSpeaker(deviceId: string): Promise<boolean> {
    const el = this.audioEl;
    if (!el?.setSinkId) return false;
    try { await el.setSinkId(deviceId); this.set({ sinkId: deviceId }); return true; } catch (e) { captureException(e, { where: 'consult_call_sink' }); return false; }
  }

  /** Consultant (tarot): show a card on the customer's call screen. */
  sendReveal(card: { id: number; reversed: boolean; position: string }): boolean {
    const ok = this.send({ t: 'reveal', card });
    if (ok) this.track('reveal_sent');
    return ok;
  }

  /** Free everything. Safe to call twice (page unload, React unmount). */
  destroy(): void {
    if (this.torn) return;
    this.closedByUs = true;
    this.teardown(this.s.status === 'ended' ? 'ended' : 'idle', this.s.endedReason);
  }

  /* ───────── state ───────── */

  private set(p: Partial<CallState>): void {
    this.s = { ...this.s, ...p };
    for (const l of [...this.listeners]) { try { l(this.s); } catch { /* a bad listener must not break the call */ } }
  }

  private resetForStart(): void {
    this.torn = false;
    this.closedByUs = false;
    this.retries = 0;
    this.everConnected = false;
    this.lastOtherPresent = false;
    this.offering = false;
    this.pendingIce = [];
    this.set({ otherPresent: false, startedAt: null, reveals: [], iceState: 'new' });
  }

  private fail(e: CallError): void {
    this.set({ status: 'error', error: e });
    this.track('error', { kind: e.kind });
    this.releaseMedia();
  }

  private track(event: string, extra?: Record<string, unknown>): void {
    capture('consult_call_client', { role: this.s.role ?? this.o.role ?? 'unknown', event, ice_state: this.s.iceState, ...extra });
  }

  /* ───────── signalling ───────── */

  private async openSocket(): Promise<void> {
    if (this.torn) return;
    this.set({ status: this.everConnected || this.retries > 0 ? 'reconnecting' : 'connecting' });
    let t: CallTicketDTO;
    try {
      t = await this.o.fetchTicket();
    } catch (e) {
      const status = (e as { status?: number } | null)?.status;
      const code = (e as { error?: string } | null)?.error;
      // 4xx = the server said no (too early, not your booking, session over): never retry blindly.
      if (this.everConnected && !(typeof status === 'number' && status >= 400 && status < 500)) { this.scheduleRetry(); return; }
      captureException(e, { where: 'consult_call_ticket', status });
      this.fail({ kind: 'ticket', message: 'We could not open the call just now.', status, code });
      return;
    }
    if (this.torn) return;
    this.iceServers = (t.ice_servers ?? []) as RTCIceServer[];
    this.set({ role: t.role, slotEndMs: t.slot_end_ms });
    let ws: WebSocket;
    try { ws = new WebSocket(t.ws_url); } catch (e) { captureException(e, { where: 'consult_call_ws' }); this.scheduleRetry(); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      this.send({ t: 'hello' });
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.send({ t: 'ping' }), PING_MS);
      this.track('ws_open');
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let m: CallServerMsg;
      try { m = JSON.parse(ev.data) as CallServerMsg; } catch { return; }
      void this.onServer(m).catch((e) => captureException(e, { where: 'consult_call_msg', t: m.t }));
    };
    ws.onclose = () => {
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closedByUs || this.torn || this.s.status === 'ended') return;
      this.track('ws_closed');
      this.scheduleRetry();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  private scheduleRetry(): void {
    if (this.torn || this.closedByUs) return;
    if (this.retries >= MAX_WS_RETRIES) {
      this.fail({ kind: 'socket', message: 'The connection was lost and could not be restored.' });
      return;
    }
    this.retries += 1;
    this.set({ status: 'reconnecting' });
    const wait = Math.min(8000, 600 * 2 ** (this.retries - 1));
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { void this.openSocket(); }, wait);
  }

  private send(m: CallClientMsg): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) { this.ws.send(JSON.stringify(m)); return true; }
    return false;
  }

  private async onServer(m: CallServerMsg): Promise<void> {
    switch (m.t) {
      case 'state': {
        this.youOffer = m.you_offer;
        const was = this.lastOtherPresent;
        this.lastOtherPresent = m.other_present;
        this.set({
          role: m.me, otherPresent: m.other_present, startedAt: m.started_at, slotEndMs: m.slot_end_ms,
          status: this.s.iceState === 'connected' || this.s.iceState === 'completed' ? 'connected' : (m.other_present ? this.s.status === 'waiting' ? 'connecting' : this.s.status : 'waiting'),
        });
        if (!m.other_present) { if (this.s.status !== 'ended') this.set({ status: 'waiting' }); return; }
        if (this.youOffer) {
          const bad = !this.pc || ['failed', 'closed', 'disconnected'].includes(this.pc.connectionState) || ['failed', 'closed'].includes(this.pc.iceConnectionState);
          if (!was || !this.pc) await this.makeOffer(true);
          else if (bad) await this.makeOffer(false);
        }
        return;
      }
      case 'offer': await this.onOffer(m.sdp); return;
      case 'answer': {
        const pc = this.pc;
        if (!pc || pc.signalingState !== 'have-local-offer') return;
        await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
        await this.flushIce();
        return;
      }
      case 'ice': {
        const c = m.candidate as RTCIceCandidateInit | null;
        if (!c) return;
        if (this.pc && this.pc.remoteDescription) { try { await this.pc.addIceCandidate(c); } catch { /* stale candidate */ } } else this.pendingIce.push(c);
        return;
      }
      case 'peer_left':
        this.lastOtherPresent = false;
        this.set({ otherPresent: false, status: 'waiting' });
        this.closePc();
        this.track('peer_left');
        return;
      case 'reveal':
        this.set({ reveals: [...this.s.reveals, { ...m.card, at: Date.now() }] });
        this.track('reveal_received');
        return;
      case 'ended':
        this.closedByUs = true;
        this.track('ended', { reason: m.reason });
        this.teardown('ended', m.reason);
        return;
      case 'error':
        captureException(new Error(`consult_call_server_${m.error}`), { where: 'consult_call_server', error: m.error });
        if (m.error === 'ended' || m.error === 'session_over') { this.closedByUs = true; this.teardown('ended', 'slot_over'); return; }
        this.fail({ kind: 'server', message: 'The call service reported a problem.', code: m.error });
        return;
      case 'pong': return;
      default: return;
    }
  }

  /* ───────── WebRTC ───────── */

  private ensurePc(fresh: boolean): RTCPeerConnection {
    if (fresh) this.closePc();
    if (this.pc) return this.pc;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;
    this.stream?.getTracks().forEach((t) => pc.addTrack(t, this.stream as MediaStream));
    pc.onicecandidate = (e) => { if (e.candidate) this.send({ t: 'ice', candidate: e.candidate.toJSON() }); };
    pc.ontrack = (e) => {
      const el = this.audioEl;
      if (!el) return;
      el.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      void el.play().catch(() => { /* the click that started the call already unlocked playback */ });
    };
    pc.oniceconnectionstatechange = () => this.onIceState(pc);
    return pc;
  }

  private closePc(): void {
    if (this.disconnectTimer) { clearTimeout(this.disconnectTimer); this.disconnectTimer = null; }
    const pc = this.pc;
    this.pc = null;
    this.pendingIce = [];
    this.offering = false;
    if (pc) { pc.onicecandidate = null; pc.ontrack = null; pc.oniceconnectionstatechange = null; try { pc.close(); } catch { /* already closed */ } }
    if (this.audioEl) this.audioEl.srcObject = null;
  }

  private async makeOffer(fresh: boolean, restart = false): Promise<void> {
    if (this.offering || this.torn) return;
    this.offering = true;
    try {
      const pc = this.ensurePc(fresh);
      const offer = await pc.createOffer(restart ? { iceRestart: true } : undefined);
      await pc.setLocalDescription(offer);
      this.send({ t: 'offer', sdp: offer.sdp ?? '' });
      this.track(restart ? 'ice_restart' : 'offer_sent');
    } finally { this.offering = false; }
  }

  private async onOffer(sdp: string): Promise<void> {
    let pc = this.ensurePc(false);
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
    } catch {
      pc = this.ensurePc(true);          // a stale connection could not take the new offer: start clean once
      await pc.setRemoteDescription({ type: 'offer', sdp });
    }
    await this.flushIce();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.send({ t: 'answer', sdp: answer.sdp ?? '' });
    this.track('answer_sent');
  }

  private async flushIce(): Promise<void> {
    const pc = this.pc;
    if (!pc || !pc.remoteDescription) return;
    const q = this.pendingIce.splice(0);
    for (const c of q) { try { await pc.addIceCandidate(c); } catch { /* stale candidate */ } }
  }

  private onIceState(pc: RTCPeerConnection): void {
    if (pc !== this.pc) return;
    const st = pc.iceConnectionState;
    this.set({ iceState: st });
    this.track('ice_state');
    if (st === 'connected' || st === 'completed') {
      if (this.disconnectTimer) { clearTimeout(this.disconnectTimer); this.disconnectTimer = null; }
      if (!this.everConnected) { this.everConnected = true; this.track('connected'); }
      this.set({ status: 'connected', error: null });
      this.updateMediaSessionState();
      return;
    }
    if (st === 'failed' || st === 'disconnected') {
      this.set({ status: 'reconnecting' });
      if (this.s.role !== 'consultant') return; // the offerer restarts; the customer answers the new offer
      const go = () => { if (this.pc === pc && ['failed', 'disconnected'].includes(pc.iceConnectionState)) void this.makeOffer(false, true).catch((e) => captureException(e, { where: 'consult_call_ice_restart' })); };
      if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
      if (st === 'failed') go(); else this.disconnectTimer = setTimeout(go, DISCONNECT_GRACE_MS);
    }
  }

  /* ───────── device bits ───────── */

  private makeAudioElement(): void {
    if (this.audioEl || typeof document === 'undefined') return;
    const el = document.createElement('audio') as SinkAudio;
    el.autoplay = true;
    el.setAttribute('playsinline', '');
    el.style.display = 'none';
    document.body.appendChild(el);
    this.audioEl = el;
    void el.play().catch(() => undefined); // inside the gesture: unlocks playback on Safari
  }

  private async acquireWakeLock(): Promise<void> {
    try {
      const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<WakeLockSentinelLike> } }).wakeLock;
      if (!wl || this.wakeLock) return;
      const s = await wl.request('screen');
      this.wakeLock = s;
      s.addEventListener?.('release', () => { if (this.wakeLock === s) this.wakeLock = null; });
    } catch { /* not allowed / battery saver: the call still works */ }
  }

  private setupMediaSession(): void {
    try {
      const ms = (navigator as unknown as { mediaSession?: MediaSession }).mediaSession;
      if (!ms) return;
      const art = this.o.artworkUrl ? [{ src: this.o.artworkUrl, sizes: '512x512', type: 'image/jpeg' }] : [];
      ms.metadata = new MediaMetadata({ title: this.o.title, artist: this.o.artist, artwork: art });
      ms.playbackState = 'playing';
      const set = (a: string, fn: () => void) => { try { ms.setActionHandler(a as MediaSessionAction, fn); } catch { /* action not supported here */ } };
      set('hangup', () => this.end());
      set('togglemicrophone', () => this.toggleMute());
      set('play', () => { void this.audioEl?.play().catch(() => undefined); });
      set('pause', () => { /* a live call is never paused from the lock screen */ });
    } catch { /* Media Session is a nicety */ }
  }

  private updateMediaSessionState(): void {
    try {
      const ms = (navigator as unknown as { mediaSession?: MediaSession & { setMicrophoneActive?: (b: boolean) => void } }).mediaSession;
      ms?.setMicrophoneActive?.(!this.s.muted);
    } catch { /* optional */ }
  }

  private releaseMedia(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.closePc();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.ws) { const w = this.ws; this.ws = null; w.onclose = null; w.onmessage = null; try { w.close(1000, 'bye'); } catch { /* closed */ } }
    if (this.audioEl) { this.audioEl.remove(); this.audioEl = null; }
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    const wl = this.wakeLock; this.wakeLock = null;
    if (wl) void wl.release().catch(() => undefined);
    try {
      const ms = (navigator as unknown as { mediaSession?: MediaSession }).mediaSession;
      if (ms) { ms.playbackState = 'none'; ms.metadata = null; for (const a of ['hangup', 'togglemicrophone', 'play', 'pause']) { try { ms.setActionHandler(a as MediaSessionAction, null); } catch { /* n/a */ } } }
    } catch { /* optional */ }
  }

  private teardown(status: CallStatus, reason: CallEndReason | null): void {
    if (this.torn) return;
    this.torn = true;
    this.releaseMedia();
    this.set({ status, endedReason: reason, otherPresent: false });
  }
}
