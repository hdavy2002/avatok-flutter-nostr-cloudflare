// [HF-SUPPORT-DESK] Shared pieces: corner flowers, chips, avatars, menus, modal, toasts, the 6-digit code boxes.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { initials } from './format';

/* ── colours (the approved mock-ups) ───────────────────────────────────── */
export const C = {
  parchment: '#E9DCC9', ivory: '#FFFAF3', plum: '#4A1747', ink: '#2B1530', muted: '#6F5B6F', line: '#D8C5A9', adminLine: '#E4D6C2',
  violet: '#6D4FD0', lilac: '#F1EBFF', pink: '#D81B72', rose: '#C2185B', amber: '#F59E0B', orange: '#EA6A12', teal: '#0E7C86', red: '#C0262D',
};

/** Status chip colours exactly as in the designs. */
export function statusTone(status: string): { tint: string; ink: string } {
  switch (status) {
    case 'waiting': return { tint: '#E3F6E8', ink: '#1F6B3F' }; // We replied
    case 'solved': return { tint: '#F1EBFF', ink: '#6D4FD0' };
    case 'closed': case 'trash': return { tint: '#F8EEE6', ink: '#6F5B6F' };
    case 'spam': return { tint: '#FFE6EF', ink: '#C0262D' };
    case 'on_hold': return { tint: '#E3F6F6', ink: '#0E7C86' };
    default: return { tint: '#FFF1D6', ink: '#B45309' }; // new, open
  }
}
export const PRIORITY_DOT: Record<string, string> = { urgent: '#C0262D', high: '#EA6A12', normal: '#6D4FD0', low: '#B8A9B8' };
export const PRIORITY_LABEL: Record<string, string> = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };
export function categoryTone(cat: string): { tint: string; ink: string } {
  switch (cat) {
    case 'withdraw': return { tint: '#E3F6F6', ink: '#0E7C86' };
    case 'report': return { tint: '#FFE6EF', ink: '#C2185B' };
    case 'wallet': return { tint: '#FFF1D6', ink: '#B45309' };
    case 'calls': case 'bookings': return { tint: '#F1EBFF', ink: '#6D4FD0' };
    case 'influencer': return { tint: '#E3F6E8', ink: '#1F6B3F' };
    default: return { tint: '#F8EEE6', ink: '#6F5B6F' };
  }
}
export function priorityChipTone(p: string): { tint: string; ink: string } {
  if (p === 'urgent') return { tint: '#FFE6EF', ink: '#C0262D' };
  if (p === 'high') return { tint: '#FFE6EF', ink: '#C2185B' };
  if (p === 'low') return { tint: '#F8EEE6', ink: '#6F5B6F' };
  return { tint: '#F1EBFF', ink: '#6D4FD0' };
}

/* ── flowers: decorative, sit in a card corner and never cover text ─────── */
export function Flower({ petal = '#F59E0B', centre = '#EA6A12', dot, size = 40, eight = false, className = '' }: { petal?: string; centre?: string; dot?: string; size?: number; eight?: boolean; className?: string }) {
  return (
    <svg className={`hfs-flower ${className}`} width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <g fill={petal}>
        <circle cx="20" cy="9" r="7" /><circle cx="31" cy="20" r="7" /><circle cx="20" cy="31" r="7" /><circle cx="9" cy="20" r="7" />
        {eight && <><circle cx="28" cy="12" r="6" /><circle cx="28" cy="28" r="6" /><circle cx="12" cy="28" r="6" /><circle cx="12" cy="12" r="6" /></>}
      </g>
      <circle cx="20" cy="20" r={eight ? 8 : 6} fill={centre} />
      {dot && <circle cx="20" cy="20" r="3.5" fill={dot} />}
    </svg>
  );
}
export const Marigold = (p: { size?: number; className?: string }) => <Flower {...p} eight dot="#B45309" />;
export const Lilac = (p: { size?: number; className?: string }) => <Flower petal="#C4B5FD" centre="#6D4FD0" {...p} />;
export const Rose = (p: { size?: number; className?: string }) => <Flower petal="#F9A8C9" centre="#D81B72" {...p} />;
export const Gold = (p: { size?: number; className?: string }) => <Flower petal="#F59E0B" centre="#EA6A12" {...p} />;

