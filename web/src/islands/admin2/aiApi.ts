// [SAATHUM-PREETI-1 2026-09-30] Typed calls for the Admin 2 "AI assistant" screens.
// Worker: worker/src/routes/admin2_ai.ts. Wire shapes mirror worker/src/lib/preeti/contracts.ts
// (declared locally so this island has no cross-agent import dependency).
import { API_BASE } from '../../lib/config';
import { fileNameHeader } from '../../lib/uploadHeaders';
import { ApiError, adminToken } from './adminApi';
import { adminCall } from './peopleKit';

export type PageKind = 'home' | 'article' | 'event' | 'other';
export type PreetiCard =
  | { type: 'event'; id: string; title: string; image: string | null; starts_at_ms: number | null;
      price_rupees: number | null; live_now: boolean; booking_open: boolean; read_more_url: string; book_url: string }
  | { type: 'article'; slug: string; title: string; image: string | null; url: string };
export type PreetiStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'card'; card: PreetiCard }
  | { type: 'handover'; url: string }
  | { type: 'done'; message_id: number }
  | { type: 'error'; code: string; message: string };

export interface BrandRuntime { name: string; domain: string; site: string; former: { name: string; domain: string | null }[] }
export interface QuickReplies { home: string[]; article: string[]; event: string[] }
export interface AdminAiConfig {
  name: string; avatar_url: string | null; welcome_text: string; quick_replies: QuickReplies;
  support_whatsapp: string; alert_whatsapp: string; enabled: boolean;
  monthly_cap_rupees: number; active_prompt_id: string | null; flag_enabled: boolean;
}
export interface AdminAiPrompt { id: string; body: string; note: string | null; created_by: string; created_at: number; published_at: number | null; active: boolean }
export interface AdminAiFile { id: string; file_name: string; mime: string; size_bytes: number; status: string; error: string | null; created_at: number }
export interface AdminAiKnowledgeDoc { url: string; kind: 'article' | 'page'; title: string | null; status: string; synced_at: number | null; error: string | null }
export interface AdminAiIncident { id: string; listing_id: string | null; listing_title: string | null; message: string; starts_at: number; expires_at: number | null; source: string; created_at: number }
export type ConvStatus = 'open' | 'resolved' | 'needs_human';
export interface AdminAiConversationRow {
  id: string; name: string | null; e164: string | null; uid: string | null; visitor_label: string;
  last_text: string; last_message_at: number; badges: string[]; status: ConvStatus; lead_score: number; message_count: number;
}
export interface AdminAiMessage { id: number; role: 'visitor' | 'preeti' | 'tool' | 'admin_note' | 'system'; text: string; cards: PreetiCard[]; tool_name: string | null; tool_summary: string | null; blocked: boolean; created_at: number }
export interface AdminAiConversationDetail {
  conversation: AdminAiConversationRow & { first_page: string | null; last_page: string | null; admin_note: string | null };
  messages: AdminAiMessage[];
  bookings: { checkout_id: string; listing_title: string; status: string; created_at: number }[];
}
export interface AdminAiBrand { current: BrandRuntime; checklist: string[] }
export interface AdminAiBrandChangeResult { ok: boolean; error?: string; check: { question: string; answer: string; pass: boolean }[] }
export interface AdminAiSpend { month: string; cost_rupees: number; cap_rupees: number; pct: number; messages: number; conversations: number }

const B = '/api/admin/v2/ai';

/** Lists may come back as a bare array or {items:[…]}; accept both. */
export function asList<T>(r: unknown): T[] {
  if (Array.isArray(r)) return r as T[];
  if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>;
    for (const k of ['items', 'prompts', 'files', 'docs', 'incidents']) if (Array.isArray(o[k])) return o[k] as T[];
  }
  return [];
}

