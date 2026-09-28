// [SAATHUM-CHECKOUT-API 2026-09-26] Saa Thum event checkout: quote, checkout,
// UPI payment (HDFC SMS rail), ticket provisioning, receipt PDF, confirmation
// email, address edits, my-checkouts list. See
// Specs/SPEC-2026-09-26-SAATHUM-CHECKOUT.md for the HTTP contract this file
// implements, and worker/migrations/2026-09-26-saathum-checkout.sql for why
// payment matching here does NOT reuse hdfc_sms_smoke_intents (amount cap).
import type { Env } from "../types";
import { requireUser, isFail, requireVerifiedWhatsApp } from "../authz"; // [WA-LOGIN-1]
import { metaDb } from "../db/shard";
import { json } from "../util";
import { rateLimit } from "../money";
import { readConfig } from "./config";
import { track, trackException } from "../hooks";
import { emailFor } from "../lib/identity";
import { escapeHtml } from "../cal/emails";
import { enqueueEmail } from "../lib/email_outbox";
import { policy as hdfcPolicy, UUID } from "../lib/hdfc_sms_smoke";
import { sha256Hex } from "../lib/payments/types";
import { bookability } from "../lib/listing_schedule";
import {
  quoteCommercialPurchase, freezeCommercialPurchaseQuote, provisionFromGatewayPurchase,
} from "./commercial_checkout";
import { renderSaathumReceiptPdf } from "../lib/me_receipt_pdf";
import {
  computeQuote, validateAddress, validateSankalp, normalizeUtr, addressLocked,
  externalStatus, CHECKOUT_EXPIRY_MS, DAKSHINA_PRESETS, dueForReminder,
  type Quote, type ListingSnapshot, type ChadhavaCatalogItem, type Address, type Sankalp,
} from "../lib/saathum_checkout_logic";
import { eventTypeOf, eventTypeCopy, isRitual } from "../lib/event_types";
// [WA-NOTIFY-2 2026-09-28] Late-buyer live-link fan-out + the internal watch URL
// builder, both shared with lib/whatsapp_notify.ts's own bulk/late-buyer WhatsApp path.
import { sendSaathumLiveLinkWhatsAppForCheckout, saathumWatchUrl, formatIst } from "../lib/whatsapp_notify";

const APP = "saathum";
const failure = (error: string, status = 400, extra: Record<string, unknown> = {}) => json({ error, message: extra.message ?? error, ...extra }, status);

function parseJsonSafe<T>(s: unknown, fallback: T): T {
  if (typeof s !== "string" || !s) return fallback;
  try { const v = JSON.parse(s); return (v ?? fallback) as T; } catch { return fallback; }
}

async function limited(env: Env, bucket: string, max: number, windowSec = 60) {
  const r = await rateLimit(env, `saathum-checkout:${bucket}`, max, windowSec);
  return r ? json({ error: "rate_limited", retryable: true }, 429, { "retry-after": r.headers.get("retry-after") ?? "60" }) : null;
}

// ---------------------------------------------------------------------------
// Listing + chadhava catalogue loading (server-authoritative; never trust the client)
// ---------------------------------------------------------------------------
type ListingRow = {
  id: string; creator_id: string; kind: string; title: string; status: string;
  price: number; starts_at: number | null; duration_min: number | null;
  capacity: number | null; attrs: string | null; cover_media: string | null; location: string | null;
  performed_by: string | null;
};

async function loadListingRow(env: Env, listingId: string): Promise<ListingRow | null> {
  return metaDb(env).prepare(
    `SELECT id, creator_id, kind, title, status, price, starts_at, duration_min, capacity, attrs, cover_media, location, performed_by
       FROM listings WHERE id=?1`,
  ).bind(listingId).first<ListingRow>();
}

function toSnapshot(row: ListingRow, attrs: Record<string, unknown>): ListingSnapshot {
  const event_type = eventTypeOf(attrs);
  const ritual = isRitual(event_type);
  const prasadPriceRaw = Number(attrs.prasad_price_rupees);
  const prasad_price_rupees = Number.isSafeInteger(prasadPriceRaw) && prasadPriceRaw >= 0 && prasadPriceRaw <= 5000 ? prasadPriceRaw : 99;
  return {
    id: row.id, title: row.title, price_rupees: Number(row.price) || 0,
    visibility: attrs.visibility === "private" ? "private" : "public",
    // [SAATHUM-EVENT-TYPES 2026-09-27] Satsang/sermon/meditation never offer prasad,
    // whatever attrs.prasad_courier says (also enforced server-side on the admin save).
    prasad_available: ritual && attrs.prasad_courier !== false, // default true per spec table
    prasad_price_rupees,
    starts_at: row.starts_at ?? null, duration_min: row.duration_min ?? null,
    event_type,
    performer_name: row.performed_by ?? null,
    performer_photo_url: typeof attrs.performer_photo_url === "string" && attrs.performer_photo_url ? attrs.performer_photo_url : null,
  };
}

async function loadChadhavaCatalog(env: Env): Promise<ChadhavaCatalogItem[]> {
  try {
    const rows = await metaDb(env).prepare(
      `SELECT id, title, description, price_rupees, image_url FROM saathum_chadhava WHERE active=1 ORDER BY sort, id`,
    ).all<ChadhavaCatalogItem>();
    return rows.results ?? [];
  } catch { return []; } // schema not migrated yet (A2's table) — quote still works, cart just offers nothing
}

async function seatsTaken(env: Env, listingId: string): Promise<number> {
  try {
    const r = await metaDb(env).prepare(
      `SELECT COUNT(*) n FROM commercial_entitlements WHERE listing_id=?1 AND role IN ('viewer','buyer') AND state IN ('reserved','held','active','consumed')`,
    ).bind(listingId).first<{ n: number }>();
    return Number(r?.n ?? 0);
  } catch { return 0; }
}

