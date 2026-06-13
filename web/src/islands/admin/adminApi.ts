/* AvaAdmin — typed fetch wrapper for /api/admin/* (PHASE 6).
 *
 * Mirrors lib/apiClient.ts but is OWNED by this phase (we do not edit the shared
 * apiClient). All calls go through the Worker; the PostHog personal key NEVER
 * reaches the browser. Response shapes here must match admin_dashboard.ts (the
 * glue note documents every shape for Phase Z to verify).
 */
import { useEffect, useState } from 'react';
import { request, ApiError } from '../../lib/apiClient';
import { getActiveToken } from '../../lib/clerk';

// ───────────────────────── response shapes ─────────────────────────
export interface Overview {
  ts: number;
  sessions: { live_streams: number; consults: number; conference: number | null; voice_calls: number; vision_calls: number; translation: number | null; total: number };
  money: { escrow_coins: number; fees_today_coins: number; fees_mtd_coins: number; gmv_today_coins: number };
  signups_today: number;
  needs_attention: { failed_settlements: number; recon_diffs: number; pending_payouts: number; open_reports: number; csam_hits: number; open_alerts: number };
  surfaces: Array<{ key: string; label: string; enabled: boolean }>;
}
export interface LiveSnapshot {
  ts: number;
  live_streams: any[]; consults: any[]; voice_calls: any[];
  vision_calls: any[]; vision_available: boolean;
  conference_rooms: { count: number | null; rooms: any[] };
  slot_utilization: { cap: number; voice: Array<{ agent_id: string; active: number }> };
  translation: { active: number | null };
}
export interface AgentsSnapshot {
  voice: { total_agents: number; active_sessions: number; calls_7d: number; gross_7d_coins: number };
  vision: { available: boolean; total_agents?: number; active_sessions?: number; calls_7d?: number; gross_7d_coins?: number; snapshots_7d?: number; avg_score?: number | null };
  ai_spend_14d: Array<{ day: string; calls: number; ms: number }>;
}
export interface Health {
  ts: number; queues: { settlement_dlq: number }; jobs: { recon: { date: string; ok: boolean; at: number } | null }; posthog_note: string;
}
export interface AnalyticsResult { insight?: string; range?: number; cached?: boolean; disabled?: boolean; reason?: string; results?: any[]; columns?: string[]; error?: string }
export interface AuditEntry { id: string; admin_id: string; action: string; target: string | null; meta: string; created_at: number }
export interface Alert { id: string; rule_id: string | null; metric: string; observed: number; threshold: number; severity: string; message: string; status: string; acked_by?: string; acked_at?: number; resolved_by?: string; resolved_at?: number; created_at: number }
export interface AlertRule { id: string; metric: string; comparator: string; threshold: number; window_sec: number; channels: string[]; enabled: boolean; created_by: string; created_at: number; updated_at: number }
export interface RoleRow { uid: string; role: string; granted_by: string | null; created_at: number | null; implicit?: boolean }
export interface UserSummary {
  found: boolean;
  user?: { uid: string; handle: string | null; display_name: string | null; avatar_url: string | null; created_at: number };
  kyc?: string; strikes?: number; verified_proofs?: number;
  counts?: { listings: number; voice_agents: number; vision_agents: number };
  recent_ledger?: any[]; note?: string;
}

export const ALERT_METRICS = ['error_rate', 'recon_diff', 'escrow_imbalance', 'failed_payout', 'csam_hit', 'agent_saturation', 'settlement_dlq'] as const;
export const COMPARATORS = ['gt', 'gte', 'lt', 'lte', 'eq', 'ne'] as const;
export const ANALYTICS_INSIGHTS = ['dau', 'events_total', 'signups', 'errors', 'error_by_endpoint', 'active_now', 'trend_daily'] as const;

// ───────────────────────── core ─────────────────────────
async function adminReq<T>(path: string, opts: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown; query?: Record<string, any> } = {}): Promise<T> {
  const auth = await getActiveToken();
  return request<T>(path, { method: opts.method ?? 'GET', body: opts.body, query: opts.query, auth });
}

// ───────────────────────── named helpers ─────────────────────────
export const getOverview = () => adminReq<Overview>('/api/admin/overview');
export const getLive = () => adminReq<LiveSnapshot>('/api/admin/live');
export const getAgents = () => adminReq<AgentsSnapshot>('/api/admin/agents');
export const getHealth = () => adminReq<Health>('/api/admin/health');
export const getAnalytics = (insight: string, range = 7) => adminReq<AnalyticsResult>('/api/admin/analytics', { query: { insight, range } });
export const getAudit = (q: { admin?: string; action?: string; limit?: number; cursor?: number } = {}) => adminReq<{ entries: AuditEntry[]; next_cursor: number | null }>('/api/admin/audit', { query: q });
export const searchUser = (q: string) => adminReq<UserSummary>('/api/admin/users/search', { query: { q } });

