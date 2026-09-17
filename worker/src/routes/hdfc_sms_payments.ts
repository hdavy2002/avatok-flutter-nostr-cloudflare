// [PAY-HDFC-SMS-1] Private single-account UPI checkout. The companion phone sends
// signed HDFC credit SMS evidence; this route is the only place that interprets it.
import type { Env } from "../types";
import { requireUser, isFail } from "../authz";
import { metaDb } from "../db/shard";
import { json } from "../util";
import { readConfig } from "./config";
import { bookability } from "../lib/listing_schedule";
import { hmacSha256Hex, sha256Hex, constantTimeEqual } from "../lib/payments/types";
import { provisionFromGatewayPurchase, quoteCommercialPurchase, freezeCommercialPurchaseQuote } from "./commercial_checkout";

// Deliberately isolated smoke-test listing. It exercises the real signed SMS
// path with a ₹1 final charge without changing normal commercial pricing.
export const UPI_SMOKE_TEST_LISTING_ID = "avatok-upi-smoke-2026";

const APP = "avapay";

function enabled(env: Env, config: any): boolean {
  return config.hdfcSmsEnabled === true
    && String(env.HDFC_UPI_VPA ?? "").includes("@")
    && Boolean(env.HDFC_SMS_DEVICE_ID && env.HDFC_SMS_DEVICE_SECRET);
}

