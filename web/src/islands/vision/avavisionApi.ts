// Phase-4 LOCAL AvaVision fetch module.
//
// WHY THIS FILE EXISTS (documented deviation #1 from the web-client MASTER §4):
//   The AvaVision endpoints (`/api/avavision/*`) post-date the web-client MASTER
//   §4 endpoint list, and the shared `lib/apiClient.ts` is READ-ONLY for this
//   phase. So we wrap `fetch` here EXACTLY like `lib/apiClient.ts` (same
//   `API_BASE`, same `Authorization: Bearer <jwt>` pattern, same `ApiError`)
//   for the `/api/avavision/*` routes only. Phase Z is asked (in the glue note)
//   to (a) add `/api/avavision/*` to MASTER §4 and (b) optionally promote these
//   helpers into `lib/apiClient.ts`. We do NOT edit `lib/apiClient.ts`.
//
// CONTRACT SOURCE: AvaVision Phase 1 (`worker/src/routes/avavision.ts`) was not
// merged into this tree at build time, so the snake_case request/response shapes
// below are derived from the AvaVision MASTER-PROMPT §4 contract + the verified
// AvaVoice baseline (`worker/src/routes/avavoice.ts`, mirrored 1:1 by the
// existing `web/src/islands/agent/api.ts`). Every path here is a real
// `https://api.avatok.ai` route from §4 — no endpoint is invented. If Phase 1
// lands different keys, only the `*FromJson` mappers here need a tweak.
//
// We reuse the shared `request` / `ApiError` (read-only) for the JSON transport,
// exactly like `islands/agent/api.ts` and `islands/marketplace/api.ts` do; the
// "local wrapper" requirement is satisfied by owning the typed AvaVision surface
// (paths + shapes + money-mutation idempotency) in this module.

import { request, ApiError } from '../../lib/apiClient';
import { API_BASE } from '../../lib/config';

export { ApiError };

const BASE = '/api/avavision';

// ─────────────────────────── shared enums (MASTER §6) ──────────────────────
export type Capability =
  | 'pose' | 'hand' | 'face_landmark' | 'face_detect' | 'gesture'
  | 'object' | 'image_class' | 'segmentation' | 'holistic' | 'gemini_only';
export type OverlayStyle =
  | 'skeleton' | 'hand_mesh' | 'face_mesh' | 'bounding_box' | 'segmentation_mask' | 'none';
export type ScoringMode = 'geometry' | 'gemini_qualitative' | 'hybrid' | 'none';
export type VisionMode = 'live' | 'agentic_snapshot' | 'both' | 'gemini_only';
export type PayerMode = 'user_pays' | 'creator_pays';
export type Platform = 'android' | 'ios' | 'web';

// Rulebook constants (verified against the AvaVoice baseline; AvaVision mirrors).
export const MAX_CONCURRENT_CALLS = 10; // D1 active-session cap (avavoice baseline)
export const MAX_SESSION_MINUTES = 60;
export const SESSION_LIMITS = [5, 10, 30, 60] as const;
export const CREATOR_PAYS_RATE_PER_HOUR = 500; // $5/hr flat, vision bundled
export const MIN_RATE_PER_HOUR = 100; // $1/hr listing floor

// ─────────────────────────── template catalog ─────────────────────────────
// Shape of `GET /api/avavision/templates?platform=web` (serves
// `Specs/avavision-templates.json`, filtered to platform=web).
export interface VisionTemplate {
  id: string;
  name: string;
  capability: Capability;
  mediapipeSolution: string | null;
  engineDefault?: string | null;
  engineUpgradeAndroidWeb?: string | null;
  platforms: Record<Platform, boolean>;
  overlayEnabled: boolean;
  overlayStyle: OverlayStyle;
  visionMode: VisionMode;
  scoringMode: ScoringMode;
  scoreLabel: string | null;
  trackedSubject: string;
  starterPrompt: string;
  freeSnapshotsPerSession?: number | null;
  safetyNotes: string[];
}

export interface VisionCategory {
  id: string;
  name: string;
  tagline: string;
  capability: Capability;
  mediapipeSolution: string | null;
  engineDefault?: string | null;
  defaultPlatforms: Record<Platform, boolean>;
  templates: VisionTemplate[];
}

