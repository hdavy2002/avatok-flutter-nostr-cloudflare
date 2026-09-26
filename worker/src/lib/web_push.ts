// [DASH2-PUSH 2026-09-26] Web Push for Saa Thum Dashboard 2 (the PWA) — no npm package.
//
// Pure WebCrypto, so it runs unchanged in Cloudflare Workers and in node (vitest):
//   * VAPID (RFC 8292): an ES256 JWT {aud: push-service origin, exp, sub} sent as
//     `Authorization: vapid t=<jwt>, k=<public key>`.
//   * Payload encryption (RFC 8291 over RFC 8188 "aes128gcm"): ephemeral ECDH P-256
//     against the browser's p256dh key, HKDF with the browser's auth secret, one
//     AES-128-GCM record.
//
// SECRETS (set by the coordinator with `wrangler secret put`, never by an agent):
//   VAPID_PUBLIC_KEY  — base64url of the 65-byte UNCOMPRESSED P-256 point (0x04||x||y).
//                       This is also the browser's `applicationServerKey`.
//   VAPID_PRIVATE_KEY — base64url of the raw 32-byte private scalar `d` (the JWK "d"
//                       member). A base64url/base64 PKCS8 DER blob is accepted too.
//   VAPID_SUBJECT     — "mailto:support@saathum.com".
//   Generate a pair with: node worker/scripts/gen_vapid.mjs
// Missing keys => push is a silent no-op (one console.warn + trackException per isolate).
//
// Triggers: T-15 reminder and go-live (cron, runPushReminders) and refund recorded
// (notifyRefundPush, called from adminRecordRefund). Dedup table: push_sent
// (migrations/2026-09-26-dash2-push-sent.sql).
import type { Env } from "../types";
import { track, trackException } from "../hooks";
import { scheduleState, toMs } from "./listing_schedule";

const APP = "saathum";

export type PushEnv = Env & { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string };
export interface PushPayload { title: string; body: string; url: string; tag: string }
export interface PushSubscriptionRow { id?: string; endpoint: string; p256dh: string; auth: string }

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------
export function b64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlDecode(str: string): Uint8Array {
  const s = str.trim().replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const utf8 = (s: string) => new TextEncoder().encode(s);
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Is this a usable browser subscription key pair? (p256dh = 65-byte point, auth = 16 bytes) */
export function validSubscriptionKeys(p256dh: unknown, auth: unknown): boolean {
  if (typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 200 || auth.length > 64) return false;
  try {
    const k = b64urlDecode(p256dh), a = b64urlDecode(auth);
    return k.length === 65 && k[0] === 4 && a.length === 16;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------
function jwkFromRaw(publicRaw: Uint8Array, d?: string): JsonWebKey {
  if (publicRaw.length !== 65 || publicRaw[0] !== 4) throw new Error("VAPID/EC public key must be a 65-byte uncompressed P-256 point");
  return {
    kty: "EC", crv: "P-256", ext: true,
    x: b64urlEncode(publicRaw.slice(1, 33)), y: b64urlEncode(publicRaw.slice(33, 65)),
    ...(d ? { d } : {}),
  };
}

/** Imports a P-256 private key from a raw `d` (base64url) or a PKCS8 DER (base64/base64url). */
export async function importEcPrivateKey(priv: string, publicRaw: Uint8Array, usage: "sign" | "deriveBits"): Promise<CryptoKey> {
  const alg = usage === "sign" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "ECDH", namedCurve: "P-256" };
  const raw = b64urlDecode(priv);
  if (raw.length === 32) {
    return crypto.subtle.importKey("jwk", jwkFromRaw(publicRaw, b64urlEncode(raw)), alg, false, [usage]);
  }
  return crypto.subtle.importKey("pkcs8", raw, alg, false, [usage]);
}

export interface VapidKeys { publicKey: string; privateKey: string; subject: string }

export function vapidFromEnv(env: PushEnv): VapidKeys | null {
  const publicKey = (env.VAPID_PUBLIC_KEY ?? "").trim();
  const privateKey = (env.VAPID_PRIVATE_KEY ?? "").trim();
  const subject = (env.VAPID_SUBJECT ?? "").trim() || "mailto:support@saathum.com";
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject };
}

let warnedMissing = false;
/** VAPID config or null; the first miss per isolate is logged once, never thrown. */
export async function vapidOrWarn(env: PushEnv): Promise<VapidKeys | null> {
  const v = vapidFromEnv(env);
  if (v || warnedMissing) return v;
  warnedMissing = true;
  console.warn("[dash2-push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — web push is a no-op");
  await trackException(env, new Error("web push disabled: VAPID keys missing"), {
    handled: true, app_name: APP, route: "web_push", extra: { area: "dash2_push", level: "warning" },
  }).catch(() => undefined);
  return null;
}

// ---------------------------------------------------------------------------
// VAPID JWT (RFC 8292)
// ---------------------------------------------------------------------------
export async function vapidJwt(endpoint: string, keys: VapidKeys, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = b64urlEncode(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  // exp must be <= 24h out; 12h is the common, safe choice.
  const claims = b64urlEncode(utf8(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: keys.subject })));
  const signingInput = `${header}.${claims}`;
  const key = await importEcPrivateKey(keys.privateKey, b64urlDecode(keys.publicKey), "sign");
  // WebCrypto ECDSA returns IEEE-P1363 r||s (64 bytes) — exactly the JWS ES256 form.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(signingInput));
  return `${signingInput}.${b64urlEncode(sig)}`;
}

