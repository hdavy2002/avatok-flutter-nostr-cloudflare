// AvaTOK Number routes (Specs/AVATOK-NUMBER-FEATURE-SPEC.md §7).
//
// A pure-virtual, country-standard, NON-PSTN number that represents a user
// in-network and maps to their Clerk uid. Generating one is FREE for everyone
// (one number per free account; claimed at onboarding); only paid plans (tier>=1)
// can regenerate/change it — a free regen attempt gets a 402. Assigning REPLACES the user's
// real phone as their network identity (card / QR / search). Numbers are unique;
// the picker only ever offers available combinations. All gated by the
// `numberFeatureEnabled` kill switch.
import type { Env } from "../types";
import { json } from "../util";
import { metaSession, metaDb } from "../db/shard";
import { requireUser, isFail } from "../authz";
import { readConfig } from "./config";
import { tierOf } from "./plans";
import { COUNTRIES, planFor, canonical, display, validNsn, validOwnNsn, exampleNsn, generate, type CountryPlan } from "../lib/numbering";
// [PIVOT-PAID-NUMBER-1] Paid vanity-number purchase for free-tier accounts.
// Copies the charge/refund pattern from virtualDidPurchase (virtual_lines.ts:109-138)
// VERBATIM: stable opId, chargeAmount 402 on insufficient balance, refund-on-failure
// via a distinct `${opId}:refund` op id.
import { chargeAmount } from "../feature_pricing";
import { walletOp } from "./wallet";

const RESERVE_TTL_MS = 10 * 60 * 1000; // 10-minute hold while the user confirms

async function featureOn(env: Env): Promise<boolean> {
  try { return (await readConfig(env)).numberFeatureEnabled !== false; } catch { return true; }
}
function paid(tier: number): boolean { return tier >= 1; }

// Cloudflare-derived request signals (IP + geo + network) for rich PostHog
// analytics: where the user is, on what network, from which edge — captured at
// the moment of each number action. `req.cf` is populated by Cloudflare's edge.
function geoProps(req: Request): Record<string, unknown> {
  const cf = (((req as unknown as { cf?: Record<string, unknown> }).cf) ?? {}) as Record<string, unknown>;
  return {
    ip: req.headers.get("CF-Connecting-IP") ?? req.headers.get("X-Forwarded-For") ?? null,
    geo_country: cf.country ?? null,
    geo_region: cf.region ?? null,
    geo_region_code: cf.regionCode ?? null,
    geo_city: cf.city ?? null,
    geo_postal: cf.postalCode ?? null,
    geo_continent: cf.continent ?? null,
    geo_lat: cf.latitude ?? null,
    geo_lon: cf.longitude ?? null,
    geo_timezone: cf.timezone ?? null,
    net_asn: cf.asn ?? null,
    net_org: cf.asOrganization ?? null,
    cf_colo: cf.colo ?? null,
    http_protocol: cf.httpProtocol ?? null,
    user_agent: req.headers.get("User-Agent") ?? null,
    accept_language: req.headers.get("Accept-Language") ?? null,
  };
}

function analytics(env: Env, event: string, uid: string, props: Record<string, unknown>, req?: Request): void {
  try {
    void env.Q_ANALYTICS.send({
      event, uid, ts: Date.now(),
      props: {
        ...props,
        ...(req ? geoProps(req) : {}),
        app_name: "avatok", service_name: "avatok-api", worker: true, account_id: uid,
      },
    });
  } catch { /* best-effort; telemetry never blocks */ }
}

// [PIVOT-NUMBER-PRIVACY-1] Lazy column add — same idempotent pattern as
// ensureLastSeenCols below. `avatok_number_source` distinguishes HOW the
// current avatok_number was bound: 'own' means the user typed in an arbitrary
// number via assign-own with NO ownership verification (phone OTP has been
// unrouted since 2026-07-10 — see personal_phone_field.dart). Anything else
// (NULL/'generated') was minted by the picker/vanity flow and is a genuine
// AvaTOK-issued identity. This lets addResolve() below refuse to publicly
// resolve an unverified 'own' claim by digits, without touching the column
// that already ships to clients (avatok_number itself is untouched).
let numberSourceColEnsured = false;
async function ensureNumberSourceCol(env: Env): Promise<void> {
  if (numberSourceColEnsured) return;
  try { await env.DB_META.prepare("ALTER TABLE users ADD COLUMN avatok_number_source TEXT").run(); } catch { /* already exists */ }
  numberSourceColEnsured = true;
}

// GET /api/number/countries — public. The picker's country list.
export function countries(): Response {
  return json(
    { countries: COUNTRIES.map((c) => ({ iso2: c.iso2, name: c.name, dial: c.dial, flag: c.flag, example: display(c, exampleNsn(c)) })) },
    200, { "cache-control": "public, max-age=3600" },
  );
}

async function isTaken(db: ReturnType<typeof metaSession>, number: string, uid: string): Promise<boolean> {
  const active = await db.prepare("SELECT uid FROM avatok_numbers WHERE number=?1 AND status='active'").bind(number).first<{ uid: string }>();
  if (active) return true;
  const now = Date.now();
  const res = await db.prepare("SELECT uid, expires_at FROM number_reservations WHERE number=?1").bind(number).first<{ uid: string; expires_at: number }>();
  if (res && res.expires_at > now && res.uid !== uid) return true;
  return false;
}

