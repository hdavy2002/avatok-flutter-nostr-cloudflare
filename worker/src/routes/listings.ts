// Phase 6 — Listings pipeline + AvaExplore marketplace + creator channels.
// (PHASE-06.md). Events/consults marketplace; SEPARATE from AvaOLX (digital
// goods). Tables in DB_META (avatok-meta): listings, reviews, creator_profiles,
// creator_follows, listing_promotions, orders, listings_fts, listing_categories.
//
// Creation pipeline (auth, KYC-gated publish):
//   POST   /api/listings                       create draft
//   PUT    /api/listings/:id                   step updates (owner)
//   POST   /api/listings/:id/publish           guards: requireKyc; live → claimBlock (409 conflict)
//   POST   /api/listings/:id/status            owner: live|completed|cancelled (Phase 7 glue)
//   POST   /api/listings/:id/duplicate         A6 — copy, clear date/slot, draft
//   DELETE /api/listings/:id                   cancel + release slot
//   GET    /api/listings/mine                  my listings (any status)
//   GET/POST /api/listings/:id/promotions      A5 — early-bird + promo codes
//   DELETE /api/listings/:id/promotions/:pid
//
// Marketplace reads (PUBLIC — A3 guest browsing, no auth required):
//   GET /api/explore?kind=&category=&country=&cursor=
//   GET /api/explore/live-now
//   GET /api/explore/search?q=&…filters…&sort=     A1 — FTS5 search
//   GET /api/explore/categories
//   GET /api/listings/:id                          details + creator card + reviews p1
//   GET /api/creators/:id                          channel page
//
// Social + money glue (auth):
//   POST   /api/listings/:id/book        order + booking + escrow hold + email
//   POST   /api/listings/:id/reviews     attendees only
//   POST/DELETE /api/creators/:id/follow A2 (+ fan-out notify on publish/go-live)
//   POST/DELETE /api/creators/:id/block  A4 buyer-side block
//   PUT    /api/creators/me              A7 channel editor
//   POST   /api/report                   A4 → user_reports pipeline
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail, requireKyc } from "../authz";
import { metaDb, metaSession, moderationDb } from "../db/shard";
import { claimBlock, releaseBlocks, policyViolation } from "../cal/engine";
import { hold, refund } from "../ledger";
import { LANGS as TRL_LANGS, RATE_PER_MIN as TRL_RATE } from "./translate";
import { track } from "../hooks";
// [MKT-POSTER-AUTO-1] Shared poster generation, extracted from admin_listings.ts.
import {
  buildPosterPrompt,
  generateListingPoster,
  type CoverMediaItem,
  type PosterState,
} from "../lib/listing_poster";
import { resolveCreatorSubject } from "../lib/poster_subject";
import { brainIngest } from "../lib/brain_ingest";
import { partyEmit } from "./messaging"; // PartyKit live nudges (ephemeral)
import { recordView, trackImpressions, geoOf } from "./insights";
import { guardWrite } from "./moderate"; // save-time content validation (Nemotron)
import { notifyUser } from "../notify";
import { emailBookingConfirmed } from "../cal/emails";
// [AVA-IDGATE-1] readConfig is no longer read here — gatePublicAction() owns the
// flag check (identityGatingEnabled) and the fail-closed posture.
import { gatePublicAction, emailOf, type PublicAction } from "../lib/identity_gate";
import { commercialLaneState, commercialLaneFlags, type CommercialLaneState } from "../lib/commercial_lane";
// [AVA-MKT-VERT-1] Taxonomy: verticals, pinned category versions, attrs validation.
// Spec: Specs/PLAN-2026-07-17-ai-listing-creation-DRAFT.md §2.0, §2.2, §2.3, §2.4.
import { DEFAULT_VERTICAL, resolveCategoryVersion, validateAttrs } from "./categories";
// [MARKET-SECTION-1] `section` (the bazaar group) is NOT `vertical`
// (commerce|connect). See lib/listing_section.ts.
import { sectionFor, isSection, publishBlockedReason, DEFAULT_SECTION, SECTIONS, groupFor } from "../lib/listing_section";
// [AVA-MKT-ENTITLEMENTS-1] §5 quota + §1.3 token charge, consumed inside the publish
// keyed on listing_id (§3.3c). Same helper the compose publish path calls.
import {
  consumeListingEntitlement,
  finalizeListingPublication,
  markListingEntitlementPublished,
  quoteListingEntitlement,
  type ListingEntitlementOk,
} from "../lib/listing_billing";
import { readConfig } from "./config";
// [C01 MKT-STATUS-GATE-1] The server-owned status transition table — see the file
// header there for the exact bypass this closes (setListingStatus used to accept
// any source status for live|completed|cancelled and every source but 'draft' for
// draft, which made rejected/pending_review/approved/completed/cancelled -> live
// all reachable from the client).
import { checkTransition } from "../lib/listing_transitions";
// [Step0 FREE-ENTRY-GATE-1] free_entry is metered with no server-side circuit
// breaker (see the file header there) — creation/edit into free_entry=1 is
// allowlist-gated, not open to every creator.
import { freeEntryAllowed } from "../lib/free_entry_gate";
// [PRICE-HOURLY-1]
import { priceFloorError } from "../lib/session_pricing";

const APP = "avaexplore";
// live_event/consult = creator services; sell/buy/social = AvaMarketplace listings.
const KINDS = new Set(["live_event", "consult", "sell", "buy", "social"]);
const MARKET_KINDS = new Set(["sell", "buy", "social"]);
const CAPACITIES = new Set([1, 10, 20]);
const FANOUT_DAILY_CAP = 2;       // A2 anti-spam
const FANOUT_MAX_FOLLOWERS = 500;

// [LIST-CONTENT-2] Spec: Specs/SPEC-2026-09-01-LISTING-CONTENT-AND-BOOKING.md §C.1.
// Curated enums for the new listing-content columns. `vibe_tags` in particular is a
// PICKLIST, never free text (§C.1: "the mock's `100% MASALA` chips are copy, not data").
const SCHEDULE_MODES = new Set(["fixed_date", "recurring", "on_request", "always_on"]);
// [PRICE-HOURLY-1] "hour" added — every session is now priced per hour (spec
// §4). The legacy values stay in the set: they are still on old rows and on
// the wire for any client that hasn't updated, and BILLING_UNITS is a
// validation allowlist, not a statement about what's accepted going forward.
const BILLING_UNITS = new Set(["session", "minute", "10min", "chat", "night", "game", "hour"]);
const VIBE_TAGS = new Set([
  "safe_space", "cam_optional", "listener_first", "savage", "beginner_ok", "queer_friendly", "women_only",
]);
// [MKT-3GROUP-1] spec §3 — audio-only vs audio+video. THIS SET ONLY VALIDATES
// THE FIELD; wiring it into the GetStream call UI is separate work (see the
// migration header for media_mode).
const MEDIA_MODES = new Set(["audio_video", "audio_only"]);
const SLUG_RE = /^[a-z0-9-]{1,48}$/;

async function marketplacePublishOn(env: Env): Promise<boolean> {
  try {
    const cfg = await readConfig(env);
    return cfg.marketplaceEnabled === true && cfg.marketplacePublishEnabled === true;
  } catch { return false; }
}

// Once a commercial service lane is enabled, the legacy booking endpoint must
// not be able to create an order that has no commercial entitlement or policy
// snapshot. Keep the old booking behavior intact while that lane is dark.
// [COMM-FLAG-UNIFY-1] `commercialBookingLaneOn` REMOVED. It read only the
// *ListingsEnabled flags, which was half the question — see lib/commercial_lane.ts.
// bookListing now calls commercialLaneState() directly so both sides of the fence read
// the same four flags through the same function.

// [LIVE-CARVE-1] Is the publish-time KYC check on? Returns null when the config is
// unreadable so the caller can 503 rather than guess. FAILS CLOSED by intent: an
// unreadable config must never be the reason an unverified account ships a paid
// listing, which is the opposite posture to gatePublicAction's (that one fails open
// because bricking every public action is worse than one ungated post).
async function listingPublishKycRequired(env: Env): Promise<boolean | null> {
  try {
    return (await readConfig(env)).listingPublishKycRequired !== false;
  } catch { return null; }
}

function marketplaceOff(): Response {
  return json({
    error: "marketplace_publish_disabled",
    message: "Marketplace publishing is temporarily unavailable.",
  }, 503);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Optional auth: a uid when a valid token rides the request, else null (guest). */
async function maybeUid(req: Request, env: Env): Promise<string | null> {
  const hasTok = !!req.headers.get("authorization") || !!new URL(req.url).searchParams.get("token");
  if (!hasTok) return null;
  const ctx = await requireUser(req, env);
  return isFail(ctx) ? null : ctx.uid;
}

async function nameOf(env: Env, uid: string): Promise<string> {
  const r = await metaDb(env).prepare("SELECT display_name, handle FROM users WHERE uid=?1").bind(uid).first<any>();
  return r?.display_name || r?.handle || "an AvaTOK creator";
}

function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== "string" || !s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

// [AVA-MKT-VERT-1] §2.0 — `vertical` is a filter on EVERY listing query, and the
// cross-vertical rule is absolute: a listing never crosses. A Connect profile
// surfacing in a commerce search is a §2.6 safety violation, not a preference.
//
// The DEFAULT is what makes this free: every read below resolves an absent
// ?vertical to 'commerce', and the migration back-fills every existing row to
// 'commerce' (2026-07-18-listings-taxonomy-columns.sql:157) — so every caller that
// shipped before today keeps seeing exactly the rows it saw yesterday.
//
// Mirrors normVertical() in categories.ts (kept local rather than exported across
// the module boundary for one regex). Anything that isn't id-shaped falls back to
// commerce rather than 400ing: a junk ?vertical must not be a way to probe for the
// other vertical's rows, and it is bound as a parameter regardless.
function vertOf(raw: string | null | undefined): string {
  const v = String(raw ?? "").trim().toLowerCase();
  return /^[a-z][a-z0-9_]{0,31}$/.test(v) ? v : DEFAULT_VERTICAL;
}

/** Push `l.vertical=?N` onto a read's WHERE. Every browse/search/mine/favourites
 *  read calls this — see the block above for why the default is load-bearing. */
function verticalFilter(req: Request, binds: unknown[], where: string[]): string {
  const vertical = vertOf(new URL(req.url).searchParams.get("vertical"));
  binds.push(vertical);
  where.push(`l.vertical=?${binds.length}`);
  return vertical;
}

// [AVA-MKT-VERT-1] §2.2 — `attrs` is ONE JSON column of user/LLM-authored answers,
// so it needs a hard size cap the way every other free field here has one.
//
// 8 KB, and the number is reasoned, not round:
//   * WHAT IT HOLDS — answers to a category's field_schema. The worst schema in the
//     plan (property, §2.2) is ~10 short scalars; 8 KB is ~2.5x headroom over a
//     pessimistic 30-field × 100-char category (~3 KB), so no honest listing can hit it.
//   * WHY NOT BIGGER — attrs rides CARD_SELECT, so it is returned for EVERY card on
//     EVERY page. A 50-card browse page is the real constraint: 50 × 8 KB = 400 KB,
//     which still clears D1's response ceiling with room for the rest of the card.
//     Cap it at description's 8000 and one page could not be a megabyte of JSON.
//   * WHY IT MATCHES description (8000) — the same "largest thing a user can type"
//     class of field, so there is one number to remember instead of two.
// Measured in BYTES, not characters: a cap on `.length` is a cap on nothing when the
// content is Devanagari or emoji (3–4 bytes/char), which for this app is the norm.
const ATTRS_MAX_BYTES = 8192;

/** Encode `attrs` to the JSON we store, or explain why we won't.
 *
 *  REJECTS rather than truncates, deliberately: slicing a JSON string at 8192 bytes
 *  produces invalid JSON, which parseJson() then silently swallows to `{}` on read —
 *  i.e. the seller's answers vanish with no error anywhere. A 422 is the only honest
 *  outcome. Callers that must not fail (normFields) drop the field instead of writing
 *  a blob that can never be read back. */
function encodeAttrs(v: unknown): { json: string | null; error?: string } {
  if (v === null) return { json: null };            // explicit clear
  if (typeof v !== "object" || Array.isArray(v)) {
    return { json: null, error: "attrs must be a JSON object" };
  }
  // Assigned via a nullable local rather than a bare `let s: string` — stringify throws
  // on a cycle, and TS's definite-assignment analysis across try/catch is the kind of
  // thing that compiles today and warns after a tsconfig change. Nothing typechecks this
  // Worker in CI, so it is written to be obviously correct instead of merely legal.
  let s: string | null = null;
  try { s = JSON.stringify(v); } catch { s = null; }
  if (s === null) return { json: null, error: "attrs must be JSON-serialisable" };
  const bytes = new TextEncoder().encode(s).length;
  if (bytes > ATTRS_MAX_BYTES) {
    return { json: null, error: `attrs too large (${bytes} bytes; max ${ATTRS_MAX_BYTES})` };
  }
  return { json: s };
}

// [C02 MKT-POSTER-PROTECT-1] `attrs.poster` is SERVER-OWNED moderation state:
// admin_listings.ts reads `attrs.poster.status` as its publish gate (:213) and its
// regeneration lock (:167). `normFields` used to accept `attrs` wholesale and
// `encodeAttrs` only checks object-ness/size, so a creator PUT of
// `{"attrs":{"poster":{"status":"approved"}}}` satisfied the admin publish gate and
// blocked regeneration — forging or erasing moderation state through a field the
// creator otherwise legitimately owns (category attrs, etc).
//
// This also fixes a related silent-erasure bug: because `attrs` is a full-column
// REPLACE (not a merge), any normal creator edit that resends `attrs` without a
// `poster` key — which is every edit a client makes through a form that doesn't
// round-trip the poster object — would have wiped a previously-approved poster.
// Splicing the server's existing value back in fixes both directions at once.
//
// If another key is ever found to need the same protection, add it here — do not
// assume `poster` is the only one.
const RESERVED_ATTRS_KEYS = ["poster"] as const;

/** Strip server-owned keys from creator-supplied `attrs` and splice the server's
 *  own current value back in, so a creator can neither forge nor erase them.
 *  `existing` is the row's ALREADY-STORED attrs object (or null for a brand-new
 *  listing, which has no poster yet). Non-object input is returned unchanged —
 *  encodeAttrs()/contentAttrsError() are what reject a malformed shape; this
 *  helper only ever narrows a shape that is already going to be validated. */
function sanitizeCreatorAttrs(raw: unknown, existing: Record<string, unknown> | null): unknown {
  const out: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  // Double-underscore keys are server transport internals. Strip every current
  // and future key; restore reserved state only from the authoritative row.
  for (const k of Object.keys(out)) if (k.startsWith("__")) delete out[k];
  for (const k of RESERVED_ATTRS_KEYS) {
    delete out[k];
    if (existing && existing[k] !== undefined) out[k] = existing[k];
  }
  return out;
}

const COMMERCIAL_REFUND_WINDOWS = new Set([0, 12, 24, 48]);
const COMMERCIAL_BOOKING_NOTICE_HOURS = new Set([1, 2, 6, 24]);

/** Creator-selected display policy is still server-bounded before storage.
 * Checkout later freezes these validated values into an immutable snapshot;
 * clients cannot invent extra commercial_* authority inside generic attrs. */
function commercialPolicyError(kind: string, raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const attrs = raw as Record<string, unknown>;
  const commercialKeys = Object.keys(attrs).filter((k) => k.startsWith("commercial_"));
  if (!commercialKeys.length) return null;
  const liveKeys = new Set(["commercial_refund_window_hours"]);
  const consultKeys = new Set([
    "commercial_cancellation_window_hours",
    "commercial_reschedule_allowed",
    "commercial_booking_notice_hours",
    "commercial_preparation_instructions",
    "commercial_no_show_policy",
  ]);
  const allowed = kind === "live_event" ? liveKeys : kind === "consult" ? consultKeys : new Set<string>();
  if (commercialKeys.some((k) => !allowed.has(k))) return "unsupported commercial policy field";
  if (kind === "live_event") {
    if (!COMMERCIAL_REFUND_WINDOWS.has(Number(attrs.commercial_refund_window_hours))) {
      return "commercial refund deadline must be 0, 12, 24 or 48 hours";
    }
    return null;
  }
  if (kind === "consult") {
    if (!COMMERCIAL_REFUND_WINDOWS.has(Number(attrs.commercial_cancellation_window_hours))) {
      return "commercial cancellation deadline must be 0, 12, 24 or 48 hours";
    }
    if (!COMMERCIAL_BOOKING_NOTICE_HOURS.has(Number(attrs.commercial_booking_notice_hours))) {
      return "commercial booking notice must be 1, 2, 6 or 24 hours";
    }
    if (typeof attrs.commercial_reschedule_allowed !== "boolean") {
      return "commercial reschedule setting must be boolean";
    }
    if (attrs.commercial_no_show_policy !== "session_charged") {
      return "unsupported commercial no-show policy";
    }
    const preparation = attrs.commercial_preparation_instructions;
    if (typeof preparation !== "string" || preparation.length > 600) {
      return "commercial preparation instructions must be at most 600 characters";
    }
  }
  return null;
}

// [LIST-CONTENT-2] Validates the new scalar listing-content COLUMNS (spec §C.1) —
// schedule shape, timezone, billing unit, seat cap, response-time chip and vibe
// tags. Mirrors commercialPolicyError's posture: an explicit bad value is REJECTED
// rather than silently coerced to a fallback, because a rejected write tells the
// creator something is wrong; a silently-coerced one (a typo'd schedule_mode
// quietly becoming 'fixed_date') does not. `raw` is the untouched request body —
// checked directly (not the normalized `f`) so a caller always gets told about the
// exact value they sent, the same reasoning encodeAttrs()/commercialPolicyError()
// use elsewhere in this file. Returns null when nothing new-column-shaped is wrong.
function listingContentFieldsError(raw: any): string | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.schedule_mode !== undefined && raw.schedule_mode !== null && !SCHEDULE_MODES.has(String(raw.schedule_mode))) {
    return "schedule_mode must be fixed_date, recurring, on_request or always_on";
  }
  const mode = raw.schedule_mode !== undefined && raw.schedule_mode !== null ? String(raw.schedule_mode) : undefined;
  if (raw.recurrence_days !== undefined && raw.recurrence_days !== null) {
    const arr = raw.recurrence_days;
    const ok = Array.isArray(arr) && arr.every((d: unknown) => Number.isInteger(Number(d)) && Number(d) >= 0 && Number(d) <= 6);
    if (!ok) return "recurrence_days must be an array of integers 0-6";
    if (mode !== undefined && mode !== "recurring") return "recurrence_days only applies when schedule_mode is recurring";
  }
  if (raw.recurrence_time !== undefined && raw.recurrence_time !== null) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(raw.recurrence_time))) return "recurrence_time must be 'HH:MM'";
    if (mode !== undefined && mode !== "recurring") return "recurrence_time only applies when schedule_mode is recurring";
  }
  if (raw.timezone !== undefined && raw.timezone !== null && !isValidTimezone(String(raw.timezone))) {
    return "timezone must be a valid IANA timezone";
  }
  if (raw.billing_unit !== undefined && raw.billing_unit !== null && !BILLING_UNITS.has(String(raw.billing_unit))) {
    return "billing_unit must be session, minute, 10min, chat, night, game or hour";
  }
  // [MKT-3GROUP-1] spec §3 — media_mode. An explicit bad value is rejected,
  // same posture as billing_unit above; normFields forces the value to
  // 'hour' for billing_unit but media_mode has two real, meaningful values,
  // so it is validated-and-kept rather than validated-and-overwritten.
  if (raw.media_mode !== undefined && raw.media_mode !== null && !MEDIA_MODES.has(String(raw.media_mode))) {
    return "media_mode must be audio_video or audio_only";
  }
  if (raw.max_per_booking !== undefined && raw.max_per_booking !== null) {
    const n = Math.trunc(Number(raw.max_per_booking));
    if (!Number.isInteger(n) || n < 1 || n > 20) return "max_per_booking must be an integer from 1 to 20";
  }
  if (raw.response_time_min !== undefined && raw.response_time_min !== null) {
    const n = Math.trunc(Number(raw.response_time_min));
    if (!Number.isInteger(n) || n < 0) return "response_time_min must be a non-negative integer";
  }
  if (raw.vibe_tags !== undefined && raw.vibe_tags !== null) {
    const arr = raw.vibe_tags;
    if (!Array.isArray(arr) || arr.length > 2 || arr.some((t: unknown) => !VIBE_TAGS.has(String(t)))) {
      return `vibe_tags must be up to 2 of: ${[...VIBE_TAGS].join(", ")}`;
    }
  }
  if (raw.blurb !== undefined && raw.blurb !== null && String(raw.blurb).length > 120) {
    return "blurb must be at most 120 characters";
  }
  if (raw.credential !== undefined && raw.credential !== null && String(raw.credential).length > 40) {
    return "credential must be at most 40 characters";
  }
  return null;
}

/** IANA timezone check the way MDN documents it: Intl.DateTimeFormat throws
 *  RangeError on an unrecognised zone, so a try/catch IS the validator. */
function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** [LIST-CONTENT-2] `attrs` keys the DETAILS PAGE reads (never the card) — spec
 *  §C.2 and TRUST §4.3: how-it-works, house rules, FAQ, sample Q&A/chat,
 *  can/can't-do, join requirements, and the one cross-field rule that belongs
 *  here because it needs `free_entry`: `content_free_cap_tokens` is REQUIRED
 *  (a positive int) exactly when the listing is free_entry=1 — the cap the free
 *  lane (§E) holds from the creator's wallet at go-live.
 *
 *  Same posture as commercialPolicyError: unknown/absent keys are never
 *  violations (a schema addition must never orphan an older client's draft;
 *  min_required enforcement, if any, belongs at publish time, not here). Only a
 *  key that IS present and malformed is rejected. */
function contentAttrsError(attrs: unknown, freeEntry: boolean): string | null {
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return null;
  const a = attrs as Record<string, unknown>;

  const isStr = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
  const strArray = (v: unknown, max: number, itemMax: number) =>
    Array.isArray(v) && v.length <= max && v.every((s) => isStr(s, itemMax));
  const qaArray = (v: unknown, max: number, qMax: number, aMax: number) =>
    Array.isArray(v) && v.length <= max &&
    v.every((x) => x && typeof x === "object" && isStr((x as any).q, qMax) && isStr((x as any).a, aMax));

  // [LIST-OPTIONAL-CONTENT-1 2026-09-04, owner decision] Both sections are
  // OPTIONAL in the wizard now, so the floor is 1, not 2/3. Omitting the key
  // entirely was always allowed (these are `!== undefined` guards) — what was
  // NOT allowed was sending a single step, which is a perfectly reasonable
  // thing for a creator to write and now round-trips instead of 400ing.
  // Loosening only: every payload that passed before still passes, so no
  // existing listing or shipped client is affected. The upper caps and the
  // per-item length limits are unchanged and still enforced.
  if (a.content_how_it_works !== undefined) {
    const v = a.content_how_it_works;
    const ok = Array.isArray(v) && v.length >= 1 && v.length <= 5 &&
      v.every((x) => x && typeof x === "object" && isStr((x as any).label, 24) && isStr((x as any).body, 240));
    if (!ok) return "content_how_it_works must be 1-5 items of {label<=24, body<=240}";
  }
  if (a.content_house_rules !== undefined) {
    const v = a.content_house_rules;
    const ok = Array.isArray(v) && v.length >= 1 && v.length <= 8 &&
      v.every((x) => x && typeof x === "object" && isStr((x as any).heading, 32) && isStr((x as any).body, 200));
    if (!ok) return "content_house_rules must be 1-8 items of {heading<=32, body<=200}";
  }
  if (a.content_house_rules_intro !== undefined && !isStr(a.content_house_rules_intro, 280)) {
    return "content_house_rules_intro must be a string of at most 280 characters";
  }
  if (a.content_join_lead_minutes !== undefined) {
    const n = Number(a.content_join_lead_minutes);
    if (!Number.isInteger(n) || n < 0 || n > 60) return "content_join_lead_minutes must be an integer 0-60";
  }
  // [PRICE-HOURLY-2 2026-09-05] NO LONGER REQUIRED WHEN free_entry IS SET.
  //
  // It used to be, and that broke the free lane the moment the wizard stopped
  // asking for it (owner decision 2026-09-05: "if the free option is selected,
  // then we should not ask the admin to enter a token amount"). The control
  // went, the server requirement stayed, and step 2 answered every free show
  // with "content_free_cap_tokens is required" — an error naming a field that
  // no longer exists on any screen.
  //
  // The cap is NOT dead, and it is not decorative: with
  // `freeSessionTokensPerAttendeeMinute` at 1 in production, it is the budget
  // that decides how many people may join. So it is now DERIVED rather than
  // demanded — `freeSessionPolicy` (lib/free_session.ts) falls back to
  // capacity × duration × rate, i.e. exactly enough to fill the room for the
  // whole session. An explicit cap still wins if a row carries one.
  //
  // Which is why the shape check below survives for a value that IS sent: an
  // existing listing's cap, or a future control, must still be a positive
  // integer. A zero here would mean "budget for nobody", and the free lane
  // would fail closed with no error anyone could see.
  if (a.content_free_cap_tokens !== undefined) {
    const n = Number(a.content_free_cap_tokens);
    if (!Number.isInteger(n) || n <= 0) return "content_free_cap_tokens must be a positive integer";
  }
  if (a.content_what_you_get !== undefined) {
    const v = a.content_what_you_get;
    if (!(Array.isArray(v) && v.length >= 3 && v.length <= 5 && v.every((s) => isStr(s, 80)))) {
      return "content_what_you_get must be 3-5 strings of at most 80 characters";
    }
  }
  if (a.content_who_for !== undefined && !strArray(a.content_who_for, 3, 80)) {
    return "content_who_for must be up to 3 strings of at most 80 characters";
  }
  if (a.content_not_for !== undefined && !strArray(a.content_not_for, 3, 80)) {
    return "content_not_for must be up to 3 strings of at most 80 characters";
  }
  if (a.content_faq !== undefined) {
    const v = a.content_faq;
    if (!(Array.isArray(v) && v.length >= 3 && v.length <= 6 && qaArray(v, 6, 120, 300))) {
      return "content_faq must be 3-6 items of {q<=120, a<=300}";
    }
  }
  if (a.content_sample_qa !== undefined && !qaArray(a.content_sample_qa, 3, 120, 300)) {
    return "content_sample_qa must be up to 3 items of {q,a}";
  }
  if (a.content_sample_chat !== undefined) {
    const v = a.content_sample_chat;
    const ok = Array.isArray(v) && v.length <= 6 &&
      v.every((x) => x && typeof x === "object" && isStr((x as any).who, 40) && isStr((x as any).line, 300));
    if (!ok) return "content_sample_chat must be up to 6 items of {who,line}";
  }
  if (a.content_can_do !== undefined && !strArray(a.content_can_do, 3, 80)) {
    return "content_can_do must be up to 3 strings";
  }
  if (a.content_cant_do !== undefined && !strArray(a.content_cant_do, 3, 80)) {
    return "content_cant_do must be up to 3 strings";
  }
  if (a.join_requirements !== undefined) {
    const v = a.join_requirements;
    if (!v || typeof v !== "object" || Array.isArray(v)) return "join_requirements must be an object";
    const jr = v as Record<string, unknown>;
    const allowed = new Set(["mic", "cam", "listen_only", "replay_days", "recording"]);
    if (Object.keys(jr).some((k) => !allowed.has(k))) return "join_requirements has an unsupported field";
    for (const k of ["mic", "cam", "listen_only", "recording"]) {
      if (jr[k] !== undefined && typeof jr[k] !== "boolean") return `join_requirements.${k} must be boolean`;
    }
    if (jr.replay_days !== undefined && (!Number.isInteger(Number(jr.replay_days)) || Number(jr.replay_days) < 0)) {
      return "join_requirements.replay_days must be a non-negative integer";
    }
  }
  return null;
}

