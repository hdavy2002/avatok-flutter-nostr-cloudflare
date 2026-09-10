import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

export interface ModalProps {
  open: boolean;
  onClose?: () => void;
  /** Optional Fredoka title row. */
  title?: ReactNode;
  children: ReactNode;
  /** Allow closing via backdrop click / Escape. Default true. */
  dismissable?: boolean;
  /** Max width in px. */
  maxWidth?: number;
  className?: string;
}

/** Centered zine modal — paper-ish card (rounded-zineLg, 24px), 3px ink
 * border, big hard shadow. Scales up from center on open via `.t-modal`
 * (transitions.dev's modal snippet, `src/styles/motion.css`); mounting is
 * gated on `open` here rather than on `.is-closing`, so there is no exit
 * animation on unmount yet — a fine default for a component that already
 * mounts/unmounts cheaply. */
export function Modal({ open, onClose, title, children, dismissable = true, maxWidth = 440, className = '' }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissable) onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, dismissable, onClose]);

  // [UI-MOTION-1] `.t-modal` needs a "closed" frame in the DOM before
  // `.is-open` lands, or the CSS transition has nothing to tween from — the
  // element would just appear already scaled to 1. Mount at scale(--modal-scale),
  // then flip the class on the next frame.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (!open) { setEntered(false); return; }
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(35,27,20,0.45)' }}
      onClick={dismissable ? onClose : undefined}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={['t-modal flex max-h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden rounded-zineLg border-zineLg border-ink bg-card shadow-zine p-6', entered && 'is-open', className].join(' ')}
        style={{ maxWidth }}
        onClick={(e) => e.stopPropagation()}
      >
        {title && <div className="mb-4 flex-none font-display font-semibold text-[24px] leading-tight text-ink">{title}</div>}
        <div className="min-h-0 overflow-y-auto overscroll-contain pr-1">
          {children}
        </div>
      </div>
    </div>
  );
}

export default Modal;
