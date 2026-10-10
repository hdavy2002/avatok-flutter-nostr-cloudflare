// [HF-NATIVE-S1] The native app's "who am I" call: one cheap read for routing, tabs and the Me screen.
//   GET   /api/hf/me   signed in -> { uid, displayName, phoneMasked, whatsappVerified, ackVersion, age18ConfirmedAt, isHost,
//                                     host: {status, slug} | null, lanes: {women, lgbtq}, closing, tokensMode }
//   PATCH /api/hf/me   { displayName }   signed in -> { ok, displayName }   (2-40 chars, no digits, no contact details)
// Not avaTOK's /api/me (that one is avaTOK-shaped). Never returns a full phone number, an email or a Clerk id other than uid.
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
  age_at: number | null; host_status: string | null; host_slug: string | null;
}

export async function hfMeRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  if (p !== "/api/hf/me") return null;
  if (req.method !== "GET" && req.method !== "PATCH") return err(405, "method_not_allowed");
  try {
    const u = await requireUser(req, env);
    if (isFail(u)) return err(u.status, u.error);
    return req.method === "GET" ? await getMe(env, u.uid) : await patchMe(req, env, u.uid);
  } catch (e) {
    await trackException(env, e, { route: p, method: req.method, handled: true, app_name: APP, extra: { area: "hf_me" } });
    return err(500, "internal_error", "Something went wrong. Please try again.");
  }
}

async function getMe(env: Env, uid: string): Promise<Response> {
  // One joined read for the profile facts, plus the ack, lane and closing checks and the (KV-cached) config, all in parallel.
  const [row, ack, lanes, closing, cfg] = await Promise.all([
    env.DB_META.prepare(
      `SELECT u.display_name AS display_name,
              cv.phone_verified AS phone_verified,
              (SELECT o.e164 FROM phone_otp o WHERE o.uid=?1 AND o.phone_hash=cv.phone_hash AND o.status='verified' ORDER BY o.verified_at DESC LIMIT 1) AS e164,
              (SELECT a.confirmed_at FROM hf_age_confirm a WHERE a.uid=?1) AS age_at,
              h.status AS host_status, h.slug AS host_slug
         FROM (SELECT ?1 AS uid) x
         LEFT JOIN users u ON u.uid=x.uid
         LEFT JOIN contact_verification cv ON cv.uid=x.uid
         LEFT JOIN hf_hosts h ON h.uid=x.uid`,
    ).bind(uid).first<MeRow>().catch(() => null),
    // [HF-NATIVE-S4] Kept apart so a missing table (migration not applied yet) can never blank the rest of the answer.
    env.DB_META.prepare("SELECT version FROM hf_user_ack WHERE uid=?1 ORDER BY at DESC LIMIT 1").bind(uid).first<{ version: string }>().catch(() => null),
    getLaneAccess(env, uid).catch(() => ({ women: false, lgbtq: false })),
    isClosing(env, uid),
    readConfig(env).catch(() => null),
  ]);
  const host = row?.host_status ? { status: row.host_status, slug: row.host_slug ?? null } : null;
  const body = {
    uid,
    displayName: row?.display_name?.trim() ? row.display_name : null,
    phoneMasked: maskPhoneLast4(row?.e164),
    whatsappVerified: Number(row?.phone_verified) === 1,
    ackVersion: ack?.version ?? null,
    age18ConfirmedAt: row?.age_at ?? null,
    isHost: !!host,
    host,
    lanes,
    closing,
    tokensMode: cfg?.hfTokensEnabled === true,
  };
  return json(body, 200, { "cache-control": "private, no-store" });
}

async function patchMe(req: Request, env: Env, uid: string): Promise<Response> {
  const lim = await rateLimit(env, `hfme:${uid}`, 20, 3600);
  if (lim) return lim;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return err(400, "invalid_body", "Please send your name.");
  const v = validateDisplayName(b.displayName);
  if (!v.ok) return err(400, "invalid_field", v.message, { field: "displayName" });
  const r = await env.DB_META.prepare("UPDATE users SET display_name=?2, updated_at=?3 WHERE uid=?1").bind(uid, v.name, Date.now()).run();
  if (!Number(r.meta?.changes ?? 0)) return err(404, "no_account", "We couldn't find your account. Please sign in again.");
  void track(env, uid, "hf_me_name_updated", APP, { outcome: "ok", length: [...v.name].length });
  return json({ ok: true, displayName: v.name });
}