// ---------------------------------------------------------------------------
// aes128gcm payload encryption (RFC 8291 / RFC 8188)
// ---------------------------------------------------------------------------
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, bytes * 8));
}

export interface EncryptOptions {
  /** Test hooks (RFC 8291 Appendix A): fixed ephemeral key and salt. */
  asPrivate?: string; asPublic?: string; salt?: Uint8Array; recordSize?: number;
}

/** Encrypts `plaintext` for one subscription; returns the full aes128gcm body. */
export async function encryptPayload(plaintext: Uint8Array, p256dh: string, authSecret: string, opts: EncryptOptions = {}): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(p256dh);
  const auth = b64urlDecode(authSecret);
  let asPrivateKey: CryptoKey, asPublic: Uint8Array;
  if (opts.asPrivate && opts.asPublic) {
    asPublic = b64urlDecode(opts.asPublic);
    asPrivateKey = await importEcPrivateKey(opts.asPrivate, asPublic, "deriveBits");
  } else {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    asPrivateKey = pair.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer);
  }
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0], asPrivateKey, 256));
  const ikm = await hkdf(auth, ecdh, concat(utf8("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const rs = opts.recordSize ?? 4096;
  if (plaintext.length + 1 + 16 > rs) throw new Error("push payload too large for one record");
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // Single (last) record: plaintext || 0x02 delimiter, no extra padding.
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ct);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
export type SendOutcome = "sent" | "gone" | "failed";

export async function sendOne(sub: PushSubscriptionRow, payload: PushPayload, keys: VapidKeys, ttlSec = 3600): Promise<{ outcome: SendOutcome; status: number }> {
  const body = await encryptPayload(utf8(JSON.stringify(payload)), sub.p256dh, sub.auth);
  const jwt = await vapidJwt(sub.endpoint, keys);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttlSec),
      Urgency: "high",
    },
    body,
  });
  if (res.status === 404 || res.status === 410) return { outcome: "gone", status: res.status };
  return { outcome: res.ok ? "sent" : "failed", status: res.status };
}

/** notify.push is ON unless the account explicitly turned it off. */
export function pushAllowed(notifyJson: unknown): boolean {
  if (typeof notifyJson !== "string" || !notifyJson) return true;
  try { return (JSON.parse(notifyJson) as { push?: unknown })?.push !== false; } catch { return true; }
}

export type PushKind = "t15" | "live" | "refund";

/**
 * Sends `payload` to every subscription of `uid`. Deletes a subscription the push
 * service says is gone (404/410). Respects notify.push=false. Never throws.
 */