async function computeBookable(env: Env, row: ListingRow, snapshot: ListingSnapshot): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (row.kind !== "live_event") return { ok: false, reason: "not_a_live_event" };
  const b = bookability(row, Date.now());
  if (!b.ok) return { ok: false, reason: b.reason };
  const capacity = snapshot.visibility === "private" ? 1 : row.capacity;
  if (capacity != null) {
    const taken = await seatsTaken(env, row.id);
    if (taken >= capacity) return { ok: false, reason: "sold_out" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// GET /api/saathum/checkout/config?listing_id=
// ---------------------------------------------------------------------------
export async function saathumCheckoutConfig(req: Request, env: Env): Promise<Response> {
  const listingId = new URL(req.url).searchParams.get("listing_id");
  if (!listingId) return failure("listing_id_required");
  const row = await loadListingRow(env, listingId);
  if (!row) return failure("not_found", 404);
  const attrs = parseJsonSafe<Record<string, unknown>>(row.attrs, {});
  const snapshot = toSnapshot(row, attrs);
  const ritual = isRitual(snapshot.event_type);
  const [chadhavaAll, config, bookableCheck] = await Promise.all([
    loadChadhavaCatalog(env), readConfig(env), computeBookable(env, row, snapshot),
  ]);
  // [SAATHUM-EVENT-TYPES 2026-09-27] Non-ritual events never offer chadhava/prasad.
  const chadhava = ritual ? chadhavaAll : [];
  const cover = parseJsonSafe<unknown[]>(row.cover_media, []);
  return json({
    listing: {
      id: row.id, title: row.title, starts_at: row.starts_at, duration_min: row.duration_min,
      price_rupees: snapshot.price_rupees, prasad_available: ritual ? snapshot.prasad_available : false,
      prasad_price_rupees: snapshot.prasad_price_rupees, visibility: snapshot.visibility,
      cover_url: typeof cover[0] === "string" ? cover[0] : (typeof (cover[0] as any)?.url === "string" ? (cover[0] as any).url : null),
      deity: typeof attrs.deity === "string" ? attrs.deity : null, location: row.location ?? null,
      event_type: snapshot.event_type, ritual,
      performer: { name: snapshot.performer_name, photo_url: snapshot.performer_photo_url },
    },
    chadhava,
    dakshina_presets: DAKSHINA_PRESETS,
    gst: { enabled: config.saathumGstEnabled === true, rate_pct: config.gstRatePct },
    bookable: bookableCheck.ok,
    ...(bookableCheck.ok ? {} : { reason: bookableCheck.reason }),
  });
}

// ---------------------------------------------------------------------------
// POST /api/saathum/checkout/quote
// ---------------------------------------------------------------------------
export async function saathumCheckoutQuote(req: Request, env: Env): Promise<Response> {
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return failure("invalid_request"); }
  if (typeof b.listing_id !== "string") return failure("listing_id_required");
  const row = await loadListingRow(env, b.listing_id);
  if (!row) return failure("not_found", 404);
  const attrs = parseJsonSafe<Record<string, unknown>>(row.attrs, {});
  const snapshot = toSnapshot(row, attrs);
  const [chadhavaCatalog, config] = await Promise.all([loadChadhavaCatalog(env), readConfig(env)]);
  const chadhava = Array.isArray(b.chadhava) ? b.chadhava as { id: string; qty: number }[] : [];
  const dakshinaRupees = Math.trunc(Number(b.dakshina_rupees ?? 0));
  const prasad = b.prasad === true;
  const quote = computeQuote({
    listing: snapshot, chadhavaCatalog, chadhava, dakshinaRupees, prasad,
    gstEnabled: config.saathumGstEnabled === true, gstRatePct: config.gstRatePct,
  });
  if (!quote.ok) return failure(quote.error, 400, { message: quote.message, field: quote.field });
  return json(quote.value);
}

// ---------------------------------------------------------------------------
// Shared: load a caller's own checkout row (404 for anyone else's — never leak
// existence, per spec's "generic 404 for other people's checkouts").
// ---------------------------------------------------------------------------
type CheckoutRowDb = {
  checkout_id: string; uid: string; listing_id: string; request_key: string;
  quote_json: string; subtotal_rupees: number; gst_rupees: number; total_rupees: number; ticket_rupees: number;
  sankalp_json: string; prasad: number; address_json: string | null;
  status: "awaiting_payment" | "confirmed" | "review_pending" | "expired" | "cancelled";
  receiving_account_key: string; amount_paise: number; payer_reference: string | null; reference_revision: number;
  reason_code: string | null; utr: string | null; commercial_order_id: string | null; receipt_no: string | null;
  created_at: number; expires_at: number; updated_at: number; confirmed_at: number | null; email_sent_at: number | null;
};

async function loadOwnCheckout(env: Env, uid: string, checkoutId: string): Promise<CheckoutRowDb | null> {
  if (!UUID.test(checkoutId)) return null;
  return metaDb(env).prepare(`SELECT * FROM saathum_checkouts WHERE checkout_id=?1 AND uid=?2`).bind(checkoutId, uid).first<CheckoutRowDb>();
}

async function checkoutEnvelope(env: Env, row: CheckoutRowDb) {
  const listing = await metaDb(env).prepare(`SELECT id,title,starts_at,duration_min,cover_media FROM listings WHERE id=?1`).bind(row.listing_id).first<{ id: string; title: string; starts_at: number | null; duration_min: number | null; cover_media: string | null }>();
  const cover = parseJsonSafe<unknown[]>(listing?.cover_media ?? null, []);
  const now = Date.now();
  const status = externalStatus(row, now);
  const config = await readConfig(env);
  const p = await hdfcPolicy(env);
  const canPay = p.enabled && status === "awaiting_payment";
  const upiUrl = canPay
    ? `upi://pay?${new URLSearchParams({
      pa: p.vpa, pn: p.payee_name, // [SAATHUM-UPI-SETTINGS] admin-set VPA
      am: (row.amount_paise / 100).toFixed(2), cu: "INR",
      tr: `ST${row.checkout_id.replace(/-/g, "")}`, tn: "Saa Thum booking",
    })}`
    : null;
  return {
    checkout_id: row.checkout_id,
    listing: { id: row.listing_id, title: listing?.title ?? "Saa Thum booking", starts_at: listing?.starts_at ?? null, duration_min: listing?.duration_min ?? null, cover_url: typeof cover[0] === "string" ? cover[0] : (typeof (cover[0] as any)?.url === "string" ? (cover[0] as any).url : null) },
    status,
    quote: JSON.parse(row.quote_json) as Quote,
    sankalp: JSON.parse(row.sankalp_json) as Sankalp,
    prasad: row.prasad === 1,
    address: row.address_json ? (JSON.parse(row.address_json) as Address) : null,
    can_edit_address: !addressLocked(listing?.starts_at ?? null, now),
    payment: {
      upi_url: upiUrl, vpa: p.vpa || null, payee_name: p.payee_name,
      amount_rupees: row.total_rupees, expires_at: row.expires_at, utr: row.utr,
      reference_revision: row.reference_revision, reason_code: status === "awaiting_payment" ? row.reason_code : null,
    },
    receipt_url: status === "confirmed" ? `/api/saathum/checkout/${row.checkout_id}/receipt.pdf` : null,
    confirmed_at: row.confirmed_at, created_at: row.created_at,
    ...(config.saathumGstEnabled === undefined ? {} : {}),
  };
}

// ---------------------------------------------------------------------------
// POST /api/saathum/checkout (signed in)
// ---------------------------------------------------------------------------
export async function saathumCheckoutCreate(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return failure(auth.error, auth.status);
  const { uid } = auth;
  // [WA-LOGIN-1 2026-09-28] Owner decision: no booking/checkout without a
  // verified WhatsApp number. Checked here (not in requireUser) so browsing,
  // quotes and every other authenticated route stay ungated.
  const waGate = await requireVerifiedWhatsApp(env, uid);
  if (waGate) {
    void track(env, uid, "whatsapp_required_blocked", APP, { route: "/api/saathum/checkout" });
    return failure("whatsapp_required", 403, { message: "Verify your WhatsApp number to continue." });
  }
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return failure("invalid_request"); }
  if (typeof b.listing_id !== "string" || typeof b.request_key !== "string" || !UUID.test(b.request_key)) return failure("invalid_request");
  if (b.accept_terms !== true || b.accept_refund !== true) return failure("terms_required", 400, { message: "You must accept the terms and refund policy." });

  const throttle = await limited(env, `create:${uid}`, 10); if (throttle) return throttle;
  const db = metaDb(env);

  // Idempotent replay on (uid, request_key).
  const existing = await db.prepare(`SELECT checkout_id FROM saathum_checkouts WHERE uid=?1 AND request_key=?2`).bind(uid, b.request_key).first<{ checkout_id: string }>();
  if (existing) {
    await finalizeSaathumCheckoutByIntent(env, existing.checkout_id).catch(() => {});
    const row = await loadOwnCheckout(env, uid, existing.checkout_id);
    if (!row) return failure("not_found", 404);
    return json({ checkout: await checkoutEnvelope(env, row) });
  }

  const row = await loadListingRow(env, b.listing_id);
  if (!row) return failure("not_found", 404);
  const attrs = parseJsonSafe<Record<string, unknown>>(row.attrs, {});
  const snapshot = toSnapshot(row, attrs);
  // [SAATHUM-EVENT-TYPES 2026-09-27] Needed before sankalp validation: non-ritual
  // types (satsang, sermon, meditation) take only the attendee's name.
  const ritual = isRitual(snapshot.event_type);

  const sankalp = validateSankalp(b.sankalp, ritual);
  if (!sankalp.ok) return failure(sankalp.error, 400, { message: sankalp.message, field: sankalp.field });
  const prasad = b.prasad === true;
  let address: Address | null = null;
  if (prasad) {
    const a = validateAddress(b.address);
    if (!a.ok) return failure(a.error, 400, { message: a.message, field: a.field });
    address = a.value;
  } else if (b.address !== undefined && b.address !== null) {
    const a = validateAddress(b.address);
    if (a.ok) address = a.value; // optional even without prasad; ignore a malformed optional address
  }

  const bookableCheck = await computeBookable(env, row, snapshot);
  if (!bookableCheck.ok) return failure(bookableCheck.reason, 409);

  const [chadhavaCatalog, config, p] = await Promise.all([loadChadhavaCatalog(env), readConfig(env), hdfcPolicy(env)]);
  const chadhava = ritual && Array.isArray(b.chadhava) ? (b.chadhava as { id: string; qty: number }[]) : [];
  const dakshinaRupees = Math.trunc(Number(b.dakshina_rupees ?? 0));
  const quote = computeQuote({
    listing: snapshot, chadhavaCatalog, chadhava, dakshinaRupees, prasad,
    gstEnabled: config.saathumGstEnabled === true, gstRatePct: config.gstRatePct,
  });
  if (!quote.ok) return failure(quote.error, 400, { message: quote.message, field: quote.field });
  if (prasad && !address) return failure("address_required", 400, { message: "A shipping address is required for prasad courier.", field: "address" });

  const checkoutId = crypto.randomUUID(), now = Date.now();
  try {
    await db.prepare(
      `INSERT INTO saathum_checkouts
        (checkout_id,uid,listing_id,request_key,quote_json,subtotal_rupees,gst_rupees,total_rupees,ticket_rupees,
         sankalp_json,prasad,address_json,status,receiving_account_key,amount_paise,created_at,expires_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'awaiting_payment',?13,?14,?15,?16,?15)`,
    ).bind(
      checkoutId, uid, row.id, b.request_key, JSON.stringify(quote.value),
      quote.value.subtotal_rupees, quote.value.gst_rupees, quote.value.total_rupees, snapshot.price_rupees,
      JSON.stringify(sankalp.value), prasad ? 1 : 0, address ? JSON.stringify(address) : null,
      p.account, quote.value.total_rupees * 100, now, now + CHECKOUT_EXPIRY_MS,
    ).run();
  } catch (err) {
    await trackException(env, err, { uid, route: "/api/saathum/checkout", method: "POST", handled: true, app_name: APP });
    return failure("checkout_unavailable", 503);
  }

  // Sankalp + address saved to the user's profile (spec §7) — the SAME store the
  // Dashboard 2 profile page reads (routes/me_dashboard.ts meProfileGet/Put).
  await saveToProfile(env, uid, { sankalp: sankalp.value, address: address ?? null }, now);

  await track(env, uid, "saathum_checkout_created", APP, {
    listing_id: row.id, total_rupees: quote.value.total_rupees, prasad, chadhava_count: chadhava.filter((c) => c.qty > 0).length,
    event_type: snapshot.event_type,
  });
  const created = await loadOwnCheckout(env, uid, checkoutId);
  if (!created) return failure("checkout_unavailable", 503);
  return json({ checkout: await checkoutEnvelope(env, created) });
}

