// [HF-REF-AUTH-1] Honest native registration: real name, immutable public
// username and the five explicit legal acknowledgements from the reference UI.
import type { Env } from "../types";
import { requireUser, isFail } from "../authz";
import { json } from "../util";
import { rateLimit } from "../money";
import { contactLeak } from "../lib/hf_options";
import { track, trackException } from "../hooks";
import { BRAND } from "../lib/brand";

const APP = BRAND.slug;
const REQUIRED_POLICIES = ["terms", "privacy", "disclaimer", "community", "engagement"] as const;
const USERNAME_RE = /^[a-z][a-z0-9._]{2,29}$/;

const err = (status: number, error: string, message: string, field?: string) =>
  json({ error, message, ...(field ? { field } : {}) }, status);

function cleanName(raw: unknown, field: string): { ok: true; value: string } | { ok: false; response: Response } {
  if (typeof raw !== "string") return { ok: false, response: err(400, "invalid_field", `Enter your ${field === "firstName" ? "first" : "last"} name.`, field) };
  const value = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  if ([...value].length < 1 || [...value].length > 40 || /\p{Nd}/u.test(value) || contactLeak(value) || /[<>@/\\]/.test(value)) {
    return { ok: false, response: err(400, "invalid_field", "Use only your real name, without numbers or contact details.", field) };
  }
  return { ok: true, value };
}

export function normalizeHfUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.normalize("NFKC").trim().toLowerCase();
  return USERNAME_RE.test(value) && !value.includes("..") ? value : null;
}

async function usernameAvailability(req: Request, env: Env, uid: string): Promise<Response> {
  const raw = new URL(req.url).searchParams.get("value");
  const username = normalizeHfUsername(raw);
  if (!username) return err(400, "invalid_username", "Use 3–30 lowercase letters, numbers, dots or underscores, starting with a letter.", "username");
  const row = await env.DB_META.prepare("SELECT uid FROM hf_user_registration WHERE lower(username)=lower(?1)")
    .bind(username).first<{ uid: string }>();
  return json({ available: !row || row.uid === uid, username });
}

async function register(req: Request, env: Env, uid: string): Promise<Response> {
  const lim = await rateLimit(env, `hfreg:${uid}`, 20, 3600);
  if (lim) return lim;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return err(400, "invalid_body", "Complete every registration field.");
  const first = cleanName(body.firstName, "firstName");
  if (!first.ok) return first.response;
  const last = cleanName(body.lastName, "lastName");
  if (!last.ok) return last.response;
  const username = normalizeHfUsername(body.username);
  if (!username) return err(400, "invalid_username", "Use 3–30 lowercase letters, numbers, dots or underscores, starting with a letter.", "username");
  const accepted = new Set(Array.isArray(body.acceptedPolicies) ? body.acceptedPolicies.map(String) : []);
  const missing = REQUIRED_POLICIES.filter((x) => !accepted.has(x));
  if (missing.length) return json({ error: "policies_required", message: "Read and accept every agreement to continue.", missing }, 400);

  const existing = await env.DB_META.prepare("SELECT first_name,last_name,username FROM hf_user_registration WHERE uid=?1")
    .bind(uid).first<{ first_name: string; last_name: string; username: string }>();
  if (existing) {
    const same = existing.first_name === first.value && existing.last_name === last.value && existing.username.toLowerCase() === username;
    return same
      ? json({ ok: true, username: existing.username, registrationComplete: true })
      : err(409, "username_locked", "Your username was already saved and cannot be changed.", "username");
  }

  const taken = await env.DB_META.prepare("SELECT 1 AS x FROM hf_user_registration WHERE lower(username)=lower(?1)")
    .bind(username).first();
  if (taken) return err(409, "username_taken", "That username is already taken.", "username");
  const now = Date.now();
  try {
    await env.DB_META.batch([
      env.DB_META.prepare(
        `INSERT INTO hf_user_registration
          (uid,first_name,last_name,username,terms_accepted_at,privacy_accepted_at,disclaimer_accepted_at,community_accepted_at,engagement_accepted_at,created_at)
         VALUES (?1,?2,?3,?4,?5,?5,?5,?5,?5,?5)`,
      ).bind(uid, first.value, last.value, username, now),
      env.DB_META.prepare("UPDATE users SET display_name=?2, updated_at=?3 WHERE uid=?1")
        .bind(uid, `${first.value} ${last.value}`.trim(), now),
    ]);
  } catch (cause) {
    await trackException(env, cause, { uid, route: "/api/hf/me/registration", method: "POST", handled: true, app_name: APP });
    const raced = await env.DB_META.prepare("SELECT uid FROM hf_user_registration WHERE lower(username)=lower(?1)").bind(username).first();
    return raced ? err(409, "username_taken", "That username is already taken.", "username") : err(503, "registration_failed", "We couldn’t save that just now. Please try again.");
  }
  void track(env, uid, "hf_registration_completed", APP, { username_length: username.length });
  return json({ ok: true, username, registrationComplete: true });
}

export async function hfRegistrationRoute(req: Request, env: Env, path: string): Promise<Response | null> {
  if (path !== "/api/hf/me/registration" && path !== "/api/hf/me/username") return null;
  const expected = path.endsWith("/username") ? "GET" : "POST";
  if (req.method !== expected) return err(405, "method_not_allowed", "That action is not available.");
  const auth = await requireUser(req, env);
  if (isFail(auth)) return err(auth.status, auth.error, "Please sign in again.");
  return path.endsWith("/username")
    ? usernameAvailability(req, env, auth.uid)
    : register(req, env, auth.uid);
}
