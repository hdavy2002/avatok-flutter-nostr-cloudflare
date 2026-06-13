// WHEP player — primary, lowest-latency live path (MASTER-PROMPT §7 / PHASE-C §3).
//
// The creator publishes from the phone via WHIP to Cloudflare Stream Live; the
// Worker (`worker/src/routes/live.ts` → `liveJoin`) hands the browser back a
// `whep` URL (`live_sessions.whep_url`, i.e. Cloudflare's `webRTCPlayback.url`).
// We negotiate a recvonly WebRTC session against it by hand — NO LiveKit, no
// media SDK, ~100 lines of `RTCPeerConnection`. This is the WHEP spec
// (draft-ietf-wish-whep): POST an SDP offer, get an SDP answer, optionally
// DELETE the resource (Location header) to tear down.
//
// Cloudflare's WHEP endpoint is NON-trickle, so we gather ICE fully before the
// POST (with a short timeout safety net) and send one complete offer.

export type WhepStatus = 'idle' | 'connecting' | 'playing' | 'failed' | 'closed';

export interface WhepPlayerOptions {
  /** WHEP playback URL from /api/live/:id/join → `whep`. */
  url: string;
  /** The <video> element to attach the remote stream to. */
  video: HTMLVideoElement;
  /** Status transitions (UI badge, fallback trigger). */
  onStatus?: (status: WhepStatus, detail?: string) => void;
  /** Max ms to wait for ICE gathering before sending the offer anyway. */
  iceTimeoutMs?: number;
}

export class WhepPlayer {
  private pc: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  /** WHEP resource URL (Location header) for trickle PATCH / teardown DELETE. */
  private resource: string | null = null;
  private closed = false;
  private readonly opts: Required<Pick<WhepPlayerOptions, 'iceTimeoutMs'>> & WhepPlayerOptions;

  constructor(options: WhepPlayerOptions) {
    this.opts = { iceTimeoutMs: 2500, ...options };
  }

  private emit(s: WhepStatus, detail?: string): void {
    this.opts.onStatus?.(s, detail);
  }

  /** Negotiate and start playback. Resolves once the answer is applied; rejects on any failure. */
  async start(): Promise<void> {
    this.emit('connecting');
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
      bundlePolicy: 'max-bundle',
    });
    this.pc = pc;
    this.stream = new MediaStream();

    // Receive-only: we only ever consume the creator's audio + video.
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    pc.ontrack = (e) => {
      if (this.closed) return;
      this.stream!.addTrack(e.track);
      // Attach once; both tracks land on the same MediaStream.
      if (this.opts.video.srcObject !== this.stream) {
        this.opts.video.srcObject = this.stream;
      }
    };

    pc.onconnectionstatechange = () => {
      if (this.closed) return;
      const st = pc.connectionState;
      if (st === 'connected') this.emit('playing');
      else if (st === 'failed' || st === 'disconnected' || st === 'closed') {
        this.emit('failed', `pc ${st}`);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.waitForIce(pc);

    const sdp = pc.localDescription?.sdp;
    if (!sdp) throw new Error('no local SDP');

    let res: Response;
    try {
      res = await fetch(this.opts.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp', Accept: 'application/sdp' },
        body: sdp,
      });
    } catch (e) {
      this.emit('failed', 'network');
      throw e;
    }
    if (!res.ok) {
      this.emit('failed', `whep ${res.status}`);
      throw new Error(`WHEP POST failed: ${res.status}`);
    }

    // Remember the resource URL so we can DELETE it on teardown (spec §4.2).
    const loc = res.headers.get('Location');
    if (loc) {
      try {
        this.resource = new URL(loc, this.opts.url).toString();
      } catch {
        this.resource = loc;
      }
    }

    const answer = await res.text();
    if (this.closed) return;
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    // 'playing' is emitted from onconnectionstatechange when ICE connects.
  }

  /** Resolve once ICE gathering completes, or after iceTimeoutMs (non-trickle endpoint). */
  private waitForIce(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => {
        if (pc.iceGatheringState === 'complete') done();
      };
      const timer = setTimeout(done, this.opts.iceTimeoutMs);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  /** Tear down the peer connection and best-effort DELETE the WHEP resource. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.emit('closed');
    const resource = this.resource;
    try {
      this.stream?.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    try {
      if (this.opts.video.srcObject === this.stream) this.opts.video.srcObject = null;
    } catch {
      /* ignore */
    }
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.pc = null;
    this.stream = null;
    this.resource = null;
    if (resource) {
      // Fire-and-forget; the endpoint also reaps idle sessions.
      void fetch(resource, { method: 'DELETE' }).catch(() => {});
    }
  }
}

export default WhepPlayer;
