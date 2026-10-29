/* [HF-PHOTO-CROP-WEB] "Adjust your photo": drag to move, wheel / pinch / slider to zoom, then crop exactly the visible window.
 * Profile = circle over a square (output square, 1080 max, 200 min). Cover = 3:1 (output up to 1500 x 500, 640 x 200 min).
 * The picture always covers the frame (the crop window is clamped inside it). Keyboard: arrows move, + / - zoom. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { capture } from '../../../lib/analytics';
import { CROP_ASPECT, CROP_MAX_ZOOM, cropBaseWidth, cropMaxZoom, cropPhoto, decodePhoto, type PhotoKind, type PhotoSource } from '../../../lib/hfPhotosApi';

interface View { z: number; cx: number; cy: number }

interface Props {
  file: File;
  kind: PhotoKind;
  onCancel: () => void;
  /** Called with the cropped JPEG. */
  onDone: (out: { blob: Blob; width: number; height: number }) => void;
  /** Called when the picture cannot be used (cannot be read, or too small). */
  onFail: (message: string, error: string) => void;
}

const HINT: Record<PhotoKind, string> = { profile: 'Move and zoom so your face is in the circle.', cover: 'Move and zoom to pick the part you want.' };

export default function PhotoCropper({ file, kind, onCancel, onDone, onFail }: Props) {
  const [photo, setPhoto] = useState<PhotoSource | null>(null);
  const [view, setView] = useState<View>({ z: 1, cx: 0, cy: 0 });
  const [busy, setBusy] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const wrap = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | null>(null);
  const alive = useRef(true);
  const aspect = CROP_ASPECT[kind];

  // Decode once. The decoded picture is released when the editor closes.
  useEffect(() => {
    alive.current = true;
    let decoded: PhotoSource | null = null;
    void decodePhoto(file).then(p => {
      if (!alive.current) { p?.close(); return; }
      if (!p) { onFail('We could not read that picture. Please try another one.', 'decode'); return; }
      decoded = p;
      if (cropMaxZoom(kind, p.width, p.height) < 1) {
        const [w, h] = kind === 'profile' ? [200, 200] : [640, 200];
        p.close(); decoded = null;
        capture('hf_photo_crop', { kind, zoom: 0, result: 'too_small' });
        onFail(`That picture is too small. Please use one at least ${w} × ${h} pixels.`, 'too_small'); return;
      }
      setPhoto(p); setView({ z: 1, cx: p.width / 2, cy: p.height / 2 });
    });
    return () => { alive.current = false; decoded?.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, kind]);

  // Frame size follows the container (phones: full width; desktop: capped).
  useLayoutEffect(() => {
    const el = wrap.current; if (!el) return;
    const measure = () => {
      const avail = el.clientWidth;
      const w = kind === 'profile' ? Math.min(avail, 420) : Math.min(avail, 760);
      setBox({ w: Math.max(0, Math.floor(w)), h: Math.max(0, Math.floor(w / aspect)) });
    };
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [kind, aspect, photo]);

  const zMax = photo ? Math.max(1, cropMaxZoom(kind, photo.width, photo.height)) : CROP_MAX_ZOOM;

  /** Clamp the crop window inside the picture so it always covers the frame. */
  const clamp = useCallback((v: View): View => {
    if (!photo) return v;
    const z = Math.min(zMax, Math.max(1, v.z));
    const sw = cropBaseWidth(kind, photo.width, photo.height) / z, sh = sw / aspect;
    return { z, cx: Math.min(photo.width - sw / 2, Math.max(sw / 2, v.cx)), cy: Math.min(photo.height - sh / 2, Math.max(sh / 2, v.cy)) };
  }, [photo, kind, aspect, zMax]);

  // Paint the visible window.
  useEffect(() => {
    const c = canvas.current; if (!c || !photo || !box.w) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(box.w * dpr); c.height = Math.round(box.h * dpr);
    const g = c.getContext('2d'); if (!g) return;
    const sw = cropBaseWidth(kind, photo.width, photo.height) / view.z, sh = sw / aspect;
    g.imageSmoothingQuality = 'high';
    g.drawImage(photo.src, view.cx - sw / 2, view.cy - sh / 2, sw, sh, 0, 0, c.width, c.height);
  }, [photo, view, box, kind, aspect]);

  const zoomTo = useCallback((z: number) => setView(v => clamp({ ...v, z })), [clamp]);
  const zoomBy = useCallback((f: number) => setView(v => clamp({ ...v, z: v.z * f })), [clamp]);
  const panPx = useCallback((dx: number, dy: number) => {
    if (!photo || !box.w) return;
    setView(v => {
      const sw = cropBaseWidth(kind, photo.width, photo.height) / v.z; // source pixels across the frame
      const k = sw / box.w;
      return clamp({ ...v, cx: v.cx - dx * k, cy: v.cy - dy * k });
    });
  }, [photo, box.w, kind, clamp]);

  // Wheel needs a non-passive listener so the page does not scroll while zooming.
  useEffect(() => {
    const el = stage.current; if (!el) return;
    const wheel = (e: WheelEvent) => { e.preventDefault(); zoomBy(Math.exp(-e.deltaY * 0.0015)); };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [zoomBy, photo]);

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pinch.current = pointers.current.size === 2 ? dist() : null;
  };
  const dist = () => { const [a, b] = [...pointers.current.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pointers.current.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) { panPx(dx, dy); return; }
    if (pointers.current.size === 2) {
      const d = dist(); if (pinch.current) zoomBy(d / pinch.current); pinch.current = d;
      panPx(dx / 2, dy / 2); // the midpoint moves by half of each finger's move
    }
  };
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    pinch.current = pointers.current.size === 2 ? dist() : null;
  };
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 8 : 24;
    if (e.key === 'ArrowLeft') panPx(step, 0);
    else if (e.key === 'ArrowRight') panPx(-step, 0);
    else if (e.key === 'ArrowUp') panPx(0, step);
    else if (e.key === 'ArrowDown') panPx(0, -step);
    else if (e.key === '+' || e.key === '=') zoomBy(1.1);
    else if (e.key === '-' || e.key === '_') zoomBy(1 / 1.1);
    else return;
    e.preventDefault();
  };

  const reset = () => { if (photo) setView({ z: 1, cx: photo.width / 2, cy: photo.height / 2 }); };

  const use = async () => {
    if (!photo || busy) return;
    setBusy(true);
    const out = await cropPhoto(photo, kind, view.cx, view.cy, view.z);
    if (!alive.current) return;
    setBusy(false);
    capture('hf_photo_crop', { kind, zoom: Math.round(view.z * 100) / 100, result: out ? 'ok' : 'failed' });
    if (!out) { onFail('We could not prepare that picture. Please try another one.', 'decode'); return; }
    onDone(out);
  };

  return <section className="pc" aria-label="Adjust your photo">
    <h2 className="pc-title">Adjust your photo</h2>
    <p className="pc-hint">{HINT[kind]}</p>
    <div className="pc-wrap" ref={wrap}>
      {!photo ? <div className="pc-loading" role="status">Opening your picture…</div> :
        <div ref={stage} className={`pc-stage ${kind}`} style={{ width: box.w, height: box.h }} tabIndex={0} role="group"
          aria-label={`${kind === 'profile' ? 'Photo' : 'Cover'} editor. Arrow keys move the picture. Plus and minus zoom.`}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onKey}>
          <canvas ref={canvas} style={{ width: box.w, height: box.h }} />
          <span className="pc-frame" aria-hidden="true" />
        </div>}
    </div>
    {photo && <div className="pc-zoom">
      <button type="button" className="pc-round" aria-label="Zoom out" disabled={view.z <= 1.001} onClick={() => zoomBy(1 / 1.15)}>−</button>
      <input type="range" min={1} max={zMax} step={0.01} value={view.z} aria-label="Zoom" onChange={e => zoomTo(Number(e.target.value))} disabled={zMax <= 1.001} />
      <button type="button" className="pc-round" aria-label="Zoom in" disabled={view.z >= zMax - 0.001} onClick={() => zoomBy(1.15)}>+</button>
      <button type="button" className="pc-ghost" onClick={reset}>Reset</button>
    </div>}
    <div className="pc-actions">
      <button type="button" className="mp-btn" disabled={!photo || busy} onClick={() => void use()}>{busy ? 'Preparing…' : 'Use this photo'}</button>
      <button type="button" className="pc-ghost" disabled={busy} onClick={onCancel}>Choose another</button>
    </div>
  </section>;
}
