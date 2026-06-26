// AvaTOK Number routes (Specs/AVATOK-NUMBER-FEATURE-SPEC.md §7).
//
// A purchasable, pure-virtual, country-standard, NON-PSTN number that represents a
// user in-network and maps to their Clerk uid. Bundled free on paid plans (tier>=1);
// free-tier callers get a 402 upgrade gate. Assigning a number REPLACES the user's
// real phone as their network identity (card / QR / search). Numbers are unique;
// the picker only ever offers available combinations. All gated by the
// `numberFeatureEnabled` kill switch.
import type { Env } from "../types";
import { json } from "../util";
import { metaSession } from "../db/shard";
import { requireUser, isFail } from "../authz";
import { readConfig } from "./config";
import { tierOf } from "./plans";
import { COUNTRIES, planFor, canonical, display, validNsn, generate, type CountryPlan } from "../lib/numbering";

const RESERVE_TTL_MS = 10 * 60 * 1000; // 10-minute hold while the user confirms

async function featureOn(env: Env): Promise<boolean> {
  try { return (await readConfig(env)).numberFeatureEnabled !== false; } catch { return true; }
}
function paid(tier: number): boolean { return tier >= 1; }

function analytics(env: Env, event: string, uid: string, props: Record<string, unknown>): void {
  try {
    void env.Q_ANALYTICS.send({
      event, uid, ts: Date.now(),
      props: { ...props, app_name: "avatok", service_name: "avatok-api", worker: true, account_id: uid },
    });
  } catch { /* best-effort; telemetry never blocks */ }
}

// GET /api/number/countries — public. The picker's country list.
export function countries(): Response {
  return json(
    { countries: COUNTRIES.map((c) => ({ iso2: c.iso2, name: c.name, dial: c.dial, flag: c.flag, example: display(c, c.avaPrefix.padEnd(c.nsnLen, "0")) })) },
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
  analytics(env, "number_store_opened", ctx.uid, { country: plan.iso2, pattern: pattern ? "yes" : "no", entitled: paid(tier), results: out.length });
  return json({ country: plan.iso2, entitled: paid(tier), tier, numbers: out });
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
  if (!paid(await tierOf(env, ctx.uid))) return json({ error: "upgrade_required" }, 402);
  const body = (await req.json().catch(() => ({}))) as any;
  const r = resolveInput(req, body);
  if (!r) return json({ error: "invalid_number" }, 400);
  const db = metaSession(env);
  if (await isTaken(db, r.number, ctx.uid)) return json({ error: "number_taken" }, 409);
  const expires = Date.now() + RESERVE_TTL_MS;
  await env.DB_META.prepare(
    "INSERT INTO number_reservations (number, uid, expires_at) VALUES (?1,?2,?3) ON CONFLICT(number) DO UPDATE SET uid=?2, expires_at=?3",
  ).bind(r.number, ctx.uid, expires).run();
  analytics(env, "number_reserved", ctx.uid, { country: r.plan.iso2, number: r.number });
  return json({ ok: true, number: r.number, display: display(r.plan, r.nsn), expires_at: expires });
}

// POST /api/number/assign {country, nsn} — auth + paid. Finalize + replace the
// real phone as the user's network identity.
export async function assign(req: Request, env: Env): Promise<Response> {
  if (!(await featureOn(env))) return json({ error: "number_feature_off" }, 503);
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const tier = await tierOf(env, ctx.uid);
  if (!paid(tier)) return json({ error: "upgrade_required" }, 402);
  const body = (await req.json().catch(() => ({}))) as any;
  const r = resolveInput(req, body);
  if (!r) return json({ error: "invalid_number" }, 400);
  const db = metaSession(env);
  if (await isTaken(db, r.number, ctx.uid)) return json({ error: "number_taken" }, 409);
  const now = Date.now();
  const disp = display(r.plan, r.nsn);

  // Was the user already on a number? (telemetry + release the old one)
  const prev = await env.DB_META.prepare("SELECT number FROM avatok_numbers WHERE uid=?1 AND status='active'").bind(ctx.uid).first<{ number: string }>();
  const hadReal = await env.DB_META.prepare("SELECT phone_hash, avatok_number FROM users WHERE uid=?1").bind(ctx.uid).first<{ phone_hash: string | null; avatok_number: string | null }>();

  const stmts = [
    // release any previous active number of this account back to the pool
    env.DB_META.prepare("UPDATE avatok_numbers SET status='released', uid=NULL, released_at=?2, updated_at=?2 WHERE uid=?1 AND status='active'").bind(ctx.uid, now),
    // claim the new number
    env.DB_META.prepare(
      `INSERT INTO avatok_numbers (number, country, uid, display, status, claimed_at, updated_at)
       VALUES (?1,?2,?3,?4,'active',?5,?5)
       ON CONFLICT(number) DO UPDATE SET uid=?3, country=?2, display=?4, status='active', claimed_at=?5, released_at=NULL, updated_at=?5`,
    ).bind(r.number, r.plan.iso2, ctx.uid, disp, now),
    // set as the user's network identity; real phone is hidden (not searchable)
    env.DB_META.prepare(
      "UPDATE users SET avatok_number=?2, avatok_number_display=?3, phone_discoverable=0, share_token=COALESCE(share_token,?4), updated_at=?5 WHERE uid=?1",
    ).bind(ctx.uid, r.number, disp, crypto.randomUUID().replace(/-/g, ""), now),
    // clear any reservation
    env.DB_META.prepare("DELETE FROM number_reservations WHERE number=?1").bind(r.number),
  ];
  await env.DB_META.batch(stmts);

  analytics(env, prev ? "number_changed" : "number_assigned", ctx.uid, { country: r.plan.iso2, number: r.number, previous: prev?.number ?? null });
  if (hadReal?.phone_hash && !hadReal.avatok_number) analytics(env, "private_number_replaced", ctx.uid, { country: r.plan.iso2 });
  return json({ ok: true, number: r.number, display: disp });
}

// GET /api/number/me — current account's number + entitlement (restore/display).
export async function me(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const tier = await tierOf(env, ctx.uid);
  const r = await metaSession(env).prepare("SELECT avatok_number, avatok_number_display FROM users WHERE uid=?1").bind(ctx.uid).first<{ avatok_number: string | null; avatok_number_display: string | null }>();
  return json({ entitled: paid(tier), tier, number: r?.avatok_number ?? null, display: r?.avatok_number_display ?? null, feature: await featureOn(env) });
}

// POST /api/number/release — voluntarily give up the current number.
export async function release(req: Request, env: Env): Promise<Response> {
  if (!(await featureOn(env))) return json({ error: "number_feature_off" }, 503);
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const now = Date.now();
  await env.DB_META.batch([
    env.DB_META.prepare("UPDATE avatok_numbers SET status='released', uid=NULL, released_at=?2, updated_at=?2 WHERE uid=?1 AND status='active'").bind(ctx.uid, now),
    env.DB_META.prepare("UPDATE users SET avatok_number=NULL, avatok_number_display=NULL, updated_at=?2 WHERE uid=?1").bind(ctx.uid, now),
  ]);
  analytics(env, "number_released", ctx.uid, {});
  return json({ ok: true });
}