export async function sendPushToUser(env: PushEnv, uid: string, payload: PushPayload, kind: PushKind | string = "other"):
  Promise<{ sent: number; failed: number; removed: number; skipped?: "no_keys" | "opted_out" | "no_subscriptions" }> {
  const keys = await vapidOrWarn(env);
  if (!keys) return { sent: 0, failed: 0, removed: 0, skipped: "no_keys" };
  const db = env.DB_META;
  let sent = 0, failed = 0, removed = 0;
  try {
    const extras = await db.prepare("SELECT notify_json FROM user_profile_extras WHERE uid=?1").bind(uid).first<{ notify_json: string | null }>();
    if (!pushAllowed(extras?.notify_json)) return { sent, failed, removed, skipped: "opted_out" };
    const rs = await db.prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE uid=?1 ORDER BY created_at DESC LIMIT 10")
      .bind(uid).all<PushSubscriptionRow>();
    const subs = rs.results ?? [];
    if (!subs.length) return { sent, failed, removed, skipped: "no_subscriptions" };
    const safe: PushPayload = { ...payload, title: payload.title.slice(0, 140), body: payload.body.slice(0, 240) };
    for (const sub of subs) {
      try {
        const r = await sendOne(sub, safe, keys);
        if (r.outcome === "sent") sent++;
        else if (r.outcome === "gone") {
          removed++;
          await db.prepare("DELETE FROM push_subscriptions WHERE endpoint=?1").bind(sub.endpoint).run();
        } else failed++;
      } catch (e) {
        failed++;
        await trackException(env, e, { uid, handled: true, app_name: APP, route: "web_push_send", extra: { area: "dash2_push", kind } }).catch(() => undefined);
      }
    }
  } catch (e) {
    failed++;
    await trackException(env, e, { uid, handled: true, app_name: APP, route: "web_push_send", extra: { area: "dash2_push", kind } }).catch(() => undefined);
  }
  if (sent || failed || removed) {
    await track(env, uid, "dash2_push_sent", APP, { kind, ok: sent > 0, sent, failed, removed }).catch(() => undefined);
  }
  return { sent, failed, removed };
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------
/** Paise -> "₹1,250" (Indian grouping), two decimals only when not whole rupees. */
export function rupees(paise: number): string {
  const p = Math.round(Number(paise) || 0);
  const whole = p % 100 === 0;
  return `₹${(p / 100).toLocaleString("en-IN", whole ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function reminderPayload(kind: "t15" | "live", listingId: string, title: string): PushPayload {
  const t = (title || "Your ritual").trim();
  return kind === "t15"
    ? { title: `🪔 Your havan starts in 15 minutes — ${t}`, body: "Open My events to join on time.", url: "/dashboard/my-events", tag: `t15-${listingId}` }
    : { title: `${t} is live now — join`, body: "Tap to join from My events.", url: "/dashboard/my-events", tag: `live-${listingId}` };
}

export function refundPayload(paymentId: string, amountPaise: number): PushPayload {
  return { title: `Your refund of ${rupees(amountPaise)} has been sent`, body: "See the details in Billing.", url: "/dashboard/billing", tag: `refund-${paymentId}` };
}

// ---------------------------------------------------------------------------
// Cron: T-15 and go-live reminders
// ---------------------------------------------------------------------------
export const T15_MS = 15 * 60_000;
export const LOOKAHEAD_MS = 20 * 60_000;
export const LOOKBACK_MS = 10 * 60_000;

export interface ReminderRow { listing_id: string; uid: string; title: string; kind?: string; status: string; starts_at: unknown; duration_min: unknown }
export interface ReminderDecision { listing_id: string; uid: string; kind: "t15" | "live"; title: string }

/**
 * Pure: which reminders are due at `now`. Only events starting in the next 20 min or
 * started in the last 10 min are considered (the SQL window mirrors this).
 *   * live — the start time is reached, or listing_schedule says the show is live.
 *   * t15  — start is within 15 minutes and the show is not live yet.
 * Dedup against push_sent happens in the caller.
 */
export function reminderDecisions(rows: ReminderRow[], now: number): ReminderDecision[] {
  const out: ReminderDecision[] = [];
  for (const r of rows) {
    const start = toMs(r.starts_at);
    if (start === null) continue;
    if (start > now + LOOKAHEAD_MS || start < now - LOOKBACK_MS) continue;
    const state = scheduleState({ kind: r.kind ?? "live_event", status: r.status, starts_at: start, duration_min: r.duration_min }, now);
    if (state === "cancelled" || state === "ended" || state === "expired" || state === "unpublished") continue;
    const base = { listing_id: r.listing_id, uid: r.uid, title: r.title };
    if (state === "live" || now >= start) out.push({ ...base, kind: "live" });
    else if (start - now <= T15_MS) out.push({ ...base, kind: "t15" });
  }
  return out;
}

const startMs = (a: string) =>
  `(CASE WHEN ${a}.starts_at < 100000000000 THEN ${a}.starts_at*1000 ELSE ${a}.starts_at END)`;

/** SQL: seat holders (paid or free) of live events in the window, who have a push subscription. */
export const REMINDER_ROWS_SQL = `
SELECT DISTINCT l.id AS listing_id, o.buyer_id AS uid, l.title, l.kind, l.status, l.starts_at, l.duration_min
  FROM listings l JOIN orders o ON o.listing_id=l.id
 WHERE l.kind='live_event' AND l.status IN ('published','live')
   AND COALESCE(l.starts_at,0) > 0
   AND ${startMs("l")} BETWEEN ?1 AND ?2
   AND o.status IN ('held','free','released')
   AND EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.uid=o.buyer_id)
 LIMIT 500`;

/** Claims (listing_id, uid, kind) once; true only for the caller that inserted it. */
export async function claimPush(env: Env, listingId: string, uid: string, kind: string, now: number): Promise<boolean> {
  const r = await env.DB_META.prepare("INSERT OR IGNORE INTO push_sent (listing_id, uid, kind, sent_at) VALUES (?1,?2,?3,?4)")
    .bind(listingId, uid, kind, now).run();
  return (r.meta?.changes ?? 0) > 0;
}

/** Cron entry point (every 5 min). Never throws. */
export async function runPushReminders(env: PushEnv, now = Date.now()): Promise<{ scanned: number; sent: number }> {
  const keys = await vapidOrWarn(env);
  if (!keys) return { scanned: 0, sent: 0 }; // do not burn dedup rows while push is off
  let scanned = 0, sent = 0;
  try {
    const rs = await env.DB_META.prepare(REMINDER_ROWS_SQL).bind(now - LOOKBACK_MS, now + LOOKAHEAD_MS).all<ReminderRow>();
    const rows = rs.results ?? [];
    scanned = rows.length;
    for (const d of reminderDecisions(rows, now)) {
      // At-most-once: claim first, then send. A crash between the two loses one reminder, never doubles it.
      if (!(await claimPush(env, d.listing_id, d.uid, d.kind, now))) continue;
      const r = await sendPushToUser(env, d.uid, reminderPayload(d.kind, d.listing_id, d.title), d.kind);
      if (r.sent) sent++;
    }
  } catch (e) {
    await trackException(env, e, { handled: true, app_name: APP, route: "cron_push_reminders", extra: { area: "dash2_push" } }).catch(() => undefined);
  }
  return { scanned, sent };
}

/** Refund recorded by an admin -> tell the buyer. Never throws. */
export async function notifyRefundPush(env: PushEnv, uid: string, paymentId: string, amountPaise: number): Promise<void> {
  try {
    const first = await claimPush(env, paymentId, uid, "refund", Date.now()).catch(() => true);
    if (!first) return;
    await sendPushToUser(env, uid, refundPayload(paymentId, amountPaise), "refund");
  } catch (e) {
    await trackException(env, e, { uid, handled: true, app_name: APP, route: "web_push_refund", extra: { area: "dash2_push" } }).catch(() => undefined);
  }
}
