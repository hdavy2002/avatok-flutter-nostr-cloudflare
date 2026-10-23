// [HF-HOST-PLATFORM-1] Typed calls for the HF host review + avatar admin screens
// (worker routes/hf_hosts_admin.ts and routes/hf_host_kyc.ts admin routes). Admin only.
import { API_BASE } from './env';
import { adminCall } from '../islands/admin2/peopleKit';

export type HostStatus = 'draft' | 'generating' | 'pending_host' | 'pending_review' | 'live' | 'paused' | 'rejected';
export interface AdminHost {
  category?: 'standard' | 'influencer' | 'celebrity';
  uid: string; slug: string | null; status: HostStatus; displayName: string | null; about: string | null; tagline: string | null; quote: string | null;
  aboutPolished: string | null; languages: string[]; style: string | null; topics: string[]; conversationLang: string | null; pricePerMin: number; plan?: string;
  hours: { days?: string[]; from?: string; to?: string }; healthConsent: boolean; womenLane: boolean; lgbtqLane: boolean; lgbtqPublic: boolean;
  avatarId: string | null; avatarUrl: string | null; genAttempts: number; reviewNote: string | null; liveAt: number | null;
  submittedAt: number | null; updatedAt: number;
}
export interface DemoInfluencer { uid: string; slug: string | null; name: string; handle: string | null; followers: number; ratePaise: number; videos: number; createdAt: number }
export interface DemoSaveResult { uid: string; slug: string | null; name: string; added: number; skipped: number; missing: string[]; bad: string[] }
export interface AdminHostMedia { id: string; kind: 'profile' | 'gallery'; url: string; caption: string | null; sort: number }
/** [HF-VOICE-INTRO-1] The host's own recorded introduction, as the reviewer sees it. `url` is signed (relative to the API origin). */
export interface AdminIntro { url: string; seconds: number; mime: string; status: 'pending' | 'approved' | 'rejected'; transcript: string | null; flags: { type: string; text: string }[] }
export interface AdminHostDetail {
  host: AdminHost; media: AdminHostMedia[];
  intro: AdminIntro | null;
  /** The previously approved introduction that is still live while a new one waits for review. */
  liveIntroUrl?: string | null;
  kyc: {
    aadhaarDone: boolean; name: string | null; gender: string | null; last4: string | null; ageOk: boolean; hasPhoto: boolean;
    selfie: { id: string; status: 'pending' | 'approved' | 'rejected'; reason: string | null; at: number } | null;
    payout: { upiOnFile: boolean; nameMatch: boolean; upiVerified: boolean; accountLast4: string | null } | null;
  };
}
export interface KycItem {
  selfieId: string; uid: string; email?: string | null; selfieUrl: string; photoUrl: string | null; urlExpiresInS: number;
  code?: string; createdAt?: number; bytes?: number; mime?: string; status?: 'pending' | 'approved' | 'rejected'; reason?: string | null;
  aadhaar?: { name: string | null; gender: string; last4: string | null; role: string | null } | null;
}
export interface AdminAvatar { id: string; url: string; gender: string; age: string; look: string; status: 'active' | 'retired'; taken: boolean; createdAt: number }
export interface AvatarJob { id: string; status: string; error: string | null; created_at: number }

/** [HF-CALLS-1] Review moderation + calls list + test credits. Row fields beyond the contract are optional; screens read them defensively. */
export interface AdminReview {
  id: string; callId?: string; stars: number; text: string | null; topic: string | null; status?: string; rejectReason?: string | null;
  createdAt?: number | string | null; hostSlug?: string | null; hostName?: string | null; callerName?: string | null; callerUid?: string | null; hostUid?: string | null; minutes?: number | null;
}
export interface AdminCall {
  id: string; status: string; callerUid?: string; hostUid?: string; hostName?: string | null; hostSlug?: string | null;
  ratePaise?: number; billedMinutes?: number | null; chargedPaise?: number | null; hostEarningPaise?: number | null; endReason?: string | null;
  createdAt?: number | string | null;
}