function parseAmountPaise(body: string): number | null {
  if (/(?:otp|one[ -]?time|password|pin|verification|debited|declined|failed)/i.test(body)) return null;
  if (!/\b(?:credited|received)\b/i.test(body)) return null;
  const m = body.match(/(?:INR|Rs\.?|₹)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

function parseReference(body: string): string {
  const m = body.match(/(?:UTR|UPI\s*(?:REF|REFERENCE)|REF(?:ERENCE)?(?:\s*NO)?)\s*[:#-]?\s*([A-Za-z0-9-]{6,})/i);
  return m?.[1] ?? `sms:${crypto.randomUUID()}`;
}

function isHdfcSender(sender: string): boolean {
  return /(?:HDFCBK|HDFCBN|HDFCBANK)/i.test(sender);
}

function hasAccountSuffix(body: string, suffix: string): boolean {
  if (!suffix) return true;
  const accounts = /\b(?:a\s*\/\s*c|acct|account|ac)\b\s*(?:(?:no\.?|number)\s*)?[:.\-]?\s*([xX*0-9]+)(?![A-Za-z0-9])/gi;
  return [...body.matchAll(accounts)].some((m) => String(m[1]).endsWith(suffix));
}

async function confirmIntentFromVerifiedReceipt(
  env: Env, db: D1Database, intent: any, reference: string,
): Promise<"confirmed" | "duplicate" | "review_pending"> {
  const claimed = await db.prepare(
    "UPDATE hdfc_sms_payment_intents SET status='payment_received',bank_reference=?2,updated_at=?3 WHERE intent_id=?1 AND status='pending'",
  ).bind(intent.intent_id, reference, Date.now()).run();
  if (Number(claimed.meta?.changes ?? 0) !== 1) return "duplicate";
  const provisioned = await provisionFromGatewayPurchase(env, {
    uid: intent.uid, listingId: intent.listing_id, bookingId: null, kind: "live_event",
    chargedTokens: Math.round(Number(intent.amount_paise) / 100), purchaseId: intent.intent_id,
    gatewayRef: reference, gateway: "hdfc_sms",
  });
  if (!provisioned.ok) {
    await db.prepare("UPDATE hdfc_sms_payment_intents SET status='review_pending',last_error=?2,updated_at=?3 WHERE intent_id=?1").bind(intent.intent_id, `provision:${provisioned.status}`, Date.now()).run();
    return "review_pending";
  }
  const commercialOrderId = `hdfc_sms-order:${intent.intent_id}`;
  await db.prepare("UPDATE hdfc_sms_payment_intents SET status='confirmed',commercial_order_id=?2,updated_at=?3 WHERE intent_id=?1").bind(intent.intent_id, commercialOrderId, Date.now()).run();
  return "confirmed";
}

async function confirmSmokeIntentFromVerifiedReceipt(
  db: D1Database, intent: any, reference: string,
): Promise<"confirmed" | "duplicate" | "review_pending"> {
  const claimed = await db.prepare(
    "UPDATE hdfc_sms_payment_intents SET status='confirmed',bank_reference=?2,updated_at=?3 WHERE intent_id=?1 AND status='pending'",
  ).bind(intent.intent_id, reference, Date.now()).run();
  return Number(claimed.meta?.changes ?? 0) === 1 ? "confirmed" : "duplicate";
}

/** Recover a verified receipt that arrived while multiple smoke intents were open. */
async function reconcileSmokeIntent(env: Env, db: D1Database, uid: string, requestedIntentId: string): Promise<string | null> {
  const requested = await db.prepare("SELECT * FROM hdfc_sms_payment_intents WHERE intent_id=?1 AND uid=?2").bind(requestedIntentId, uid).first<any>();
  if (!requested || requested.listing_id !== UPI_SMOKE_TEST_LISTING_ID) return requested?.status === "confirmed" ? "confirmed" : null;
  if (requested.status === "confirmed") return "confirmed";
  if (requested.status !== "pending") return null;
  const receipt = await db.prepare("SELECT message,created_at FROM hdfc_sms_receipts ORDER BY created_at DESC LIMIT 20").all<{ message: string; created_at: number }>();
  // A receipt from an earlier smoke test must never auto-confirm a new QR.
  // It must have arrived after this intent was created.
  const match = (receipt.results ?? []).find((r) => Number(r.created_at) >= Number(requested.created_at) && parseAmountPaise(String(r.message)) === Number(requested.amount_paise));
  if (!match) return null;
  const candidates = await db.prepare(
    "SELECT * FROM hdfc_sms_payment_intents WHERE uid=?1 AND listing_id=?2 AND status='pending' AND amount_paise=?3 ORDER BY created_at DESC LIMIT 10",
  ).bind(uid, UPI_SMOKE_TEST_LISTING_ID, requested.amount_paise).all<any>();
  candidates.results.sort((a: any, b: any) => Number(b.created_at) - Number(a.created_at));
  const chosen = candidates.results?.[0];
  if (!chosen) return null;
  if (candidates.results.length > 1) {
    for (const other of candidates.results.slice(1)) {
      await db.prepare("UPDATE hdfc_sms_payment_intents SET status='review_pending',last_error='superseded_smoke_test_intent',updated_at=?2 WHERE intent_id=?1 AND status='pending'").bind(other.intent_id, Date.now()).run();
    }
  }
  return await confirmSmokeIntentFromVerifiedReceipt(db, chosen, parseReference(String(match.message)));
}

/** GET /api/pay/hdfc-sms/method — separate from the retired generic picker gate. */
export async function hdfcSmsMethod(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const config = await readConfig(env);
  return enabled(env, config)
    ? json({ gateway: "hdfc_sms", label: "UPI QR", sub: "Scan with PhonePe or any UPI app", recommended: true, test_mode: true })
    : json({ gateway: "hdfc_sms", enabled: false }, 200);
}

/** POST /api/pay/hdfc-sms/order — creates a QR payment intent for a live ticket. */
export async function hdfcSmsCreateOrder(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const config = await readConfig(env);
  if (!enabled(env, config)) return json({ error: "checkout unavailable" }, 503);
  const b = await req.json().catch(() => ({})) as Record<string, unknown>;
  const listingId = String(b.listingId ?? "");
  if (!listingId) return json({ error: "listingId required" }, 400);
  const db = metaDb(env);
  const listing = await db.prepare(
    "SELECT id,creator_id,kind,title,price,status,starts_at,duration_min,capacity,attrs,free_entry FROM listings WHERE id=?1",
  ).bind(listingId).first<any>();
  if (!listing || listing.kind !== "live_event" || !["published", "live"].includes(String(listing.status))) {
    return json({ error: "listing not available" }, 404);
  }
  const smokeTest = listing.id === UPI_SMOKE_TEST_LISTING_ID;
  if (!smokeTest && listing.creator_id === auth.uid) return json({ error: "cannot buy your own service" }, 400);
  const sellable = bookability(listing, Date.now());
  if (!sellable.ok) return json({ error: sellable.reason, message: sellable.message }, 410);
  const price = Math.trunc(Number(listing.price));
  if (smokeTest) {
    const now = Date.now();
    const expires = now + 30 * 60_000;
    const intentId = crypto.randomUUID();
    await db.prepare(
      `INSERT INTO hdfc_sms_payment_intents
        (intent_id,uid,listing_id,kind,amount_paise,status,expires_at,created_at,updated_at)
       VALUES (?1,?2,?3,'live_event',100,'pending',?4,?5,?5)`,
    ).bind(intentId, auth.uid, listing.id, expires, now).run();
    const ref = `AV${intentId.replace(/-/g, "").slice(0, 24)}`;
    const params = new URLSearchParams({
      pa: String(env.HDFC_UPI_VPA), pn: String(env.HDFC_UPI_PAYEE_NAME ?? "AvaTOK"),
      am: "1.00", cu: "INR", tr: ref, tn: `AvaTOK smoke ${ref}`,
    });
    return json({
      ok: true, intent_id: intentId, listing_id: listing.id, status: "pending",
      amount_paise: 100, total_amount: 1, expires_at: expires,
      upi_url: `upi://pay?${params.toString()}`, payee_name: String(env.HDFC_UPI_PAYEE_NAME ?? "AvaTOK"),
      smoke_test: true,
    });
  }
  const pricingConfig = config;
  let purchaseQuote;
  try {
    purchaseQuote = quoteCommercialPurchase({
      buyerId: auth.uid, kind: "live_event", listing, bookingId: null,
      rail: "hdfc_sms", config: pricingConfig, sourcePrice: price,
      slotStart: null, slotEnd: null,
    });
  } catch { return json({ error: "invalid listing price" }, 409); }
  const tax = purchaseQuote.pricing;
  if (tax.buyerTotal <= 0) return json({ error: "invalid listing price" }, 409);
  const intentId = crypto.randomUUID();
  const commercialOrderId = `hdfc_sms-order:${intentId}`;
  try { await freezeCommercialPurchaseQuote(env, commercialOrderId, purchaseQuote); }
  catch { return json({ error: "pricing snapshot unavailable" }, 503); }
  const now = Date.now();
  const expires = now + 30 * 60_000;
  await db.prepare(
    `INSERT INTO hdfc_sms_payment_intents
      (intent_id,uid,listing_id,kind,amount_paise,status,expires_at,created_at,updated_at)
     VALUES (?1,?2,?3,'live_event',?4,'pending',?5,?6,?6)`,
  ).bind(intentId, auth.uid, listing.id, tax.buyerTotal * 100, expires, now).run();
  const ref = `AV${intentId.replace(/-/g, "").slice(0, 24)}`;
  const params = new URLSearchParams({
    pa: String(env.HDFC_UPI_VPA), pn: String(env.HDFC_UPI_PAYEE_NAME ?? "AvaTOK"),
    am: (tax.buyerTotal).toFixed(2), cu: "INR", tr: ref, tn: `AvaTOK ${ref}`,
  });
  return json({
    ok: true, intent_id: intentId, listing_id: listing.id, status: "pending",
    amount_paise: tax.buyerTotal * 100, total_amount: tax.buyerTotal, expires_at: expires,
    upi_url: `upi://pay?${params.toString()}`, payee_name: String(env.HDFC_UPI_PAYEE_NAME ?? "AvaTOK"),
    smoke_test: smokeTest,
  });
}

/** GET /api/pay/hdfc-sms/status?intent_id=… — browser polling endpoint. */
export async function hdfcSmsStatus(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const id = new URL(req.url).searchParams.get("intent_id") ?? "";
  const row = await metaDb(env).prepare(
    "SELECT intent_id,uid,listing_id,status,amount_paise,commercial_order_id,expires_at,updated_at FROM hdfc_sms_payment_intents WHERE intent_id=?1",
  ).bind(id).first<any>();
  if (!row || row.uid !== auth.uid) return json({ error: "not found" }, 404);
  if (row.status === "pending") {
    const recovered = await reconcileSmokeIntent(env, metaDb(env), auth.uid, id);
    if (recovered === "confirmed") {
      row.status = "confirmed";
      row.commercial_order_id = `hdfc_sms-order:${id}`;
    }
  }
  if (row.status === "pending" && Number(row.expires_at ?? 0) <= Date.now()) {
    await metaDb(env).prepare("UPDATE hdfc_sms_payment_intents SET status='expired',updated_at=?2 WHERE intent_id=?1 AND status='pending'").bind(id, Date.now()).run();
    row.status = "expired";
  }
  return json({ ok: true, intent_id: row.intent_id, listing_id: row.listing_id, status: row.status,
    amount_paise: Number(row.amount_paise), order_id: row.commercial_order_id,
    updated_at: Number(row.updated_at) });
}

function canonical(body: any): string {
  return [body.device_id, body.sender, body.message, body.received_at, body.sim_slot ?? "", body.message_hash, body.nonce, body.sent_at].join("\n");
}

/** POST /api/sms/incoming — Upeo-compatible signed receipt from the companion. */
export async function hdfcSmsIncoming(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null) as any;
  if (!body || body.device_id !== env.HDFC_SMS_DEVICE_ID || !env.HDFC_SMS_DEVICE_SECRET
    || typeof body.sender !== "string" || typeof body.message !== "string"
    || typeof body.received_at !== "string" || typeof body.sent_at !== "string"
    || typeof body.message_hash !== "string" || typeof body.nonce !== "string") return json({ error: "invalid device payload" }, 401);
  const signature = String(body.signature ?? "");
  const expectedHash = await sha256Hex(`${body.sender}|${body.message}|${body.received_at}`);
  if (!signature || !constantTimeEqual(expectedHash, String(body.message_hash ?? ""))) return json({ error: "message hash mismatch" }, 400);
  const skew = Math.abs(Date.now() - Date.parse(String(body.sent_at ?? "")));
  if (!Number.isFinite(skew) || skew > 5 * 60_000) return json({ error: "stale request" }, 400);
  const expected = await hmacSha256Hex(String(env.HDFC_SMS_DEVICE_SECRET), canonical(body));
  if (!constantTimeEqual(expected, signature.toLowerCase())) return json({ error: "invalid signature" }, 401);
  if (!isHdfcSender(String(body.sender ?? ""))) return json({ ok: true, ignored: "sender" });
  const amountPaise = parseAmountPaise(String(body.message ?? ""));
  if (!amountPaise) return json({ ok: true, ignored: "not_credit" });
  const suffix = String(env.HDFC_SMS_ACCOUNT_SUFFIX ?? "");
  if (!hasAccountSuffix(String(body.message), suffix)) return json({ ok: true, ignored: "account" });
  const db = metaDb(env);
  let receipt;
  try {
    receipt = await db.prepare(
      `INSERT OR IGNORE INTO hdfc_sms_receipts
        (message_hash,device_id,sender,message,received_at,nonce,created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7)`,
    ).bind(String(body.message_hash), String(body.device_id), String(body.sender), String(body.message), String(body.received_at), String(body.nonce), Date.now()).run();
  } catch { return json({ error: "receipt storage unavailable" }, 503); }
  const duplicateReceipt = Number(receipt.meta?.changes ?? 0) === 0;
  const pending = await db.prepare(
    `SELECT * FROM hdfc_sms_payment_intents
       WHERE status='pending' AND amount_paise=?1 AND expires_at>?2
       ORDER BY created_at ASC LIMIT 2`,
  ).bind(amountPaise, Date.now()).all<any>();
  if (pending.results.length !== 1) {
    const smoke = pending.results.length > 0 && pending.results.every((x: any) => x.listing_id === UPI_SMOKE_TEST_LISTING_ID);
    if (!smoke) return json({ ok: true, status: "review_pending", reason: pending.results.length ? "ambiguous_intent" : "no_matching_intent" });
  }
  const intent = pending.results[0];
  if (pending.results.length > 1) {
    pending.results.sort((a: any, b: any) => Number(b.created_at) - Number(a.created_at));
    for (const other of pending.results.slice(1)) {
      await db.prepare("UPDATE hdfc_sms_payment_intents SET status='review_pending',last_error='superseded_smoke_test_intent',updated_at=?2 WHERE intent_id=?1 AND status='pending'").bind(other.intent_id, Date.now()).run();
    }
  }
  const ref = parseReference(String(body.message));
  const result = duplicateReceipt
    ? await reconcileSmokeIntent(env, db, intent.uid, intent.intent_id)
    : intent.listing_id === UPI_SMOKE_TEST_LISTING_ID
      ? await confirmSmokeIntentFromVerifiedReceipt(db, intent, ref)
      : await confirmIntentFromVerifiedReceipt(env, db, intent, ref);
  return json({ ok: true, status: result ?? (duplicateReceipt ? "duplicate" : "review_pending"), intent_id: intent.intent_id });
}

/** Signed companion health check. */
export async function hdfcSmsHeartbeat(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null) as any;
  if (!body || body.device_id !== env.HDFC_SMS_DEVICE_ID || !env.HDFC_SMS_DEVICE_SECRET) return json({ error: "unknown device" }, 401);
  const expected = await hmacSha256Hex(String(env.HDFC_SMS_DEVICE_SECRET), `${body.device_id}\n${body.nonce}\n${body.sent_at}`);
  return constantTimeEqual(expected, String(body.signature ?? "").toLowerCase()) ? json({ ok: true }) : json({ error: "invalid signature" }, 401);
}
