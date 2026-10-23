/* [HF-DASH-V3-1] Building blocks of the new customer dashboard: icons, Indian flowers, stickers, cards, dialog, toast.
 * Everything renders inside .hf3 (styles/hf-dash3.css). Flowers are drawn in SVG; stickers are the owner's art in /public/hf/stickers. */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { publicImage } from '../../../lib/config';

/* ── icons ─────────────────────────────────────────────────────────────── */
const PATHS: Record<string, string> = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c1.5-4 4.5-6 8-6s6.5 2 8 6',
  wallet: 'M3 9a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3zM16 13h2M3 10h18M6 6l9-3 2 3',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2',
  cal: 'M3 8a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3zM3 10h18M8 3v4M16 3v4',
  heart: 'M12 20s-7-4.3-8.8-8.5C2 8.4 4 5 7.2 5c1.9 0 3.2 1 4.8 2.9C13.6 6 14.9 5 16.8 5 20 5 22 8.4 20.8 11.5 19 15.7 12 20 12 20z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  star: 'M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.5 6.7 19.4l1.2-6L3.4 9.3l6-.7z',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5V14M12 17h.01',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  out: 'M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
  menu: 'M4 7h16M4 12h16M4 17h16', x: 'M6 6l12 12M18 6L6 18', plus: 'M12 5v14M5 12h14',
  left: 'M15 6l-6 6 6 6', right: 'M9 6l6 6-6 6',
  clock: 'M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 9v4l3 2M9 2h6',
  bag: 'M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2',
  money: 'M3 6h18v12H3zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
  shirt: 'M8 3L3 6l2 4 3-1v11h8V9l3 1 2-4-5-3c-.5 1.5-2 2.5-4 2.5S8.5 4.5 8 3z',
  down: 'M12 4v12M6 11l6 6 6-6M5 20h14', chat: 'M4 5h16v11H9l-5 4z', shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4',
};
export function Ic({ name, className = 'i', size }: { name: string; className?: string; size?: number }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={PATHS[name] ?? PATHS.user} /></svg>;
}

/* ── flowers: marigold (genda), lotus (kamal), hibiscus (gudhal), jasmine (mogra) ── */
export function Marigold({ size = 48, tone = 0 }: { size?: number; tone?: 0 | 1 }) {
  const rings: [number, number, string][] = tone
    ? [[40, 18, '#f59e0b'], [31, 16, '#fbbf24'], [21, 13, '#fcd34d'], [12, 9, '#f59e0b']]
    : [[40, 18, '#ea6a12'], [31, 16, '#f59e0b'], [21, 13, '#fb923c'], [12, 9, '#f97316']];
  return <svg className="flower" viewBox="-45 -45 90 90" width={size} height={size} aria-hidden="true">
    {rings.map(([r, n, c], ri) => Array.from({ length: n }, (_, i) => <ellipse key={`${ri}-${i}`} cy={-r * 0.55} rx={r * 0.21} ry={r * 0.5} fill={c} stroke="rgba(130,50,0,.28)" strokeWidth=".9" transform={`rotate(${i * 360 / n + ri * 9})`} />))}
    <circle r="5" fill="#9a3412" />
  </svg>;
}
export function Lotus({ size = 60 }: { size?: number }) {
  const pet = (rot: number, c: string, sc = 1) => <path key={rot} d="M0 0 C -12 -18 -10 -40 0 -54 C 10 -40 12 -18 0 0Z" fill={c} stroke="#be185d" strokeWidth="1" transform={`rotate(${rot}) scale(${sc})`} />;
  return <svg className="flower" viewBox="-60 -62 120 80" width={size} height={size * 0.67} aria-hidden="true">
    {pet(-62, '#fbcfe8', .8)}{pet(62, '#fbcfe8', .8)}{pet(-34, '#f9a8d4', .92)}{pet(34, '#f9a8d4', .92)}{pet(0, '#f472b6')}<ellipse cy="4" rx="40" ry="7" fill="#3f8f3a" />
  </svg>;
}
export function Hibiscus({ size = 50 }: { size?: number }) {
  return <svg className="flower" viewBox="-48 -48 96 96" width={size} height={size} aria-hidden="true">
    {Array.from({ length: 5 }, (_, i) => <path key={i} d="M0 0 C -20 -14 -22 -40 0 -44 C 22 -40 20 -14 0 0Z" fill="#dc2626" stroke="#991b1b" strokeWidth="1" transform={`rotate(${i * 72})`} />)}
    <circle r="9" fill="#7f1d1d" /><path d="M0 0 L 18 -26" stroke="#fde047" strokeWidth="3" strokeLinecap="round" /><circle cx="19" cy="-28" r="4" fill="#fde047" />
  </svg>;
}
export function Jasmine({ size = 22 }: { size?: number }) {
  return <svg className="flower" viewBox="-20 -20 40 40" width={size} height={size} aria-hidden="true">
    {Array.from({ length: 5 }, (_, i) => <ellipse key={i} cy="-9" rx="5" ry="9" fill="#fff" stroke="#e7d9c9" strokeWidth="1" transform={`rotate(${i * 72})`} />)}<circle r="3.4" fill="#fbbf24" />
  </svg>;
}
function Leaf({ size = 34, rot = 0 }: { size?: number; rot?: number }) {
  return <svg viewBox="-20 -20 40 40" width={size} height={size} aria-hidden="true" style={{ transform: `rotate(${rot}deg)` }}><path d="M-16 10 C -10 -14 10 -18 16 -14 C 12 4 -4 16 -16 10Z" fill="#3f8f3a" /><path d="M-14 9 L 12 -11" stroke="#2c6b28" strokeWidth="1.4" /></svg>;
}
export function FlowerCluster({ className = 'flowers', style }: { className?: string; style?: CSSProperties }) {
  const at = (s: CSSProperties, c: ReactNode) => <div style={{ position: 'absolute', ...s }}>{c}</div>;
  return <div className={className} aria-hidden="true" style={{ position: 'absolute', width: 210, height: 200, ...style }}>
    {at({ right: 40, top: 30 }, <Leaf size={56} rot={20} />)}{at({ right: 110, top: 6 }, <Leaf size={44} rot={-60} />)}
    {at({ right: 20, top: 20 }, <Marigold size={110} />)}{at({ right: 118, top: 44 }, <Marigold size={64} tone={1} />)}
    {at({ right: 62, top: 118 }, <Hibiscus size={58} />)}{at({ right: 150, top: 110 }, <Jasmine size={26} />)}{at({ right: 8, top: 128 }, <Jasmine size={22} />)}
  </div>;
}
export function Mogra({ n = 9 }: { n?: number }) {
  return <div className="h3-mogra" aria-hidden="true">{Array.from({ length: n }, (_, i) => i % 4 === 3 ? <Marigold key={i} size={18} tone={1} /> : <Jasmine key={i} size={18} />)}</div>;
}

