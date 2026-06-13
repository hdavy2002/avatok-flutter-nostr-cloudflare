import { useEffect } from 'react';
import type { ReactNode } from 'react';

export interface SheetProps {
  open: boolean;
  onClose?: () => void;
  title?: ReactNode;
  children: ReactNode;
  dismissable?: boolean;
  className?: string;
}

/**
 * Bottom sheet — slides up from the bottom edge, ink top border + big shadow.
 * Mobile-first sibling of {@link Modal}; same dismiss semantics.
 */
export function Sheet({ open, onClose, title, children, dismissable = true, className = '' }: SheetProps) {
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
      className="fixed inset-0 z-50 flex items-end justify-center"
      style={{ background: 'rgba(35,27,20,0.45)' }}
      onClick={dismissable ? onClose : undefined}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={[
          'w-full max-w-[640px] rounded-t-zine border-zineLg border-ink bg-card shadow-zine p-6 pb-8',
          className,
        ].join(' ')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-inkMute" aria-hidden />
        {title && <div className="mb-4 font-display font-semibold text-[22px] leading-tight text-ink">{title}</div>}
        {children}
      </div>
    </div>
  );
}

export default Sheet;