/** [HF-STD-PLAN-1] Standard-plan call with its margin estimates (admin only). All money in paise; estimates are before other expenses, NOT profit. */
export interface StdCallRow {
  id: string; at?: number | string | null; createdAt?: number | string | null; hostName?: string | null; hostSlug?: string | null; billableSeconds?: number | null;
  chargePaise?: number | null; hostPaise?: number | null; phoneCostEstPaise?: number | null; phoneCostActualPaise?: number | null;
  platformEstPaise?: number | null; platformAfterActualPaise?: number | null; tiers?: { fromMin: number; toMin: number | null; paisePerMin: number; seconds: number; amountPaise: number }[];
}
export interface StdTotals {
  calls?: number; seconds?: number; chargePaise?: number; hostPaise?: number; phoneCostEstPaise?: number; phoneCostActualPaise?: number | null;
  platformEstPaise?: number; platformAfterActualPaise?: number | null;
}

/** [HF-ADMIN-CALLS-BLANK-2] /std/summary groups its figures: calls{count,billableSeconds,chargePaise,hostEarningsPaise},
 * phoneCost{estimatePaise,actualPaise}, platformBeforeOtherExpenses{estimatePaise,afterActualPhoneCostPaise}. Flatten to StdTotals. */
function stdSummaryTotals(r: Record<string, unknown>): StdTotals | undefined {
  const g = (k: string): Record<string, unknown> => (r[k] && typeof r[k] === 'object' ? (r[k] as Record<string, unknown>) : {});
  const num = (o: Record<string, unknown>, k: string): number | undefined => (typeof o[k] === 'number' && Number.isFinite(o[k] as number) ? (o[k] as number) : undefined);
  const c = g('calls'), ph = g('phoneCost'), pl = g('platformBeforeOtherExpenses');
  if (!Object.keys(c).length) return stdTotals(r.totals ?? r);
  return {
    calls: num(c, 'count'), seconds: num(c, 'billableSeconds'), chargePaise: num(c, 'chargePaise'), hostPaise: num(c, 'hostEarningsPaise') ?? num(c, 'hostPaise'),
    phoneCostEstPaise: num(ph, 'estimatePaise'), phoneCostActualPaise: num(ph, 'actualPaise') ?? null,
    platformEstPaise: num(pl, 'estimatePaise'), platformAfterActualPaise: num(pl, 'afterActualPhoneCostPaise') ?? null,
  };
}
/** [HF-ADMIN-CALLS-BLANK-2] One /std/calls row: the worker sends startedAt and platformBeforeOtherExpenses*; the table reads at/platformEst*. */
function stdRow(raw: unknown): StdCallRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const num = (...ks: string[]): number | null => { for (const k of ks) { const v = o[k]; if (typeof v === 'number' && Number.isFinite(v)) return v; } return null; };
  const str = (k: string): string | null => (typeof o[k] === 'string' ? (o[k] as string) : null);
  return {
    id: String(o.id ?? ''), at: num('at', 'endedAt', 'startedAt', 'createdAt'), createdAt: num('createdAt', 'startedAt'),
    hostName: str('hostName'), hostSlug: str('hostSlug'), billableSeconds: num('billableSeconds'),
    chargePaise: num('chargePaise'), hostPaise: num('hostPaise'), phoneCostEstPaise: num('phoneCostEstPaise'), phoneCostActualPaise: num('phoneCostActualPaise'),
    platformEstPaise: num('platformEstPaise', 'platformBeforeOtherExpensesEstPaise'),
    platformAfterActualPaise: num('platformAfterActualPaise', 'platformBeforeOtherExpensesActualPaise'),
  };
}
/** [HF-ADMIN-CALLS-BLANK-1] The worker sends totals with long names (and /summary nests them under `calls`, an OBJECT). Rendering that
 * object as {totals.calls} crashed React (#31) and blanked the whole Calls and credits page. Map to plain numbers only. */
