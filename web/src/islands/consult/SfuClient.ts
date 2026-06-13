/*
 * SfuClient — native WebRTC client for a 1:1 consult, talking to the
 * Cloudflare Realtime SFU through the Worker's authed proxy. NO LiveKit / Dyte /
 * RealtimeKit SDK — just the browser's own `RTCPeerConnection` (MASTER-PROMPT §7,
 * PHASE-D "critical correction").
 *
 * Transport: every SFU call is a `POST` to
 *   `${API_BASE}/api/consult/:bookingId/sfu/<sub>`
 * The proxy (worker/src/routes/consult.ts → consultSfu) forwards `<sub>` to
 *   `https://rtc.live.cloudflare.com/v1/apps/<APP_ID><sub>`
 * with the app secret attached server-side. It reads the real HTTP verb from the
 * `x-sfu-method` header ("The app always POSTs … x-sfu-method carries the real
 * verb") and the session token from `x-session-token` (or `?token=`). We follow
 * that exact convention.
 *
 * Cloudflare Realtime SFU HTTP API (the proxy is transparent):
 *   POST /sessions/new                         -> { sessionId }
 *   POST /sessions/:id/tracks/new  (publish)   body { sessionDescription:{type:"offer",sdp}, tracks:[{location:"local",mid,trackName}] }
 *                                              -> { sessionDescription:{type:"answer",sdp}, tracks:[...] }
 *   POST /sessions/:id/tracks/new  (pull)      body { tracks:[{location:"remote",sessionId,trackName}] }
 *                                              -> { requiresImmediateRenegotiation, sessionDescription:{type:"offer",sdp}, tracks:[...] }
 *   PUT  /sessions/:id/renegotiate             body { sessionDescription:{type:"answer",sdp} }
 *
 * CONTRACT DRIFT (documented for Phase Z): for a capacity-1 booking the Worker's
 * /join returns `mode:"p2p"` (a CallRoom-DO path used by the Flutter app). The
 * web client deliberately does NOT implement that app-only P2P signaling; per
 * PHASE-D's critical correction it always negotiates through the SFU proxy, which
 * works whenever CALLS_APP_ID/SECRET are configured on the env (otherwise the
 * proxy returns 503 "group sessions unavailable", surfaced as a clear error).
 */
import { API_BASE } from '../../lib/config';

export type SfuConnState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed';

export interface PublishedTracks {
  /** Our SFU session id — announced to the peer over the room WS. */
  sessionId: string;
  /** Track names the peer must pull, by kind. */
  audio: string | null;
  video: string | null;
}

export interface SfuClientOpts {
  bookingId: string;
  /** Session JWT (room_token from /join). */
  token: string;
  /** Fires whenever a remote MediaStream becomes available. */
  onRemoteStream: (stream: MediaStream) => void;
  /** PeerConnection lifecycle for the connection HUD. */
  onState?: (s: SfuConnState) => void;
}

const ICE_GATHER_TIMEOUT_MS = 2500;
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
  bundlePolicy: 'max-bundle',
};

let _seq = 0;
const uniqueName = (kind: string) => `${kind}-${Date.now().toString(36)}-${(_seq++).toString(36)}`;

export class SfuClient {
  private readonly opts: SfuClientOpts;
  private pc: RTCPeerConnection | null = null;
  private sessionId: string | null = null;
  private remote = new MediaStream();
  private pulled = new Set<string>(); // `${sessionId}/${trackName}` already pulled
  private negotiating = false;
  private closed = false;

  constructor(opts: SfuClientOpts) {
    this.opts = opts;
  }

  // ── proxy plumbing ────────────────────────────────────────────────────────

