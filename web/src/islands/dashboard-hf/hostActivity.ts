/* [HF-DASH-SHELL-2] Host call-list parsing shared by the Overview, Calls and Earnings sections (moved from HostDashboard.tsx). */
import { toMs } from '../../lib/hfCallsApi';
import { formatPaise } from '../../lib/money';

export const BEAT_MS = 5 * 60_000;
export const REFRESH_MS = 60_000;

export interface MeHost { slug: string | null; status: string; displayName: string | null; presence?: string | null }
export interface Row { id: string; status: string; handle: string; at: number | null; minutes: number; earned: number | null; seconds?: number }
export interface Today { calls: number; minutes: number; earned: number }

export const STATUS_NOTE: Record<string, string> = {
  draft: 'You haven’t finished your profile yet.',
  generating: 'We’re preparing your profile.',
  pending_host: 'Your profile is ready. Please check it and send it for review.',
  pending_review: 'Our team is checking your profile. We’ll WhatsApp you when you’re live, usually within 24 hours.',
  paused: 'Your profile is paused for now. Please contact support if you’re not sure why.',
  rejected: 'Your profile needs some changes before it can go live.',
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
function normRow(x: Record<string, unknown>): Row {
  const paise = num(x.hostEarningPaise) ?? num(x.earningPaise);
  return {
    id: String(x.id ?? Math.random()),
    status: String(x.status ?? ''),
    handle: String(x.callerHandle ?? x.handle ?? x.caller ?? 'A caller'),
    at: toMs((x.connectedAt ?? x.createdAt ?? x.startedAt ?? null) as number | string | null),
    minutes: num(x.billedMinutes) ?? 0,
    seconds: num(x.billableSeconds) ?? undefined,
    earned: num(x.hostEarningRupees) ?? num(x.earnedRupees) ?? num(x.earningRupees) ?? (paise != null ? paise / 100 : null),
  };
}
export function parseCalls(d: unknown): { rows: Row[]; today: Today } {
  const obj = (Array.isArray(d) ? { items: d } : (d ?? {})) as Record<string, unknown>;
  if (!Array.isArray(obj.items) && !Array.isArray(obj.calls)) throw new Error('Invalid call response');
  const list = (Array.isArray(obj.items) ? obj.items : Array.isArray(obj.calls) ? obj.calls : []) as Record<string, unknown>[];
  const rows = list.map(normRow);
  const t = obj.today as Record<string, unknown> | undefined;
  if (t && typeof t === 'object') {
    return { rows, today: { calls: num(t.calls) ?? 0, minutes: num(t.minutes) ?? 0, earned: num(t.earningRupees) ?? num(t.earnedRupees) ?? ((num(t.earningPaise) ?? 0) / 100) } };
  }
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const todays = rows.filter(r => r.status === 'completed' && r.at != null && r.at >= start.getTime());
  return { rows, today: { calls: todays.length, minutes: todays.reduce((a, r) => a + r.minutes, 0), earned: todays.reduce((a, r) => a + (r.earned ?? 0), 0) } };
}
export function rowText(r: Row): string {
  switch (r.status) {
    case 'completed': return `${r.seconds != null ? `${Math.floor(r.seconds / 60)} min ${r.seconds % 60} s` : `${r.minutes} min`}${r.earned != null ? ` · ${formatPaise(Math.round(r.earned * 100))}` : ''}`;
    case 'connected': return 'On a call now';
    case 'ringing_host': case 'ringing_caller': return 'Ringing';
    case 'host_declined': return 'You declined';
    case 'no_answer': return 'Missed';
    case 'caller_no_answer': return 'Caller didn’t pick up';
    case 'blocked': return 'Ended and blocked';
    default: return 'Not connected';
  }
}

