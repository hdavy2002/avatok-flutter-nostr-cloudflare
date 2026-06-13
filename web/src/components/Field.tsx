import { useState } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  /** UPPERCASE mono label above the field. */
  label?: string;
  /** Short leading-cell glyph ("@", "$") rendered on a lime cell. */
  lead?: string;
  /** Error message — turns the focus shadow coral and shows the line below. */
  error?: string | null;
  trailing?: ReactNode;
  className?: string;
}

/**
 * Text input in the zine field chrome — bordered pill box, optional lime lead
 * cell, focus lifts the box and shows a blue-ink hard shadow (coral on error).
 * Mirrors ZineField.
 */
export function Field({ label, lead, error, trailing, className = '', ...input }: FieldProps) {
  const [focused, setFocused] = useState(false);
  const shadow = error ? 'shadow-zine-error' : focused ? 'shadow-zine-focus' : 'shadow-zine-sm';
  const lift = focused && !error ? '-translate-x-[1px] -translate-y-[1px]' : '';

  return (
    <label className={['block', className].join(' ')}>
      {label && (
        <span className="mb-2 block font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-inkSoft">
          {label}
        </span>
      )}
      <span
        className={[
          'flex items-stretch overflow-hidden rounded-zineField border-zine border-ink bg-card',
          'transition-transform duration-zine ease-out',
          shadow,
          lift,
        ].join(' ')}
      >
        {lead && (
          <span className="flex w-[50px] items-center justify-center border-r-zine border-ink bg-lime font-display font-semibold text-[22px] text-ink">
            {lead}
          </span>
        )}
        <input
          {...input}
          onFocus={(e) => {
            setFocused(true);
            input.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            input.onBlur?.(e);
          }}
          className="min-w-0 flex-1 bg-transparent px-3.5 py-4 font-body font-extrabold text-[18px] text-ink outline-none placeholder:text-placeholder placeholder:font-bold"
        />
        {trailing && <span className="flex items-center border-l-zine border-ink px-3">{trailing}</span>}
      </span>
      {error && (
        <span className="mt-2 block font-mono font-bold uppercase text-[12px] tracking-[0.04em] text-coral">
          ⚠ {error}
        </span>
      )}
    </label>
  );
}

export default Field;
