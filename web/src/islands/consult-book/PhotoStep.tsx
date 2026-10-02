/* [AUMFE-CONSULT-F2-1 2026-10-02] Step 2 for palmistry and face reading — camera capture with guidance (mockups
 * BookPalm / BookFace). getUserMedia + the outline overlay; two cheap quality checks run on a 240 px canvas copy of the
 * live frame (brightness + Laplacian-variance blur, see bookLogic.frameStats); optionally MediaPipe Hands / Face
 * Landmarker is lazy-loaded from cdn.jsdelivr.net ONLY when this step opens (site "load later" rule) to say "one hand /
 * one face found" and "fill the outline". If MediaPipe cannot load the step still works on light + sharpness alone.
 * "Upload instead" re-encodes any picked image to a <=1600 px JPEG. Nothing is uploaded here: the wizard uploads once the
 * booking exists and feeds each verdict back through `photos[kind]` (accepted / rejected + reason -> retake).
 * NOTE FOR AI: MediaPipe models come from storage.googleapis.com (jsdelivr hosts the code + wasm, not the .task files). */
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { capture, captureException } from '../../lib/analytics';
import type { PhotoKind } from '../../lib/consultTypes';
import { frameStats, isSharp, lightVerdict } from './bookLogic';
import type { LightVerdict } from './bookLogic';

export interface PhotoItem { blob: Blob; url: string; status: 'local' | 'uploading' | 'accepted' | 'rejected' | 'error'; reason?: string | null }
type KindSpec = { kind: PhotoKind; optional: boolean };

const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MP_MODEL = {
  hand: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
};

/* eslint-disable @typescript-eslint/no-explicit-any */
async function loadLandmarker(hand: boolean): Promise<any | null> {
  try {
    const mod: any = await import(/* @vite-ignore */ `${MP_BASE}/vision_bundle.mjs`);
    const files = await mod.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
    const baseOptions = { modelAssetPath: hand ? MP_MODEL.hand : MP_MODEL.face };
    return hand
      ? await mod.HandLandmarker.createFromOptions(files, { baseOptions, runningMode: 'VIDEO', numHands: 2 })
      : await mod.FaceLandmarker.createFromOptions(files, { baseOptions, runningMode: 'VIDEO', numFaces: 2 });
  } catch (e) {
    captureException(e, { where: 'consult_mediapipe_load' });
    return null;
  }
}
interface Det { n: number; fill: boolean }
function summarise(hand: boolean, r: any): Det {
  const sets: { x: number; y: number }[][] = (hand ? r?.landmarks : r?.faceLandmarks) ?? [];
  if (sets.length !== 1) return { n: sets.length, fill: false };
  const ys = sets[0].map((p) => p.y);
  return { n: 1, fill: Math.max(...ys) - Math.min(...ys) >= (hand ? 0.5 : 0.35) };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function canvasBlob(c: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.9));
}
async function fileToJpeg(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d')?.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const b = await canvasBlob(c);
  if (!b) throw new Error('encode_failed');
  return b;
}

const PALM_PATH = 'M70 370 C60 300 40 250 28 200 C20 170 34 160 46 178 L72 228 L66 70 C66 52 92 52 92 70 L98 190 L104 40 C104 20 132 20 132 40 L134 190 L142 52 C142 34 168 34 168 52 L166 200 L180 96 C182 80 206 82 204 100 L194 240 C190 300 180 340 172 370';

