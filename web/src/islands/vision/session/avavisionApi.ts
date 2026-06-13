// Phase-5 LOCAL AvaVision fetch helpers.
//
// Thin wrappers over the read-only shared `request` (lib/apiClient) for the
// §4 AvaVision endpoints this phase needs. We do NOT edit apiClient and we do
// NOT invent endpoints — every path here is a documented https://api.avatok.ai
// route (MASTER-PROMPT §4 / worker/src/routes/avavision.ts, mirroring avavoice).
//
// The field shapes mirror Phase E's avavoice `api.ts` exactly (response keys are
// snake_case: session_id, token, model, limit_minutes, voice, language,
// beat_every_sec) PLUS the AvaVision vision fields from MASTER §4:
//   capability, overlay_style, scoring_mode, score_label, agentic_snapshot_enabled,
//   free_snapshots_per_session, token_expires_at, tracked_subject, engine.
// Money mutations carry an Idempotency-Key + one safe retry with the SAME key.
//
// GLUE NOTE (Phase Z): Phase 4 owns the canonical `web/src/islands/vision/avavisionApi.ts`.
// It had not landed when Phase 5 was built, so the session/snapshot wrappers live
// here under the Phase-5-owned `session/` dir. Phase Z should DEDUPE: move the
// shared agent/marketplace/session helpers up to `vision/avavisionApi.ts` and have
// both the studio (Phase 4) and the session (Phase 5) import from there.

import { request, ApiError } from '../../../lib/apiClient';

const BASE = '/api/avavision';

// ── enums (MASTER §6 / templates field_glossary) ──────────────────────────────
export type Capability =
  | 'pose'
  | 'hand'
  | 'face_landmark'
  | 'face_detect'
  | 'gesture'
  | 'object'
  | 'image_class'
  | 'segmentation'
  | 'holistic'
  | 'gemini_only';
export type OverlayStyle =
  | 'skeleton'
  | 'hand_mesh'
  | 'face_mesh'
  | 'bounding_box'
  | 'segmentation_mask'
  | 'none';
export type ScoringMode = 'geometry' | 'gemini_qualitative' | 'hybrid' | 'none';
/** Client-side engine choice (MASTER §7). `movenet` is the default pose engine. */
export type VisionEngine = 'movenet' | 'mediapipe_pose' | 'mediapipe' | 'gemini';

export const MAX_CONCURRENT_CALLS = 10; // rulebook cap (mirrors avavoice)
export const MAX_SESSION_MINUTES = 60;

/** Public vision-agent shape, mirroring VoiceAgent + the AvaVision vision fields. */
export interface VisionAgent {
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
  callsTotal: number;
  ratingAvg?: number | null;
  activeCalls?: number | null;
  // vision-specific
  capability: Capability;
  overlayStyle: OverlayStyle;
  scoringMode: ScoringMode;
  scoreLabel: string;
  trackedSubject: string;
  engine: VisionEngine;
  agenticSnapshotEnabled: boolean;
  freeSnapshotsPerSession: number;
  platforms: { android: boolean; ios: boolean; web: boolean };
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : v == null ? undefined : Number(v);
}

/** Derive the client engine from capability when the server doesn't pin one (MASTER §7). */
export function engineFor(capability: Capability, raw?: string | null): VisionEngine {
  if (raw === 'movenet' || raw === 'mediapipe_pose' || raw === 'mediapipe' || raw === 'gemini') return raw;
  if (capability === 'pose') return 'movenet';
  if (capability === 'gemini_only') return 'gemini';
  return 'mediapipe';
}

export function agentFromJson(j: Record<string, unknown>): VisionAgent {
  const capability = (String(j.capability ?? 'gemini_only')) as Capability;
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
    callsTotal: num(j.calls_total) ?? 0,
    ratingAvg: (num(j.rating_avg) ?? null) as number | null,
    activeCalls: (num(j.active_calls) ?? null) as number | null,
    capability,
    overlayStyle: (String(j.overlay_style ?? 'none')) as OverlayStyle,
    scoringMode: (String(j.scoring_mode ?? 'none')) as ScoringMode,
    scoreLabel: String(j.score_label ?? 'Score'),
    trackedSubject: String(j.tracked_subject ?? ''),
    engine: engineFor(capability, j.engine as string | null),
    agenticSnapshotEnabled: j.agentic_snapshot_enabled === true,
    freeSnapshotsPerSession: num(j.free_snapshots_per_session) ?? 0,
    platforms: {
      android: (j.platforms as any)?.android === true,
      ios: (j.platforms as any)?.ios === true,
      web: (j.platforms as any)?.web !== false,
    },
  };
}

export function isFreeForCallers(a: { payerMode: string }): boolean {
  return a.payerMode === 'creator_pays';
}

export function isBusy(a: { activeCalls?: number | null }): boolean {
  return (a.activeCalls ?? 0) >= MAX_CONCURRENT_CALLS;
}

export function fmtCoins(coins: number): string {
  if (coins === 0) return 'Free';
  return `$${(coins / 100).toFixed(coins % 100 === 0 ? 0 : 2)}`;
}

/** "Free to call" or "$X/hr · $Y/min" — coins are USD cents. */
export function rateLabel(a: VisionAgent): string {
  if (isFreeForCallers(a)) return 'Free to call';
  const perMin = Math.ceil(a.ratePerHourCoins / 60);
  return `${fmtCoins(a.ratePerHourCoins)}/hr · ${fmtCoins(perMin)}/min`;
}

