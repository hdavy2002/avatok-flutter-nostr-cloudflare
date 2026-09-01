/*
 * getstream.ts — the ONE place the web client talks to the commercial GetStream
 * lane. [WEB-GS-CORE-1 2026-09-01]
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * The server has minted correct GetStream credentials for paid live events and
 * paid 1:1 consultations since the Phase 2 build (worker/src/routes/
 * commercial_stream_sessions.ts). Nothing in the browser could consume them:
 * `web/package.json` carried no `@stream-io/*` package, and no file under
 * `web/src` called `/api/commercial/*`. The 1 Sep 2026 pipeline audit named that
 * as the single largest gap in the paid pipeline. This file plus the two islands
 * that import it are the fix.
 *
 * THE ONE RULE
 * ------------
 * The client NEVER constructs a call type or a call id. Both are minted
 * server-side in `worker/src/lib/commercial_stream_sessions.ts`:
 *
 *     live_event    → callType `avatok_livestream`,   id `live_<listingId>_<v>`
 *     consult_1to1  → callType `avatok_consult_1to1`, id `consult_<bookingId>`
 *
 * A client that guesses either one is a bug, not a shortcut — the server treats
 * a divergent id as a session-authority mismatch and refuses. Take `call_type`
 * and `call_id` from the join response, verbatim, always.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ---------------------------------------
 *   • No Cloudflare media fallback. The paid lane fails closed on purpose — an
 *     unmetered session is a money bug (SPEC-2026-08-24 §1). If the join is
 *     refused, show the refusal; do not route around it.
 *   • No entitlement logic. Whether this viewer has paid is the server's
 *     decision and only the server's; `403 ticket required` is an answer to
 *     render, not a rule to re-implement here.
 *   • No token caching across users. A GetStream token is bound to one user id.
 */

import { request, ApiError } from './apiClient';

/** The two paid session kinds. Matches the server's route segment, not its DB `kind`. */
export type CommercialKind = 'live' | 'consult';

/** Exactly what `authorizeProviderJoin` returns on success. Do not add fields. */
export interface CommercialJoinCredentials {
  /** GetStream project API key. Public by design — it is not a secret. */
  api_key: string;
  /** The GetStream user id the token is minted for. */
  user_id: string;
  /** Short-lived GetStream JWT. */
  token: string;
  /** `avatok_livestream` | `avatok_consult_1to1` — server's word, never ours. */
  call_type: string;
  /** `live_<listing>_<v>` | `consult_<booking>` — server's word, never ours. */
  call_id: string;
  /** `host` | `viewer` for live; `creator` | `buyer` for consult. */
  role: string;
  /** The `commercial_sessions` row id, for receipts and telemetry correlation. */
  session_id?: string;
}

/**
 * Every way the server can refuse a join, as a discriminated reason the UI can
 * switch on. Each one deserves its own screen — a generic toast throws away
 * information the buyer needs.
 *
 *   too_early      → the join window has not opened; show a countdown
 *   too_late       → the window closed or the session ended; offer the receipt
 *   needs_ticket   → NOT an error. The buyer can pay right now and walk in;
 *                    `commercial_checkout.ts` explicitly allows buying while a
 *                    listing is already `live`. Send them to checkout.
 *   not_yours      → this consultation is booked for somebody else
 *   disabled       → the lane is dark (all six commercial flags are false in
 *                    production as of 1 Sep 2026, so this is today's answer)
 *   unavailable    → provider not configured, or a transient server failure
 */
export type JoinRefusalReason =
  | 'too_early'
  | 'too_late'
  | 'needs_ticket'
  | 'not_yours'
  | 'disabled'
  | 'unavailable';

export interface JoinRefusal {
  ok: false;
  reason: JoinRefusalReason;
  status: number;
  /** The server's raw error string. For logs and telemetry — never for the screen. */
  detail: string;
  /** Present on `too_early`: epoch ms the join window opens. */
  opens_at?: number;
}

export type JoinResult =
  | ({ ok: true } & CommercialJoinCredentials)
  | JoinRefusal;

function refusalFor(e: ApiError): JoinRefusal {
  const detail = e.error || 'join refused';
  const body = (e.body && typeof e.body === 'object' ? e.body : {}) as Record<string, unknown>;
  const opensAt = typeof body.opens_at === 'number' ? body.opens_at : undefined;

  // The server distinguishes these by status first, message second. Status is
  // the load-bearing half: 425 and 410 are chosen deliberately in
  // `joinWindow()` and are unambiguous.
  if (e.status === 425) return { ok: false, reason: 'too_early', status: e.status, detail, opens_at: opensAt };
  if (e.status === 410) return { ok: false, reason: 'too_late', status: e.status, detail };
  if (e.status === 404) return { ok: false, reason: 'disabled', status: e.status, detail };
  if (e.status === 403) {
    // Two different 403s, and conflating them is the difference between "buy a
    // ticket" and "you are in the wrong room".
    //
    // Order matters here, and an earlier draft of this function got it wrong.
    // The server's two consult refusals are `not your booking` (you are neither
    // the creator nor the buyer) and `booking entitlement required` (you are the
    // buyer, but nothing is paid for). Both contain the word "booking", so a
    // `/booking|yours/` test that runs FIRST swallows the second one and tells a
    // buyer who simply hasn't paid that the session belongs to someone else —
    // a dead end instead of a checkout. Match the ownership refusal on its own
    // distinctive phrase, and let everything else fall through to the buy path.
    if (/not your/i.test(detail)) return { ok: false, reason: 'not_yours', status: e.status, detail };
    if (/ticket|entitlement/i.test(detail)) return { ok: false, reason: 'needs_ticket', status: e.status, detail };
    return { ok: false, reason: 'needs_ticket', status: e.status, detail };
  }
  return { ok: false, reason: 'unavailable', status: e.status, detail };
}