/* ── stickers (owner's desi art; no brands, logos or watermarks) ─────────── */
export type StickerName = 'chai' | 'auto' | 'fav' | 'swag' | 'kachori' | 'lkk' | 'lotus' | 'peace' | 'girlboss' | 'pco' | 'nazar' | 'yaari' | 'mehman' | 'mohmaya' | 'chugli' | 'aalsi' | 'panipilo' | 'kyabaat';
const POSTER: Partial<Record<StickerName, true>> = { kachori: true, lkk: true, lotus: true, peace: true, girlboss: true, pco: true, nazar: true, chugli: true, kyabaat: true };
export function Sticker({ name, w, rot = -5, wiggle = false, alt = '' }: { name: StickerName; w: number; rot?: number; wiggle?: boolean; alt?: string }) {
  const src = publicImage(`/hf/stickers/${name}.webp`, { width: w > 210 ? 420 : 256 });
  return <img src={src} alt={alt} loading="lazy" decoding="async" draggable={false}
    className={`h3-stk${POSTER[name] ? ' poster' : ''}${wiggle ? ' h3-wiggle' : ''}`} style={{ width: w, ['--rot' as string]: `${rot}deg` }} />;
}

/* ── layout bits ─────────────────────────────────────────────────────────── */
export function Card({ title, note, children, link, right, tone = 0, id, className = '' }: { title: ReactNode; note?: ReactNode; children: ReactNode; link?: { label: string; href: string }; right?: ReactNode; tone?: 0 | 1; id?: string; className?: string }) {
  return <section className={`h3-card ${className}`} id={id}>
    <div className="top">
      <div><h2><Marigold size={20} tone={tone} />{title}</h2>{note && <div className="note">{note}</div>}</div>
      {link ? <a className="h3-link" href={link.href}>{link.label} →</a> : right ?? null}
    </div>
    {children}
  </section>;
}
export function PageHead({ eyebrow, title, sub, art }: { eyebrow: string; title: ReactNode; sub?: ReactNode; art?: ReactNode }) {
  return <header className="h3-pagehead">
    <div style={{ flex: 1, minWidth: '14rem' }}><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>
    {art && <div style={{ flex: 'none', marginRight: 8 }}>{art}</div>}
  </header>;
}
const PAL = ['#d81b72', '#6d4fd0', '#0e7c86', '#ea6a12', '#4a1747', '#b45309', '#c0262d'];
export const avColor = (s: string) => PAL[[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % PAL.length];
export const initials = (s: string | null | undefined) => (String(s || '?').trim().split(/\s+/).slice(0, 2).map(w => Array.from(w)[0] ?? '').join('') || '?').toLocaleUpperCase();
export function Avatar({ name, seed, size = 'sm', photo }: { name: string | null | undefined; seed: string; size?: 'sm' | '' | 'lg'; photo?: string | null }) {
  if (photo) return <img className={`h3-av ${size}`} src={photo} alt="" width={size === 'lg' ? 84 : size === 'sm' ? 40 : 48} height={size === 'lg' ? 84 : size === 'sm' ? 40 : 48} loading="lazy" style={{ objectFit: 'cover' }} />;
  return <div className={`h3-av ${size}`} style={{ background: avColor(seed) }} aria-hidden="true">{initials(name)}</div>;
}
export function Pill({ presence }: { presence: 'online' | 'busy' | 'offline' }) {
  const t = presence === 'online' ? ['on', 'Online'] : presence === 'busy' ? ['busy', 'On a call'] : ['off', 'Offline'];
  return <span className={`h3-pill ${t[0]}`}>{t[1]}</span>;
}
export function Empty({ text, children }: { text: ReactNode; children?: ReactNode }) {
  return <div className="h3-empty"><Lotus size={84} /><p>{text}</p>{children}</div>;
}
export function Failed({ onRetry, text = 'We could not load this.' }: { onRetry?: () => void; text?: string }) {
  return <div className="h3-failed" role="status">{text}{onRetry && <button type="button" className="h3-link" onClick={onRetry}>Try again</button>}</div>;
}
export const Skel = ({ h = 120 }: { h?: number }) => <div className="sk" style={{ height: h, width: '100%', display: 'block' }} aria-hidden="true" />;

/* ── dialog (native <dialog>, top layer) ─────────────────────────────────── */
export function Dialog({ open, onClose, children, label }: { open: boolean; onClose: () => void; children: ReactNode; label: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current; if (!d) return;
    if (open && !d.open) { try { d.showModal(); } catch { d.setAttribute('open', ''); } }
    if (!open && d.open) d.close();
  }, [open]);
  return <dialog ref={ref} className="h3-dlg" aria-label={label} onClose={onClose} onClick={e => { if (e.target === ref.current) onClose(); }}>
    {open && <div className="in"><button type="button" className="h3-iconbtn x" aria-label="Close" onClick={onClose}><Ic name="x" className="" /></button>{children}</div>}
  </dialog>;
}