// ---------------------------------------------------------------------------
// GET /api/saathum/checkout/:id (signed in) — also finalises idempotently.
// ---------------------------------------------------------------------------
export async function saathumCheckoutGet(req: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return failure(auth.error, auth.status);
  let row = await loadOwnCheckout(env, auth.uid, id);
  if (!row) return failure("not_found", 404);
  if (row.status === "awaiting_payment") {
    await finalizeSaathumCheckoutByIntent(env, row.checkout_id).catch((err) => trackException(env, err, { uid: auth.uid, route: "/api/saathum/checkout/:id", method: "GET", handled: true, app_name: APP }));
    row = (await loadOwnCheckout(env, auth.uid, id)) ?? row;
  }
  return json({ checkout: await checkoutEnvelope(env, row) });
}

// ---------------------------------------------------------------------------
// POST /api/saathum/checkout/:id/utr (signed in)
// ---------------------------------------------------------------------------
export async function saathumCheckoutUtr(req: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return failure(auth.error, auth.status);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return failure("invalid_request"); }
  const utr = normalizeUtr(b.utr);
  if (!utr) return failure("reference_must_be_12_digits");
  if (!Number.isSafeInteger(b.expected_reference_revision) || Number(b.expected_reference_revision) < 0) return failure("invalid_request");
  const throttle = await limited(env, `utr:${auth.uid}`, 20); if (throttle) return throttle;
  const row = await loadOwnCheckout(env, auth.uid, id);
  if (!row) return failure("not_found", 404);
  if (row.status !== "awaiting_payment") {
    await track(env, auth.uid, "saathum_checkout_utr_submitted", APP, { ok: false, reason: `status_${row.status}` });
    return json({ checkout: await checkoutEnvelope(env, row) });
  }
  const now = Date.now();
  try {
    await metaDb(env).prepare(
      `UPDATE saathum_checkouts SET payer_reference=?3, reference_revision=reference_revision+1, updated_at=?4
       WHERE checkout_id=?1 AND uid=?2 AND status='awaiting_payment' AND reference_revision=?5 AND payer_reference IS NOT ?3`,
    ).bind(id, auth.uid, utr, now, Number(b.expected_reference_revision)).run();
  } catch (err) {
    // UNIQUE(receiving_account_key,payer_reference) — this UTR is already claimed
    // by another Saa Thum checkout.
    await track(env, auth.uid, "saathum_checkout_utr_submitted", APP, { ok: false, reason: "reference_conflict" });
    return failure("reference_conflict", 409);
  }
  const after = await loadOwnCheckout(env, auth.uid, id);
  if (!after) return failure("not_found", 404);
  if (after.payer_reference !== utr) {
    await track(env, auth.uid, "saathum_checkout_utr_submitted", APP, { ok: false, reason: "reference_conflict" });
    return failure("reference_conflict", 409);
  }
  await track(env, auth.uid, "saathum_checkout_utr_submitted", APP, { ok: true });
  await finalizeSaathumCheckoutByIntent(env, id).catch((err) => trackException(env, err, { uid: auth.uid, route: "/api/saathum/checkout/:id/utr", method: "POST", handled: true, app_name: APP }));
  const final = (await loadOwnCheckout(env, auth.uid, id)) ?? after;
  return json({ checkout: await checkoutEnvelope(env, final) });
}

