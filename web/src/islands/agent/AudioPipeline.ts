// AudioPipeline — Web Audio plumbing for the agent call.
//
// IN  (mic → agent): getUserMedia({audio}) with AEC/NS/AGC on, captured via an
//   AudioWorklet that downsamples the device rate to 16 kHz mono PCM16 and posts
//   chunks to the main thread (which base64s + sends over the Gemini WS). The
//   worklet is loaded lazily from an inline Blob URL — no extra network asset,
//   no UI-thread audio work. Falls back to ScriptProcessorNode where AudioWorklet
//   is unavailable.
// OUT (agent → speaker): 24 kHz mono PCM16 chunks are converted to AudioBuffers
//   and scheduled back-to-back on a dedicated 24 kHz AudioContext with a small
//   jitter buffer (lead time) so playback is gapless and smooth.
//
// Rates mirror the app's reference engine: mic 16 kHz in, agent 24 kHz out.
// [AGENT-LIVE-1] R2 §3.1: Agent Live wants 24 kHz BOTH ways — `new
// AudioPipeline(handlers, { inputRate: 24000, outputRate: 24000 })`. The
// Gemini callers (AgentCall.tsx) pass no second argument at all, so the
// defaults below MUST stay 16000/24000 — changing them would silently
// re-tune every existing Gemini call.

const MIC_RATE = 16000;
const AGENT_RATE = 24000;
const JITTER_LEAD_SEC = 0.1; // R2 §3.1: 80-120 ms lead so chunks never under-run
const QUEUE_CEILING_SEC = 0.5; // R2 §3.1: don't let scheduled playback exceed 500 ms

export interface AudioRates {
  inputRate: number;
  outputRate: number;
}

// Inline AudioWorklet: linear-resample input → 16 kHz, emit Int16 frames + RMS.
const WORKLET_SRC = `
class MicDownsampler extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.targetRate = (opts.processorOptions && opts.processorOptions.targetRate) || 16000;
    this.ratio = sampleRate / this.targetRate; // sampleRate is the context rate
    this.pos = 0;
    this.muted = false;
    this.port.onmessage = (e) => { if (e.data && 'muted' in e.data) this.muted = !!e.data.muted; };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || this.muted) return true;
    const outLen = Math.floor((ch.length - this.pos) / this.ratio);
    if (outLen <= 0) { this.pos -= ch.length; if (this.pos < 0) this.pos = 0; return true; }
    const out = new Int16Array(outLen);
    let sumSq = 0;
    let idx = this.pos;
    for (let i = 0; i < outLen; i++) {
      const i0 = Math.floor(idx);
      const frac = idx - i0;
      const s0 = ch[i0] || 0;
      const s1 = ch[i0 + 1] !== undefined ? ch[i0 + 1] : s0;
      let s = s0 + (s1 - s0) * frac;        // linear interpolation
      if (s > 1) s = 1; else if (s < -1) s = -1;
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      sumSq += s * s;
      idx += this.ratio;
    }
    this.pos = idx - ch.length;             // carry the fractional remainder
    if (this.pos < 0) this.pos = 0;
    const rms = Math.sqrt(sumSq / outLen);
    this.port.postMessage({ pcm: out.buffer, rms }, [out.buffer]);
    return true;
  }
}
registerProcessor('mic-downsampler', MicDownsampler);
`;

export interface AudioPipelineHandlers {
  /** A 16 kHz PCM16 mic chunk ready to send to the agent. */
  onMicChunk?: (pcm16: ArrayBuffer) => void;
  /** Mic input level 0..1 (for the "you're talking" indicator). */
  onMicLevel?: (level: number) => void;
  /** Agent playback started / stopped (talking indicator). */
  onAgentSpeaking?: (speaking: boolean) => void;
}

export class AudioPipeline {
  private micCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private micNode: AudioWorkletNode | ScriptProcessorNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;

