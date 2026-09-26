// [ADMIN2-EVENTS 2026-09-26] Types + helpers for the Admin 2 Events screens.
// Worker: worker/src/routes/admin2_events.ts (GET/POST/PUT /api/admin/v2/events…).
// Money on the wire is integer paise (price_paise) except the form's price_rupees.
import { API_BASE } from '../../lib/config';
import { fileNameHeader } from '../../lib/uploadHeaders';
import { ApiError, adminApi, adminToken } from './adminApi';

export type EventTab = 'upcoming' | 'live' | 'past' | 'drafts' | 'cancelled';
export const EVENT_TABS: { key: EventTab; label: string }[] = [
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'live', label: 'Live' },
  { key: 'past', label: 'Past' },
  { key: 'drafts', label: 'Drafts' },
  { key: 'cancelled', label: 'Cancelled' },
];

export interface EventRow {
  id: string;
  title: string;
  category: string | null;
  category_label: string | null;
  deity: string | null;
  image_url: string | null;
  starts_at: number | null;
  duration_min: number | null;
  price_paise: number;
  capacity: number | null;
  seats_booked: number;
  pending_payments: number;
  status: string;
  tab: EventTab;
  schedule_state: string;
  youtube_set: boolean;
  poster_status: string | null;
  book_url: string;
  updated_at: number;
}

export interface EventsListResponse {
  now: number;
  tab: EventTab;
  counts: Record<EventTab, number>;
  items: EventRow[];
}

export interface Blocker { code: string; field: string | null; message: string }

export type PosterPlan =
  | { kind: 'ready' }
  | { kind: 'use_cover'; url: string }
  | { kind: 'approve_ai' }
  | { kind: 'needs_image'; message: string };

export interface EventDetail extends EventRow {
  blurb: string | null;
  description: string | null;
  performed_by: string | null;
  // [SAATHUM-EVENT-FIELDS-1] Book now card fields, SEO and the share line.
  location: string | null;
  intention: string | null;
  prasad_courier: boolean;
  // [SAATHUM-CHADHAVA 2026-09-26]
  video_download: boolean;
  visibility: 'public' | 'private';
  prasad_price_rupees: number;
  video_download_url: string | null;
  guide_slug: string | null;
  seo: { title: string; description: string; title_source: 'auto' | 'admin'; description_source: 'auto' | 'admin' } | null;
  ad_hook: string | null;
  slug: string | null;
  start_ist: { date: string; time: string } | null;
  price_rupees: number;
  manual_cover_url: string | null;
  ai_poster_url: string | null;
  poster: { status: string | null; provider: string | null; url: string | null; error: string | null } | null;
  creator_id: string | null;
  created_by_you: boolean;
  created_at: number;
}

export interface EventDetailResponse {
  event: EventDetail;
  youtube: { video_id: string; url: string } | null;
  blockers: Blocker[];
  publishable: boolean;
  poster_plan: PosterPlan;
}

export interface EventsMeta {
  categories: { id: string; label: string }[];
  min_price_rupees: number;
  duration: { min: number; max: number };
  deity_suggestions: string[];
  intentions?: { id: string; label: string }[];
  limits: { titleMax: number; blurbMax: number; descriptionMax: number; deityMax: number; performedByMax: number; capacityMax: number; locationMax?: number; seoTitleMax?: number; seoDescriptionMax?: number };
}

export const eventsPath = (id?: string, action?: string) =>
  `/api/admin/v2/events${id ? `/${encodeURIComponent(id)}` : ''}${action ? `/${action}` : ''}`;

export function statusMeta(status: string, tab?: EventTab): { label: string; variant: 'default' | 'secondary' | 'accent' | 'destructive' | 'outline' | 'muted' } {
  switch (status) {
    case 'published': return tab === 'past' ? { label: 'Ended', variant: 'muted' } : tab === 'live' ? { label: 'Live', variant: 'destructive' } : { label: 'Published', variant: 'accent' };
    case 'live': return { label: 'Live', variant: 'destructive' };
    case 'completed': return { label: 'Ended', variant: 'muted' };
    case 'cancelled': return { label: 'Cancelled', variant: 'outline' };
    case 'approved': return { label: 'Ready', variant: 'secondary' };
    case 'pending_review': return { label: 'Unpublished', variant: 'secondary' };
    case 'rejected': return { label: 'Rejected', variant: 'outline' };
    default: return { label: 'Draft', variant: 'secondary' };
  }
}

/** Accepts watch?v=, youtu.be/, /live/, /embed/, /shorts/ links or a bare 11-char id. The worker re-checks. */
export function looksLikeYoutube(v: string): boolean {
  const s = v.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return true;
  try {
    const u = new URL(s);
    return /(^|\.)youtube(-nocookie)?\.com$|(^|\.)youtu\.be$/.test(u.hostname);
  } catch { return false; }
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_COVER_BYTES = 8 * 1024 * 1024;

/** Upload a cover to /upload/public (the same byte-staging route the listing wizard uses). */
export async function uploadCover(file: File): Promise<string> {
  const mime = IMAGE_TYPES.includes(file.type) ? file.type : null;
  if (!mime) throw new Error('Use a JPG, PNG or WebP image.');
  if (file.size > MAX_COVER_BYTES) throw new Error('That image is larger than 8 MB.');
  const token = await adminToken();
  if (!token) throw new ApiError(401, 'unauthorized', { message: 'Please sign in again.' });
  const res = await fetch(`${API_BASE}/upload/public`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'x-content-type': mime, 'x-file-name': fileNameHeader(file.name), 'x-app': 'saathum' },
    body: file,
  });
  let body: { url?: string; error?: string; message?: string } = {};
  try { body = await res.json(); } catch { /* not json */ }
  if (!res.ok || !body.url) throw new ApiError(res.status, body.error ?? 'upload_failed', { message: body.message ?? `The upload failed (${res.status}).` });
  return body.url;
}

/** The existing admin YouTube route (me_dashboard.ts adminEventVideo). url:'' clears. */
export function saveYoutube(id: string, url: string) {
  return adminApi<{ ok: boolean; youtube_video_id: string | null }>(`/api/admin/listings/${encodeURIComponent(id)}/youtube`, { method: 'PUT', body: { url } });
}

export const DURATION_PRESETS = [30, 45, 60, 90, 120, 180, 240];

/** "HH:MM" every 15 minutes, for the start-time select. */
export const TIME_SLOTS: string[] = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`);

export function timeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Local Date from the picker -> "YYYY-MM-DD" of the day picked (read as an IST date). */
export function ymdOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function dateOfYmd(ymd: string | null | undefined): Date | undefined {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return undefined;
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
}
/** Today's date in IST as "YYYY-MM-DD". */
export function istTodayYmd(now = Date.now()): string {
  return new Date(now + 330 * 60_000).toISOString().slice(0, 10);
}