// GET /api/number/available?country=GH&pattern=555 — auth. Returns available
// vanity numbers only. Browsing is allowed on any tier; assign is gated.
export async function available(req: Request, env: Env): Promise<Response> {
  if (!(await featureOn(env))) return json({ error: "number_feature_off" }, 503);
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const url = new URL(req.url);
  const plan = planFor(url.searchParams.get("country") || "");
  if (!plan) return json({ error: "unsupported_country" }, 400);
  const pattern = url.searchParams.get("pattern") || "";
  const tier = await tierOf(env, ctx.uid);
  const db = metaSession(env);
  const cands = generate(plan, 24, pattern);
  const out: { nsn: string; canonical: string; display: string }[] = [];
  for (const nsn of cands) {
    if (out.length >= 8) break;
    const num = canonical(plan, nsn);
    if (await isTaken(db, num, ctx.uid)) continue;
    out.push({ nsn, canonical: num, display: display(plan, nsn) });
  }
  analytics(env, "number_store_opened", ctx.uid, {
    country: plan.iso2, country_name: plan.name, country_dial: plan.dial,
    pattern: pattern ? "yes" : "no", pattern_value: pattern || null,
    entitled: paid(tier), tier, results: out.length, has_results: out.length > 0,
  }, req);
  // [PIVOT-PAID-NUMBER-1] Free-tier clients need the price to render a "Buy for
  // ₹N" confirm step without a subscription. 0 means the paid path is dark
  // (unconfigured) — the client must treat 0 as "not for sale", never free.
  const cfg = await readConfig(env);
  return json({ country: plan.iso2, entitled: paid(tier), tier, numbers: out, vanityPriceTokens: cfg.avatokVanityNumberTokens });
}

function resolveInput(req: Request, body: { country?: string; nsn?: string; number?: string }): { plan: CountryPlan; nsn: string; number: string } | null {
  const plan = planFor(body.country || "");
  if (!plan) return null;
  let nsn = (body.nsn || "").replace(/[^0-9]/g, "");
  if (!nsn && body.number) {
    const digits = body.number.replace(/[^0-9]/g, "");
    nsn = digits.startsWith(plan.dial) ? digits.slice(plan.dial.length) : digits;
  }
  if (!validNsn(plan, nsn)) return null;
  return { plan, nsn, number: canonical(plan, nsn) };
}

// POST /api/number/reserve {country, nsn} — auth + paid. Short TTL hold.
export async function reserve(req: Request, env: Env): Promise<Response> {
  if (!(await featureOn(env))) return json({ error: "number_feature_off" }, 503);
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  // [PIVOT-PAID-NUMBER-1] A free-tier account may still reserve — the SAME short
  // TTL hold used by the paid tier flow — as the first step of buying a vanity
  // number with tokens via purchaseVanity() below, but ONLY once the owner has
  // actually priced that path (avatokVanityNumberTokens > 0); otherwise the paid
  // path is dark and this stays exactly the old tier-gated 402. The existing
  // subscription-tier reserve path is unchanged.
  const cfgReserve = await readConfig(env);
  if (!paid(await tierOf(env, ctx.uid)) && !(cfgReserve.avatokVanityNumberTokens > 0)) {
    return json({ error: "upgrade_required" }, 402);
  }
  const body = (await req.json().catch(() => ({}))) as any;
  const r = resolveInput(req, body);
  if (!r) return json({ error: "invalid_number" }, 400);
  const db = metaSession(env);
  if (await isTaken(db, r.number, ctx.uid)) return json({ error: "number_taken" }, 409);
  const expires = Date.now() + RESERVE_TTL_MS;
  await env.DB_META.prepare(
    "INSERT INTO number_reservations (number, uid, expires_at) VALUES (?1,?2,?3) ON CONFLICT(number) DO UPDATE SET uid=?2, expires_at=?3",
  ).bind(r.number, ctx.uid, expires).run();
  analytics(env, "number_reserved", ctx.uid, {
    country: r.plan.iso2, country_name: r.plan.name, country_dial: r.plan.dial,
    number: r.number, display: display(r.plan, r.nsn), nsn: r.nsn, tier: await tierOf(env, ctx.uid),
  }, req);
  return json({ ok: true, number: r.number, display: display(r.plan, r.nsn), expires_at: expires });
}

