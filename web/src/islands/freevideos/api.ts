/* [SAATHUM-FREEVIDEOS-WEB-1 2026-10-01] Typed wrappers over the Free videos HTTP contract
 * (Specs/SPEC-2026-10-01-FREE-VIDEOS.md, worker/src/routes/free_videos.ts). Built on the shared
 * `request()` in lib/apiClient.ts, which already reports api_error on every failure.
 *
 * NOTE FOR AI: a public card NEVER carries the YouTube id or link. The id only ever comes from
 * getFreeVideoWatch (signed-in call) and must never be rendered into page HTML.
 */
import { request } from '../../lib/apiClient';
import { captureException } from '../../lib/analytics';
import type { VideoCrop } from '../../components/dash2/crop';

export interface FreeVideoCardData {
  id: string;
  title: string;
  description: string;
  category: string;
  category_label: string;
  /** Uploaded cover, else the YouTube thumbnail (server decides). */
  cover_url: string | null;
  is_live: boolean;
  published_at: number | null;
}

/** Fixed category list (same order as the worker). */
export const FREE_VIDEO_CATEGORIES: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'satsang', label: 'Satsang' },
  { key: 'meditation', label: 'Meditation' },
  { key: 'sermon', label: 'Sermon' },
  { key: 'bhajan', label: 'Bhajan' },
  { key: 'aarti', label: 'Aarti' },
  { key: 'festival', label: 'Festival' },
];

export interface FreeVideoWatchInfo {
  ok: boolean;
  id: string;
  youtube_video_id: string;
  crop: VideoCrop | null;
  is_live: boolean;
}

export async function getFreeVideos(
  params: { limit?: number; category?: string } = {},
  signal?: AbortSignal,
): Promise<FreeVideoCardData[]> {
  const r = await request<{ items?: FreeVideoCardData[] }>('/api/free-videos', {
    query: { limit: params.limit, category: params.category }, signal,
  });
  return r.items ?? [];
}

export async function getFreeVideo(id: string, signal?: AbortSignal): Promise<FreeVideoCardData> {
  const r = await request<{ video: FreeVideoCardData }>(`/api/free-videos/${encodeURIComponent(id)}`, { signal });
  return r.video;
}

/** Entitled call: signed in (email) is enough — no WhatsApp. The only source of the video id. */
export function getFreeVideoWatch(id: string, token: string, signal?: AbortSignal): Promise<FreeVideoWatchInfo> {
  return request<FreeVideoWatchInfo>(`/api/free-videos/${encodeURIComponent(id)}/watch`, { auth: token, signal });
}

function postFreeVideoView(id: string, token: string): void {
  request<unknown>(`/api/free-videos/${encodeURIComponent(id)}/view`, { method: 'POST', body: {}, auth: token })
    .catch((err) => captureException(err, { surface: 'free_video_view', listing_id: id }));
}

const viewCounted = new Set<string>();
/** Count a viewer at most once per video per page load (first Play). Fire and forget. */
export function postFreeVideoViewOnce(id: string, token: string): void {
  if (viewCounted.has(id)) return;
  viewCounted.add(id);
  postFreeVideoView(id, token);
}
