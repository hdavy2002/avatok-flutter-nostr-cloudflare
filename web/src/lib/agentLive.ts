// [AGENT-LIVE-1] Typed client for `/api/agents…` — the AI voice agent listing
// surface on GPT-Live-1. Shared by the admin UI (`islands/admin-agents/*`,
// workstream F) and the customer-facing booking/talk UI (`islands/agent-live/*`,
// workstream G) — see BUILD SPEC §3/§6/§11 M11.
//
// OWNERSHIP: this file belongs to workstream F (web admin UI). Per the build
// spec, WS-G imports the customer-side functions below rather than writing
// its own copy. If you are WS-G and need a different shape, edit call sites
// or ask — do not fork this file; a second copy of these exports is exactly
// the drift the spec's ownership table exists to prevent.
//
// Follows the house pattern of `lib/apiClient.ts` (same `API_BASE`, same
// `ApiError`, same `Authorization: Bearer <jwt>` for authed calls) but is its
// own module because these endpoints are not yet in apiClient's §4 surface —
// mirrors the precedent at `islands/vision/avavisionApi.ts`.
//
// Casing follows BUILD SPEC §3/§11 M11 literally, field by field: the admin
// create/patch body and every listing-shaped response are snake_case (the
// house convention — `price_per_min`, `slot_minutes`, `cover_media`, …), while
// the checkout/quote/book request bodies are camelCase exactly as §3 writes
// them (`startsAt`, `idempotencyKey`) because that is what the spec pins for
// those routes. Do not "fix" the casing to be consistent — it must match
// whatever WS-D/WS-C actually implement from the same spec.
//
// Every function here fetches its own auth token (unlike `apiClient.request`,
// which takes `auth` from the caller) so island call sites stay one-liners:
// `await adminListAgents()`, not `await adminListAgents(await getActiveToken())`.
// Public reads (`getAgentPublic`, `getAgentAvailability`) never attach a token.

import { request, ApiError, ws as wsUrl } from './apiClient';
import { API_BASE } from './config';
import { getActiveTokenWaited as getActiveToken } from './clerk';

export { ApiError };

const BASE = '/api/agents';

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : v == null ? undefined : Number(v);
}

/** Every authed call goes through here so a missing/expired session reads as
 *  a normal `ApiError(401)` instead of a confusing raw fetch failure. */
async function authToken(): Promise<string> {
  const t = await getActiveToken();
  if (!t) throw new ApiError(401, 'Your session ended. Reload the page to sign in again.');
  return t;
}

// ─────────────────────────── shared enums / constants ──────────────────────

export type PersonaKind = 'companion' | 'palmist' | 'astrologer' | 'coach' | 'custom';

/** The 12 GPT-Live-1 voice ids (BUILD SPEC §3, `GET /api/agents/admin/voices`). */
export const VOICE_IDS = [
  'quartz', 'ripple', 'vesper', 'willow', 'stone', 'gleam',
  'meridian', 'bossa', 'tempo', 'beacon', 'delta', 'cinder',
] as const;
export type VoiceId = (typeof VOICE_IDS)[number];

export const SLOT_MINUTE_OPTIONS = [5, 10, 20, 30, 40, 60] as const;

export type AgentStatus = 'draft' | 'published';

// ─────────────────────────── admin payload shapes (M11) ────────────────────

/** The subset of `listings` + `agent_live_agents` columns the admin editor
 *  reads and writes. Loosely typed on purpose (mirrors `ListingDetail` in
 *  `islands/admin/adminListingsShared.tsx`) — the exact column set is the
 *  worker's D1 schema, not something a web-only client should pin tightly. */
export type AgentAdminListing = Record<string, unknown> & {
  id: string;
  title?: string | null;
  blurb?: string | null;
  description?: string | null;
  category?: string | null;
  cover_media?: Array<{ url?: string; type?: string }> | null;
  status?: string | null; // 'draft' | 'published'
};

export type AgentAdminAgent = Record<string, unknown> & {
  persona_kind?: PersonaKind | string | null;
  voice?: VoiceId | string | null;
  language?: string | null;
  greeting?: string | null;
  instructions?: string | null;
  backend_instructions?: string | null;
  image_instructions?: string | null;
  price_per_min?: number | null;
  slot_minutes?: number[] | null;
  max_concurrent?: number | null;
  image_reading?: boolean | null;
  memory_enabled?: boolean | null;
  adults_only?: boolean | null;
};

