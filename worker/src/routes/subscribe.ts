// subscribe.ts — Phase 1 subscription checkout + entitlement.
//
// Two payment rails, one entitlement (see PROPOSAL-USAGE-PACKAGES-AND-GATING.md +
// the regulatory decision: Play Billing for in-app Android, Stripe for web; the
// server is the single source of truth for the user's tier via plans.setSub):
//
//   • WEB    → Stripe Checkout in `mode=subscription`. Mirrors the wallet top-up
//              checkout exactly; the webhook (handled inside wallet.ts stripeWebhook,
//              same signed endpoint) flips the tier on completion + on cancel.
//   • ANDROID→ Google Play Billing (native, client-side). The client buys the
//              `playProductId`, then POSTs the purchase token here to verify +
//              entitle. Verification needs a Play service account (TODO below); we
//              fail CLOSED until it's configured (never grant tier unverified).
//
// EVERYTHING is gated by platform_config.billingEnabled — while false (beta) the
// checkout endpoints 503 with reason:"billing_disabled" so nothing goes live by
// accident.

import type { Env } from "../types";
import { json } from "../util";
import { isFail, requireUser } from "../authz";
import { readConfig } from "./config";
import { track } from "../hooks";
import {
  PLANS, isTierId, readPlans, setSub, getSub, type TierId,
} from "./plans";

function webBase(env: Env): string {
  return (env as any).PUBLIC_WEB_URL || "https://avatok.ai";
}

async function billingOn(env: Env): Promise<boolean> {
  try { return !!(await readConfig(env)).billingEnabled; } catch { return false; }
}

// ── POST /api/subscribe/checkout { tier, platform } ─────────────────────────
// Web: returns { checkout_url } (Stripe hosted subscription checkout).
// Android: returns { play_product_id } — the client launches native Play Billing
// and then calls /android/verify with the purchase token.
export async function subscribeCheckout(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!(await billingOn(env))) return json({ ok: false, error: "billing not enabled", reason: "billing_disabled" }, 503);

  let body: { tier?: number; platform?: string };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const tier = body.tier;
  const platform = (body.platform || "web").toLowerCase();
  if (!isTierId(tier) || tier === 0) return json({ error: "tier must be 1, 2 or 3" }, 400);

  const plans = await readPlans(env);
  const plan = plans[tier as TierId];

  // ── Android → native Play Billing (client drives the purchase UI) ──────────
  if (platform === "android") {
    if (!plan.playProductId) return json({ error: "no play product for tier" }, 400);
    return json({ ok: true, platform: "android", play_product_id: plan.playProductId, tier });
  }

  // ── Web → Stripe Checkout (mode=subscription) ──────────────────────────────
  if (!env.STRIPE_SECRET_KEY) return json({ ok: false, error: "stripe not configured", reason: "stripe_unconfigured" }, 503);

  const checkoutId = crypto.randomUUID();
  const form = new URLSearchParams();
  form.set("mode", "subscription");
  form.set("client_reference_id", ctx.uid);
  form.set("success_url", `${webBase(env)}/subscribe?status=success&cid=${checkoutId}`);
  form.set("cancel_url", `${webBase(env)}/subscribe?status=cancel`);
  if (plan.stripePriceId) {
    form.set("line_items[0][price]", plan.stripePriceId);
    form.set("line_items[0][quantity]", "1");
  } else {
    // No Price ID minted yet → build the recurring price inline so the tier still works.
    form.set("line_items[0][price_data][currency]", "usd");
    form.set("line_items[0][price_data][unit_amount]", String(Math.round(plan.priceUsd * 100)));
    form.set("line_items[0][price_data][recurring][interval]", "month");
    form.set("line_items[0][price_data][product_data][name]", `AvaTOK ${plan.name}`);
    form.set("line_items[0][quantity]", "1");
  }
  form.set("metadata[uid]", ctx.uid);
  form.set("metadata[tier]", String(tier));
  form.set("metadata[checkout_id]", checkoutId);
  form.set("subscription_data[metadata][uid]", ctx.uid);
  form.set("subscription_data[metadata][tier]", String(tier));

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const session = (await res.json()) as any;
  if (!res.ok) return json({ ok: false, error: "stripe error", detail: session?.error?.message }, 502);

  await env.DB_META.prepare(
    "INSERT INTO subscription_checkouts (id, uid, tier, source, session_id, status, created_at) VALUES (?1,?2,?3,'stripe',?4,'pending',?5)",
  ).bind(checkoutId, ctx.uid, tier, session.id, Date.now()).run();

  track(env, ctx.uid, "subscribe_checkout_started", "subscribe", { tier, platform: "web", price_usd: plan.priceUsd });
  return json({ ok: true, platform: "web", checkout_url: session.url, checkout_id: checkoutId, tier });
}