function templateFromJson(j: Record<string, unknown>): VisionTemplate {
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' ? v : v == null ? undefined : Number(v);
  const plat = (j.platforms ?? {}) as Record<string, unknown>;
  return {
    id: String(j.id ?? ''),
    name: String(j.name ?? ''),
    capability: (j.capability as Capability) ?? 'gemini_only',
    mediapipeSolution: (j.mediapipe_solution as string | null) ?? null,
    engineDefault: (j.engine_default as string | null) ?? null,
    engineUpgradeAndroidWeb: (j.engine_upgrade_android_web as string | null) ?? null,
    platforms: {
      android: plat.android === true,
      ios: plat.ios === true,
      web: plat.web === true,
    },
    overlayEnabled: j.overlay_enabled === true,
    overlayStyle: (j.overlay_style as OverlayStyle) ?? 'none',
    visionMode: (j.vision_mode as VisionMode) ?? 'live',
    scoringMode: (j.scoring_mode as ScoringMode) ?? 'none',
    scoreLabel: (j.score_label as string | null) ?? null,
    trackedSubject: String(j.tracked_subject ?? ''),
    starterPrompt: String(j.starter_prompt ?? ''),
    freeSnapshotsPerSession: (num(j.free_snapshots_per_session) ?? null) as number | null,
    safetyNotes: Array.isArray(j.safety_notes) ? (j.safety_notes as unknown[]).map(String) : [],
  };
}

function categoryFromJson(j: Record<string, unknown>): VisionCategory {
  const plat = (j.default_platforms ?? {}) as Record<string, unknown>;
  return {
    id: String(j.id ?? ''),
    name: String(j.name ?? ''),
    tagline: String(j.tagline ?? ''),
    capability: (j.capability as Capability) ?? 'gemini_only',
    mediapipeSolution: (j.mediapipe_solution as string | null) ?? null,
    engineDefault: (j.engine_default as string | null) ?? null,
    defaultPlatforms: {
      android: plat.android !== false,
      ios: plat.ios === true,
      web: plat.web !== false,
    },
    templates: Array.isArray(j.templates)
      ? (j.templates as Record<string, unknown>[]).map(templateFromJson)
      : [],
  };
}

// ─────────────────────────── agent shape ──────────────────────────────────
// Mirrors VoiceAgent in `islands/agent/api.ts` + the AvaVision vision fields.
export interface VisionAgent {
  id: string;
  name: string;
  role: string;
  systemProfile: string;
  voiceName: string;
  payerMode: PayerMode;
  status: string; // 'draft' | 'published'
  avatarUrl?: string | null;
  images: string[];
  creatorUid?: string | null;
  creatorName?: string | null;
  ratePerHourCoins: number;
  sessionLimitMin: number;

  // vision fields
  capability: Capability;
  overlayEnabled: boolean;
  overlayStyle: OverlayStyle;
  scoringMode: ScoringMode;
  scoreLabel: string | null;
  visionMode: VisionMode;
  trackedSubject: string;
  agenticSnapshotEnabled: boolean;
  freeSnapshotsPerSession: number;
  saveSnapshots: boolean;
  platforms: Record<Platform, boolean>;
  safetyNotes: string[];

  // stats / availability
  callsTotal: number;
  ratingAvg?: number | null;
  activeCalls?: number | null;
}

