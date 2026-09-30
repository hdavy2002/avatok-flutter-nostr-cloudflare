// [SAATHUM-PREETI-1 2026-09-30] Client for the public Preeti chat API
// (worker/src/routes/preeti.ts). JSON calls go through apiClient.request so they
// get the shared api_error telemetry; the chat call is a raw fetch because it
// must read a POST server-sent-events stream (EventSource cannot POST).
import { API_BASE } from './env';
import { ApiError, request } from './apiClient';
import { apiError, captureException } from './analytics';
import type { PageCtx, PreetiPublicConfig, PreetiSession, PreetiStreamEvent } from './preetiTypes';

export function getPreetiConfig(signal?: AbortSignal): Promise<PreetiPublicConfig> {
  return request<PreetiPublicConfig>('/api/preeti/config', { signal, timeoutMs: 8000 });
}

export function openPreetiSession(
  body: { visitor_id: string; conversation_id?: string; page: PageCtx },
  auth?: string | null,
): Promise<PreetiSession> {
  return request<PreetiSession>('/api/preeti/session', { method: 'POST', body, auth: auth ?? null, timeoutMs: 15000 });
}

export function identifyPreeti(body: {
  conversation_id: string;
  visitor_id: string;
  email: string;
  whatsapp: string;
  name?: string;
}): Promise<{ ok: boolean; e164: string; email: string }> {
  return request('/api/preeti/identify', { method: 'POST', body, timeoutMs: 15000 });
}

/** A 400 from /identify: which field failed and the server's message (null for any other error). */
export function identifyFieldError(e: unknown): { field: 'email' | 'whatsapp'; message: string } | null {
  if (!(e instanceof ApiError) || e.status !== 400) return null;
  const b = e.body;
  const o = b && typeof b === 'object' ? (b as { error?: unknown; field?: unknown }) : {};
  const email = o.error === 'invalid_email' || o.field === 'email';
  const phone = o.error === 'invalid_phone' || o.field === 'whatsapp' || o.field === 'phone';
  if (!email && !phone) return null;
  return { field: email ? 'email' : 'whatsapp', message: apiMessage(e) ?? (email ? 'Please check your email address.' : 'Please check your WhatsApp number.') };
}

/** Human-readable server message from a failed call, when the body carries one. */
export function apiMessage(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const b = e.body;
  if (b && typeof b === 'object') {
    const o = b as { message?: unknown; error?: unknown };
    if (typeof o.message === 'string' && o.message) return o.message;
    if (typeof o.error === 'string' && o.error && o.error.includes(' ')) return o.error;
  }
  return null;
}

export interface ChatArgs {
  conversation_id: string;
  visitor_id: string;
  message: string;
  page: PageCtx;
  /** [SAATHUM-PREETI-LEADGATE-1] true + empty message: answer the questions already asked. */
  answer_pending?: boolean;
}

/**
 * POST /api/preeti/chat and feed each SSE `data:` JSON event to onEvent.
 * Throws ApiError on a non-2xx response (429 rate_limited, 503 ...).
 */
export async function streamPreetiChat(
  args: ChatArgs,
  opts: { auth?: string | null; signal?: AbortSignal; onEvent: (ev: PreetiStreamEvent) => void },
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (opts.auth) headers.Authorization = `Bearer ${opts.auth}`;
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/preeti/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify(args),
      signal: opts.signal,
    });
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'AbortError')) {
      apiError({ endpoint: '/api/preeti/chat', method: 'POST', status: 0, reason: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 });
    }
    throw e;
  }
  if (!res.ok) {
    let parsed: unknown = undefined;
    try { parsed = await res.json(); } catch { /* body was not JSON; status is enough */ }
    const code = parsed && typeof parsed === 'object' && 'error' in parsed ? String((parsed as { error: unknown }).error) : res.statusText || 'request failed';
    apiError({ endpoint: '/api/preeti/chat', method: 'POST', status: res.status, reason: code, ms: Date.now() - t0 });
    throw new ApiError(res.status, code, parsed);
  }

  const emit = (block: string) => {
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) return;
    let ev: PreetiStreamEvent;
    try {
      ev = JSON.parse(data) as PreetiStreamEvent;
    } catch (e) {
      captureException(e, { surface: 'preeti_stream', reason: 'bad_sse_json' });
      return;
    }
    opts.onEvent(ev);
  };

  if (!res.body) {
    const text = await res.text();
    for (const block of text.replace(/\r\n/g, '\n').split('\n\n')) emit(block);
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      emit(block);
    }
    if (done) break;
  }
  if (buf.trim()) emit(buf);
}
