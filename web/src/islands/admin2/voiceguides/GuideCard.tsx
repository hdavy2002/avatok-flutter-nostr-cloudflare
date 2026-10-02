/* Voice guides — card preview + status pill + form bits. [AUMFE-VOICE-ADMIN-1] */
import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';
import { Badge } from '../../../components/ui/badge';
import type { Guide, GuideStatus } from './api';

export const rupees = (tokens: number) => `₹${Math.round(tokens).toLocaleString('en-IN')}`; // 1 token = ₹1

const PILL: Record<GuideStatus, 'accent' | 'secondary' | 'muted' | 'outline'> = { live: 'accent', preview: 'secondary', draft: 'outline', archived: 'muted' };
export function StatusBadge({ status }: { status: string }) {
  return <Badge variant={PILL[status as GuideStatus] ?? 'muted'} className="capitalize">{status}</Badge>;
}

export function Avatar({ g, size = 56 }: { g: Pick<Guide, 'initial' | 'tint' | 'name' | 'avatar_url'>; size?: number }) {
  return (
    <span aria-hidden className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-dash font-bold text-white" style={{ width: size, height: size, background: g.tint || '#8a5a2b', fontSize: size * 0.42 }}>
      {g.avatar_url ? <img src={g.avatar_url} alt="" className="h-full w-full object-cover" /> : (g.initial || g.name.slice(0, 1) || '?').slice(0, 2)}
    </span>
  );
}

/** Mirrors the customer-facing card on /talk. */
export function GuideCardView({ g, onClick, stats }: { g: Guide; onClick?: () => void; stats?: boolean }) {
  const body = (
    <>
      <div className="flex items-start gap-3">
        <Avatar g={g} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-dash text-[18px] font-bold text-foreground">{g.name || 'New guide'}</p>
          <p className="truncate text-[14px] font-bold text-muted-foreground">{g.subject || 'Subject'}</p>
        </div>
        <StatusBadge status={g.status} />
      </div>
      <p className="mt-3 line-clamp-3 text-[14px] font-semibold leading-relaxed text-foreground">{g.blurb || 'A short line that tells customers what this guide helps with.'}</p>
      <p className="mt-3 font-dash text-[16px] font-bold text-grand-teal">{rupees(g.price_per_min_tokens || 0)}/min</p>
      {stats && (
        <p className="mt-2 text-[13px] font-semibold text-muted-foreground">
          Docs ready {g.docs_ready ?? 0}/{g.docs_total ?? 0} · {g.sessions_7d ?? 0} calls in 7 days
        </p>
      )}
    </>
  );
  const cls = 'block w-full rounded-xl border border-border bg-card p-4 text-left shadow-sm';
  return onClick
    ? <button type="button" onClick={onClick} className={cn(cls, 'min-h-[44px] transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}>{body}</button>
    : <div className={cls}>{body}</div>;
}

export const FIELD = 'h-11 w-full rounded-md border border-input bg-background px-3 font-dashbody text-[15px] font-semibold text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5">
      <span className="font-dashbody text-[14px] font-bold text-foreground">{label}</span>
      {children}
      {hint && <span className="text-[13px] font-semibold text-muted-foreground">{hint}</span>}
    </label>
  );
}

export function Pick({ value, onChange, options, label }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; label: string }) {
  const opts = options.some((o) => o.value === value) || !value ? options : [{ value, label: value }, ...options];
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={FIELD}>
      {!value && <option value="">Choose…</option>}
      {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
