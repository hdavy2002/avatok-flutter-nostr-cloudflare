// [SAATHUM-PREETI-1 2026-09-30] Small shared pieces for the Admin 2 AI assistant tabs.
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { DesiCard, type Corner, type Tone } from './desi';

export const CARD = 'hf-admin-op-card rounded-xl border border-border bg-card p-4 shadow-sm sm:p-6';
export const H2 = 'font-dash text-[20px] font-bold text-[var(--hf-admin-plum,#4a1747)]';
export const LABEL = 'font-dashbody text-[14px] font-bold text-foreground';
export const HINT = 'text-[14px] font-semibold leading-relaxed text-muted-foreground';
export const TEXTAREA =
  'w-full rounded-md border border-input bg-background px-3 py-2 font-dashbody text-[15px] font-semibold leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';

/** Tinted tile surfaces (soft wash + matching border) for rows, tiles and bubbles. */
export const TINT = {
  rani: 'border-[#f6c2d8] bg-[linear-gradient(160deg,#fff,var(--a-blush,#ffe6ef))]',
  lav: 'border-[#e4dafc] bg-[linear-gradient(160deg,#fff,var(--a-lavtint,#f1ebff))]',
  tea: 'border-[#cfe9eb] bg-[linear-gradient(160deg,#fff,var(--a-teatint,#e3f5f6))]',
  gold: 'border-[#f3dfb3] bg-[linear-gradient(160deg,#fff,var(--a-goldtint,#fff1d6))]',
  cream: 'border-[var(--a-line,#f1e3d6)] bg-[var(--a-cream,#fffaf3)]',
} as const;
export type TintKey = keyof typeof TINT;

export function Section({ title, children, aside, className, tone = 'cream', corner = 'jasmine', pattern }: {
  title: string; children: ReactNode; aside?: ReactNode; className?: string; tone?: Tone; corner?: Corner; pattern?: 'stripes' | 'dots' | 'bahi';
}) {
  return (
    <DesiCard title={title} action={aside} tone={tone} corner={corner} pattern={pattern} className={className}>
      {children}
    </DesiCard>
  );
}

const CHIP_ON = 'border-[var(--a-plum,#4a1747)] bg-[var(--a-plum,#4a1747)] text-white';
const CHIP_OFF: Record<'lav' | 'tea' | 'gold' | 'rani', string> = {
  lav: 'border-[#e4dafc] bg-[var(--a-lavtint,#f1ebff)] text-[var(--a-lav,#6d4fd0)] hover:bg-[#e6dcff]',
  tea: 'border-[#cfe9eb] bg-[var(--a-teatint,#e3f5f6)] text-[var(--a-peacock,#0e7c86)] hover:bg-[#d2eef0]',
  gold: 'border-[#f3dfb3] bg-[var(--a-goldtint,#fff1d6)] text-[var(--a-amber,#b45309)] hover:bg-[#ffe8bd]',
  rani: 'border-[#f6c2d8] bg-[var(--a-blush,#ffe6ef)] text-[var(--a-rani,#d81b72)] hover:bg-[#ffd6e5]',
};
export function Chip({ active, onClick, children, tone = 'lav' }: { active: boolean; onClick: () => void; children: ReactNode; tone?: 'lav' | 'tea' | 'gold' | 'rani' }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex min-h-[44px] shrink-0 items-center rounded-full border-2 px-4 font-dashbody text-[14px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? CHIP_ON : CHIP_OFF[tone],
      )}
    >
      {children}
    </button>
  );
}

/** "12 May, 3:04 pm" style relative-friendly time in IST. */
export function ago(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = Date.now() - ms;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`;
  return new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
}