export const aiApi = {
  config: () => adminCall<AdminAiConfig>(`${B}/config`),
  saveConfig: (patch: Partial<AdminAiConfig>) => adminCall<unknown>(`${B}/config`, { method: 'PUT', body: patch }),
  spend: () => adminCall<AdminAiSpend>(`${B}/spend`),
  generateAvatar: () => adminCall<{ candidates: string[] }>(`${B}/avatar/generate`, { method: 'POST', body: {}, timeoutMs: 120_000 }),
  brand: () => adminCall<AdminAiBrand>(`${B}/brand`),
  changeBrand: (name: string, domain: string) => adminCall<AdminAiBrandChangeResult>(`${B}/brand/change`, { method: 'POST', body: { name, domain }, timeoutMs: 180_000 }),
  prompts: async () => asList<AdminAiPrompt>(await adminCall<unknown>(`${B}/prompts`)),
  savePrompt: (body: string, note: string) => adminCall<unknown>(`${B}/prompts`, { method: 'POST', body: { body, note } }),
  publishPrompt: (id: string) => adminCall<unknown>(`${B}/prompts/${encodeURIComponent(id)}/publish`, { method: 'POST', body: {} }),
  files: async () => asList<AdminAiFile>(await adminCall<unknown>(`${B}/files`)),
  deleteFile: (id: string) => adminCall<unknown>(`${B}/files/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  knowledge: async () => asList<AdminAiKnowledgeDoc>(await adminCall<unknown>(`${B}/knowledge`)),
  syncKnowledge: (full: boolean) => adminCall<unknown>(`${B}/knowledge/sync`, { method: 'POST', body: { full }, timeoutMs: 120_000 }),
  incidents: async () => asList<AdminAiIncident>(await adminCall<unknown>(`${B}/incidents`)),
  createIncident: (b: { listing_id: string | null; message: string; expires_at: number | null }) => adminCall<unknown>(`${B}/incidents`, { method: 'POST', body: b }),
  deleteIncident: (id: string) => adminCall<unknown>(`${B}/incidents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  conversations: (q: { q?: string; badge?: string; status?: string; cursor?: string }) =>
    adminCall<{ items: AdminAiConversationRow[]; next_cursor?: string }>(`${B}/conversations`, { query: q }),
  conversation: (id: string) => adminCall<AdminAiConversationDetail>(`${B}/conversations/${encodeURIComponent(id)}`),
  patchConversation: (id: string, p: { status?: ConvStatus; admin_note?: string }) =>
    adminCall<unknown>(`${B}/conversations/${encodeURIComponent(id)}`, { method: 'PUT', body: p } /* PATCH fails the CORS preflight */),
};

/** Raw-body upload to an admin AI route (avatar / knowledge file). Returns the parsed JSON. */
export async function uploadRaw<T = Record<string, unknown>>(path: string, file: File, mime: string): Promise<T> {
  const token = await adminToken();
  if (!token) throw new ApiError(401, 'unauthorized', { message: 'Please sign in again.' });
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'x-content-type': mime, 'Content-Type': mime, 'x-file-name': fileNameHeader(file.name) },
    body: file,
  });
  let body: Record<string, unknown> = {};
  try { body = await res.json(); } catch { /* not json */ }
  if (!res.ok) throw new ApiError(res.status, String(body.error ?? 'upload_failed'), { message: String(body.message ?? `The upload failed (${res.status}).`) });
  return body as T;
}
export const uploadAvatar = (file: File) => uploadRaw<{ url?: string; avatar_url?: string }>(`${B}/avatar`, file, file.type);
export const uploadKnowledgeFile = (file: File, mime: string) => uploadRaw(`${B}/files`, file, mime);

/** POST /ai/test-chat and stream the SSE events (fetch + ReadableStream). Resolves when the stream ends. */
export async function streamTestChat(
  body: { prompt_id?: string; message: string; conversation_id: string },
  onEvent: (e: PreetiStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const token = await adminToken();
  if (!token) throw new ApiError(401, 'unauthorized', { message: 'Please sign in again.' });
  const res = await fetch(`${API_BASE}${B}/test-chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let b: Record<string, unknown> = {};
    try { b = await res.json(); } catch { /* not json */ }
    throw new ApiError(res.status, String(b.error ?? 'test_chat_failed'), b);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const flush = (chunk: string) => {
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const json = line.slice(5).trim();
      if (!json) continue;
      try { onEvent(JSON.parse(json) as PreetiStreamEvent); } catch { /* ignore a malformed frame */ }
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) { flush(buf.slice(0, i)); buf = buf.slice(i + 2); }
  }
  if (buf.trim()) flush(buf);
}