// ---------------------------------------------------------------------------
// PUT /api/saathum/checkout/:id/address (signed in)
// ---------------------------------------------------------------------------
export async function saathumCheckoutAddress(req: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return failure(auth.error, auth.status);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return failure("invalid_request"); }
  const a = validateAddress(b.address);
  if (!a.ok) return failure(a.error, 400, { message: a.message, field: a.field });
  const row = await loadOwnCheckout(env, auth.uid, id);
  if (!row) return failure("not_found", 404);
  const listing = await metaDb(env).prepare(`SELECT starts_at FROM listings WHERE id=?1`).bind(row.listing_id).first<{ starts_at: number | null }>();
  if (addressLocked(listing?.starts_at ?? null)) return failure("address_locked", 409);
  const now = Date.now();
  await metaDb(env).prepare(`UPDATE saathum_checkouts SET address_json=?2, updated_at=?3 WHERE checkout_id=?1`).bind(id, JSON.stringify(a.value), now).run();
  await saveToProfile(env, auth.uid, { address: a.value }, now);
  const after = await loadOwnCheckout(env, auth.uid, id);
  if (!after) return failure("not_found", 404);
  return json({ checkout: await checkoutEnvelope(env, after) });
}

// ---------------------------------------------------------------------------
// GET /api/saathum/my-checkouts (signed in)
// ---------------------------------------------------------------------------
export async function saathumMyCheckouts(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return failure(auth.error, auth.status);
  const rows = await metaDb(env).prepare(`SELECT * FROM saathum_checkouts WHERE uid=?1 ORDER BY created_at DESC LIMIT 100`).bind(auth.uid).all<CheckoutRowDb>();
  const now = Date.now();
  const items = await Promise.all((rows.results ?? []).map(async (row) => {
    const envelope = await checkoutEnvelope(env, row);
    const { payment: _drop, ...summary } = envelope as any;
    const listing = await metaDb(env).prepare(`SELECT status,starts_at,duration_min,attrs FROM listings WHERE id=?1`).bind(row.listing_id).first<{ status: string; starts_at: number | null; duration_min: number | null; attrs: string | null }>();
    const ended = listing?.starts_at != null && now >= listing.starts_at + (listing.duration_min ?? 60) * 60_000;
    const attrs = parseJsonSafe<Record<string, unknown>>(listing?.attrs ?? null, {});
    const video_download_url = envelope.status === "confirmed" && ended && typeof attrs.video_download_url === "string" ? attrs.video_download_url : null;
    return { ...summary, video_download_url };
  }));
  return json({ items });
}

// ---------------------------------------------------------------------------
// GET /api/saathum/checkout/:id/receipt.pdf (signed in, confirmed only)
// ---------------------------------------------------------------------------
export async function saathumCheckoutReceiptPdf(req: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return failure(auth.error, auth.status);
  const row = await loadOwnCheckout(env, auth.uid, id);
  if (!row) return failure("not_found", 404);
  if (externalStatus(row) !== "confirmed" || !row.receipt_no) return failure("not_confirmed", 409, { message: "A receipt is available once the payment is confirmed." });
  const key = `saathum-receipts/${auth.uid}/${row.receipt_no}.pdf`;
  const headers = { "content-type": "application/pdf", "content-disposition": `attachment; filename="${row.receipt_no}.pdf"`, "cache-control": "private, no-store" };
  try {
    const cached = await env.DIGITAL.get(key);
    if (cached) return new Response(cached.body, { headers });
  } catch { /* fall through to render */ }
  const [listing, email] = await Promise.all([
    metaDb(env).prepare(`SELECT title,starts_at,duration_min FROM listings WHERE id=?1`).bind(row.listing_id).first<{ title: string; starts_at: number | null; duration_min: number | null }>(),
    emailFor(env, auth.uid).catch(() => null),
  ]);
  const quote = JSON.parse(row.quote_json) as Quote;
  const sankalp = JSON.parse(row.sankalp_json) as Sankalp;
  const address = row.address_json ? (JSON.parse(row.address_json) as Address) : null;
  const pdf = await renderSaathumReceiptPdf({
    receiptNo: row.receipt_no, issuedAt: row.confirmed_at ?? row.created_at,
    billedTo: { name: sankalp.name || null, email, address: address ? [address.line1, address.line2, `${address.city}, ${address.state} ${address.pincode}`].filter(Boolean) as string[] : [] },
    item: { title: listing?.title ?? "Saa Thum booking", startsAt: listing?.starts_at ?? null, durationMin: listing?.duration_min ?? null },
    lines: quote.lines, gstRatePct: quote.gst_rate_pct, gstRupees: quote.gst_rupees, subtotalRupees: quote.subtotal_rupees, totalRupees: quote.total_rupees,
    paidAt: row.confirmed_at, utr: row.utr, paymentId: row.checkout_id, orderId: row.commercial_order_id,
  });
  try { await env.DIGITAL.put(key, pdf, { httpMetadata: { contentType: "application/pdf" }, customMetadata: { uid: auth.uid, checkout_id: row.checkout_id } }); } catch { /* best-effort cache */ }
  return new Response(pdf, { headers });
}

// ---------------------------------------------------------------------------
// Payment matching + finalization. Idempotent — safe to call from the
// customer's GET/UTR path AND from hdfcSmsIncoming after a bank-SMS match.
// See the migration file's PAYMENT DESIGN NOTE for why this does not reuse
// hdfc_sms_smoke_intents/matchIntent: that table hard-caps amount_paise=100.
// Instead this reads the SAME evidence table those functions write
// (hdfc_sms_smoke_receipts, populated by the existing SMS-parsing/signature
// pipeline in routes/hdfc_sms_payments.ts hdfcSmsIncoming) and matches by
// (receiving_account_key, bank_reference, amount_paise) — the customer-supplied
// UTR is the disambiguator, never amount alone.
// ---------------------------------------------------------------------------
/**
 * [SAATHUM-CHECKOUT-API] Write the sankalp (gotra, family) and prasad address into the
 * customer's real profile (user_profile_extras / user_addresses — what /api/me/profile
 * reads). Only non-empty values overwrite; the phone stays on the checkout's own address
 * (user_addresses has no phone column). Best-effort: never fails the checkout.
 */
async function saveToProfile(env: Env, uid: string, v: { sankalp?: any; address?: any | null }, now: number): Promise<void> {
  const db = metaDb(env);
  const stmts: D1PreparedStatement[] = [];
  const gotra = typeof v.sankalp?.gotra === "string" && v.sankalp.gotra.trim() ? v.sankalp.gotra.trim().slice(0, 60) : null;
  const family = Array.isArray(v.sankalp?.family)
    ? v.sankalp.family.filter((n: unknown) => typeof n === "string" && n.trim()).map((n: string) => n.trim().slice(0, 80)).slice(0, 20)
    : [];
  if (gotra || family.length) {
    stmts.push(db.prepare(
      `INSERT INTO user_profile_extras (uid,gotra,family_json,updated_at) VALUES (?1,?2,?3,?4)
       ON CONFLICT(uid) DO UPDATE SET
         gotra=COALESCE(excluded.gotra, gotra),
         family_json=CASE WHEN ?5 THEN excluded.family_json ELSE family_json END,
         updated_at=excluded.updated_at`,
    ).bind(uid, gotra, family.length ? JSON.stringify(family) : null, now, family.length ? 1 : 0));
  }
  const ad = v.address;
  if (ad) {
    stmts.push(db.prepare(
      `INSERT INTO user_addresses (uid,name,line1,line2,city,state,pin,country,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'IN',?8)
       ON CONFLICT(uid) DO UPDATE SET name=excluded.name,line1=excluded.line1,line2=excluded.line2,city=excluded.city,
         state=excluded.state,pin=excluded.pin,country=excluded.country,updated_at=excluded.updated_at`,
    ).bind(uid, ad.name, ad.line1, ad.line2 ?? null, ad.city, ad.state, ad.pincode, now));
  }
  if (!stmts.length) return;
  try { await db.batch(stmts); }
  catch (err) { await trackException(env, err, { uid, route: "saathum_checkout.saveToProfile", handled: true, app_name: APP }); }
}