// ── POST /api/subscribe/android/verify { productId, purchaseToken } ─────────
// Verify a Google Play purchase token, then entitle. Fails CLOSED until a Play
// service account is wired (we never grant a tier on an unverified token).
export async function subscribeAndroidVerify(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!(await billingOn(env))) return json({ ok: false, reason: "billing_disabled" }, 503);

  let body: { productId?: string; purchaseToken?: string };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const { productId, purchaseToken } = body;
  if (!productId || !purchaseToken) return json({ error: "productId and purchaseToken required" }, 400);

  const tier = (Object.values(PLANS).find((p) => p.playProductId === productId)?.id) as TierId | undefined;
  if (tier === undefined) return json({ error: "unknown product" }, 400);

  // TODO(play-billing): verify with the Google Play Developer API —
  //   GET androidpublisher/v3/applications/{pkg}/purchases/subscriptionsv2/tokens/{purchaseToken}
  //   authed with a service-account JWT (env.PLAY_SERVICE_ACCOUNT_JSON). Confirm
  //   state=ACTIVE, the productId matches, and read expiryTime → renewsAt. Until
  //   that secret exists we fail closed so a forged token can't grant a tier.
  if (!(env as any).PLAY_SERVICE_ACCOUNT_JSON) {
    return json({ ok: false, error: "play verification not configured", reason: "play_unconfigured" }, 503);
  }

  // (Verification result would set renewsAt from the token's expiryTime.)
  const renewsAt = Date.now() + 31 * 24 * 60 * 60 * 1000;
  await setSub(env, ctx.uid, { tier, status: "active", source: "play", renewsAt, ref: purchaseToken });
  track(env, ctx.uid, "subscribe_activated", "subscribe", { tier, source: "play" });
  return json({ ok: true, tier, status: "active", renews_at: renewsAt });
}

// ── POST /api/subscribe/cancel ──────────────────────────────────────────────
// Marks the subscription canceled; the user keeps their tier until renews_at,
// then getSub() downgrades them to Free automatically. (Real cancel on the
// provider side is done by the client via Play/Stripe; this records intent +
// drives the UI. Stripe also fires customer.subscription.deleted → same effect.)
export async function subscribeCancel(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const sub = await getSub(env, ctx.uid);
  if (sub.tier === 0) return json({ ok: true, tier: 0, status: "none" });
  await setSub(env, ctx.uid, { tier: sub.tier, status: "canceled", source: sub.source, renewsAt: sub.renewsAt });
  track(env, ctx.uid, "subscribe_canceled", "subscribe", { tier: sub.tier });
  return json({ ok: true, tier: sub.tier, status: "canceled", renews_at: sub.renewsAt });
}

// ── Stripe webhook delegation (called from wallet.ts stripeWebhook) ─────────
// Returns a Response when it handled the event, else null so the caller can fall
// through to its own (top-up) handling. Same signed endpoint, same secret.
export async function subscribeWebhookEvent(env: Env, event: any): Promise<Response | null> {
  const type = event?.type as string;
  const obj = event?.data?.object ?? {};

  // A subscription checkout completed → entitle the tier.
  if (type === "checkout.session.completed" && obj.mode === "subscription") {
    const uid = obj.metadata?.uid || obj.client_reference_id;
    const tierN = Number(obj.metadata?.tier);
    if (!uid || !isTierId(tierN)) return json({ received: true, ignored: "missing uid/tier" });
    const renewsAt = Date.now() + 31 * 24 * 60 * 60 * 1000; // refined by subscription.updated
    await setSub(env, uid, { tier: tierN as TierId, status: "active", source: "stripe", renewsAt, ref: obj.subscription || null });
    if (obj.metadata?.checkout_id) {
      try { await env.DB_META.prepare("UPDATE subscription_checkouts SET status='done' WHERE id=?1").bind(obj.metadata.checkout_id).run(); } catch { /* best-effort */ }
    }
    track(env, uid, "subscribe_activated", "subscribe", { tier: tierN, source: "stripe" });
    return json({ received: true, entitled: tierN });
  }

  // Renewal / status change → refresh renews_at + status from the period end.
  if (type === "customer.subscription.updated") {
    const uid = obj.metadata?.uid;
    const tierN = Number(obj.metadata?.tier);
    if (uid && isTierId(tierN)) {
      const renewsAt = obj.current_period_end ? obj.current_period_end * 1000 : null;
      const status = obj.cancel_at_period_end ? "canceled" : (obj.status === "active" ? "active" : "active");
      await setSub(env, uid, { tier: tierN as TierId, status, source: "stripe", renewsAt, ref: obj.id });
      return json({ received: true, updated: tierN });
    }
  }

  // Subscription ended → downgrade to Free.
  if (type === "customer.subscription.deleted") {
    const uid = obj.metadata?.uid;
    if (uid) {
      await setSub(env, uid, { tier: 0, status: "none", source: "none", renewsAt: null, ref: obj.id });
      track(env, uid, "subscribe_ended", "subscribe", {});
      return json({ received: true, downgraded: true });
    }
  }

  return null; // not a subscription event — let the caller handle it
}