/** [LIST-CONTENT-2] slugify(): lowercase, a-z0-9-, <=48 chars — the pretty-URL
 *  segment a title becomes on create. Strips accents so a Devanagari/emoji-only
 *  title (which normalizes to nothing) still gets a usable slug via the fallback. */
function slugify(title: string): string {
  const base = String(title || "")
    .toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return base || "listing";
}

/** Make `base` unique among this creator's OTHER listings by appending -2, -3, …
 *  (spec §C.1: "unique per creator by appending -2, -3…"). `excludeId` is the
 *  listing being created/updated, so it never collides with itself. Two different
 *  creators may both hold the bare slug "yoga" — the uniqueness is scoped to
 *  `idx_listings_creator_slug (creator_id, slug)`, not global. */
async function uniqueSlugFor(env: Env, creatorId: string, base: string, excludeId?: string): Promise<string> {
  const db = metaSession(env);
  let candidate = base;
  for (let n = 2; n <= 200; n++) {
    const row = excludeId
      ? await db.prepare("SELECT id FROM listings WHERE creator_id=?1 AND slug=?2 AND id<>?3").bind(creatorId, candidate, excludeId).first()
      : await db.prepare("SELECT id FROM listings WHERE creator_id=?1 AND slug=?2").bind(creatorId, candidate).first();
    if (!row) return candidate;
    candidate = `${base}-${n}`.slice(0, 48);
  }
  // 200 straight collisions on one creator/title is not a real case — fall back to a
  // short random suffix rather than looping forever.
  return `${base.slice(0, 40)}-${crypto.randomUUID().slice(0, 6)}`;
}

/** The version triple a listing born RIGHT NOW would pin (§2.4), or null when the
 *  category doesn't exist / isn't migrated yet. Read at creation ONLY — after that
 *  the listing's own pins are the truth and this must never be consulted again. */
async function catVersions(env: Env, category: string): Promise<{ cat: number; playbook: number; template: number } | null> {
  try {
    const r = await metaDb(env).prepare(
      "SELECT cat_version, playbook_version, template_version FROM listing_categories WHERE id=?1",
    ).bind(category).first<any>();
    if (!r) return null;
    return {
      cat: Number(r.cat_version ?? 1),
      playbook: Number(r.playbook_version ?? 1),
      template: Number(r.template_version ?? 1),
    };
  } catch {
    return null; // columns not migrated yet — the DEFAULT 1 pins are correct anyway
  }
}

// [UI-MKT-4] Card SELECT extended with review + view aggregates in-query (NO
// N+1 per card): rating_avg/rating_count already live on `listings` (kept in sync
// by the reviews route); `review_count` is a correlated COUNT over `reviews`, and
// `view_count` a correlated COUNT over `listing_views` for this listing. The
// per-user `favorited` flag is hydrated separately via favoritesFor() (one IN
// query keyed on the caller's uid) so this shared SELECT stays bind-order-stable
// across every caller that reuses it. created_at + country are already selected
// (client derives the <48h "NEW" chip + flag chip from them).
const CARD_SELECT = `
  SELECT l.id, l.creator_id, l.kind, l.title, l.description, l.category, l.price,
         l.currency_display, l.country, l.adults_only, l.badges, l.cover_media,
         l.starts_at, l.duration_min, l.capacity, l.status, l.joined_count,
         l.expires_at, l.expiry_days, l.market_type, l.social_sub, l.location,
         l.translation_enabled, l.spoken_lang,
         l.rating_avg, l.rating_count, l.created_at, l.content_version,
         l.vertical, l.section, l.attrs, l.video_url, l.proposed_category,
         l.cat_version, l.playbook_version, l.template_version,
         (SELECT COUNT(*) FROM reviews rv WHERE rv.listing_id = l.id) AS review_count,
         (SELECT COUNT(*) FROM listing_views lv WHERE lv.subject_kind='listing' AND lv.subject_id = l.id) AS view_count,
         u.handle AS creator_handle, u.display_name AS creator_name, u.avatar_url AS creator_avatar,
         u.avatok_number_display AS creator_number,
         (SELECT k.status FROM kyc_status k WHERE k.uid = l.creator_id) AS creator_kyc,
         -- [LIST-CONTENT-2] spec §H.1 / §C.1 — card content columns, plus
         -- price_semantics (joined off listing_categories, NOT a listings column —
         -- see worker/migrations/2026-09-02-listings-content.sql's header) and
         -- follower_count (creator_profiles). LEFT JOINs so a listing whose category
         -- row or creator_profiles row doesn't exist yet still returns a card.
         l.blurb, l.slug, l.schedule_mode, l.recurrence_days, l.recurrence_time,
         l.timezone, l.billing_unit, l.free_entry, l.max_per_booking,
         l.response_time_min, l.vibe_tags, l.credential, l.media_mode,
         lc.price_semantics AS category_price_semantics,
         cp.follower_count AS creator_follower_count
    FROM listings l LEFT JOIN users u ON u.uid = l.creator_id
         LEFT JOIN listing_categories lc ON lc.id = l.category
         LEFT JOIN creator_profiles cp ON cp.user_id = l.creator_id`;

/** [UI-MKT-3] Which of these listing ids has `uid` favorited? One IN query (no
 *  N+1). Empty set for a guest (uid null) or no ids. Per-account scoped: the uid
 *  is the authed caller's, so favorites never leak across the shared-phone accounts. */
async function favoritesFor(env: Env, uid: string | null, ids: string[]): Promise<Set<string>> {
  const set = new Set<string>();
  if (!uid || !ids.length) return set;
  try {
    const rs = await metaSession(env).prepare(
      `SELECT listing_id FROM listing_favorites WHERE uid=?1 AND listing_id IN (${ids.map((_, i) => `?${i + 2}`).join(",")})`,
    ).bind(uid, ...ids).all();
    for (const r of (rs.results ?? []) as any[]) set.add(String(r.listing_id));
  } catch { /* table may not be migrated yet — treat as none favorited */ }
  return set;
}

function activePromoPct(promos: any[], now: number, code?: string | null): { pct: number; promo: any | null } {
  let best: any = null;
  for (const p of promos) {
    if (p.ends_at && now > Number(p.ends_at)) continue;
    if (p.max_uses != null && Number(p.used) >= Number(p.max_uses)) continue;
    if (p.kind === "promo_code" && (!code || String(p.code || "").toUpperCase() !== String(code).toUpperCase())) continue;
    if (!best || Number(p.pct_off) > Number(best.pct_off)) best = p;
  }
  return best ? { pct: Math.min(100, Math.max(0, Number(best.pct_off))), promo: best } : { pct: 0, promo: null };
}

function shapeCard(r: any, promosByListing?: Map<string, any[]>, favorited?: Set<string>, stats?: Map<string, { seats_taken: number; watching: number }>) {
  const now = Date.now();
  const promos = promosByListing?.get(r.id) ?? [];
  const { pct } = activePromoPct(promos.filter((p) => p.kind === "early_bird"), now);
  const oneLiner = String(r.description || "").split("\n")[0].slice(0, 120);
  return {
    id: r.id, creator_id: r.creator_id, kind: r.kind, title: r.title,
    one_liner: oneLiner, category: r.category,
    // [MARKET-SECTION-1] The bazaar section this card belongs to. Additive, so
    // every already-shipped client ignores it. Falls back rather than emitting
    // null: a card with no section would silently vanish from a grouped view.
    section: r.section ?? DEFAULT_SECTION,
    // [MKT-3GROUP-1] Derived, additive — the marketplace's three-group layer
    // on top of section (spec §1.2). null for a section that renders nowhere
    // (today, only ai_voice_agents), never a made-up group.
    group_id: groupFor(r.section ?? DEFAULT_SECTION),
    price: Number(r.price), effective_price: pct > 0 ? Math.round(Number(r.price) * (100 - pct) / 100) : Number(r.price),
    promo_pct: pct, currency_display: r.currency_display ?? "USD",
    country: r.country ?? null, adults_only: !!r.adults_only,
    badges: parseJson(r.badges, [] as unknown[]),
    cover_media: parseJson(r.cover_media, [] as unknown[]),
    starts_at: r.starts_at ?? null, duration_min: r.duration_min ?? null,
    capacity: r.capacity ?? null, status: r.status,
    expires_at: r.expires_at ?? null, expiry_days: r.expiry_days ?? null,
    market_type: r.market_type ?? null, social_sub: r.social_sub ?? null, location: r.location ?? null,
    translation_enabled: !!r.translation_enabled, spoken_lang: r.spoken_lang ?? null,
    joined_count: Number(r.joined_count ?? 0),
    rating_avg: r.rating_avg != null ? Number(r.rating_avg) : null,
    rating_count: Number(r.rating_count ?? 0),
    // [UI-MKT-4] additive card stats (backward-compatible): review_count from the
    // reviews table, view_count from listing_views, created_at for the <48h "NEW"
    // chip, and the per-user favorited flag (false for guests / un-hydrated pages).
    review_count: Number(r.review_count ?? 0),
    view_count: Number(r.view_count ?? 0),
    created_at: r.created_at != null ? Number(r.created_at) : null,
    favorited: favorited ? favorited.has(String(r.id)) : false,
    // [AVA-MKT-CVER-1] The negotiation reopen key. The client echoes this back on
    // /marketplace/negotiate{,/state}, which key mkt_negotiations on
    // (buyer_id, listing_id, content_version) — so a material owner edit (which
    // bumps this in updateListing) reopens "talk to my agent" for every buyer.
    // Defaults to 0 pre-migration, which is exactly what the client already sent.
    content_version: Number(r.content_version ?? 0),
    // [AVA-MKT-VERT-1] Taxonomy fields (§2.0/§2.2/§2.4). All additive with the same
    // defaults the migration back-fills, so a pre-migration row and a legacy client
    // both keep behaving exactly as before.
    //   vertical  — which marketplace this belongs to; a listing never crosses (§2.0).
    //   attrs     — the category-specific answers, rendered by the detail template.
    //   video_url — YouTube link (§2.2); null on every listing that has none.
    //   *_version — the PINNED versions (§2.4). Shipped so the detail page renders
    //               with the template the listing was BORN with, never "latest".
    // proposed_category is the §2.3 audit trail of where the taxonomy was wrong; it
    // is a suggestion box, and the client must never render it AS a category.
    vertical: r.vertical ?? DEFAULT_VERTICAL,
    attrs: parseJson(r.attrs, {} as Record<string, unknown>),
    video_url: r.video_url ?? null,
    proposed_category: r.proposed_category ?? null,
    cat_version: Number(r.cat_version ?? 1),
    playbook_version: Number(r.playbook_version ?? 1),
    template_version: Number(r.template_version ?? 1),
    // [CARD-SCHEMA-1] Derived, and null (not 0) when unknown, so a card can tell
    // "nobody has booked" apart from "we could not count".
    seats_taken: stats?.get(String(r.id))?.seats_taken ?? null,
    seats_left: r.capacity != null && stats?.get(String(r.id))
      ? Math.max(0, Number(r.capacity) - Number(stats.get(String(r.id))!.seats_taken))
      : null,
    watching: stats?.get(String(r.id))?.watching ?? null,
    // [LIST-CONTENT-2] spec §H.1 — card/page content columns. All additive with the
    // same DEFAULTs the migration back-fills (schedule_mode/timezone), so a
    // pre-migration row and a legacy client both read exactly as before.
    blurb: r.blurb ?? null,
    slug: r.slug ?? null,
    schedule_mode: r.schedule_mode ?? "fixed_date",
    recurrence_days: parseJson(r.recurrence_days, [] as number[]),
    recurrence_time: r.recurrence_time ?? null,
    timezone: r.timezone ?? "Asia/Kolkata",
    billing_unit: r.billing_unit ?? null,
    free_entry: !!r.free_entry,
    max_per_booking: r.max_per_booking != null ? Number(r.max_per_booking) : 4,
    response_time_min: r.response_time_min != null ? Number(r.response_time_min) : null,
    vibe_tags: parseJson(r.vibe_tags, [] as string[]),
    // [MKT-3GROUP-1] spec §3 — audio-only vs audio+video. FIELD ONLY: no call
    // UI reads this yet (see the migration header). Defaults to the column
    // default so a pre-migration row and a legacy client both read the same
    // answer the schema already commits to.
    media_mode: r.media_mode ?? "audio_video",
    credential: r.credential ?? null,
    // §C.1 — "price_semantics is not a new column: join listing_categories into
    // CARD_SELECT/shapeCard". Null when the category row can't be resolved (matches
    // getListing's own "asking" fallback being applied client-side, not baked in here
    // since a card has no per-request default the way the detail page's local variable
    // does).
    price_semantics: r.category_price_semantics ?? null,
    creator: {
      uid: r.creator_id, handle: r.creator_handle ?? null,
      name: r.creator_name ?? null, avatar_url: r.creator_avatar ?? null,
      avatok_number: r.creator_number ?? null,                        // owner's AvaTOK number (dial inside AvaTOK)
      kyc_verified: r.creator_kyc === "verified",                     // A4 trust badge
      // [LIST-CONTENT-2] spec §H.1 — "regulars" proof chip source.
      follower_count: Number(r.creator_follower_count ?? 0),
    },
  };
}


/**
 * [CARD-SCHEMA-1] Card stats that are DERIVED, never stored.
 *
 * The new card designs promise "3 slots left" and "428 watching". Both are already
 * computable from tables the commercial lane maintains, so storing them would create a
 * second place for the same fact to be wrong — and a counter that drifts from the
 * entitlements it counts is worse than no counter, because people book against it.
 *
 *   seats_taken — live entitlements for the listing. [COMM-LIVE-AUTH-1] moved the
 *                 per-ticket order onto the member row, which is what makes this an
 *                 honest count of admitted buyers rather than of sessions.
 *   watching    — participant intervals still OPEN, i.e. people connected right now.
 *
 * FAILS SOFT. The commercial migrations are not auto-applied, so these tables may not
 * exist yet; an empty map means the card simply omits the stat. A missing seat count
 * must never take down a marketplace page.
 *
 * One IN query each, no N+1 — same shape as promosFor above.
 */
async function cardStatsFor(env: Env, ids: string[]): Promise<Map<string, { seats_taken: number; watching: number }>> {
  const map = new Map<string, { seats_taken: number; watching: number }>();
  if (!ids.length) return map;
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
  try {
    const seats = await metaSession(env).prepare(
      `SELECT listing_id, COUNT(*) n FROM commercial_entitlements
        WHERE listing_id IN (${placeholders})
          AND role IN ('viewer','buyer')
          AND state IN ('reserved','held','active','consumed')
        GROUP BY listing_id`,
    ).bind(...ids).all();
    for (const r of (seats.results ?? []) as any[]) {
      map.set(String(r.listing_id), { seats_taken: Number(r.n ?? 0), watching: 0 });
    }
  } catch { /* migration not applied — no seat counts, not an error */ }
  try {
    const live = await metaSession(env).prepare(
      `SELECT s.listing_id listing_id, COUNT(*) n
         FROM commercial_participant_intervals i
         JOIN commercial_sessions s ON s.commercial_session_id = i.commercial_session_id
        WHERE s.listing_id IN (${placeholders})
          AND i.reconciliation_state = 'open'
        GROUP BY s.listing_id`,
    ).bind(...ids).all();
    for (const r of (live.results ?? []) as any[]) {
      const key = String(r.listing_id);
      const prev = map.get(key) ?? { seats_taken: 0, watching: 0 };
      map.set(key, { ...prev, watching: Number(r.n ?? 0) });
    }
  } catch { /* same */ }
  return map;
}

/** Fetch early-bird promos for a page of listing ids (one IN query, no N+1). */
async function promosFor(env: Env, ids: string[]): Promise<Map<string, any[]>> {
  const map = new Map<string, any[]>();
  if (!ids.length) return map;
  const rs = await metaSession(env).prepare(
    `SELECT id, listing_id, kind, pct_off, code, max_uses, used, ends_at FROM listing_promotions
      WHERE listing_id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`,
  ).bind(...ids).all();
  for (const p of (rs.results ?? []) as any[]) {
    if (!map.has(p.listing_id)) map.set(p.listing_id, []);
    map.get(p.listing_id)!.push(p);
  }
  return map;
}

/** Keep the FTS row in sync (listings are low-write → replace-on-write).
 *
 *  [AVA-MKT-VERT-1] §2.0 names "search (ftsSync included)" as vertical-scoped, and this
 *  function deliberately does NOT write a vertical — `listings_fts` has no such column
 *  and does not need one. It indexes CONTENT, and the scoping happens where the rows are
 *  actually chosen: exploreSearch is two-phase (FTS nominates ids → the main `listings`
 *  query filters them with `l.vertical=?`), so an id this table hands back for the wrong
 *  vertical is discarded before it can become a card. The reasoning is spelled out in
 *  full at the exploreSearch call site, including the recall caveat (phase 1's LIMIT 200
 *  is vertical-blind) and what to do about it when connect has volume. Do not add a
 *  vertical token into the indexed text as a shortcut: the marketplace MATCH is column-
 *  filtered to {title description category}, so a smuggled token would make "connect"
 *  a query that matches every connect listing by name. */
export async function ftsSync(env: Env, id: string, remove = false): Promise<void> {
  const db = metaDb(env);
  await db.prepare("DELETE FROM listings_fts WHERE listing_id=?1").bind(id).run();
  if (remove) return;
  const l = await db.prepare(
    `SELECT l.title, l.description, l.category, u.display_name, u.handle
       FROM listings l LEFT JOIN users u ON u.uid=l.creator_id WHERE l.id=?1 AND l.status IN ('published','live')`,
  ).bind(id).first<any>();
  if (!l) return;
  await db.prepare(
    "INSERT INTO listings_fts (listing_id, title, description, creator_name, category) VALUES (?1,?2,?3,?4,?5)",
  ).bind(id, l.title ?? "", l.description ?? "", `${l.display_name ?? ""} ${l.handle ?? ""}`.trim(), l.category ?? "").run();
}

/**
 * A2 fan-out notify: push every follower with notify=1 on publish / go-live.
 * Capped at FANOUT_DAILY_CAP per creator per day (anti-spam). Notifications
 * feed rows are batch-inserted; FCM pushes ride Q_PUSH in chunks of 100.
 */
export async function fanout(
  env: Env,
  creatorId: string,
  title: string,
  body: string,
  deeplink: string,
  opts?: { eventId?: string; listingId?: string; eventType?: string },
): Promise<{ sent: number; capped: boolean }> {
  const db = metaDb(env);
  const now = Date.now();
  let firstAttempt = true;
  if (opts?.eventId) {
    const inserted = await db.prepare(
      `INSERT OR IGNORE INTO listing_fanout_events
       (event_id,listing_id,event_type,state,created_at,updated_at)
       VALUES (?1,?2,?3,'pending',?4,?4)`,
    ).bind(opts.eventId, opts.listingId ?? "", opts.eventType ?? "listing_update", now).run();
    firstAttempt = Number(inserted.meta?.changes ?? 0) > 0;
    const event = await db.prepare("SELECT state FROM listing_fanout_events WHERE event_id=?1")
      .bind(opts.eventId).first<{ state: string }>();
    if (event?.state === "sent") return { sent: 0, capped: false };
  }

  const day = new Date(now).toISOString().slice(0, 10);
  const cur = await db.prepare("SELECT count FROM fanout_log WHERE creator_id=?1 AND day=?2")
    .bind(creatorId, day).first<{ count: number }>();
  if ((cur?.count ?? 0) >= FANOUT_DAILY_CAP) {
    if (opts?.eventId) await db.prepare(
      "UPDATE listing_fanout_events SET state='sent',sent_at=?2,updated_at=?2 WHERE event_id=?1",
    ).bind(opts.eventId, now).run();
    return { sent: 0, capped: true };
  }
  if (firstAttempt) {
    await db.prepare(
      "INSERT INTO fanout_log (creator_id, day, count) VALUES (?1,?2,1) ON CONFLICT(creator_id, day) DO UPDATE SET count=count+1",
    ).bind(creatorId, day).run();
  }

  const rs = await db.prepare(
    "SELECT follower_id FROM creator_follows WHERE creator_id=?1 AND notify=1 LIMIT ?2",
  ).bind(creatorId, FANOUT_MAX_FOLLOWERS).all();
  const followers = ((rs.results ?? []) as any[]).map((r) => String(r.follower_id));
  await Promise.all(followers.map((uid) => notifyUser(env, uid, {
    type: "social", title, body, data: { deeplink },
  }, opts?.eventId ? { id: `listing-fanout:${opts.eventId}:${uid}` } : undefined)));

  if (opts?.eventId) await db.prepare(
    "UPDATE listing_fanout_events SET state='sent',sent_at=?2,updated_at=?2 WHERE event_id=?1",
  ).bind(opts.eventId, Date.now()).run();
  return { sent: followers.length, capped: false };
}

// ---------------------------------------------------------------------------
// creation pipeline
// ---------------------------------------------------------------------------

// [AVA-MKT-VERT-1] `attrs` and `video_url` are editable; `vertical`, `cat_version`,
// `playbook_version` and `template_version` are deliberately ABSENT and must stay so.
//   vertical  — §2.0, a listing never crosses. Not editable = not crossable, by
//               construction, rather than by a check someone can forget to write.
//   *_version — §2.4, PINNED AT BIRTH. A listing renders and negotiates at the version
//               it was created under, always; letting a client PUT a new pin is exactly
//               the silent behaviour change the whole versioning design exists to stop.
// proposed_category is also absent: it is the §2.3 record of what the AI proposed when
// it filed this listing, not a field to be revised afterwards.
const EDITABLE = ["title", "description", "category", "price", "currency_display", "country", "adults_only", "badges", "cover_media", "starts_at", "duration_min", "capacity", "translation_enabled", "spoken_lang", "agent_instructions", "agent_lang", "agent_voice_persona", "location", "expiry_days", "attrs", "video_url",
  // [LIST-CONTENT-2] spec §C.1 — card/page content columns. `slug` rides here too
  // (rather than being written by a bare column assignment) so it goes through the
  // same generic SET-builder as everything else; its uniqueness/format check happens
  // in updateListing BEFORE `f.slug` is set, same pattern as the attrs validation above.
  "blurb", "slug", "schedule_mode", "recurrence_days", "recurrence_time", "timezone",
  "billing_unit", "free_entry", "max_per_booking", "response_time_min", "vibe_tags", "credential",
  // [MKT-3GROUP-1] spec §3 — audio-only vs audio+video, field only (see the
  // migration + normFields for why it is NOT in REVIEW_MATERIAL_FIELDS).
  "media_mode",
] as const;

// [AVA-MKT-CVER-1] MATERIAL fields — the subset of EDITABLE whose change invalidates
// a negotiation a buyer's agent already had. Editing one bumps listings.content_version,
// which reopens "talk to my agent" for EVERY buyer on the listing (the mkt_negotiations
// PK includes content_version).
//
// This list is deliberately SHORT, and adding to it costs real money. A bump reopens a
// PAID Sonnet negotiation for every buyer, and agentDailyCap (10/day) caps the BUYER,
// not the seller — nothing bounds a seller who edits repeatedly. So the test is strictly
// "would a buyer's agent have negotiated differently?":
//   IN  — title, description, price, currency_display, category: the terms themselves.
//         (currency_display matters as much as price: 500 USD ≠ 500 INR.)
//   OUT — cover_media (reordering photos), expiry_days (a TTL renewal), agent_* settings
//         (the SELLER's own mandate, not the offer), country/location/badges, and the
//         live_event scheduling fields. None change what was agreed.
// normFields() already folds the client's price_amount/price_currency aliases into
// price/currency_display, so comparing the normalized values here catches both spellings.
//
// [AVA-MKT-VERT-1] `attrs` IS IN, and it is the one addition this list has earned.
// Apply the test above literally: attrs holds the category's own answers — bedrooms,
// area, mileage, year. "3 bedrooms" → "2 bedrooms" is not a detail around the offer,
// it IS the thing being sold, and a buyer's agent that negotiated the first number
// negotiated a flat that does not exist. That is squarely "would a buyer's agent have
// negotiated differently?", and it is a worse failure than a stale title: the title is
// prose a human re-reads, while attrs is the structured data the agent reasons over.
// The cost side is real and accepted: a bump reopens a paid negotiation. Leaving it OUT
// would trade that cost for agents negotiating hard over specs the seller has since
// corrected — cheaper, and wrong.
//
// It cannot use the plain string compare, though, and that is why it is called out
// here rather than just appended. `attrs` is JSON: JSON.stringify key order follows
// insertion order, so a compose loop that rebuilds the same object with its keys in a
// different order produces a different string for identical data. Under String()
// comparison that reads as an edit and bumps — a free, unbounded reopen of every
// buyer's paid negotiation, triggered by nothing. sameAttrs() below compares canonically.
//
// Still OUT — video_url: swapping the YouTube link is the cover_media case (the
// presentation of the offer, not its terms). vertical and the pinned versions are not
// editable at all, so they cannot reach here.
const MATERIAL = ["title", "description", "price", "currency_display", "category", "attrs"] as const;

/** Order-insensitive equality for the `attrs` JSON — see the MATERIAL note above.
 *  Top-level keys are sorted; values are compared by their own JSON, which is exact.
 *  §2.2 attrs are flat (scalars, and arrays for `multi`), so top-level canonicalisation
 *  is total for every schema the plan defines. If a nested-object field type is ever
 *  added, this needs to recurse — a bug that would cost money, so it is written down.
 *  Non-object / unparseable input falls back to the raw string compare. */
function sameAttrs(a: unknown, b: unknown): boolean {
  const canon = (s: unknown): string => {
    const v = parseJson<unknown>(s, null);
    if (!v || typeof v !== "object" || Array.isArray(v)) return String(s ?? "");
    const o = v as Record<string, unknown>;
    return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
  };
  return canon(a) === canon(b);
}