export async function finalizeSaathumCheckoutByIntent(env: Env, checkoutId: string): Promise<void> {
  const db = metaDb(env);
  const row = await db.prepare(`SELECT * FROM saathum_checkouts WHERE checkout_id=?1`).bind(checkoutId).first<CheckoutRowDb>();
  if (!row || row.status !== "awaiting_payment" || !row.payer_reference) return;
  const now = Date.now();
  const receipt = await db.prepare(
    `SELECT bank_reference, payer_vpa FROM hdfc_sms_smoke_receipts
      WHERE receiving_account_key=?1 AND bank_reference=?2 AND amount_paise=?3 AND disposition='accepted'
        AND received_at_end_ms>=?4 AND received_at_ms<=?5`,
  ).bind(row.receiving_account_key, row.payer_reference, row.amount_paise, row.created_at, row.expires_at + 86_400_000).first<{ bank_reference: string; payer_vpa: string | null }>();
  if (!receipt) return;

  // First writer wins — the guard (status='awaiting_payment' AND payer_reference
  // unchanged) makes a concurrent SMS-webhook call and a concurrent customer
  // GET/UTR call converge on exactly one confirmation.
  const claim = await db.prepare(
    `UPDATE saathum_checkouts SET status='confirmed', utr=?3, confirmed_at=?4, updated_at=?4
      WHERE checkout_id=?1 AND status='awaiting_payment' AND payer_reference=?2`,
  ).bind(checkoutId, row.payer_reference, row.payer_reference, now).run();
  if (Number((claim as any).meta?.changes ?? 0) !== 1) return; // lost the race or already confirmed elsewhere

  try {
    const config = await readConfig(env);
    const listingRow = await db.prepare(
      `SELECT id,creator_id,kind,title,status,price,currency_display,starts_at,duration_min,capacity,attrs,free_entry FROM listings WHERE id=?1`,
    ).bind(row.listing_id).first<any>();
    if (!listingRow) throw new Error("saathum listing missing at finalize");
    const listingAttrsForEvent = parseJsonSafe<Record<string, unknown>>(listingRow.attrs, {});
    const purchaseQuote = quoteCommercialPurchase({
      buyerId: row.uid, kind: "live_event", listing: listingRow, bookingId: null, rail: "hdfc_sms", config,
      sourcePrice: row.ticket_rupees, slotStart: null, slotEnd: null,
    });
    const orderId = `hdfc_sms-order:${checkoutId}`;
    await freezeCommercialPurchaseQuote(env, orderId, purchaseQuote);
    const resp = await provisionFromGatewayPurchase(env, {
      uid: row.uid, listingId: row.listing_id, bookingId: null, kind: "live_event",
      chargedTokens: purchaseQuote.pricing.buyerTotal, purchaseId: checkoutId, gatewayRef: row.payer_reference,
      gateway: "hdfc_sms",
    });
    if (!resp.ok) {
      await db.prepare(`UPDATE saathum_checkouts SET status='review_pending', reason_code='provisioning_failed', updated_at=?2 WHERE checkout_id=?1`).bind(checkoutId, Date.now()).run();
      await trackException(env, new Error(`saathum provisioning failed: ${resp.status}`), { uid: row.uid, route: "finalizeSaathumCheckoutByIntent", handled: true, app_name: APP });
      return;
    }

    // Receipt number: SH-<year>-NNNNNN, scoped to Saa Thum's own counter.
    const year = new Date(now).getUTCFullYear();
    // Derived from the checkout id: unique without a COUNT race between two confirmations.
    const receiptNo = `SA-${year}-${checkoutId.replace(/-/g, "").slice(0, 10).toUpperCase()}`;

    await db.prepare(
      `UPDATE saathum_checkouts SET commercial_order_id=?2, receipt_no=?3, updated_at=?4 WHERE checkout_id=?1`,
    ).bind(checkoutId, orderId, receiptNo, Date.now()).run();

    // Mirror into hdfc_sms_payment_intents (protocol v1 shape) so Dashboard 2
    // billing, admin payments and refunds keep working (spec §Payment rail).
    // amount_paise here is the FULL total the customer paid, per spec — not just
    // the ticket portion that went through escrow above.
    await db.prepare(
      `INSERT INTO hdfc_sms_payment_intents (intent_id,uid,listing_id,kind,amount_paise,status,bank_reference,commercial_order_id,expires_at,created_at,updated_at)
       VALUES (?1,?2,?3,'live_event',?4,'confirmed',?5,?6,?7,?8,?9)
       ON CONFLICT(intent_id) DO UPDATE SET status='confirmed', bank_reference=excluded.bank_reference, commercial_order_id=excluded.commercial_order_id, updated_at=excluded.updated_at`,
    ).bind(checkoutId, row.uid, row.listing_id, row.amount_paise, row.payer_reference, orderId, row.expires_at, row.created_at, Date.now()).run().catch(() => {});

    await track(env, row.uid, "saathum_checkout_confirmed", APP, { listing_id: row.listing_id, total_rupees: row.total_rupees, via: "customer", event_type: eventTypeOf(listingAttrsForEvent) });
    await sendSaathumConfirmationEmail(env, checkoutId).catch((err) => trackException(env, err, { uid: row.uid, route: "finalizeSaathumCheckoutByIntent:email", handled: true, app_name: APP }));
    // [WA-NOTIFY-2 2026-09-28] Owner decision: people can keep booking while a show
    // is live, and a buyer who confirms while it's live/linked must get the same
    // WhatsApp + email a bulk admin-save fan-out would have given them — never blocks
    // or slows this confirmation (each send is only a cheap D1 outbox insert, exactly
    // like the bulk path; the actual WhatsApp/email delivery happens off the request,
    // via the cron drain / email queue). Both are no-ops when the flag is off, when the
    // listing has no live link yet, or when it's cancelled/completed.
    await notifySaathumLateBuyerIfLive(env, checkoutId, row.uid, row.listing_id)
      .catch((err) => trackException(env, err, { uid: row.uid, route: "finalizeSaathumCheckoutByIntent:late_buyer", handled: true, app_name: APP }));
  } catch (err) {
    await db.prepare(`UPDATE saathum_checkouts SET status='review_pending', reason_code='finalize_error', updated_at=?2 WHERE checkout_id=?1`).bind(checkoutId, Date.now()).run().catch(() => {});
    await trackException(env, err, { uid: row.uid, route: "finalizeSaathumCheckoutByIntent", handled: true, app_name: APP });
  }
}

