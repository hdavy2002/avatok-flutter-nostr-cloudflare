import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Spinner } from './Spinner';

export type ButtonVariant = 'lime' | 'blue' | 'coral' | 'ghost';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  /** lime = primary (ONE per screen), coral = destructive (white text), blue, ghost. */
  variant?: ButtonVariant;
  /** Optional leading or trailing icon node. */
  icon?: ReactNode;
  trailingIcon?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  /** Label text (or pass children). */
  label?: string;
  children?: ReactNode;
  className?: string;
}

const FILL: Record<ButtonVariant, string> = {
  lime: 'bg-lime text-ink',
  blue: 'bg-blue text-ink',
  coral: 'bg-coral text-white', // the ONLY fill that takes white text (zine §2)
  ghost: 'bg-card text-ink',
};

/**
 * Primary zine button — pill, 2.5px ink border, hard offset shadow that
 * collapses on press (object presses INTO the paper). Mirrors ZineButton.
 */
export function Button({
  variant = 'lime',
  icon,
  trailingIcon = true,
  loading = false,
  fullWidth = false,
  label,
  children,
  disabled,
  className = '',
  ...rest
}: ButtonProps) {
  const isDisabled = disabled || loading;
  const content = label ?? children;

  if (isDisabled) {
    return (
      <button
        type="button"
        disabled
        className={[
          'inline-flex items-center justify-center gap-2.5 select-none',
          'rounded-full border-zine border-inkMute bg-paper2 text-inkMute',
          'px-6 py-3.5 font-display font-semibold text-[19px] leading-none tracking-[-0.2px]',
          fullWidth ? 'w-full' : '',
          className,
        ].join(' ')}
        {...rest}
      >
        {loading && <Spinner size={18} color="var(--zine-inkMute)" />}
        {!loading && icon && !trailingIcon && <span className="text-[21px]">{icon}</span>}
        {content}
        {!loading && icon && trailingIcon && <span className="text-[21px]">{icon}</span>}
      </button>
    );
  }

  return (
    <button
      type="button"
      className={[
        'inline-flex items-center justify-center gap-2.5 select-none',
        'rounded-full border-zine border-ink shadow-zine-sm',
        'transition-transform duration-zine ease-out',
        'active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed',
        'px-6 py-3.5 font-display font-semibold text-[19px] leading-none tracking-[-0.2px]',
        FILL[variant],
        fullWidth ? 'w-full' : '',
        className,
      ].join(' ')}
      {...rest}
    >
      {icon && !trailingIcon && <span className="text-[21px] leading-none">{icon}</span>}
      <span className="truncate">{content}</span>
      {icon && trailingIcon && <span className="text-[21px] leading-none">{icon}</span>}
    </button>
  );
}

export default Button;
