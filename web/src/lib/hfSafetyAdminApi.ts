/* [HF-CALL-SAFETY-WEB] Admin client for call safety (contract: HF-CALL-SAFETY-CONTRACT.md, "Admin"). Safety reviewers only.
 * Response shapes follow the contract; fields the contract leaves open (history rows, strike rows, access-log rows) are read
 * defensively in islands/admin2/hosts/CallSafety.tsx so a small backend difference never blanks the page. */
import { adminCall, type Page } from '../islands/admin2/peopleKit';
import { adminBlob } from '../islands/admin2/adminApi';
import type { StrikeReason } from './hfSafetyApi';

export type SafetyTab = 'review' | 'strikes' | 'paused' | 'access';
export type RowKind = 'danger' | 'review' | 'appeal' | 'fan_report' | 'paused';
export type Verdict = 'clean' | 'selling' | 'outside_payment' | 'contact_sharing' | 'abuse' | 'sexual' | 'danger';
export type Who = 'fan' | 'influencer';

export interface SafetyRow {
  id: string; kind: RowKind; uid: string; role: Who; name: string | null; photo: string | null;
  verdict: Verdict | null; score: number | null; speaker: Who | null; speakerScore: number | null;
  callAt: number | null; durationSec: number | null; activeStrikes: number; waitingMs: number; summary: string | null; womenLane: boolean | 0 | 1;
  /** Open extras (strike rows and access-log rows): shown when present. */
  at?: number; by?: string | null; action?: string | null; reviewId?: string | null; reason?: string | null; expiresAt?: number | null;
}
export interface SafetySummary { checkedToday: number; flaggedToday: number; strikesToday: number; waiting: number; oldestWaitingMs: number }
export interface TranscriptLine { t: string; speaker: Who; text: string; flagged: boolean }
export interface HistoryItem { at?: number; kind?: string; reason?: string; reasonText?: string; text?: string; expiresAt?: number; appeal?: string | null }
export interface SafetyDetail extends SafetyRow { lines: TranscriptLine[]; audioUntil: number | null; history: (HistoryItem | string)[] }

export interface BanStrike { id?: string; reason?: StrikeReason | string; reasonText?: string; callAt?: number; at?: number; source?: string; by?: string; sure?: boolean; appeal?: string | null; appealStatus?: string | null }
export interface BanPreview { name: string; strikes: BanStrike[]; heldPaise: number; refunds: { fanUid: string; paise: number }[]; refundTotalPaise: number; payoutPaise: number }

const e = encodeURIComponent;
const BASE = '/api/admin/hf/safety';

/** The queue answers a page `{items, next_cursor}`, `{rows, nextCursor}` or a bare array; all three are read. */
function rowsOf(r: unknown): { items: SafetyRow[]; next: string | null } {
  if (Array.isArray(r)) return { items: r as SafetyRow[], next: null };
  const o = (r ?? {}) as Record<string, unknown>;
  const items = (Array.isArray(o.items) ? o.items : Array.isArray(o.rows) ? o.rows : []) as SafetyRow[];
  const next = (typeof o.next_cursor === 'string' && o.next_cursor) || (typeof o.nextCursor === 'string' && o.nextCursor) || null;
  return { items, next };
}

export const safetyAdminApi = {
  summary: () => adminCall<SafetySummary>(`${BASE}/summary`),
  queue: async (tab: SafetyTab, cursor?: string) => rowsOf(await adminCall<Page<SafetyRow>>(`${BASE}/queue`, { query: { tab, cursor } })),
  detail: (id: string) => adminCall<SafetyDetail>(`${BASE}/reviews/${e(id)}`),
  transcript: async (id: string, reason: string): Promise<TranscriptLine[]> => {
    const r = await adminCall<TranscriptLine[] | { lines?: TranscriptLine[] }>(`${BASE}/reviews/${e(id)}/transcript`, { method: 'POST', body: { reason } });
    return Array.isArray(r) ? r : r.lines ?? [];
  },
  /** Audio needs the admin bearer token, so it is fetched as a blob and played from an object URL. */
  clip: async (id: string): Promise<string> => {
    const { blob } = await adminBlob(`${BASE}/reviews/${e(id)}/clip`);
    return URL.createObjectURL(blob);
  },
  decide: (id: string, body: { action: 'confirm_strike' | 'dismiss' | 'pause'; target: Who; reason: string; note?: string }) =>
    adminCall<{ ok: boolean }>(`${BASE}/reviews/${e(id)}/decision`, { method: 'POST', body }),
  decideAppeal: (id: string, decision: 'accept' | 'reject', note?: string) =>
    adminCall<{ ok: boolean }>(`${BASE}/appeals/${e(id)}/decision`, { method: 'POST', body: { decision, note: note || undefined } }),
  banPreview: (uid: string) => adminCall<BanPreview>(`${BASE}/users/${e(uid)}/ban-preview`),
  ban: (uid: string, reason: string) => adminCall<{ ok: boolean }>(`${BASE}/users/${e(uid)}/ban`, { method: 'POST', body: { reason, refundFans: true } }),
  restore: (uid: string, removeStrikeIds: string[]) => adminCall<{ ok: boolean }>(`${BASE}/users/${e(uid)}/restore`, { method: 'POST', body: { removeStrikeIds } }),
};

/** What the admin picks for "Reason (sent on WhatsApp)": the verdict it maps to and the sentence the person receives. */
export const STRIKE_REASONS: { key: StrikeReason; label: string }[] = [
  { key: 'outside_payment', label: 'Asked for payment outside Hello Fraands' },
  { key: 'selling', label: 'Selling a product or service' },
  { key: 'contact_sharing', label: 'Shared or asked for contact details' },
  { key: 'abuse', label: 'Abusive or rude' },
  { key: 'sexual', label: 'Sexual talk' },
];