/**
 * [WA-NOTIFY-2 2026-09-28] Called once, right after a checkout confirms. If the
 * listing already has a live-stream link saved (event_videos) and isn't
 * cancelled/completed, this buyer gets the same live-link WhatsApp + email a bulk
 * admin-save fan-out would have sent — they booked after the link went out, so the
 * bulk send never reached them. Idempotent through the SAME outbox keys the bulk
 * path uses (checkout_id+kind+url_hash for WhatsApp, checkout_id+kind+url_hash for
 * email), so if this checkout is somehow already covered it is a silent no-op, never
 * a double send. Both sub-sends are independently gated on saathumLiveLinkNotifyEnabled
 * inside lib/whatsapp_notify.ts / the email functions above, so this function itself
 * carries no flag check — it only decides WHETHER a live link exists to notify about.
 */
async function notifySaathumLateBuyerIfLive(env: Env, checkoutId: string, uid: string, listingId: string): Promise<void> {
  const db = metaDb(env);
  const listing = await db.prepare(`SELECT status FROM listings WHERE id=?1`).bind(listingId).first<{ status: string }>();
  if (!listing || listing.status === "cancelled" || listing.status === "completed") return;
  const video = await db.prepare(`SELECT source_url, youtube_video_id FROM event_videos WHERE listing_id=?1`)
    .bind(listingId).first<{ source_url: string | null; youtube_video_id: string }>();
  const url = video?.source_url || (video?.youtube_video_id ? `https://www.youtube.com/watch?v=${video.youtube_video_id}` : null);
  if (!url) return;
  await Promise.all([
    sendSaathumLiveLinkWhatsAppForCheckout(env, listingId, checkoutId, uid, url)
      .catch((err) => trackException(env, err, { uid, route: "notifySaathumLateBuyerIfLive:whatsapp", handled: true, app_name: APP })),
    sendSaathumLiveLinkEmailForCheckout(env, listingId, checkoutId, uid, url)
      .catch((err) => trackException(env, err, { uid, route: "notifySaathumLateBuyerIfLive:email", handled: true, app_name: APP })),
  ]);
}

async function sendSaathumConfirmationEmail(env: Env, checkoutId: string): Promise<void> {
  const db = metaDb(env);
  const row = await db.prepare(`SELECT * FROM saathum_checkouts WHERE checkout_id=?1`).bind(checkoutId).first<CheckoutRowDb>();
  if (!row || row.status !== "confirmed" || row.email_sent_at) return;
  const [listing, to] = await Promise.all([
    db.prepare(`SELECT title,starts_at,duration_min,attrs FROM listings WHERE id=?1`).bind(row.listing_id).first<{ title: string; starts_at: number | null; duration_min: number | null; attrs: string | null }>(),
    emailFor(env, row.uid).catch(() => null),
  ]);
  if (!to) { await track(env, row.uid, "saathum_checkout_email", APP, { ok: false, reason: "no_email" }); return; }
  const quote = JSON.parse(row.quote_json) as Quote;
  const sankalp = JSON.parse(row.sankalp_json) as Sankalp;
  const address = row.address_json ? (JSON.parse(row.address_json) as Address) : null;
  // [SAATHUM-EVENT-TYPES 2026-09-27] Copy follows the listing's own type -- never
  // hard-coded "havan" (and never the word "YouTube").
  const emailCopy = eventTypeCopy(eventTypeOf(parseJsonSafe<Record<string, unknown>>(listing?.attrs ?? null, {})));
  const pdf = await renderSaathumReceiptPdf({
    receiptNo: row.receipt_no ?? checkoutId, issuedAt: row.confirmed_at ?? Date.now(),
    billedTo: { name: sankalp.name || null, email: to, address: address ? [address.line1, address.line2, `${address.city}, ${address.state} ${address.pincode}`].filter(Boolean) as string[] : [] },
    item: { title: listing?.title ?? "Saa Thum booking", startsAt: listing?.starts_at ?? null, durationMin: listing?.duration_min ?? null },
    lines: quote.lines, gstRatePct: quote.gst_rate_pct, gstRupees: quote.gst_rupees, subtotalRupees: quote.subtotal_rupees, totalRupees: quote.total_rupees,
    paidAt: row.confirmed_at, utr: row.utr, paymentId: row.checkout_id, orderId: row.commercial_order_id,
  });
  let bin = ""; for (const byte of pdf) bin += String.fromCharCode(byte);
  const pdfBase64 = btoa(bin);
  const whenIst = listing?.starts_at ? new Date(listing.starts_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) : null;
  const prasadNote = row.prasad ? `<p style="margin:0 0 8px">Your prasad ships the same day as the ${escapeHtml(emailCopy.noun)}.</p>` : "";
  const html = `
  <div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px">
    <h2 style="margin:0 0 12px">Booking confirmed</h2>
    <p style="margin:0 0 8px;font-weight:600">${escapeHtml(listing?.title ?? "Saa Thum booking")}</p>
    ${whenIst ? `<p style="margin:0 0 8px">${escapeHtml(whenIst)} IST</p>` : ""}
    <p style="margin:0 0 8px">When the ${escapeHtml(emailCopy.noun)} finishes, we'll email you the video to download.</p>
    ${prasadNote}
    <p style="margin:20px 0 0;color:#999;font-size:12px">Your payment receipt is attached. Receipt no. ${escapeHtml(row.receipt_no ?? "")}</p>
    <p style="color:#999;font-size:12px;margin-top:20px">Saa Thum</p>
  </div>`;
  const result = await enqueueEmail(env, {
    to, subject: `Booking confirmed — ${listing?.title ?? "Saa Thum"}`, html,
    kind: "saathum_checkout_confirmation", orderId: row.commercial_order_id, recipientId: row.uid,
    messageVersion: "saathum-checkout-confirmation.v1",
    attachments: [{ name: `${row.receipt_no ?? "receipt"}.pdf`, content: pdfBase64 }],
  });
  const ok = result.status !== "unavailable" && result.status !== "failed";
  if (ok) await db.prepare(`UPDATE saathum_checkouts SET email_sent_at=?2 WHERE checkout_id=?1`).bind(checkoutId, Date.now()).run().catch(() => {});
  await track(env, row.uid, "saathum_checkout_email", APP, { ok });
}


// ---------------------------------------------------------------------------
// [SAATHUM-CHECKOUT-API follow-up] "30 minutes before" reminder email.
// Called from index.ts scheduled() (every 5 min, see wrangler.toml crons) —
// same pattern as the other cron sweeps there (log a summary, never throw).
// Claims each row atomically (reminder_sent_at IS NULL guard) BEFORE sending,
// so a slow/duplicate cron tick can never double-send. One failed send is
// tracked and skipped; it never stops the loop or the rest of the tick.
// ---------------------------------------------------------------------------
const DASHBOARD_MY_EVENTS_URL = "https://saathum.com/dashboard/my-events";