// POST /api/number/assign {country, nsn} — auth + paid. Finalize + replace the
// real phone as the user's network identity.
export async function assign(req: Request, env: Env): Promise<Response> {
  if (!(await featureOn(env))) return json({ error: "number_feature_off" }, 503);
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  await ensureNumberSourceCol(env); // [PIVOT-NUMBER-PRIVACY-1]
  const tier = await tierOf(env, ctx.uid);
  // Generating an AvaTOK number is FREE for everyone, but a FREE account gets
  // exactly ONE number. Paid accounts regenerate without limit. A free account
  // that already used its free generation (or already holds a number) must
  // upgrade to change (owner request 2026-06-27).
  if (!paid(tier)) {
    const u = await metaSession(env).prepare(
      "SELECT free_number_used, avatok_number FROM users WHERE uid=?1",
    ).bind(ctx.uid).first<{ free_number_used: number | null; avatok_number: string | null }>();
    const hasNumber = !!(u?.avatok_number ?? "");
    const freeUsed = (u?.free_number_used ?? 0) === 1;
    // [NUMBER-STUCK-FIX 2026-07-10] Block a CHANGE only when the user ACTUALLY HOLDS
    // a number (changing then needs a paid plan). The old check also blocked on
    // `free_number_used === 1` alone — but that flag can be 1 while avatok_number is
    // EMPTY (an interrupted earlier assign, a released number, or a cross-onboarding
    // flag). That combination TRAPPED the user: the shell number gate shows (no
    // number) yet every pick 402'd "Available on paid plans", forever. A free user
    // with no number must always be able to claim their one number; this self-heals.
    if (hasNumber) {
      analytics(env, "number_regen_blocked_free", ctx.uid, { tier, reason: "free_already_used" }, req);
      return json({ error: "upgrade_required" }, 402);
    }
    // Rich telemetry: we healed the inconsistent state (flag set, no number). If this
    // fires often, something upstream is setting free_number_used without a number.
    if (freeUsed && !hasNumber) {
      analytics(env, "number_free_flag_self_healed", ctx.uid, { tier }, req);
    }
  }
  const body = (await req.json().catch(() => ({}))) as any;
  const r = resolveInput(req, body);
  if (!r) {
    analytics(env, "number_assign_failed", ctx.uid, { reason: "invalid_number", country: (body?.country ?? null), tier }, req);
    return json({ error: "invalid_number" }, 400);
  }
  const db = metaSession(env);
  if (await isTaken(db, r.number, ctx.uid)) {
    analytics(env, "number_assign_failed", ctx.uid, { reason: "number_taken", country: r.plan.iso2, number: r.number, tier }, req);
    return json({ error: "number_taken" }, 409);
  }
  const now = Date.now();
  const disp = display(r.plan, r.nsn);

  // Was the user already on a number? (telemetry + release the old one)
  const prev = await env.DB_META.prepare("SELECT number FROM avatok_numbers WHERE uid=?1 AND status='active'").bind(ctx.uid).first<{ number: string }>();
  const hadReal = await env.DB_META.prepare("SELECT phone_hash, avatok_number FROM users WHERE uid=?1").bind(ctx.uid).first<{ phone_hash: string | null; avatok_number: string | null }>();

  const stmts = [
    // [NUMBER-ONBOARD-PERSIST-1] Number selection happens BEFORE the profile
    // form is saved. A brand-new Clerk account may therefore have no users row
    // yet; UPDATE users below would affect zero rows and /me would immediately
    // forget the successful assignment. Materialize the minimal row first.
    env.DB_META.prepare(
      "INSERT INTO users (uid, created_at, updated_at) VALUES (?1,?2,?2) ON CONFLICT(uid) DO NOTHING",
    ).bind(ctx.uid, now),
    // release any previous active number of this account back to the pool
    env.DB_META.prepare("UPDATE avatok_numbers SET status='released', uid=NULL, released_at=?2, updated_at=?2 WHERE uid=?1 AND status='active'").bind(ctx.uid, now),
    // claim the new number
    env.DB_META.prepare(
      `INSERT INTO avatok_numbers (number, country, uid, display, status, claimed_at, updated_at)
       VALUES (?1,?2,?3,?4,'active',?5,?5)
       ON CONFLICT(number) DO UPDATE SET uid=?3, country=?2, display=?4, status='active', claimed_at=?5, released_at=NULL, updated_at=?5`,
    ).bind(r.number, r.plan.iso2, ctx.uid, disp, now),
    // set as the user's network identity; real phone is hidden (not searchable)
    // [PIVOT-NUMBER-PRIVACY-1] Mark source='generated' — a genuine AvaTOK-minted
    // identity, publicly resolvable by digits in addResolve() below. Overwritten
    // on every mint so a prior 'own' (unverified) claim can't leak forward.
    env.DB_META.prepare(
      // number_norm = last 10 digits → indexed, format-tolerant number search.
      "UPDATE users SET avatok_number=?2, avatok_number_display=?3, number_norm=substr(?2,-10), phone_discoverable=0, free_number_used=1, share_token=COALESCE(share_token,?4), avatok_number_source='generated', updated_at=?5 WHERE uid=?1",
    ).bind(ctx.uid, r.number, disp, crypto.randomUUID().replace(/-/g, ""), now),
    // clear any reservation
    env.DB_META.prepare("DELETE FROM number_reservations WHERE number=?1").bind(r.number),
  ];
  await env.DB_META.batch(stmts);

  analytics(env, prev ? "number_changed" : "number_assigned", ctx.uid, {
    country: r.plan.iso2, country_name: r.plan.name, country_dial: r.plan.dial,
    number: r.number, display: disp, nsn: r.nsn,
    previous: prev?.number ?? null, replaced_previous: !!prev,
    tier, is_free: !paid(tier), had_real_phone: !!hadReal?.phone_hash,
    is_first_number: !prev && !hadReal?.avatok_number,
  }, req);
  if (hadReal?.phone_hash && !hadReal.avatok_number) {
    analytics(env, "private_number_replaced", ctx.uid, { country: r.plan.iso2, tier }, req);
  }
  return json({ ok: true, number: r.number, display: disp });
}

