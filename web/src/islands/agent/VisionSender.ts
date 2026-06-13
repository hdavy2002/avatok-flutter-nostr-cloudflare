// VisionSender — vision agents only.
//
// When the session model is the vision model (gemini-3.1-flash-live-preview,
// vision_enabled=true), the browser additionally sends low-FPS frames from the
// camera OR a screen share. Frames are drawn to an offscreen canvas, exported
// as JPEG, and handed to GeminiLiveClient.sendVideoFrame.
//
// CONTRACT NOTE: the Flutter app has NOT yet shipped its vision frame format
// (call_screen.dart stubs it as "Phase 4"). We therefore mirror Gemini Live's
// documented realtimeInput.video shape (JPEG @ ~1 fps). Phase Z / the app team
// should reconcile if the app later picks a different cadence/codec.

const DEFAULT_FPS = 1; // low FPS keeps latency + token cost down
const MAX_EDGE = 768; // downscale long edge for bandwidth

export type VisionSource = 'camera' | 'screen';

export class VisionSender {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private timer: number | null = null;
  private running = false;

  constructor(
    private readonly onFrame: (jpeg: ArrayBuffer) => void,
    private readonly fps: number = DEFAULT_FPS,
  ) {}

  get active(): boolean {
    return this.running;
  }

  get source(): VisionSource | null {
    return this.stream ? (this.currentSource ?? null) : null;
  }
  private currentSource: VisionSource | null = null;

  async start(source: VisionSource): Promise<void> {
    await this.stop();
    const md = navigator.mediaDevices;
    this.stream =
      source === 'screen'
        ? await md.getDisplayMedia({ video: { frameRate: this.fps }, audio: false })
        : await md.getUserMedia({ video: { facingMode: 'user', frameRate: this.fps }, audio: false });
    this.currentSource = source;

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = this.stream;
    await video.play().catch(() => undefined);
    this.video = video;
    this.canvas = document.createElement('canvas');

    // If the user stops the share from the browser chrome, tear down cleanly.
    this.stream.getVideoTracks().forEach((t) => (t.onended = () => void this.stop()));

    this.running = true;
    const intervalMs = Math.max(200, Math.round(1000 / this.fps));
    this.timer = window.setInterval(() => this.capture(), intervalMs);
    // Grab one frame immediately so the agent "sees" right away.
    this.capture();
  }

  private capture(): void {
    const video = this.video;
    const canvas = this.canvas;
    if (!video || !canvas || video.videoWidth === 0) return;
    const scale = Math.min(1, MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.max(1, Math.round(video.videoWidth * scale));
    const h = Math.max(1, Math.round(video.videoHeight * scale));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        blob.arrayBuffer().then((buf) => this.onFrame(buf)).catch(() => undefined);
      },
      'image/jpeg',
      0.6,
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.currentSource = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    this.canvas = null;
  }
}
