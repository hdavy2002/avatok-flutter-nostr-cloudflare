// [DASH2-PROFILE 2026-09-25] shadcn-style Switch without @radix-ui/react-switch
// (not installed; no new packages). An accessible <button role="switch">:
// Space/Enter toggle it natively, aria-checked carries the state, and the
// data-state attribute matches the shadcn source so styling reads the same.
import * as React from 'react';
import { cn } from '../../lib/utils';

export interface SwitchProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'value'> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ className, checked, onCheckedChange, disabled, onClick, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      data-state={checked ? 'checked' : 'unchecked'}
      disabled={disabled}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) onCheckedChange?.(!checked);
      }}
      className={cn(
        'peer inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
        'data-[state=checked]:bg-accent data-[state=unchecked]:bg-input/70',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        data-state={checked ? 'checked' : 'unchecked'}
        className="pointer-events-none block h-6 w-6 rounded-full bg-card shadow-md ring-0 transition-transform duration-200 motion-reduce:transition-none data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0"
      />
    </button>
  ),
);
Switch.displayName = 'Switch';

export { Switch };