// POST /api/number/assign-own {country, number} — auth. "Use my own number": the
// user supplies a real number they want to represent them (e.g. a business that
// doesn't need privacy). Per owner decision (2026-06-27) this is NOT ownership-
// verified — it is format-validated only and bound as the user's AvaTOK identity.
// AvaTOK numbers never touch the PSTN, so this is an in-app label, not a carrier
// claim. In-network uniqueness is still enforced. Unlike minting, this does NOT
// hide the real phone (a business sharing its own number WANTS it visible).
export async function assignOwn(req: Request, env: Env): Promise<Response> {
  if (!(await featureOn(env))) return json({ error: "number_feature_off" }, 503);
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  await ensureNumberSourceCol(env); // [PIVOT-NUMBER-PRIVACY-1]
  const tier = await tierOf(env, ctx.uid);
  // Same free allowance as minting: a free account gets ONE number total (mint OR
  // bring-your-own); paid can change freely.
  if (!paid(tier)) {
    const u = await metaSession(env).prepare(
      "SELECT free_number_used, avatok_number FROM users WHERE uid=?1",
    ).bind(ctx.uid).first<{ free_number_used: number | null; avatok_number: string | null }>();
    if ((u?.free_number_used ?? 0) === 1 || (u?.avatok_number ?? "")) {
      analytics(env, "number_regen_blocked_free", ctx.uid, { tier, reason: "free_already_used", kind: "own" }, req);
      return json({ error: "upgrade_required" }, 402);
    }
  }
  const body = (await req.json().catch(() => ({}))) as { country?: string; number?: string; nsn?: string };
  const plan = planFor(body.country || "");
  if (!plan) return json({ error: "unsupported_country" }, 400);
  let nsn = (body.nsn || "").replace(/[^0-9]/g, "");
  if (!nsn && body.number) {
    const digits = (body.number || "").replace(/[^0-9]/g, "");
    nsn = digits.startsWith(plan.dial) ? digits.slice(plan.dial.length) : digits;
  }
  if (!validOwnNsn(plan, nsn)) {
    analytics(env, "number_assign_failed", ctx.uid, { reason: "invalid_own_number", country: plan.iso2, tier, kind: "own" }, req);
    return json({ error: "invalid_number" }, 400);
  }
  const number = canonical(plan, nsn);
  const disp = display(plan, nsn);
  const db = metaSession(env);
  if (await isTaken(db, number, ctx.uid)) {
    analytics(env, "number_assign_failed", ctx.uid, { reason: "number_taken", country: plan.iso2, number, tier, kind: "own" }, req);
    return json({ error: "number_taken" }, 409);
  }
  const now = Date.now();
  const prev = await env.DB_META.prepare("SELECT number FROM avatok_numbers WHERE uid=?1 AND status='active'").bind(ctx.uid).first<{ number: string }>();
  await env.DB_META.batch([
    // [NUMBER-ONBOARD-PERSIST-1] Keep BYO-number assignment durable even when
    // onboarding has not posted the profile row yet.
    env.DB_META.prepare(
      "INSERT INTO users (uid, created_at, updated_at) VALUES (?1,?2,?2) ON CONFLICT(uid) DO NOTHING",
    ).bind(ctx.uid, now),
    env.DB_META.prepare("UPDATE avatok_numbers SET status='released', uid=NULL, released_at=?2, updated_at=?2 WHERE uid=?1 AND status='active'").bind(ctx.uid, now),
    env.DB_META.prepare(
      `INSERT INTO avatok_numbers (number, country, uid, display, status, claimed_at, updated_at)
       VALUES (?1,?2,?3,?4,'active',?5,?5)
       ON CONFLICT(number) DO UPDATE SET uid=?3, country=?2, display=?4, status='active', claimed_at=?5, released_at=NULL, updated_at=?5`,
    ).bind(number, plan.iso2, ctx.uid, disp, now),
    // [PIVOT-NUMBER-PRIVACY-1] Mark source='own': this binding is FORMAT-VALIDATED
    // ONLY, not ownership-verified (phone OTP has been unrouted since 2026-07-10 —
    // there is currently no verification mechanism at all). A user can type in
    // ANY well-formatted number here, including a real person's — see
    // Specs/PIVOT-2026-08-27-MARKETPLACE-FIRST-PAID-SESSIONS.md §8.2. addResolve()
    // below refuses to publicly resolve an 'own'-sourced number by digits (the
    // ?n= lookup) so a stranger cannot be "found" by typing in a claimed number.
    // The binding itself is kept (not rejected outright) so an existing user who
    // already bound their own business number does not lose their identity or
    // get bounced by a hard error — only its public-by-digits discoverability is
    // removed. The account's own share-card/QR token flow (an explicit, chosen
    // share — not an anonymous digit guess) is unaffected.
    env.DB_META.prepare(
      "UPDATE users SET avatok_number=?2, avatok_number_display=?3, number_norm=substr(?2,-10), free_number_used=1, share_token=COALESCE(share_token,?4), avatok_number_source='own', updated_at=?5 WHERE uid=?1",
    ).bind(ctx.uid, number, disp, crypto.randomUUID().replace(/-/g, ""), now),
    env.DB_META.prepare("DELETE FROM number_reservations WHERE number=?1").bind(number),
  ]);
  analytics(env, prev ? "number_changed" : "number_assigned", ctx.uid, {
    country: plan.iso2, country_name: plan.name, country_dial: plan.dial,
    number, display: disp, nsn, previous: prev?.number ?? null, replaced_previous: !!prev,
    tier, is_free: !paid(tier), kind: "own", publicly_resolvable_by_number: false,
  }, req);
  return json({ ok: true, number, display: disp });
}