/**
 * Join a paid session. `id` is the LISTING id for `live`, the BOOKING id for
 * `consult` — that asymmetry is the server's, mirroring how the two call ids are
 * minted, and this signature keeps it visible rather than hiding it behind a
 * single misleading name.
 *
 * Never throws for a refusal — a refusal is a result. It throws only for a
 * genuinely broken transport (offline, DNS), which the caller should surface as
 * "couldn't reach avaTOK" rather than as anything about the session.
 */
export async function joinCommercialSession(
  kind: CommercialKind,
  id: string,
  jwt: string,
  signal?: AbortSignal,
): Promise<JoinResult> {
  try {
    const creds = await request<CommercialJoinCredentials>(
      `/api/commercial/${kind}/${encodeURIComponent(id)}/join`,
      { method: 'POST', auth: jwt, signal },
    );
    return { ok: true, ...creds };
  } catch (e) {
    if (e instanceof ApiError) return refusalFor(e);
    throw e;
  }
}

/**
 * `GET /api/commercial/consult/:id/prejoin` — the consult room's pre-flight.
 * Returns scheduling and counterparty detail so the green room can say who the
 * buyer is about to meet and when the block ends, without joining the call.
 */
export interface ConsultPrejoin {
  starts_at: number;
  ends_at: number;
  counterparty_name: string | null;
  counterparty_avatar: string | null;
  role: 'creator' | 'buyer';
  /** Epoch ms the join window opens; before this, joining returns 425. */
  join_opens_at?: number;
}

export async function consultPrejoin(
  bookingId: string,
  jwt: string,
  signal?: AbortSignal,
): Promise<ConsultPrejoin | JoinRefusal> {
  try {
    return await request<ConsultPrejoin>(
      `/api/commercial/consult/${encodeURIComponent(bookingId)}/prejoin`,
      { auth: jwt, signal },
    );
  } catch (e) {
    if (e instanceof ApiError) return refusalFor(e);
    throw e;
  }
}

/** `GET /api/commercial/{live|consult}/:id/state` — poll while waiting to start. */
export interface CommercialSessionState {
  state: 'scheduled' | 'backstage' | 'live' | 'ending' | 'ended' | 'cancelled';
  starts_at?: number;
  ends_at?: number;
  viewer_count?: number;
}

export function commercialSessionState(
  kind: CommercialKind,
  id: string,
  jwt: string,
  signal?: AbortSignal,
): Promise<CommercialSessionState> {
  return request<CommercialSessionState>(
    `/api/commercial/${kind}/${encodeURIComponent(id)}/state`,
    { auth: jwt, signal },
  );
}

/*
 * ── StreamVideoClient, memoised per user ───────────────────────────────────
 *
 * The SDK opens a websocket per client instance. React 18/19 double-invokes
 * effects in development, and a naive `new StreamVideoClient(...)` inside an
 * effect therefore opens two sockets and leaks one. Memoising on the user id
 * plus the api key makes a second construction for the same user a no-op.
 *
 * The import is dynamic so the ~200 kB SDK is fetched only on a page that
 * actually joins a call — the marketplace and checkout pages must not pay for
 * it. Callers `await` this once and hold the result.
 */

type AnyStreamClient = {
  disconnectUser: () => Promise<void>;
};

let cached: { key: string; client: AnyStreamClient } | null = null;

/**
 * Build (or reuse) the GetStream client for these credentials.
 *
 * Returns the SDK's `StreamVideoClient`, typed loosely here so this module does
 * not force the SDK into the bundle of anything that merely imports the join
 * helpers above. The two call islands import the SDK's types directly.
 */
export async function streamClientFor(creds: CommercialJoinCredentials): Promise<AnyStreamClient> {
  const key = `${creds.api_key}:${creds.user_id}`;
  if (cached && cached.key === key) return cached.client;

  // A different user on the same tab — tear the old socket down before opening
  // a new one, or the previous user stays presence-visible in their old call.
  if (cached) {
    try {
      await cached.client.disconnectUser();
    } catch {
      // Already gone. Nothing to do, and nothing worth telling the user.
    }
    cached = null;
  }

  const { StreamVideoClient } = await import('@stream-io/video-react-sdk');
  const client = new StreamVideoClient({
    apiKey: creds.api_key,
    user: { id: creds.user_id },
    token: creds.token,
  }) as unknown as AnyStreamClient;

  cached = { key, client };
  return client;
}

/** Drop the memoised client. Call on sign-out, not on leaving a call. */
export async function releaseStreamClient(): Promise<void> {
  if (!cached) return;
  const { client } = cached;
  cached = null;
  try {
    await client.disconnectUser();
  } catch {
    // Best effort — the socket is going away either way.
  }
}
