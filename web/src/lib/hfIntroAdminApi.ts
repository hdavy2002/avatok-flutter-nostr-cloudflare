// [HF-INTRO-B2] Admin client for the intro-video applications (contract: Specs/HF-INTRO-VIDEO-1-API.md section 2).
import { adminCall } from '../islands/admin2/peopleKit';

export type IntroStatus = 'submitted' | 'approved' | 'rejected';
export type CallOption = 'A' | 'B' | null;
export interface IntroCategory { id: string; label: string }
export interface RejectReason { code: string; text: string }

export interface IntroListItem {
  id: string; uid: string; status: IntroStatus; name: string | null; categories: IntroCategory[]; lang: string | null;
  ratePerMin: number | null; callOption: CallOption; submittedAt: number | null; reviewedAt: number | null; hasSocials: boolean;
  aadhaar: { status: 'verified' | 'none'; female: boolean };
  /** Optional extras: shown when the server sends them, never required. */
  photoUrl?: string | null; socialPlatforms?: string[];
}

export interface IntroSocial { platform: string; handle: string; url: string; followers?: number | null }
export interface CalendarRange { startMin: number; endMin: number }
export interface IntroCalendar { timezone?: string; weekly?: { weekday: number; ranges: CalendarRange[] }[]; exceptions?: unknown[]; empty?: boolean }
export interface IntroApplication {
  id: string; status: IntroStatus; categories?: IntroCategory[]; lang?: string | null; topic?: string | null; callOption?: CallOption;
  submittedAt?: number | null; reviewedAt?: number | null; rejectReasons?: RejectReason[]; rejectNote?: string | null; createdAt?: number | null;
}
export interface IntroDetail {
  ok?: true;
  application: IntroApplication;
  host: { uid: string; status?: string; name: string | null; description: string | null; ratePerMin: number | null; photoUrl: string | null; callOption?: CallOption; createdAt?: number | null };
  // [HF-INTRO-DELETE-1] after a reject the files are deleted: videoUrl / posterUrl are null and deletedAt says when (deletedReason: rejected | replaced | draft_expired ...).
  video: { videoUrl: string | null; posterUrl: string | null; durationMs?: number; width?: number; height?: number; lang?: string | null; topic?: string | null; deletedAt?: number | null; deletedReason?: string | null } | null;
  socials: IntroSocial[];
  aadhaar: { done: boolean; female: boolean; gender?: string | null };
  whatsappVerified: boolean;
  womenToWomen: boolean;
  calendar: IntroCalendar | null;
  history?: IntroApplication[];
  rejectReasons: RejectReason[];
}
export interface DecisionResult { ok: true; status: 'approved' | 'rejected'; notified?: boolean; notifyReason?: string | null; videoDeleted?: boolean }

const e = encodeURIComponent;
const BASE = '/api/admin/hf/intro-applications';

export const introAdminApi = {
  list: async (status: IntroStatus, onCached?: (r: { items: IntroListItem[]; rejectReasons: RejectReason[] }) => void) => {
    const r = await adminCall<{ items?: IntroListItem[]; rejectReasons?: RejectReason[] }>(`${BASE}?status=${e(status)}`, {
      onCached: onCached && ((c) => onCached({ items: c.items ?? [], rejectReasons: c.rejectReasons ?? [] })),
    });
    return { items: r.items ?? [], rejectReasons: r.rejectReasons ?? [] };
  },
  detail: (id: string) => adminCall<IntroDetail>(`${BASE}/${e(id)}`),
  approve: (id: string) => adminCall<DecisionResult>(`${BASE}/${e(id)}/approve`, { method: 'POST', body: {} }),
  reject: (id: string, reasons: string[], note: string) => adminCall<DecisionResult>(`${BASE}/${e(id)}/reject`, { method: 'POST', body: { reasons, note: note || undefined } }),
};
