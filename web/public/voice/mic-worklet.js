/* [AUMFE-VOICE-WEB-1] Microphone capture worklet.
 * Takes whatever rate the browser runs at (usually 48 kHz), averages down to 16 kHz mono and posts
 * PCM16 little-endian frames of 640 samples (40 ms) to the main thread: { pcm: ArrayBuffer }.
 * Also posts { level } (0..1 RMS) about every 50 ms for the "listening" visual. */
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.acc = 0;
    this.cnt = 0;
    this.frame = new Int16Array(640);
    this.n = 0;
    this.lvlAcc = 0;
    this.lvlN = 0;
    this.sinceLvl = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = ch[i];
      this.acc += s;
      this.cnt += 1;
      this.lvlAcc += s * s;
      this.lvlN += 1;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        let v = this.acc / this.cnt;
        this.acc = 0;
        this.cnt = 0;
        if (v > 1) v = 1; else if (v < -1) v = -1;
        this.frame[this.n++] = Math.round(v < 0 ? v * 32768 : v * 32767);
        if (this.n === this.frame.length) {
          const buf = this.frame.buffer.slice(0);
          this.port.postMessage({ pcm: buf }, [buf]);
          this.n = 0;
        }
      }
    }
    this.sinceLvl += ch.length;
    if (this.sinceLvl >= sampleRate * 0.05) {
      this.port.postMessage({ level: Math.sqrt(this.lvlAcc / Math.max(1, this.lvlN)) });
      this.lvlAcc = 0;
      this.lvlN = 0;
      this.sinceLvl = 0;
    }
    return true;
  }
}

registerProcessor('aumfe-mic', MicProcessor);
