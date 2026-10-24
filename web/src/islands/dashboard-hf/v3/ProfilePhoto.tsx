/* [HF-CHANNEL-PHOTO-1] Dashboard "Profile photo": an influencer picks a picture, drags and zooms it inside a fixed 4:5 window,
 * and saves a 1200x1500 JPEG. Worker: GET /api/hosts/me (avatarUrl), PUT /api/hosts/me/photo (raw body, Specs/SPEC-HF-CHANNEL C1).
 * The photo must be the chosen AI avatar, never a real photo (HF-AVA-5). The visible AI tag was removed from the public page by the owner on 2026-10-24 (HF-AVA-1 changed). */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import type { DashboardAccount } from '../../../components/account/DashboardNav';
import { hfCall } from '../../../lib/hfCallsApi';
import { API_BASE } from '../../../lib/env';
import { capture, captureException } from '../../../lib/analytics';
import '../../../styles/hf-profile-photo.css';
import { Card, Ic, PageHead, Skel, useToast } from './ui';

const MAX_BYTES = 10 * 1024 * 1024;
const MIN_W = 600, MIN_H = 750;
const OUT_W = 1200, OUT_H = 1500;
const ZOOM_MAX = 4;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

interface MeHost { slug?: string | null; displayName?: string | null; avatarUrl?: string | null }
interface View { zoom: number; cx: number; cy: number }
type PutResult = { ok: true; avatarUrl: string | null } | { ok: false; status: number; code: string };