  private outCtx: AudioContext | null = null;
  private playHead = 0;
  private scheduled = 0; // count of buffers still in the future
  // R2 §3.1: track scheduled source nodes so a clear can stop them directly
  // instead of tearing down and rebuilding the whole AudioContext.
  private scheduledNodes: Set<AudioBufferSourceNode> = new Set();
  private speaking = false;
  private muted = false;
  private workletUrl: string | null = null;

  private readonly inputRate: number;
  private readonly outputRate: number;
  // R2 §3.1: aggregate mic capture into fixed 20 ms frames (inputRate*0.02
  // samples) before handing them to onMicChunk, carrying any fractional
  // remainder across worklet/ScriptProcessor callbacks.
  private readonly frameSamples: number;
  private pendingMic: Int16Array = new Int16Array(0);

  constructor(
    private readonly handlers: AudioPipelineHandlers = {},
    rates: Partial<AudioRates> = {},
  ) {
    this.inputRate = rates.inputRate ?? MIC_RATE;
    this.outputRate = rates.outputRate ?? AGENT_RATE;
    this.frameSamples = Math.max(1, Math.round(this.inputRate * 0.02));
  }

  /** Append newly-downsampled samples and flush every complete 20 ms frame. */
  private pushMicSamples(chunk: Int16Array): void {
    let merged: Int16Array;
    if (this.pendingMic.length === 0) {
      merged = chunk;
    } else {
      merged = new Int16Array(this.pendingMic.length + chunk.length);
      merged.set(this.pendingMic, 0);
      merged.set(chunk, this.pendingMic.length);
    }
    let offset = 0;
    while (merged.length - offset >= this.frameSamples) {
      const frame = merged.slice(offset, offset + this.frameSamples);
      this.handlers.onMicChunk?.(frame.buffer);
      offset += this.frameSamples;
    }
    this.pendingMic = offset < merged.length ? merged.slice(offset) : new Int16Array(0);
  }