// [LIST-REVIEW-BINDING-1] Second half of C02. Commit fa44bc21 (RESERVED_ATTRS_KEYS
// above) stopped a creator from forging/erasing attrs.poster; it did NOT stop them
// from rewriting everything else an admin actually judged and keeping the approval.
// `updateListing`'s only status guard is cancelled/completed -> 409 — the UPDATE
// never touches `status`, so an approved yoga class can become a published escort
// listing with the yoga class's approval still on it.
//
// `reviewedContentHash()` fingerprints the MATERIAL content of a listing — the
// subset an admin reviewer actually looks at and judges before clicking approve.
// It is written to `listings.reviewed_content_hash` at approval time
// (admin_listings.ts) and recomputed on every `updateListing` write; a mismatch
// means the content on disk is no longer the content that was approved.
//
// INCLUDED — the terms + the substance of what's being sold, exactly what an
// admin sees on the review screen: title, description, category, price (and
// currency_display — 500 USD is not the same listing as 500 INR, same reasoning
// as the MATERIAL list above), cover_media (the photos ARE the review — swapping
// them post-approval is the textbook version of this bug), starts_at, duration_min,
// capacity (a live_event/consult's shape), free_entry (free vs paid is a term, not
// a detail), and the CREATOR-OWNED parts of attrs (category answers — bedrooms,
// mileage, etc — same "would a reviewer have judged this differently" test as
// MATERIAL's attrs entry above).
//
// EXCLUDED, deliberately:
//   - attrs.poster and all __* attrs — server-owned moderation/transport state.
//   - status, revisions, counters and timestamps — pipeline bookkeeping.
//   - slug and derived section — routing values whose reviewed meaning is already
//     represented by title/category. Every other public editable field is included.
const REVIEW_MATERIAL_FIELDS = [
  "title", "description", "category", "price", "currency_display", "country",
  "adults_only", "badges", "cover_media", "starts_at", "duration_min", "capacity",
  "translation_enabled", "spoken_lang", "agent_instructions", "agent_lang",
  "agent_voice_persona", "location", "expiry_days", "video_url", "blurb",
  "schedule_mode", "recurrence_days", "recurrence_time", "timezone", "billing_unit",
  "free_entry", "max_per_booking", "response_time_min", "vibe_tags", "credential",
] as const;

/** Deterministic JSON: object keys sorted (recursively) so the same content always
 *  serialises identically no matter which caller assembled the object or in what
 *  key order. Array ORDER is kept — order is material for `cover_media` (the
 *  gallery sequence is part of what a reviewer saw), matching sameAttrs()'s
 *  top-level-only canonicalisation being enough for attrs (§2.2 attrs are flat). */
