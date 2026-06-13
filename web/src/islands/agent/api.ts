// Phase-E LOCAL AvaVoice fetch helpers.
//
// Thin wrappers over the read-only shared `request` (lib/apiClient) for the
// §4 AvaVoice endpoints this phase needs. We do NOT edit apiClient and we do
// NOT invent endpoints — every path here is an EXISTING https://api.avatok.ai
// route (MASTER-PROMPT §4 / worker/src/routes/avavoice.ts).
//
// The field shapes mirror the app's reference client `app/lib/core/avavoice_api.dart`
// exactly (response keys: session_id, token, model, limit_minutes, voice,
// vision_enabled, beat_every_sec; call_id from /calls/now). Money mutations
// carry an Idempotency-Key + one safe retry with the SAME key, like the app.

import { request, ApiError } from '../../lib/apiClient';

const BASE = '/api/avavoice';

/** Public agent shape, mirroring VoiceAgent in avavoice_api.dart. */
export interface VoiceAgent {
  id: string;
  name: string;
  role: string;
  systemProfile: string;
  voiceName: string;
  payerMode: string; // 'user_pays' | 'creator_pays'
  status: string;
  avatarUrl?: string | null;
  images: string[];
  creatorUid?: string | null;
  creatorName?: string | null;
  ratePerHourCoins: number;
  sessionLimitMin: number;
  visionEnabled: boolean;
  callsTotal: number;
  ratingAvg?: number | null;
  activeCalls?: number | null;
}

export const MAX_CONCURRENT_CALLS = 10; // rulebook cap (avavoice_api.dart)
export const MAX_SESSION_MINUTES = 60;

export function agentFromJson(j: Record<string, unknown>): VoiceAgent {
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' ? v : v == null ? undefined : Number(v);
  return {
    id: String(j.id ?? ''),
    name: String(j.name ?? ''),
    role: String(j.role ?? ''),
    systemProfile: String(j.system_profile ?? ''),
    voiceName: String(j.voice_name ?? 'Puck'),
    payerMode: String(j.payer_mode ?? 'user_pays'),
    status: String(j.status ?? 'draft'),
    avatarUrl: (j.avatar_url as string | null) ?? null,
    images: Array.isArray(j.images) ? (j.images as unknown[]).map(String) : [],
    creatorUid: (j.creator_uid as string | null) ?? null,
    creatorName: (j.creator_name as string | null) ?? null,
    ratePerHourCoins: num(j.rate_per_hour) ?? 0,
    sessionLimitMin: num(j.session_limit_min) ?? 30,
    visionEnabled: j.vision_enabled === true,
    callsTotal: num(j.calls_total) ?? 0,
    ratingAvg: (num(j.rating_avg) ?? null) as number | null,
    activeCalls: (num(j.active_calls) ?? null) as number | null,
  };
}

export function isFreeForCallers(a: VoiceAgent): boolean {
  return a.payerMode === 'creator_pays';
}

export function isBusy(a: VoiceAgent): boolean {
  return (a.activeCalls ?? 0) >= MAX_CONCURRENT_CALLS;
}

/** "Free to call" or "$X/hr · $Y/min" — coins are USD cents. */
export function rateLabel(a: VoiceAgent): string {
  if (isFreeForCallers(a)) return 'Free to call';
  const perMin = Math.ceil(a.ratePerHourCoins / 60);
  return `${fmtCoins(a.ratePerHourCoins)}/hr · ${fmtCoins(perMin)}/min`;
}

export function fmtCoins(coins: number): string {
  if (coins === 0) return 'Free';
  return `$${(coins / 100).toFixed(coins % 100 === 0 ? 0 : 2)}`;
}

// ── ephemeral ticket returned by sessions/start ────────────────────────────
export interface SessionTicket {
  sessionId: string;
  geminiToken: string; // ephemeral Gemini auth token (NEVER a Google secret)
  model: string; // e.g. gemini-live-2.5-flash-native-audio | gemini-3.1-flash-live-preview
  limitMinutes: number;
  voice?: string | null;
  language: string;
  beatEverySec: number;
  visionEnabled: boolean;
}