async function sendSaathumReminderEmail(env: Env, checkoutId: string): Promise<boolean> {
  const db = metaDb(env);
  const row = await db.prepare(`SELECT * FROM saathum_checkouts WHERE checkout_id=?1`).bind(checkoutId).first<CheckoutRowDb>();
  if (!row) return false;
  const [listing, to] = await Promise.all([
    db.prepare(`SELECT title,starts_at,duration_min,attrs FROM listings WHERE id=?1`).bind(row.listing_id).first<{ title: string; starts_at: number | null; duration_min: number | null; attrs: string | null }>(),
    emailFor(env, row.uid).catch(() => null),
  ]);
  if (!to) return false;
  const sankalp = JSON.parse(row.sankalp_json) as Sankalp;
  // [SAATHUM-EVENT-TYPES 2026-09-27] Copy follows the listing's own type -- never
  // hard-coded "havan"/"priest"/"sankalp" for a non-ritual event.
  const listingAttrsForCopy = parseJsonSafe<Record<string, unknown>>(listing?.attrs ?? null, {});
  const reminderType = eventTypeOf(listingAttrsForCopy);
  const reminderCopy = eventTypeCopy(reminderType);
  const ritual = isRitual(reminderType);
  const whenIst = listing?.starts_at
    ? new Date(listing.starts_at < 100_000_000_000 ? listing.starts_at * 1000 : listing.starts_at)
      .toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })
    : null;
  const title = listing?.title ?? "Saa Thum booking";
  const readyLine = ritual
    ? `${escapeHtml(sankalp.name || "Your")} sankalp is ready — the priest will begin shortly.`
    : `Your seat is ready — the ${escapeHtml(reminderCopy.noun)} will begin shortly.`;
  const html = `
  <div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px">
    <h2 style="margin:0 0 12px">Starting in 30 minutes</h2>
    <p style="margin:0 0 8px;font-weight:600">${escapeHtml(title)}</p>
    ${whenIst ? `<p style="margin:0 0 8px">${escapeHtml(whenIst)} IST</p>` : ""}
    <p style="margin:0 0 8px">${readyLine}</p>
    <p style="margin:0 0 8px">If you like, light a lamp at home at the same time and pray with your family. We'll email you the video when the ${escapeHtml(reminderCopy.noun)} finishes.</p>
    <p style="margin:20px 0"><a href="${DASHBOARD_MY_EVENTS_URL}" style="background:#08C4C4;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">View my booking</a></p>
    <p style="color:#999;font-size:12px;margin-top:20px">Saa Thum</p>
  </div>`;
  const result = await enqueueEmail(env, {
    to, subject: `Starting in 30 minutes: ${title}`, html,
    kind: "saathum_checkout_reminder", orderId: row.commercial_order_id, recipientId: row.uid,
    messageVersion: "saathum-checkout-reminder.v1",
  });
  return result.status !== "unavailable" && result.status !== "failed";
}

// [SAATHUM-VIDEO-ONLY 2026-09-27, owner decision] The site no longer promises a live
// link; it promises "we email you the video when it finishes". This sends that email
// to every confirmed buyer the moment the admin saves the video download link on the
// event (routes/admin2_events.ts writeMediaAndAttrs). The outbox key includes the
// link, so a re-save of the same link never re-sends, and a corrected link does.
export async function sendSaathumVideoReadyEmails(env: Env, listingId: string, url: string): Promise<{ sent: number }> {
  const db = metaDb(env);
  const listing = await db.prepare(`SELECT title,attrs FROM listings WHERE id=?1`).bind(listingId).first<{ title: string; attrs: string | null }>();
  const noun = eventTypeCopy(eventTypeOf(parseJsonSafe<Record<string, unknown>>(listing?.attrs ?? null, {}))).noun;
  const title = listing?.title ?? "Saa Thum booking";
  const rows = await db.prepare(
    `SELECT checkout_id, uid, commercial_order_id FROM saathum_checkouts WHERE listing_id=?1 AND status='confirmed' LIMIT 2000`,
  ).bind(listingId).all<{ checkout_id: string; uid: string; commercial_order_id: string | null }>();
  const urlHash = (await sha256Hex(url)).slice(0, 16);
  let sent = 0;
  for (const row of rows.results ?? []) {
    try {
      const to = await emailFor(env, row.uid).catch(() => null);
      if (!to) continue;
      const html = `
  <div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px">
    <h2 style="margin:0 0 12px">Your video is ready 🙏</h2>
    <p style="margin:0 0 8px;font-weight:600">${escapeHtml(title)}</p>
    <p style="margin:0 0 8px">The ${escapeHtml(noun)} is complete. Download the video to keep, and share it with your family.</p>
    <p style="margin:20px 0"><a href="${escapeHtml(url)}" style="background:#08C4C4;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">Download the video</a></p>
    <p style="margin:0 0 8px">It also stays under <a href="${DASHBOARD_MY_EVENTS_URL}">My events</a>.</p>
    <p style="color:#999;font-size:12px;margin-top:20px">Saa Thum</p>
  </div>`;
      const r = await enqueueEmail(env, {
        to, subject: `Your video is ready: ${title}`, html,
        kind: "saathum_video_ready", orderId: row.commercial_order_id, recipientId: row.uid,
        messageVersion: "saathum-video-ready.v1", outboxKey: `saathum-video-ready:${row.checkout_id}:${urlHash}`,
      });
      if (r.status !== "unavailable" && r.status !== "failed") sent++;
    } catch (err) {
      await trackException(env, err, { uid: row.uid, route: "sendSaathumVideoReadyEmails", handled: true, app_name: APP });
    }
  }
  await track(env, "system", "saathum_video_ready_emails", APP, { listing_id: listingId, recipients: rows.results?.length ?? 0, sent });
  return { sent };
}

// ---------------------------------------------------------------------------
// [WA-NOTIFY-2 2026-09-28] Live-link email — mirrors sendSaathumVideoReadyEmails
// above (same enqueueEmail/outbox-key shape) but for the live-stream link instead
// of the finished video, and carries ONLY the internal watch-page URL, never the
// raw YouTube link (owner decision — see lib/whatsapp_notify.ts saathumWatchUrl).
// Two entry points share this core: the bulk fan-out (every confirmed buyer, fired
// from the admin save in routes/me_dashboard.ts adminEventVideo) and the late-buyer
// single send (one checkout, fired from finalizeSaathumCheckoutByIntent below when a
// booking confirms while the show is already live/linked). Both are outboxKey-deduped
// per checkout+kind+urlHash, so the two paths can never double-email the same buyer.
// Both are gated on saathumLiveLinkNotifyEnabled (routes/config.ts) — the watch page
// doesn't exist yet, so this must stay dark until it ships.
// ---------------------------------------------------------------------------
async function enqueueLiveLinkEmailsForBuyers(
  env: Env, listingId: string, urlHash: string, trigger: "link_saved" | "late_buyer",
  buyers: { checkout_id: string; uid: string; commercial_order_id: string | null }[],
): Promise<{ sent: number }> {
  const db = metaDb(env);
  const listing = await db.prepare(`SELECT title,attrs,starts_at FROM listings WHERE id=?1`).bind(listingId)
    .first<{ title: string; attrs: string | null; starts_at: number | null }>();
  const noun = eventTypeCopy(eventTypeOf(parseJsonSafe<Record<string, unknown>>(listing?.attrs ?? null, {}))).noun;
  const title = listing?.title ?? "Saa Thum booking";
  const watch = saathumWatchUrl(env, listingId);
  const startsAt = listing?.starts_at ?? null;
  const alreadyStarted = startsAt != null && Date.now() >= startsAt;
  const whenLine = alreadyStarted
    ? `The live ${noun} is live now.`
    : startsAt != null
      ? `The live ${noun} starts ${formatIst(startsAt)}.`
      : `The live ${noun} starts soon — check the event page for the exact time.`;
  const subject = `${alreadyStarted ? "Live now" : "Starting soon"}: ${title}`;
  let sent = 0;
  for (const row of buyers) {
    try {
      const to = await emailFor(env, row.uid).catch(() => null);
      if (!to) continue;
      const html = `
  <div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px">
    <h2 style="margin:0 0 12px">🙏 ${escapeHtml(title)}</h2>
    <p style="margin:0 0 8px">${escapeHtml(whenLine)}</p>
    <p style="margin:20px 0"><a href="${escapeHtml(watch)}" style="background:#08C4C4;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">Watch</a></p>
    <p style="margin:0 0 8px;color:#999;font-size:12px">This link is only for your booking — please don't share it.</p>
    <p style="color:#999;font-size:12px;margin-top:20px">Saa Thum</p>
  </div>`;
      const r = await enqueueEmail(env, {
        to, subject, html,
        kind: "saathum_live_link", orderId: row.commercial_order_id, recipientId: row.uid,
        messageVersion: "saathum-live-link.v1", outboxKey: `saathum-live-link:${row.checkout_id}:${urlHash}`,
      });
      if (r.status !== "unavailable" && r.status !== "failed") sent++;
    } catch (err) {
      await trackException(env, err, { uid: row.uid, route: "sendSaathumLiveLinkEmails", handled: true, app_name: APP, extra: { trigger } });
    }
  }
  await track(env, "system", "saathum_live_link_emails", APP, { listing_id: listingId, recipients: buyers.length, sent, trigger });
  return { sent };
}