// ── ephemeral ticket returned by sessions/start (MASTER §4) ────────────────────
export interface VisionTicket {
  sessionId: string;
  geminiToken: string; // ephemeral Gemini auth token (NEVER a Google secret)
  tokenExpiresAt?: number | null;
  model: string;
  limitMinutes: number;
  voice?: string | null;
  language: string;
  beatEverySec: number;
  // vision config (video locked LOW/~1fps server-side into the token)
  capability: Capability;
  overlayStyle: OverlayStyle;
  scoringMode: ScoringMode;
  scoreLabel: string;
  trackedSubject: string;
  engine: VisionEngine;
  agenticSnapshotEnabled: boolean;
  freeSnapshotsPerSession: number;
}

/** Marketplace read — PUBLIC (no auth). Used for the shareable page lookup. */
export async function getMarketplace(signal?: AbortSignal): Promise<VisionAgent[]> {
  const r = await request<{ agents?: Record<string, unknown>[] }>(`${BASE}/marketplace`, { signal });
  return (r.agents ?? []).map(agentFromJson);
}

/** Authed agent detail — GET /api/avavision/agents/:id (requires session). Null on 404. */
export async function getAgent(id: string, auth: string, signal?: AbortSignal): Promise<VisionAgent | null> {
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
async function money<T>(
  path: string,
  body: unknown,
  auth: string,
): Promise<{ status: number; body: T | null; error?: string }> {
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

/** POST /api/avavision/calls/now — instant call. 409 AGENT_BUSY · 402 insufficient. */
export function callNow(agentId: string, language: string, auth: string) {
  return money<{ ok: boolean; call_id: string; escrow_coins: number }>(
    `${BASE}/calls/now`,
    { agent_id: agentId, language },
    auth,
  );
}

/** POST /api/avavision/sessions/start — mints the ephemeral Gemini token (video locked LOW/~1fps). */
export async function sessionStart(
  args: { callId?: string; bookingId?: string; language: string },
  auth: string,
): Promise<{ status: number; ticket?: VisionTicket; error?: string }> {
  const body: Record<string, unknown> = { language: args.language };
  if (args.bookingId) body.booking_id = args.bookingId;
  if (args.callId) body.call_id = args.callId;
  const r = await money<Record<string, unknown>>(`${BASE}/sessions/start`, body, auth);
  if (r.status !== 200 || !r.body) return { status: r.status, error: r.error };
  const j = r.body;
  const capability = (String(j.capability ?? 'gemini_only')) as Capability;
  return {
    status: 200,
    ticket: {
      sessionId: String(j.session_id ?? ''),
      geminiToken: String(j.token ?? ''),
      tokenExpiresAt: num(j.token_expires_at) ?? null,
      model: String(j.model ?? ''),
      limitMinutes: num(j.limit_minutes) ?? MAX_SESSION_MINUTES,
      voice: (j.voice as string | null) ?? null,
      language: String(j.language ?? args.language),
      beatEverySec: num(j.beat_every_sec) ?? 60,
      capability,
      overlayStyle: (String(j.overlay_style ?? 'none')) as OverlayStyle,
      scoringMode: (String(j.scoring_mode ?? 'none')) as ScoringMode,
      scoreLabel: String(j.score_label ?? 'Score'),
      trackedSubject: String(j.tracked_subject ?? ''),
      engine: engineFor(capability, j.engine as string | null),
      agenticSnapshotEnabled: j.agentic_snapshot_enabled === true,
      freeSnapshotsPerSession: num(j.free_snapshots_per_session) ?? 0,
    },
  };
}

/** POST /api/avavision/sessions/heartbeat — keepalive. Returns ended/402 signals. */
export function sessionHeartbeat(sessionId: string, auth: string) {
  return money<{ ok: boolean; ended?: boolean; status?: string }>(
    `${BASE}/sessions/heartbeat`,
    { session_id: sessionId },
    auth,
  );
}

/** POST /api/avavision/sessions/stop — settle + refund unused escrow. Idempotent (§B). */
export function sessionStop(sessionId: string, auth: string, reason = 'user') {
  return money<{ ok: boolean }>(`${BASE}/sessions/stop`, { session_id: sessionId, reason }, auth);
}

export interface SnapshotResult {
  annotatedImage?: string | null; // data URL or https URL of the annotated frame
  score?: number | null;
  breakdown: string;
}

/**
 * POST /api/avavision/snapshot — the only NEW media path. Body { session_id, image }
 * where image = base64 JPEG of one hi-res frame. Returns { annotated_image, score,
 * breakdown }. 429 SNAPSHOT_CAP_REACHED is a NO-CHARGE fair-use limit (§B) — surfaced
 * as `capReached`, never an error toast.
 */
export async function snapshot(
  sessionId: string,
  imageB64: string,
  auth: string,
): Promise<{ status: number; result?: SnapshotResult; capReached?: boolean; error?: string }> {
  try {
    const r = await request<Record<string, unknown>>(`${BASE}/snapshot`, {
      method: 'POST',
      body: { session_id: sessionId, image: imageB64 },
      auth,
    });
    return {
      status: 200,
      result: {
        annotatedImage: (r.annotated_image as string | null) ?? null,
        score: num(r.score) ?? null,
        breakdown: String(r.breakdown ?? ''),
      },
    };
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 429) return { status: 429, capReached: true };
      return { status: e.status, error: e.error };
    }
    return { status: 0, error: 'network' };
  }
}
