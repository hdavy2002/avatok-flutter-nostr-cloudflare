// [PRICING-1 2026-09-26, owner decision] One place to set Saathum's "starting
// from" prices, so the ritual articles and the share-card ads never go stale.
//
// The owner: "my prices keep changing. so create a backend for pricing. so when
// we change it there, we can change it on all articles, Ad card as og:image."
// And the wording is always "starting from ₹X" — the checkout adds prasad
// delivery, GST, donation, chadhava etc., so the headline is a floor, not a total.
//
//   GET /api/pricing          public, 60 s edge cache — read by every article
//                             page (client refresh), the OG card renderer and
//                             the build.
//   PUT /api/admin/pricing    admin only — the /admin/pricing screen.
//
// Shape (KV `pricing:v1` in TOKENS, same namespace as the remote-config blob):
//   { currency:'INR', havan_from:number|null, puja_from:number|null,
//     rituals:{ [slug]: number },   // per-ritual override of the floor
//     updated_at, updated_by }
// A ritual's price = rituals[slug] ?? (havan ? havan_from : puja_from). null
// means "don't print a price" (the card then just says "Join live").
//
// This is display pricing ONLY. What a buyer is charged comes from the listing
// row at checkout — nothing here moves money.
import type { Env } from "../types";
import { json } from "../util";
import { requireAdmin } from "./admin_money";
import { track } from "../hooks";

const KEY = "pricing:v1";
const MAX_PRICE = 1_000_000;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

export type Pricing = {
  currency: "INR";
  havan_from: number | null;
  puja_from: number | null;
  rituals: Record<string, number>;
  updated_at: number | null;
  updated_by: string | null;
};

/** ₹111: amounts ending in 1 are shagun. Owner-set 2026-09-26. */
export const DEFAULT_PRICING: Pricing = {
  currency: "INR", havan_from: 111, puja_from: null, rituals: {}, updated_at: null, updated_by: null,
};

function priceOrNull(v: unknown): number | null | undefined {
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > MAX_PRICE) return undefined;
  return n;
}

export async function readPricing(env: Env): Promise<Pricing> {
  try {
    const stored = (await env.TOKENS.get(KEY, "json")) as Partial<Pricing> | null;
    if (!stored) return { ...DEFAULT_PRICING };
    return {
      ...DEFAULT_PRICING,
      ...stored,
      currency: "INR",
      rituals: stored.rituals && typeof stored.rituals === "object" ? stored.rituals : {},
    };
  } catch {
    return { ...DEFAULT_PRICING };
  }
}

export async function getPricing(env: Env): Promise<Response> {
  const pricing = await readPricing(env);
  return json(pricing, 200, { "cache-control": "public, max-age=60" });
}

export async function putPricing(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return json({ error: "bad_request", message: "Send the prices as JSON." }, 400);

  const before = await readPricing(env);
  const next: Pricing = { ...before };
  for (const field of ["havan_from", "puja_from"] as const) {
    if (!(field in body)) continue;
    const v = priceOrNull(body[field]);
    if (v === undefined) return json({ error: "bad_price", field, message: `${field === "havan_from" ? "Havan" : "Puja"} price must be a whole number of rupees (or empty).` }, 400);
    next[field] = v;
  }
  if ("rituals" in body) {
    const raw = body.rituals;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return json({ error: "bad_request", field: "rituals", message: "rituals must be an object of slug → price." }, 400);
    const rituals: Record<string, number> = {};
    for (const [slug, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!SLUG_RE.test(slug)) return json({ error: "bad_slug", field: slug, message: `Unknown ritual id "${slug}".` }, 400);
      const v = priceOrNull(value);
      if (v === undefined) return json({ error: "bad_price", field: slug, message: `Price for ${slug} must be a whole number of rupees.` }, 400);
      if (v !== null) rituals[slug] = v; // null/empty clears the override
    }
    if (Object.keys(rituals).length > 500) return json({ error: "too_many", message: "Too many ritual prices." }, 400);
    next.rituals = rituals;
  }
  next.updated_at = Date.now();
  next.updated_by = a.uid;
  await env.TOKENS.put(KEY, JSON.stringify(next));

  const changed: string[] = (["havan_from", "puja_from"] as const).filter((k) => before[k] !== next[k]);
  for (const slug of new Set([...Object.keys(before.rituals), ...Object.keys(next.rituals)])) {
    if (before.rituals[slug] !== next.rituals[slug]) changed.push(slug);
  }
  try {
    await env.DB_WALLET.prepare(
      "INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
    ).bind(crypto.randomUUID(), a.uid, "pricing_update", "pricing", JSON.stringify({ before, after: next, changed }), next.updated_at).run();
  } catch { /* audit is best-effort, matching the other admin routes */ }
  try {
    await track(env, a.uid, "admin_pricing_updated", "admin_pricing", {
      admin_id: a.uid, havan_from: next.havan_from, puja_from: next.puja_from,
      ritual_overrides: Object.keys(next.rituals).length, changed: changed.join(","),
    });
  } catch { /* best-effort */ }
  return json({ ok: true, pricing: next, changed });
}