// POST /api/number/purchase {country, nsn|number} — auth. [PIVOT-PAID-NUMBER-1]
//
// Lets a FREE-TIER account buy a SPECIFIC vanity/short AvaTOK number with
// tokens (1 token = ₹1), without a subscription — a path that runs ALONGSIDE
// the existing tier-gated reserve()/assign() flow above (that path is
// untouched; a paid-tier account should keep using assign() directly, which
// is free for them). Requires an active reservation for this exact number
// held by this uid (POST /api/number/reserve — same RESERVE_TTL_MS hold used
// by the tier path), so a purchase can't race a browsing session onto a
// number someone else is mid-checkout on.
//
// Pricing: `avatokVanityNumberTokens` in config.ts, default 0. Fails CLOSED
// when unpriced ("not for sale") — mirrors how telephony_tiers/virtual_lines
// treat an unconfigured rate. Never free.
//
// Charge pattern copied VERBATIM from virtualDidPurchase
// (worker/src/routes/virtual_lines.ts:109-138): a stable opId, chargeAmount
// with a 402 insufficient_balance on failure, and refund-on-failure via a
// DISTINCT `${opId}:refund` op id.
//
// Improvement over that template: these numbers are pure-virtual (no PSTN,
// no external provider call), so the only post-charge failure mode is the D1
// write itself. virtualDidPurchase's equivalent branch returns
// `ownership_record_failed` and leaves the charge for MANUAL reconciliation
// (a `console.error` "reconciliation required" and nothing more). Here we
// instead REFUND IMMEDIATELY on that D1 failure, exactly like the
// provider-call failure branch above it — the user is never left having paid
// for a number they don't have.
export async function purchaseVanity(req: Request, env: Env): Promise<Response> {
  if (!(await featureOn(env))) return json({ error: "number_feature_off" }, 503);
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  await ensureNumberSourceCol(env); // [PIVOT-PAID-NUMBER-1] same column as assign()/assignOwn()
  const cfg = await readConfig(env);
  const price = cfg.avatokVanityNumberTokens;
  // Fail CLOSED: 0 (or any non-positive/misconfigured value) means "not for
  // sale" — never treat an unpriced flag as free.
  if (!(Number.isFinite(price) && price > 0)) {
    return json({ error: "vanity_purchase_disabled" }, 503);
  }
  const body = (await req.json().catch(() => ({}))) as any;
  const r = resolveInput(req, body);
  if (!r) {
    analytics(env, "number_purchase_failed", ctx.uid, { reason: "invalid_number", country: (body?.country ?? null) }, req);
    return json({ error: "invalid_number" }, 400);
  }
  const db = metaSession(env);
  // Require this account to be holding the SAME reservation it took out via
  // POST /api/number/reserve — this is the "reuse the reserve TTL hold"
  // handoff: purchase can only finalize a number this uid already has a live
  // hold on, not an arbitrary un-reserved number.
  const now = Date.now();
  const res = await env.DB_META.prepare(
    "SELECT uid, expires_at FROM number_reservations WHERE number=?1",
  ).bind(r.number).first<{ uid: string; expires_at: number }>();
  if (!res || res.uid !== ctx.uid || res.expires_at <= now) {
    analytics(env, "number_purchase_failed", ctx.uid, { reason: "reservation_expired", country: r.plan.iso2, number: r.number }, req);
    return json({ error: "reservation_expired" }, 409);
  }
  if (await isTaken(db, r.number, ctx.uid)) {
    analytics(env, "number_purchase_failed", ctx.uid, { reason: "number_taken", country: r.plan.iso2, number: r.number }, req);
    return json({ error: "number_taken" }, 409);
  }

  const opId = `avatok_vanity:${ctx.uid}:${r.number}`;
  const charge = await chargeAmount(env, ctx.uid, "avatok_vanity_number", price, opId);
  if (!charge.ok) {
    analytics(env, "number_purchase_failed", ctx.uid, { reason: charge.reason ?? "charge_failed", country: r.plan.iso2, number: r.number, price }, req);
    return json({ error: charge.reason === "insufficient" ? "insufficient_balance" : "charge_failed", balance: charge.balance }, 402);
  }

  const disp = display(r.plan, r.nsn);
  const prev = await env.DB_META.prepare("SELECT number FROM avatok_numbers WHERE uid=?1 AND status='active'").bind(ctx.uid).first<{ number: string }>();
  const hadReal = await env.DB_META.prepare("SELECT phone_hash, avatok_number FROM users WHERE uid=?1").bind(ctx.uid).first<{ phone_hash: string | null; avatok_number: string | null }>();

  // Same commit shape as assign() above — claim the number, replace the
  // account's public identity, clear the reservation.
  const stmts = [
    env.DB_META.prepare(
      "INSERT INTO users (uid, created_at, updated_at) VALUES (?1,?2,?2) ON CONFLICT(uid) DO NOTHING",
    ).bind(ctx.uid, now),
    env.DB_META.prepare("UPDATE avatok_numbers SET status='released', uid=NULL, released_at=?2, updated_at=?2 WHERE uid=?1 AND status='active'").bind(ctx.uid, now),
    env.DB_META.prepare(
      `INSERT INTO avatok_numbers (number, country, uid, display, status, claimed_at, updated_at)
       VALUES (?1,?2,?3,?4,'active',?5,?5)
       ON CONFLICT(number) DO UPDATE SET uid=?3, country=?2, display=?4, status='active', claimed_at=?5, released_at=NULL, updated_at=?5`,
    ).bind(r.number, r.plan.iso2, ctx.uid, disp, now),
    env.DB_META.prepare(
      "UPDATE users SET avatok_number=?2, avatok_number_display=?3, number_norm=substr(?2,-10), phone_discoverable=0, free_number_used=1, share_token=COALESCE(share_token,?4), avatok_number_source='generated', updated_at=?5 WHERE uid=?1",
    ).bind(ctx.uid, r.number, disp, crypto.randomUUID().replace(/-/g, ""), now),
    env.DB_META.prepare("DELETE FROM number_reservations WHERE number=?1").bind(r.number),
  ];

  try {
    await env.DB_META.batch(stmts);
  } catch (e) {
    // [PIVOT-PAID-NUMBER-1] Charge succeeded, D1 write failed. Unlike
    // virtualDidPurchase's `ownership_record_failed` (manual reconciliation,
    // no refund), refund immediately — there is no external provider state to
    // reconcile here, so nothing is lost by reversing the charge right away.
    try {
      await walletOp(env, ctx.uid, {
        op: "credit", uid: ctx.uid, amount: price, type: "refund", app_name: "avatok_vanity_number",
        ref: opId, op_id: `${opId}:refund`,
        ledger: { debit: "platform:fees", credit: `user:${ctx.uid}`, type: "avatok_vanity_refund", ref: opId },
      });
    } catch {
      console.error("[number] vanity purchase refund reconciliation required", ctx.uid, r.number, String(e));
    }
    analytics(env, "number_purchase_failed", ctx.uid, { reason: "write_failed", country: r.plan.iso2, number: r.number, price, refunded: true }, req);
    return json({ error: "purchase_failed", refunded: true, detail: String(e).slice(0, 120) }, 502);
  }

  analytics(env, prev ? "number_purchased_changed" : "number_purchased", ctx.uid, {
    country: r.plan.iso2, country_name: r.plan.name, country_dial: r.plan.dial,
    number: r.number, display: disp, nsn: r.nsn, price_tokens: price,
    previous: prev?.number ?? null, replaced_previous: !!prev, had_real_phone: !!hadReal?.phone_hash,
  }, req);
  return json({ ok: true, number: r.number, display: disp, charged: price });
}

