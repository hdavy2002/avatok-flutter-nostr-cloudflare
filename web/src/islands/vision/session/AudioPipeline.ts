// AudioPipeline — Web Audio plumbing for the AvaVision live session.
//
// MIRRORED from web-client Phase E (islands/agent/AudioPipeline.ts) per MASTER
// rule 4 ("mirror, don't share") — copied into the vision feature rather than
// cross-imported, exactly as the app phases mirror AvaVoice.
//
// IN  (mic → agent): getUserMedia({audio}) with AEC/NS/AGC on, captured via an
//   AudioWorklet that downsamples the device rate to 16 kHz mono PCM16 and posts
//   chunks to the main thread. Falls back to ScriptProcessorNode where the
//   AudioWorklet is unavailable.
// OUT (agent → speaker): 24 kHz mono PCM16 chunks scheduled back-to-back on a
//   dedicated 24 kHz AudioContext with a small jitter buffer for gapless audio.

const MIC_RATE = 16000;
const AGENT_RATE = 24000;
const JITTER_LEAD_SEC = 0.12;

const WORKLET_SRC = `
class MicDownsampler extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.targetRate = (opts.processorOptions && opts.processorOptions.targetRate) || 16000;
    this.ratio = sampleRate / this.targetRate;
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
      let s = s0 + (s1 - s0) * frac;
      if (s > 1) s = 1; else if (s < -1) s = -1;
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      sumSq += s * s;
      idx += this.ratio;
    }
    this.pos = idx - ch.length;
    if (this.pos < 0) this.pos = 0;
    const rms = Math.sqrt(sumSq / outLen);
    this.port.postMessage({ pcm: out.buffer, rms }, [out.buffer]);
    return true;
  }
}
registerProcessor('mic-downsampler', MicDownsampler);
`;

export interface AudioPipelineHandlers {
  onMicChunk?: (pcm16: ArrayBuffer) => void;
  onMicLevel?: (level: number) => void;
  onAgentSpeaking?: (speaking: boolean) => void;
}

export class AudioPipeline {
  private micCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private micNode: AudioWorkletNode | ScriptProcessorNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;

  private outCtx: AudioContext | null = null;
  private playHead = 0;
  private scheduled = 0;
  private speaking = false;
  private muted = false;
  private workletUrl: string | null = null;

  constructor(private readonly handlers: AudioPipelineHandlers = {}) {}

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
          processorOptions: { targetRate: MIC_RATE },
        });
        node.port.onmessage = (e) => {
          const d = e.data as { pcm?: ArrayBuffer; rms?: number };
          if (d.pcm) this.handlers.onMicChunk?.(d.pcm);
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

  private startMicScriptProcessor(ctx: AudioContext, source: MediaStreamAudioSourceNode): void {
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const ratio = ctx.sampleRate / MIC_RATE;
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
      this.handlers.onMicChunk?.(out.buffer);
      this.handlers.onMicLevel?.(Math.min(1, Math.sqrt(sumSq / Math.max(1, outLen)) * 4));
    };
    source.connect(node);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink);
    sink.connect(ctx.destination);
    this.micNode = node;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.micStream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    const n = this.micNode;
    if (n && 'port' in n) (n as AudioWorkletNode).port.postMessage({ muted });
  }

  private ensureOut(): AudioContext {
    if (!this.outCtx) {
      this.outCtx = new AudioContext({ sampleRate: AGENT_RATE });
      this.playHead = this.outCtx.currentTime;
    }
    return this.outCtx;
  }

  async resumeOutput(): Promise<void> {
    const ctx = this.ensureOut();
    if (ctx.state === 'suspended') await ctx.resume();
  }

  playChunk(pcm16: ArrayBuffer): void {
    const ctx = this.ensureOut();
    const view = new Int16Array(pcm16);
    if (view.length === 0) return;
    const buf = ctx.createBuffer(1, view.length, AGENT_RATE);
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
    if (!this.speaking) {
      this.speaking = true;
      this.handlers.onAgentSpeaking?.(true);
    }
    node.onended = () => {
      this.scheduled = Math.max(0, this.scheduled - 1);
      if (this.scheduled === 0 && this.speaking) {
        this.speaking = false;
        this.handlers.onAgentSpeaking?.(false);
      }
    };
  }

  clearPlayback(): void {
    const ctx = this.outCtx;
    if (!ctx) return;
    try {
      void ctx.close();
    } catch {
      /* ignore */
    }
    this.outCtx = null;
    this.scheduled = 0;
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
