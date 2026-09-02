// Typed fetch wrapper for the avatok.ai Worker API.
//
// RULES (MASTER-PROMPT §4):
//   - every call targets an EXISTING https://api.avatok.ai endpoint listed in §4;
//   - auth is a Clerk/guest session JWT sent as `Authorization: Bearer <jwt>`;
//   - public reads need no auth.
// Do NOT add a helper for an endpoint that isn't in §4.

import { API_BASE } from './config';
import type { Card, CardPage, Creator, CreatorStats, Listing, Review } from './types';

/** Typed error thrown on any non-2xx response. */
export class ApiError extends Error {
  readonly status: number;
  readonly error: string;
  readonly body: unknown;
  constructor(status: number, error: string, body?: unknown) {
    super(`API ${status}: ${error}`);
    this.name = 'ApiError';
    this.status = status;
    this.error = error;
    this.body = body;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** JSON-serializable body (object) — encoded automatically. */
  body?: unknown;
  /** Session JWT (guest or full). Attaches Authorization: Bearer <jwt>. */
  auth?: string | null;
  /** Extra query params (skips undefined/null values). */
  query?: Record<string, string | number | boolean | null | undefined>;
  /** Extra headers. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const base = path.startsWith('http') ? path : `${API_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
  if (!query) return base;
  const u = new URL(base);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/** Core typed request. Throws {@link ApiError} on non-2xx. */
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth, query, headers = {}, signal } = opts;
  const init: RequestInit = { method, headers: { ...headers }, signal };
  if (auth) (init.headers as Record<string, string>)['Authorization'] = `Bearer ${auth}`;
  if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const res = await fetch(buildUrl(path, query), init);
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const errMsg =
      parsed && typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : res.statusText || 'request failed';
    throw new ApiError(res.status, errMsg, parsed);
  }
  return parsed as T;
}

/**
 * Build a `wss://` URL for the WebSocket endpoints (live/consult rooms).
 * The Worker accepts the JWT via `?token=` for WS clients that can't set headers.
 * Pass a §4 WS path, e.g. `/api/live/${id}/room`.
 */
export function ws(path: string, token?: string | null): string {
  const httpUrl = buildUrl(path);
  const wsUrl = httpUrl.replace(/^http/, 'ws'); // http→ws, https→wss
  if (!token) return wsUrl;
  const u = new URL(wsUrl);
  u.searchParams.set('token', token);
  return u.toString();
}

// ───────────────────────── named §4 helpers (used by A–E) ─────────────────────

export interface ExploreParams {
  kind?: string;
  category?: string;
  country?: string;
  creator?: string;
  limit?: number;
  cursor?: string;
  /**
   * [MARKET-SECTION-1] The bazaar section (`listings.section`). NOT `vertical`,
   * which is the separate commerce|connect split. An unrecognised value is
   * ignored by the worker rather than matching nothing.
   */
  section?: string;
  /** Price band in tokens (₹1 = 1 token), inclusive both ends. */
  minPrice?: number;
  maxPrice?: number;
  /** Availability window as epoch ms against `starts_at`. */
  from?: number;
  to?: number;
  /** '' | newest | cheapest | popular | rating — the worker's vocabulary. */
  sort?: string;
}

/** GET /api/explore — public marketplace browse (no auth). */
export function getExplore(params: ExploreParams = {}, signal?: AbortSignal): Promise<CardPage> {
  return request<CardPage>('/api/explore', { query: { ...params }, signal });
}

/** GET /api/explore/live-now — currently-live listings (each `joinable: true`). */
export function getLiveNow(signal?: AbortSignal): Promise<{ listings: Card[] }> {
  return request<{ listings: Card[] }>('/api/explore/live-now', { signal });
}

/**
 * GET /api/listings/:id — full listing detail (public read).
 *
 * [LIST-DETAIL-2] The worker's actual response body (worker/src/routes/listings.ts,
 * function getListing) is the envelope `{ listing: {...}, creator_stats, reviews,
 * viewer }` — every Card-level field (id, title, price, cover_media, starts_at, ...)
 * lives UNDER `.listing`, not at the top level this function used to promise. That
 * mismatch typechecked (TS never complained) but left `listing.title`, `.price`,
 * `.poster` etc. silently `undefined` for every caller. Unwrapping HERE, at the one
 * fetch call, means every caller — `pages/l/[id].astro`, `pages/e/[event].astro`,
 * `pages/dashboard/l/[id].astro`, `pages/watch/[id].astro`, `pages/book/[id].astro`,
 * `pages/live/[id].astro` — gets a real flat `Listing` with no per-page unwrap.
 * Idempotent: a response that is already flat (a hand-built mock, or a future worker
 * change) passes through unchanged, since `inner` is only used when present.
 */
export async function getListing(id: string, auth?: string | null, signal?: AbortSignal): Promise<Listing> {
  const raw = await request<Record<string, unknown> & { listing?: Record<string, unknown> }>(
    `/api/listings/${encodeURIComponent(id)}`,
    { auth, signal },
  );
  const inner = raw?.listing && typeof raw.listing === 'object' ? raw.listing : null;
  if (!inner) return raw as unknown as Listing;
  return {
    ...(inner as unknown as Listing),
    creator_stats: (raw.creator_stats as CreatorStats | null | undefined) ?? (inner.creator_stats as CreatorStats | null | undefined) ?? null,
    reviews: (raw.reviews as Review[] | undefined) ?? (inner.reviews as Review[] | undefined) ?? [],
    viewer: (raw.viewer as Listing['viewer'] | undefined) ?? (inner.viewer as Listing['viewer'] | undefined),
  };
}

/** GET /api/creators/:id — creator channel (public read). */
export function getCreator(id: string, auth?: string | null, signal?: AbortSignal): Promise<Creator> {
  return request<Creator>(`/api/creators/${encodeURIComponent(id)}`, { auth, signal });
}