function CameraView({ kind, facePhoto, onShot, onFile, fileErr }: {
  kind: PhotoKind; facePhoto: boolean; onShot: (b: Blob) => void; onFile: (e: ChangeEvent<HTMLInputElement>) => void; fileErr: string | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [cam, setCam] = useState<'starting' | 'live' | 'blocked'>('starting');
  const [light, setLight] = useState<LightVerdict | null>(null);
  const [sharp, setSharp] = useState<boolean | null>(null);
  const [det, setDet] = useState<Det | null>(null);
  const [mpReady, setMpReady] = useState(false);
  const [shooting, setShooting] = useState(false);
  const selfie = kind === 'face_front' || kind === 'face_side';

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    setCam('starting'); setLight(null); setSharp(null); setDet(null); setMpReady(false);
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setCam('blocked'); capture('consult_photo_capture', { kind, ok: false, reason: 'unsupported' }); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: selfie ? 'user' : 'environment', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        await v.play().catch(() => undefined);
        setCam('live');
      } catch (e) {
        if (stopped) return;
        setCam('blocked');
        const name = e instanceof DOMException ? e.name : 'camera_error';
        capture('consult_photo_capture', { kind, ok: false, reason: name });
        if (name !== 'NotAllowedError' && name !== 'NotFoundError') captureException(e, { where: 'consult_camera_start', kind });
      }
    })();
    return () => { stopped = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [kind, selfie]);

  useEffect(() => {
    if (cam !== 'live') return;
    const v = videoRef.current;
    if (!v) return;
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    let cancelled = false;
    let mp: { detectForVideo: (v: HTMLVideoElement, t: number) => unknown; close?: () => void } | null = null;
    void loadLandmarker(!facePhoto).then((m) => { if (cancelled) { m?.close?.(); return; } mp = m; setMpReady(!!m); });
    const id = window.setInterval(() => {
      if (!v.videoWidth) return;
      c.width = 240;
      c.height = Math.max(1, Math.round((240 * v.videoHeight) / v.videoWidth));
      ctx.drawImage(v, 0, 0, c.width, c.height);
      const s = frameStats(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
      setLight(lightVerdict(s.brightness));
      setSharp(isSharp(s.sharpness));
      if (mp) {
        try { setDet(summarise(!facePhoto, mp.detectForVideo(v, performance.now()))); } catch { /* a missed frame is fine */ }
      }
    }, 450);
    return () => { cancelled = true; window.clearInterval(id); mp?.close?.(); };
  }, [cam, facePhoto]);

  const detOk = !mpReady || (det != null && det.n === 1 && det.fill);
  const canShoot = cam === 'live' && light === 'ok' && sharp === true && detOk && !shooting;

  async function shoot() {
    const v = videoRef.current;
    if (!v || !v.videoWidth || !canShoot) return;
    setShooting(true);
    try {
      const scale = Math.min(1, 1280 / v.videoWidth);
      const c = document.createElement('canvas');
      c.width = Math.round(v.videoWidth * scale);
      c.height = Math.round(v.videoHeight * scale);
      c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height);
      const b = await canvasBlob(c);
      if (!b) throw new Error('encode_failed');
      capture('consult_photo_capture', { kind, ok: true, reason: 'camera' });
      onShot(b);
    } catch (e) {
      capture('consult_photo_capture', { kind, ok: false, reason: 'capture_failed' });
      captureException(e, { where: 'consult_camera_capture', kind });
    } finally {
      setShooting(false);
    }
  }

  const handWord = facePhoto ? 'face' : 'hand';
  return (
    <>
      <div className="cb-frame">
        <video ref={videoRef} playsInline muted autoPlay className={selfie ? 'mirror' : undefined} aria-label="Camera preview" />
        {cam !== 'live' && <span className="tag">{cam === 'starting' ? 'Starting the camera…' : 'Camera preview'}</span>}
        {cam === 'blocked' && <p style={{ position: 'relative', zIndex: 2, padding: 24 }}>The camera isn&rsquo;t available. Allow camera access in your browser, or tap “Upload instead”.</p>}
        {cam !== 'blocked' && (facePhoto
          ? <span className="wm face cb-outline" style={{ position: 'relative', width: 250, height: 320, opacity: 0.95 }} />
          : <svg className="cb-outline" width="250" height="380" viewBox="0 0 250 380" fill="none" aria-hidden="true" style={kind === 'palm_left' ? { transform: 'scaleX(-1)' } : undefined}>
            <path d={PALM_PATH} stroke="#f6e7c4" strokeWidth="3" strokeDasharray="10 8" strokeLinecap="round" />
          </svg>)}
        {cam === 'live' && (
          <div className="cb-chipcol" aria-live="polite">
            {mpReady && det && (det.n === 1
              ? <span className="chip">✓ One {handWord} found</span>
              : <span className="chip warn">{det.n === 0 ? `Show your ${handWord} to the camera` : `Only one ${handWord}, please`}</span>)}
            {light && (light === 'ok' ? <span className="chip">✓ Good light</span> : <span className="chip warn">{light === 'dark' ? 'Need more light' : 'Too bright — move out of the glare'}</span>)}
            {sharp != null && (sharp ? <span className="chip">✓ Sharp</span> : <span className="chip warn">Hold still — the picture is blurry</span>)}
            {mpReady && det && det.n === 1 && !det.fill && <span className="chip warn">Move closer — fill the outline</span>}
          </div>
        )}
      </div>
      <div className="cb-cam-foot">
        <p>{facePhoto
          ? 'Hair back from your forehead. A bindi or tilak is fine. No glasses or beauty filter.'
          : 'Open your hand, fingers apart, in daylight. Remove rings. The button turns on when the photo is good enough to read.'}</p>
        {fileErr && <p className="cb-err" role="alert">{fileErr}</p>}
        <div className="cb-cam-row">
          <button type="button" className="btn ghost small" onClick={() => fileRef.current?.click()}>Upload instead</button>
          <button type="button" className="cb-shutter" aria-label="Take photo" disabled={!canShoot} onClick={() => void shoot()} />
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={onFile} />
        </div>
      </div>
    </>
  );
}

