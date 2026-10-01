/* [AUMFE-PANDIT-WEB-1] Authed calls for /pandit. Same pattern as islands/voice/api.ts: request() from lib/apiClient
 * (reports api_error itself) + the Clerk/guest token from lib/clerk. The chat call is a raw fetch because it must
 * read a POST server-sent-events stream (EventSource cannot POST or send an Authorization header). */
import { API_BASE } from '../../lib/env';
import { ApiError, request } from '../../lib/apiClient';
import { getActiveTokenWaited } from '../../lib/clerk';
import { apiError } from '../../lib/analytics';
import type { PanditState, PanditStreamEvent, ProfileInput } from './types';

const GUEST_JWT_KEY = 'saathum_guest_jwt';

export class SignedOutError extends Error {
  constructor() { super('Please sign in again.'); this.name = 'SignedOutError'; }
}

export async function authToken(): Promise<string | null> {
  const t = await getActiveTokenWaited(6000);
  if (t) return t;
  try { return localStorage.getItem(GUEST_JWT_KEY); } catch { return null; }
}

async function authed<T>(path: string, opts: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown } = {}): Promise<T> {
  const auth = await authToken();
  if (!auth) throw new SignedOutError();
  return request<T>(path, { timeoutMs: 20_000, ...opts, auth });
}

export function errMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.body && typeof e.body === 'object') {
    const m = (e.body as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  if (e instanceof TypeError) return 'You seem to be offline. Check your connection and try again.';
  return fallback;
}

export const getState = () => authed<PanditState>('/api/guides/pandit/state');

export const saveProfile = (p: ProfileInput) => authed<unknown>('/api/me/astro-profile', { method: 'PUT', body: p });
export const saveConsent = (consent: boolean) => authed<unknown>('/api/me/memory-consent', { method: 'POST', body: { consent } });
export const deleteMemory = (id: string) => authed<{ ok: boolean }>(`/api/me/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });

/**
 * POST /api/guides/pandit/chat and feed each SSE `data:` JSON event to onEvent.
 * Throws ApiError on a non-2xx response; an aborted fetch rejects with an AbortError (caller treats it as Stop).
 */
export async function streamChat(
  args: { conversation_id?: string; text: string },
  opts: { signal?: AbortSignal; onEvent: (ev: PanditStreamEvent) => void },
): Promise<void> {
  const auth = await authToken();
  if (!auth) throw new SignedOutError();
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/guides/pandit/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${auth}` },
      body: JSON.stringify(args),
      signal: opts.signal,
      cache: 'no-store',
    });
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'AbortError')) {
      apiError({ endpoint: '/api/guides/pandit/chat', method: 'POST', status: 0, reason: e instanceof Error ? e.message : String(e), ms: 0 });
    }
    throw e;
  }
  if (!res.ok || !res.body) {
    let body: unknown;
    try { body = await res.json(); } catch { body = undefined; }
    const code = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : res.statusText || 'request failed';
    apiError({ endpoint: '/api/guides/pandit/chat', method: 'POST', status: res.status, reason: code, ms: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0) });
    throw new ApiError(res.status, code, body);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const flushLine = (line: string) => {
    const l = line.trim();
    if (!l.startsWith('data:')) return;
    const payload = l.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let ev: PanditStreamEvent;
    try { ev = JSON.parse(payload) as PanditStreamEvent; } catch { return; }
    if (ev && typeof ev === 'object' && typeof ev.type === 'string') opts.onEvent(ev);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      flushLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  }
  if (buf) flushLine(buf);
}
