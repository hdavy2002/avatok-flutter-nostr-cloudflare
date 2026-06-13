// visionEngineWeb — the FREE, on-device web vision engine for AvaVision.
//
// One module, two consumers:
//   • Phase 5 SessionRoom — full session (overlay + score + frame grabbers).
//   • Phase 4 studio preview — uses start()/stop() + the overlay only.
//
// Engine policy is LOCKED (MASTER §7): free + on-device only.
//   pose            → MoveNet via TF.js (default, 17 kpts); template may upgrade
//                     to MediaPipe Pose (33 pts) on web.
//   hand|gesture|face_landmark|face_detect|object|image_class|segmentation|holistic
//                   → MediaPipe Tasks (Vision).
//   gemini_only     → no on-device model (Live + snapshot only).
// Everything runs in the browser, free, ~30 fps, and is NEVER streamed. The only
// cloud paths are the 1-fps Gemini Live frames (grabLowResFrame) and the on-demand
// snapshot (grabHiResFrame) — both owned by SessionRoom, not this engine.
//
// §7 DEVIATION (documented in PHASE-5-GLUE.md): the web-client house rule allows
// "no heavy media SDK beyond hls.js". AvaVision adds MediaPipe Tasks Vision + TF.js
// MoveNet as a deliberate, product-intrinsic exception. They are LAZY-LOADED from a
// pinned CDN only when an engine actually starts, so non-vision pages and the rest
// of the bundle are completely unaffected (nothing is imported at module scope).
//
// Pinned versions (keep in sync with PHASE-5-GLUE.md):
//   @mediapipe/tasks-vision      0.10.18
//   @tensorflow/tfjs-core        4.22.0
//   @tensorflow/tfjs-backend-webgl 4.22.0
//   @tensorflow/tfjs-converter   4.22.0  (peer of pose-detection)
//   @tensorflow-models/pose-detection 2.1.3

import type { Capability, OverlayStyle, ScoringMode, VisionEngine } from './avavisionApi';

// ── pinned CDN endpoints ──────────────────────────────────────────────────────
const MP_VER = '0.10.18';
const TF_VER = '4.22.0';
const POSE_DET_VER = '2.1.3';
const CDN = {
  mpTasks: `https://esm.sh/@mediapipe/tasks-vision@${MP_VER}`,
  mpWasm: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/wasm`,
  tfCore: `https://esm.sh/@tensorflow/tfjs-core@${TF_VER}`,
  tfWebgl: `https://esm.sh/@tensorflow/tfjs-backend-webgl@${TF_VER}`,
  poseDet: `https://esm.sh/@tensorflow-models/pose-detection@${POSE_DET_VER}?deps=@tensorflow/tfjs-core@${TF_VER},@tensorflow/tfjs-converter@${TF_VER}`,
};
// Curated free model assets (Google-hosted).
const MODEL = {
  pose: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  hand: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  faceDetect:
    'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.task',
  gesture:
    'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task',
  object:
    'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite',
  imageClass:
    'https://storage.googleapis.com/mediapipe-models/image_classifier/efficientnet_lite0/float32/1/efficientnet_lite0.tflite',
  segmentation:
    'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
};

// zine accent palette (hard, never blurred). Mirrors tokens.css.
const COLOR = { lime: '#BFEB56', coral: '#FE674C', blueInk: '#007D7F', ink: '#231B14', lilac: '#CDAEF2' };

/** Variable-URL dynamic import so Vite/TS treat the CDN module as external `any`. */
async function cdnImport(url: string): Promise<any> {
  return import(/* @vite-ignore */ url);
}

export interface VisionEngineConfig {
  capability: Capability;
  engine: VisionEngine;
  overlayStyle: OverlayStyle;
  scoringMode: ScoringMode;
  scoreLabel?: string;
  /** Front camera is mirrored in the UI; mirror the overlay to match. Default true. */
  mirrored?: boolean;
}

type ScoreCb = (score: number | null, hint?: string) => void;

const LOWRES_EDGE = 640; // ~640px long edge for the 1-fps Live frame
const SCORE_EVERY_MS = 700; // throttle score callbacks so we don't spam Live cues