export type KbFileStatus = 'uploaded' | 'indexing' | 'indexed' | 'failed';
export interface KbFile {
  fileId: string;
  name: string;
  bytes: number;
  status: KbFileStatus;
  error?: string | null;
  createdAt?: number | null;
}
function kbFileFromJson(j: Record<string, unknown>): KbFile {
  return {
    fileId: String(j.file_id ?? j.fileId ?? j.id ?? ''),
    name: String(j.name ?? j.filename ?? ''),
    bytes: num(j.bytes ?? j.size) ?? 0,
    status: (j.status as KbFileStatus) ?? 'uploaded',
    error: (j.error as string | null | undefined) ?? null,
    createdAt: (num(j.created_at) ?? null) as number | null,
  };
}

/** Row shape for the admin list page (BUILD SPEC §6 card fields). */
export interface AgentAdminRow {
  id: string;
  title: string;
  voice: string;
  pricePerMin: number;
  status: AgentStatus | string;
  maxConcurrent: number;
  kbCount: number;
  coverUrl?: string | null;
}
function adminRowFromJson(j: Record<string, unknown>): AgentAdminRow {
  return {
    id: String(j.id ?? j.listing_id ?? ''),
    title: String(j.title ?? 'Untitled agent'),
    voice: String(j.voice ?? ''),
    pricePerMin: num(j.price_per_min) ?? 0,
    status: String(j.status ?? 'draft'),
    maxConcurrent: num(j.max_concurrent) ?? 1,
    kbCount: num(j.kb_count) ?? 0,
    coverUrl: (j.cover_url as string | null | undefined) ?? (j.cover_media as { url?: string }[] | undefined)?.[0]?.url ?? null,
  };
}

export interface AgentAdminDetail {
  listing: AgentAdminListing;
  agent: AgentAdminAgent;
  kb: KbFile[];
}

/** The body `POST /api/agents/admin` and `PATCH /api/agents/admin/:id` accept
 *  (BUILD SPEC §11 M11) — snake_case, matches the worker's column names. */
export interface AgentAdminSaveBody {
  title?: string;
  blurb?: string;
  description?: string;
  category?: string;
  cover_media?: Array<{ url: string; type?: string }>;
  persona_kind?: PersonaKind;
  voice?: VoiceId | string;
  language?: string;
  greeting?: string;
  instructions?: string;
  backend_instructions?: string;
  image_instructions?: string;
  price_per_min?: number;
  slot_minutes?: number[];
  max_concurrent?: number;
  image_reading?: boolean;
  memory_enabled?: boolean;
  adults_only?: boolean;
}

// ─────────────────────────── admin: list / crud / publish ──────────────────

/** GET /api/agents/admin/list. A 403 here is the "you are not the agent admin"
 *  gate (BUILD SPEC D2) — callers should render "Admin only" on that status
 *  rather than a generic error. */
export async function adminListAgents(): Promise<AgentAdminRow[]> {
  const token = await authToken();
  const r = await request<{ agents?: Record<string, unknown>[] } | Record<string, unknown>[]>(
    `${BASE}/admin/list`,
    { auth: token },
  );
  const rows = Array.isArray(r) ? r : (r.agents ?? []);
  return rows.map(adminRowFromJson);
}

/** POST /api/agents/admin → `{listing_id}`. Creates `listings` +
 *  `agent_live_agents` in one batch (worker side). */
export async function adminCreateAgent(body: AgentAdminSaveBody): Promise<{ listingId: string }> {
  const token = await authToken();
  const r = await request<{ listing_id?: string; id?: string }>(`${BASE}/admin`, {
    method: 'POST', auth: token, body,
  });
  return { listingId: String(r.listing_id ?? r.id ?? '') };
}

/** GET /api/agents/admin/:id → `{listing, agent, kb}`. */
export async function adminGetAgent(id: string): Promise<AgentAdminDetail> {
  const token = await authToken();
  const r = await request<{ listing?: Record<string, unknown>; agent?: Record<string, unknown>; kb?: Record<string, unknown>[] }>(
    `${BASE}/admin/${encodeURIComponent(id)}`,
    { auth: token },
  );
  return {
    listing: (r.listing ?? { id }) as AgentAdminListing,
    agent: (r.agent ?? {}) as AgentAdminAgent,
    kb: (r.kb ?? []).map(kbFileFromJson),
  };
}

