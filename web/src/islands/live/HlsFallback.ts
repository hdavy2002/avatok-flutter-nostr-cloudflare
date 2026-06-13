// LL-HLS fallback — only used when WHEP can't run (no WebRTC, Safari quirks,
// negotiation/connection error). PHASE-C §4 / §8: `hls.js` is the ONLY allowed
// media dependency, and it is loaded LAZILY via dynamic import() so the WHEP
// happy path never ships it.
//
// Safari (and iOS) play HLS natively, so there we just set `video.src` and skip
// hls.js entirely. Everywhere else we dynamic-import hls.js on demand.

export type HlsStatus = 'idle' | 'connecting' | 'playing' | 'failed' | 'closed';

export interface HlsFallbackOptions {
  /** LL-HLS URL from /api/live/:id/join → `hls`. */
  url: string;
  video: HTMLVideoElement;
  onStatus?: (status: HlsStatus, detail?: string) => void;
}

export class HlsFallback {
  // Loosely typed: hls.js Hls instance (the lib is dynamically imported).
  private hls: { destroy: () => void } | null = null;
  private nativeVideo: HTMLVideoElement | null = null;
  private closed = false;
  private readonly opts: HlsFallbackOptions;

  constructor(options: HlsFallbackOptions) {
    this.opts = options;
  }

  private emit(s: HlsStatus, detail?: string): void {
    this.opts.onStatus?.(s, detail);
  }

  async start(): Promise<void> {
    this.emit('connecting');
    const { url, video } = this.opts;

    // Native HLS (Safari / iOS): cheapest path, no JS bundle.
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      this.nativeVideo = video;
      const onPlaying = () => !this.closed && this.emit('playing');
      const onError = () => !this.closed && this.emit('failed', 'native hls error');
      video.addEventListener('playing', onPlaying, { once: true });
      video.addEventListener('error', onError, { once: true });
      video.src = url;
      try {
        await video.play();
      } catch {
        /* autoplay policy — UI offers an unmute/play tap */
      }
      return;
    }

    // Everywhere else: lazy-load hls.js (low-latency mode).
    const mod = await import('hls.js');
    const Hls = (mod as { default: any }).default;
    if (this.closed) return;
    if (!Hls?.isSupported?.()) {
      this.emit('failed', 'hls.js unsupported');
      throw new Error('hls.js not supported in this browser');
    }

    const hls = new Hls({
      lowLatencyMode: true,
      backBufferLength: 8,
      liveSyncDuration: 2,
      liveMaxLatencyDuration: 6,
      enableWorker: true,
    });
    this.hls = hls;

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (this.closed) return;
      video.play().catch(() => {/* autoplay policy */});
    });
    hls.on(Hls.Events.FRAG_BUFFERED, () => !this.closed && this.emit('playing'));
    hls.on(Hls.Events.ERROR, (_evt: unknown, data: any) => {
      if (this.closed || !data?.fatal) return;
      // Try the documented fatal-error recovery before giving up.
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else this.emit('failed', String(data?.details ?? 'hls fatal'));
    });

    hls.loadSource(url);
    hls.attachMedia(video);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('closed');
    try {
      this.hls?.destroy();
    } catch {
      /* ignore */
    }
    this.hls = null;
    if (this.nativeVideo) {
      try {
        this.nativeVideo.removeAttribute('src');
        this.nativeVideo.load();
      } catch {
        /* ignore */
      }
      this.nativeVideo = null;
    }
  }
}

export default HlsFallback;
