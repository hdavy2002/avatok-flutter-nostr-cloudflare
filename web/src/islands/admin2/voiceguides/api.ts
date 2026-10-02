// [AUMFE-VOICE-ADMIN-1] Typed calls for Admin 2 "Voice guides". Worker: /api/admin/v2/voice-agents/*
// (AUMFE-VOICE-AGENTS-DB-1). Errors come back as {error: string}; adminCall() surfaces them as ApiError.
import { API_BASE } from '../../../lib/env';
import { ApiError, adminToken } from '../adminApi';
import { adminCall } from '../peopleKit';

export type GuideStatus = 'draft' | 'preview' | 'live' | 'archived';
export const STATUSES: GuideStatus[] = ['draft', 'preview', 'live', 'archived'];

export interface VoiceMeta { voices: string[]; languages: string[]; tool_packs: { id: string; label: string; description: string; tools: string[] }[] }
export interface Guide {
  id: string; name: string; subject: string; blurb: string; initial: string; tint: string; avatar_url?: string | null;
  voice: string; language: string; tool_pack: string; price_per_min_tokens: number; status: GuideStatus; sort: number;
  published_prompt_version?: number | null; docs_ready?: number; docs_total?: number; sessions_7d?: number; updated_at?: number;
}
export interface GuidePrompt { id: string; version: number; persona: string; greeting: string | null; note: string | null; status: string; created_at: number; published_at: number | null }
export interface GuideDoc { id: string; kind: string; title: string; bytes: number; status: string; chunks: number; error: string | null; created_at: number }
export interface SessionRow { id: string; uid: string; name: string | null; email: string | null; started_at: number; minutes: number; cost_tokens: number; status: string; summary: string | null }
export interface SessionDetail { session: SessionRow & Record<string, unknown>; transcript: unknown; memories: unknown[]; charges: unknown[] }

const B = '/api/admin/v2/voice-agents';
const e = encodeURIComponent;

export const vgApi = {
  meta: () => adminCall<VoiceMeta>(`${B}/meta`),
  list: async () => (await adminCall<{ agents: Guide[] }>(B)).agents ?? [],
  create: (g: Partial<Guide>) => adminCall<{ agent: Guide }>(B, { method: 'POST', body: g }),
  update: (id: string, g: Partial<Guide>) => adminCall<{ agent: Guide }>(`${B}/${e(id)}`, { method: 'PUT', body: g }),
  archive: (id: string) => adminCall<unknown>(`${B}/${e(id)}`, { method: 'DELETE' }),
  prompts: async (id: string) => (await adminCall<{ prompts: GuidePrompt[] }>(`${B}/${e(id)}/prompts`)).prompts ?? [],
  savePrompt: (id: string, b: { persona: string; greeting?: string; note?: string }) => adminCall<{ prompt: GuidePrompt }>(`${B}/${e(id)}/prompts`, { method: 'POST', body: b }),
  publish: (id: string, pid: string) => adminCall<{ agent: Guide }>(`${B}/${e(id)}/prompts/${e(pid)}/publish`, { method: 'POST', body: {} }),
  docs: async (id: string) => (await adminCall<{ docs: GuideDoc[] }>(`${B}/${e(id)}/docs`)).docs ?? [],
  addUrl: (id: string, b: { url: string; title?: string }) => adminCall<unknown>(`${B}/${e(id)}/docs/url`, { method: 'POST', body: b, timeoutMs: 60_000 }),
  addText: (id: string, b: { title: string; text: string }) => adminCall<unknown>(`${B}/${e(id)}/docs/text`, { method: 'POST', body: b, timeoutMs: 60_000 }),
  deleteDoc: (id: string, did: string) => adminCall<unknown>(`${B}/${e(id)}/docs/${e(did)}`, { method: 'DELETE' }),
  reindex: (id: string, did: string) => adminCall<unknown>(`${B}/${e(id)}/docs/${e(did)}/reindex`, { method: 'POST', body: {} }),
  sessions: (id: string, cursor?: string) =>
    adminCall<{ sessions: SessionRow[]; cursor?: string | null }>(`${B}/${e(id)}/sessions`, { query: cursor ? { cursor } : {} }),
  session: (sid: string) => adminCall<SessionDetail>(`/api/admin/v2/voice-sessions/${e(sid)}`),
};

/** Multipart upload ("file") of a knowledge document. */
export async function uploadDoc(id: string, file: File): Promise<unknown> {
  const token = await adminToken();
  if (!token) throw new ApiError(401, 'unauthorized', { message: 'Please sign in again.' });
  const fd = new FormData();
  fd.append('file', file, file.name);
  const res = await fetch(`${API_BASE}${B}/${e(id)}/docs/file`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  let body: Record<string, unknown> = {};
  try { body = await res.json(); } catch { /* not json */ }
  if (!res.ok) throw new ApiError(res.status, String(body.error ?? 'upload_failed'), { message: String(body.error ?? `The upload failed (${res.status}).`) });
  return body;
}