/** PATCH /api/agents/admin/:id — accepts the same subset as create. */
export async function adminPatchAgent(id: string, body: Partial<AgentAdminSaveBody>): Promise<AgentAdminDetail> {
  const token = await authToken();
  const r = await request<{ listing?: Record<string, unknown>; agent?: Record<string, unknown>; kb?: Record<string, unknown>[] }>(
    `${BASE}/admin/${encodeURIComponent(id)}`,
    { method: 'PATCH', auth: token, body },
  );
  return {
    listing: (r.listing ?? { id }) as AgentAdminListing,
    agent: (r.agent ?? {}) as AgentAdminAgent,
    kb: (r.kb ?? []).map(kbFileFromJson),
  };
}

/** POST /api/agents/admin/:id/publish `{publish}` → `{status}`. */
export async function adminPublishAgent(id: string, publish: boolean): Promise<{ status: string }> {
  const token = await authToken();
  const r = await request<{ status?: string }>(`${BASE}/admin/${encodeURIComponent(id)}/publish`, {
    method: 'POST', auth: token, body: { publish },
  });
  return { status: String(r.status ?? (publish ? 'published' : 'draft')) };
}

// ─────────────────────────── admin: knowledge base ──────────────────────────

/** GET /api/agents/admin/:id/kb — status polling target while any file is
 *  `indexing` (poll every 3s per BUILD SPEC §6). */
export async function adminListKb(id: string): Promise<KbFile[]> {
  const token = await authToken();
  const r = await request<{ kb?: Record<string, unknown>[] } | Record<string, unknown>[]>(
    `${BASE}/admin/${encodeURIComponent(id)}/kb`,
    { auth: token },
  );
  const rows = Array.isArray(r) ? r : (r.kb ?? []);
  return rows.map(kbFileFromJson);
}

/**
 * POST /api/agents/admin/:id/kb — multipart PDF/TXT/MD/DOCX upload.
 * Uses XHR (not `fetch`) so `onProgress` can report upload percentage while
 * dragging a large file — `fetch` has no upload-progress event.
 */