export class VisionEngineWeb {
  private cfg: VisionEngineConfig;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private stream: MediaStream | null = null;
  private raf = 0;
  private running = false;
  private scoreCb: ScoreCb | null = null;
  private lastScoreAt = 0;
  private lastScore: number | null = null;

  // lazily-loaded model handles (typed `any` — external CDN modules)
  private mp: any = null; // MediaPipe task instance
  private mpDraw: any = null; // MediaPipe DrawingUtils
  private mpVision: any = null; // the tasks-vision module (for connection consts)
  private moveNet: any = null; // TF.js pose detector
  private offscreen: HTMLCanvasElement | null = null; // for frame grabs

  constructor(cfg: VisionEngineConfig) {
    this.cfg = { mirrored: true, ...cfg };
  }

  get isRunning(): boolean {
    return this.running;
  }

  onScore(cb: ScoreCb): void {
    this.scoreCb = cb;
  }

  /** Start the camera, load the right model, and begin the overlay loop. */
  async start(videoEl: HTMLVideoElement, canvasEl: HTMLCanvasElement): Promise<void> {
    if (this.running) return;
    this.video = videoEl;
    this.canvas = canvasEl;

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    videoEl.srcObject = this.stream;
    videoEl.muted = true;
    videoEl.playsInline = true;
    await videoEl.play().catch(() => undefined);

    if (this.cfg.capability !== 'gemini_only') {
      try {
        await this.loadModel();
      } catch (e) {
        // Model load failure is non-fatal: the Live coach + snapshot still work,
        // we just run without the on-device overlay/score.
        // eslint-disable-next-line no-console
        console.warn('[avavision] on-device model load failed; continuing without overlay', e);
        this.mp = null;
        this.moveNet = null;
      }
    }

    this.running = true;
    this.loop();
  }

  private async loadModel(): Promise<void> {
    if (this.cfg.engine === 'movenet' && this.cfg.capability === 'pose') {
      await this.loadMoveNet();
      return;
    }
    await this.loadMediaPipe();
  }

  private async loadMoveNet(): Promise<void> {
    const tf = await cdnImport(CDN.tfCore);
    await cdnImport(CDN.tfWebgl);
    await tf.setBackend('webgl');
    await tf.ready();
    const pd = await cdnImport(CDN.poseDet);
    this.moveNet = await pd.createDetector(pd.SupportedModels.MoveNet, {
      modelType: pd.movenet.modelType.SINGLEPOSE_LIGHTNING,
      enableSmoothing: true,
    });
  }

  private async loadMediaPipe(): Promise<void> {
    const vision = await cdnImport(CDN.mpTasks);
    this.mpVision = vision;
    const fileset = await vision.FilesetResolver.forVisionTasks(CDN.mpWasm);
    const cap = this.cfg.capability;
    const opts = (modelAssetPath: string, extra: Record<string, unknown> = {}) => ({
      baseOptions: { modelAssetPath, delegate: 'GPU' },
      runningMode: 'VIDEO',
      ...extra,
    });

    if (cap === 'pose' || cap === 'holistic') {
      this.mp = await vision.PoseLandmarker.createFromOptions(fileset, opts(MODEL.pose, { numPoses: 1 }));
    } else if (cap === 'hand') {
      this.mp = await vision.HandLandmarker.createFromOptions(fileset, opts(MODEL.hand, { numHands: 2 }));
    } else if (cap === 'gesture') {
      this.mp = await vision.GestureRecognizer.createFromOptions(fileset, opts(MODEL.gesture, { numHands: 2 }));
    } else if (cap === 'face_landmark') {
      this.mp = await vision.FaceLandmarker.createFromOptions(fileset, opts(MODEL.face, { numFaces: 1 }));
    } else if (cap === 'face_detect') {
      this.mp = await vision.FaceDetector.createFromOptions(fileset, opts(MODEL.faceDetect));
    } else if (cap === 'object') {
      this.mp = await vision.ObjectDetector.createFromOptions(fileset, opts(MODEL.object, { scoreThreshold: 0.4 }));
    } else if (cap === 'image_class') {
      this.mp = await vision.ImageClassifier.createFromOptions(fileset, opts(MODEL.imageClass, { maxResults: 3 }));
    } else if (cap === 'segmentation') {
      this.mp = await vision.ImageSegmenter.createFromOptions(
        fileset,
        opts(MODEL.segmentation, { outputCategoryMask: true, outputConfidenceMasks: false }),
      );
    }
    if (this.mp && this.canvas) {
      const ctx = this.canvas.getContext('2d');
      if (ctx) this.mpDraw = new vision.DrawingUtils(ctx);
    }
  }

