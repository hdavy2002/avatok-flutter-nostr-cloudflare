// [HF-NATIVE-S1] The native app's "who am I" call: one cheap read for routing, tabs and the Me screen.
//   GET   /api/hf/me   signed in -> { uid, displayName, phoneMasked, whatsappVerified, ackVersion, age18ConfirmedAt, isHost,
//                                     host: {status, slug} | null, lanes: {women, lgbtq}, closing, tokensMode,
//                                     [HF-WIRE-1B reels app, additive:] name, email|null, whatsapp (masked), role: 'fan'|'host' (host = live),
//                                     hostStatus|null (raw hf_hosts.status), presence|null (hosts only), walletPaise|null, prefs:{notifyWhatsapp,apptReminders,reelAlerts} }
//        walletPaise is the caller's own spendable balance in paise, or null when it could not be read (use GET /api/hf/wallet for the breakdown).
//   PATCH /api/hf/me   { displayName?, email? }   signed in -> { ok, displayName, email }   (name: 2-40 chars, no digits, no contact details;
//        [HF-WIRE-2] email: stored in hf_user_email, needs flag hfFanSignupEnabled else 403 feature_off; at least one field required)
//   POST  /api/hf/me/ack { version, ack18? }  signed in -> { ok, ackVersion, age18ConfirmedAt }   [HF-NATIVE-S4]
//        stores hf_user_ack(uid, version, at) (first ack of a version wins) and, when ack18 is true, the existing hf_age_confirm row.
// Not avaTOK's /api/me (that one is avaTOK-shaped). Never returns a full phone number, an email or a Clerk id other than uid.
import { lineFieldsForUids } from "../lib/hf_host_line_view"; // [HF-CALL-MODES-A]
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { track, trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { contactLeak } from "../lib/hf_options";
import { getLaneAccess } from "../lib/hf_lanes";
import { isClosing } from "../lib/hf_exit";
import { readConfig } from "./config";
import { emailFor } from "../lib/identity";
import { resolveHfHandle } from "../lib/hf_handle";
import { walletOp } from "./wallet";
import { balanceSummary } from "../lib/hf_token_ledger";

const APP = BRAND.slug;
const err = (status: number, error: string, message?: string, extra: Record<string, unknown> = {}) =>
  json({ error, message: message ?? error, ...extra }, status);

/** Last four digits only, e.g. "******3210". Empty/short input gives null. */
export function maskPhoneLast4(e164: string | null | undefined): string | null {
  const d = String(e164 ?? "").replace(/\D/g, "");
  return d.length >= 4 ? `******${d.slice(-4)}` : null;
}

export type NameCheck = { ok: true; name: string } | { ok: false; message: string };
/** 2-40 characters, no digits, no phone numbers / links / handles / app names (same contact-detail check as host profiles and reviews). */
export function validateDisplayName(raw: unknown): NameCheck {
  if (typeof raw !== "string") return { ok: false, message: "Please enter your name." };
  const name = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  const len = [...name].length;
  if (len < 2 || len > 40) return { ok: false, message: "Your name must be 2 to 40 characters." };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f<>]/.test(name)) return { ok: false, message: "Please use letters only in your name." };
  if (/\p{Nd}/u.test(name)) return { ok: false, message: "Your name can't have numbers in it." };
  if (contactLeak(name) || /[@/\\]/.test(name)) return { ok: false, message: "Please don't put phone numbers, links or handles in your name." };
  return { ok: true, name };
}

interface MeRow {
  display_name: string | null; phone_verified: number | null; e164: string | null;
  age_at: number | null; host_status: string | null; host_slug: string | null; host_presence: string | null;
}