export function adminUploadKb(
  id: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<KbFile> {
  return new Promise((resolve, reject) => {
    void (async () => {
      let token: string;
      try {
        token = await authToken();
      } catch (e) {
        reject(e);
        return;
      }
      const form = new FormData();
      form.append('file', file, file.name);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}${BASE}/admin/${encodeURIComponent(id)}/kb`, true);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      if (onProgress) {
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) onProgress(Math.round((ev.loaded / ev.total) * 100));
        };
      }
      xhr.onerror = () => reject(new ApiError(0, 'network'));
      xhr.onload = () => {
        let parsed: unknown;
        try {
          parsed = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
        } catch {
          parsed = xhr.responseText;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          const errMsg =
            parsed && typeof parsed === 'object' && parsed !== null && 'error' in parsed
              ? String((parsed as { error: unknown }).error)
              : xhr.statusText || 'upload failed';
          reject(new ApiError(xhr.status, errMsg, parsed));
          return;
        }
        resolve(kbFileFromJson((parsed ?? {}) as Record<string, unknown>));
      };
      xhr.send(form);
    })();
  });
}

/** DELETE /api/agents/admin/:id/kb/:fileId. */
export async function adminDeleteKb(id: string, fileId: string): Promise<void> {
  const token = await authToken();
  await request(`${BASE}/admin/${encodeURIComponent(id)}/kb/${encodeURIComponent(fileId)}`, {
    method: 'DELETE', auth: token,
  });
}

/** POST /api/agents/admin/:id/test-call → a 3-min `is_test=1` booking, no
 *  hold, no money job. Opens `/talk/<bookingId>` in a new tab (caller does the
 *  `window.open`; this just resolves the path). */
export async function adminTestCall(id: string): Promise<{ bookingId: string; talkPath: string }> {
  const token = await authToken();
  const r = await request<{ booking_id?: string; bookingId?: string; talk_path?: string; talkPath?: string }>(
    `${BASE}/admin/${encodeURIComponent(id)}/test-call`,
    { method: 'POST', auth: token },
  );
  const bookingId = String(r.booking_id ?? r.bookingId ?? '');
  return { bookingId, talkPath: String(r.talk_path ?? r.talkPath ?? `/talk/${bookingId}`) };
}

/** GET /api/agents/admin/voices → the 12 voice ids + labels. */
export interface AdminVoice { id: VoiceId | string; label: string }
export async function adminVoices(): Promise<AdminVoice[]> {
  const token = await authToken();
  const r = await request<{ voices?: Record<string, unknown>[] } | Record<string, unknown>[]>(
    `${BASE}/admin/voices`,
    { auth: token },
  );
  const rows = Array.isArray(r) ? r : (r.voices ?? []);
  if (rows.length) {
    return rows.map((j) => ({ id: String(j.id ?? j.voice ?? ''), label: String(j.label ?? j.name ?? j.id ?? '') }));
  }
  // Fail open to the known static id list (BUILD SPEC §3) if the endpoint is
  // not yet live — the picker still renders with the right ids, just no
  // server-sourced label override.
  return VOICE_IDS.map((id) => ({ id, label: id }));
}

// ─────────────────────────── customer: public reads ────────────────────────

export interface AgentPublic {
  id: string;
  title: string;
  blurb: string | null;
  personaKind: PersonaKind | string;
  voice: string;
  slotMinutes: number[];
  pricePerMin: number;
  adultsOnly: boolean;
  imageReading: boolean;
  availableNow: boolean;
  nextFreeAt: number | null;
}
function agentPublicFromJson(j: Record<string, unknown>): AgentPublic {
  return {
    id: String(j.id ?? ''),
    title: String(j.title ?? ''),
    blurb: (j.blurb as string | null | undefined) ?? null,
    personaKind: (j.persona_kind as PersonaKind | string | undefined) ?? 'companion',
    voice: String(j.voice ?? ''),
    slotMinutes: Array.isArray(j.slot_minutes) ? (j.slot_minutes as unknown[]).map(Number) : [],
    pricePerMin: num(j.price_per_min) ?? 0,
    adultsOnly: j.adults_only === true,
    imageReading: j.image_reading === true,
    availableNow: j.available_now === true,
    nextFreeAt: (num(j.next_free_at) ?? null) as number | null,
  };
}

/** GET /api/agents/:id — public persona card, no auth. */
export async function getAgentPublic(id: string): Promise<AgentPublic> {
  const r = await request<Record<string, unknown>>(`${BASE}/${encodeURIComponent(id)}`);
  return agentPublicFromJson(r);
}

/** GET /api/agents/:id/availability?minutes=&day=&tz= — no auth. */
export async function getAgentAvailability(
  id: string,
  params: { minutes: number; day: string; tz: string },
): Promise<{ starts: number[] }> {
  const r = await request<{ starts?: number[] }>(`${BASE}/${encodeURIComponent(id)}/availability`, {
    query: { minutes: params.minutes, day: params.day, tz: params.tz },
  });
  return { starts: Array.isArray(r.starts) ? r.starts.map(Number) : [] };
}

// ─────────────────────────── customer: quote / book / manage ───────────────

/** Mirrors R2 §2.2's `AgentQuote` — persisted/signed server-side, echoed back
 *  verbatim to `postAgentBook`. Do not reshape or recompute any field on the
 *  client; the server treats the whole object (or its `quoteId`, depending on
 *  what WS-D lands) as opaque and re-validates the hash. */
export interface AgentQuote {
  quoteId: string;
  buyerUid: string;
  agentId: string;
  minutes: number;
  instant: boolean;
  scheduledStartMs: number | null;
  pricePerMin: number;
  amount: number;
  beneficiaryUid: string;
  feeBps: number;
  personaVersion: number;
  policyVersion: string;
  expiresAt: number;
  [k: string]: unknown; // opaque signature/extra fields WS-D adds — pass through
}
function agentQuoteFromJson(j: Record<string, unknown>): AgentQuote {
  return {
    ...j,
    quoteId: String(j.quoteId ?? j.quote_id ?? ''),
    buyerUid: String(j.buyerUid ?? j.buyer_uid ?? ''),
    agentId: String(j.agentId ?? j.agent_id ?? ''),
    minutes: num(j.minutes) ?? 0,
    instant: j.instant === true,
    scheduledStartMs: (num(j.scheduledStartMs ?? j.scheduled_start_ms) ?? null) as number | null,
    pricePerMin: num(j.pricePerMin ?? j.price_per_min) ?? 0,
    amount: num(j.amount) ?? 0,
    beneficiaryUid: String(j.beneficiaryUid ?? j.beneficiary_uid ?? ''),
    feeBps: num(j.feeBps ?? j.fee_bps) ?? 2000,
    personaVersion: num(j.personaVersion ?? j.persona_version) ?? 0,
    policyVersion: String(j.policyVersion ?? j.policy_version ?? 'agent-live-v2'),
    expiresAt: num(j.expiresAt ?? j.expires_at) ?? 0,
  };
}

/** POST /api/agents/:id/quote `{minutes, instant, startsAt?, tz}`. 503
 *  `agent_live_unavailable` when the lane gate fails — callers should show a
 *  "not available right now" state on that status, not a generic error. */
export async function postAgentQuote(
  id: string,
  body: { minutes: number; instant: boolean; startsAt?: number; tz: string },
): Promise<AgentQuote> {
  const token = await authToken();
  const r = await request<Record<string, unknown>>(`${BASE}/${encodeURIComponent(id)}/quote`, {
    method: 'POST', auth: token, body,
  });
  return agentQuoteFromJson(r);
}

export interface AgentBookResult {
  bookingId: string;
  startsAt: number;
  endsAt: number;
  talkPath: string;
}

/** POST /api/agents/:id/book `{quote, idempotencyKey}`. 402
 *  `insufficient_tokens` (server dual-emits legacy `insufficient_avacoins`),
 *  409 `seat_taken` (+`next_free_at` on the error body), 409
 *  `idempotency_conflict` — callers read `e.status`/`e.body` on `ApiError`. */
export async function postAgentBook(
  id: string,
  body: { quote: AgentQuote; idempotencyKey: string },
): Promise<AgentBookResult> {
  const token = await authToken();
  const r = await request<{ bookingId?: string; booking_id?: string; startsAt?: number; starts_at?: number; endsAt?: number; ends_at?: number; talkPath?: string; talk_path?: string }>(
    `${BASE}/${encodeURIComponent(id)}/book`,
    { method: 'POST', auth: token, body },
  );
  const bookingId = String(r.bookingId ?? r.booking_id ?? '');
  return {
    bookingId,
    startsAt: num(r.startsAt ?? r.starts_at) ?? 0,
    endsAt: num(r.endsAt ?? r.ends_at) ?? 0,
    talkPath: String(r.talkPath ?? r.talk_path ?? `/talk/${bookingId}`),
  };
}

export type AgentBookingStatus = string;
export interface AgentBooking {
  bookingId: string;
  agentId?: string | null;
  status: AgentBookingStatus;
  startsAt: number | null;
  endsAt: number | null;
  moneyState?: string | null;
  receiptLines?: Array<{ label: string; amount: number }>;
  talkPath?: string | null;
}
function agentBookingFromJson(j: Record<string, unknown>): AgentBooking {
  return {
    bookingId: String(j.bookingId ?? j.booking_id ?? j.id ?? ''),
    agentId: (j.agentId as string | undefined) ?? (j.agent_id as string | undefined) ?? null,
    status: String(j.status ?? ''),
    startsAt: (num(j.startsAt ?? j.starts_at) ?? null) as number | null,
    endsAt: (num(j.endsAt ?? j.ends_at) ?? null) as number | null,
    moneyState: (j.moneyState as string | undefined) ?? (j.money_state as string | undefined) ?? null,
    receiptLines: Array.isArray(j.receiptLines ?? j.receipt_lines)
      ? ((j.receiptLines ?? j.receipt_lines) as Record<string, unknown>[]).map((l) => ({
        label: String(l.label ?? ''),
        amount: num(l.amount) ?? 0,
      }))
      : undefined,
    talkPath: (j.talkPath as string | undefined) ?? (j.talk_path as string | undefined) ?? null,
  };
}

/** POST /api/agents/bookings/:bookingId/cancel. */
export async function cancelAgentBooking(bookingId: string): Promise<{ decision: string }> {
  const token = await authToken();
  const r = await request<{ decision?: string }>(`${BASE}/bookings/${encodeURIComponent(bookingId)}/cancel`, {
    method: 'POST', auth: token,
  });
  return { decision: String(r.decision ?? '') };
}

/** GET /api/agents/bookings/mine. */
export async function getMyAgentBookings(): Promise<AgentBooking[]> {
  const token = await authToken();
  const r = await request<{ bookings?: Record<string, unknown>[] } | Record<string, unknown>[]>(`${BASE}/bookings/mine`, { auth: token });
  const rows = Array.isArray(r) ? r : (r.bookings ?? []);
  return rows.map(agentBookingFromJson);
}

/** GET /api/agents/bookings/:bookingId. */
export async function getAgentBooking(bookingId: string): Promise<AgentBooking> {
  const token = await authToken();
  const r = await request<Record<string, unknown>>(`${BASE}/bookings/${encodeURIComponent(bookingId)}`, { auth: token });
  return agentBookingFromJson(r);
}

// ─────────────────────────── customer: talk room ────────────────────────────

export interface AgentPrejoin {
  wsUrl: string;
  roomToken: string;
  startsAt: number;
  endsAt: number;
  serverNow: number;
  agent: { name: string; avatar: string | null; voice: string };
  imageReading: boolean;
  memoryEnabled: boolean;
}
function prejoinFromJson(j: Record<string, unknown>): AgentPrejoin {
  const a = (j.agent ?? {}) as Record<string, unknown>;
  return {
    wsUrl: String(j.ws_url ?? j.wsUrl ?? ''),
    roomToken: String(j.room_token ?? j.roomToken ?? ''),
    startsAt: num(j.starts_at ?? j.startsAt) ?? 0,
    endsAt: num(j.ends_at ?? j.endsAt) ?? 0,
    serverNow: num(j.server_now ?? j.serverNow) ?? Date.now(),
    agent: {
      name: String(a.name ?? ''),
      avatar: (a.avatar as string | null | undefined) ?? null,
      voice: String(a.voice ?? ''),
    },
    imageReading: j.image_reading === true || j.imageReading === true,
    memoryEnabled: j.memory_enabled === true || j.memoryEnabled === true,
  };
}

/** POST /api/agents/talk/:bookingId/prejoin. */
export async function prejoinAgentTalk(bookingId: string): Promise<AgentPrejoin> {
  const token = await authToken();
  const r = await request<Record<string, unknown>>(`${BASE}/talk/${encodeURIComponent(bookingId)}/prejoin`, {
    method: 'POST', auth: token,
  });
  return prejoinFromJson(r);
}

/** `wss://…/api/agents/talk/:bookingId/ws?token=…` — the room WebSocket URL.
 *  Not itself a fetch; islands/agent-live/AgentLiveSocket.ts (WS-G) opens it. */
export function agentTalkWsUrl(bookingId: string, roomToken: string): string {
  return wsUrl(`${BASE}/talk/${encodeURIComponent(bookingId)}/ws`, roomToken);
}

/**
 * POST /api/agents/talk/:bookingId/image — multipart `file`, ≤ 8 MB,
 * JPEG/PNG/WebP. `clientUploadId` lets the caller correlate this upload with
 * an optimistic UI entry before the server's `imageId` comes back.
 */
export async function uploadTalkImage(
  bookingId: string,
  file: File | Blob,
  clientUploadId: string,
): Promise<{ imageId: string; status: string; clientUploadId: string }> {
  const token = await authToken();
  const form = new FormData();
  form.append('file', file, (file as File).name ?? 'photo.jpg');
  form.append('client_upload_id', clientUploadId);
  const res = await fetch(`${API_BASE}${BASE}/talk/${encodeURIComponent(bookingId)}/image`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
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
  const j = (parsed ?? {}) as { imageId?: string; image_id?: string; status?: string };
  return { imageId: String(j.imageId ?? j.image_id ?? ''), status: String(j.status ?? 'analyzing'), clientUploadId };
}

/** DELETE /api/agents/:id/memory/me — Forget me. */
export async function forgetAgentMemory(agentId: string): Promise<void> {
  const token = await authToken();
  await request(`${BASE}/${encodeURIComponent(agentId)}/memory/me`, { method: 'DELETE', auth: token });
}