// money console (EXISTING endpoints — reused, never re-implemented)
export const getLedger = (q: { user?: string; ref?: string; limit?: number }) => adminReq<{ entries: any[] }>('/api/admin/ledger', { query: q });
export const getRecon = (order?: string) => adminReq<{ runs: any[]; spot: any }>('/api/admin/recon', { query: order ? { order } : {} });
export const getSettlements = (status = 'failed') => adminReq<{ settlements: any[] }>('/api/admin/settlements', { query: { status } });
export const retrySettlement = (id: string) => adminReq<{ ok: boolean }>(`/api/admin/settlements/${encodeURIComponent(id)}/retry`, { method: 'POST' });
export const getAffiliates = () => adminReq<{ affiliates: any[] }>('/api/admin/affiliates');
export const refund = (body: { orderId: string; amount: number; reason: string; userId?: string }) => adminReq<any>('/api/admin/refund', { method: 'POST', body });
export const adjust = (body: { account: string; amount: number; reason: string }) => adminReq<any>('/api/admin/adjust', { method: 'POST', body });
export const getAccount = (uid: string) => adminReq<any>(`/api/admin/account/${encodeURIComponent(uid)}`);

// config / kill switches (EXISTING endpoints)
export const getConfig = () => request<Record<string, any>>('/api/admin/config');
export const putConfig = async (patch: Record<string, any>) => adminReq<{ ok: boolean; config: Record<string, any> }>('/api/admin/config', { method: 'PUT', body: patch });

// alerts (NEW)
export const getAlerts = (status = 'open') => adminReq<{ alerts: Alert[] }>('/api/admin/alerts', { query: { status } });
export const ackAlert = (id: string) => adminReq<{ ok: boolean }>(`/api/admin/alerts/${encodeURIComponent(id)}/ack`, { method: 'POST' });
export const resolveAlert = (id: string) => adminReq<{ ok: boolean }>(`/api/admin/alerts/${encodeURIComponent(id)}/resolve`, { method: 'POST' });
export const evaluateAlerts = () => adminReq<{ ok: boolean; checked: number; tripped: number; opened: number }>('/api/admin/alerts/evaluate', { method: 'POST' });
export const getAlertRules = () => adminReq<{ rules: AlertRule[] }>('/api/admin/alert-rules');
export const createAlertRule = (body: Partial<AlertRule>) => adminReq<{ ok: boolean; id: string }>('/api/admin/alert-rules', { method: 'POST', body });
export const updateAlertRule = (id: string, body: Partial<AlertRule>) => adminReq<{ ok: boolean }>(`/api/admin/alert-rules/${encodeURIComponent(id)}`, { method: 'PUT', body });
export const deleteAlertRule = (id: string) => adminReq<{ ok: boolean }>(`/api/admin/alert-rules/${encodeURIComponent(id)}`, { method: 'DELETE' });

// roles (NEW, super only)
export const getRoles = () => adminReq<{ roles: RoleRow[] }>('/api/admin/roles');
export const setRole = (uid: string, role: string) => adminReq<{ ok: boolean }>(`/api/admin/roles/${encodeURIComponent(uid)}`, { method: 'PUT', body: { role } });

// ───────────────────────── gate hook ─────────────────────────
export type GateState = 'checking' | 'admin' | 'anon' | 'forbidden';

/** Resolve the session token, then confirm admin via the Worker (a 403 means
 *  "not an admin"). The Worker is the real boundary — we never trust the client. */
export function useAdminGate(): { state: GateState; error: string | null; retry: () => void } {
  const [state, setState] = useState<GateState>('checking');
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    void (async () => {
      setState('checking'); setError(null);
      const token = await getActiveToken();
      if (!token) { if (alive) setState('anon'); return; }
      try {
        await getOverview();
        if (alive) setState('admin');
        // Reveal the (otherwise hidden) Admin nav link for confirmed admins only.
        try { localStorage.setItem('avatok_is_admin', '1'); } catch { /* ignore */ }
      } catch (e) {
        if (!alive) return;
        try { localStorage.removeItem('avatok_is_admin'); } catch { /* ignore */ }
        if (e instanceof ApiError && (e.status === 403)) setState('forbidden');
        else if (e instanceof ApiError && e.status === 401) setState('anon');
        else { setError(e instanceof ApiError ? e.error : 'Could not verify admin access.'); setState('forbidden'); }
      }
    })();
    return () => { alive = false; };
  }, [nonce]);

  return { state, error, retry: () => setNonce((n) => n + 1) };
}

export const coins = (c: number | null | undefined): string =>
  c == null ? '—' : `$${(Number(c) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const fmtTime = (ms: number | null | undefined): string => (ms ? new Date(ms).toLocaleString() : '—');
export const minsAgo = (ms: number): string => { const m = Math.floor((Date.now() - ms) / 60000); return m < 1 ? 'now' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`; };
