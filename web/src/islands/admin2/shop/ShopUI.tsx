/* ShopUI — [SAATHUM-SHOP-ADMIN-1 2026-10-01] Small shared pieces for the Shop admin screens:
 * the mockup's modal (`.sh-modal`), the right-hand drawer (`.sh-drawer`), image thumb with the
 * striped placeholder as the empty state, and the busy-button helper. Markup/classes are the
 * mockup's (Specs/shop-mockup/shop-main.html + shop.js); CSS lives in shopAdmin.css. */
import { useEffect, type ReactNode } from 'react';
import { DesiCard, Jasmine, Marigold } from '../desi';

export function Modal({ open, onClose, children, wide }: { open: boolean; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sh-modal is-on" role="dialog" aria-modal="true" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`sh-modal-box${wide ? ' sh-modal-box--wide' : ''}`}>
        <span className="sh-modal-art" aria-hidden="true"><Marigold size={58} tone={1} /><Jasmine size={26} /></span>
        {children}
      </div>
    </div>
  );
}

export function Drawer({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <>
      <div className={`sh-scrim${open ? ' is-on' : ''}`} onClick={onClose} />
      <aside className={`sh-drawer${open ? ' is-on' : ''}`} aria-label={title} aria-hidden={!open}>
        <div className="sh-dh"><h2><Marigold size={26} />{title}</h2><button type="button" className="sh-x" onClick={onClose} aria-label="Close">×</button></div>
        <div className="sh-drawer-body">{open ? children : null}</div>
      </aside>
    </>
  );
}

/** Product / collection thumbnail: the photo, or the mockup's striped placeholder when none yet. */
export function Thumb({ url }: { url: string | null | undefined }) {
  if (url) return <img src={url} alt="" loading="lazy" />;
  return <div className="sh-ph"><span>No photo</span></div>;
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return <p className="sh-empty-note" role="status">{label}</p>;
}

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert">
      <DesiCard tone="rani" corner="hibiscus" title="Couldn’t load this">
        <p className="sh-help">{message}</p>
        <button type="button" className="sh-btn sh-btn--teal" onClick={onRetry}>Try again</button>
      </DesiCard>
    </div>
  );
}