  private async sfu<T>(method: 'POST' | 'PUT' | 'GET', sub: string, body?: unknown): Promise<T> {
    const url = `${API_BASE}/api/consult/${encodeURIComponent(this.opts.bookingId)}/sfu${sub}`;
    const res = await fetch(url, {
      method: 'POST', // the proxy always receives POST; the verb rides x-sfu-method
      headers: {
        'content-type': 'application/json',
        'x-sfu-method': method,
        'x-session-token': this.opts.token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const msg =
        parsed && typeof parsed === 'object' && parsed !== null && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : res.statusText || `SFU ${res.status}`;
      throw new Error(`${res.status}: ${msg}`);
    }
    return parsed as T;
  }

  // ── peer connection ───────────────────────────────────────────────────────

  private setState(s: SfuConnState) {
    if (!this.closed) this.opts.onState?.(s);
  }

  private ensurePc(): RTCPeerConnection {
    if (this.pc) return this.pc;
    const pc = new RTCPeerConnection(RTC_CONFIG);
    pc.addEventListener('track', (e) => {
      this.remote.addTrack(e.track);
      this.opts.onRemoteStream(this.remote);
    });
    pc.addEventListener('connectionstatechange', () => {
      switch (pc.connectionState) {
        case 'connected':
          this.setState('connected');
          break;
        case 'connecting':
        case 'new':
          this.setState('connecting');
          break;
        case 'disconnected':
          this.setState('reconnecting');
          break;
        case 'failed':
          this.setState('failed');
          break;
        case 'closed':
          this.setState('closed');
          break;
      }
    });
    this.pc = pc;
    return pc;
  }

  /** Resolve once ICE gathering completes, or after a short timeout (trickle-free SDP). */
  private async waitIce(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return;
    await new Promise<void>((resolve) => {
      const done = () => {
        pc.removeEventListener('icegatheringstatechange', check);
        clearTimeout(timer);
        resolve();
      };
      const check = () => {
        if (pc.iceGatheringState === 'complete') done();
      };
      const timer = setTimeout(done, ICE_GATHER_TIMEOUT_MS);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  // ── publish ───────────────────────────────────────────────────────────────

  /**
   * Create the SFU session and publish the local stream's audio+video.
   * Returns the session id + track names to announce to the peer.
   */
  async publish(local: MediaStream): Promise<PublishedTracks> {
    this.setState('connecting');
    const created = await this.sfu<{ sessionId: string }>('POST', '/sessions/new');
    this.sessionId = created.sessionId;
    const pc = this.ensurePc();

    const result: PublishedTracks = { sessionId: created.sessionId, audio: null, video: null };
    const trackDefs: Array<{ location: 'local'; mid: string; trackName: string }> = [];

    for (const track of local.getTracks()) {
      const tn = uniqueName(track.kind);
      const tx = pc.addTransceiver(track, { direction: 'sendonly', streams: [local] });
      // mid is assigned after setLocalDescription; stash on the transceiver.
      (tx as RTCRtpTransceiver & { __tn?: string }).__tn = tn;
      if (track.kind === 'audio') result.audio = tn;
      if (track.kind === 'video') result.video = tn;
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.waitIce(pc);

    for (const tx of pc.getTransceivers()) {
      const tn = (tx as RTCRtpTransceiver & { __tn?: string }).__tn;
      if (tn && tx.mid) trackDefs.push({ location: 'local', mid: tx.mid, trackName: tn });
    }

    const answer = await this.sfu<{ sessionDescription: RTCSessionDescriptionInit }>(
      'POST',
      `/sessions/${this.sessionId}/tracks/new`,
      { sessionDescription: pc.localDescription, tracks: trackDefs },
    );
    await pc.setRemoteDescription(answer.sessionDescription);
    return result;
  }

  // ── pull the peer ─────────────────────────────────────────────────────────

  /**
   * Subscribe to the peer's published tracks. Idempotent: a track already pulled
   * is skipped, so re-announcements (reconnects) are safe.
   */
  async pull(peerSessionId: string, trackNames: Array<string | null | undefined>): Promise<void> {
    if (!this.sessionId || !this.pc) throw new Error('publish() must run before pull()');
    const want = trackNames
      .filter((t): t is string => !!t)
      .filter((t) => !this.pulled.has(`${peerSessionId}/${t}`));
    if (want.length === 0) return;
    if (this.negotiating) {
      // Serialize concurrent pulls; retry shortly.
      await new Promise((r) => setTimeout(r, 250));
      return this.pull(peerSessionId, trackNames);
    }
    this.negotiating = true;
    try {
      const tracks = want.map((trackName) => ({ location: 'remote' as const, sessionId: peerSessionId, trackName }));
      const res = await this.sfu<{
        requiresImmediateRenegotiation?: boolean;
        sessionDescription?: RTCSessionDescriptionInit;
      }>('POST', `/sessions/${this.sessionId}/tracks/new`, { tracks });
      for (const t of want) this.pulled.add(`${peerSessionId}/${t}`);

      if (res.requiresImmediateRenegotiation && res.sessionDescription) {
        const pc = this.pc;
        await pc.setRemoteDescription(res.sessionDescription); // SFU's offer
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.waitIce(pc);
        await this.sfu('PUT', `/sessions/${this.sessionId}/renegotiate`, {
          sessionDescription: pc.localDescription,
        });
      }
    } finally {
      this.negotiating = false;
    }
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  close(): void {
    this.closed = true;
    try {
      this.pc?.getSenders().forEach((s) => s.track?.stop());
    } catch {
      /* ignore */
    }
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.pc = null;
    this.remote.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    });
    this.remote = new MediaStream();
    this.setState('closed');
  }
}

export default SfuClient;