// GET /api/number/me — current account's number + entitlement (restore/display).
export async function me(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const tier = await tierOf(env, ctx.uid);
  // Read from the PRIMARY (not a session/replica): this is the gate's source of
  // truth right after assigning a number in a previous request, and a lagged
  // replica here made the app re-ask for a number it had just set (loop bug,
  // owner report 2026-06-27).
  let r = await metaDb(env).prepare("SELECT avatok_number, avatok_number_display, free_number_used FROM users WHERE uid=?1").bind(ctx.uid).first<{ avatok_number: string | null; avatok_number_display: string | null; free_number_used: number | null }>();
  // [NUMBER-ONBOARD-PERSIST-1] Recover assignments made before the profile row
  // existed. Older onboarding could successfully claim avatok_numbers while the
  // follow-up UPDATE users affected zero rows, leaving the account stuck in this
  // gate forever. The active number table is the durable assignment authority;
  // repair the directory row before returning the result.
  if (!r?.avatok_number) {
    const active = await metaDb(env).prepare(
      "SELECT number, display FROM avatok_numbers WHERE uid=?1 AND status='active' ORDER BY claimed_at DESC LIMIT 1",
    ).bind(ctx.uid).first<{ number: string; display: string }>();
    if (active?.number) {
      const now = Date.now();
      await metaDb(env).batch([
        env.DB_META.prepare(
          "INSERT INTO users (uid, created_at, updated_at) VALUES (?1,?2,?2) ON CONFLICT(uid) DO NOTHING",
        ).bind(ctx.uid, now),
        env.DB_META.prepare(
          "UPDATE users SET avatok_number=?2, avatok_number_display=?3, number_norm=substr(?2,-10), phone_discoverable=0, free_number_used=1, share_token=COALESCE(share_token,?4), updated_at=?5 WHERE uid=?1",
        ).bind(ctx.uid, active.number, active.display, crypto.randomUUID().replace(/-/g, ""), now),
      ]);
      analytics(env, "number_assignment_repaired", ctx.uid, { number: active.number, display: active.display }, req);
      r = { avatok_number: active.number, avatok_number_display: active.display, free_number_used: 1 };
    }
  }
  // can_generate: free accounts may claim their ONE number; paid accounts always.
  const canGenerate = paid(tier) || ((r?.free_number_used ?? 0) === 0 && !(r?.avatok_number ?? ""));
  return json({ entitled: paid(tier), tier, number: r?.avatok_number ?? null, display: r?.avatok_number_display ?? null, feature: await featureOn(env), can_generate: canGenerate });
}

// POST /api/number/share-card — auth. The client (which holds the raw phone/email)
// posts the card the user CHOSE to share when they open their QR / tap Share. We
// persist it keyed by a stable, NON-EXPIRING share_token so the QR resolves
// server-side.
//
// [PIVOT-NUMBER-MASK-1] (2026-08-28) This used to read "Paid users share their
// AvaTOK number; free users their real number" and trust whatever `number` the
// CLIENT posted — free-tier clients were sending the user's raw real phone
// number here, so the "opposite" branch was really just "the server never
// checked, and one client path filled in the real number for free users."
// That is the marketplace-pivot's highest-severity leak: it publishes the real
// phone number of every free user via the share card / QR.
//
// Fix: the AvaTOK number is the public identity for EVERYONE, paid or free.
// The server now resolves the number ITSELF from the account's own
// avatok_number row and ignores any `number` the client posts — a client can
// no longer smuggle a real number onto the public card. If the account has no
// AvaTOK number yet, this fails CLOSED (409) rather than falling back to the
// real number. `plan` is kept in the response for wire compatibility (older
// clients read it) but no longer selects which number gets shared.
export async function shareCardPut(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const tier = await tierOf(env, ctx.uid);
  // [PIVOT-NUMBER-MASK-1] Resolve the public number from the account itself —
  // never from client input. This is the one legitimate source of a number
  // for the share card: whatever is bound in avatok_numbers / users.avatok_number
  // (generated free/paid number, or a verified "own" number a paid user
  // registered — both are already the account's OWN public identity, not an
  // arbitrary string a client can inject).
  const acct = await metaDb(env).prepare(
    "SELECT avatok_number, avatok_number_display FROM users WHERE uid=?1",
  ).bind(ctx.uid).first<{ avatok_number: string | null; avatok_number_display: string | null }>();
  if (!acct?.avatok_number) {
    // Fail CLOSED: no AvaTOK number assigned yet → no share card, never the
    // real number as a fallback.
    return json({ error: "no_avatok_number" }, 409);
  }
  const publicNumber = (acct.avatok_number_display && acct.avatok_number_display.trim()) || acct.avatok_number;
  const card = {
    firstName: String(b.firstName || "").trim().slice(0, 60),
    lastName: String(b.lastName || "").trim().slice(0, 60),
    email: String(b.email || "").trim().slice(0, 160),
    number: publicNumber.trim().slice(0, 40),
    plan: paid(tier) ? "paid" : "free",
  };
  const token = crypto.randomUUID().replace(/-/g, "");
  await env.DB_META.prepare(
    `UPDATE users SET share_card=?2,
       first_name=COALESCE(NULLIF(?3,''),first_name), last_name=COALESCE(NULLIF(?4,''),last_name),
       share_token=COALESCE(share_token,?5), updated_at=?6 WHERE uid=?1`,
  ).bind(ctx.uid, JSON.stringify(card), card.firstName, card.lastName, token, Date.now()).run();
  const row = await metaSession(env).prepare("SELECT share_token FROM users WHERE uid=?1").bind(ctx.uid).first<{ share_token: string }>();
  const t = row?.share_token ?? token;
  analytics(env, "qr_shown", ctx.uid, {
    plan: card.plan, has_email: !!card.email, has_number: !!card.number,
    has_name: !!(card.firstName || card.lastName),
  }, req);
  return json({ ok: true, token: t, link: `https://avatok.ai/add?t=${t}` });
}