export async function hfMeRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  if (p !== "/api/hf/me" && p !== "/api/hf/me/ack") return null;
  const ok = p === "/api/hf/me/ack" ? req.method === "POST" : req.method === "GET" || req.method === "PATCH";
  if (!ok) return err(405, "method_not_allowed");
  try {
    const u = await requireUser(req, env);
    if (isFail(u)) return err(u.status, u.error);
    if (p === "/api/hf/me/ack") return await postAck(req, env, u.uid);
    return req.method === "GET" ? await getMe(env, u.uid) : await patchMe(req, env, u.uid);
  } catch (e) {
    await trackException(env, e, { route: p, method: req.method, handled: true, app_name: APP, extra: { area: "hf_me" } });
    return err(500, "internal_error", "Something went wrong. Please try again.");
  }
}

async function getMe(env: Env, uid: string): Promise<Response> {
  // One joined read for the profile facts, plus the ack, lane and closing checks and the (KV-cached) config, all in parallel.
  const [row, ack, registration, registrationPending, lanes, closing, cfg, clerkEmail, prefs, typedEmail] = await Promise.all([
    env.DB_META.prepare(
      `SELECT u.display_name AS display_name,
              cv.phone_verified AS phone_verified,
              (SELECT o.e164 FROM phone_otp o WHERE o.uid=?1 AND o.phone_hash=cv.phone_hash AND o.status='verified' ORDER BY o.verified_at DESC LIMIT 1) AS e164,
              (SELECT a.confirmed_at FROM hf_age_confirm a WHERE a.uid=?1) AS age_at,
              h.status AS host_status, h.slug AS host_slug, h.presence AS host_presence
         FROM (SELECT ?1 AS uid) x
         LEFT JOIN users u ON u.uid=x.uid
         LEFT JOIN contact_verification cv ON cv.uid=x.uid
         LEFT JOIN hf_hosts h ON h.uid=x.uid`,
    ).bind(uid).first<MeRow>().catch(() => null),
    // [HF-NATIVE-S4] Kept apart so a missing table (migration not applied yet) can never blank the rest of the answer.
    env.DB_META.prepare("SELECT version FROM hf_user_ack WHERE uid=?1 ORDER BY at DESC LIMIT 1").bind(uid).first<{ version: string }>().catch(() => null),
    // [HF-REF-AUTH-1] Registration is a separate immutable record. Keep this
    // read failure-isolated so an unapplied migration does not break sign-in.
    env.DB_META.prepare("SELECT username FROM hf_user_registration WHERE uid=?1").bind(uid).first<{ username: string }>().catch(() => null),
    // Server-owned signup membership survives reinstalls, lost ticket responses,
    // and another device signing into an unfinished account.
    env.DB_META.prepare(`SELECT 1 AS x FROM hf_phone_signup WHERE uid=?1 AND state='done'
      UNION SELECT 1 AS x FROM hf_registration_progress WHERE uid=?1 LIMIT 1`).bind(uid).first().catch(() => null), // [HF-WIRE-1B] a missing table must not blank /me
    getLaneAccess(env, uid).catch(() => ({ women: false, lgbtq: false })),
    isClosing(env, uid),
    readConfig(env).catch(() => null),
    // [HF-WIRE-1B] The caller's OWN email (KV-cached Clerk lookup); null if it cannot be read. Never another user's.
    (async () => emailFor(env, uid))().catch(() => null),
    (async () => env.DB_META.prepare("SELECT * FROM hf_user_prefs WHERE uid=?1").bind(uid)
      .first<{ notify_whatsapp: number; appt_reminders: number | null; reel_alerts?: number | null }>())().catch(() => null),
    // [HF-WIRE-2] The email a fan typed at sign-up (phone-only accounts have no Clerk email). Failure-isolated.
    env.DB_META.prepare("SELECT email FROM hf_user_email WHERE uid=?1").bind(uid).first<{ email: string }>().then((r) => r?.email ?? null).catch(() => null),
  ]);
  // [HF-FIX-HANDLE-1] Everyone has a handle; assign lazily when no registered username exists.
  const handle = await resolveHfHandle(env, uid, registration?.username);
  const walletPaise = await readWalletPaise(env, uid, cfg?.hfTokensEnabled === true);
  const hostLine = row?.host_status ? (await lineFieldsForUids(env, [uid]).catch(() => null))?.get(uid) : undefined; // [HF-CALL-MODES-A] mode / callState / queue (flag on only)
  const email = clerkEmail ?? typedEmail;
  const host = row?.host_status ? { status: row.host_status, slug: row.host_slug ?? null } : null;
  const displayName = row?.display_name?.trim() ? row.display_name : null;
  const phoneMasked = maskPhoneLast4(row?.e164);
  const body = {
    uid,
    displayName,
    username: handle,
    registrationComplete: !!registration?.username,
    registrationRequired: !registration?.username && !!registrationPending,
    phoneMasked,
    whatsappVerified: Number(row?.phone_verified) === 1,
    ackVersion: ack?.version ?? null,
    age18ConfirmedAt: row?.age_at ?? null,
    isHost: !!host,
    host,
    lanes,
    closing,
    tokensMode: cfg?.hfTokensEnabled === true,
    // [HF-WIRE-1B] Reels-app fields (additive; every field above is unchanged).
    name: displayName,
    email: email ?? null,
    whatsapp: phoneMasked,
    role: row?.host_status === "live" || row?.host_status === "approved" ? "host" : "fan", // [HF-WIRE-3] Channels-approved influencers are hosts too
    hostStatus: row?.host_status ?? null,
    presence: row?.host_status ? (row.host_presence ?? "offline") : null,
    ...(hostLine ? { mode: hostLine.mode, callState: hostLine.callState, queue: hostLine.queue } : {}),
    walletPaise,
    prefs: { notifyWhatsapp: prefs ? Number(prefs.notify_whatsapp) === 1 : true, apptReminders: prefs ? Number(prefs.appt_reminders ?? 1) !== 0 : true, reelAlerts: prefs ? Number(prefs.reel_alerts ?? 1) !== 0 : true },
  };
  return json(body, 200, { "cache-control": "private, no-store" });
}