/** Marketplace read — PUBLIC (no auth). Used for the shareable page lookup. */
export async function getMarketplace(signal?: AbortSignal): Promise<VoiceAgent[]> {
  const r = await request<{ agents?: Record<string, unknown>[] }>(`${BASE}/marketplace`, { signal });
  return (r.agents ?? []).map(agentFromJson);
}

/**
 * Authed agent detail — GET /api/avavoice/agents/:id.
 * NOTE: this endpoint requires a session (requireUser) in the Worker, so it is
 * only callable AFTER the guest gate. Returns null on 404.
 */
export async function getAgent(id: string, auth: string, signal?: AbortSignal): Promise<VoiceAgent | null> {
  try {
    const r = await request<{ agent?: Record<string, unknown> }>(
      `${BASE}/agents/${encodeURIComponent(id)}`,
      { auth, signal },
    );
    return r.agent ? agentFromJson(r.agent) : null;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

function uuid(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `idem_${Date.now()}_${Math.random().toString(36).slice(2)}`
  );
}

/** A money mutation: Idempotency-Key + one retry with the SAME key (mirrors app). */
async function money<T>(path: string, body: unknown, auth: string): Promise<{ status: number; body: T | null; error?: string }> {
  const key = uuid();
  for (let attempt = 0; ; attempt++) {
    try {
      const data = await request<T>(path, { method: 'POST', body, auth, headers: { 'Idempotency-Key': key } });
      return { status: 200, body: data };
    } catch (e) {
      if (e instanceof ApiError) {
        return { status: e.status, body: (e.body as T) ?? null, error: e.error };
      }
      if (attempt >= 1) return { status: 0, body: null, error: 'network' };
    }
  }
}

/** POST /api/avavoice/calls/now — instant call. 409 AGENT_BUSY · 402 insufficient_avacoins. */
export function callNow(agentId: string, language: string, auth: string) {
  return money<{ ok: boolean; call_id: string; escrow_coins: number }>(
    `${BASE}/calls/now`,
    { agent_id: agentId, language },
    auth,
  );
}

/** POST /api/avavoice/sessions/start — mints the ephemeral Gemini token. */
export async function sessionStart(
  args: { callId?: string; bookingId?: string; language: string },
  auth: string,
): Promise<{ status: number; ticket?: SessionTicket; error?: string }> {
  const body: Record<string, unknown> = { language: args.language };
  if (args.bookingId) body.booking_id = args.bookingId;
  if (args.callId) body.call_id = args.callId;
  const r = await money<Record<string, unknown>>(`${BASE}/sessions/start`, body, auth);
  if (r.status !== 200 || !r.body) return { status: r.status, error: r.error };
  const j = r.body;
  return {
    status: 200,
    ticket: {
      sessionId: String(j.session_id ?? ''),
      geminiToken: String(j.token ?? ''),
      model: String(j.model ?? ''),
      limitMinutes: Number(j.limit_minutes ?? MAX_SESSION_MINUTES),
      voice: (j.voice as string | null) ?? null,
      language: String(j.language ?? args.language),
      beatEverySec: Number(j.beat_every_sec ?? 60),
      visionEnabled: j.vision_enabled === true,
    },
  };
}

/** POST /api/avavoice/sessions/heartbeat — keepalive. Returns ended/402 signals. */
export async function sessionHeartbeat(sessionId: string, auth: string) {
  return money<{ ok: boolean; ended?: boolean; status?: string }>(
    `${BASE}/sessions/heartbeat`,
    { session_id: sessionId },
    auth,
  );
}

/** POST /api/avavoice/sessions/stop — settle + refund unused escrow. */
export function sessionStop(sessionId: string, auth: string, reason = 'user') {
  return money<{ ok: boolean }>(`${BASE}/sessions/stop`, { session_id: sessionId, reason }, auth);
}
