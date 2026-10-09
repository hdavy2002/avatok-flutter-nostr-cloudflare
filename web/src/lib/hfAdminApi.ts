// [HF-HOST-PLATFORM-1] Typed calls for the HF host review + avatar admin screens
// (worker routes/hf_hosts_admin.ts and routes/hf_host_kyc.ts admin routes). Admin only.
import { API_BASE } from './env';
import { adminCall } from '../islands/admin2/peopleKit';

export type HostStatus = 'draft' | 'generating' | 'pending_host' | 'pending_review' | 'live' | 'paused' | 'rejected';
export interface AdminHost {
  uid: string; slug: string | null; status: HostStatus; displayName: string | null; about: string | null; tagline: string | null; quote: string | null;
  aboutPolished: string | null; languages: string[]; style: string | null; topics: string[]; conversationLang: string | null; pricePerMin: number;
  hours: { days?: string[]; from?: string; to?: string }; healthConsent: boolean; womenLane: boolean; lgbtqLane: boolean; lgbtqPublic: boolean;
  avatarId: string | null; avatarUrl: string | null; genAttempts: number; reviewNote: string | null; liveAt: number | null;
  submittedAt: number | null; updatedAt: number;
}
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
    payout: { nameMatch: boolean; upiVerified: boolean; accountLast4: string | null } | null;
  };
}
export interface KycItem { selfieId: string; uid: string; selfieUrl: string; photoUrl: string | null; urlExpiresInS: number }
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

/** [HF-ADMIN-CREDIT-1] One row of the caller picker (admin only: full phone and email). */
export interface AdminUserHit {
  uid: string; name: string | null; phone: string | null; email: string | null; whatsappVerified: boolean;
  isHost: boolean; hostSlug?: string; balanceRupees: number; createdAt: number | null;
}

const e = encodeURIComponent;
/** Signed media paths come back relative to the API origin. */
export const apiUrl = (p: string | null | undefined) => (p ? (p.startsWith('http') ? p : `${API_BASE}${p}`) : '');

export const hfAdminApi = {
  hosts: async (status: HostStatus) => (await adminCall<{ items: AdminHost[] }>(`/api/admin/hf/hosts?status=${e(status)}`)).items ?? [],
  host: (uid: string) => adminCall<AdminHostDetail>(`/api/admin/hf/hosts/${e(uid)}`),
  decide: (uid: string, decision: 'approve' | 'reject' | 'pause', reason = '') =>
    adminCall<{ ok: true; status: string; notified: boolean }>(`/api/admin/hf/hosts/${e(uid)}/decision`, { method: 'POST', body: { decision, reason } }),
  /** [HF-VOICE-INTRO-1] Approve the host's recorded introduction, or ask them to record it again (reason is shown to the host). */
  introDecision: (uid: string, decision: 'approve' | 'reject', reason = '') =>
    adminCall<{ ok: true }>(`/api/admin/hf/hosts/${e(uid)}/intro`, { method: 'POST', body: { decision, reason } }),
  /** Signed selfie video + Aadhaar photo URLs (5 min). Find the host by uid in the status the selfie is in. */
  kycMedia: async (uid: string, status: 'pending' | 'approved' | 'rejected') =>
    ((await adminCall<{ items: KycItem[] }>(`/api/admin/hf/kyc?status=${status}`)).items ?? []).find((i) => i.uid === uid) ?? null,
  selfieDecision: (uid: string, decision: 'approve' | 'reject', reason = '', selfieId?: string) =>
    adminCall<{ ok: true }>(`/api/admin/hf/kyc/${e(uid)}/selfie`, { method: 'POST', body: { decision, reason, selfieId } }),
  avatars: () => adminCall<{ items: AdminAvatar[]; jobs: AvatarJob[] }>('/api/admin/hf/avatars'),
  generateAvatars: (b: { count: number; gender: string; age: string; look: string }) =>
    adminCall<{ ok: true; jobId: string }>('/api/admin/hf/avatars/generate', { method: 'POST', body: b }),
  fillAvatars: (target = 4) =>
    adminCall<{ ok: true; jobId?: string; queued: number }>('/api/admin/hf/avatars/fill', { method: 'POST', body: { target } }),
  retireAvatar: (id: string) => adminCall<{ ok: true }>(`/api/admin/hf/avatars/${e(id)}/retire`, { method: 'POST', body: {} }),
  // [HF-CALLS-1]
  reviews: async (status: 'pending' | 'approved' | 'rejected' = 'pending') => (await adminCall<{ items: AdminReview[] }>(`/api/admin/hf/reviews?status=${e(status)}`)).items ?? [],
  decideReview: (id: string, decision: 'approve' | 'reject', reason = '') =>
    adminCall<{ ok: true }>(`/api/admin/hf/reviews/${e(id)}`, { method: 'POST', body: { decision, reason: reason || undefined } }),
  calls: async () => (await adminCall<{ items: AdminCall[] }>('/api/admin/hf/calls')).items ?? [],
  /** [HF-ADMIN-CREDIT-1] Credit by uid (search result / advanced) or by WhatsApp number. */
  creditWallet: (b: { uid?: string; phone?: string; rupees: number; note: string; via?: 'search'; opId?: string }) =>
    adminCall<{ ok: true; uid: string; name: string | null; balanceRupees: number }>('/api/admin/hf/wallet/credit', { method: 'POST', body: b }),
  searchUsers: async (q: string) => (await adminCall<{ items: AdminUserHit[] }>(`/api/admin/hf/users/search?q=${e(q)}`)).items ?? [],
};