  // ── mic capture ───────────────────────────────────────────────────────────
  async startMic(): Promise<void> {
    if (this.micCtx) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });
    this.micStream = stream;
    const ctx = new AudioContext();
    this.micCtx = ctx;
    if (ctx.state === 'suspended') await ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    this.micSource = source;

    if (ctx.audioWorklet) {
      try {
        this.workletUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
        await ctx.audioWorklet.addModule(this.workletUrl);
        const node = new AudioWorkletNode(ctx, 'mic-downsampler', {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          processorOptions: { targetRate: this.inputRate },
        });
        node.port.onmessage = (e) => {
          const d = e.data as { pcm?: ArrayBuffer; rms?: number };
          if (d.pcm) this.pushMicSamples(new Int16Array(d.pcm));
          if (typeof d.rms === 'number') this.handlers.onMicLevel?.(Math.min(1, d.rms * 4));
        };
        source.connect(node);
        this.micNode = node;
        return;
      } catch {
        /* fall through to ScriptProcessor */
      }
    }
    this.startMicScriptProcessor(ctx, source);
  }

  // Legacy fallback: ScriptProcessorNode (deprecated but universal).
  private startMicScriptProcessor(ctx: AudioContext, source: MediaStreamAudioSourceNode): void {
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const ratio = ctx.sampleRate / this.inputRate;
    node.onaudioprocess = (ev) => {
      if (this.muted) return;
      const input = ev.inputBuffer.getChannelData(0);
      const outLen = Math.floor(input.length / ratio);
      const out = new Int16Array(outLen);
      let sumSq = 0;
      let idx = 0;
      for (let i = 0; i < outLen; i++) {
        const i0 = Math.floor(idx);
        let s = input[i0] || 0;
        if (s > 1) s = 1; else if (s < -1) s = -1;
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        sumSq += s * s;
        idx += ratio;
      }
      this.pushMicSamples(out);
      this.handlers.onMicLevel?.(Math.min(1, Math.sqrt(sumSq / Math.max(1, outLen)) * 4));
    };
    source.connect(node);
    // ScriptProcessor only fires while connected to a destination.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink);
    sink.connect(ctx.destination);
    this.micNode = node;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    // Stop sending: gate the mic track AND tell the worklet to skip frames.
    this.micStream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    const n = this.micNode;
    if (n && 'port' in n) (n as AudioWorkletNode).port.postMessage({ muted });
  }

  // ── agent playback ─────────────────────────────────────────────────────────
  private ensureOut(): AudioContext {
    if (!this.outCtx) {
      // Match the agent's output rate so no resampling artifacts on playback.
      this.outCtx = new AudioContext({ sampleRate: this.outputRate });
      this.playHead = this.outCtx.currentTime;
    }
    return this.outCtx;
  }

  async resumeOutput(): Promise<void> {
    const ctx = this.ensureOut();
    if (ctx.state === 'suspended') await ctx.resume();
  }

  /** Remaining scheduled playback, in ms — the queue R2 §3.1 caps at 500 ms. */
  queuedMs(): number {
    const ctx = this.outCtx;
    if (!ctx) return 0;
    return Math.max(0, (this.playHead - ctx.currentTime) * 1000);
  }

  /** Queue a PCM16 chunk (at `outputRate`) from the agent for gapless playback.
   *  Drops the chunk instead of growing the queue past the R2 §3.1 500 ms
   *  ceiling — the caller decides what a sustained overrun means (a stalled
   *  connection is not this pipeline's call to make). */
  playChunk(pcm16: ArrayBuffer): boolean {
    const ctx = this.ensureOut();
    const view = new Int16Array(pcm16);
    if (view.length === 0) return true;
    if (this.queuedMs() / 1000 >= QUEUE_CEILING_SEC) return false;
    const buf = ctx.createBuffer(1, view.length, this.outputRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < view.length; i++) ch[i] = view[i] / (view[i] < 0 ? 0x8000 : 0x7fff);

    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(ctx.destination);

    const now = ctx.currentTime;
    if (this.playHead < now + JITTER_LEAD_SEC) this.playHead = now + JITTER_LEAD_SEC;
    node.start(this.playHead);
    this.playHead += buf.duration;

    this.scheduled++;
    this.scheduledNodes.add(node);
    if (!this.speaking) {
      this.speaking = true;
      this.handlers.onAgentSpeaking?.(true);
    }
    node.onended = () => {
      this.scheduledNodes.delete(node);
      this.scheduled = Math.max(0, this.scheduled - 1);
      if (this.scheduled === 0 && this.speaking) {
        this.speaking = false;
        this.handlers.onAgentSpeaking?.(false);
      }
    };
    return true;
  }

  /** Drop everything queued — used on a barge-in / interrupt / `playback_clear`.
   *  R2 §3.1: stop the scheduled nodes directly rather than rebuilding the
   *  whole AudioContext, so the very next chunk can be scheduled immediately. */
  clearPlayback(): void {
    const ctx = this.outCtx;
    for (const node of this.scheduledNodes) {
      try {
        node.onended = null;
        node.stop();
        node.disconnect();
      } catch {
        /* already stopped/ended */
      }
    }
    this.scheduledNodes.clear();
    this.scheduled = 0;
    if (ctx) this.playHead = ctx.currentTime;
    if (this.speaking) {
      this.speaking = false;
      this.handlers.onAgentSpeaking?.(false);
    }
  }

  async dispose(): Promise<void> {
    try {
      this.micNode?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      this.micSource?.disconnect();
    } catch {
      /* ignore */
    }
    this.micStream?.getTracks().forEach((t) => t.stop());
    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl);
      this.workletUrl = null;
    }
    try {
      await this.micCtx?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.outCtx?.close();
    } catch {
      /* ignore */
    }
    this.micCtx = null;
    this.outCtx = null;
    this.micNode = null;
    this.micSource = null;
    this.micStream = null;
  }
}
