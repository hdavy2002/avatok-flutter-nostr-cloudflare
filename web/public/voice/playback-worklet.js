/* [AUMFE-VOICE-WEB-1] Playback worklet for the guide's voice.
 * Receives { pcm: ArrayBuffer } (PCM16 LE mono 24 kHz), queues it, and plays it with a small
 * jitter buffer. { flush: true } drops everything queued at once (the customer spoke over her).
 * Posts { level } (0..1 RMS, smoothed) about every 50 ms and { idle: boolean } when playback
 * starts or runs dry. */
const SRC_RATE = 24000;
const PREBUFFER_SEC = 0.06;

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.head = 0;
    this.buffered = 0;
    this.playing = false;
    this.lvl = 0;
    this.sinceLvl = 0;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.flush) {
        this.queue = [];
        this.head = 0;
        this.buffered = 0;
        this.playing = false;
        this.port.postMessage({ idle: true });
        return;
      }
      if (d.pcm) this.enqueue(new Int16Array(d.pcm));
    };
  }

  enqueue(pcm) {
    let f = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
    if (sampleRate !== SRC_RATE) {
      const step = SRC_RATE / sampleRate;
      const outLen = Math.floor(f.length / step);
      const out = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const p = i * step;
        const i0 = Math.floor(p);
        const frac = p - i0;
        const a = f[i0];
        const b = i0 + 1 < f.length ? f[i0 + 1] : a;
        out[i] = a + (b - a) * frac;
      }
      f = out;
    }
    this.queue.push(f);
    this.buffered += f.length;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const need = out.length;
    if (!this.playing && this.buffered >= PREBUFFER_SEC * sampleRate) {
      this.playing = true;
      this.port.postMessage({ idle: false });
    }
    let w = 0;
    if (this.playing) {
      while (w < need && this.queue.length) {
        const cur = this.queue[0];
        const take = Math.min(need - w, cur.length - this.head);
        for (let i = 0; i < take; i++) out[w + i] = cur[this.head + i];
        w += take;
        this.head += take;
        this.buffered -= take;
        if (this.head >= cur.length) {
          this.queue.shift();
          this.head = 0;
        }
      }
      if (!this.queue.length && w < need) {
        this.playing = false;
        this.port.postMessage({ idle: true });
      }
    }
    let sum = 0;
    for (let i = 0; i < need; i++) {
      if (i >= w) out[i] = 0;
      sum += out[i] * out[i];
    }
    const rms = Math.sqrt(sum / need);
    this.lvl = this.lvl * 0.7 + rms * 0.3;
    this.sinceLvl += need;
    if (this.sinceLvl >= sampleRate * 0.05) {
      this.port.postMessage({ level: this.lvl });
      this.sinceLvl = 0;
    }
    return true;
  }
}

registerProcessor('aumfe-playback', PlaybackProcessor);
