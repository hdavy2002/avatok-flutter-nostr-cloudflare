// [SAATHUM-FREEVIDEOS-ADMIN-1 2026-10-01] Types + calls for the Admin "Free videos" screens.
// Contract: Specs/SPEC-2026-10-01-FREE-VIDEOS.md. Worker: worker/src/routes/free_videos.ts
// (GET/POST/PUT/DELETE /api/admin/v2/free-videos). A free video is NOT an event: no price,
// booking or date. Cover upload reuses uploadCover from ./eventsApi.
import type { VideoCrop } from '../../components/dash2/crop';
import { adminApi } from './adminApi';

export type FreeVideoCategory = 'satsang' | 'meditation' | 'sermon' | 'bhajan' | 'aarti' | 'festival';
export const FREE_VIDEO_CATEGORIES: { id: FreeVideoCategory; label: string }[] = [
  { id: 'satsang', label: 'Satsang' },
  { id: 'meditation', label: 'Meditation' },
  { id: 'sermon', label: 'Sermon' },
  { id: 'bhajan', label: 'Bhajan' },
  { id: 'aarti', label: 'Aarti' },
  { id: 'festival', label: 'Festival' },
];
export const categoryLabel = (id: string) => FREE_VIDEO_CATEGORIES.find((c) => c.id === id)?.label ?? id;

export const FREE_VIDEO_LIMITS = { titleMin: 3, titleMax: 120, descriptionMax: 600 };

export type FreeVideoStatus = 'draft' | 'published' | 'archived';

export interface FreeVideoRow {
  id: string;
  title: string;
  description: string;
  category: string;
  /** null = the card uses the YouTube thumbnail. */
  cover_url: string | null;
  youtube_video_id: string;
  /** The link the admin pasted. May be absent on an older API; fall back to the id. */
  youtube_url?: string | null;
  crop?: VideoCrop | null;
  status: FreeVideoStatus;
  sort_order?: number;
  is_live?: boolean;
  /** Distinct viewers (event_video_views). Absent on an older API. */
  viewers?: number;
  views?: number;
  published_at: number | null;
  created_at?: number;
  updated_at: number;
}

export interface FreeVideosListResponse { items: FreeVideoRow[] }
export interface FreeVideoResponse { video: FreeVideoRow }

export interface FreeVideoBody {
  title?: string;
  description?: string;
  category?: string;
  /** string = uploaded cover, null = use the YouTube thumbnail, undefined = leave unchanged. */
  cover_url?: string | null;
  youtube_url?: string;
  /** VideoCrop = set, null = clear (whole video), undefined = keep. */
  crop?: VideoCrop | null;
  status?: FreeVideoStatus;
}

export const freeVideosPath = (id?: string) => `/api/admin/v2/free-videos${id ? `/${encodeURIComponent(id)}` : ''}`;

export const listFreeVideos = (signal?: AbortSignal) => adminApi<FreeVideosListResponse>(freeVideosPath(), { signal });
export const getFreeVideo = (id: string) => adminApi<FreeVideoResponse>(freeVideosPath(id));
export const createFreeVideo = (body: FreeVideoBody) => adminApi<FreeVideoResponse>(freeVideosPath(), { method: 'POST', body });
export const updateFreeVideo = (id: string, body: FreeVideoBody) => adminApi<FreeVideoResponse>(freeVideosPath(id), { method: 'PUT', body });
/** Soft delete: the server sets status = 'archived'. */
/** [SAATHUM-FREEVIDEOS-AUTOFILL-1] Pull the video's title/description from YouTube and have AI
 *  rewrite them (unique wording) + pick a category. Saves nothing. */
export interface FreeVideoAutofill {
  ok: boolean; youtube_video_id: string; title: string; description: string;
  category: FreeVideoCategory | null; source: 'ai' | 'youtube'; original: { title: string; channel: string };
}
export const autofillFreeVideo = (youtube_url: string) =>
  adminApi<FreeVideoAutofill>(`${freeVideosPath()}/autofill`, { method: 'POST', body: { youtube_url } });
export const archiveFreeVideo = (id: string) => adminApi<{ ok: boolean }>(freeVideosPath(id), { method: 'DELETE' });

export function freeStatusMeta(status: string): { label: string; variant: 'secondary' | 'accent' | 'muted' } {
  if (status === 'published') return { label: 'Published', variant: 'accent' };
  if (status === 'archived') return { label: 'Archived', variant: 'muted' };
  return { label: 'Draft', variant: 'secondary' };
}