/** Bulk: every confirmed buyer of the listing (admin-save path). */
export async function sendSaathumLiveLinkEmails(env: Env, listingId: string, url: string): Promise<{ sent: number }> {
  const config = await readConfig(env);
  if (!config.saathumLiveLinkNotifyEnabled) return { sent: 0 };
  const db = metaDb(env);
  const rows = await db.prepare(
    `SELECT checkout_id, uid, commercial_order_id FROM saathum_checkouts WHERE listing_id=?1 AND status='confirmed' LIMIT 2000`,
  ).bind(listingId).all<{ checkout_id: string; uid: string; commercial_order_id: string | null }>();
  const urlHash = (await sha256Hex(url)).slice(0, 16);
  return enqueueLiveLinkEmailsForBuyers(env, listingId, urlHash, "link_saved", rows.results ?? []);
}

/** Late buyer: ONE checkout, fired at confirmation time (see finalizeSaathumCheckoutByIntent). */
export async function sendSaathumLiveLinkEmailForCheckout(
  env: Env, listingId: string, checkoutId: string, uid: string, url: string,
): Promise<{ sent: number }> {
  const config = await readConfig(env);
  if (!config.saathumLiveLinkNotifyEnabled) return { sent: 0 };
  const db = metaDb(env);
  const row = await db.prepare(`SELECT commercial_order_id FROM saathum_checkouts WHERE checkout_id=?1`)
    .bind(checkoutId).first<{ commercial_order_id: string | null }>();
  const urlHash = (await sha256Hex(url)).slice(0, 16);
  return enqueueLiveLinkEmailsForBuyers(env, listingId, urlHash, "late_buyer", [
    { checkout_id: checkoutId, uid, commercial_order_id: row?.commercial_order_id ?? null },
  ]);
}

export async function runSaathumReminders(env: Env): Promise<{ scanned: number; sent: number }> {
  const db = metaDb(env);
  const now = Date.now();
  const rows = await db.prepare(
    `SELECT c.checkout_id, c.uid, c.listing_id, l.starts_at
       FROM saathum_checkouts c JOIN listings l ON l.id = c.listing_id
      WHERE c.status='confirmed' AND c.reminder_sent_at IS NULL AND l.starts_at IS NOT NULL
      ORDER BY c.confirmed_at ASC LIMIT 500`,
  ).all<{ checkout_id: string; uid: string; listing_id: string; starts_at: number | null }>();
  let scanned = 0, sent = 0;
  for (const row of rows.results ?? []) {
    scanned++;
    if (sent >= 200) break;
    if (!dueForReminder({ status: "confirmed", reminder_sent_at: null, starts_at: row.starts_at }, now)) continue;
    // Atomic claim BEFORE sending — first cron tick to touch this row wins.
    const claim = await db.prepare(
      `UPDATE saathum_checkouts SET reminder_sent_at=?2 WHERE checkout_id=?1 AND reminder_sent_at IS NULL`,
    ).bind(row.checkout_id, now).run();
    if (Number((claim as any).meta?.changes ?? 0) !== 1) continue;
    try {
      const ok = await sendSaathumReminderEmail(env, row.checkout_id);
      if (ok) sent++;
      await track(env, row.uid, "saathum_reminder_sent", APP, { listing_id: row.listing_id, ok });
    } catch (err) {
      await trackException(env, err, { uid: row.uid, route: "runSaathumReminders", handled: true, app_name: APP });
      await track(env, row.uid, "saathum_reminder_sent", APP, { listing_id: row.listing_id, ok: false });
    }
  }
  return { scanned, sent };
}

// ---------------------------------------------------------------------------
// [WA-NOTIFY-2 2026-09-28] GET /api/saathum/watch/:listingId — entitlement check
// for the (not-yet-built) internal watch page. Requires a signed-in, WhatsApp-
// verified account (same requireVerifiedWhatsApp gate as checkout creation) AND a
// confirmed saathum_checkouts row for this exact listing — otherwise 403 not_booked.
// A listing with no live link queued yet is 404 no_stream, so the page can tell
// "you're not booked" apart from "the stream isn't up yet". Never returns the raw
// YouTube url as a link the buyer could re-share — only the video id, for the
// watch page's own (future) embedded player to use.
// ---------------------------------------------------------------------------
export async function saathumWatchGet(req: Request, env: Env, listingId: string): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return failure(auth.error, auth.status);
  const waErr = await requireVerifiedWhatsApp(env, auth.uid);
  if (waErr) return failure(waErr.error, waErr.status);
  if (!listingId || listingId.length > 200) return failure("not_found", 404);
  const db = metaDb(env);
  const booked = await db.prepare(
    `SELECT 1 FROM saathum_checkouts WHERE listing_id=?1 AND uid=?2 AND status='confirmed' LIMIT 1`,
  ).bind(listingId, auth.uid).first();
  if (!booked) {
    await track(env, auth.uid, "saathum_watch_access", APP, { listing_id: listingId, outcome: "not_booked" });
    return failure("not_booked", 403);
  }
  const listing = await db.prepare(`SELECT title, starts_at, status FROM listings WHERE id=?1`)
    .bind(listingId).first<{ title: string; starts_at: number | null; status: string }>();
  const video = await db.prepare(`SELECT youtube_video_id FROM event_videos WHERE listing_id=?1`)
    .bind(listingId).first<{ youtube_video_id: string }>();
  if (!listing || !video?.youtube_video_id) {
    await track(env, auth.uid, "saathum_watch_access", APP, { listing_id: listingId, outcome: "no_stream" });
    return failure("no_stream", 404);
  }
  await track(env, auth.uid, "saathum_watch_access", APP, { listing_id: listingId, outcome: "ok" });
  return json({
    ok: true, listing_id: listingId, title: listing.title, starts_at: listing.starts_at,
    status: listing.status, youtube_video_id: video.youtube_video_id,
  });
}