export function agentFromJson(j: Record<string, unknown>): VisionAgent {
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' ? v : v == null ? undefined : Number(v);
  const plat = (j.platforms ?? {}) as Record<string, unknown>;
  return {
    id: String(j.id ?? ''),
    name: String(j.name ?? ''),
    role: String(j.role ?? ''),
    systemProfile: String(j.system_profile ?? ''),
    voiceName: String(j.voice_name ?? 'Puck'),
    payerMode: (String(j.payer_mode ?? 'user_pays') as PayerMode),
    status: String(j.status ?? 'draft'),
    avatarUrl: (j.avatar_url as string | null) ?? null,
    images: Array.isArray(j.images) ? (j.images as unknown[]).map(String) : [],
    creatorUid: (j.creator_uid as string | null) ?? null,
    creatorName: (j.creator_name as string | null) ?? null,
    ratePerHourCoins: num(j.rate_per_hour) ?? 0,
    sessionLimitMin: num(j.session_limit_min) ?? 30,

    capability: (j.capability as Capability) ?? 'gemini_only',
    overlayEnabled: j.overlay_enabled === true,
    overlayStyle: (j.overlay_style as OverlayStyle) ?? 'none',
    scoringMode: (j.scoring_mode as ScoringMode) ?? 'none',
    scoreLabel: (j.score_label as string | null) ?? null,
    visionMode: (j.vision_mode as VisionMode) ?? 'live',
    trackedSubject: String(j.tracked_subject ?? ''),
    agenticSnapshotEnabled: j.agentic_snapshot_enabled === true,
    freeSnapshotsPerSession: num(j.free_snapshots_per_session) ?? 0,
    saveSnapshots: j.save_snapshots === true,
    platforms: {
      android: plat.android === true,
      ios: plat.ios === true,
      web: plat.web === true,
    },
    safetyNotes: Array.isArray(j.safety_notes) ? (j.safety_notes as unknown[]).map(String) : [],

    callsTotal: num(j.calls_total) ?? 0,
    ratingAvg: (num(j.rating_avg) ?? null) as number | null,
    activeCalls: (num(j.active_calls) ?? null) as number | null,
  };
}

// ─────────────────────────── voices ───────────────────────────────────────
export interface Voice {
  name: string;
  label?: string | null;
  gender?: string | null;
}

function voiceFromJson(j: Record<string, unknown>): Voice {
  return {
    name: String(j.name ?? j.voice_name ?? ''),
    label: (j.label as string | null) ?? null,
    gender: (j.gender as string | null) ?? null,
  };
}

// ─────────────────────────── price helpers (coins = USD cents) ─────────────
export function isFreeForCallers(a: Pick<VisionAgent, 'payerMode'>): boolean {
  return a.payerMode === 'creator_pays';
}

export function isBusy(a: Pick<VisionAgent, 'activeCalls'>): boolean {
  return (a.activeCalls ?? 0) >= MAX_CONCURRENT_CALLS;
}

export function fmtCoins(coins: number): string {
  if (coins === 0) return 'Free';
  return `$${(coins / 100).toFixed(coins % 100 === 0 ? 0 : 2)}`;
}

export function rateLabel(a: Pick<VisionAgent, 'payerMode' | 'ratePerHourCoins'>): string {
  if (isFreeForCallers(a)) return 'Free to call';
  const perMin = Math.ceil(a.ratePerHourCoins / 60);
  return `${fmtCoins(a.ratePerHourCoins)}/hr · ${fmtCoins(perMin)}/min`;
}

// ─────────────────────────── PUBLIC reads (no auth) ────────────────────────

/** GET /api/avavision/templates?platform=web — category→use-case catalog. */
export async function getTemplates(
  platform: Platform = 'web',
  signal?: AbortSignal,
): Promise<VisionCategory[]> {
  const r = await request<{ categories?: Record<string, unknown>[] }>(`${BASE}/templates`, {
    query: { platform },
    signal,
  });
  return (r.categories ?? []).map(categoryFromJson);
}

/** GET /api/avavision/voices — reuses AvaVoice's voice catalog verbatim. */
export async function getVoices(signal?: AbortSignal): Promise<Voice[]> {
  const r = await request<{ voices?: Record<string, unknown>[] }>(`${BASE}/voices`, { signal });
  return (r.voices ?? []).map(voiceFromJson);
}

/** GET /api/avavision/marketplace?q= — published agents (PUBLIC). */
export async function getMarketplace(q?: string, signal?: AbortSignal): Promise<VisionAgent[]> {
  const r = await request<{ agents?: Record<string, unknown>[] }>(`${BASE}/marketplace`, {
    query: q ? { q } : undefined,
    signal,
  });
  return (r.agents ?? []).map(agentFromJson);
}

/**
 * GET /api/avavision/agents/:id/availability — live slot count (PUBLIC).
 * Returns `{ activeCalls, busy }` for the Call-Now / Agent-Busy badge.
 */