// GET /api/add?t=<token> — PUBLIC. Resolves a QR share token to the sharer's
// contact card. Tokens are random + non-enumerable; respects who_can_add.
export async function addResolve(req: Request, env: Env): Promise<Response> {
  if (!(await featureOn(env))) return json({ error: "number_feature_off" }, 503);
  const url = new URL(req.url);
  const t = (url.searchParams.get("t") || "").replace(/[^a-f0-9]/gi, "").slice(0, 64);
  // Add-by-number (?n=<digits>) — a contact's QR encodes their PUBLIC AvaTOK
  // number; resolve it to the owner's card so others can add them. Respects
  // who_can_add. No share token needed. (Owner request 2026-06-29.)
  const nRaw = url.searchParams.get("n") || "";
  if (!t && nRaw) {
    const digits = nRaw.replace(/[^0-9]/g, "").slice(0, 20);
    if (!digits) return json({ error: "bad_number" }, 400);
    await ensureNumberSourceCol(env); // [PIVOT-NUMBER-PRIVACY-1]
    const r = await metaSession(env).prepare(
      "SELECT uid, display_name, avatar_url, share_card, who_can_add, avatok_number_source FROM users WHERE avatok_number=?1 LIMIT 1",
    ).bind(digits).first<any>();
    // [PIVOT-NUMBER-PRIVACY-1] An 'own'-sourced number is UNVERIFIED — the user
    // format-validated it via assign-own with no proof of ownership (see the
    // comment on assignOwn()/assign() above). Anyone could have claimed a real
    // person's phone number this way. This public, anonymous, guess-a-digit-
    // string lookup must never resolve one — treat it exactly like "not found"
    // (fail CLOSED). The account itself keeps the number (no data loss); only
    // this anonymous public resolution path is blocked. The consent-based
    // share_token (?t=) path below is untouched — that requires the owner to
    // have deliberately shared their own QR/link, not a stranger guessing digits.
    if (!r || r.avatok_number_source === "own") {
      analytics(env, "qr_resolve_failed", r?.uid ?? "anon", { reason: r ? "unverified_own_number" : "number_not_found" }, req);
      return json({ error: "not_found" }, 404);
    }
    if (r.who_can_add === "nobody") { analytics(env, "qr_resolve_failed", r.uid, { reason: "adds_disabled" }, req); return json({ error: "adds_disabled" }, 403); }
    analytics(env, "qr_resolved", r.uid, { by: "number", who_can_add: r.who_can_add ?? "everyone" }, req);
    let card: any = {};
    try { card = r.share_card ? JSON.parse(r.share_card) : {}; } catch { /* malformed → empty */ }
    const name = (r.display_name && String(r.display_name).trim()) || `${card.firstName || ""} ${card.lastName || ""}`.trim();
    return json({ uid: r.uid, name, avatar_url: r.avatar_url ?? null, card });
  }
  if (!t) return json({ error: "bad_token" }, 400);
  const r = await metaSession(env).prepare(
    "SELECT uid, display_name, avatar_url, share_card, who_can_add FROM users WHERE share_token=?1",
  ).bind(t).first<any>();
  if (!r) { analytics(env, "qr_resolve_failed", "anon", { reason: "not_found" }, req); return json({ error: "not_found" }, 404); }
  if (r.who_can_add === "nobody") { analytics(env, "qr_resolve_failed", r.uid, { reason: "adds_disabled" }, req); return json({ error: "adds_disabled" }, 403); }
  analytics(env, "qr_resolved", r.uid, { who_can_add: r.who_can_add ?? "everyone" }, req);
  let card: any = {};
  try { card = r.share_card ? JSON.parse(r.share_card) : {}; } catch { /* malformed → empty */ }
  const name = (r.display_name && String(r.display_name).trim()) || `${card.firstName || ""} ${card.lastName || ""}`.trim();
  return json({ uid: r.uid, name, avatar_url: r.avatar_url ?? null, card });
}

// [LASTSEEN-PRIVACY-1] Lazy column add for the last-seen visibility setting —
// same pattern as receptionist.ts ensureStatusColumns: ALTER TABLE is idempotent
// via the duplicate-column catch, so no deploy-time migration step is needed.
// last_seen_visibility: everyone | contacts | list | nobody (default everyone).
// last_seen_allow: JSON array of uids — the allow set for 'contacts' (synced
// from the client's on-device address book, uids only) and 'list' (hand-picked).
let lastSeenColsEnsured = false;
async function ensureLastSeenCols(env: Env): Promise<void> {
  if (lastSeenColsEnsured) return;
  for (const ddl of [
    "ALTER TABLE users ADD COLUMN last_seen_visibility TEXT",
    "ALTER TABLE users ADD COLUMN last_seen_allow TEXT",
  ]) {
    try { await env.DB_META.prepare(ddl).run(); } catch { /* already exists */ }
  }
  lastSeenColsEnsured = true;
}