/* ── small things ──────────────────────────────────────────────────────── */
export function Chip({ tint, ink, children, title, className = '' }: { tint: string; ink: string; children: ReactNode; title?: string; className?: string }) {
  return <span className={`hfs-chip ${className}`} title={title} style={{ background: tint, color: ink }}>{children}</span>;
}

export function Avatar({ name, size = 40, tone = 'lilac' }: { name: string; size?: number; tone?: 'lilac' | 'plum' }) {
  const s: CSSProperties = { width: size, height: size, borderRadius: size / 2, fontSize: Math.round(size * 0.38) };
  return <span className={`hfs-avatar hfs-avatar--${tone}`} style={s} aria-hidden="true">{initials(name)}</span>;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="hfs-spinner" role="status" aria-label={label} />;
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="hfs-empty">
      <Marigold size={44} />
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="hfs-error" role="alert">
      <span>{message}</span>
      {onRetry && <button type="button" className="hfs-btn hfs-btn--ghost hfs-btn--sm" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function Icon({ name, size = 20 }: { name: 'plus' | 'back' | 'paperclip' | 'image' | 'search' | 'check' | 'x' | 'bell' | 'chevron' | 'print'; size?: number }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.3, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, focusable: false };
  switch (name) {
    case 'plus': return <svg {...p}><path d="M12 5v14M5 12h14" /></svg>;
    case 'back': return <svg {...p}><path d="M19 12H5" /><path d="M11 6l-6 6 6 6" /></svg>;
    case 'paperclip': return <svg {...p}><path d="M21 12.5l-8.5 8.5a5 5 0 0 1-7-7L14 5.5a3.5 3.5 0 0 1 5 5L10.5 19a2 2 0 0 1-3-3L15 8.5" /></svg>;
    case 'image': return <svg {...p}><rect x="3" y="5" width="18" height="14" rx="3" /><circle cx="9" cy="11" r="2" /><path d="M21 16l-5-5-8 8" /></svg>;
    case 'search': return <svg {...p}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>;
    case 'check': return <svg {...p}><path d="M5 12.5l4.5 4.5L19 7" /></svg>;
    case 'x': return <svg {...p}><path d="M6 6l12 12M18 6L6 18" /></svg>;
    case 'bell': return <svg {...p}><path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7z" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>;
    case 'chevron': return <svg {...p}><path d="M6 9l6 6 6-6" /></svg>;
    case 'print': return <svg {...p}><path d="M7 9V4h10v5" /><rect x="4" y="9" width="16" height="8" rx="2" /><path d="M7 14h10v6H7z" /></svg>;
  }
}

/* ── hooks ─────────────────────────────────────────────────────────────── */
export function useInterval(fn: () => void, ms: number | null): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms == null) return;
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => { const id = setTimeout(() => setV(value), ms); return () => clearTimeout(id); }, [value, ms]);
  return v;
}

/** Pause polling while the tab is hidden. */
export function usePageVisible(): boolean {
  const [vis, setVis] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const f = () => setVis(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', f);
    return () => document.removeEventListener('visibilitychange', f);
  }, []);
  return vis;
}

/* ── menu: a button with a popover list ────────────────────────────────── */
export function Menu({ label, children, className = 'hfs-btn hfs-btn--pill', align = 'left', disabled, title }: {
  label: ReactNode; children: (close: () => void) => ReactNode; className?: string; align?: 'left' | 'right'; disabled?: boolean; title?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="hfs-menu" ref={box}>
      <button type="button" className={className} aria-haspopup="menu" aria-expanded={open} disabled={disabled} title={title} onClick={() => setOpen((o) => !o)}>{label}</button>
      {open && <div className={`hfs-menu__list hfs-menu__list--${align}`} role="menu">{children(close)}</div>}
    </div>
  );
}
export function MenuItem({ children, onClick, danger, active, disabled }: { children: ReactNode; onClick: () => void; danger?: boolean; active?: boolean; disabled?: boolean }) {
  return <button type="button" role="menuitem" disabled={disabled} className={`hfs-menu__item${danger ? ' is-danger' : ''}${active ? ' is-active' : ''}`} onClick={onClick}>{children}</button>;
}

