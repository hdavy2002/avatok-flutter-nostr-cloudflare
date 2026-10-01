/* [AUMFE-VOICE-WEB-1] Browser side of the voice call: microphone -> 16 kHz PCM16 frames -> WebSocket, and the
 * guide's 24 kHz PCM16 audio -> playback worklet. No React in here. Audio worklets live in /public/voice/ and
 * are fetched only when a call is started (site-speed rule: nothing audio-related loads with the page). */
import type { ClientMsg, ServerMsg } from './types';

export type MicErrorKind = 'denied' | 'no_device' | 'unsupported' | 'failed';

export class MicError extends Error {
  readonly kind: MicErrorKind;
  constructor(kind: MicErrorKind) { super(`mic_${kind}`); this.name = 'MicError'; this.kind = kind; }
}

export interface VoiceClientHandlers {
  onMessage(m: ServerMsg): void;
  /** Socket closed (either side). `opened` says whether it ever connected. */
  onClose(info: { opened: boolean }): void;
  /** ms from {type:"start"} to the first guide audio frame. */
  onFirstAudio(ms: number): void;
}

type AudioCtxCtor = typeof AudioContext;

function audioCtor(): AudioCtxCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioCtxCtor; webkitAudioContext?: AudioCtxCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export class VoiceClient {
  /** Latest smoothed output (guide) and input (customer) levels, 0..1, read by the wave animation. */
  outLevel = 0;
  micLevel = 0;
  muted = false;

  private stream: MediaStream | null = null;
  private micCtx: AudioContext | null = null;
  private outCtx: AudioContext | null = null;
  private micNode: AudioWorkletNode | null = null;
  private outNode: AudioWorkletNode | null = null;
  private ws: WebSocket | null = null;
  private opened = false;
  private closed = false;
  private startedAt = 0;
  private gotAudio = false;

  constructor(private readonly h: VoiceClientHandlers) {}

  /** Call straight from the click: asks for the mic, creates the audio contexts and loads the worklets. */
  async prepareAudio(): Promise<void> {
    const AC = audioCtor();
    if (!AC || !navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') throw new MicError('unsupported');
    // Created inside the user gesture so Safari lets them run.
    try { this.outCtx = new AC({ sampleRate: 24000 }); } catch { this.outCtx = new AC(); }
    this.micCtx = new AC();
    void this.outCtx.resume().catch(() => undefined);
    void this.micCtx.resume().catch(() => undefined);
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      this.teardownAudio();
      const name = e instanceof DOMException ? e.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') throw new MicError('denied');
      if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new MicError('no_device');
      throw new MicError('failed');
    }
    try {
      await Promise.all([
        this.micCtx.audioWorklet.addModule('/voice/mic-worklet.js'),
        this.outCtx.audioWorklet.addModule('/voice/playback-worklet.js'),
      ]);
    } catch {
      this.teardownAudio();
      throw new MicError('failed');
    }
    const outNode = new AudioWorkletNode(this.outCtx, 'aumfe-playback', { numberOfInputs: 0, outputChannelCount: [1] });
    outNode.port.onmessage = (e: MessageEvent<{ level?: number }>) => {
      if (typeof e.data?.level === 'number') this.outLevel = e.data.level;
    };
    outNode.connect(this.outCtx.destination);
    this.outNode = outNode;

    const src = this.micCtx.createMediaStreamSource(this.stream);
    const micNode = new AudioWorkletNode(this.micCtx, 'aumfe-mic', { numberOfOutputs: 1, channelCount: 1 });
    micNode.port.onmessage = (e: MessageEvent<{ pcm?: ArrayBuffer; level?: number }>) => {
      const d = e.data;
      if (typeof d?.level === 'number') this.micLevel = this.muted ? 0 : d.level;
      if (d?.pcm && !this.muted && this.ws && this.ws.readyState === WebSocket.OPEN && this.opened) this.ws.send(d.pcm);
    };
    const silent = this.micCtx.createGain(); // keeps the graph pulled without echoing the mic
    silent.gain.value = 0;
    src.connect(micNode);
    micNode.connect(silent);
    silent.connect(this.micCtx.destination);
    this.micNode = micNode;
  }

  /** Open the socket (mic is already live) and tell the server to begin. */
  connect(wsUrl: string): void {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.opened = true;
      this.startedAt = performance.now();
      this.send({ type: 'start' });
    };
    ws.onmessage = (ev: MessageEvent<string | ArrayBuffer>) => {
      if (typeof ev.data === 'string') {
        let m: ServerMsg;
        try { m = JSON.parse(ev.data) as ServerMsg; } catch { return; }
        if (m.type === 'interrupted') this.flush();
        this.h.onMessage(m);
        return;
      }
      if (ev.data.byteLength < 2) return;
      if (!this.gotAudio) {
        this.gotAudio = true;
        this.h.onFirstAudio(Math.round(performance.now() - this.startedAt));
      }
      this.outNode?.port.postMessage({ pcm: ev.data }, [ev.data]);
    };
    ws.onclose = () => this.finish();
    ws.onerror = () => this.finish();
  }

  send(m: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  setMuted(on: boolean): void {
    this.muted = on;
    if (on) this.micLevel = 0;
    this.stream?.getAudioTracks().forEach((t) => { t.enabled = !on; });
    this.send({ type: 'mute', on });
  }

  /** Drop everything queued for playback (customer spoke over her). */
  flush(): void {
    this.outNode?.port.postMessage({ flush: true });
    this.outLevel = 0;
  }

  /** Ask the server to end; the socket then closes by itself. */
  end(): void {
    this.send({ type: 'end' });
  }

  /** Hard stop: close everything now. Safe to call twice. */
  close(): void {
    this.closed = true;
    try { this.ws?.close(); } catch { /* already closed */ }
    this.teardownAudio();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.teardownAudio();
    this.h.onClose({ opened: this.opened });
  }

  private teardownAudio(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    try { this.micNode?.disconnect(); } catch { /* ignore */ }
    try { this.outNode?.disconnect(); } catch { /* ignore */ }
    this.micNode = null;
    this.outNode = null;
    void this.micCtx?.close().catch(() => undefined);
    void this.outCtx?.close().catch(() => undefined);
    this.micCtx = null;
    this.outCtx = null;
  }
}