function stdTotals(raw: unknown): StdTotals | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const n = (...keys: string[]): number | undefined => { for (const k of keys) { const v = o[k]; if (typeof v === 'number' && Number.isFinite(v)) return v; } return undefined; };
  return {
    calls: n('calls', 'count'), seconds: n('seconds', 'billableSeconds'), chargePaise: n('chargePaise'), hostPaise: n('hostPaise'),
    phoneCostEstPaise: n('phoneCostEstPaise'), phoneCostActualPaise: n('phoneCostActualPaise') ?? null,
    platformEstPaise: n('platformEstPaise', 'platformBeforeOtherExpensesEstPaise'),
    platformAfterActualPaise: n('platformAfterActualPaise', 'platformBeforeOtherExpensesActualPaise') ?? null,
  };
}

/** [HF-ADMIN-CREDIT-1] One row of the caller picker (admin only: full phone and email). */
export interface AdminUserHit {
  uid: string; name: string | null; phone: string | null; email: string | null; whatsappVerified: boolean;
  isHost: boolean; hostSlug?: string; balanceRupees: number; createdAt: number | null;
}

const e = encodeURIComponent;
/** Signed media paths come back relative to the API origin. */
export const apiUrl = (p: string | null | undefined) => (p ? (p.startsWith('http') ? p : `${API_BASE}${p}`) : '');

/** [HF-WIRE-22] A creator who is not on the app yet; their reels show in the feed with an Invite button. */
export interface InviteCreator { platform: 'youtube' | 'instagram'; handle: string; name: string; avatar: string | null; followers: number; votes: number; source: string; hidden: boolean; reels: number; lastLookupAt: number }