/* ── modal ─────────────────────────────────────────────────────────────── */
export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('keydown', esc); prev?.focus?.(); };
  }, []);
  return (
    <div className="hfs-modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`hfs-modal__panel${wide ? ' is-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={panel}>
        <div className="hfs-modal__head">
          <h2>{title}</h2>
          <button type="button" className="hfs-iconbtn" aria-label="Close" onClick={onClose}><Icon name="x" size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ── toasts ────────────────────────────────────────────────────────────── */
interface ToastItem { id: number; text: string; kind: 'ok' | 'error' | 'info'; action?: { label: string; run: () => void } }
type ToastFn = (text: string, kind?: ToastItem['kind'], action?: ToastItem['action']) => void;
const ToastCtx = createContext<ToastFn>(() => undefined);
export const useToast = (): ToastFn => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(1);
  const toast = useCallback<ToastFn>((text, kind = 'ok', action) => {
    const id = idRef.current++;
    setItems((l) => [...l.slice(-3), { id, text, kind, action }]);
    setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), action ? 9000 : kind === 'error' ? 6500 : 3800);
  }, []);
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="hfs-toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`hfs-toast hfs-toast--${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            <span>{t.text}</span>
            {t.action && <button type="button" onClick={() => { t.action!.run(); setItems((l) => l.filter((x) => x.id !== t.id)); }}>{t.action.label}</button>}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ── six boxes for a one-time code ─────────────────────────────────────── */
export function CodeBoxes({ value, onChange, onComplete, length = 6, disabled, autoFocus, label = 'Code' }: {
  value: string; onChange: (v: string) => void; onComplete?: (v: string) => void; length?: number; disabled?: boolean; autoFocus?: boolean; label?: string;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = value.padEnd(length, ' ').slice(0, length).split('');
  useEffect(() => { if (autoFocus) refs.current[0]?.focus(); }, [autoFocus]);
  const set = (next: string) => {
    const clean = next.replace(/\D/g, '').slice(0, length);
    onChange(clean);
    if (clean.length === length) onComplete?.(clean);
  };
  return (
    <div className="hfs-code" role="group" aria-label={label}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          className={d.trim() ? 'is-filled' : ''}
          aria-label={`Digit ${i + 1}`}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={length}
          disabled={disabled}
          value={d.trim()}
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            const raw = e.target.value.replace(/\D/g, '');
            if (raw.length > 1) { set(raw); refs.current[Math.min(raw.length, length) - 1]?.focus(); return; }
            const pos = Math.min(i, value.length);
            const next = raw ? value.slice(0, pos) + raw + value.slice(pos + (i < value.length ? 1 : 0)) : value.slice(0, i) + value.slice(i + 1);
            set(next);
            if (raw) refs.current[Math.min(pos + 1, length - 1)]?.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !d.trim() && i > 0) { refs.current[i - 1]?.focus(); }
            if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus();
            if (e.key === 'ArrowRight' && i < length - 1) refs.current[i + 1]?.focus();
          }}
          onPaste={(e) => { const t = e.clipboardData.getData('text'); if (t) { e.preventDefault(); set(t); refs.current[Math.min(t.replace(/\D/g, '').length, length) - 1]?.focus(); } }}
        />
      ))}
    </div>
  );
}

export function useCountdown(until: number): number {
  const [n, setN] = useState(() => Math.max(0, Math.ceil((until - Date.now()) / 1000)));
  useEffect(() => {
    setN(Math.max(0, Math.ceil((until - Date.now()) / 1000)));
    const id = setInterval(() => setN(Math.max(0, Math.ceil((until - Date.now()) / 1000))), 500);
    return () => clearInterval(id);
  }, [until]);
  return n;
}
