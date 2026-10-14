/* [HF-DASH-SUMMARY-1] Dashboard Overview summary: one call, role-aware, every part may be null when it could not be read. */
import { hfCall, type HfResult } from './hfCallsApi';

export interface DashRecentCall { id: string; otherHandle: string; status: string; at: number; seconds: number; amountPaise: number | null }
export interface DashSummary {
  ok: boolean;
  role: 'host' | 'customer';
  callsToday: { made: number | null; received: number | null };
  appointmentsToday: number | null;
  expectedHostNetPaise: number | null;
  fraands: { saved: number | null; newThisWeek: number | null };
  recentMade: DashRecentCall[] | null;
}

export function getDashSummary(opts: { isCurrent?: () => boolean } = {}): Promise<HfResult<DashSummary>> {
  return hfCall<DashSummary>('GET', '/api/hf/me/summary', undefined, opts);
}

/** How many numbers this role shows that came back empty (reported with the load event). */
export function partsFailed(s: DashSummary): number {
  const host = s.role === 'host';
  const parts = host
    ? [s.callsToday.received, s.appointmentsToday, s.expectedHostNetPaise, s.fraands.newThisWeek]
    : [s.callsToday.made, s.appointmentsToday, s.fraands.saved, s.recentMade];
  return parts.filter(v => v === null || v === undefined).length;
}
