import type { ReactNode } from 'react';

export type PillKind = 'ok' | 'no' | 'hint' | 'plain';

export interface PillProps {
  children: ReactNode;
  /** ok = lime, no = coral (white text), hint = ghost (muted, no shadow), plain = card. */
  kind?: PillKind;
  icon?: ReactNode;
  onClick?: () => void;
  className?: string;
}

const STYLE: Record<PillKind, { fill: string; border: string; shadow: string }> = {
  ok: { fill: 'bg-lime text-ink', border: 'border-ink', shadow: 'shadow-zine-xs' },
  no: { fill: 'bg-coral text-white', border: 'border-ink', shadow: 'shadow-zine-xs' },
  hint: { fill: 'bg-card text-inkSoft', border: 'border-inkMute', shadow: '' },
  plain: { fill: 'bg-card text-ink', border: 'border-ink', shadow: 'shadow-zine-xs' },
};

/** Sticker / tag pill (mirrors ZineSticker) — UPPERCASE mono label. */
export function Pill({ children, kind = 'plain', icon, onClick, className = '' }: PillProps) {
  const s = STYLE[kind];
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      {...(onClick ? { type: 'button', onClick } : {})}
      className={[
        'inline-flex items-center gap-1.5 rounded-full border-zine px-2.5 py-1',
        'font-mono font-bold uppercase text-[12px] tracking-[0.04em]',
        s.fill,
        s.border,
        s.shadow,
        className,
      ].join(' ')}
    >
      {icon && <span className="text-[14px] leading-none">{icon}</span>}
      <span className="truncate">{children}</span>
    </Tag>
  );
}

export default Pill;