  // ── the per-frame loop ───────────────────────────────────────────────────────
  private loop = (): void => {
    if (!this.running) return;
    const v = this.video;
    const c = this.canvas;
    if (v && c && v.videoWidth > 0) {
      if (c.width !== v.videoWidth) c.width = v.videoWidth;
      if (c.height !== v.videoHeight) c.height = v.videoHeight;
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.save();
        ctx.clearRect(0, 0, c.width, c.height);
        if (this.cfg.mirrored) {
          ctx.translate(c.width, 0);
          ctx.scale(-1, 1);
        }
        try {
          this.detectAndDraw(ctx, v);
        } catch {
          /* skip a bad frame */
        }
        ctx.restore();
      }
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private detectAndDraw(ctx: CanvasRenderingContext2D, v: HTMLVideoElement): void {
    const now = performance.now();
    const cap = this.cfg.capability;

    if (this.moveNet) {
      // Async detector — fire and draw on resolve (kept simple; ~30fps best effort).
      void this.moveNet.estimatePoses(v, { flipHorizontal: false }).then((poses: any[]) => {
        if (!this.running) return;
        const c = this.canvas;
        if (!c) return;
        const ctx2 = c.getContext('2d');
        if (!ctx2) return;
        ctx2.save();
        ctx2.clearRect(0, 0, c.width, c.height);
        if (this.cfg.mirrored) {
          ctx2.translate(c.width, 0);
          ctx2.scale(-1, 1);
        }
        const kpts = poses?.[0]?.keypoints ?? [];
        this.drawMoveNet(ctx2, kpts);
        ctx2.restore();
        this.maybeScore(this.scoreFromMoveNet(kpts));
      });
      return;
    }

    if (!this.mp) return;
    const res = this.mp.detectForVideo(v, now);

    if (cap === 'pose' || cap === 'holistic') {
      const lms = res.landmarks ?? [];
      for (const set of lms) {
        this.mpDraw?.drawConnectors(set, this.mpVision.PoseLandmarker.POSE_CONNECTIONS, { color: COLOR.blueInk, lineWidth: 4 });
        this.mpDraw?.drawLandmarks(set, { color: COLOR.lime, fillColor: COLOR.coral, radius: 4, lineWidth: 2 });
      }
      this.maybeScore(this.scoreFromVisibility(lms[0]));
    } else if (cap === 'hand') {
      const lms = res.landmarks ?? [];
      for (const set of lms) {
        this.mpDraw?.drawConnectors(set, this.mpVision.HandLandmarker.HAND_CONNECTIONS, { color: COLOR.blueInk, lineWidth: 4 });
        this.mpDraw?.drawLandmarks(set, { color: COLOR.lime, fillColor: COLOR.coral, radius: 4 });
      }
      this.maybeScore(this.scoreFromVisibility(lms[0]));
    } else if (cap === 'gesture') {
      const lms = res.landmarks ?? [];
      for (const set of lms) {
        this.mpDraw?.drawConnectors(set, this.mpVision.GestureRecognizer.HAND_CONNECTIONS, { color: COLOR.blueInk, lineWidth: 4 });
        this.mpDraw?.drawLandmarks(set, { color: COLOR.lime, fillColor: COLOR.coral, radius: 4 });
      }
      const g = res.gestures?.[0]?.[0];
      this.maybeScore(g ? Math.round((g.score ?? 0) * 100) : null, g?.categoryName);
    } else if (cap === 'face_landmark') {
      const lms = res.faceLandmarks ?? [];
      for (const set of lms) {
        const C = this.mpVision.FaceLandmarker;
        this.mpDraw?.drawConnectors(set, C.FACE_LANDMARKS_TESSELATION, { color: 'rgba(0,125,127,0.35)', lineWidth: 1 });
        this.mpDraw?.drawConnectors(set, C.FACE_LANDMARKS_FACE_OVAL, { color: COLOR.coral, lineWidth: 3 });
      }
      this.maybeScore(lms.length ? this.scoreFromVisibility(lms[0]) : null);
    } else if (cap === 'face_detect') {
      this.drawBoxes(ctx, (res.detections ?? []).map((d: any) => d.boundingBox), v);
      this.maybeScore(res.detections?.length ? 100 : null);
    } else if (cap === 'object') {
      const dets = res.detections ?? [];
      this.drawBoxes(
        ctx,
        dets.map((d: any) => d.boundingBox),
        v,
        dets.map((d: any) => `${d.categories?.[0]?.categoryName ?? ''} ${Math.round((d.categories?.[0]?.score ?? 0) * 100)}%`),
      );
      this.maybeScore(dets.length ? Math.round((dets[0].categories?.[0]?.score ?? 0) * 100) : null, dets[0]?.categories?.[0]?.categoryName);
    } else if (cap === 'image_class') {
      const top = res.classifications?.[0]?.categories?.[0];
      this.maybeScore(top ? Math.round((top.score ?? 0) * 100) : null, top?.categoryName);
    } else if (cap === 'segmentation') {
      this.drawSegmentation(ctx, res, v);
      this.maybeScore(null);
    }
  }

  // ── overlay drawing ───────────────────────────────────────────────────────────
  private drawMoveNet(ctx: CanvasRenderingContext2D, kpts: any[]): void {
    if (!kpts.length || !this.canvas) return;
    const ADJ = [
      [0, 1], [0, 2], [1, 3], [2, 4], [5, 6], [5, 7], [7, 9], [6, 8], [8, 10],
      [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
    ];
    ctx.lineWidth = 4;
    ctx.strokeStyle = COLOR.blueInk;
    for (const [a, b] of ADJ) {
      const p = kpts[a];
      const q = kpts[b];
      if ((p?.score ?? 0) < 0.3 || (q?.score ?? 0) < 0.3) continue;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
    }
    for (const k of kpts) {
      if ((k?.score ?? 0) < 0.3) continue;
      ctx.beginPath();
      ctx.arc(k.x, k.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = COLOR.coral;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = COLOR.lime;
      ctx.stroke();
    }
  }

  private drawBoxes(ctx: CanvasRenderingContext2D, boxes: any[], v: HTMLVideoElement, labels?: string[]): void {
    ctx.lineWidth = 4;
    ctx.strokeStyle = COLOR.coral;
    ctx.font = '600 18px sans-serif';
    boxes.forEach((b, i) => {
      if (!b) return;
      ctx.strokeRect(b.originX, b.originY, b.width, b.height);
      const label = labels?.[i];
      if (label) {
        ctx.save();
        // labels must read left-to-right even when the canvas is mirrored
        if (this.cfg.mirrored) {
          ctx.translate(v.videoWidth, 0);
          ctx.scale(-1, 1);
          const mx = v.videoWidth - b.originX - b.width;
          ctx.fillStyle = COLOR.ink;
          ctx.fillRect(mx, Math.max(0, b.originY - 22), ctx.measureText(label).width + 10, 22);
          ctx.fillStyle = COLOR.lime;
          ctx.fillText(label, mx + 5, Math.max(14, b.originY - 6));
        } else {
          ctx.fillStyle = COLOR.ink;
          ctx.fillRect(b.originX, Math.max(0, b.originY - 22), ctx.measureText(label).width + 10, 22);
          ctx.fillStyle = COLOR.lime;
          ctx.fillText(label, b.originX + 5, Math.max(14, b.originY - 6));
        }
        ctx.restore();
      }
    });
  }

  private drawSegmentation(ctx: CanvasRenderingContext2D, res: any, v: HTMLVideoElement): void {
    const mask = res.categoryMask;
    if (!mask) return;
    const w = mask.width;
    const h = mask.height;
    const data: Uint8Array = mask.getAsUint8Array();
    const img = ctx.createImageData(w, h);
    const [r, g, b] = [205, 174, 242]; // lilac
    for (let i = 0; i < data.length; i++) {
      const on = data[i] > 0;
      img.data[i * 4] = r;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = b;
      img.data[i * 4 + 3] = on ? 110 : 0;
    }
    // scale the mask up to the canvas via a temp canvas
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    tmp.getContext('2d')?.putImageData(img, 0, 0);
    ctx.drawImage(tmp, 0, 0, v.videoWidth, v.videoHeight);
    mask.close?.();
  }

  // ── scoring ───────────────────────────────────────────────────────────────────
  // A geometry score is a STABILITY/CONFIDENCE proxy from landmark visibility +
  // left/right symmetry. It is intentionally generic (technique-only, never
  // appearance — MASTER rule 10); the agent treats it as a coarse on-screen cue and
  // defers fine judgments to the snapshot. `gemini_qualitative` emits no local score.
  private maybeScore(score: number | null, hint?: string): void {
    if (this.cfg.scoringMode === 'none' || this.cfg.scoringMode === 'gemini_qualitative') {
      // qualitative scoring is judged by the model, not on-device
      if (this.cfg.scoringMode === 'gemini_qualitative' && hint) {
        const now = performance.now();
        if (now - this.lastScoreAt >= SCORE_EVERY_MS) {
          this.lastScoreAt = now;
          this.scoreCb?.(null, hint);
        }
      }
      return;
    }
    const now = performance.now();
    if (now - this.lastScoreAt < SCORE_EVERY_MS) return;
    this.lastScoreAt = now;
    // light smoothing
    if (score != null && this.lastScore != null) score = Math.round(this.lastScore * 0.5 + score * 0.5);
    this.lastScore = score;
    this.scoreCb?.(score, hint);
  }

  private scoreFromVisibility(set: any[] | undefined): number | null {
    if (!set || !set.length) return null;
    let sum = 0;
    let n = 0;
    for (const p of set) {
      const v = typeof p.visibility === 'number' ? p.visibility : 1;
      sum += Math.max(0, Math.min(1, v));
      n++;
    }
    if (!n) return null;
    return Math.round((sum / n) * 100);
  }

  private scoreFromMoveNet(kpts: any[]): number | null {
    if (!kpts || !kpts.length) return null;
    const conf = kpts.reduce((a, k) => a + (k.score ?? 0), 0) / kpts.length;
    // symmetry bonus: shoulders (5,6) and hips (11,12) level → steadier form
    const sym = (ai: number, bi: number): number => {
      const a = kpts[ai];
      const b = kpts[bi];
      if (!a || !b) return 0;
      const span = Math.abs(a.x - b.x) || 1;
      return 1 - Math.min(1, Math.abs(a.y - b.y) / span);
    };
    const symmetry = (sym(5, 6) + sym(11, 12)) / 2;
    return Math.round((conf * 0.7 + symmetry * 0.3) * 100);
  }

  // ── frame grabbers (owned/called by SessionRoom) ───────────────────────────────
  private grab(maxEdge: number | null, quality: number): string | null {
    const v = this.video;
    if (!v || v.videoWidth === 0) return null;
    if (!this.offscreen) this.offscreen = document.createElement('canvas');
    const oc = this.offscreen;
    const scale = maxEdge ? Math.min(1, maxEdge / Math.max(v.videoWidth, v.videoHeight)) : 1;
    oc.width = Math.max(1, Math.round(v.videoWidth * scale));
    oc.height = Math.max(1, Math.round(v.videoHeight * scale));
    const ctx = oc.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, oc.width, oc.height);
    return oc.toDataURL('image/jpeg', quality);
  }

  /** ~640px JPEG data-URL for the 1-fps Gemini Live frame. */
  grabLowResFrame(): string | null {
    return this.grab(LOWRES_EDGE, 0.6);
  }

  /** Full-res JPEG data-URL for the "Analyze my form" snapshot. */
  grabHiResFrame(): string | null {
    return this.grab(null, 0.92);
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    try {
      this.mp?.close?.();
    } catch {
      /* ignore */
    }
    try {
      this.moveNet?.dispose?.();
    } catch {
      /* ignore */
    }
    this.mp = null;
    this.moveNet = null;
    this.mpDraw = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    const c = this.canvas;
    if (c) c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
  }
}

/** Strip the `data:image/jpeg;base64,` prefix → raw base64 (for the snapshot body). */
export function dataUrlToBase64(dataUrl: string): string {
  const i = dataUrl.indexOf(',');
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}

/** data-URL JPEG → ArrayBuffer (for GeminiLiveClient.sendVideoFrame). */
export function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  const b64 = dataUrlToBase64(dataUrl);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