export const hfAdminApi = {
  // [HF-ADMIN-CACHE-1] list getters take an optional onCached(rows) that paints the last response before the live fetch.
  hosts: async (status: HostStatus, onCached?: (r: AdminHost[]) => void) => (await adminCall<{ items: AdminHost[] }>(`/api/admin/hf/hosts?status=${e(status)}`, { onCached: onCached && ((r) => onCached(r.items ?? [])) })).items ?? [],
  host: (uid: string) => adminCall<AdminHostDetail>(`/api/admin/hf/hosts/${e(uid)}`),
  decide: (uid: string, decision: 'approve' | 'reject' | 'pause', reason = '') =>
    adminCall<{ ok: true; status: string; notified: boolean }>(`/api/admin/hf/hosts/${e(uid)}/decision`, { method: 'POST', body: { decision, reason } }),
  /** [HF-VOICE-INTRO-1] Approve the host's recorded introduction, or ask them to record it again (reason is shown to the host). */
  introDecision: (uid: string, decision: 'approve' | 'reject', reason = '') =>
    adminCall<{ ok: true }>(`/api/admin/hf/hosts/${e(uid)}/intro`, { method: 'POST', body: { decision, reason } }),
  /** Signed selfie video + Aadhaar photo URLs (5 min). Find the host by uid in the status the selfie is in. */
  kycMedia: async (uid: string, status: 'pending' | 'approved' | 'rejected') =>
    ((await adminCall<{ items: KycItem[] }>(`/api/admin/hf/kyc?status=${status}`)).items ?? []).find((i) => i.uid === uid) ?? null,
  kycList: async (status: 'pending' | 'approved' | 'rejected', onCached?: (r: KycItem[]) => void) =>
    (await adminCall<{ items: KycItem[] }>(`/api/admin/hf/kyc?status=${status}`, { onCached: onCached && ((r) => onCached(r.items ?? [])) })).items ?? [],
  selfieDecision: (uid: string, decision: 'approve' | 'reject', reason = '', selfieId?: string) =>
    adminCall<{ ok: true }>(`/api/admin/hf/kyc/${e(uid)}/selfie`, { method: 'POST', body: { decision, reason, selfieId } }),
  avatars: (onCached?: (r: { items: AdminAvatar[]; jobs: AvatarJob[] }) => void) => adminCall<{ items: AdminAvatar[]; jobs: AvatarJob[] }>('/api/admin/hf/avatars', { onCached }),
  generateAvatars: (b: { count: number; gender: string; age: string; look: string }) =>
    adminCall<{ ok: true; jobId: string }>('/api/admin/hf/avatars/generate', { method: 'POST', body: b }),
  fillAvatars: (target = 4) =>
    adminCall<{ ok: true; jobId?: string; queued: number }>('/api/admin/hf/avatars/fill', { method: 'POST', body: { target } }),
  retireAvatar: (id: string) => adminCall<{ ok: true }>(`/api/admin/hf/avatars/${e(id)}/retire`, { method: 'POST', body: {} }),
  // [HF-WIRE-14] demo influencers from pasted YouTube links
  demoInfluencers: async (onCached?: (r: DemoInfluencer[]) => void) => (await adminCall<{ items: DemoInfluencer[] }>('/api/admin/hf/demo-influencers', { onCached: onCached && ((r) => onCached(r.items ?? [])) })).items ?? [],
  saveDemoInfluencer: (b: { uid?: string; name: string; ratePaise: number; youtubeUrls: string[] }) =>
    adminCall<{ ok: true; result: DemoSaveResult }>('/api/admin/hf/demo-influencers', { method: 'POST', body: b }),
  deleteDemoInfluencer: (uid: string) => adminCall<{ ok: true }>(`/api/admin/hf/demo-influencers/${e(uid)}`, { method: 'DELETE' }),
  // [HF-WIRE-22] invite creators (HF-REEL-40)
  inviteCreators: async (onCached?: (r: InviteCreator[]) => void) => (await adminCall<{ items: InviteCreator[] }>('/api/admin/hf/invite-creators', { onCached: onCached && ((r) => onCached(r.items ?? [])) })).items ?? [],
  addInviteCreator: (b: { platform: 'youtube' | 'instagram'; handle: string }) =>
    adminCall<{ ok: true; creator: { platform: string; handle: string; name: string; followers: number }; reels: number }>('/api/admin/hf/invite-creators', { method: 'POST', body: b }),
  hideInviteCreator: (platform: string, handle: string, hidden: boolean) =>
    adminCall<{ ok: true; hidden: boolean }>(`/api/admin/hf/invite-creators/${e(platform)}/${e(handle.replace(/^@/, ''))}`, { method: 'PATCH', body: { hidden } }),
  // [HF-CALLS-1]
  reviews: async (status: 'pending' | 'approved' | 'rejected' = 'pending', onCached?: (r: AdminReview[]) => void) => (await adminCall<{ items: AdminReview[] }>(`/api/admin/hf/reviews?status=${e(status)}`, { onCached: onCached && ((r) => onCached(r.items ?? [])) })).items ?? [],
  decideReview: (id: string, decision: 'approve' | 'reject', reason = '') =>
    adminCall<{ ok: true }>(`/api/admin/hf/reviews/${e(id)}`, { method: 'POST', body: { decision, reason: reason || undefined } }),
  calls: async (onCached?: (r: AdminCall[]) => void) => (await adminCall<{ items: AdminCall[] }>('/api/admin/hf/calls', { onCached: onCached && ((r) => onCached(r.items ?? [])) })).items ?? [],
  /** [HF-ADMIN-CREDIT-1] Credit by uid (search result / advanced) or by WhatsApp number. */
  creditWallet: (b: { uid?: string; phone?: string; rupees: number; note: string; via?: 'search'; opId?: string }) =>
    adminCall<{ ok: true; uid: string; name: string | null; balanceRupees: number }>('/api/admin/hf/wallet/credit', { method: 'POST', body: b }),
  /** [HF-STD-PLAN-1] Calls & margins. */
  stdCalls: async () => { const r = await adminCall<{ items?: unknown[]; calls?: unknown[]; totals?: Record<string, unknown> }>('/api/admin/hf/std/calls'); const list = Array.isArray(r.items) ? r.items : Array.isArray(r.calls) ? r.calls : []; return { items: list.map(stdRow).filter((x): x is StdCallRow => x !== null), totals: stdTotals(r.totals) }; },
  stdSummary: async () => stdSummaryTotals(await adminCall<Record<string, unknown>>('/api/admin/hf/std/summary')),
  searchUsers: async (q: string) => (await adminCall<{ items: AdminUserHit[] }>(`/api/admin/hf/users/search?q=${e(q)}`)).items ?? [],
};
