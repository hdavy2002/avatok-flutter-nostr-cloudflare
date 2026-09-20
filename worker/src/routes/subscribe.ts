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
  PLANS, isTierId, setSub, getSub, type TierId,
} from "./plans";
import { verifyPlaySubscription } from "../play";

async function billingOn(env: Env): Promise<boolean> {
  return false;
}

// ── POST /api/subscribe/checkout { tier, platform } ─────────────────────────
// Web: returns { checkout_url } (Stripe hosted subscription checkout).
// Android: returns { play_product_id } — the client launches native Play Billing
// and then calls /android/verify with the purchase token.
export async function subscribeCheckout(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const cfg = await readConfig(env);
  if (!(cfg as any).subscriptionPlansEnabled) {
    return json({ ok: false, error: "subscription plans disabled", reason: "subscription_plans_disabled" }, 503);
  }
  return json({ ok: false, error: "payments disabled", reason: "payments_disabled" }, 503);
}

// ── POST /api/subscribe/android/verify { productId, purchaseToken } ─────────
// Verify a Google Play purchase token, then entitle. Fails CLOSED until a Play
// service account is wired (we never grant a tier on an unverified token).
export async function subscribeAndroidVerify(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const cfg = await readConfig(env);
  if (!(cfg as any).subscriptionPlansEnabled) {
    return json({ ok: false, error: "subscription plans disabled", reason: "subscription_plans_disabled" }, 503);
  }
  if (!(await billingOn(env))) return json({ ok: false, error: "payments disabled", reason: "payments_disabled" }, 503);

  let body: { productId?: string; purchaseToken?: string };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const { productId, purchaseToken } = body;
  if (!productId || !purchaseToken) return json({ error: "productId and purchaseToken required" }, 400);

  const tier = (Object.values(PLANS).find((p) => p.playProductId === productId)?.id) as TierId | undefined;
  if (tier === undefined) return json({ error: "unknown product" }, 400);

  // Fail CLOSED until the service account is wired (forged token can't grant a tier).
  if (!(env as any).PLAY_SERVICE_ACCOUNT_JSON) {
    return json({ ok: false, error: "play verification not configured", reason: "play_unconfigured" }, 503);
  }

  // Verify the token against the Google Play Developer API (purchases.subscriptionsv2).
  const v = await verifyPlaySubscription(env, purchaseToken);
  if (!v.ok) {
    track(env, ctx.uid, "subscribe_verify_failed", "subscribe", { tier, source: "play", reason: v.reason });
    return json({ ok: false, error: "play verification failed", reason: v.reason }, 502);
  }
  // The token must be paid/active AND map to the product the client claimed.
  if (!v.entitled || (v.productId && v.productId !== productId)) {
    track(env, ctx.uid, "subscribe_verify_rejected", "subscribe", { tier, state: v.state, product: v.productId });
    return json({ ok: false, error: "purchase not active", reason: v.state || "not_entitled" }, 402);
  }

  const renewsAt = v.expiryMs ?? Date.now() + 31 * 24 * 60 * 60 * 1000;
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