/** [HF-WIRE-1B] Caller's own spendable balance in paise; null if unreadable. Token mode reads the lot ledger, the old mode the rupee WalletDO. */
async function readWalletPaise(env: Env, uid: string, tokensMode: boolean): Promise<number | null> {
  try {
    if (tokensMode) return Math.max(0, Math.trunc((await balanceSummary(env, uid)).availablePaise));
    const snap = await walletOp(env, uid, { op: "balance", uid });
    if (snap.status !== 200) return null;
    return Math.max(0, Math.trunc(Number(snap.body?.balance ?? 0))) * 100;
  } catch { return null; }
}

const EMAIL_RE = /^[^\s@<>()\\,;:"]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
/** [HF-WIRE-2] Trimmed, lower-cased, <=254 chars, one "@", a dot in the domain. */
export function validateEmail(raw: unknown): { ok: true; email: string } | { ok: false; message: string } {
  const email = typeof raw === "string" ? raw.normalize("NFKC").trim().toLowerCase() : "";
  if (!email || email.length > 254 || !EMAIL_RE.test(email) || email.includes("..")) return { ok: false, message: "Please enter a valid email address." };
  return { ok: true, email };
}

async function patchMe(req: Request, env: Env, uid: string): Promise<Response> {
  const lim = await rateLimit(env, `hfme:${uid}`, 20, 3600);
  if (lim) return lim;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return err(400, "invalid_body", "Please send your name.");
  const hasName = b.displayName !== undefined, hasEmail = b.email !== undefined;
  if (!hasName && !hasEmail) return err(400, "invalid_body", "Please send your name or email.");
  let name: string | null = null, email: string | null = null;
  if (hasName) {
    const v = validateDisplayName(b.displayName);
    if (!v.ok) return err(400, "invalid_field", v.message, { field: "displayName" });
    name = v.name;
  }
  if (hasEmail) {
    if (!(await readConfig(env).catch(() => null))?.hfFanSignupEnabled) return err(403, "feature_off", "This isn\u2019t available yet.");
    const v = validateEmail(b.email);
    if (!v.ok) return err(400, "invalid_field", v.message, { field: "email" });
    email = v.email;
  }
  const now = Date.now();
  if (name !== null) {
    const r = await env.DB_META.prepare("UPDATE users SET display_name=?2, updated_at=?3 WHERE uid=?1").bind(uid, name, now).run();
    if (!Number(r.meta?.changes ?? 0)) return err(404, "no_account", "We couldn't find your account. Please sign in again.");
    void track(env, uid, "hf_me_name_updated", APP, { outcome: "ok", length: [...name].length });
  }
  if (email !== null) {
    await env.DB_META.prepare(
      "INSERT INTO hf_user_email (uid, email, updated_at) VALUES (?1,?2,?3) ON CONFLICT(uid) DO UPDATE SET email=excluded.email, updated_at=excluded.updated_at",
    ).bind(uid, email, now).run();
    void track(env, uid, "hf_me_email_saved", APP, { outcome: "ok" });
  }
  return json({ ok: true, ...(name !== null ? { displayName: name } : {}), ...(email !== null ? { email } : {}) });
}

// ---------------------------------------------------------------------------
// POST /api/hf/me/ack {version, ack18?} (signed in) -- [HF-NATIVE-S4]
// The Welcome screen's "friendly conversation, not counselling... I am 18 or older" tick. `version` is the terms/safety text the user saw
// (config hfAckVersion is the current one; any well-formed version is stored, the app compares). ack18 true also records the 18+ confirmation
// in hf_age_confirm (same table and first-confirmation-wins rule as POST /api/hf/account/age-confirm). Re-sending is harmless.
// ---------------------------------------------------------------------------
const VERSION_RE = /^[A-Za-z0-9._-]{1,40}$/;
function sourceHint(v: unknown): string {
  const c = typeof v === "string" ? v.trim().toLowerCase() : "";
  return /^[a-z0-9_-]{1,16}$/.test(c) ? c : "app";
}

async function postAck(req: Request, env: Env, uid: string): Promise<Response> {
  const lim = await rateLimit(env, `hfack:${uid}`, 30, 3600);
  if (lim) return lim;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return err(400, "invalid_body", "Please send the version you accepted.");
  if (typeof b.version !== "string" || !VERSION_RE.test(b.version)) return err(400, "invalid_field", "That version is not valid.", { field: "version" });
  if (b.ack18 !== undefined && typeof b.ack18 !== "boolean") return err(400, "invalid_field", "ack18 must be true or false.", { field: "ack18" });
  const version = b.version;
  const ack18 = b.ack18 === true;
  const now = Date.now();
  const db = env.DB_META;
  const stmts = [db.prepare("INSERT OR IGNORE INTO hf_user_ack (uid, version, at) VALUES (?1,?2,?3)").bind(uid, version, now)];
  if (ack18) stmts.push(db.prepare("INSERT OR IGNORE INTO hf_age_confirm (uid, confirmed_at, source) VALUES (?1,?2,?3)").bind(uid, now, sourceHint(b.client)));
  try {
    await db.batch(stmts);
  } catch (e) {
    void track(env, uid, "hf_user_ack", APP, { outcome: "failed", reason: "db", version, ack18 });
    await trackException(env, e, { uid, route: "/api/hf/me/ack", method: "POST", handled: true, app_name: APP });
    return err(503, "ack_failed", "We couldn\u2019t save that just now. Please try again.");
  }
  const age = await db.prepare("SELECT confirmed_at FROM hf_age_confirm WHERE uid=?1").bind(uid).first<{ confirmed_at: number }>().catch(() => null);
  void track(env, uid, "hf_user_ack", APP, { outcome: "ok", version, ack18, age18_on_file: !!age });
  return json({ ok: true, ackVersion: version, age18ConfirmedAt: age?.confirmed_at ?? null });
}