/* ── toast ───────────────────────────────────────────────────────────────── */
const ToastCtx = createContext<(msg: string) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback((m: string) => { setMsg(m); clearTimeout(t.current); t.current = setTimeout(() => setMsg(null), 3600); }, []);
  return <ToastCtx.Provider value={show}>{children}<div className="h3-toast" role="status" aria-live="polite" hidden={!msg}>{msg}</div></ToastCtx.Provider>;
}

/** Marigold and jasmine petals falling over `box` (a celebration after a top-up). Skipped for reduced motion. */
export function Petals({ run }: { run: number }) {
  const [items, setItems] = useState<number[]>([]);
  useEffect(() => {
    if (!run || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setItems(Array.from({ length: 24 }, (_, i) => i));
    const id = setTimeout(() => setItems([]), 3200);
    return () => clearTimeout(id);
  }, [run]);
  return <>{items.map(i => <div key={`${run}-${i}`} className="h3-petal" style={{ left: `${(i * 37) % 100}%`, animationDelay: `${(i % 6) * 0.12}s` }}>{i % 3 ? <Marigold size={18 + (i % 4) * 6} tone={(i % 2) as 0 | 1} /> : <Jasmine size={18} />}</div>)}</>;
}

/* ── formatting ──────────────────────────────────────────────────────────── */
export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-IN');
export const minutes = (sec: number) => Math.round(sec / 60);
export const istDay = (ms: number) => new Date(ms).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
export const istTime = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
export const durationText = (sec: number) => sec >= 60 ? `${Math.floor(sec / 60)} min ${sec % 60 ? `${sec % 60} s` : ''}`.trim() : `${sec} s`;
