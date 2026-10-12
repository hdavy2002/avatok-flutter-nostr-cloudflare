import { adminCall } from '../islands/admin2/peopleKit';
import { getActiveTokenWaited } from './clerk';
import { API_BASE } from './env';
import { ApiError } from './apiClient';
import { captureException } from './analytics';

export interface CreatorListing {
  uid: string; slug: string | null; status: string; category: 'standard' | 'influencer' | 'celebrity';
  displayName: string | null; tagline: string | null; about: string | null; pricePerMin: number;
  languages: string[]; topics: string[]; privatePhone?: string | null;
  voice: { status: string; seconds: number | null; mime: string | null };
  media?: { id: string; kind: string; url: string }[];
  publicationBlockers?: string[];
  sampleData?: boolean;
}
export interface CreatorPreview { displayName: string; tagline: string | null; avatarUrl: string | null; priceLabel: string; status: 'offline'; introAudioUrl: string | null; languages: string[] }
const base = '/api/admin/hf/listings';
const path = (uid: string) => `${base}/${encodeURIComponent(uid)}`;
export const creatorAdminApi = {
  list: () => adminCall<{ items: CreatorListing[] }>(base),
  get: (uid: string) => adminCall<{ listing: CreatorListing }>(path(uid)),
  create: (uid: string, category: 'influencer' | 'celebrity') => adminCall<{ listing: CreatorListing }>(base, { method: 'POST', body: { uid, category } }),
  save: (uid: string, body: Record<string, unknown>) => adminCall<{ listing: CreatorListing }>(path(uid), { method: 'PUT', body }),
  publish: (uid: string) => adminCall<{ listing: CreatorListing }>(`${path(uid)}/publish`, { method: 'POST', body: {} }),
  archive: (uid: string) => adminCall<{ ok: true }>(path(uid), { method: 'DELETE' }),
  removeVoice: (uid: string) => adminCall<{ listing: CreatorListing }>(`${path(uid)}/voice`, { method: 'DELETE' }),
  seed: () => adminCall<{ items: CreatorListing[] }>(`${base}/seed`, { method: 'POST', body: { mode: 'private_drafts' } }),
  preview: (uid: string) => adminCall<{ item: CreatorPreview }>(`${path(uid)}/preview`),
  async upload(uid: string, kind: 'voice' | 'profile' | 'gallery', file: File, seconds?: number): Promise<{ listing: CreatorListing }> {
    const endpoint = `${path(uid)}/${kind === 'voice' ? 'voice' : `media?kind=${kind}`}`;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await getActiveTokenWaited(5000, { skipCache: attempt > 0 });
        if (!token) throw new Error('Sign in to upload.');
        const response = await fetch(`${API_BASE}${endpoint}`, { method: 'PUT', body: file,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': file.type || (kind === 'voice' ? 'audio/mpeg' : 'application/octet-stream'),
            ...(kind === 'voice' ? { 'x-duration-seconds': String(seconds), 'x-voice-consent': 'v1' } : {}) },
          signal: AbortSignal.timeout(60000) });
        if (response.status === 401 && attempt === 0) continue;
        const data = await response.json();
        if (!response.ok) throw new ApiError(response.status, data.message ?? data.error ?? 'Upload failed', data);
        return data;
      }
      throw new Error('Sign in again to upload.');
    } catch (error) { captureException(error, { area: 'hf_creator_upload', kind }); throw error; }
  },
};

export async function mp3Duration(file: File): Promise<number> {
  if (!/\.mp3$/i.test(file.name) || (file.type && !['audio/mpeg', 'audio/mp3'].includes(file.type))) throw new Error('Choose an MP3 audio file.');
  if (file.size < 20 * 1024 || file.size > 15 * 1024 * 1024) throw new Error('Choose an MP3 between 20 KB and 15 MB.');
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<number>((resolve, reject) => {
      const audio = new Audio();
      const timer = window.setTimeout(() => { audio.src = ''; reject(new Error('Could not read the recording length. Try another MP3.')); }, 10000);
      const finish = () => { clearTimeout(timer); audio.onloadedmetadata = null; audio.onerror = null; audio.removeAttribute('src'); audio.load(); };
      audio.onloadedmetadata = () => {
        const seconds = audio.duration; finish();
        if (!Number.isFinite(seconds) || seconds < 20 || seconds > 300) reject(new Error('The recording must be at least 20 seconds and no longer than 5 minutes.'));
        else resolve(seconds);
      };
      audio.onerror = () => { finish(); reject(new Error('This file could not be read as MP3 audio.')); };
      audio.preload = 'metadata'; audio.src = url;
    });
  } finally { URL.revokeObjectURL(url); }
}
