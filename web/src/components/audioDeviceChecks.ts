export function rmsLevel(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const centered = (samples[i] - 128) / 128;
    sum += centered * centered;
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * 3.5);
}

export interface SpeakerState {
  playing: boolean;
  tested: boolean;
  error: string | null;
}

/** User-triggered local tone with ownership guards for delayed browser resumes. */
export class SpeakerTone {
  private context: AudioContext | null = null;
  private oscillator: OscillatorNode | null = null;
  private gain: GainNode | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private closed = false;
  private active = false;
  private readonly createContext: () => AudioContext;
  private readonly update: (state: SpeakerState) => void;
  private readonly event: (result: string) => void;
  constructor(
    createContext: () => AudioContext,
    update: (state: SpeakerState) => void,
    event: (result: string) => void = () => {},
  ) {
    this.createContext = createContext;
    this.update = update;
    this.event = (result) => { try { event(result); } catch { /* diagnostics cannot block playback */ } };
  }

  start(): void {
    if (this.closed || this.active) return;
    const generation = ++this.generation;
    this.active = true;
    this.update({ playing: true, tested: false, error: null });
    this.event('started');
    try {
      // resume is invoked synchronously by the click, retaining user activation.
      const context = this.context = this.createContext();
      void context.resume().then(() => {
        if (this.closed || generation !== this.generation) return;
        if (context.state !== 'running') throw new Error('suspended');
        const oscillator = this.oscillator = context.createOscillator();
        const gain = this.gain = context.createGain();
        oscillator.frequency.value = 660;
        gain.gain.setValueAtTime(0.0001, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.55);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start();
        this.timer = setTimeout(() => this.stop(), 650);
      }).catch(() => this.fail(generation));
    } catch { this.fail(generation); }
  }

  private cleanup(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    try { this.oscillator?.stop(); } catch { /* not started or stopped */ }
    try { this.oscillator?.disconnect(); } catch { /* released */ }
    try { this.gain?.disconnect(); } catch { /* released */ }
    this.oscillator = null;
    this.gain = null;
    const context = this.context;
    this.context = null;
    if (context) { try { void context.close().catch(() => {}); } catch { /* released */ } }
  }

  private fail(generation: number): void {
    if (this.closed || generation !== this.generation) return;
    ++this.generation;
    this.active = false;
    this.cleanup();
    this.update({ playing: false, tested: false, error: 'Could not play the test sound. Check browser audio permissions and try again.' });
    this.event('failed');
  }

  stop(): void {
    const wasActive = this.active;
    ++this.generation;
    this.active = false;
    this.cleanup();
    if (!this.closed && wasActive) {
      this.update({ playing: false, tested: true, error: null });
      this.event('stopped');
    }
  }

  dispose(): void {
    this.closed = true;
    this.stop();
  }
}
