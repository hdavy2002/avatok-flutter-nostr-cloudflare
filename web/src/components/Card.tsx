import type { ReactNode } from 'react';

export interface CardProps {
  children: ReactNode;
  /** zine surface color class fill, default card. e.g. 'bg-card' | 'bg-paper2'. */
  fillClassName?: string;
  /** Tap target — adds press-into-paper interaction. */
  onClick?: () => void;
  /** Shadow size: 'sm' (default), 'lg', or 'none'. */
  shadow?: 'sm' | 'lg' | 'none';
  className?: string;
  as?: 'div' | 'article' | 'section';
}

const SHADOW = { sm: 'shadow-zine-sm', lg: 'shadow-zine', none: '' } as const;

/** Container card — card fill, 2.5px ink border, 22px radius, hard shadow. */
export function Card({
  children,
  fillClassName = 'bg-card',
  onClick,
  shadow = 'sm',
  className = '',
  as = 'div',
}: CardProps) {
  const Tag = onClick ? 'button' : as;
  const interactive = onClick
    ? 'transition-transform duration-zine ease-out active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed text-left w-full'
    : '';
  return (
    <Tag
      {...(onClick ? { type: 'button', onClick } : {})}
      className={[
        'rounded-zine border-zine border-ink p-[18px]',
        fillClassName,
        SHADOW[shadow],
        interactive,
        className,
      ].join(' ')}
    >
      {children}
    </Tag>
  );
}

export default Card;
