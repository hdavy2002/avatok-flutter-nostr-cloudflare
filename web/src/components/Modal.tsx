import { useEffect } from 'react';
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

/** Centered zine modal — paper-ish card, 3px ink border, big hard shadow. */
export function Modal({ open, onClose, title, children, dismissable = true, maxWidth = 440, className = '' }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissable) onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, dismissable, onClose]);

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
        className={['w-full rounded-zine border-zineLg border-ink bg-card shadow-zine p-6', className].join(' ')}
        style={{ maxWidth }}
        onClick={(e) => e.stopPropagation()}
      >
        {title && <div className="mb-4 font-display font-semibold text-[24px] leading-tight text-ink">{title}</div>}
        {children}
      </div>
    </div>
  );
}

export default Modal;