// GET /api/number/privacy — auth. Current discoverability settings.
export async function privacyGet(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  await ensureLastSeenCols(env);
  const r = await metaSession(env).prepare("SELECT phone_discoverable, email_discoverable, who_can_add, last_seen_visibility, last_seen_allow FROM users WHERE uid=?1").bind(ctx.uid).first<any>();
  let allow: string[] = [];
  try { const a = JSON.parse(r?.last_seen_allow ?? "[]"); if (Array.isArray(a)) allow = a.map(String); } catch { /* corrupt → empty */ }
  return json({
    phone_discoverable: !!(r?.phone_discoverable),
    email_discoverable: r ? r.email_discoverable !== 0 : true,
    who_can_add: r?.who_can_add ?? "everyone",
    last_seen_visibility: r?.last_seen_visibility ?? "everyone",
    last_seen_allow: allow,
  });
}

// POST /api/number/privacy {phone_discoverable?, email_discoverable?, who_can_add?,
// last_seen_visibility?, last_seen_allow?} — auth.
export async function privacySet(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  await ensureLastSeenCols(env);
  const b = (await req.json().catch(() => ({}))) as any;
  const who = ["everyone", "number_only", "nobody"].includes(b.who_can_add) ? b.who_can_add : null;
  // [LASTSEEN-PRIVACY-1] WhatsApp-style visibility. 'contacts' and 'list' both
  // enforce against last_seen_allow (uids only — never phone numbers/emails, per
  // the 2026-06-27 privacy rule). Allow list capped at 1000 uids.
  const lsv = ["everyone", "contacts", "list", "nobody"].includes(b.last_seen_visibility)
    ? b.last_seen_visibility : null;
  const lsAllow = Array.isArray(b.last_seen_allow)
    ? JSON.stringify(b.last_seen_allow.map((u: unknown) => String(u).slice(0, 128)).slice(0, 1000))
    : null;
  await env.DB_META.prepare(
    `UPDATE users SET phone_discoverable=COALESCE(?2,phone_discoverable),
       email_discoverable=COALESCE(?3,email_discoverable), who_can_add=COALESCE(?4,who_can_add),
       last_seen_visibility=COALESCE(?6,last_seen_visibility),
       last_seen_allow=COALESCE(?7,last_seen_allow), updated_at=?5 WHERE uid=?1`,
  ).bind(
    ctx.uid,
    typeof b.phone_discoverable === "boolean" ? (b.phone_discoverable ? 1 : 0) : null,
    typeof b.email_discoverable === "boolean" ? (b.email_discoverable ? 1 : 0) : null,
    who, Date.now(), lsv, lsAllow,
  ).run();
  analytics(env, "discoverability_changed", ctx.uid, {
    who_can_add: who, phone: b.phone_discoverable, email: b.email_discoverable,
    last_seen_visibility: lsv,
  }, req);
  return json({ ok: true });
}

// POST /api/number/private { number?, show? } — auth. Register/clear the user's
// OPTIONAL private number. `private_number` stores RAW real-phone digits.
//
// [PIVOT-NUMBER-PRIVACY-1] (2026-08-28) This used to accept a client-supplied
// `show` flag and, when true, set `show_private_number=1` — which api.ts's
// dialpad resolve (`SELECT uid FROM users WHERE show_private_number=1 AND
// private_number=?1`) and the share card treated as permission to expose the
// RAW real number publicly. Under the marketplace-pivot rule every real number
// is masked behind the AvaTOK number and shown to NOBODY, with no opt-out —
// so `private_number` must be permanently NON-EXPOSABLE regardless of what the
// client asks for. The column and field name are kept (dropping them is a
// separate migration, out of scope, and would break shipped clients reading
// this field), but `show_private_number` is now UNCONDITIONALLY forced to 0
// here — the client's `show` input is accepted for wire compatibility (still
// read, still doesn't error) but no longer has any effect. This fails CLOSED:
// no code path in this file can ever write a 1 into show_private_number again,
// so api.ts's exposure query can no longer match for numbers set from here.
// (A row that already had show_private_number=1 from before this fix is only
// corrected the next time the user hits this endpoint again; a full closure
// also requires a one-time data fix in api.ts / a migration, which is out of
// scope for this file-only change — flagged in the report.)
// VERIFICATION STUB: still no phone-ownership verification (OTP unrouted since
// 2026-07-10) — see personal_phone_field.dart. Guarded so a missing migration
// returns 503 rather than 500. (Owner request 2026-06-29.)
export async function privateNumberSet(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const digits = typeof b.number === "string" ? b.number.replace(/[^0-9]/g, "").slice(0, 20) : "";
  // [PIVOT-NUMBER-PRIVACY-1] Always 0 — private_number is never exposable, no
  // matter what the client requests. `requestedShow` is telemetry-only so we
  // can see how often clients still ask for the now-dead behavior.
  const requestedShow = b.show === true && digits.length >= 6;
  const show = 0;
  try {
    await env.DB_META.prepare(
      "UPDATE users SET private_number=?2, show_private_number=?3, updated_at=?4 WHERE uid=?1",
    ).bind(ctx.uid, digits || null, show, Date.now()).run();
  } catch (e) {
    return json({ error: "schema_pending", detail: String(e).slice(0, 120) }, 503);
  }
  analytics(env, "private_number_set", ctx.uid, { show: false, requested_show: requestedShow, has_number: digits.length >= 6 }, req);
  return json({ ok: true });
}

// POST /api/number/release — voluntarily give up the current number.
export async function release(req: Request, env: Env): Promise<Response> {
  if (!(await featureOn(env))) return json({ error: "number_feature_off" }, 503);
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const now = Date.now();
  await env.DB_META.batch([
    env.DB_META.prepare("UPDATE avatok_numbers SET status='released', uid=NULL, released_at=?2, updated_at=?2 WHERE uid=?1 AND status='active'").bind(ctx.uid, now),
    env.DB_META.prepare("UPDATE users SET avatok_number=NULL, avatok_number_display=NULL, number_norm=NULL, updated_at=?2 WHERE uid=?1").bind(ctx.uid, now),
  ]);
  analytics(env, "number_released", ctx.uid, {}, req);
  return json({ ok: true });
}
