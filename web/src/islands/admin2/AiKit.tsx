// [SAATHUM-PREETI-1 2026-09-30] Small shared pieces for the Admin 2 AI assistant tabs.
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export const CARD = 'rounded-xl border border-border bg-card p-4 shadow-sm sm:p-6';
export const H2 = 'font-dash text-[20px] font-bold text-grand-teal';
export const LABEL = 'font-dashbody text-[14px] font-bold text-foreground';
export const HINT = 'text-[13px] font-semibold leading-relaxed text-muted-foreground';
export const TEXTAREA =
  'w-full rounded-md border border-input bg-background px-3 py-2 font-dashbody text-[15px] font-semibold leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';

export function Section({ title, children, aside, className }: { title: string; children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <section className={cn(CARD, className)}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className={H2}>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-9 items-center rounded-full border px-3 font-dashbody text-[13px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'border-accent bg-accent text-accent-foreground' : 'border-border/70 bg-card text-foreground hover:bg-muted',
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