function stableStringify(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Fingerprint of a listing's MATERIAL content (see REVIEW_MATERIAL_FIELDS above).
 *  `row` may be the raw DB row, or the row with an in-flight edit's changes already
 *  merged in — updateListing does the latter so it can compare "what this would
 *  look like after the write" against what was last approved, BEFORE committing.
 *  `attrs`/`cover_media` are accepted either as the JSON string D1 stores or as an
 *  already-parsed value, so callers never have to re-encode just to hash. Async
 *  because a Worker's only hashing primitive is WebCrypto (crypto.subtle). */
export async function reviewedContentHash(row: Record<string, unknown>): Promise<string> {
  const attrsIn = row.attrs;
  const attrsObj = typeof attrsIn === "string" ? parseJson<Record<string, unknown>>(attrsIn, {})
    : ((attrsIn && typeof attrsIn === "object") ? (attrsIn as Record<string, unknown>) : {});
  const creatorAttrs: Record<string, unknown> = { ...attrsObj };
  for (const k of Object.keys(creatorAttrs)) {
    if (k.startsWith("__") || (RESERVED_ATTRS_KEYS as readonly string[]).includes(k)) delete creatorAttrs[k];
  }
  const material: Record<string, unknown> = { attrs: creatorAttrs };
  for (const f of REVIEW_MATERIAL_FIELDS) {
    const val = row[f];
    const jsonField = ["badges", "cover_media", "recurrence_days", "vibe_tags"].includes(f);
    material[f] = jsonField && typeof val === "string" ? parseJson(val, []) : (val ?? null);
  }
  const canonical = stableStringify(material);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Does this listing have any live (non-refunded/non-revoked) entitlement — a real
 *  seat someone paid for or claimed? Same table/columns/states cardStatsFor() (the
 *  `seats_left` source, above) already uses for `seats_taken`, so "has this listing
 *  sold" means the same thing everywhere in this file. Returns `null` — never `0` —
 *  when the count could not be determined (e.g. commercial_entitlements hasn't been
 *  migrated on this environment yet): the caller MUST fail closed on null, never
 *  read it as "no sales", per this change's fail-closed/never-strand-a-buyer brief. */
async function hasSoldEntitlements(env: Env, listingId: string): Promise<boolean | null> {
  try {
    const row = await metaDb(env).prepare(
      `SELECT COUNT(*) c FROM commercial_entitlements
        WHERE listing_id=?1 AND role IN ('viewer','buyer')
          AND state IN ('reserved','held','active','consumed')`,
    ).bind(listingId).first<{ c: number }>();
    return Number(row?.c ?? 0) > 0;
  } catch {
    return null;
  }
}

function normFields(b: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (b.title !== undefined) out.title = String(b.title).slice(0, 140);
  if (b.description !== undefined) out.description = String(b.description).slice(0, 8000);
  if (b.category !== undefined) out.category = String(b.category);
  if (b.price !== undefined) out.price = Math.max(0, Math.trunc(Number(b.price) || 0));
  // AvaMarketplace sends price_amount/price_currency (major units, any ISO-4217).
  if (b.price_amount !== undefined && b.price === undefined) out.price = Math.max(0, Math.trunc(Number(b.price_amount) || 0));
  if (b.currency_display !== undefined) out.currency_display = String(b.currency_display).slice(0, 8);
  if (b.price_currency !== undefined && b.currency_display === undefined) out.currency_display = String(b.price_currency).slice(0, 8);
  if (b.country !== undefined) out.country = b.country ? String(b.country).slice(0, 2).toUpperCase() : null;
  if (b.adults_only !== undefined) out.adults_only = b.adults_only ? 1 : 0;
  if (b.badges !== undefined) out.badges = b.badges ? JSON.stringify(b.badges) : null;
  if (b.cover_media !== undefined) {
    // Listing photos: 1–5 (min enforced at publish; max here). Shape: {type,url}.
    const arr = (Array.isArray(b.cover_media) ? b.cover_media : [])
      .filter((m: any) => m && typeof m.url === "string" && /^https:\/\//.test(m.url))
      .slice(0, 5)
      .map((m: any) => ({ type: String(m.type || "image"), url: String(m.url).slice(0, 500) }));
    out.cover_media = arr.length ? JSON.stringify(arr) : null;
  }
  if (b.starts_at !== undefined) out.starts_at = b.starts_at ? Math.trunc(Number(b.starts_at)) : null;
  if (b.duration_min !== undefined) out.duration_min = b.duration_min ? Math.trunc(Number(b.duration_min)) : null;
  if (b.capacity !== undefined) out.capacity = b.capacity ? Math.trunc(Number(b.capacity)) : null;
  // Voice translation options ("Voice translation available" + creator's
  // language of transmission, e.g. 'hi' for Hindi).
  if (b.translation_enabled !== undefined) out.translation_enabled = b.translation_enabled ? 1 : 0;
  // [LIST-CREATE-LANG-1] 64, not 12. The cap was written when this held ONE language
  // code; the web form lets a creator pick several and sends them comma-separated, and
  // "Hindi,English" is 13 characters — it truncated to "Hindi,Englis", mid-word, with
  // no error. TEXT column, so nothing in the schema needed changing.
  if (b.spoken_lang !== undefined) out.spoken_lang = b.spoken_lang ? String(b.spoken_lang).slice(0, 64) : null;
  // AvaMarketplace: the agent mandate + language/persona + type metadata.
  if (b.agent_instructions !== undefined) out.agent_instructions = b.agent_instructions ? String(b.agent_instructions).slice(0, 2000) : null;
  if (b.agent_lang !== undefined) out.agent_lang = b.agent_lang ? String(b.agent_lang).slice(0, 32) : null;
  if (b.agent_voice_persona !== undefined) out.agent_voice_persona = b.agent_voice_persona ? String(b.agent_voice_persona).slice(0, 200) : null;
  if (b.market_type !== undefined) out.market_type = b.market_type ? String(b.market_type).slice(0, 16) : null;
  if (b.social_sub !== undefined) out.social_sub = b.social_sub ? String(b.social_sub).slice(0, 32) : null;
  if (b.location !== undefined) out.location = b.location ? String(b.location).slice(0, 120) : null;
  if (b.expiry_days !== undefined) out.expiry_days = b.expiry_days ? Math.max(1, Math.min(90, Math.trunc(Number(b.expiry_days) || 30))) : null;
  // [AVA-MKT-VERT-1] §2.2 — the category's own answers, one JSON column.
  // Size-capped (see ATTRS_MAX_BYTES). An oversize / non-object blob is DROPPED here
  // rather than written: normFields cannot return an error, and storing JSON that
  // parseJson() will silently read back as {} is strictly worse than not storing it.
  // Both write routes call encodeAttrs() themselves first and 422 on the same error,
  // so a caller always gets told — this branch is the backstop that guarantees no
  // future caller of normFields can slip an unbounded blob into the column.
  if (b.attrs !== undefined) {
    const enc = encodeAttrs(b.attrs);
    if (!enc.error) out.attrs = enc.json;
  }
  // §2.2 — YouTube link. https-only, exactly like cover_media above: a plain http URL
  // is a mixed-content failure in the client's player and a stripped-in-transit link.
  // Non-https is dropped, not stored broken (same posture as cover_media's filter).
  // NOTE: the plan says "YouTube only" and this does NOT yet enforce a host allowlist
  // — see the report / follow-up; it is a validation gap, not a media-upload surface
  // (nothing here accepts bytes).
  if (b.video_url !== undefined) {
    const v = b.video_url ? String(b.video_url) : "";
    out.video_url = /^https:\/\//.test(v) ? v.slice(0, 500) : null;
  }
  // §2.3 — the AI's suggestion when nothing fit. Free text with no allowlist is correct
  // HERE and nowhere else: it is never a query key and never renders as a category.
  if (b.proposed_category !== undefined) {
    out.proposed_category = b.proposed_category ? String(b.proposed_category).trim().slice(0, 80) || null : null;
  }
  // [LIST-CONTENT-2] spec §C.1. Values reaching here have already passed
  // listingContentFieldsError() at both call sites (createListing/updateListing), so
  // this block only NORMALIZES — encodes arrays to JSON, applies column defaults — it
  // does not re-validate. `slug` is deliberately NOT handled here: it needs a DB
  // uniqueness check (uniqueSlugFor / the creator-scoped clash check), which normFields
  // has no DB handle to do; both call sites set `out.slug`/`f.slug` themselves.
  if (b.blurb !== undefined) out.blurb = b.blurb ? String(b.blurb).slice(0, 120) : null;
  if (b.schedule_mode !== undefined) out.schedule_mode = b.schedule_mode ? String(b.schedule_mode) : "fixed_date";
  if (b.recurrence_days !== undefined) {
    out.recurrence_days = Array.isArray(b.recurrence_days)
      ? JSON.stringify(b.recurrence_days.map((d: unknown) => Math.trunc(Number(d))))
      : null;
  }
  if (b.recurrence_time !== undefined) out.recurrence_time = b.recurrence_time ? String(b.recurrence_time).slice(0, 5) : null;
  if (b.timezone !== undefined) out.timezone = b.timezone ? String(b.timezone).slice(0, 64) : "Asia/Kolkata";
  // [PRICE-HOURLY-1] spec §4 — "everything is priced per hour", and the
  // wizard's "Charged per" dropdown is REMOVED. Rather than trust whatever a
  // caller sends (a stale client could still send an old value), this FORCES
  // billing_unit to 'hour' the moment the field is present in the request at
  // all — the same "coerce, don't merely validate" posture normFields already
  // uses for free_entry's price=0 below. A caller that omits billing_unit
  // entirely (the normal case once the wizard drops the field) leaves the
  // column untouched here; createListing's own default fills 'hour' for a
  // brand-new row (see the INSERT).
  if (b.billing_unit !== undefined) out.billing_unit = "hour";
  // [MKT-3GROUP-1] spec §3 — audio-only vs audio+video. Unlike billing_unit
  // this has two real values, so it is kept (already validated against
  // MEDIA_MODES by listingContentFieldsError), not overwritten.
  if (b.media_mode !== undefined) out.media_mode = b.media_mode ? String(b.media_mode) : "audio_video";
  if (b.free_entry !== undefined) out.free_entry = b.free_entry ? 1 : 0;
  if (b.max_per_booking !== undefined) out.max_per_booking = b.max_per_booking != null ? Math.trunc(Number(b.max_per_booking)) : 4;
  if (b.response_time_min !== undefined) out.response_time_min = b.response_time_min != null ? Math.trunc(Number(b.response_time_min)) : null;
  if (b.vibe_tags !== undefined) {
    out.vibe_tags = Array.isArray(b.vibe_tags) ? JSON.stringify(b.vibe_tags.slice(0, 2).map((t: unknown) => String(t))) : null;
  }
  if (b.credential !== undefined) out.credential = b.credential ? String(b.credential).slice(0, 40) : null;
  // E: the free lane costs the CREATOR, never the buyer — force price=0 unconditionally
  // the moment free_entry lands at 1 in this call, regardless of what price was sent
  // alongside it. (The case where free_entry was already 1 on an EARLIER call and this
  // call only touches price is handled by the caller, which knows the existing row.)
  if (out.free_entry === 1) out.price = 0;
  return out;
}

// [AVA-IDGATE-1] Marketplace listing gate. Spec: Specs/SPEC-2026-07-10-identity-gating.md
//
// WAS (2026-07-07): a one-time PHONE OTP — `contact_verification.phone_verified=1`,
// rejecting with 403 `phone_required`.
// NOW (2026-07-10): a Didit LIVENESS pass, valid 90 days. All phone verification is
// removed app-wide; a phone number proved nothing about identity, cost money in SMS,
// and could not be traced by us in any jurisdiction anyway.
//
// Creating a listing is a PUBLIC action, so it goes through the same gate as posts,
// comments, going live, DMs to strangers, group posts and public uploads. One gate,
// one contract, no per-surface special cases — a gap in a safety control is a
// destination, not an omission.
//
// gatePublicAction() fails CLOSED and emits its own telemetry. Returns a 403 Response
// to short-circuit, or null to proceed. Browsing stays free.
//
// NAME: this was `phoneGate()` until 2026-07-18. It has enforced LIVENESS (never a
// phone) since 2026-07-10; the old name and its comments claimed the opposite and
// misled readers into deriving a phone-OTP model that no longer exists. Owner
// decisions M-D1 (2026-07-17) / M-D11 (2026-07-18): liveness only, no phone anywhere.
async function identityGate(env: Env, uid: string, listingKind: string, listingId: string | null): Promise<Response | null> {
  // A 'social' listing IS a post; 'live_event' IS going live. Same gate either way.
  const action: PublicAction = listingKind === "live_event" ? "live" : listingKind === "social" ? "post" : "listing";
  const blocked = await gatePublicAction(env, uid, await emailOf(env, uid), action);
  if (!blocked) return null;
  track(env, uid, "listing_blocked_identity_unverified", APP, { listing_id: listingId, listing_kind: listingKind });
  return blocked;
}

// POST /api/listings — create a draft.
export async function createListing(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const kind = String(b.kind || "");
  if (!KINDS.has(kind)) return json({ error: "kind must be live_event|consult|sell|buy|social" }, 400);
  if (MARKET_KINDS.has(kind) && !(await marketplacePublishOn(env))) return marketplaceOff();
  // Marketplace listing gate (2026-07-10): a Didit LIVENESS pass, valid 90 days.
  // Creating a listing is a public action, so it is gated exactly like posts,
  // going live and DMs to strangers. There is no phone check here (none anywhere).
  const gate = await identityGate(env, ctx.uid, kind, null);
  if (gate) return gate;
  const id = crypto.randomUUID();
  const now = Date.now();
  // [C02] Strip/replace server-owned attrs keys BEFORE normFields() touches them —
  // there is no existing row yet, so `existing` is null (a brand-new listing has no
  // poster to preserve, only one to refuse forging).
  if (b.attrs !== undefined) b.attrs = sanitizeCreatorAttrs(b.attrs, null);
  const f = normFields(b);
  // [LIST-CONTENT-2] spec §C.1 — new scalar columns (schedule_mode, timezone,
  // billing_unit, vibe_tags, …) validated before anything is written.
  const fieldsError = listingContentFieldsError(b);
  if (fieldsError) return json({ ok: false, error: fieldsError, message: fieldsError, field: "listing" }, 400);
  // [Step0 C01-adjacent] free_entry is allowlist-gated (see free_entry_gate.ts) —
  // checked against the RESULTING state (f.free_entry, after normFields), not the
  // raw body, though for create the two always agree (no existing row to diff
  // against). `freeSessionsEnabled=true` + `freeSessionTokensPerAttendeeMinute=1`
  // are already live in prod, so this is the actual safety mechanism, not a formality.
  const effectiveFreeEntryCreate = Number(f.free_entry ?? 0) === 1;
  if (effectiveFreeEntryCreate) {
    const cfg = await readConfig(env);
    if (!freeEntryAllowed(env, cfg, ctx.uid)) {
      track(env, ctx.uid, "listing_free_entry_refused", APP, { listing_id: null, kind, reason: "free_entry_not_allowed" });
      return json({
        ok: false, error: "free_entry_not_allowed", field: "free_entry",
        message: "Free-entry listings are limited to approved creators right now.",
      }, 403);
    }
  }
  // [PRICE-HOURLY-1] spec §4.2 — the ₹49/hour floor. Only checked when a price
  // was actually SENT (not the default-0 a step-1 draft is created with, long
  // before the wizard's money step asks for one) and only for the two session
  // kinds this pricing model governs — sell/buy/social are AvaMarketplace
  // goods with their own price semantics, never hourly. A client check alone
  // is not a rule; this is the server recomputing and refusing, per spec §4.1.
  //
  // ⚠️ `b.price !== undefined` WAS NOT ENOUGH, and the bug it caused was
  // reported from a phone on 2026-09-05: the wizard's bodyForSave ALWAYS sends
  // `price` (0 until the creator reaches the Money step), so the draft created
  // at the end of step 2 arrived with price=0, failed this floor, and the
  // wizard snapped back to Pitch showing "Price must be at least 49
  // tokens/hour" on a step that has no price field. The comment above used to
  // claim a step-1 draft has no price yet; it does, and it is 0.
  //
  // A price of 0 means NOT PRICED YET, which is a legitimate state for a
  // draft. The floor is about a price the creator actually chose, so it
  // applies from 1 up. An unpriced draft is caught where it matters — at
  // submitListingForApproval, which checks the stored row unconditionally and
  // is the last gate before the review queue.
  if (!effectiveFreeEntryCreate && Number(f.price) > 0 && (kind === "live_event" || kind === "consult")) {
    const priceErr = priceFloorError(f.price, false);
    if (priceErr) return json({ ok: false, error: "price_below_floor", message: priceErr, field: "price" }, 400);
  }
  // [AVA-MKT-VERT-1] §2.2 — attrs is the one field a caller can get wrong in a way
  // worth naming, so say so instead of dropping it silently (normFields would).
  if (b.attrs !== undefined) {
    const enc = encodeAttrs(b.attrs);
    if (enc.error) return json({ ok: false, error: enc.error, message: enc.error, field: "attrs" }, 422);
    const policyError = commercialPolicyError(kind, b.attrs);
    if (policyError) return json({ ok: false, error: policyError, message: policyError, field: "attrs" }, 422);
    // [LIST-CONTENT-2] spec §C.2 / TRUST §4.3 — details-page attrs. freeEntry here is
    // simply `f.free_entry === 1`: there is no existing row yet at create time, so the
    // "effective" value IS whatever this request sends (normFields already forced
    // f.price=0 when free_entry=1, above).
    const contentError = contentAttrsError(b.attrs, effectiveFreeEntryCreate);
    if (contentError) return json({ ok: false, error: contentError, message: contentError, field: "attrs" }, 422);
  }
  // [C03/cap-hole] The `else if (effectiveFreeEntryCreate)` branch that stood
  // here re-ran contentAttrsError against an empty attrs object, purely to stop
  // a free listing being created with no content_free_cap_tokens. That cap is
  // no longer required of the caller ([PRICE-HOURLY-2] — freeSessionPolicy
  // derives it), so the branch had become a call that could not fail: dead code
  // whose comment still described a hole it was no longer plugging. The hole
  // itself is closed further down the pipe now, in lib/free_session.ts, where a
  // missing cap resolves to one full house rather than to zero.
  const blocked = await guardWrite(req, env, ctx.uid, APP, [
    { text: f.title as string | undefined, field: "listing_title" },
    { text: f.description as string | undefined, field: "listing_desc" },
  ]);
  if (blocked) return blocked;

  // §2.0 — the vertical is chosen ONCE, at birth, and is not editable afterwards
  // (it is absent from EDITABLE). Absent ⇒ 'commerce', so every caller that shipped
  // before today creates exactly the listing it created yesterday.
  const vertical = vertOf(b.vertical);

  // §2.3 — THE AI PROPOSES, AN ADMIN APPROVES, AND THE USER IS NEVER BLOCKED.
  // An unknown category is NOT an error here. When the compose AI couldn't match one
  // it sends its suggestion as `proposed_category`; we file the listing under the
  // seeded 'other' waiting-room row and it publishes normally. The suggestion becomes
  // the admin queue's input (proposedCategories, categories.ts) and the audit trail of
  // where the taxonomy was wrong. Blocking here would be the one outcome §2.3 forbids.
  let category = (f.category as string) ?? "teachers";
  let versions = await catVersions(env, category);
  if (!versions && f.proposed_category) {
    category = "other";
    versions = await catVersions(env, category);
  }
  // §2.4 — PIN AT BIRTH. Read the category's versions now and freeze them onto the row;
  // the listing renders and negotiates at THESE numbers forever, never at "latest". A
  // category the row lookup can't resolve (unknown id, or pre-migration columns) pins
  // 1/1/1 — which is exactly the DEFAULT the migration back-fills, so the fallback and
  // the migration agree rather than inventing a third answer.
  const catV = versions?.cat ?? 1, pbV = versions?.playbook ?? 1, tplV = versions?.template ?? 1;

  // [LIST-CONTENT-2] spec §C.1 — "slug is generated from the title on create,
  // unique per creator". Generated even for a title-less draft ("Untitled" is what
  // the INSERT below falls back to) so every listing has a pretty-URL segment from
  // birth; a later title edit does NOT reslug (slug is stable once assigned, matching
  // "editable once" on the update path).
  const slug = await uniqueSlugFor(env, ctx.uid, slugify((f.title as string) || "Untitled"));

  await metaDb(env).prepare(
    `INSERT INTO listings (id, creator_id, kind, title, description, category, price, currency_display,
       country, adults_only, badges, cover_media, starts_at, duration_min, capacity, status, created_at, updated_at,
       agent_instructions, agent_lang, agent_voice_persona, market_type, social_sub, location, expiry_days,
       vertical, attrs, video_url, proposed_category, cat_version, playbook_version, template_version,
       spoken_lang, translation_enabled, section,
       slug, blurb, schedule_mode, recurrence_days, recurrence_time, timezone, billing_unit,
       free_entry, max_per_booking, response_time_min, vibe_tags, credential, media_mode)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,'draft',?16,?16,?17,?18,?19,?20,?21,?22,?23,
             ?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,
             ?34,?35,?36,?37,?38,?39,?40,?41,?42,?43,?44,?45,?46)`,
  ).bind(id, ctx.uid, kind, (f.title as string) ?? "Untitled", f.description ?? null, category,
    f.price ?? 0, f.currency_display ?? "USD", f.country ?? null, f.adults_only ?? 0, f.badges ?? null,
    f.cover_media ?? null, f.starts_at ?? null, f.duration_min ?? null,
    kind === "consult" ? (f.capacity ?? 1) : null, now,
    f.agent_instructions ?? null, f.agent_lang ?? null, f.agent_voice_persona ?? null,
    f.market_type ?? (MARKET_KINDS.has(kind) ? kind : null), f.social_sub ?? null, f.location ?? null,
    f.expiry_days ?? null,
    vertical, f.attrs ?? null, f.video_url ?? null, f.proposed_category ?? null, catV, pbV, tplV,
    // [LIST-CREATE-LANG-1 2026-08-30] spoken_lang and translation_enabled were ACCEPTED by
    // normFields, length-checked, and then silently dropped: neither appeared in this
    // INSERT's column list, though both are in EDITABLE and both are written by
    // updateListing. So a language chosen at CREATE vanished, and the only way to set one
    // was to create the listing and then edit it. No error, no warning — the field simply
    // did not exist afterwards. Found by picking Hindi+English in the new web form and
    // reading `spoken_lang` back as NULL from prod.
    f.spoken_lang ?? null, f.translation_enabled ?? 0,
    // [MARKET-SECTION-1] The bazaar section, resolved ONCE here from (kind,
    // category) and stored, so the marketplace can filter, count and sort by it
    // server-side. Not `vertical` — see lib/listing_section.ts for why those are
    // two different things.
    sectionFor(kind, category),
    // [LIST-CONTENT-2] spec §C.1 new columns. schedule_mode/timezone fall back to the
    // column DEFAULTs (fixed_date / Asia/Kolkata) exactly like the migration does, so a
    // caller that sends neither creates a row indistinguishable from a pre-migration one.
    slug, f.blurb ?? null, f.schedule_mode ?? "fixed_date", f.recurrence_days ?? null,
    f.recurrence_time ?? null, f.timezone ?? "Asia/Kolkata",
    // [PRICE-HOURLY-1] spec §4 — a brand-new session listing (live_event/consult)
    // is billed hourly from birth even if the (now dropped) wizard field never
    // sends billing_unit at all. Marketplace-goods kinds (sell/buy/social) keep
    // null — hourly billing is not their pricing model.
    f.billing_unit ?? (kind === "live_event" || kind === "consult" ? "hour" : null),
    f.free_entry ?? 0, f.max_per_booking ?? 4, f.response_time_min ?? null,
    f.vibe_tags ?? null, f.credential ?? null,
    // [MKT-3GROUP-1] spec §3 — media_mode, defaults to the column default.
    f.media_mode ?? "audio_video").run();
  track(env, ctx.uid, "listing_draft_created", APP, {
    kind, vertical, category, section: sectionFor(kind, category), proposed_category: f.proposed_category ?? null,
    cat_version: catV, playbook_version: pbV, template_version: tplV,
    // §2.3 signal: how often the taxonomy has no home for what someone is listing.
    filed_as_other: category === "other" && !!f.proposed_category,
  });
  return json({
    ok: true, listing_id: id, status: "draft", vertical, category,
    cat_version: catV, playbook_version: pbV, template_version: tplV,
  });
}

// PUT /api/listings/:id — step updates (owner only; drafts and published).
export async function updateListing(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  // [AVA-MKT-CVER-1] The MATERIAL columns ride along so we can diff old vs new below
  // — a bump must reflect a real CHANGE, not merely a field being submitted.
  // [AVA-MKT-VERT-1] `attrs` rides along as a MATERIAL column (diffed below), and
  // `cat_version` because it is the PIN every attrs check must be resolved at (§2.4).
  const row = await metaDb(env).prepare(
    // [MARKET-SECTION-1] `section` rides along so the update below can tell
    // whether an edit actually moves the listing to a different bazaar section.
    // [LIST-CONTENT-2] `free_entry` and `slug` ride along: free_entry to compute the
    // EFFECTIVE free-lane state when a caller only touches price (or only touches
    // free_entry) in this PUT; slug for the uniqueness clash check below.
    // [LIST-REVIEW-BINDING-1] cover_media/starts_at/duration_min/capacity and
    // reviewed_content_hash ride along too — the review-binding check below needs
    // the full REVIEW_MATERIAL_FIELDS set plus the hash it's comparing against.
    "SELECT * FROM listings WHERE id=?1",
  ).bind(id).first<any>();
  if (!row || row.creator_id !== ctx.uid) return json({ error: "not found" }, 404);
  if (MARKET_KINDS.has(String(row.kind)) && !(await marketplacePublishOn(env))) return marketplaceOff();
  if (row.status === "cancelled" || row.status === "completed") return json({ error: "listing closed" }, 409);
  const b = (await req.json().catch(() => ({}))) as any;
  // [C02] Strip/replace server-owned attrs keys BEFORE normFields() (and every
  // validator below) sees them, splicing the row's OWN stored poster back in so a
  // creator-supplied attrs blob can neither forge nor silently erase it.
  if (b.attrs !== undefined) {
    const existingAttrs = parseJson<Record<string, unknown>>(row.attrs, {});
    b.attrs = sanitizeCreatorAttrs(b.attrs, existingAttrs);
  }
  const f = normFields(b);
  // [LIST-CONTENT-2] spec §C.1 — new scalar columns.
  const fieldsError = listingContentFieldsError(b);
  if (fieldsError) return json({ ok: false, error: fieldsError, message: fieldsError, field: "listing" }, 400);
  // E: the free lane forces price=0. normFields already did this when THIS call sets
  // free_entry=1, but a call that edits price alone while free_entry=1 was already
  // true on the row (or a call that flips free_entry=1 without resending price) also
  // needs the force — so recompute the EFFECTIVE value from the row when absent here.
  const effectiveFreeEntry = ("free_entry" in f ? Number(f.free_entry) : Number(row.free_entry ?? 0)) === 1;
  if (effectiveFreeEntry) f.price = 0;
  // [Step0 C01-adjacent] free_entry is allowlist-gated — checked against the
  // RESULTING state, not just an incoming `free_entry:true`: a creator must not be
  // able to flip an ALREADY-EXISTING listing to free_entry=1 either (e.g. by editing
  // only `attrs` on a listing that was already free_entry=1 as a way to probe, or a
  // client bug that resends `free_entry:true` on every save). Someone already on the
  // allowlist keeps editing their existing free listing normally — freeEntryAllowed
  // returns true for them regardless of "existing" status.
  if (effectiveFreeEntry) {
    const cfg = await readConfig(env);
    if (!freeEntryAllowed(env, cfg, ctx.uid)) {
      track(env, ctx.uid, "listing_free_entry_refused", APP, { listing_id: id, kind: row.kind, reason: "free_entry_not_allowed" });
      return json({
        ok: false, error: "free_entry_not_allowed", field: "free_entry",
        message: "Free-entry listings are limited to approved creators right now.",
      }, 403);
    }
  }
  // [PRICE-HOURLY-1] spec §4.2 — same floor as createListing, only when THIS
  // call actually sends a price (never retroactively fails an edit that
  // doesn't touch price, which would turn "fix a typo in the title" into a
  // surprise 400 for a listing that predates this rule) and only for the two
  // session kinds this pricing model governs. `row.kind` — kind is not editable.
  // `Number(f.price) > 0`, not `b.price !== undefined` — same reason as
  // createListing above: every wizard step PUTs the full accumulated body, so
  // steps 3-7 all re-send price=0 on a draft the creator has not priced yet,
  // and an `!== undefined` test rejects every one of them.
  if (!effectiveFreeEntry && Number(f.price) > 0 && (String(row.kind) === "live_event" || String(row.kind) === "consult")) {
    const priceErr = priceFloorError(f.price, false);
    if (priceErr) return json({ ok: false, error: "price_below_floor", message: priceErr, field: "price" }, 400);
  }
  // [LIST-CONTENT-2] spec §C.1 — "on update accept an explicit slug once — reject with
  // 409 if taken by another of the creator's listings". Validated and uniqueness-
  // checked HERE (not in normFields, which has no DB handle) before `keys` is built so
  // f.slug rides the same generic SET-builder as every other column below.
  if (b.slug !== undefined) {
    const want = String(b.slug || "").trim().toLowerCase();
    if (!SLUG_RE.test(want)) {
      return json({ ok: false, error: "slug must be lowercase a-z0-9- (max 48 chars)", message: "slug must be lowercase a-z0-9- (max 48 chars)", field: "slug" }, 400);
    }
    if (want !== String(row.slug ?? "")) {
      const clash = await metaSession(env).prepare(
        "SELECT 1 FROM listings WHERE creator_id=?1 AND slug=?2 AND id<>?3",
      ).bind(row.creator_id, want, id).first();
      if (clash) {
        return json({ ok: false, error: "slug_taken", message: "You already have a listing with this slug.", field: "slug" }, 409);
      }
    }
    f.slug = want;
  }
  const keys = (EDITABLE as readonly string[]).filter((k) => k in f);
  if (!keys.length) return json({ error: "nothing to update" }, 400);

  // -------------------------------------------------------------------------
  // [AVA-MKT-VERT-1] §2.2 + §2.4 — validate `attrs` against the category's
  // field_schema AT THE LISTING'S PINNED cat_version.
  //
  // The pin is the whole point, and it is easy to get wrong by reaching for the live
  // row: validating a seller's answers against a NEWER schema than the listing was
  // born under means an admin adding a required field in September retroactively makes
  // a July listing un-editable — the seller cannot fix a typo without answering
  // questions that did not exist when they published. That is the silent drift §2.4
  // exists to stop, wearing a different hat. resolveCategoryVersion() reads the exact
  // pinned version row and falls back to the live row (never MAX(version)).
  // -------------------------------------------------------------------------
  let attrsMissing: string[] = [];
  // Keyed on the RAW body, not on `"attrs" in f`: normFields DROPS an oversize/malformed
  // attrs, so a `f`-keyed check would skip this block precisely when it is needed and
  // return 200 on a write that stored nothing. Ask the body whether attrs was submitted.
  if (b.attrs !== undefined) {
    const enc = encodeAttrs(b.attrs);
    if (enc.error) return json({ ok: false, error: enc.error, message: enc.error, field: "attrs" }, 422);
    const policyError = commercialPolicyError(String(row.kind), b.attrs);
    if (policyError) return json({ ok: false, error: policyError, message: policyError, field: "attrs" }, 422);
    // [LIST-CONTENT-2] spec §C.2 / TRUST §4.3 — details-page attrs, checked against the
    // EFFECTIVE free_entry computed above (this call's value, or the row's).
    const contentError = contentAttrsError(b.attrs, effectiveFreeEntry);
    if (contentError) return json({ ok: false, error: contentError, message: contentError, field: "attrs" }, 422);
    // A category change in the same PUT validates against the NEW category — still at
    // the pinned cat_version, because re-pinning is an explicit admin migration (§2.4),
    // never a side effect of a seller edit.
    const cat = String(("category" in f ? f.category : row.category) ?? "");
    const resolved = await resolveCategoryVersion(env, cat, Number(row.cat_version ?? 1));
    const v = validateAttrs(resolved?.field_schema ?? null, parseJson(f.attrs, {} as Record<string, unknown>));
    // ONLY `violations` block. `missing` (the min_required keys still unanswered) must
    // NOT 422: this endpoint is how the compose loop saves a half-finished draft, and
    // "you haven't told me the area yet" is the loop's next QUESTION, not a failed save.
    // §2.2 puts min_required behind publish; validateAttrs().ok folds the two together,
    // so it is deliberately not used here. Unknown keys are never violations either
    // (§2.4: a schema bump must not orphan data).
    if (v.violations.length) {
      const msg = v.violations.map((x) => x.detail).join("; ");
      track(env, ctx.uid, "listing_attrs_rejected", APP, {
        listing_id: id, category: cat, cat_version: Number(row.cat_version ?? 1),
        resolved_from: resolved?.resolved_from ?? "none",
        codes: v.violations.map((x) => x.code), keys: v.violations.map((x) => x.k),
      });
      // Shape mirrors guardWrite()'s 422 (moderate.ts:95) — same `ok:false` + `field` +
      // `error`/`message` pair, so the client's existing 422 renderer needs no new case.
      return json({
        ok: false, attrs: "invalid", field: "attrs",
        violations: v.violations, missing: v.missing, unknown_keys: v.unknown_keys,
        error: msg, message: msg,
      }, 422);
    }
    attrsMissing = v.missing;
  } else if (effectiveFreeEntry) {
    // [C03/cap-hole] A PUT of just `{"free_entry": true}` (no `attrs` in the body at
    // all) skips contentAttrsError entirely, because it only runs inside the
    // `b.attrs !== undefined` branch above. This re-runs it over the row's existing
    // stored attrs against the now-true effective free_entry.
    //
    // [PRICE-HOURLY-2] It no longer guards the CAP — that is not required of a
    // caller any more and lib/free_session.ts derives it. What it still catches
    // is every other cross-field rule in contentAttrsError for a listing that
    // has just become free, so it stays rather than being deleted with the
    // requirement that first motivated it.
    const existingAttrs = parseJson<Record<string, unknown>>(row.attrs, {});
    const contentError = contentAttrsError(existingAttrs, true);
    if (contentError) return json({ ok: false, error: contentError, message: contentError, field: "attrs" }, 422);
  }

  const blocked = await guardWrite(req, env, ctx.uid, APP, [
    { text: f.title as string | undefined, field: "listing_title" },
    { text: f.description as string | undefined, field: "listing_desc" },
  ]);
  if (blocked) return blocked;
  // A published live event's time can't silently move (the slot is claimed) — reject.
  if (row.status !== "draft" && row.kind === "live_event" && ("starts_at" in f || "duration_min" in f)) {
    return json({ error: "cannot move a published event — cancel and re-create" }, 409);
  }
  // A marketplace expiry is a paid/free 30-day entitlement. Updating expiry_days
  // on an already-published listing must not extend the live window for free; the
  // next period is obtained by restoring to draft and publishing again, which
  // consumes the next deterministic entitlement period.
  if ("expiry_days" in f && MARKET_KINDS.has(String(row.kind)) && row.status !== "draft") {
    return json({ error: "renewal_required", message: "Restore this listing and publish a new 30-day period." }, 409);
  }
  // [AVA-MKT-CVER-1] Bump content_version ONLY on a real delta to a MATERIAL field.
  // Submitting title unchanged (the client PUTs the whole form) must NOT reopen every
  // buyer's paid negotiation — hence the value comparison, not an `in f` check.
  // Compared as strings so 500 vs "500" (D1 vs JSON) and null vs "" don't read as edits.
  // [AVA-MKT-VERT-1] `attrs` is JSON and compares canonically (sameAttrs) — a raw
  // String() compare would read a key REORDER as an edit and reopen every buyer's paid
  // negotiation for free. Every other MATERIAL field is a scalar and keeps String().
  const same = (x: unknown, y: unknown) => String(x ?? "") === String(y ?? "");
  const changed = (MATERIAL as readonly string[]).filter(
    (k) => k in f && !(k === "attrs" ? sameAttrs(f[k], row[k]) : same(f[k], row[k])),
  );
  const material = changed.length > 0;
  // Literal expression, not a bind — keeps the ?N bind order below stable, and the
  // read-modify-write happens inside SQLite so concurrent edits can't lose a bump.
  const bump = material ? ", content_version=content_version+1" : "";
  const sets = keys.map((k, i) => `${k}=?${i + 2}`).join(", ");
  // [MARKET-SECTION-1] `section` is DERIVED from (kind, category), so an edit
  // that changes the category has to move the listing to its new section. It is
  // a literal expression rather than a bind for the same reason `bump` is:
  // keeping the ?N order below stable. Without this, re-filing a listing under
  // "astrologers" left it sitting in Live streaming forever, and the only sign
  // would have been a card in the wrong section of the marketplace.
  const nextSection = sectionFor(
    "kind" in f ? String(f.kind) : String(row.kind),
    "category" in f ? String(f.category) : String(row.category),
  );
  const sectionSet = nextSection !== String(row.section ?? "") ? `, section='${nextSection}'` : "";

  // [LIST-REVIEW-BINDING-1] Second half of C02 — is the approval this listing is
  // carrying still bound to the content that's about to be written? Only matters
  // once a listing has actually been through review (`reviewed_content_hash` set)
  // and is sitting in one of the three statuses that CARRY an approval forward.
  // draft/pending_review/rejected have nothing to invalidate — either they were
  // never approved, or (rejected) the hash was already cleared at reject time.
  let demoteToPendingReview = false;
  const reviewedStatus = String(row.status);
  if (["approved", "published", "live"].includes(reviewedStatus)) {
    const mergedForHash: Record<string, unknown> = { ...row };
    for (const rf of REVIEW_MATERIAL_FIELDS) if (rf in f) mergedForHash[rf] = f[rf];
    // `attrs` isn't in REVIEW_MATERIAL_FIELDS (reviewedContentHash treats it as its
    // own key, stripping RESERVED_ATTRS_KEYS internally) — merge it explicitly or an
    // edited attrs blob would silently hash against the OLD stored value.
    if ("attrs" in f) mergedForHash.attrs = f.attrs;
    const [currentHash, newHash] = await Promise.all([
      reviewedContentHash(row),
      reviewedContentHash(mergedForHash),
    ]);
    // Legacy approved rows have no stored hash. An unchanged full-form save is
    // harmless, but a real reviewed-field edit must earn a fresh approval.
    const approvalInvalid = row.reviewed_content_hash
      ? currentHash !== row.reviewed_content_hash || newHash !== row.reviewed_content_hash
      : newHash !== currentHash;
    if (approvalInvalid) {
      if (reviewedStatus !== "approved") {
        // published/live — real buyers may be holding a seat. Never silently
        // unpublish out from under them: check for sold entitlements FIRST and
        // fail closed (refuse the edit) whenever that check can't be trusted.
        const sold = await hasSoldEntitlements(env, id);
        if (sold !== false) {
          track(env, ctx.uid, "listing_material_edit_refused", APP, {
            listing_id: id, status: reviewedStatus,
            sold_check: sold === null ? "unavailable" : "sold",
          });
          return json({
            ok: false, error: "material_edit_blocked_sold_out",
            message: sold === null
              ? "Could not confirm whether this listing has sold seats; try again shortly, or cancel it first."
              : "This listing has sold seats/bookings and its material details can't be changed. Cancel it, or make only non-material edits.",
          }, 409);
        }
      }
      demoteToPendingReview = true;
    }
  }
  // [LIST-REVIEW-BINDING-1] `listing_transitions.ts` now carries the three
  // `system_review_invalidated_*` rows for (approved|published|live) -> pending_review
  // — checkTransition() is the AUTHORITY here, not a bystander. If it refuses (e.g. a
  // future edit to that table drops one of these rows), the demotion must NOT happen:
  // fail closed by refusing the whole edit with a 409, rather than writing the status
  // via a literal SQL fragment regardless of the answer. Leaving the status alone and
  // letting the content write through was rejected as the fail-closed choice — that
  // would silently re-open the exact hole this mechanism exists to close (rewritten
  // content sitting under a stale approval), just without the loud refusal a 409 gives.
  let transitionRuleId: string | null = null;
  if (demoteToPendingReview) {
    const transitionCheck = checkTransition(reviewedStatus, "pending_review", "system");
    if (!transitionCheck.ok) {
      track(env, ctx.uid, "listing_material_edit_refused", APP, {
        listing_id: id, status: reviewedStatus,
        reason: "no_demotion_transition_rule", transition_reason: transitionCheck.reason,
      });
      return json({
        ok: false, error: "material_edit_blocked_no_transition_rule",
        message: "This edit could not be safely applied right now; try again shortly or contact support.",
      }, 409);
    }
    transitionRuleId = transitionCheck.rule.id;
    track(env, ctx.uid, "listing_review_invalidated_by_edit", APP, {
      listing_id: id, from_status: reviewedStatus, to_status: "pending_review",
      fields: ([...REVIEW_MATERIAL_FIELDS, "attrs"] as string[]).filter((k) => k in f),
      transition_rule_id: transitionRuleId,
    });
  }
  const statusSet = demoteToPendingReview
    ? ", status='pending_review', reviewed_content_hash=NULL, reviewed_at=NULL, reviewed_by=NULL"
    : "";

  const updateRes = await metaDb(env).prepare(
    `UPDATE listings SET ${sets}${bump}${sectionSet}${statusSet}, updated_at=?${keys.length + 2}
      WHERE id=?1 AND authority_version=?${keys.length + 3} AND status=?${keys.length + 4}`,
  ).bind(id, ...keys.map((k) => f[k]), Date.now(), Number(row.authority_version ?? 0), row.status).run();
  if (!(updateRes.meta?.changes ?? 0)) {
    return json({ error: "conflict", message: "This listing changed while it was being saved. Reload and try again." }, 409);
  }
  const version = Number(row.content_version ?? 0) + (material ? 1 : 0);
  if (material) {
    track(env, ctx.uid, "listing_content_version_bumped", APP, {
      listing_id: id, listing_kind: row.kind, fields: changed, content_version: version,
    });
  }
  // #8: live listing update — nudge anyone viewing this listing to refresh
  // (price / details changed). Ephemeral, best-effort.
  void partyEmit(env, `listing:${id}`, { t: "listing_update" });
  if (row.status !== "draft") await ftsSync(env, id);
  // content_version is additive in this response: the client can refresh its copy of
  // the reopen key without re-fetching the card.
  // [AVA-MKT-VERT-1] attrs_missing is the compose loop's "what must I still ask before
  // this can publish" (§2.2 min_required) — reported, never enforced, on a draft save.
  return json({
    ok: true, content_version: version, attrs_missing: attrsMissing,
    ...(demoteToPendingReview ? { status: "pending_review", review_invalidated: true } : {}),
  });
}

// POST /api/listings/:id/submit — creator moves a draft into the approval queue.
//
// [MKT-POSTER-AUTO-1] Also kicks off AI poster generation so an admin opening
// the review queue already has a poster waiting, rather than having to click
// "generate" themselves. Gated behind `posterAutoGenerateOnSubmit` (default
// false — declared in routes/config.ts DEFAULTS by a concurrent change; read
// here via the normal readConfig() layering, never assumed from DEFAULTS
// alone). Generation must never block this response: the synchronous D1
// write below flips the poster into a `generating` placeholder so the admin
// UI shows a spinner immediately, and the actual image call runs detached.
export async function submitListingForApproval(req: Request, env: Env, id: string, exec?: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const db = metaDb(env);
  const row = await db.prepare(
    "SELECT id, creator_id, status, attrs, title, description, blurb, category, kind, vibe_tags, spoken_lang, cover_media, authority_version, price, free_entry FROM listings WHERE id=?1",
  ).bind(id).first<any>();
  if (!row || row.creator_id !== ctx.uid) return json({ error: "not found" }, 404);
  if (String(row.status) !== "draft") return json({ error: "listing not draft", status: row.status }, 409);
  // [PRICE-HOURLY-1] spec §4.2 — the floor's LAST word before a listing goes
  // into the approval queue, independent of whichever create/edit call set
  // the price: a draft can accumulate its price across several PUTs (each of
  // which only checks a price it was actually sent), so submit is where an
  // unpriced or under-floor draft is finally caught rather than slipping
  // through to review.
  if (Number(row.free_entry ?? 0) !== 1 && (String(row.kind) === "live_event" || String(row.kind) === "consult")) {
    const priceErr = priceFloorError(row.price, false);
    if (priceErr) return json({ ok: false, error: "price_below_floor", message: priceErr, field: "price" }, 400);
  }
  let attrs: any = {};
  try { attrs = row.attrs ? JSON.parse(String(row.attrs)) : {}; } catch { attrs = {}; }
  const now = Date.now();

  // [MKT-POSTER-AUTO-1] Decide whether to auto-generate BEFORE the write so the
  // placeholder poster state lands in the same batch as the status flip.
  const cfg = await readConfig(env);
  const autoOn = (cfg as any).posterAutoGenerateOnSubmit === true;
  const maxAttempts = Number((cfg as any).posterAutoGenerateMaxAttempts ?? 2) || 2;
  const priorPoster = attrs.poster ?? null;
  const priorAttempt = Number(priorPoster?.attempt ?? 0) || 0;
  const nextAttempt = priorAttempt + 1;
  // Never re-generate over an existing draft/approved/rejected poster — only
  // when there is none yet, or the last attempt failed, and only within the
  // configured attempt budget.
  const eligible = !priorPoster || priorPoster.status === "failed";
  const manualCoverCount = parseJson<unknown[]>(row.cover_media, [])
    .filter((c: any) => c && c.source !== "ai_poster").length;
  // A poster is prepended. Refuse the generation itself when five creator
  // images already occupy the gallery, rather than producing an unsaveable sixth.
  const shouldAutoGenerate = autoOn && eligible && nextAttempt <= maxAttempts && manualCoverCount < 5;

  if (shouldAutoGenerate) {
    attrs.poster = { status: "generating", generated_at: now, auto: true, attempt: nextAttempt };
  }

  const submitted = await db.prepare(
    "UPDATE listings SET status='pending_review', attrs=?2, updated_at=?3 WHERE id=?1 AND status='draft' AND authority_version=?4",
  ).bind(id, JSON.stringify(attrs), now, Number(row.authority_version ?? 0)).run();
  if (!(submitted.meta?.changes ?? 0)) {
    return json({ error: "conflict", message: "This listing changed before submission. Reload and try again." }, 409);
  }
  await db.prepare(
    `INSERT INTO listing_approval_history
     (id, listing_id, actor_id, action, previous_status, next_status, reason, poster_status, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
  ).bind(crypto.randomUUID(), id, ctx.uid, "submit_for_review", row.status, "pending_review", null, attrs.poster?.status ?? null, now).run();
  try {
    await env.DB_WALLET.prepare(
      "INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
    ).bind(crypto.randomUUID(), ctx.uid, "listing_submit_for_review", id, JSON.stringify({ previous_status: row.status, next_status: "pending_review", poster_status: attrs.poster?.status ?? null }), now).run();
  } catch {
    // audit best-effort; core state and history already committed atomically.
  }
  // [Telemetry] This step previously emitted no server event at all — the only
  // record of a submit-for-review was the D1 approval-history row, which PostHog
  // can't query. draft->pending_review is also the one creator-initiated transition
  // `checkTransition` grants unconditionally (`creator_submit`, requires:"none"), so
  // this event is the honest signal of submission VOLUME independent of the status
  // endpoint's own `listing_status_changed`.
  track(env, ctx.uid, "listing_submitted_for_review", APP, {
    listing_id: id, kind: row.kind, category: row.category,
    previous_status: row.status, poster_auto_generate: shouldAutoGenerate,
  });

  if (shouldAutoGenerate) {
    // The ExecutionContext is threaded in from index.ts so the isolate is held
    // open until generation finishes. Without waitUntil a bare detached
    // promise can be dropped the moment the response is sent, stranding the
    // poster on `generating` with nothing to move it off. The `exec` param is
    // optional only so other callers/tests can omit it; in that case we fall
    // back to a detached promise, which is best-effort.
    const work = runAutoPosterGeneration(env, {
      listingId: id,
      ownerUid: row.creator_id,
      row,
      actorUid: ctx.uid,
      attempt: nextAttempt,
      // [POSTER-FIRST-1] Flags are read HERE, on the request path, and passed
      // down — not re-read inside the detached job. A second readConfig() in
      // the background could see a different KV value than the one that decided
      // to start this generation, so the run would not match its own decision.
      variants: (cfg as any).posterVariantsEnabled === true,
      verify: (cfg as any).posterVerifyEnabled === true,
      composeFallback: (cfg as any).posterComposeFallbackEnabled === true,
      verifyMaxAttempts: Number((cfg as any).posterVerifyMaxAttempts ?? 3) || 3,
      // [POSTER-SUBJECT-1] Same reasoning as the flags above: decided here, on
      // the request path, and passed down.
      subjectEnabled: (cfg as any).posterCreatorSubjectEnabled === true,
      subjectPhoto: (cfg as any).posterCreatorPhotoEnabled === true,
    }).catch((e) => {
      // runAutoPosterGeneration() itself never throws (it wraps everything in
      // try/catch and always tries to land a terminal state) — this is a final
      // safety net so a truly unexpected throw can never look like a silently
      // unhandled rejection.
      console.error("listing_poster_auto_generate_unhandled", { listing_id: id, error: String((e as any)?.message || e) });
    });
    if (exec && typeof exec.waitUntil === "function") exec.waitUntil(work);
    else void work;
  }

  return json({ ok: true, id, status: "pending_review" });
}

// [MKT-POSTER-AUTO-1] Runs the actual poster generation off the request path,
// then re-reads the listing and merges the result back in — never a blind
// overwrite, because an admin can act on the row (approve/reject/regenerate)
// while generation is still in flight. If the row has moved on (no longer
// pending_review, or the poster is no longer in the exact `generating` state
// this call put it in), the write is abandoned rather than clobbering
// whatever the admin did. Any failure — including an abandoned write — must
// still land the poster on `failed`, never leave it stuck on `generating`.
/** [POSTER-CHECKPOINT-1 2026-09-05] Land one poster result on the row.
 *
 *  Extracted verbatim from runAutoPosterGeneration so it can be called TWICE in
 *  one run: once the moment the portrait exists (the checkpoint), and once at
 *  the end with the variants attached. Splitting it is the whole fix — the auto
 *  path runs detached on `ctx.waitUntil`, and on 2026-09-05 the isolate was
 *  killed between "portrait verified" and "write to D1", so a finished poster
 *  was thrown away and the cron reported it as interrupted.
 *
 *  `acceptStatuses` is what makes the second write safe. The checkpoint may only
 *  overwrite the `generating` placeholder; the final write may also overwrite
 *  the `draft` its own checkpoint left. Neither may touch `approved` or
 *  `rejected` — if an admin acted in between, that decision wins and this
 *  attempt is abandoned rather than reverted.
 */
async function persistPosterAttempt(
  env: Env,
  listingId: string,
  attempt: number,
  poster: PosterState,
  coverMedia: CoverMediaItem[] | null,
  acceptStatuses: readonly string[],
): Promise<{ ok: boolean; errorKind?: string; poster: PosterState }> {
  const db = metaDb(env);
  const claims = (attrs: any, status: any) =>
    String(status) === "pending_review"
    && acceptStatuses.includes(String(attrs?.poster?.status))
    && Number(attrs?.poster?.attempt ?? -1) === attempt;

  const fresh = await db.prepare(
    "SELECT status, attrs, cover_media, authority_version FROM listings WHERE id=?1",
  ).bind(listingId).first<any>();
  if (!fresh) return { ok: false, errorKind: "listing_missing", poster };

  let freshAttrs: any = {};
  try { freshAttrs = fresh.attrs ? JSON.parse(String(fresh.attrs)) : {}; } catch { freshAttrs = {}; }
  if (!claims(freshAttrs, fresh.status)) {
    // Row moved on (admin acted, or a newer attempt already landed) — abandon
    // the write rather than clobber it.
    console.warn("listing_poster_auto_generate_abandoned", {
      listing_id: listingId, status: fresh.status, poster_status: freshAttrs.poster?.status,
    });
    return { ok: false, errorKind: "abandoned_row_changed", poster };
  }

  freshAttrs.poster = poster;
  const nextCoverMedia = coverMedia ? JSON.stringify(coverMedia) : fresh.cover_media;
  const saved = await db.prepare(
    "UPDATE listings SET attrs=?2, cover_media=?3, updated_at=?4 WHERE id=?1 AND status='pending_review' AND authority_version=?5",
  ).bind(listingId, JSON.stringify(freshAttrs), nextCoverMedia, Date.now(), Number(fresh.authority_version ?? 0)).run();
  if (saved.meta?.changes ?? 0) return { ok: true, poster };

  // A concurrent ordinary edit may have advanced only the row revision while
  // leaving this exact poster attempt active. Re-read once and merge against
  // the latest covers instead of stranding the generating state.
  const latest = await db.prepare(
    "SELECT status,attrs,cover_media,authority_version FROM listings WHERE id=?1",
  ).bind(listingId).first<any>();
  let latestAttrs: any = {};
  try { latestAttrs = latest?.attrs ? JSON.parse(String(latest.attrs)) : {}; } catch { latestAttrs = {}; }
  if (!claims(latestAttrs, latest?.status)) {
    return { ok: false, errorKind: "abandoned_row_changed", poster };
  }

  let mergedCoverMedia = latest.cover_media;
  let terminalPoster = poster;
  let errorKind: string | undefined;
  if (poster.status === "draft" && Array.isArray(coverMedia)) {
    const generated = coverMedia.find((c: any) => c?.source === "ai_poster");
    const manual = parseJson<any[]>(latest.cover_media, [])
      .filter((c: any) => c && c.source !== "ai_poster");
    if (!generated || manual.length >= 5) {
      terminalPoster = {
        ...poster,
        status: "failed",
        error: "Remove one creator photo before saving the AI poster.",
      };
      errorKind = "cover_slot_required";
    } else {
      mergedCoverMedia = JSON.stringify([generated, ...manual]);
    }
  }
  latestAttrs.poster = terminalPoster;
  const retried = await db.prepare(
    "UPDATE listings SET attrs=?2,cover_media=?3,updated_at=?4 WHERE id=?1 AND status='pending_review' AND authority_version=?5",
  ).bind(
    listingId,
    JSON.stringify(latestAttrs),
    mergedCoverMedia,
    Date.now(),
    Number(latest.authority_version ?? 0),
  ).run();
  if (!(retried.meta?.changes ?? 0)) {
    return { ok: false, errorKind: "abandoned_row_changed", poster };
  }
  return { ok: !errorKind, errorKind, poster: terminalPoster };
}

async function runAutoPosterGeneration(
  env: Env,
  opts: {
    listingId: string; ownerUid: string; row: Record<string, any>; actorUid: string; attempt: number;
    // [POSTER-FIRST-1] Resolved by the caller from the same readConfig() that
    // decided to run at all. Optional so existing tests/callers still compile,
    // defaulting to the pre-POSTER-FIRST behaviour.
    variants?: boolean; verify?: boolean; composeFallback?: boolean; verifyMaxAttempts?: number;
    // [POSTER-SUBJECT-1] posterCreatorSubjectEnabled / posterCreatorPhotoEnabled.
    subjectEnabled?: boolean; subjectPhoto?: boolean;
  },
): Promise<void> {
  const t0 = Date.now();
  let outcome: "draft" | "failed" = "failed";
  let errorKind: string | undefined;
  // [POSTER-CHECKPOINT-1] Set by the checkpoint below. When true, a portrait is
  // already on the row, so even if everything after this point is lost the
  // creator has a poster — and the final write is allowed to overwrite the
  // `draft` this attempt itself wrote.
  let checkpointed = false;
  let subjectKind = "off";
  try {
    // [POSTER-SUBJECT-1] Resolved inside the detached job, not on the request
    // path, because it may fetch the profile photo and run a vision call — work
    // that must not sit between the creator pressing Submit and the response.
    const subject = opts.subjectEnabled
      ? await resolveCreatorSubject(env, opts.ownerUid, { usePhoto: opts.subjectPhoto === true })
      : null;
    subjectKind = !subject ? "off"
      : subject.photoUrl ? `likeness:${subject.gender ?? "unknown"}`
      : subject.gender ? `gender:${subject.gender}`
      : `none:${subject.photoSkipped ?? "unknown"}`;
    const prompt = buildPosterPrompt(opts.row, subject);
    const { poster, coverMedia } = await generateListingPoster(env, {
      subject,
      listingId: opts.listingId,
      ownerUid: opts.ownerUid,
      row: opts.row,
      prompt,
      actorUid: opts.actorUid,
      auto: true,
      attempt: opts.attempt,
      variants: opts.variants,
      verify: opts.verify,
      composeFallback: opts.composeFallback,
      maxAttempts: opts.verifyMaxAttempts,
      // [POSTER-CHECKPOINT-1] The portrait is in R2 and verified; save it NOW,
      // before the tablet/wide reframes get a chance to outlive the isolate.
      onPortrait: async ({ poster: p, coverMedia: cm }) => {
        const r = await persistPosterAttempt(env, opts.listingId, opts.attempt, p, cm, ["generating"]);
        checkpointed = r.ok;
        await track(env, opts.actorUid, "listing_poster_checkpoint", APP, {
          listing_id: opts.listingId,
          creator_id: opts.ownerUid,
          attempt: opts.attempt,
          ok: r.ok,
          error_kind: r.errorKind,
          ms_since_start: Date.now() - t0,
        });
      },
    });
    outcome = poster.status === "draft" ? "draft" : "failed";
    if (poster.status === "failed") errorKind = "generation_failed";

    // The final write also accepts the `draft` its own checkpoint left, so the
    // variants can be attached; it still refuses `approved`/`rejected`, so an
    // admin decision taken mid-run is never reverted.
    const res = await persistPosterAttempt(
      env, opts.listingId, opts.attempt, poster, coverMedia,
      checkpointed ? ["generating", "draft"] : ["generating"],
    );
    if (!res.ok) {
      errorKind = errorKind || res.errorKind;
      // A checkpointed run already put a usable poster on the listing, so
      // losing only the variants write is not a failed generation.
      outcome = checkpointed && res.errorKind === "abandoned_row_changed" ? "draft" : "failed";
    } else if (res.poster.status !== "draft") {
      outcome = "failed";
    }
  } catch (e) {
    errorKind = errorKind || "unexpected_exception";
    outcome = "failed";
    // Best-effort: try to land a terminal `failed` state so nothing is stuck
    // on `generating` forever, but only if the row is still in the exact spot
    // this call left it in — same re-read + merge discipline as the happy path.
    try {
      const db = metaDb(env);
      const fresh = await db.prepare("SELECT status, attrs, authority_version FROM listings WHERE id=?1").bind(opts.listingId).first<any>();
      if (fresh) {
        let freshAttrs: any = {};
        try { freshAttrs = fresh.attrs ? JSON.parse(String(fresh.attrs)) : {}; } catch { freshAttrs = {}; }
        if (String(fresh.status) === "pending_review" && freshAttrs.poster?.status === "generating" && Number(freshAttrs.poster?.attempt ?? -1) === opts.attempt) {
          freshAttrs.poster = { ...freshAttrs.poster, status: "failed", error: String((e as any)?.message || "unexpected error").slice(0, 180) };
          await db.prepare(
            "UPDATE listings SET attrs=?2, updated_at=?3 WHERE id=?1 AND status='pending_review' AND authority_version=?4",
          ).bind(opts.listingId, JSON.stringify(freshAttrs), Date.now(), Number(fresh.authority_version ?? 0)).run();
        }
      }
    } catch { /* last-resort best-effort; nothing more to do */ }
  } finally {
    try {
      await track(env, opts.actorUid, "listing_poster_generate", APP, {
        listing_id: opts.listingId,
        creator_id: opts.ownerUid,
        auto: true,
        attempt: opts.attempt,
        outcome,
        duration_ms: Date.now() - t0,
        error_kind: errorKind,
        // [POSTER-SUBJECT-1] Which subject the poster was actually painted
        // from. "off" = the flag is dark. "none:<reason>" is the one to watch:
        // the feature ran and still had nothing to say about who the creator
        // is, which is how a poster silently reverts to an invented person.
        subject: subjectKind,
        // [POSTER-CHECKPOINT-1] The success value to assert: on a healthy run
        // this is true and `outcome` is "draft". `checkpointed=true` with a
        // failed outcome means the safety net caught a death after the
        // portrait — the creator still has a poster. `checkpointed=false` with
        // no `listing_poster_checkpoint` event at all is the 2026-09-05 shape
        // (killed before the portrait) and is the one to alert on.
        checkpointed,
      });
    } catch { /* telemetry best-effort — must never affect poster state */ }
  }
}

// GET /api/marketplace/listing-quote?listing_id=... — authoritative fee preview.
// The listing must already be the caller's draft so a client cannot probe another
// account's quota/balance or manufacture a period identity.
export async function listingFeeQuote(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!(await marketplacePublishOn(env))) return marketplaceOff();
  const listingId = (new URL(req.url).searchParams.get("listing_id") || "").trim();
  if (!listingId) return json({ error: "listing_id required" }, 400);
  const listing = await metaDb(env).prepare(
    "SELECT creator_id, kind, vertical, status FROM listings WHERE id=?1",
  ).bind(listingId).first<any>();
  if (!listing || String(listing.creator_id) !== ctx.uid) return json({ error: "not found" }, 404);
  if (!MARKET_KINDS.has(String(listing.kind))) return json({ error: "not a marketplace listing" }, 400);
  if (String(listing.status) !== "draft") return json({ error: "listing_not_draft", status_now: listing.status }, 409);
  try {
    const quote = await quoteListingEntitlement(env, {
      uid: ctx.uid,
      listingId,
      vertical: String(listing.vertical ?? DEFAULT_VERTICAL),
    });
    return json({ ok: true, quote });
  } catch {
    return json({ error: "billing_unavailable", message: "Listing pricing is temporarily unavailable." }, 503);
  }
}

// [C03 MKT-PUBLISH-UNIFY-1] THE ONE AUTHORITATIVE PUBLISH PATH — every gate, the
// entitlement charge, and every side effect a listing publish must run, in one
// place. Extracted from the body of publishListing() (below) so the admin
// moderation queue's "Publish" button (admin_listings.ts adminListingAction,
// action:"publish") runs through the SAME checks a creator's own publish call
// does, instead of the raw `UPDATE listings SET status=...` that used to sit at
// admin_listings.ts:236. That bare write skipped: identity/liveness, KYC,
// category-active, the 1-5 cover cap, future starts_at, duration_min bounds,
// capacity enum, consult availability, section gating, marketplacePublishOn, the
// entitlement quote+charge, ftsSync, the creator_profiles insert and fanout.
// Two proven consequences: an admin-published listing never reached
// `listings_fts` (un-searchable by name — exploreSearch hard-returns empty on an
// index miss), and a poster generated on top of 5 uploads = 6 covers shipped,
// which the creator's OWN publish endpoint rejects with "max 5 photos".
//
// publishListing() (the HTTP handler right below this) is now a thin wrapper:
// authenticate, resolve `id`, hand off here with actor:"creator". Ownership
// (`l.creator_id !== actorUid` -> 404) is enforced HERE, but only for the
// creator actor — admin has no ownership relationship to check, and its own
// pre-checks (status==='approved', poster.status==='approved') stay in
// admin_listings.ts because they are ADDITIONAL gates on top of this function,
// never a replacement for anything it does.
//
// 🚨 CHARGE AND IDENTITY ARE EVALUATED AGAINST `l.creator_id` (`creatorUid`
// below), NEVER `args.actorUid`. Every step that touches money or KYC/liveness
// state — identityGate, requireKyc, claimBlock, the availability_rules lookup,
// quoteListingEntitlement/consumeListingEntitlement/finalizeListingPublication,
// creator_profiles, fanout, brainIngest — is keyed on the listing's CREATOR. An
// admin clicking Publish in the review queue must not spend the admin's own
// wallet balance or be blocked by the admin's own KYC/liveness state: the
// listing being published belongs to, and is metered against, the person who
// authored it, regardless of who pressed the button.
async function ensurePublicationEffects(env: Env, snapshot: any): Promise<{ sent: number; capped: boolean }> {
  const db = metaDb(env);
  const listingId = String(snapshot.id);
  const listing = await db.prepare("SELECT * FROM listings WHERE id=?1").bind(listingId).first<any>();
  if (!listing || !["published", "live"].includes(String(listing.status))) {
    throw new Error("listing is not published");
  }
  const creatorUid = String(listing.creator_id);
  await db.prepare(
    "INSERT INTO creator_profiles (user_id, updated_at) VALUES (?1,?2) ON CONFLICT(user_id) DO NOTHING",
  ).bind(creatorUid, Date.now()).run();
  await ftsSync(env, listingId);

  const who = await nameOf(env, creatorUid);
  const result = await fanout(
    env,
    creatorUid,
    `${who} just scheduled: ${String(listing.title ?? "").slice(0, 40)}`,
    listing.kind === "live_event" ? "New live event — book your spot" : "New session offering",
    `/explore/listing/${listingId}`,
    { eventId: `listing:${listingId}:published:${Number(listing.publication_version ?? 0)}`, listingId, eventType: "published" },
  );
  void brainIngest(env, {
    uid: creatorUid,
    domain: "listings",
    kind: "listing_published",
    sourceId: listingId,
    text: `Published listing "${listing.title}" (${listing.kind})`,
    meta: { kind: listing.kind, title: listing.title, price: listing.price },
  });
  return result;
}

export async function publishListingAuthoritative(
  env: Env,
  args: { listingId: string; actor: "creator" | "admin"; actorUid: string },
): Promise<
  | { ok: true; status: number; body: Record<string, unknown> }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const { listingId: id, actor, actorUid } = args;
  const db = metaDb(env);
  const l = await db.prepare("SELECT * FROM listings WHERE id=?1").bind(id).first<any>();
  if (!l) return { ok: false, status: 404, body: { error: "not found" } };
  if (actor === "creator" && l.creator_id !== actorUid) return { ok: false, status: 404, body: { error: "not found" } };
  const creatorUid = String(l.creator_id);
  // Additive telemetry only — these two keys are absent (or creator-valued) on
  // the creator path, so the pre-existing event shape for creators is unchanged.
  const actorProps: Record<string, unknown> = actor === "admin" ? { actor: "admin", admin_id: actorUid } : { actor: "creator" };

  if (String(l.status) === "published" || String(l.status) === "live") {
    if (MARKET_KINDS.has(String(l.kind))) {
      const reconciled = await markListingEntitlementPublished(env, { listingId: id });
      if (!reconciled) {
        return { ok: false, status: 503, body: {
          error: "billing_reconciliation_required",
          message: "Publication billing is still being reconciled. Please retry in a minute.",
        } };
      }
    }
    try {
      const repaired = await ensurePublicationEffects(env, l);
      return { ok: true, status: 200, body: {
        ok: true, status: String(l.status), reconciled: true, fanout: repaired,
      } };
    } catch {
      return { ok: false, status: 503, body: {
        error: "publication_repair_pending",
        published: true,
        message: "The listing is published, but its search and notification updates are still being repaired.",
      } };
    }
  }
  if (String(l.status) !== "approved") {
    return {
      ok: false, status: 409, body: {
        approved: false,
        code: "approval_required",
        reason: "approval_required",
        listing_id: id,
        status: String(l.status ?? "draft"),
        approval_status: String(l.status ?? "draft"),
        poster_status: (() => {
          try { return l.attrs ? JSON.parse(String(l.attrs))?.poster?.status ?? null : null; } catch { return null; }
        })(),
        message: "Listing approval is required before publish.",
      },
    };
  }
  const approvedAttrs = parseJson<Record<string, unknown>>(l.attrs, {});
  const posterStatus = (approvedAttrs.poster as any)?.status ?? null;
  if (posterStatus !== "approved") {
    return { ok: false, status: 409, body: {
      error: "poster_approval_required", poster_status: posterStatus,
      message: "The current poster must be approved before publication.",
    } };
  }
  if (!l.reviewed_content_hash) {
    return { ok: false, status: 409, body: {
      error: "review_binding_required",
      message: "This approval predates reviewed-content binding. An admin must review it again.",
    } };
  }
  const currentReviewedHash = await reviewedContentHash(l);
  if (currentReviewedHash !== String(l.reviewed_content_hash)) {
    return { ok: false, status: 409, body: {
      error: "review_stale", message: "The listing changed after approval and must be reviewed again.",
    } };
  }
  if (Number(l.free_entry ?? 0) === 1) {
    const cfg = await readConfig(env);
    if (!freeEntryAllowed(env, cfg, creatorUid)) {
      return { ok: false, status: 403, body: {
        error: "free_entry_not_allowed",
        message: "Free-entry listings are limited to approved creators right now.",
      } };
    }
  }
  if (MARKET_KINDS.has(String(l.kind)) && !(await marketplacePublishOn(env))) {
    return { ok: false, status: 503, body: { error: "marketplace_publish_disabled", message: "Marketplace publishing is temporarily unavailable." } };
  }

  // Marketplace listing gate (2026-07-10): a Didit LIVENESS pass, valid 90 days.
  // Covers publish AND edit-to-republish (a re-publish always funnels back through
  // here). No phone check — phone verification was removed app-wide. Gated on the
  // CREATOR's identity state — see the "creatorUid, never actorUid" note above.
  const lg = await identityGate(env, creatorUid, String(l.kind), id);
  if (lg) {
    let body: Record<string, unknown> = {};
    try { body = await lg.json(); } catch { /* best-effort */ }
    return { ok: false, status: lg.status, body };
  }

  const isMarket = MARKET_KINDS.has(String(l.kind));
  let claimedCreatorSlot = false;
  if (isMarket) {
    // AvaMarketplace (buy/sell/social): no slots, availability, capacity or valid-
    // category-id requirement; photos are optional so the flow is testable now.
    // NOTE: identity IS enforced — identityGate() above already required a Didit
    // liveness pass. The old "3-factor (video+email+phone), not enforced yet" note
    // here was wrong on both counts: there is no phone factor, and the gate is live.
    if (!l.title) return { ok: false, status: 400, body: { error: "title required" } };
    const mc = parseJson(l.cover_media, [] as unknown[]);
    // [C03 cover-cap] `cover_count` is additive (a new field on an unchanged
    // error/status) so the admin queue can show a reviewer WHY, without changing
    // the shape a creator-facing client already parses.
    if (Array.isArray(mc) && mc.length > 5) return { ok: false, status: 400, body: { error: "max 5 photos", cover_count: mc.length, limit: 5 } };
    if (!(Number(l.price) >= 0)) return { ok: false, status: 400, body: { error: "bad price" } };
  } else {
    // Creator services (live_event/consult) — KYC + photos + valid category + slot/availability.
    //
    // [LIVE-CARVE-1] This is a SECOND, DIFFERENT gate from the liveness one at
    // createListing:617. It reads `kyc_status` (authz.ts:45), which is written by the
    // Rekognition-liveness path AND the Stripe Identity path — so turning liveness off
    // leaves creators with no way to satisfy it, and every publish 403s
    // "identity verification required" immediately after the draft succeeds. Two walls,
    // one behind the other, is how the owner's screenshot fix would have looked fixed
    // and stayed broken.
    //
    // ⚠️ RESTORE THIS BEFORE REAL MONEY-IN. Relaxing it means an unverified account can
    // publish a listing that sells tickets. That is acceptable ONLY while
    // billingEnabled=false and walletRealMoney=false and every commercial* flag is off,
    // which is prod's state on 2026-08-29. `listingPublishKycRequired` back to true is a
    // prerequisite in Specs/SPEC-2026-08-29-PAID-SESSIONS-FIX-AND-GUEST-PAY.md Phase 4.
    const kycRequired = await listingPublishKycRequired(env);
    if (kycRequired === null) return { ok: false, status: 503, body: { error: "identity configuration unavailable" } };
    if (kycRequired) {
      const kycGate = await requireKyc(env, creatorUid);
      if (kycGate) return { ok: false, status: kycGate.status, body: { error: kycGate.error, reason: "kyc" } };
    } else {
      track(env, creatorUid, "listing_publish_kyc_exempt", APP, { listing_id: id, listing_kind: l.kind, ...actorProps });
    }
    if (!l.title || !l.category) return { ok: false, status: 400, body: { error: "title and category required" } };
    // A listing must have a primary image: 1–5 (owner decision 2026-06-11).
    //
    // [POSTER-FIRST-1 2026-09-05] It no longer has to be a PHOTO. The wizard has
    // told creators photos are optional since the auto-poster shipped
    // (`steps.tsx:585`), but this check still demanded one, so a creator with no
    // photo whose generation failed reached the review queue and then hit a dead
    // end at publish with an error the UI had promised would not happen. The
    // generated poster is prepended to cover_media, so in the happy path this
    // already passed — the fix is for the unhappy one. An approved poster now
    // satisfies the requirement explicitly, and the message names both ways out.
    const covers = parseJson(l.cover_media, [] as unknown[]);
    const posterState = (parseJson(l.attrs, {} as any) || {}).poster;
    const hasUsablePoster = !!posterState?.url
      && (posterState.status === "draft" || posterState.status === "approved");
    if ((!Array.isArray(covers) || covers.length < 1) && !hasUsablePoster) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "cover_required",
          detail: "This listing needs a poster or at least one photo before publishing.",
          poster_status: posterState?.status ?? null,
        },
      };
    }
    if (covers.length > 5) return { ok: false, status: 400, body: { error: "max 5 photos", cover_count: covers.length, limit: 5 } };
    const cat = await db.prepare("SELECT 1 FROM listing_categories WHERE id=?1 AND active=1").bind(l.category).first();
    if (!cat) return { ok: false, status: 400, body: { error: "unknown category" } };

    // [MARKET-SECTION-2 2026-08-31] A section whose DELIVERY is switched off
    // cannot be published into. Today that is adda rooms, which need group
    // calling while `conferenceEnabled` is false in production — publishing one
    // would put a bookable ticket on the marketplace for a room nobody can join.
    //
    // Enforced HERE rather than by hiding the category, on purpose: the creator
    // keeps their draft and gets a sentence explaining why, and the listing
    // publishes normally the moment the flag flips. Hiding it would have made
    // the same listing quietly impossible to finish with no explanation.
    const pubSection = sectionFor(l.kind, l.category);
    const blocked = publishBlockedReason(pubSection, await readConfig(env));
    if (blocked) {
      track(env, creatorUid, "listing_publish_section_gated", APP, { listing_id: id, section: pubSection, ...actorProps });
      return { ok: false, status: 409, body: { error: "section_unavailable", section: pubSection, message: blocked } };
    }

    if (!(Number(l.price) >= 0)) return { ok: false, status: 400, body: { error: "bad price" } };

    if (l.kind === "live_event") {
      const start = Number(l.starts_at), dur = Number(l.duration_min);
      if (!(start > Date.now()) || !(dur >= 5 && dur <= 480)) {
        return { ok: false, status: 400, body: { error: "starts_at (future) and duration_min (5–480) required" } };
      }
      // Conflict engine: claim the CREATOR's slot — occupied ⇒ 409 (greyed UX client-side).
      const claim = await claimBlock(env, { userId: creatorUid, sourceApp: APP, sourceRef: id, start, end: start + dur * 60_000, title: String(l.title) });
      if (!claim.ok) return { ok: false, status: 409, body: { error: "conflict", conflictWith: claim.conflict } };
      claimedCreatorSlot = true;
    } else {
      if (!CAPACITIES.has(Number(l.capacity))) return { ok: false, status: 400, body: { error: "capacity must be 1, 10 or 20" } };
      // Consult listings attach to availability_rules — there must be some, and they
      // are the CREATOR's, not the admin's.
      const rules = await db.prepare("SELECT 1 FROM availability_rules WHERE user_id=?1 LIMIT 1").bind(creatorUid).first();
      if (!rules) return { ok: false, status: 409, body: { error: "no_availability", detail: "Set your availability in AvaCalendar before publishing a consult listing." } };
    }
  }

  // [AVA-MKT-ENTITLEMENTS-1] §5 quota + §1.3 charge — the LAST gate before the status
  // flip, and only for marketplace listings (creator services live_event/consult are a
  // different money model and are not metered here). Charged against `creatorUid` —
  // see the file-header note: an admin-triggered publish must never touch the
  // reviewing admin's wallet.
  //
  // ORDERING (§3.3c): moderation → entitlement → status flip. In the classic path,
  // content moderation ran at create/edit time (createListing/updateListing → guardWrite),
  // and all the shape checks above (title/price/photos) have passed — so a listing that
  // would fail those never reaches here, and is never charged. We consume the entitlement
  // immediately BEFORE the UPDATE that flips status='published', so:
  //   • insufficient funds → we return 402 and DO NOT flip status (nothing published,
  //     nothing charged, no entitlement row written — the draft is untouched).
  //   • ok → the flip proceeds; a charged listing always goes live.
  // IDEMPOTENCY: the helper resumes an interrupted operation for the same
  // (listing, period), while a completed restore advances to period 2+ so archive→
  // restore→republish cannot reuse period 1.
  let feeQuote: Awaited<ReturnType<typeof quoteListingEntitlement>> | null = null;
  let feeEntitlement: ListingEntitlementOk | null = null;
  if (isMarket) {
    try {
      feeQuote = await quoteListingEntitlement(env, {
        uid: creatorUid, listingId: id, vertical: String(l.vertical ?? DEFAULT_VERTICAL),
      });
    } catch {
      return { ok: false, status: 503, body: { error: "billing_unavailable", message: "Listing pricing is temporarily unavailable. Try again in a minute." } };
    }
    const ent = await consumeListingEntitlement(env, {
      uid: creatorUid, listingId: id, vertical: String(l.vertical ?? DEFAULT_VERTICAL), period: feeQuote.period,
    });
    if (!ent.ok) {
      if (ent.error === "insufficient_funds") {
        track(env, creatorUid, "listing_publish_insufficient_funds", APP, { listing_id: id, needed: ent.needed, period: feeQuote.period, ...actorProps });
        return { ok: false, status: 402, body: { error: "insufficient_funds", needed: ent.needed, feature: "listing_post", fee: feeQuote } };
      }
      // charge_failed — wallet unreachable/errored. Fail closed like moderation: nothing
      // charged, nothing published, safe to retry.
      track(env, creatorUid, "listing_publish_charge_failed", APP, { listing_id: id, period: feeQuote.period, recovery_required: ent.error === "recovery_required", ...actorProps });
      return { ok: false, status: 503, body: { error: "billing_unavailable", message: "Couldn't complete the listing charge right now, try again in a minute." } };
    }
    feeEntitlement = ent;
    feeQuote = {
      ...feeQuote,
      source: ent.source,
      amount: ent.amount,
      expires_at: ent.expires_at,
      paid_balance: ent.balance,
    };
  }

  const pubNow = Date.now();
  if (isMarket) {
    const finalized = await finalizeListingPublication(env, {
      listingId: id,
      period: feeQuote?.period ?? 0,
      expiresAt: feeQuote?.expires_at ?? (pubNow + 30 * 86_400_000),
      expectedStatus: "approved",
      expectedAuthorityVersion: Number(l.authority_version ?? 0),
      expectedReviewedHash: String(l.reviewed_content_hash),
      now: pubNow,
    });
    if (!finalized) {
      const fresh = await db.prepare("SELECT status FROM listings WHERE id=?1").bind(id).first<{ status: string }>();
      const publicationWon = fresh?.status === "published"
        && await markListingEntitlementPublished(env, { listingId: id });
      if (!publicationWon) {
        track(env, creatorUid, "listing_publish_finalize_failed", APP, { listing_id: id, period: feeQuote?.period ?? null, ...actorProps });
        return { ok: false, status: fresh?.status === "published" ? 503 : 409, body: {
          error: fresh?.status === "published" ? "billing_reconciliation_required" : "publish_conflict",
          published: fresh?.status === "published",
          message: fresh?.status === "published"
            ? "The listing is published while its billing record is being repaired. Retry in a minute."
            : "The listing changed during publication. Reload and retry; the completed entitlement will be reused.",
        } };
      }
    }
  } else {
    const published = await db.prepare(
      `UPDATE listings SET status='published', publication_version=publication_version+1, updated_at=?2
        WHERE id=?1 AND status='approved' AND authority_version=?3 AND reviewed_content_hash=?4`,
    ).bind(id, pubNow, Number(l.authority_version ?? 0), String(l.reviewed_content_hash)).run();
    if (!(published.meta?.changes ?? 0)) {
      if (claimedCreatorSlot) await releaseBlocks(env, APP, id).catch(() => undefined);
      return { ok: false, status: 409, body: {
        error: "publish_conflict", message: "The listing changed during publication. Reload and try again.",
      } };
    }
  }
  let fo: { sent: number; capped: boolean };
  try {
    fo = await ensurePublicationEffects(env, l);
  } catch {
    return { ok: false, status: 503, body: {
      error: "publication_repair_pending",
      published: true,
      message: "The listing is published, but its search and notification updates are still being repaired.",
    } };
  }
  track(env, creatorUid, "listing_published", APP, {
    kind: l.kind, price: l.price, fanout: fo.sent,
    fee_source: feeEntitlement?.source ?? feeQuote?.source ?? null, fee_charged: feeEntitlement?.charged ?? 0,
    fee_period: feeQuote?.period ?? null, ...actorProps,
  });
  return {
    ok: true, status: 200, body: {
      ok: true, status: "published", fanout: fo,
      ...(feeQuote ? {
        fee: {
          source: feeEntitlement?.source ?? feeQuote.source, charged: feeEntitlement?.charged ?? 0, amount: feeQuote.amount,
          funding_policy: feeQuote.funding_policy, period: feeQuote.period,
          free_used: feeQuote.free_used, free_remaining: feeQuote.free_remaining,
          paid_balance: feeQuote.paid_balance, entitlement_expires_at: feeQuote.expires_at,
        },
      } : {}),
    },
  };
}

// POST /api/listings/:id/publish — KYC gate + slot claim (live) / rules check (consult).
// [C03 MKT-PUBLISH-UNIFY-1] Thin HTTP wrapper — all behaviour lives in
// publishListingAuthoritative() above. This is a pure refactor for the creator:
// same auth, same ownership 404, same status codes and response bodies as before.
export async function publishListing(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const result = await publishListingAuthoritative(env, { listingId: id, actor: "creator", actorUid: ctx.uid });
  return json(result.body, result.status);
}

// POST /api/listings/:id/status {status} — owner glue for live|completed|cancelled.
//
// [C01 MKT-STATUS-GATE-1] This used to validate only the TARGET shape and reject a
// SOURCE of 'draft' — every other (from, to) pair reached the raw UPDATE, including
// pending_review/rejected/approved/completed/cancelled -> 'live', which put a
// sellable, joinable listing on the marketplace having skipped publishListing()'s
// KYC/photo/section gates and the entitlement charge (see listing_transitions.ts's
// header for the full writeup). checkTransition() is now the only authority on
// whether (from, to, actor:"creator") is legal; this function no longer branches on
// status strings itself except to run the `to==="draft"` revision's own side effects.
export async function setListingStatus(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const to = String(b.status || "");
  // Shape check only — this endpoint's public contract is still these four targets.
  // Whether (from, to) is actually LEGAL for a creator is checkTransition()'s call,
  // immediately below.
  if (!["live", "completed", "cancelled", "draft"].includes(to)) return json({ error: "status must be live|completed|cancelled|draft" }, 400);
  const db = metaDb(env);
  const l = await db.prepare("SELECT creator_id, status, title, kind, authority_version FROM listings WHERE id=?1").bind(id).first<any>();
  if (!l || l.creator_id !== ctx.uid) return json({ error: "not found" }, 404);

  const check = checkTransition(String(l.status), to, "creator");
  if (!check.ok) {
    // Covers, among others, the one wrong answer this whole change exists to
    // prevent: `to==='live'` is refused for EVERY creator request now (reason
    // "live_is_provider_confirmed") — only systemMarkListingLive() below, called
    // once a media provider has actually confirmed the broadcast, may set it.
    track(env, ctx.uid, "listing_status_transition_refused", APP, {
      listing_id: id, from: l.status, to, reason: check.reason, actor: "creator",
    });
    return json({
      error: "transition_not_allowed", reason: check.reason,
      status_now: l.status, allowed_targets: check.allowedTargets,
    }, 409);
  }

  if (to === "draft") {
    // Revision + archive-restore path. checkTransition above narrowed this to the
    // table's three creator rows targeting 'draft': rejected (a revision) and
    // cancelled/completed (restoring an archived listing to reuse it). The source
    // statuses it now REFUSES are the ones that were the bug — published -> draft
    // and pending_review/approved -> draft used to work here with no source check.
    // Per listing_transitions.ts's header this IS a revision: the caller must force
    // a fresh pending_review on the next submit; this endpoint only owns the STATUS
    // move + the marketplace entitlement reconciliation, exactly as it did before.
    //
    // Rejected, cancelled and completed each have an explicit creator->draft row
    // in the transition table. Published/live cannot use this endpoint as an
    // unpublish shortcut.
    if (MARKET_KINDS.has(String(l.kind))) {
      const reconciled = await markListingEntitlementPublished(env, { listingId: id });
      if (!reconciled) return json({ error: "billing_unavailable", message: "The listing entitlement could not be reconciled. Try again shortly." }, 503);
    }
    // Conditional UPDATE — WHERE status=<the status checkTransition validated
    // against> — so a concurrent edit between the read above and this write can't
    // silently apply a transition that was authorized against a status that has
    // since changed. 0 rows changed = a real conflict, not a no-op.
    const res = await db.prepare(
      "UPDATE listings SET status='draft', expires_at=NULL, updated_at=?2 WHERE id=?1 AND status=?3 AND authority_version=?4",
    ).bind(id, Date.now(), l.status, Number(l.authority_version ?? 0)).run();
    if (!(res.meta?.changes ?? 0)) {
      return json({ error: "conflict", message: "This listing's status changed before the request completed." }, 409);
    }
    await ftsSync(env, id, true);
    track(env, ctx.uid, "listing_restored", APP, {});
    return json({ ok: true, status: "draft" });
  }

  const res = await db.prepare(
    "UPDATE listings SET status=?2, updated_at=?3 WHERE id=?1 AND status=?4 AND authority_version=?5",
  ).bind(id, to, Date.now(), l.status, Number(l.authority_version ?? 0)).run();
  if (!(res.meta?.changes ?? 0)) {
    return json({ error: "conflict", message: "This listing's status changed before the request completed." }, 409);
  }
  void partyEmit(env, `listing:${id}`, { t: "listing_update", status: to }); // #8: live SOLD/status change
  if (to === "cancelled" || to === "completed") { await releaseBlocks(env, APP, id); await ftsSync(env, id, true); }
  // NOTE: `to === "live"` can no longer reach this line — checkTransition() above
  // refuses it unconditionally for actor "creator". The "is LIVE now" fanout that
  // used to fire here on the (now-closed) creator->live bypass moved to
  // systemMarkListingLive() below, which is the provider-confirmed replacement.
  track(env, ctx.uid, "listing_status_changed", APP, { to });
  return json({ ok: true, status: to });
}

// [C01 MKT-STATUS-GATE-1] The ONLY function allowed to flip a listing published ->
// live. `live` is provider-confirmed per listing_transitions.ts (system actor only,
// `requires: "provider_confirmed"`) — this function does not itself confirm
// anything with a media provider; the CALLER must already know the provider
// confirmed the broadcast actually started before calling this. It carries the
// follower "is LIVE now" fanout that setListingStatus used to fire on the creator's
// (now-closed) direct live request — see the NOTE in setListingStatus above.
//
// TODO(wiring): the real caller is `recordCommercialStreamEvent()` in
// worker/src/routes/commercial_stream_sessions.ts, in its `session_started` /
// `live_started` webhook branch (around line 1666-1675 there, the
// `UPDATE commercial_sessions SET state='live', ... WHERE ... state IN
// ('scheduled','backstage','live')` statement) — THAT is the actual moment GetStream
// confirms the broadcast is live. Call `systemMarkListingLive(env, session.listing_id)`
// right after that UPDATE succeeds (only for `session.kind === "live_event"`; a
// consult booking has no marketplace "live" listing state to flip). Do NOT call this
// from `commercialLiveGoLive()` (commercial_stream_sessions.ts:1157) — that endpoint
// only REQUESTS go-live and hands off to the provider; at that point nothing has
// confirmed the broadcast is actually running yet.
export async function systemMarkListingLive(env: Env, listingId: string): Promise<{ ok: boolean; reason?: string }> {
  const db = metaDb(env);
  const row = await db.prepare(
    "SELECT status,title,creator_id,kind,authority_version,publication_version FROM listings WHERE id=?1",
  ).bind(listingId).first<any>();
  if (!row) return { ok: false, reason: "not_found" };

  if (String(row.status) === "published") {
    const check = checkTransition("published", "live", "system");
    if (!check.ok) return { ok: false, reason: check.reason };
    const res = await db.prepare(
      "UPDATE listings SET status='live', updated_at=?2 WHERE id=?1 AND status='published' AND authority_version=?3",
    ).bind(listingId, Date.now(), Number(row.authority_version ?? 0)).run();
    if (!(res.meta?.changes ?? 0)) return { ok: false, reason: "conflict" };
    void partyEmit(env, `listing:${listingId}`, { t: "listing_update", status: "live" });
  } else if (String(row.status) !== "live") {
    return { ok: false, reason: "transition_not_allowed" };
  }

  // The fan-out has its own durable id. A webhook replay or cron repair resumes
  // an unfinished projection without creating a second feed row or push.
  const who = await nameOf(env, String(row.creator_id));
  const fo = await fanout(
    env, String(row.creator_id), `${who} is LIVE now`,
    String(row.title ?? "").slice(0, 60), `/explore/listing/${listingId}`,
    { eventId: `listing:${listingId}:live:${Number(row.publication_version ?? 0)}`, listingId, eventType: "live" },
  );
  track(env, String(row.creator_id), "listing_status_changed", APP, {
    to: "live", actor: "system", fanout: fo.sent,
  });
  return { ok: true };
}

export async function systemMarkListingCompleted(
  env: Env,
  listingId: string,
): Promise<{ ok: boolean; reason?: string }> {
  const db = metaDb(env);
  const row = await db.prepare(
    "SELECT status,creator_id,authority_version,publication_version FROM listings WHERE id=?1",
  ).bind(listingId).first<any>();
  if (!row) return { ok: false, reason: "not_found" };
  if (String(row.status) === "live") {
    const check = checkTransition("live", "completed", "system");
    if (!check.ok) return { ok: false, reason: check.reason };
    const res = await db.prepare(
      "UPDATE listings SET status='completed', updated_at=?2 WHERE id=?1 AND status='live' AND authority_version=?3",
    ).bind(listingId, Date.now(), Number(row.authority_version ?? 0)).run();
    if (!(res.meta?.changes ?? 0)) return { ok: false, reason: "conflict" };
  } else if (String(row.status) !== "completed") {
    return { ok: false, reason: "transition_not_allowed" };
  }

  await releaseBlocks(env, APP, listingId);
  await ftsSync(env, listingId, true);
  await db.prepare(
    `INSERT INTO listing_fanout_events
     (event_id,listing_id,event_type,state,created_at,updated_at,sent_at)
     VALUES (?1,?2,'completed_effects','sent',?3,?3,?3)
     ON CONFLICT(event_id) DO UPDATE SET state='sent',updated_at=excluded.updated_at,sent_at=excluded.sent_at`,
  ).bind(`listing:${listingId}:completed-effects:${Number(row.publication_version ?? 0)}`, listingId, Date.now()).run();
  void partyEmit(env, `listing:${listingId}`, { t: "listing_update", status: "completed" });
  track(env, String(row.creator_id ?? "system"), "listing_status_changed", APP, {
    to: "completed", actor: "system",
  });
  return { ok: true };
}

export async function reconcileListingPublicationEffects(
  env: Env,
  limit = 25,
): Promise<{ scanned: number; repaired: number }> {
  const rows = await metaDb(env).prepare(
    `SELECT l.*
       FROM listings l
       LEFT JOIN listing_fanout_events e
         ON e.event_id=('listing:' || l.id || ':published:' || COALESCE(l.publication_version,0))
      WHERE l.status IN ('published','live') AND COALESCE(e.state,'pending')<>'sent'
      ORDER BY l.updated_at ASC LIMIT ?1`,
  ).bind(Math.max(1, Math.min(100, Math.trunc(limit)))).all<any>();
  let repaired = 0;
  for (const row of rows.results ?? []) {
    try {
      await ensurePublicationEffects(env, row);
      repaired++;
    } catch {
      // Leave the event pending; the next scheduled pass retries it.
    }
  }

  // A Worker interruption during image generation must not leave the admin UI
  // permanently refusing regeneration. Reset stale attempts to a retryable failure.
  const stalePosters = await metaDb(env).prepare(
    `SELECT id,attrs,authority_version FROM listings
      WHERE status='pending_review'
        AND json_extract(attrs,'$.poster.status')='generating'
        AND CAST(json_extract(attrs,'$.poster.generated_at') AS INTEGER)<=?1
      ORDER BY updated_at ASC LIMIT ?2`,
  ).bind(Date.now() - 15 * 60_000, Math.max(1, Math.min(100, Math.trunc(limit)))).all<any>();
  for (const row of stalePosters.results ?? []) {
    const attrs = parseJson<Record<string, any>>(row.attrs, {});
    if (attrs.poster?.status !== "generating") continue;
    attrs.poster = {
      ...attrs.poster,
      status: "failed",
      error: "Poster generation was interrupted. Regenerate to try again.",
    };
    const reset = await metaDb(env).prepare(
      "UPDATE listings SET attrs=?2,updated_at=?3 WHERE id=?1 AND status='pending_review' AND authority_version=?4",
    ).bind(row.id, JSON.stringify(attrs), Date.now(), Number(row.authority_version ?? 0)).run();
    if (reset.meta?.changes) repaired++;
  }
  return {
    scanned: (rows.results ?? []).length + (stalePosters.results ?? []).length,
    repaired,
  };
}

export async function reconcileListingLifecycleProjections(
  env: Env,
  limit = 25,
): Promise<{ scanned: number; repaired: number }> {
  const rows = await metaDb(env).prepare(
    `SELECT s.listing_id,s.state,l.status
       FROM commercial_sessions s
       JOIN listings l ON l.id=s.listing_id
       LEFT JOIN listing_fanout_events live_event
         ON live_event.event_id=('listing:' || s.listing_id || ':live:' || COALESCE(l.publication_version,0))
       LEFT JOIN listing_fanout_events completed_event
         ON completed_event.event_id=('listing:' || s.listing_id || ':completed-effects:' || COALESCE(l.publication_version,0))
      WHERE s.kind='live_event'
        AND ((s.state='live' AND (l.status='published' OR (l.status='live' AND COALESCE(live_event.state,'pending')<>'sent')))
          OR (s.state='ended' AND (l.status='live' OR (l.status='completed' AND COALESCE(completed_event.state,'pending')<>'sent'))))
      ORDER BY s.updated_at ASC LIMIT ?1`,
  ).bind(Math.max(1, Math.min(100, Math.trunc(limit)))).all<any>();
  let repaired = 0;
  for (const row of rows.results ?? []) {
    const result = row.state === "live"
      ? await systemMarkListingLive(env, String(row.listing_id))
      : await systemMarkListingCompleted(env, String(row.listing_id));
    if (result.ok) repaired++;
  }
  return { scanned: (rows.results ?? []).length, repaired };
}

// POST /api/listings/:id/duplicate — A6: copy everything, clear date/slot, draft.
export async function duplicateListing(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const db = metaDb(env);
  const l = await db.prepare("SELECT * FROM listings WHERE id=?1").bind(id).first<any>();
  if (!l || l.creator_id !== ctx.uid) return json({ error: "not found" }, 404);
  const nid = crypto.randomUUID();
  const now = Date.now();
  // [AVA-MKT-VERT-1] The copy carries `vertical` — omitting it would silently re-home a
  // connect listing into commerce via the column DEFAULT, i.e. the exact cross-vertical
  // leak §2.0 calls absolute, through the one path nobody would think to check.
  //
  // Versions are RE-PINNED to the category's CURRENT triple, not copied from the source.
  // §2.4 is "every listing pins the versions it was BORN with", and this listing is born
  // now: copying a stale pin would create a brand-new listing already frozen to a schema
  // and playbook that were retired before it existed. attrs comes along (the whole point
  // of a duplicate) and is re-validated against the new pin on the next PUT.
  const dupVersions = await catVersions(env, String(l.category ?? ""));
  await db.prepare(
    `INSERT INTO listings (id, creator_id, kind, title, description, category, price, currency_display,
       country, adults_only, badges, cover_media, starts_at, duration_min, capacity, translation_enabled, spoken_lang, status, created_at, updated_at,
       vertical, attrs, video_url, cat_version, playbook_version, template_version, section)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,NULL,?13,?14,?15,?16,'draft',?17,?17,?18,?19,?20,?21,?22,?23,?24)`,
  ).bind(nid, ctx.uid, l.kind, l.title, l.description, l.category, l.price, l.currency_display,
    l.country, l.adults_only, l.badges, l.cover_media, l.duration_min, l.capacity,
    l.translation_enabled ?? 0, l.spoken_lang ?? null, now,
    l.vertical ?? DEFAULT_VERTICAL, l.attrs ?? null, l.video_url ?? null,
    dupVersions?.cat ?? 1, dupVersions?.playbook ?? 1, dupVersions?.template ?? 1,
    // [MARKET-SECTION-1] RE-RESOLVED, not copied from the source row. Same
    // reasoning as the version pins just above: this is a newly born listing, so
    // it gets today's answer to (kind, category) rather than inheriting one that
    // may predate a change to the mapping.
    sectionFor(l.kind, l.category)).run();
  track(env, ctx.uid, "listing_duplicated", APP, { vertical: l.vertical ?? DEFAULT_VERTICAL });
  return json({ ok: true, listing_id: nid });
}

/**
 * [CARD-SLOTS-1] POST /api/listings/:id/repeat  { weeks: 1..12 }
 *
 * "Repeat this weekly for N weeks" → N NEW DRAFTS, each a standalone bookable event with
 * its own starts_at, sharing a `series_id` with the source.
 *
 * WHY DRAFTS AND NOT PUBLISHED. Publishing claims a calendar block and can conflict
 * (claimBlock → 409). Publishing N at once would either fail halfway, leaving a partly
 * created series with no obvious repair, or need a transaction across N calendar claims
 * that D1 will not give us. Each copy goes through the normal publish path, one at a
 * time, where a clash is a thing the creator can see and move.
 *
 * WHY NOT `listing_sessions`. See the migration. One listing is one event; this groups
 * copies, it does not introduce a second grain.
 *
 * live_event only — a consult has no fixed start to shift; its recurrence is
 * availability_rules in AvaCalendar, which already exists.
 */
export async function repeatListing(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as { weeks?: unknown };
  const weeks = Math.trunc(Number(b.weeks));
  // Bounded because each week is a row, a calendar claim and a card. Twelve is a quarter.
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 12) {
    return json({ error: "weeks must be a whole number from 1 to 12" }, 400);
  }
  const db = metaDb(env);
  const l = await db.prepare("SELECT * FROM listings WHERE id=?1").bind(id).first<any>();
  if (!l || l.creator_id !== ctx.uid) return json({ error: "not found" }, 404);
  if (l.kind !== "live_event") {
    return json({ error: "only live events repeat", detail: "A consult repeats through your availability in AvaCalendar." }, 400);
  }
  const baseStart = Number(l.starts_at);
  if (!Number.isFinite(baseStart) || baseStart <= 0) {
    return json({ error: "set a start date and time before repeating" }, 400);
  }

  // The source joins its own series so "cancel the series" includes the original. An
  // existing series_id is reused, so repeating twice extends one series instead of
  // fragmenting it into two that look identical to the creator.
  const seriesId = String(l.series_id ?? `series:${id}`);
  const now = Date.now();
  const versions = await catVersions(env, String(l.category ?? ""));
  const created: string[] = [];
  const WEEK_MS = 7 * 86_400_000;

  for (let i = 1; i <= weeks; i++) {
    const nid = crypto.randomUUID();
    // Plain 7-day arithmetic on a UTC epoch. India has no DST, which is the only market
    // (see the "no company" section of CLAUDE.md), so a fixed week is exactly a week and
    // the local clock time is preserved. Revisit if a DST market is ever added — there
    // the honest version shifts the local calendar date, not the epoch.
    const startsAt = baseStart + i * WEEK_MS;
    await db.prepare(
      `INSERT INTO listings (id, creator_id, kind, title, description, category, price, currency_display,
         country, adults_only, badges, cover_media, starts_at, duration_min, capacity, translation_enabled,
         spoken_lang, location, status, created_at, updated_at,
         vertical, attrs, video_url, cat_version, playbook_version, template_version, series_id, section)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,'draft',?19,?19,?20,?21,?22,?23,?24,?25,?26,?27)`,
    ).bind(nid, ctx.uid, l.kind, l.title, l.description, l.category, l.price, l.currency_display,
      l.country, l.adults_only, l.badges, l.cover_media, startsAt, l.duration_min, l.capacity,
      l.translation_enabled ?? 0, l.spoken_lang ?? null, l.location ?? null, now,
      l.vertical ?? DEFAULT_VERTICAL, l.attrs ?? null, l.video_url ?? null,
      versions?.cat ?? 1, versions?.playbook ?? 1, versions?.template ?? 1, seriesId,
      // [MARKET-SECTION-1] Same (kind, category) for every slot in the series,
      // so a weekly repeat cannot scatter itself across sections.
      sectionFor(l.kind, l.category)).run();
    created.push(nid);
  }
  // Stamp the source last: if the loop threw partway, the source is untouched and the
  // creator sees exactly the copies that were made rather than an empty series header.
  await db.prepare("UPDATE listings SET series_id=?2, updated_at=?3 WHERE id=?1 AND creator_id=?4")
    .bind(id, seriesId, now, ctx.uid).run();

  track(env, ctx.uid, "listing_repeated", APP, { weeks, series_id: seriesId, created: created.length });
  return json({ ok: true, series_id: seriesId, listing_ids: created, weeks });
}

// DELETE /api/listings/:id — cancel + release the slot.
export async function cancelListing(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const db = metaDb(env);
  const l = await db.prepare(
    "SELECT creator_id,cover_media,status,authority_version FROM listings WHERE id=?1",
  ).bind(id).first<any>();
  if (!l || l.creator_id !== ctx.uid) return json({ error: "not found" }, 404);
  const permanent = new URL(req.url).searchParams.get("permanent") === "true";
  if (permanent) {
    // DELETE CASCADE — remove the listing from every side: search index, slot
    // blocks, negotiation ledger, R2 cover media (best-effort), then the D1 row
    // (the source of truth). AI Search de-index hooks here once that binding lands.
    await ftsSync(env, id, true).catch(() => {});
    await releaseBlocks(env, APP, id).catch(() => {});
    try {
      const covers = parseJson(l.cover_media, [] as any[]);
      for (const c of Array.isArray(covers) ? covers : []) {
        const url = String((c && (c as any).url) || "");
        const key = url.split("/").filter(Boolean).pop();
        if (key) await (env as any).BLOBS?.delete(key).catch(() => {});
      }
    } catch { /* media best-effort */ }
    try { await db.prepare("DELETE FROM mkt_negotiations WHERE listing_id=?1").bind(id).run(); } catch { /* table may not exist */ }
    await db.prepare("DELETE FROM listings WHERE id=?1").bind(id).run();
    track(env, ctx.uid, "listing_deleted_permanent", APP, {});
    return json({ ok: true, deleted: true });
  }
  // Soft remove follows the same creator transition authority as the status API.
  const transition = checkTransition(String(l.status), "cancelled", "creator");
  if (!transition.ok) {
    return json({ error: "transition_not_allowed", reason: transition.reason, status_now: l.status }, 409);
  }
  const cancelled = await db.prepare(
    "UPDATE listings SET status='cancelled', updated_at=?2 WHERE id=?1 AND status=?3 AND authority_version=?4",
  ).bind(id, Date.now(), l.status, Number(l.authority_version ?? 0)).run();
  if (!(cancelled.meta?.changes ?? 0)) {
    return json({ error: "conflict", message: "This listing changed before it could be archived." }, 409);
  }
  // [LIST-ERR-SURFACE-1 2026-09-05] These run AFTER the status write has already
  // committed, so a throw here used to turn a SUCCESSFUL archive into a 500 —
  // the creator saw "could not remove", retried, and the retry then failed with
  // `noop_transition` because the listing really was already cancelled. The
  // permanent-delete branch above has always guarded both with `.catch(() => {})`
  // for exactly this reason; the soft path was the odd one out.
  //
  // Failures are logged rather than swallowed silently: an unreleased calendar
  // block or a stale FTS row is a real (recoverable) problem worth seeing, it is
  // just not a reason to tell the creator their archive did not happen.
  await releaseBlocks(env, APP, id).catch((e) => {
    console.error("listing_cancel_release_blocks_failed", { listing_id: id, error: String((e as any)?.message || e) });
  });
  await ftsSync(env, id, true).catch((e) => {
    console.error("listing_cancel_fts_sync_failed", { listing_id: id, error: String((e as any)?.message || e) });
  });
  return json({ ok: true });
}

// GET /api/listings/mine — the creator's own listings, all statuses.
export async function myListings(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  // [AVA-MKT-VERT-1] §2.0 — My Listings is vertical-scoped like every other listing
  // read. Each vertical has its own menu and its own My Listings; one user's Connect
  // profile must not appear in their commerce list. Absent ?vertical ⇒ commerce.
  const vertical = vertOf(new URL(req.url).searchParams.get("vertical"));
  const rs = await metaSession(env).prepare(
    `${CARD_SELECT} WHERE l.creator_id=?1 AND l.vertical=?2 ORDER BY l.updated_at DESC LIMIT 100`,
  ).bind(ctx.uid, vertical).all();
  const rows = (rs.results ?? []) as any[];
  const promos = await promosFor(env, rows.map((r) => r.id));
  const cardStats = await cardStatsFor(env, rows.map((r) => r.id));
  const favs = await favoritesFor(env, ctx.uid, rows.map((r) => String(r.id))); // [UI-MKT-3]
  // [FREE-ENTRY-GATE-1] Per-user capability so the wizard can show/hide the
  // "free show" control for the person actually asking, instead of reading
  // the public config flag (which is the same for every visitor and hid the
  // checkbox from admins/allowlisted testers too).
  const cfg = await readConfig(env);
  const freeEntry = freeEntryAllowed(env, cfg, ctx.uid);
  return json({ listings: rows.map((r) => shapeCard(r, promos, favs, cardStats)), free_entry_allowed: freeEntry });
}

// ---------------------------------------------------------------------------
// A5 promotions
// ---------------------------------------------------------------------------

export async function listingPromotions(req: Request, env: Env, id: string): Promise<Response> {
  if (req.method === "GET") {
    const rs = await metaSession(env).prepare(
      "SELECT id, kind, pct_off, code, max_uses, used, ends_at FROM listing_promotions WHERE listing_id=?1",
    ).bind(id).all();
    return json({ promotions: rs.results ?? [] });
  }
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const own = await metaDb(env).prepare("SELECT creator_id FROM listings WHERE id=?1").bind(id).first<any>();
  if (!own || own.creator_id !== ctx.uid) return json({ error: "not found" }, 404);
  const b = (await req.json().catch(() => ({}))) as any;
  const kind = String(b.kind || "");
  const pct = Math.trunc(Number(b.pct_off));
  if (!["early_bird", "promo_code"].includes(kind)) return json({ error: "kind must be early_bird|promo_code" }, 400);
  if (!(pct >= 1 && pct <= 100)) return json({ error: "pct_off 1–100 required" }, 400);
  const code = kind === "promo_code" ? String(b.code || "").trim().toUpperCase() : null;
  if (kind === "promo_code" && !code) return json({ error: "code required" }, 400);
  const pid = crypto.randomUUID();
  await metaDb(env).prepare(
    "INSERT INTO listing_promotions (id, listing_id, kind, pct_off, code, max_uses, used, ends_at) VALUES (?1,?2,?3,?4,?5,?6,0,?7)",
  ).bind(pid, id, kind, pct, code, b.max_uses ? Math.trunc(Number(b.max_uses)) : null, b.ends_at ? Math.trunc(Number(b.ends_at)) : null).run();
  track(env, ctx.uid, "listing_promo_created", APP, { kind, pct });
  return json({ ok: true, promotion_id: pid });
}

export async function deletePromotion(req: Request, env: Env, id: string, pid: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const own = await metaDb(env).prepare("SELECT creator_id FROM listings WHERE id=?1").bind(id).first<any>();
  if (!own || own.creator_id !== ctx.uid) return json({ error: "not found" }, 404);
  await metaDb(env).prepare("DELETE FROM listing_promotions WHERE id=?1 AND listing_id=?2").bind(pid, id).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// marketplace reads (public — guest browsing, A3)
// ---------------------------------------------------------------------------

export async function exploreCategories(env: Env): Promise<Response> {
  // [MKT-3GROUP-1] spec §2 — group_id added so the marketplace's three-group
  // blips can be rendered from the server's own answer instead of each client
  // re-deriving (category -> section -> group) on its own. NULL for
  // marketplace-goods categories (cars, property, mobiles, …), which are a
  // different product and untouched by this change.
  const rs = await metaSession(env).prepare(
    "SELECT id, label, emoji, group_id FROM listing_categories WHERE active=1 ORDER BY sort",
  ).all();
  return json({ categories: rs.results ?? [] });
}

/** WHERE fragment hiding listings from creators the (authed) caller blocked. */
function blockFilter(uid: string | null, binds: unknown[], where: string[]): void {
  if (!uid) return;
  binds.push(uid);
  where.push(`l.creator_id NOT IN (SELECT blocked_uid FROM blocks WHERE uid=?${binds.length})`);
}

// GET /api/explore?kind=&category=&country=&cursor=&limit=
export async function exploreBrowse(req: Request, env: Env): Promise<Response> {
  const uid = await maybeUid(req, env);
  const u = new URL(req.url).searchParams;
  const where = ["l.status IN ('published','live')"];
  const binds: unknown[] = [];
  // Hide expired marketplace listings (creator listings have no expiry → null shows).
  binds.push(Date.now());
  where.push(`(l.expires_at IS NULL OR l.expires_at > ?${binds.length})`);
  // [AVA-MKT-VERT-1] §2.0 — the cross-vertical rule, on the main browse. Defaults to
  // commerce, so today's callers (which send no ?vertical) see today's rows.
  const vertical = verticalFilter(req, binds, where);
  for (const [k, col] of [["kind", "l.kind"], ["category", "l.category"], ["country", "l.country"]] as const) {
    const v = u.get(k);
    if (v) { binds.push(v); where.push(`${col}=?${binds.length}`); }
  }
  // [MARKET-SECTION-1] ?section= — the bazaar sidebar's category filter. Validated
  // against the closed SECTIONS list rather than bound blind, so an unknown value
  // is IGNORED (the visitor sees everything) instead of matching nothing and
  // rendering an empty bazaar that looks broken.
  const section = u.get("section");
  if (isSection(section)) { binds.push(section); where.push(`l.section=?${binds.length}`); }
  const creator = u.get("creator");
  if (creator) { binds.push(creator); where.push(`l.creator_id=?${binds.length}`); }
  // AvaMarketplace-only view (buy/sell/social), excludes creator services.
  if (u.get("market") === "1") where.push("l.kind IN ('sell','buy','social')");
  blockFilter(uid, binds, where);
  // [MARKET-SECTION-1] ?sort= on browse, matching exploreSearch's vocabulary so
  // the two endpoints don't disagree about what "cheapest" means. The default is
  // unchanged (live first, then soonest), so existing callers see today's order.
  const sort = u.get("sort") || "";
  const order = sort === "cheapest" ? "l.price ASC"
    : sort === "popular" ? "l.joined_count DESC"
    : sort === "rating" ? "COALESCE(l.rating_avg,0) DESC, l.rating_count DESC"
    : sort === "newest" ? "l.created_at DESC"
    : "(l.status='live') DESC, COALESCE(l.starts_at, 4102444800000) ASC";
  const limit = Math.min(50, Math.max(1, Number(u.get("limit") || 20)));
  const offset = Math.max(0, Number(u.get("cursor") || 0));
  const rs = await metaSession(env).prepare(
    `${CARD_SELECT} WHERE ${where.join(" AND ")}
      ORDER BY ${order}, l.created_at DESC
      LIMIT ${limit + 1} OFFSET ${offset}`,
  ).bind(...binds).all();
  const rows = (rs.results ?? []) as any[];
  const page = rows.slice(0, limit);
  const promos = await promosFor(env, page.map((r) => r.id));
  const cardStats = await cardStatsFor(env, page.map((r) => r.id));
  const favs = await favoritesFor(env, uid, page.map((r) => String(r.id))); // [UI-MKT-3] hydrate heart state per fetch
  trackImpressions(env, req, uid, APP, "explore", page.map((r) => String(r.id)));

  // [MARKET-SECTION-1] Per-section totals for the marketplace sidebar.
  //
  // These are CATALOGUE counts, not page counts, and that distinction is the
  // reason this query exists at all: the rail used to count the listings the
  // browser happened to have fetched, so "Consulting 0" meant "none on this
  // page", which is a different claim from "none exist" and looked like a bug
  // the moment pagination kicked in.
  //
  // Deliberately counted WITHOUT the ?section= predicate — a sidebar that zeroes
  // out every other row the moment you pick one row is a dead end with no way
  // back. `sectionCounts` is omitted entirely if the query fails (e.g. before
  // the migration lands) so the client falls back rather than showing zeroes.
  const sectionCounts = await sectionCountsFor(env, req, uid);

  return json({
    vertical,
    section: isSection(section) ? section : null,
    section_counts: sectionCounts,
    listings: page.map((r) => shapeCard(r, promos, favs, cardStats)),
    cursor: rows.length > limit ? String(offset + limit) : null,
  });
}

/**
 * [MARKET-SECTION-1] `{ section: count }` over every published listing in the
 * caller's vertical. Every section in SECTIONS is present, zero included, so the
 * client never has to distinguish "absent" from "none".
 *
 * Returns null on any failure. That is the point: this powers a decorative
 * count beside a filter name, and it must never be the reason a marketplace
 * page 500s.
 */
async function sectionCountsFor(env: Env, req: Request, uid: string | null): Promise<Record<string, number> | null> {
  try {
    const where = ["l.status IN ('published','live')"];
    const binds: unknown[] = [];
    binds.push(Date.now());
    where.push(`(l.expires_at IS NULL OR l.expires_at > ?${binds.length})`);
    verticalFilter(req, binds, where);
    blockFilter(uid, binds, where);
    const rs = await metaSession(env).prepare(
      `SELECT l.section AS section, COUNT(*) AS n FROM listings l WHERE ${where.join(" AND ")} GROUP BY l.section`,
    ).bind(...binds).all();
    const out: Record<string, number> = {};
    for (const s of SECTIONS) out[s] = 0;
    for (const r of ((rs.results ?? []) as any[])) {
      const k = String(r.section ?? "");
      if (k in out) out[k] = Number(r.n ?? 0);
    }
    return out;
  } catch {
    return null;
  }
}

// GET /api/explore/live-now — the red-dot rail.
export async function exploreLiveNow(req: Request, env: Env): Promise<Response> {
  const uid = await maybeUid(req, env);
  const where = ["l.status='live'"];
  const binds: unknown[] = [];
  // [AVA-MKT-VERT-1] §2.0 — the live rail is a listing read like any other, and it is
  // the one that renders unbidden at the top of the shell. Defaults to commerce.
  const vertical = verticalFilter(req, binds, where);
  blockFilter(uid, binds, where);
  const rs = await metaSession(env).prepare(
    `${CARD_SELECT} WHERE ${where.join(" AND ")} ORDER BY l.joined_count DESC LIMIT 25`,
  ).bind(...binds).all();
  const rows = (rs.results ?? []) as any[];
  const promos = await promosFor(env, rows.map((r) => r.id));
  const cardStats = await cardStatsFor(env, rows.map((r) => r.id));
  const favs = await favoritesFor(env, uid, rows.map((r) => String(r.id))); // [UI-MKT-3]
  trackImpressions(env, req, uid, APP, "live_now", rows.map((r) => String(r.id)));
  return json({ vertical, listings: rows.map((r) => ({ ...shapeCard(r, promos, favs, cardStats), joinable: true })) });
}

// GET /api/explore/search — A1: FTS5 + filters + sorts; partial title AND creator name hit.
export async function exploreSearch(req: Request, env: Env): Promise<Response> {
  const uid = await maybeUid(req, env);
  const u = new URL(req.url).searchParams;
  const q = (u.get("q") || "").trim();
  const where = ["l.status IN ('published','live')"];
  const binds: unknown[] = [];

  // -------------------------------------------------------------------------
  // [AVA-MKT-VERT-1] §2.0 — "search (ftsSync included)" is vertical-scoped, and this
  // ONE predicate is what enforces it. Why that is sufficient, verified rather than
  // assumed, because "a Connect profile must never surface in a commerce search" is a
  // §2.6 safety requirement and not a UX preference:
  //
  // `listings_fts` has no `vertical` column (it is title/description/creator_name/
  // category only — see ftsSync), so FTS on its own CANNOT scope by vertical. But the
  // search below is TWO-PHASE: phase 1 asks FTS for candidate ids, phase 2 re-queries
  // the MAIN `listings` table with `l.id IN (<those ids>)` AND every predicate in this
  // WHERE. FTS never returns a row to the caller — it only nominates ids, and each
  // nominee must survive `l.vertical=?` on the real table to be shaped into a card.
  // A connect listing nominated by FTS is therefore dropped in phase 2. Confirmed by
  // reading the phase-2 query: it is `${CARD_SELECT} WHERE ${where.join(" AND ")}`, so
  // this predicate is unconditionally ANDed onto the id filter. No FTS migration needed.
  //
  // The one real cost, and it is RECALL, not leakage: phase 1 is `LIMIT 200`, applied
  // before we know anything about verticals. Once connect has volume, a query whose top
  // 200 FTS hits are mostly connect rows yields fewer commerce cards than it should —
  // never wrong rows, just thin pages. The fix when that bites is a `vertical` column on
  // listings_fts (a migration + a ftsSync write), not a change here.
  // -------------------------------------------------------------------------
  const vertical = verticalFilter(req, binds, where);

  const isMarket = u.get("market") === "1";
  if (q) {
    const tokens = q.toLowerCase().replace(/[^a-z0-9\s@_-]/g, " ").split(/\s+/).filter(Boolean).slice(0, 6);
    if (tokens.length) {
      // Marketplace search uses OR for broad recall (any keyword matches);
      // creator search keeps AND for precision. Marketplace also restricts the
      // FTS match to the listing's own content columns so a seller's *name*
      // can't spuriously match a product query (e.g. "car" hitting "John Carter").
      const joined = tokens.map((t) => `"${t.replace(/"/g, "")}"*`).join(isMarket ? " OR " : " ");
      const match = isMarket ? `{title description category} : (${joined})` : joined;
      const ids = await metaSession(env).prepare(
        "SELECT listing_id FROM listings_fts WHERE listings_fts MATCH ?1 LIMIT 200",
      ).bind(match).all();
      const idList = ((ids.results ?? []) as any[]).map((r) => String(r.listing_id));
      // [MARKET-SECTION-1] section_counts on the no-hits path too — the sidebar
      // is still on screen when a search finds nothing, and blanking its counts
      // there is exactly when a visitor is deciding whether the site is broken.
      if (!idList.length) {
        return json({ vertical, section: null, section_counts: await sectionCountsFor(env, req, uid), listings: [], cursor: null });
      }
      where.push(`l.id IN (${idList.map((_, i) => `?${binds.length + i + 1}`).join(",")})`);
      binds.push(...idList);
    }
  }
  for (const [k, col] of [["kind", "l.kind"], ["category", "l.category"], ["country", "l.country"]] as const) {
    const v = u.get(k);
    if (v) { binds.push(v); where.push(`${col}=?${binds.length}`); }
  }
  // [MARKET-SECTION-1] Same closed-list validation as exploreBrowse: an unknown
  // ?section= is ignored rather than matching nothing.
  const section = u.get("section");
  if (isSection(section)) { binds.push(section); where.push(`l.section=?${binds.length}`); }
  const minPrice = Number(u.get("minPrice") || -1), maxPrice = Number(u.get("maxPrice") || -1);
  if (minPrice >= 0) { binds.push(minPrice); where.push(`l.price >= ?${binds.length}`); }
  if (maxPrice >= 0) { binds.push(maxPrice); where.push(`l.price <= ?${binds.length}`); }
  const from = Number(u.get("from") || 0), to = Number(u.get("to") || 0);
  if (from > 0) { binds.push(from); where.push(`l.starts_at >= ?${binds.length}`); }
  if (to > 0) { binds.push(to); where.push(`l.starts_at <= ?${binds.length}`); }
  const minRating = Number(u.get("minRating") || 0);
  if (minRating > 0) { binds.push(minRating); where.push(`l.rating_avg >= ?${binds.length}`); }
  // Marketplace-only + hide expired listings from search.
  if (isMarket) {
    where.push("l.kind IN ('sell','buy','social')");
    binds.push(Date.now());
    where.push(`(l.expires_at IS NULL OR l.expires_at > ?${binds.length})`);
  }
  blockFilter(uid, binds, where);

  const sort = u.get("sort") || "soonest";
  const order = sort === "cheapest" ? "l.price ASC"
    : sort === "popular" ? "l.joined_count DESC"
    : sort === "rating" ? "COALESCE(l.rating_avg,0) DESC, l.rating_count DESC"
    : "COALESCE(l.starts_at, 4102444800000) ASC";
  const limit = Math.min(50, Math.max(1, Number(u.get("limit") || 20)));
  const offset = Math.max(0, Number(u.get("cursor") || 0));
  const rs = await metaSession(env).prepare(
    `${CARD_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${order}, l.created_at DESC LIMIT ${limit + 1} OFFSET ${offset}`,
  ).bind(...binds).all();
  const rows = (rs.results ?? []) as any[];
  const page = rows.slice(0, limit);
  const promos = await promosFor(env, page.map((r) => r.id));
  const cardStats = await cardStatsFor(env, page.map((r) => r.id));
  const favs = await favoritesFor(env, uid, page.map((r) => String(r.id))); // [UI-MKT-3]
  const g = geoOf(req);
  track(env, uid ?? "guest", "explore_search", APP, { q: q.slice(0, 40), sort, n: page.length, guest: !uid, vertical, section: isSection(section) ? section : null, country: g.country, city: g.city });
  trackImpressions(env, req, uid, APP, "search", page.map((r) => String(r.id)));
  return json({
    vertical,
    section: isSection(section) ? section : null,
    // [MARKET-SECTION-1] Search returns the same catalogue-wide counts as browse,
    // so the sidebar does not blank out the moment someone types a query.
    section_counts: await sectionCountsFor(env, req, uid),
    listings: page.map((r) => shapeCard(r, promos, favs, cardStats)),
    cursor: rows.length > limit ? String(offset + limit) : null,
  });
}

// GET /api/listings/:id — full details + creator card + reviews page 1.
export async function getListing(req: Request, env: Env, id: string): Promise<Response> {
  const uid = await maybeUid(req, env);
  const r = await metaSession(env).prepare(`${CARD_SELECT} WHERE l.id=?1`).bind(id).first<any>();
  if (!r) return json({ error: "not found" }, 404);
  const isOwner = uid === r.creator_id;
  // Public details pages must only expose listings that have completed the
  // creator/admin approval flow.  The owner can still preview any state from
  // the dashboard, but pending, rejected, or otherwise unpublished listings
  // must not leak through a guessed `/l/:id` URL.
  if (!isOwner && !["published", "live"].includes(String(r.status))) {
    return json({ error: "not found" }, 404);
  }
  const promos = await promosFor(env, [id]);
  const cardStats = await cardStatsFor(env, [id]);
  const favs = await favoritesFor(env, uid, [id]); // [UI-MKT-3] heart state on the detail page
  const card = shapeCard(r, promos, favs, cardStats);
  const reviews = await metaSession(env).prepare(
    `SELECT rv.id, rv.author_id, rv.rating, rv.body, rv.reply, rv.reply_at, rv.created_at, u.display_name AS author_name, u.avatar_url AS author_avatar
       FROM reviews rv LEFT JOIN users u ON u.uid=rv.author_id WHERE rv.listing_id=?1 ORDER BY rv.created_at DESC LIMIT 20`,
  ).bind(id).all();
  const prof = await metaSession(env).prepare(
    "SELECT rating_avg, rating_count, follower_count FROM creator_profiles WHERE user_id=?1",
  ).bind(r.creator_id).first<any>();
  let following = false, booked = false;
  if (uid) {
    following = !!(await metaDb(env).prepare("SELECT 1 FROM creator_follows WHERE follower_id=?1 AND creator_id=?2").bind(uid, r.creator_id).first());
    booked = !!(await metaDb(env).prepare("SELECT 1 FROM bookings WHERE listing_id=?1 AND buyer_id=?2 AND status IN ('confirmed','completed')").bind(id, uid).first());
    // Commercial live tickets are account-bound entitlements, not rows in the
    // legacy bookings table. Keep the detail CTA aligned with the same
    // server admission authority used by the GetStream join route.
    if (!booked && r.kind === "live_event") {
      try {
        booked = !!(await metaDb(env).prepare(
          "SELECT 1 FROM commercial_entitlements WHERE kind='live_event' AND listing_id=?1 AND account_id=?2 AND role='viewer' AND state IN ('reserved','held','active','consumed')",
        ).bind(id, uid).first());
      } catch (_) {
        // Before the commercial migration lands, fail closed and leave the
        // normal checkout CTA visible rather than granting access.
      }
    }
  }
  // Creator analytics: log non-owner detail views (D1 dashboard + PostHog mirror).
  if (!isOwner && ["published", "live"].includes(String(r.status))) {
    const src = new URL(req.url).searchParams.get("src");
    await recordView(env, req, {
      kind: "listing", subjectId: id, creatorId: String(r.creator_id), viewerUid: uid,
      app: APP, source: src, extra: { listing_kind: r.kind, price: Number(r.price), live: r.status === "live" },
    });
  }
  // [MKT1-DETAIL] The buyer detail page renders one of five templates keyed on the
  // listing's CATEGORY, not on `kind`. Three category-driven fields drive that choice:
  //   detail_template — PINNED (§2.4). Resolve it at the listing's OWN cat_version via
  //     resolveCategoryVersion, so the page renders with the template the listing was
  //     BORN with, never "latest" (an admin re-templating a category in September must
  //     not silently reshape a July listing's detail page).
  //   intent + price_semantics — NOT behaviour-pinned. They rarely change and, unlike
  //     the playbook, don't steer a paid negotiation, so read them from the LIVE
  //     listing_categories row by id (matching how categories.ts surfaces them).
  // agent_playbook is deliberately NOT surfaced: resolveCategoryVersion returns it, but
  // it is the seller's negotiation mandate and is dropped here exactly as CAT_PUBLIC_COLS
  // withholds it (categories.ts header). Defaults are the browse-card defaults so a
  // pre-migration category (or a category the lookup can't resolve) still renders.
  let intent = "SELL", detailTemplate = "sell", priceSemantics = "asking";
  try {
    const cat = String(r.category ?? "");
    const resolved = await resolveCategoryVersion(env, cat, Number(r.cat_version ?? 1));
    if (resolved?.detail_template) detailTemplate = String(resolved.detail_template);
    const catLive = await metaSession(env).prepare(
      "SELECT intent, price_semantics FROM listing_categories WHERE id=?1",
    ).bind(cat).first<any>();
    if (catLive?.intent) intent = String(catLive.intent);
    if (catLive?.price_semantics) priceSemantics = String(catLive.price_semantics);
  } catch { /* pre-migration: category columns/tables absent — keep the safe defaults */ }

  // [LIST-CONTENT-2] TRUST §4.2 — `creator_stats` is a SEPARATE table from
  // `creator_profiles` (the rating_avg/rating_count/follower_count already read into
  // `prof` above). Read-only here; a cron/on-write refresh ([LIST-STATS-1], not this
  // change) is what fills it. FAILS SOFT: the table may not be migrated/populated yet,
  // and a missing trust row must never take down the detail page (same posture as
  // cardStatsFor). Named `creator_trust_stats` in the response, NOT `creator_stats` —
  // that key already exists below with a DIFFERENT shape (rating/follower numbers from
  // creator_profiles), and rule J/§5 forbids changing an existing key's shape.
  let creatorTrustStats: Record<string, unknown> | null = null;
  try {
    const cs = await metaSession(env).prepare(
      `SELECT shows_hosted, hours_live, on_time_pct, cancel_rate, comeback_pct, avg_response_min,
              sessions_done, sold_out_count, first_session_at, last_session_at, updated_at
         FROM creator_stats WHERE creator_id=?1`,
    ).bind(r.creator_id).first<any>();
    if (cs) {
      creatorTrustStats = {
        shows_hosted: Number(cs.shows_hosted ?? 0),
        hours_live: Number(cs.hours_live ?? 0),
        on_time_pct: cs.on_time_pct != null ? Number(cs.on_time_pct) : null,
        cancel_rate: cs.cancel_rate != null ? Number(cs.cancel_rate) : null,
        comeback_pct: cs.comeback_pct != null ? Number(cs.comeback_pct) : null,
        avg_response_min: cs.avg_response_min != null ? Number(cs.avg_response_min) : null,
        sessions_done: Number(cs.sessions_done ?? 0),
        sold_out_count: Number(cs.sold_out_count ?? 0),
        first_session_at: cs.first_session_at ?? null,
        last_session_at: cs.last_session_at ?? null,
        updated_at: cs.updated_at ?? null,
      };
    }
  } catch { /* creator_stats not migrated/populated yet — null, not an error */ }

  // [LIST-CONTENT-2] spec item 4 — "booked_24h (count of entitlements/bookings for
  // this listing in last 24h)". Reuses the exact table + state list cardStatsFor's
  // seats_taken uses, so this number and the card's seats_taken agree on what counts
  // as "booked". Same fail-soft posture: pre-migration ⇒ null, not a 500.
  let booked24h: number | null = null;
  try {
    const row24 = await metaSession(env).prepare(
      `SELECT COUNT(*) n FROM commercial_entitlements
        WHERE listing_id=?1 AND role IN ('viewer','buyer')
          AND state IN ('reserved','held','active','consumed')
          AND created_at >= ?2`,
    ).bind(id, Date.now() - 86_400_000).first<any>();
    booked24h = Number(row24?.n ?? 0);
  } catch { /* commercial migration not applied — no 24h count, not an error */ }

  return json({
    listing: {
      ...card, description: r.description ?? "",
      intent, detail_template: detailTemplate, price_semantics: priceSemantics,
    },
    creator_stats: { rating_avg: prof?.rating_avg ?? null, rating_count: prof?.rating_count ?? 0, follower_count: prof?.follower_count ?? 0 },
    // [LIST-CONTENT-2] new, additive keys — see the comments above for why the trust
    // table's data is under its own name rather than overloading `creator_stats`.
    creator_trust_stats: creatorTrustStats,
    booked_24h: booked24h,
    reviews: reviews.results ?? [],
    viewer: { following, booked, is_owner: isOwner },
  });
}

// GET /api/listings/by-slug/:handle/:slug — pretty-URL resolution for the public
// /<handle>/<slug> details page (Specs/SPEC-2026-09-01-LISTING-CONTENT-AND-
// BOOKING.md §G). Resolves the creator's handle to a uid, then the (creator_id,
// slug) pair to a listing id, and hands off to getListing so the response shape
// (and every fail-soft path inside it) is identical to fetching by id — there is
// exactly one way this page's data gets built. 404s (never 500s) when the
// handle or slug do not resolve, same posture as getListing's own 404.
export async function getListingBySlug(req: Request, env: Env, handle: string, slug: string): Promise<Response> {
  const user = await metaSession(env).prepare(
    "SELECT uid FROM users WHERE handle=?1 OR uid=?1",
  ).bind(handle).first<any>();
  if (!user) return json({ error: "not found" }, 404);
  const row = await metaSession(env).prepare(
    "SELECT id FROM listings WHERE creator_id=?1 AND slug=?2",
  ).bind(user.uid, slug).first<any>();
  if (!row) return json({ error: "not found" }, 404);
  return getListing(req, env, String(row.id));
}

// GET /api/creators/:id — channel: profile, public fields, listings, reviews.
export async function getCreator(req: Request, env: Env, id: string): Promise<Response> {
  const uid = await maybeUid(req, env);
  const user = await metaSession(env).prepare(
    "SELECT uid, handle, display_name, bio, avatar_url FROM users WHERE uid=?1",
  ).bind(id).first<any>();
  if (!user) return json({ error: "not found" }, 404);
  const prof = await metaSession(env).prepare("SELECT * FROM creator_profiles WHERE user_id=?1").bind(id).first<any>();
  const kyc = await metaSession(env).prepare("SELECT status FROM kyc_status WHERE uid=?1").bind(id).first<any>();
  // [AVA-MKT-VERT-1] §2.0 — the channel page lists LISTINGS, so it is scoped too: one
  // person may hold a commerce shop and a connect profile, and the commerce channel must
  // not surface the latter (that is the §2.6 case, not a tidiness one). Not named in the
  // spec's list, but "a filter on every query" is the rule and the same default applies.
  const vertical = vertOf(new URL(req.url).searchParams.get("vertical"));
  const ls = await metaSession(env).prepare(
    `${CARD_SELECT} WHERE l.creator_id=?1 AND l.vertical=?2 AND l.status IN ('published','live')
      ORDER BY (l.status='live') DESC, COALESCE(l.starts_at, 4102444800000) ASC LIMIT 50`,
  ).bind(id, vertical).all();
  const lrows = (ls.results ?? []) as any[];
  const promos = await promosFor(env, lrows.map((r) => r.id));
  const cardStats = await cardStatsFor(env, lrows.map((r) => r.id));
  const favs = await favoritesFor(env, uid, lrows.map((r) => String(r.id))); // [UI-MKT-3]
  const reviews = await metaSession(env).prepare(
    `SELECT rv.id, rv.listing_id, rv.author_id, rv.rating, rv.body, rv.reply, rv.reply_at, rv.created_at, u.display_name AS author_name, u.avatar_url AS author_avatar
       FROM reviews rv LEFT JOIN users u ON u.uid=rv.author_id WHERE rv.creator_id=?1 ORDER BY rv.created_at DESC LIMIT 50`,
  ).bind(id).all();
  let following = false, notify = true;
  if (uid) {
    const f = await metaDb(env).prepare("SELECT notify FROM creator_follows WHERE follower_id=?1 AND creator_id=?2").bind(uid, id).first<any>();
    following = !!f; notify = f ? !!f.notify : true;
  }
  if (uid !== id) {
    const g = geoOf(req);
    track(env, uid ?? "guest", "creator_channel_viewed", APP, { creator_id: id, guest: !uid, country: g.country, city: g.city });
  }
  return json({
    creator: {
      uid: user.uid, handle: user.handle, name: user.display_name, avatar_url: user.avatar_url,
      bio: prof?.bio ?? user.bio ?? null,
      kyc_verified: kyc?.status === "verified",
      public_fields: parseJson(prof?.public_fields, {} as Record<string, unknown>),
      rating_avg: prof?.rating_avg ?? null, rating_count: prof?.rating_count ?? 0,
      follower_count: prof?.follower_count ?? 0,
      banner_r2_key: prof?.banner_r2_key ?? null,                       // A7
      links: parseJson(prof?.links, [] as unknown[]),
      intro_video_ref: prof?.intro_video_ref ?? null,
      pinned_listing_id: prof?.pinned_listing_id ?? null,
    },
    listings: lrows.map((r) => shapeCard(r, promos, favs, cardStats)),
    reviews: reviews.results ?? [],
    viewer: { following, notify },
  });
}

// PUT /api/creators/me — A7 channel editor (extras only; identity stays in users).
export async function updateMyChannel(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  let links: string | null | undefined = undefined;
  if (b.links !== undefined) {
    const arr = Array.isArray(b.links) ? b.links.slice(0, 8) : [];
    for (const li of arr) {
      if (!/^https:\/\//.test(String(li?.url || ""))) return json({ error: "links must be https" }, 400);
    }
    links = arr.length ? JSON.stringify(arr.map((li: any) => ({ label: String(li.label || "").slice(0, 40), url: String(li.url).slice(0, 300) }))) : null;
  }
  if (b.pinned_listing_id) {
    const own = await metaDb(env).prepare("SELECT creator_id FROM listings WHERE id=?1").bind(String(b.pinned_listing_id)).first<any>();
    if (!own || own.creator_id !== ctx.uid) return json({ error: "pinned listing not yours" }, 400);
  }
  const now = Date.now();
  await metaDb(env).prepare(
    `INSERT INTO creator_profiles (user_id, bio, public_fields, banner_r2_key, links, intro_video_ref, pinned_listing_id, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
     ON CONFLICT(user_id) DO UPDATE SET
       bio=COALESCE(?2,bio), public_fields=COALESCE(?3,public_fields), banner_r2_key=COALESCE(?4,banner_r2_key),
       links=COALESCE(?5,links), intro_video_ref=COALESCE(?6,intro_video_ref),
       pinned_listing_id=COALESCE(?7,pinned_listing_id), updated_at=?8`,
  ).bind(ctx.uid, b.bio !== undefined ? String(b.bio).slice(0, 2000) : null,
    b.public_fields !== undefined ? JSON.stringify(b.public_fields) : null,
    b.banner_r2_key !== undefined ? String(b.banner_r2_key) : null,
    links === undefined ? null : links,
    b.intro_video_ref !== undefined ? String(b.intro_video_ref) : null,
    b.pinned_listing_id ? String(b.pinned_listing_id) : null, now).run();
  track(env, ctx.uid, "channel_updated", APP, {});
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// A2 follows + A4 block + report
// ---------------------------------------------------------------------------

export async function followCreator(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (ctx.uid === id) return json({ error: "cannot follow yourself" }, 400);
  const b = (await req.json().catch(() => ({}))) as any;
  const db = metaDb(env);
  const exists = await db.prepare("SELECT notify FROM creator_follows WHERE follower_id=?1 AND creator_id=?2").bind(ctx.uid, id).first<any>();
  const notify = b.notify === undefined ? (exists ? !!exists.notify : true) : !!b.notify;
  if (exists) {
    // Per-creator mute toggle (notify=0) rides the same endpoint.
    await db.prepare("UPDATE creator_follows SET notify=?3 WHERE follower_id=?1 AND creator_id=?2").bind(ctx.uid, id, notify ? 1 : 0).run();
    return json({ ok: true, following: true, notify });
  }
  await db.batch([
    db.prepare("INSERT INTO creator_follows (follower_id, creator_id, created_at, notify) VALUES (?1,?2,?3,?4)").bind(ctx.uid, id, Date.now(), notify ? 1 : 0),
    db.prepare(`INSERT INTO creator_profiles (user_id, follower_count, updated_at) VALUES (?1,1,?2)
                ON CONFLICT(user_id) DO UPDATE SET follower_count=follower_count+1, updated_at=?2`).bind(id, Date.now()),
  ]);
  void brainIngest(env, { uid: ctx.uid, domain: "listings", kind: "creator_followed", sourceId: `${ctx.uid}:${id}`, text: "Followed a creator", meta: { creator: id } });
  track(env, ctx.uid, "creator_followed", APP, {});
  return json({ ok: true, following: true, notify });
}

export async function unfollowCreator(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const db = metaDb(env);
  const r = await db.prepare("DELETE FROM creator_follows WHERE follower_id=?1 AND creator_id=?2").bind(ctx.uid, id).run();
  if ((r.meta?.changes ?? 0) > 0) {
    await db.prepare("UPDATE creator_profiles SET follower_count=MAX(0,follower_count-1), updated_at=?2 WHERE user_id=?1").bind(id, Date.now()).run();
  }
  track(env, ctx.uid, "creator_unfollowed", APP, {});
  return json({ ok: true, following: false });
}

// A4 buyer-side block: hides the creator's listings + blocks messages both ways
// (messaging honours the same `blocks` table via authz.blocks()).
export async function blockCreator(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (req.method === "DELETE") {
    await metaDb(env).prepare("DELETE FROM blocks WHERE uid=?1 AND blocked_uid=?2").bind(ctx.uid, id).run();
    return json({ ok: true, blocked: false });
  }
  await metaDb(env).prepare("INSERT OR IGNORE INTO blocks (uid, blocked_uid, created_at) VALUES (?1,?2,?3)").bind(ctx.uid, id, Date.now()).run();
  // Blocking also unfollows.
  await metaDb(env).prepare("DELETE FROM creator_follows WHERE follower_id=?1 AND creator_id=?2").bind(ctx.uid, id).run();
  track(env, ctx.uid, "creator_blocked", APP, {});
  return json({ ok: true, blocked: true });
}

// POST /api/report {targetType: listing|creator|review, targetId, reason} → user_reports.
export async function report(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const targetType = String(b.targetType || "");
  const targetId = String(b.targetId || "");
  if (!["listing", "creator", "review"].includes(targetType) || !targetId) {
    return json({ error: "targetType (listing|creator|review) and targetId required" }, 400);
  }
  let reportedUid = targetId;
  if (targetType === "listing") {
    const l = await metaDb(env).prepare("SELECT creator_id FROM listings WHERE id=?1").bind(targetId).first<any>();
    if (!l) return json({ error: "listing not found" }, 404);
    reportedUid = l.creator_id;
  } else if (targetType === "review") {
    const rv = await metaDb(env).prepare("SELECT author_id FROM reviews WHERE id=?1").bind(targetId).first<any>();
    if (!rv) return json({ error: "review not found" }, 404);
    reportedUid = rv.author_id;
  }
  await moderationDb(env).prepare(
    `INSERT INTO user_reports (id, reporter_uid, reported_uid, content_kind, content_id, category, description, status, priority, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,'open',3,?8)`,
  ).bind(crypto.randomUUID(), ctx.uid, reportedUid, targetType, targetId,
    String(b.reason || "other").slice(0, 60), b.description ? String(b.description).slice(0, 2000) : null, Date.now()).run();
  track(env, ctx.uid, "report_filed", APP, { targetType });
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// [UI-MKT-3] favorites (marketplace hearts) — per-account scoped by ctx.uid.
//   POST   /api/marketplace/favorites {listing_id}   → insert OR IGNORE
//   DELETE /api/marketplace/favorites?listing_id=…    → delete
//   GET    /api/marketplace/favorites                 → the user's favorited cards
// The card/list reads hydrate the `favorited` flag via favoritesFor() (above),
// so the client can render the heart state without a per-card round-trip.
// ---------------------------------------------------------------------------

/** POST /api/marketplace/favorites {listing_id} — heart a listing (idempotent). */
export async function addFavorite(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const listingId = String(b.listing_id || "").trim();
  if (!listingId) return json({ error: "listing_id required" }, 400);
  // Only real listings can be hearted (avoids orphan rows); soft check, best-effort.
  const l = await metaDb(env).prepare("SELECT id FROM listings WHERE id=?1").bind(listingId).first<any>();
  if (!l) return json({ error: "not found" }, 404);
  await metaDb(env).prepare(
    "INSERT OR IGNORE INTO listing_favorites (uid, listing_id, created_at) VALUES (?1,?2,?3)",
  ).bind(ctx.uid, listingId, Date.now()).run();
  track(env, ctx.uid, "listing_favorited", APP, { listing_id: listingId });
  return json({ ok: true, favorited: true });
}

/** DELETE /api/marketplace/favorites?listing_id=… — un-heart. */
export async function removeFavorite(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  // listing_id may ride the query (DELETE) or a JSON body — accept both.
  let listingId = new URL(req.url).searchParams.get("listing_id") || "";
  if (!listingId) { const b = (await req.json().catch(() => ({}))) as any; listingId = String(b.listing_id || ""); }
  listingId = listingId.trim();
  if (!listingId) return json({ error: "listing_id required" }, 400);
  await metaDb(env).prepare("DELETE FROM listing_favorites WHERE uid=?1 AND listing_id=?2").bind(ctx.uid, listingId).run();
  track(env, ctx.uid, "listing_unfavorited", APP, { listing_id: listingId });
  return json({ ok: true, favorited: false });
}

/** GET /api/marketplace/favorites — the user's favorited listings as full cards
 *  (newest-favorited first), so the "Saved" tab renders with the same card path. */
export async function listFavorites(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  // [AVA-MKT-VERT-1] §2.0 — "favourites" is named in the cross-vertical rule. The Saved
  // tab belongs to a vertical's shell, so it shows that vertical's saves; the row itself
  // is unchanged (listing_favorites needs no vertical column — the join to `listings`
  // already carries it). Absent ?vertical ⇒ commerce, i.e. today's list for today's app.
  const vertical = vertOf(new URL(req.url).searchParams.get("vertical"));
  const rs = await metaSession(env).prepare(
    `${CARD_SELECT}
       JOIN listing_favorites f ON f.listing_id = l.id
      WHERE f.uid=?1 AND l.vertical=?2 AND l.status IN ('published','live')
      ORDER BY f.created_at DESC LIMIT 100`,
  ).bind(ctx.uid, vertical).all();
  const rows = (rs.results ?? []) as any[];
  const promos = await promosFor(env, rows.map((r) => r.id));
  const cardStats = await cardStatsFor(env, rows.map((r) => r.id));
  const favs = new Set(rows.map((r) => String(r.id))); // all favorited by definition
  return json({ vertical, listings: rows.map((r) => shapeCard(r, promos, favs, cardStats)) });
}

// ---------------------------------------------------------------------------
// purchase glue (full lifecycle in Phase 7)
// ---------------------------------------------------------------------------

// POST /api/listings/:id/book { slot?: {start_at,end_at}, promo_code? }
// Shared by "Book" and the live "Join & pay" popup. Creates orders row +
// booking + wallet escrow hold + joined_count bump + Brevo confirmation.
export async function bookListing(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const db = metaDb(env);
  const l = await db.prepare("SELECT * FROM listings WHERE id=?1").bind(id).first<any>();
  if (!l || !["published", "live"].includes(l.status)) return json({ error: "listing not available" }, 404);
  if (l.creator_id === ctx.uid) return json({ error: "cannot book your own listing" }, 400);
  if (l.kind === "live_event" || l.kind === "consult") {
    // [COMM-FLAG-UNIFY-1] One predicate, shared with commercial_checkout.ts. This fence
    // used to read only the *ListingsEnabled flags while checkout read only the
    // *CheckoutEnabled ones, so a half-flip left BOTH lanes taking money for one listing
    // into two unrelated escrow buckets. `mixed` is now its own state and refuses here
    // too — a half-configured money lane must never be the reason a charge succeeds.
    const kind = l.kind === "live_event" ? "live_event" : "consult_1to1";
    let lane: CommercialLaneState;
    try {
      lane = commercialLaneState(await readConfig(env), kind);
    } catch {
      return json({ error: "commercial configuration unavailable" }, 503);
    }
    if (lane === "mixed") {
      track(env, ctx.uid, "commercial_lane_misconfigured", APP, {
        listing_id: id, listing_kind: l.kind, surface: "legacy_book",
        ...commercialLaneFlags(await readConfig(env), kind),
      });
      return json({ error: "commercial configuration unavailable", reason: "lane_misconfigured" }, 503);
    }
    if (lane === "on") {
      return json({
        error: "commercial_checkout_required",
        message: "This service must be purchased through commercial checkout.",
      }, 409);
    }
  }
  // Phase 7 A5 — creator block list: a blocked buyer cannot book this creator.
  {
    const blocked = await db.prepare("SELECT 1 FROM blocks WHERE uid=?1 AND blocked_uid=?2").bind(l.creator_id, ctx.uid).first().catch(() => null);
    if (blocked) return json({ error: "listing not available" }, 404);
  }

  // Window: live events are fixed; consults bring a slot from the picker.
  let start: number, end: number;
  if (l.kind === "live_event") {
    start = Number(l.starts_at);
    end = start + Number(l.duration_min || 60) * 60_000;
    if (l.status !== "live" && start < Date.now()) return json({ error: "event already started" }, 409);
  } else {
    start = Math.trunc(Number(b.slot?.start_at));
    end = Math.trunc(Number(b.slot?.end_at || (start + Number(l.duration_min || 60) * 60_000)));
    if (!(start > Date.now()) || !(end > start)) return json({ error: "slot {start_at, end_at} required (future)" }, 400);
    // Server-side policy re-validation (UI greying is not enforcement).
    const viol = await policyViolation(env, l.creator_id, start, end);
    if (viol) return json({ error: "policy", reason: viol }, 409);
    // Capacity: seats on this exact window.
    const seats = await db.prepare(
      "SELECT COUNT(*) AS n FROM bookings WHERE listing_id=?1 AND starts_at=?2 AND status IN ('confirmed','completed')",
    ).bind(id, start).first<{ n: number }>();
    if ((seats?.n ?? 0) >= Number(l.capacity || 1)) return json({ error: "slot full" }, 409);
  }

  // A5: best single promotion (early-bird auto; promo code when provided).
  const promos = await promosFor(env, [id]);
  const cardStats = await cardStatsFor(env, [id]);
  const { pct, promo } = activePromoPct(promos.get(id) ?? [], Date.now(), b.promo_code ?? null);
  const amount = pct > 0 ? Math.round(Number(l.price) * (100 - pct) / 100) : Number(l.price);

  const bookingId = crypto.randomUUID();
  const orderId = `ord_${bookingId.slice(0, 18)}`;

  // Voice translation add-on ("Would you like this to be translated into the
  // language of your choice?"). $3/h = 5 Tokens/min for the booked duration;
  // 100% platform fee — NEVER shared with the creator. Unused minutes refund
  // at settlement.
  let trlLang: string | null = null, trlTokens = 0, trlOrderId: string | null = null;
  if (b.translation?.lang) {
    if (!l.translation_enabled) return json({ error: "translation not offered on this listing" }, 400);
    const lang = String(b.translation.lang);
    if (!TRL_LANGS.has(lang)) return json({ error: "unsupported translation language", lang }, 400);
    trlLang = lang;
    trlTokens = Math.ceil((end - start) / 60_000) * TRL_RATE;
    trlOrderId = `trl_${bookingId.slice(0, 18)}`;
  }

  // Conflict engine claims: the BUYER always; the creator too for 1:1 consults.
  const claim = await claimBlock(env, { userId: ctx.uid, sourceApp: "avabooking", sourceRef: bookingId, start, end, title: String(l.title) });
  if (!claim.ok) return json({ error: "conflict", conflictWith: claim.conflict }, 409);
  let creatorClaimed = false;
  if (l.kind === "consult" && Number(l.capacity || 1) === 1) {
    const cc = await claimBlock(env, { userId: l.creator_id, sourceApp: APP, sourceRef: bookingId, start, end, title: String(l.title) });
    if (!cc.ok) {
      await releaseBlocks(env, "avabooking", bookingId);
      return json({ error: "conflict", conflictWith: cc.conflict }, 409);
    }
    creatorClaimed = true;
  }

  // Money: escrow hold (Phase 2). Free listings skip the wallet entirely (A5).
  if (amount > 0) {
    const h = await hold(env, ctx.uid, orderId, amount, { title: String(l.title), app: APP });
    if (!h.ok) {
      await releaseBlocks(env, "avabooking", bookingId);
      if (creatorClaimed) await releaseBlocks(env, APP, bookingId);
      if (h.status === 402) return json({ error: "insufficient_funds", needed: amount + trlTokens, ...h.body }, 402);
      return json({ error: "payment failed", detail: h.body }, 502);
    }
  }
  // Translation prepay → its own escrow bucket (trl_*). On failure, unwind the
  // main hold so the buyer never pays for a booking they didn't get.
  if (trlOrderId && trlTokens > 0) {
    const th = await hold(env, ctx.uid, trlOrderId, trlTokens, { title: `Voice translation (${trlLang})`, app: "avatranslate" });
    if (!th.ok) {
      if (amount > 0) await refund(env, orderId, ctx.uid, amount, { opId: `refund:${orderId}:trlfail`, reason: "booking failed (translation payment)", title: String(l.title) });
      await releaseBlocks(env, "avabooking", bookingId);
      if (creatorClaimed) await releaseBlocks(env, APP, bookingId);
      if (th.status === 402) return json({ error: "insufficient_funds", needed: amount + trlTokens, ...th.body }, 402);
      return json({ error: "payment failed", detail: th.body }, 502);
    }
  }

  const now = Date.now();
  const bkKind = l.kind === "live_event" ? "live_event" : (Number(l.capacity || 1) > 1 ? "consult_group" : "consult_1to1");
  const mkEvent = (owner: string, role: string) => db.prepare(
    `INSERT INTO calendar_events (id, booking_id, slot_id, owner_uid, owner_uid, role, host_uid, host_uid, attendee_uid, attendee_uid, title, start_at, end_at, price_coins, paid, status, source, created_at)
     VALUES (?1,?2,?3,?4,?4,?5,?6,?6,?7,?7,?8,?9,?10,?11,?12,'confirmed','user',?13)`,
  ).bind(crypto.randomUUID(), bookingId, id, owner, role, l.creator_id, ctx.uid, l.title, start, end, amount, amount > 0 ? 1 : 0, now);
  await db.batch([
    db.prepare(
      `INSERT INTO orders (id, listing_id, buyer_id, creator_id, amount, promo_id, status, created_at, updated_at, kind, fee_pct, escrow_account, booking_id)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8,?9,20,?10,?11)`,
    ).bind(orderId, id, ctx.uid, l.creator_id, amount, promo?.id ?? null, amount > 0 ? "held" : "free", now,
      l.kind === "live_event" ? "live_event" : "consult", `escrow:${orderId}`, bookingId),
    db.prepare(
      `INSERT INTO bookings (id, creator_id, buyer_id, listing_id, kind, starts_at, ends_at, price, order_id, status, translation_lang, translation_coins, trl_order_id, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'confirmed',?10,?11,?12,?13,?13)`,
    ).bind(bookingId, l.creator_id, ctx.uid, id, bkKind, start, end, amount, amount > 0 ? orderId : null, trlLang, trlTokens, trlOrderId, now),
    mkEvent(ctx.uid, "attendee"),
    mkEvent(l.creator_id, "host"),
    db.prepare("UPDATE listings SET joined_count=joined_count+1, updated_at=?2 WHERE id=?1").bind(id, now),
    ...(promo ? [db.prepare("UPDATE listing_promotions SET used=used+1 WHERE id=?1").bind(promo.id)] : []),
  ]);

  // Phase 7: arm the session DO — alarms at start+wait (no-show check) and
  // end+grace (settlement) fire the refund engine exactly on time. The minute
  // sweep is the safety net, so best-effort here.
  try {
    const sid = l.kind === "live_event" ? id : bookingId;
    const doKey = l.kind === "live_event" ? `live:${id}` : `consult:${bookingId}`;
    await env.STREAM_SESSION_DO.get(env.STREAM_SESSION_DO.idFromName(doKey)).fetch("https://session/op", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "schedule", sid, kind: l.kind === "live_event" ? "live_event" : "consult", starts_at: start, ends_at: end, host_id: l.creator_id }),
    });
  } catch { /* sweep covers it */ }

  // Confirmation email (date/time + how to join) + push, both sides. Best-effort.
  const [creatorName, buyerName] = await Promise.all([nameOf(env, l.creator_id), nameOf(env, ctx.uid)]);
  try {
    await emailBookingConfirmed(env, { bookingId, title: l.title, start, end, price: amount, creatorId: l.creator_id, buyerId: ctx.uid, creatorName, buyerName });
  } catch { /* best-effort */ }
  try { await notifyUser(env, l.creator_id, { type: "system", title: l.kind === "live_event" ? "New attendee" : "New booking", body: l.title, data: { deeplink: "/booking", booking_id: bookingId } }); } catch { /* best-effort */ }
  try { await notifyUser(env, ctx.uid, { type: "system", title: "Booking confirmed", body: l.title, data: { deeplink: `/explore/listing/${id}`, booking_id: bookingId } }); } catch { /* best-effort */ }
  void brainIngest(env, { uid: ctx.uid, domain: "listings", kind: "listing_booked", sourceId: bookingId, text: `Booked "${l.title}" (${l.kind})`, meta: { title: l.title, kind: l.kind, amount } });
  {
    const g = geoOf(req);
    track(env, ctx.uid, "listing_booked", APP, {
      kind: l.kind, amount, promo: pct, live: l.status === "live", translation: !!trlLang,
      listing_id: id, creator_id: l.creator_id, country: g.country, city: g.city, region: g.region,
    });
  }
  return json({
    ok: true, booking_id: bookingId, order_id: orderId, amount, paid: amount + trlTokens > 0,
    translation: trlLang ? { lang: trlLang, coins: trlTokens, order_id: trlOrderId } : null,
    total: amount + trlTokens,
    start_at: start, end_at: end, joinable: l.status === "live",
  });
}

// POST /api/listings/:id/reviews { rating 1–5, body? } — attendees only.
export async function createReview(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const rating = Math.trunc(Number(b.rating));
  if (!(rating >= 1 && rating <= 5)) return json({ error: "rating 1–5 required" }, 400);
  const db = metaDb(env);
  const l = await db.prepare("SELECT creator_id, status FROM listings WHERE id=?1").bind(id).first<any>();
  if (!l) return json({ error: "not found" }, 404);
  if (l.creator_id === ctx.uid) return json({ error: "cannot review your own listing" }, 400);

  // Attendance gate: a confirmed/completed booking whose window has passed.
  const bk = await db.prepare(
    "SELECT 1 FROM bookings WHERE listing_id=?1 AND buyer_id=?2 AND status IN ('confirmed','completed') AND ends_at <= ?3",
  ).bind(id, ctx.uid, Date.now()).first();
  if (!bk) return json({ error: "only attendees can review (after the session ends)" }, 403);

  const now = Date.now();
  await db.prepare(
    `INSERT INTO reviews (id, listing_id, creator_id, author_id, rating, body, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7)
     ON CONFLICT(listing_id, author_id) DO UPDATE SET rating=?5, body=?6, created_at=?7`,
  ).bind(crypto.randomUUID(), id, l.creator_id, ctx.uid, rating, b.body ? String(b.body).slice(0, 2000) : null, now).run();

  // Averages update on the card AND the channel (acceptance criterion).
  await db.batch([
    db.prepare(
      `UPDATE listings SET
         rating_avg=(SELECT AVG(rating) FROM reviews WHERE listing_id=?1),
         rating_count=(SELECT COUNT(*) FROM reviews WHERE listing_id=?1), updated_at=?2 WHERE id=?1`,
    ).bind(id, now),
    db.prepare(
      `INSERT INTO creator_profiles (user_id, rating_avg, rating_count, updated_at)
       VALUES (?1, (SELECT AVG(rating) FROM reviews WHERE creator_id=?1), (SELECT COUNT(*) FROM reviews WHERE creator_id=?1), ?2)
       ON CONFLICT(user_id) DO UPDATE SET
         rating_avg=(SELECT AVG(rating) FROM reviews WHERE creator_id=?1),
         rating_count=(SELECT COUNT(*) FROM reviews WHERE creator_id=?1), updated_at=?2`,
    ).bind(l.creator_id, now),
  ]);
  try { await notifyUser(env, l.creator_id, { type: "social", title: `New ${rating}★ review`, body: b.body ? String(b.body).slice(0, 80) : undefined, data: { deeplink: `/explore/listing/${id}` } }); } catch { /* best-effort */ }
  void brainIngest(env, { uid: ctx.uid, domain: "listings", kind: "review_left", sourceId: `${ctx.uid}:${id}`, text: `Left a ${rating}★ review`, meta: { rating } });
  track(env, ctx.uid, "review_created", APP, { rating });
  return json({ ok: true });
}