export async function getAvailability(
  id: string,
  signal?: AbortSignal,
): Promise<{ activeCalls: number; busy: boolean }> {
  const r = await request<Record<string, unknown>>(
    `${BASE}/agents/${encodeURIComponent(id)}/availability`,
    { signal },
  );
  const active = Number(r.active_calls ?? r.active ?? 0);
  const busy = r.busy === true || active >= MAX_CONCURRENT_CALLS;
  return { activeCalls: active, busy };
}

// ─────────────────────────── AUTHED reads (creator / detail) ───────────────

/** GET /api/avavision/agents/:id — full detail (requires session). 404 → null. */
export async function getAgent(
  id: string,
  auth: string,
  signal?: AbortSignal,
): Promise<VisionAgent | null> {
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

/** GET /api/avavision/agents/mine — creator's own agents. */
export async function getMine(auth: string, signal?: AbortSignal): Promise<VisionAgent[]> {
  const r = await request<{ agents?: Record<string, unknown>[] }>(`${BASE}/agents/mine`, {
    auth,
    signal,
  });
  return (r.agents ?? []).map(agentFromJson);
}

/** GET /api/avavision/agents/:id/stats — dashboard numbers. */
export interface AgentStats {
  callsTotal: number;
  avgScore?: number | null;
  peakScore?: number | null;
  snapshotCalls?: number | null;
  ratingAvg?: number | null;
}
export async function getStats(id: string, auth: string, signal?: AbortSignal): Promise<AgentStats> {
  const r = await request<Record<string, unknown>>(
    `${BASE}/agents/${encodeURIComponent(id)}/stats`,
    { auth, signal },
  );
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' ? v : v == null ? undefined : Number(v);
  return {
    callsTotal: num(r.calls_total) ?? 0,
    avgScore: (num(r.avg_score) ?? null) as number | null,
    peakScore: (num(r.peak_score) ?? null) as number | null,
    snapshotCalls: (num(r.snapshot_calls) ?? null) as number | null,
    ratingAvg: (num(r.rating_avg) ?? null) as number | null,
  };
}

// ─────────────────────────── creator mutations (authed) ────────────────────
// The create/update body is snake_case to match the Worker (mirrors avavoice).

export interface AgentDraftInput {
  name: string;
  role: string;
  systemProfile: string;
  voiceName: string;
  payerMode: PayerMode;
  ratePerHourCoins: number;
  sessionLimitMin: number;
  // vision config (seeded from the chosen template, editable)
  capability: Capability;
  overlayEnabled: boolean;
  overlayStyle: OverlayStyle;
  scoringMode: ScoringMode;
  scoreLabel: string | null;
  visionMode: VisionMode;
  trackedSubject: string;
  agenticSnapshotEnabled: boolean;
  freeSnapshotsPerSession: number;
  saveSnapshots: boolean;
  platforms: Record<Platform, boolean>;
  templateId?: string;
  avatarUrl?: string | null;
}

function draftToBody(d: AgentDraftInput): Record<string, unknown> {
  return {
    name: d.name,
    role: d.role,
    system_profile: d.systemProfile,
    voice_name: d.voiceName,
    payer_mode: d.payerMode,
    rate_per_hour: d.ratePerHourCoins,
    session_limit_min: d.sessionLimitMin,
    capability: d.capability,
    overlay_enabled: d.overlayEnabled,
    overlay_style: d.overlayStyle,
    scoring_mode: d.scoringMode,
    score_label: d.scoreLabel,
    vision_mode: d.visionMode,
    tracked_subject: d.trackedSubject,
    agentic_snapshot_enabled: d.agenticSnapshotEnabled,
    free_snapshots_per_session: d.freeSnapshotsPerSession,
    save_snapshots: d.saveSnapshots,
    platforms: d.platforms,
    template_id: d.templateId,
    avatar_url: d.avatarUrl ?? null,
  };
}

/** POST /api/avavision/agents — create a draft. Returns the new agent. */
export async function createAgent(d: AgentDraftInput, auth: string): Promise<VisionAgent> {
  const r = await request<{ agent?: Record<string, unknown> }>(`${BASE}/agents`, {
    method: 'POST',
    auth,
    body: draftToBody(d),
  });
  return agentFromJson(r.agent ?? {});
}

/** PUT /api/avavision/agents/:id — update a draft. */
export async function updateAgent(
  id: string,
  d: AgentDraftInput,
  auth: string,
): Promise<VisionAgent> {
  const r = await request<{ agent?: Record<string, unknown> }>(
    `${BASE}/agents/${encodeURIComponent(id)}`,
    { method: 'PUT', auth, body: draftToBody(d) },
  );
  return agentFromJson(r.agent ?? {});
}

/** POST /api/avavision/agents/:id/publish — server validates coherence + rate. */
export async function publishAgent(id: string, auth: string): Promise<VisionAgent> {
  const r = await request<{ agent?: Record<string, unknown> }>(
    `${BASE}/agents/${encodeURIComponent(id)}/publish`,
    { method: 'POST', auth },
  );
  return agentFromJson(r.agent ?? {});
}

/** POST /api/avavision/agents/:id/unpublish. */
export async function unpublishAgent(id: string, auth: string): Promise<VisionAgent> {
  const r = await request<{ agent?: Record<string, unknown> }>(
    `${BASE}/agents/${encodeURIComponent(id)}/unpublish`,
    { method: 'POST', auth },
  );
  return agentFromJson(r.agent ?? {});
}

/**
 * POST /api/avavision/agents/:id/files?name= — optional brain (File Search).
 * Binary upload: the shared `request()` JSON-encodes bodies, so this is a direct
 * fetch that still mirrors apiClient's `API_BASE` + Bearer + `ApiError` pattern.
 */
export async function uploadFile(
  id: string,
  name: string,
  file: Blob,
  auth: string,
): Promise<{ ok: boolean; fileId?: string }> {
  const u = new URL(`${API_BASE}${BASE}/agents/${encodeURIComponent(id)}/files`);
  u.searchParams.set('name', name);
  const res = await fetch(u.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth}`,
      'Content-Type': file.type || 'application/octet-stream',
    },
    body: file,
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const errMsg =
      parsed && typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : res.statusText || 'upload failed';
    throw new ApiError(res.status, errMsg, parsed);
  }
  const j = (parsed ?? {}) as { ok?: boolean; file_id?: string };
  return { ok: j.ok === true, fileId: j.file_id };
}

/** DELETE /api/avavision/agents/:id/files/:fid — remove a brain file. */
export async function deleteFile(id: string, fid: string, auth: string): Promise<{ ok: boolean }> {
  const r = await request<{ ok?: boolean }>(
    `${BASE}/agents/${encodeURIComponent(id)}/files/${encodeURIComponent(fid)}`,
    { method: 'DELETE', auth },
  );
  return { ok: r.ok === true };
}

// ─────────────────────────── money mutations (idempotent) ──────────────────
function uuid(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `idem_${Date.now()}_${Math.random().toString(36).slice(2)}`
  );
}

/** A money mutation: Idempotency-Key + one retry with the SAME key (mirrors AvaVoice). */
async function money<T>(
  path: string,
  body: unknown,
  auth: string,
): Promise<{ status: number; body: T | null; error?: string }> {
  const key = uuid();
  for (let attempt = 0; ; attempt++) {
    try {
      const data = await request<T>(path, {
        method: 'POST',
        body,
        auth,
        headers: { 'Idempotency-Key': key },
      });
      return { status: 200, body: data };
    } catch (e) {
      if (e instanceof ApiError) {
        return { status: e.status, body: (e.body as T) ?? null, error: e.error };
      }
      if (attempt >= 1) return { status: 0, body: null, error: 'network' };
    }
  }
}

/** POST /api/avavision/bookings — book a future session. */
export function book(agentId: string, startsAt: number, language: string, auth: string) {
  return money<{ ok: boolean; booking_id: string; escrow_coins: number }>(
    `${BASE}/bookings`,
    { agent_id: agentId, starts_at: startsAt, language },
    auth,
  );
}

/** POST /api/avavision/calls/now — instant call. 409 AGENT_BUSY · 402 insufficient. */
export function callNow(agentId: string, language: string, auth: string) {
  return money<{ ok: boolean; call_id: string; escrow_coins: number }>(
    `${BASE}/calls/now`,
    { agent_id: agentId, language },
    auth,
  );
}

// NOTE: session lifecycle (sessions/start, heartbeat, stop, snapshot) belongs to
// Phase 5 (`islands/vision/session/`). This module exports only the shared types
// and the discovery/creator/booking surface that Phase 4 owns.