async function putPhoto(blob: Blob): Promise<PutResult> {
  const { getActiveTokenWaited } = await import('../../../lib/clerk');
  const token = await getActiveTokenWaited(6000);
  if (!token) return { ok: false, status: 401, code: 'no_session' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90_000);
  try {
    const res = await fetch(`${API_BASE}/api/hosts/me/photo`, { method: 'PUT', body: blob, cache: 'no-store', signal: ctl.signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': blob.type || 'image/jpeg' } });
    const j = await res.json().catch(() => ({})) as { ok?: boolean; error?: string; avatarUrl?: string | null };
    if (res.ok && j.ok !== false) return { ok: true, avatarUrl: j.avatarUrl ?? null };
    return { ok: false, status: res.status, code: String(j.error ?? 'error') };
  } catch { return { ok: false, status: 0, code: 'network' }; } finally { clearTimeout(timer); }
}

function saveMessage(status: number, code: string): string {
  if (status === 413 || code === 'too_big') return 'That picture is bigger than 10 MB. Please pick a smaller one.';
  if (code === 'too_small') return `That picture is too small. Please use one at least ${MIN_W} × ${MIN_H} pixels.`;
  if (code === 'bad_type') return 'That file type is not supported. Please use a JPG, PNG or WebP picture.';
  if (status === 404) return 'We could not find your influencer profile. Please finish setting it up first, then come back.';
  if (status === 429) return 'You have changed your photo a lot in the last hour. Please try again a little later.';
  if (status === 401) return 'Please sign in again to save your photo.';
  if (status === 0) return 'We could not reach the server. Check your internet and try again.';
  return 'We could not save your photo. Please try again.';
}

export default function ProfilePhoto({ account }: { account: DashboardAccount }) {
  if (!account.host) return <NotInfluencer />;
  return <Editor account={account} />;
}

function NotInfluencer() {
  return <>
    <PageHead eyebrow="My public page" title="Profile photo" sub="The big picture at the top of an influencer’s public page." />
    <Card title="This is for influencers">
      <p style={{ marginTop: 0 }}>You need an influencer profile to have a public page. It’s free to start, and you can add your photo as soon as you’re in.</p>
      <a className="h3-btn rani" href="/dashboard/become">Become an influencer →</a>
    </Card>
  </>;
}

function Editor({ account }: { account: DashboardAccount }) {
  const toast = useToast();
  const [host, setHost] = useState<MeHost | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [view, setView] = useState<View>({ zoom: 1, cx: 0, cy: 0 });
  const [W, setW] = useState(0);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedUrl, setSavedUrl] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const heroPrev = useRef<HTMLCanvasElement>(null);
  const roundPrev = useRef<HTMLCanvasElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const objUrl = useRef<string | null>(null);
  const viewRef = useRef(view); viewRef.current = view;
  const imgRef = useRef(img); imgRef.current = img;
  const Wref = useRef(W); Wref.current = W;

  const slug = host?.slug || account.host?.slug || null;
  const name = host?.displayName || account.displayName || 'Your name';
  const currentUrl = savedUrl ?? host?.avatarUrl ?? null;

  const load = useCallback(async () => {
    setLoading(true); setLoadFailed(false);
    const r = await hfCall<{ host: MeHost | null; avatarUrl?: string | null }>('GET', '/api/hosts/me');
    if (!r.ok) { setLoadFailed(true); setLoading(false); return; }
    const h = r.data.host ?? {};
    setHost({ ...h, avatarUrl: h.avatarUrl ?? r.data.avatarUrl ?? null });
    setLoading(false);
  }, []);
  useEffect(() => { void load(); capture('profile_photo_opened', {}); }, [load]);
  useEffect(() => () => { if (objUrl.current) URL.revokeObjectURL(objUrl.current); }, []);

  /* crop window geometry: fixed 4:5 window, 84% of the box width, centred (matches .pp-win inset 8%) */
  const geom = useCallback((w: number, im: HTMLImageElement, v: View) => {
    const ww = 0.84 * w, wh = 1.05 * w;
    const base = Math.max(ww / im.naturalWidth, wh / im.naturalHeight);
    const s = base * v.zoom;
    const hw = ww / (2 * s), hh = wh / (2 * s);
    const cx = Math.min(Math.max(v.cx, hw), im.naturalWidth - hw);
    const cy = Math.min(Math.max(v.cy, hh), im.naturalHeight - hh);
    return { s, hw, hh, cx, cy };
  }, []);

  useEffect(() => {
    const el = box.current; if (!el) return;
    const set = () => setW(el.clientWidth);
    set();
    const ro = new ResizeObserver(set); ro.observe(el);
    return () => ro.disconnect();
  }, [loading]);

  /* draw the editor canvas + the two live previews */
  useEffect(() => {
    const c = canvas.current;
    if (!c || !img || !W) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const H = W * 1.25;
    c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
    const g = c.getContext('2d'); if (!g) return;
    const q = geom(W, img, view);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, W / 2 - q.cx * q.s, H / 2 - q.cy * q.s, img.naturalWidth * q.s, img.naturalHeight * q.s);
    const hp = heroPrev.current, rp = roundPrev.current;
    if (hp) { hp.width = 220; hp.height = 275; hp.getContext('2d')?.drawImage(img, q.cx - q.hw, q.cy - q.hh, q.hw * 2, q.hh * 2, 0, 0, 220, 275); }
    if (rp) { rp.width = 220; rp.height = 220; rp.getContext('2d')?.drawImage(img, q.cx - q.hw, q.cy - q.hh + (q.hh - q.hw), q.hw * 2, q.hw * 2, 0, 0, 220, 220); }
  }, [img, view, W, geom]);

  const move = useCallback((patch: (v: View, s: number) => Partial<View>) => {
    const im = imgRef.current, w = Wref.current; if (!im || !w) return;
    setView(v => { const q = geom(w, im, v); const n = { ...v, cx: q.cx, cy: q.cy, ...patch(v, q.s) }; const z = Math.min(ZOOM_MAX, Math.max(1, n.zoom)); const g2 = geom(w, im, { ...n, zoom: z }); return { zoom: z, cx: g2.cx, cy: g2.cy }; });
  }, [geom]);
  const reset = useCallback(() => { const im = imgRef.current; if (im) setView({ zoom: 1, cx: im.naturalWidth / 2, cy: im.naturalHeight / 2 }); }, []);

  /* pointer: drag to move, two fingers to pinch */
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; zoom: number } | null>(null);
  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!img) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.current.size === 2) { const [a, b] = [...ptrs.current.values()]; pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: viewRef.current.zoom }; }
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const p = ptrs.current.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.current.size >= 2 && pinch.current) {
      const [a, b] = [...ptrs.current.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.current.d > 0) { const z = pinch.current.zoom * (d / pinch.current.d); move(() => ({ zoom: z })); }
    } else move((v, s) => ({ cx: v.cx - dx / s, cy: v.cy - dy / s }));
  };
  const onUp = (e: RPointerEvent<HTMLDivElement>) => { ptrs.current.delete(e.pointerId); if (ptrs.current.size < 2) pinch.current = null; };
  useEffect(() => {
    const el = box.current; if (!el) return;
    const wheel = (e: WheelEvent) => { if (!imgRef.current) return; e.preventDefault(); move(v => ({ zoom: v.zoom * Math.exp(-e.deltaY * 0.0015) })); };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [move, loading]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!img) return;
    const step = e.shiftKey ? 60 : 16;
    const k = e.key;
    if (k === 'ArrowLeft') move((v, s) => ({ cx: v.cx - step / s }));
    else if (k === 'ArrowRight') move((v, s) => ({ cx: v.cx + step / s }));
    else if (k === 'ArrowUp') move((v, s) => ({ cy: v.cy - step / s }));
    else if (k === 'ArrowDown') move((v, s) => ({ cy: v.cy + step / s }));
    else if (k === '+' || k === '=') move(v => ({ zoom: v.zoom * 1.1 }));
    else if (k === '-' || k === '_') move(v => ({ zoom: v.zoom / 1.1 }));
    else if (k === '0') reset();
    else return;
    e.preventDefault();
  };

  /* file intake */
  const takeFile = useCallback((f: File | null | undefined) => {
    if (!f) return;
    setErr(''); setSavedUrl(null);
    const okType = TYPES.includes(f.type) || (!f.type && /\.(jpe?g|png|webp)$/i.test(f.name));
    if (!okType) { setErr('That file type is not supported. Please use a JPG, PNG or WebP picture.'); return; }
    if (f.size > MAX_BYTES) { setErr('That picture is bigger than 10 MB. Please pick a smaller one.'); return; }
    const url = URL.createObjectURL(f);
    const im = new Image();
    im.onload = () => {
      if (im.naturalWidth < MIN_W || im.naturalHeight < MIN_H) { URL.revokeObjectURL(url); setErr(`That picture is too small (${im.naturalWidth} × ${im.naturalHeight} pixels). Please use one at least ${MIN_W} × ${MIN_H} pixels.`); return; }
      if (objUrl.current) URL.revokeObjectURL(objUrl.current);
      objUrl.current = url;
      setImg(im); setView({ zoom: 1, cx: im.naturalWidth / 2, cy: im.naturalHeight / 2 });
      window.setTimeout(() => box.current?.focus({ preventScroll: true }), 0);
    };
    im.onerror = () => { URL.revokeObjectURL(url); setErr('We could not open that picture. Please try a different JPG, PNG or WebP file.'); };
    im.src = url;
  }, []);
  const onDrop = (e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setOver(false); takeFile(e.dataTransfer.files?.[0]); };

  const save = async () => {
    if (!img || !W || saving) return;
    setSaving(true); setErr('');
    try {
      const q = geom(W, img, viewRef.current);
      const out = document.createElement('canvas'); out.width = OUT_W; out.height = OUT_H;
      const g = out.getContext('2d'); if (!g) throw new Error('no_canvas');
      g.fillStyle = '#fff'; g.fillRect(0, 0, OUT_W, OUT_H);
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, q.cx - q.hw, q.cy - q.hh, q.hw * 2, q.hh * 2, 0, 0, OUT_W, OUT_H);
      const blob = await new Promise<Blob | null>(res => out.toBlob(res, 'image/jpeg', 0.88));
      if (!blob) throw new Error('no_blob');
      const r = await putPhoto(blob);
      if (!r.ok) { setErr(saveMessage(r.status, r.code)); capture('profile_photo_failed', { reason: r.code, status: r.status }); return; }
      capture('profile_photo_saved', { bytes: blob.size, zoom: Math.round(viewRef.current.zoom * 100) / 100 });
      const url = r.avatarUrl ? `${r.avatarUrl}${r.avatarUrl.includes('?') ? '&' : '?'}v=${Date.now()}` : null;
      setSavedUrl(url); setHost(h => ({ ...(h ?? {}), avatarUrl: url }));
      setImg(null); if (objUrl.current) { URL.revokeObjectURL(objUrl.current); objUrl.current = null; }
      toast('Photo saved. It’s on your page now.');
    } catch (e) {
      captureException(e, { area: 'hf_dashboard', step: 'profile_photo_save' });
      capture('profile_photo_failed', { reason: 'client', status: -1 });
      setErr('We could not prepare your picture. Please try a different one.');
    } finally { setSaving(false); }
  };

  const zoomPct = useMemo(() => Math.round(view.zoom * 100), [view.zoom]);

  if (loading) return <><PageHead eyebrow="My public page" title="Profile photo" /><Skel h={420} /></>;

  return <>
    <PageHead eyebrow="My public page" title="Profile photo" sub="The big picture at the top of your page. Upload it, then drag and zoom until your face sits in the middle." />
    {loadFailed && <div className="pp-err" role="status">We could not load your current photo, but you can still upload a new one. <button type="button" className="pp-lnk" onClick={() => void load()}>Try again</button></div>}
    <section className="h3-card" aria-label="Edit profile photo">
      <div className="pp-ed">
        <div>
          <div ref={box} className={`pp-crop${img ? '' : ' is-empty'}`} tabIndex={img ? 0 : -1} role="group"
            aria-label={img ? 'Crop area. Drag to move the picture. Arrow keys move it, plus and minus zoom, zero resets.' : 'Crop area. Choose a picture to start.'}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onKey}>
            {img ? <canvas ref={canvas} aria-hidden="true" /> : currentUrl ? <img className="pp-cur" src={currentUrl} alt="Your current profile photo" draggable={false} /> :
              <div className="pp-empty"><div><b>No photo yet</b>Choose a picture on the right to start.</div></div>}
            {img && <><div className="pp-win" /><div className="pp-grid3" /></>}
          </div>
          <div className="pp-zoom">
            <label htmlFor="pp-zoom">Zoom</label>
            <input id="pp-zoom" type="range" min={100} max={ZOOM_MAX * 100} step={1} value={zoomPct} disabled={!img} aria-valuetext={`${zoomPct} percent`}
              onChange={e => move(() => ({ zoom: Number(e.target.value) / 100 }))} />
          </div>
          {img && <p className="pp-hint">Drag the picture, scroll or pinch to zoom. With the keyboard: arrow keys move, + and − zoom.</p>}
          <div className="pp-acts">
            <button type="button" className="h3-btn rani" disabled={!img || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save photo'}</button>
            <button type="button" className="h3-btn ghost" onClick={() => fileIn.current?.click()} disabled={saving}>Upload another</button>
            <button type="button" className="pp-lnk" onClick={reset} disabled={!img || saving}>Reset</button>
          </div>
          <div aria-live="polite">
            {err && <div className="pp-err" role="alert">{err}</div>}
            {savedUrl && !img && <div className="pp-ok" role="status"><span>Saved! Your new photo is live.</span>{slug && <a className="h3-btn sm ghost" href={`/h/${slug}`}>View my page</a>}</div>}
          </div>
        </div>
        <div>
          <div className={`pp-drop${over ? ' is-over' : ''}`} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
            <Ic name="down" className="" />
            <p className="t">Drop an image or <button type="button" onClick={() => fileIn.current?.click()}>browse</button></p>
            <p className="s">JPG, PNG or WebP · up to 10 MB · at least {MIN_W} × {MIN_H} px</p>
            <input ref={fileIn} className="pp-file" type="file" accept="image/jpeg,image/png,image/webp" tabIndex={-1} aria-label="Choose a profile photo"
              onChange={e => { takeFile(e.target.files?.[0]); e.target.value = ''; }} />
          </div>
          <div className="pp-do">
            <div><span className="m" aria-hidden="true">✓</span><span><b>Use your AI avatar.</b> The one you chose, not a real photo.</span></div>
            <div><span className="m x" aria-hidden="true">✕</span><span><b>No real photo of yourself</b> — this keeps you safe. Our team removes real photos.</span></div>
            <div><span className="m" aria-hidden="true">✓</span><span><b>Face in the middle,</b> no text or logos on the picture.</span></div>
          </div>
          <p className="pp-prev-h">Preview</p>
          <div className="pp-prev">
            <div className="pp-hero">
              <div className="ph">{img ? <canvas ref={heroPrev} aria-hidden="true" /> : currentUrl ? <img src={currentUrl} alt="" /> : null}</div>
              <div><b>{name}</b><p>Your public page</p></div>
            </div>
            <div className="pp-rw">
              <div className="pp-round">{img ? <canvas ref={roundPrev} aria-hidden="true" /> : currentUrl ? <img src={currentUrl} alt="" /> : null}</div>
              <p>Explore card</p>
            </div>
          </div>
          <p className="pp-note"><b>Coming to sign-up:</b> every new influencer will add this photo before their page goes live.</p>
        </div>
      </div>
    </section>
  </>;
}