export function PhotoStep({ discipline, kinds, hand, photos, onShot, onClear, onDone, onBack }: {
  discipline: 'palmistry' | 'face_reading';
  kinds: KindSpec[];
  hand: 'right' | 'left';
  photos: Partial<Record<PhotoKind, PhotoItem>>;
  onShot: (kind: PhotoKind, blob: Blob) => void;
  onClear: (kind: PhotoKind) => void;
  onDone: () => void;
  onBack: () => void;
}) {
  const [idx, setIdx] = useState(0);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const spec = kinds[Math.min(idx, kinds.length - 1)];
  const kind = spec.kind;
  const face = discipline === 'face_reading';
  const item = photos[kind];
  const next = kinds[idx + 1];

  const title = face
    ? (kind === 'face_front' ? 'Look straight at the camera' : 'Now turn your head to the side')
    : `Your ${kind === 'palm_right' ? 'right' : 'left'} palm${(kind === 'palm_right') === (hand === 'right') ? ' (dominant)' : ''}`;
  const otherHand = hand === 'right' ? 'left' : 'right';
  const nextLabel = face ? 'Add side photo' : `Add ${otherHand} palm`;
  const skipLabel = face ? 'Skip side photo' : `Skip ${otherHand} palm`;

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setFileErr(null);
    try {
      const b = await fileToJpeg(file);
      capture('consult_photo_capture', { kind, ok: true, reason: 'upload' });
      onShot(kind, b);
    } catch (err) {
      capture('consult_photo_capture', { kind, ok: false, reason: 'unreadable_file' });
      captureException(err, { where: 'consult_photo_file', kind });
      setFileErr('That image can’t be read. Please choose a JPEG or PNG photo.');
    }
  }

  const blocked = item?.status === 'rejected' || item?.status === 'error' || item?.status === 'uploading';
  return (
    <div className={`cb-cam ${face ? 'cat-face' : 'cat-palm'}`}>
      <div className="cb-cam-top">
        <div className="steps"><span className="on" /><span className="on" /><span /><span /></div>
        <span className="label">Step 2 of 4 · {face ? 'Face photo' : 'Palm photo'}</span>
        <h2>{title}</h2>
        <button type="button" className="edit left" style={{ color: '#f6e7c4' }} onClick={onBack}>← Back to your details</button>
      </div>
      {!item ? (
        <>
          <CameraView key={kind} kind={kind} facePhoto={face} onShot={(b) => onShot(kind, b)} onFile={(e) => void onFile(e)} fileErr={fileErr} />
          {spec.optional && <div className="cb-cam-foot" style={{ paddingTop: 0 }}><button type="button" className="btn ghost small" onClick={onDone}>{skipLabel}</button></div>}
        </>
      ) : (
        <>
          <div className="cb-frame">
            <img className="shot" src={item.url} alt={`Your photo, ${title}`} />
            <div className="cb-chipcol" aria-live="polite">
              {item.status === 'accepted' && <span className="chip">✓ Photo accepted</span>}
              {item.status === 'uploading' && <span className="chip warn">Checking your photo…</span>}
              {item.status === 'local' && <span className="chip">✓ Photo ready</span>}
              {(item.status === 'rejected' || item.status === 'error') && <span className="chip bad">{item.reason || 'We couldn’t read that photo.'} Please retake it.</span>}
            </div>
          </div>
          <div className="cb-cam-foot">
            <div className="cb-cam-row">
              <button type="button" className="btn ghost small" onClick={() => { setFileErr(null); onClear(kind); }}>Retake</button>
              {next && !photos[next.kind] && <button type="button" className="btn ghost small" disabled={blocked} onClick={() => setIdx(idx + 1)}>{nextLabel}</button>}
              <button type="button" className="btn red small" disabled={blocked} onClick={onDone}>Continue</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
