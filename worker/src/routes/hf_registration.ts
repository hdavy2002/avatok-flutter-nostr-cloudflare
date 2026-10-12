// [HF-REF-AUTH-1] Honest native registration: real name, immutable public
// username and the five explicit legal acknowledgements from the reference UI.
import type { Env } from "../types";
import { requireUser, isFail } from "../authz";
import { json } from "../util";
import { rateLimit } from "../money";
import { contactLeak } from "../lib/hf_options";
import { track, trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { HF_REGISTRATION_POLICIES, REGISTRATION_POLICY_NAMES, currentPolicyAcceptances } from "../lib/hf_registration_policies";

const APP = BRAND.slug;
const REQUIRED_POLICIES = REGISTRATION_POLICY_NAMES;
const USERNAME_RE = /^[a-z][a-z0-9._]{2,29}$/;
const RESERVED_USERNAMES = new Set([
  "admin", "administrator", "moderator", "mod", "support", "help", "helpdesk", "official",
  "staff", "team", "system", "security", "safety", "billing", "payments", "wallet", "root",
  "api", "www", "null", "undefined", "deleted", "anonymous",
  BRAND.slug.replace(/[^a-z0-9]/g, ""), BRAND.name.replace(/[^a-z0-9]/gi, "").toLowerCase(),
]);

export function isReservedHfUsername(username: string): boolean {
  // Also reject punctuation camouflage such as a.d.m.i.n and support_team.
  const compact = username.replace(/[._]/g, "");
  return RESERVED_USERNAMES.has(compact) || /^(admin|administrator|support|moderator|official|staff|security)(team|help|desk|\d+)$/.test(compact);
}

interface ContactProof { phone_verified: number | null; email_verified: number | null }
interface Draft {
  first_name: string | null; last_name: string | null; username: string | null;
  kyc_choice: number | null; accepted_policies_json: string;
}
async function contactProof(env: Env, uid: string): Promise<ContactProof | null> {
  return env.DB_META.prepare("SELECT phone_verified,email_verified FROM contact_verification WHERE uid=?1").bind(uid).first<ContactProof>();
}
function missingContacts(proof: ContactProof | null): string[] {
  return [Number(proof?.phone_verified) !== 1 ? "whatsapp" : null, Number(proof?.email_verified) !== 1 ? "email" : null].filter((x): x is string => x !== null);
}
const contactsRequired = (missing: string[]) => json({ error: "contact_verification_required", message: "Verify your WhatsApp number and email before continuing.", missing, field: missing[0] }, 403);

async function readDraft(env: Env, uid: string): Promise<Draft | null> {
  return env.DB_META.prepare("SELECT first_name,last_name,username,kyc_choice,accepted_policies_json FROM hf_registration_progress WHERE uid=?1").bind(uid).first<Draft>();
}

async function progress(env: Env, uid: string): Promise<Response> {
  const [proof, draft, registered, signup, challengeRaw] = await Promise.all([
    contactProof(env, uid), readDraft(env, uid),
    env.DB_META.prepare("SELECT first_name,last_name,username FROM hf_user_registration WHERE uid=?1").bind(uid).first<{ first_name: string; last_name: string; username: string }>(),
    env.DB_META.prepare("SELECT 1 AS x FROM hf_phone_signup WHERE uid=?1 AND state='done'").bind(uid).first(),
    env.TOKENS.get(`otp:email:${uid}`),
  ]);
  let emailChallenge: { email: string; expiresAt: number } | null = null;
  try {
    const challenge = challengeRaw ? JSON.parse(challengeRaw) : null;
    if (challenge && typeof challenge.email === "string" && Number.isFinite(challenge.exp) && challenge.exp > Date.now() && challenge.attempts < 5) {
      emailChallenge = { email: challenge.email, expiresAt: challenge.exp };
    }
  } catch { /* Expired or malformed challenge resumes at email entry. */ }
  let accepted: unknown = {};
  try { accepted = JSON.parse(draft?.accepted_policies_json ?? "{}"); } catch { /* Re-ask. */ }
  const whatsappVerified = Number(proof?.phone_verified) === 1;
  const emailVerified = Number(proof?.email_verified) === 1;
  const step = registered ? 8 : !whatsappVerified ? 1 : !emailVerified ? (emailChallenge ? 3 : 2)
    : !draft?.first_name || !draft.last_name ? 4 : !draft.username ? 5 : draft.kyc_choice == null ? 6 : 7;
  return json({
    uid, registrationRequired: !registered && !!(signup || draft), registrationComplete: !!registered,
    step, whatsappVerified, emailVerified, emailChallenge: emailVerified ? null : emailChallenge,
    firstName: registered?.first_name ?? draft?.first_name ?? null, lastName: registered?.last_name ?? draft?.last_name ?? null,
    username: registered?.username ?? draft?.username ?? null,
    kycNow: draft?.kyc_choice == null ? null : draft.kyc_choice === 1,
    acceptedPolicyVersions: currentPolicyAcceptances(accepted), policies: HF_REGISTRATION_POLICIES,
  }, 200, { "cache-control": "private, no-store" });
}

async function saveProgress(req: Request, env: Env, uid: string): Promise<Response> {
  const lim = await rateLimit(env, `hfregprogress:${uid}`, 120, 3600);
  if (lim) return lim;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return err(400, "invalid_body", "Please try that step again.");
  const missing = missingContacts(await contactProof(env, uid));
  if (missing.length) return contactsRequired(missing);
  const completed = await env.DB_META.prepare("SELECT 1 AS x FROM hf_user_registration WHERE uid=?1").bind(uid).first();
  if (completed) return progress(env, uid);
  const draft = await readDraft(env, uid);
  // Whitelist each step's fields. Request-supplied uid, OTP, or verification
  // flags never enter this record and cannot grant a completed step.
  let columns: string;
  let values: (string | number)[];
  if (body.step === "name") {
    const first = cleanName(body.firstName, "firstName");
    if (!first.ok) return first.response;
    const last = cleanName(body.lastName, "lastName");
    if (!last.ok) return last.response;
    columns = "first_name=excluded.first_name,last_name=excluded.last_name";
    await env.DB_META.prepare(`INSERT INTO hf_registration_progress (uid,first_name,last_name,updated_at) VALUES (?1,?2,?3,?4)
      ON CONFLICT(uid) DO UPDATE SET ${columns},updated_at=excluded.updated_at`).bind(uid, first.value, last.value, Date.now()).run();
  } else {
    if (!draft?.first_name || !draft.last_name) return err(409, "name_required", "Save your name first.");
    if (body.step === "username") {
      const username = normalizeHfUsername(body.username);
      if (!username) return err(400, "invalid_username", "Choose a valid username.", "username");
      if (isReservedHfUsername(username)) return err(400, "username_reserved", "That username is reserved. Choose another.", "username");
      const taken = await env.DB_META.prepare("SELECT 1 AS x FROM hf_user_registration WHERE lower(username)=lower(?1)").bind(username).first();
      if (taken) return err(409, "username_taken", "That username is already taken.", "username");
      columns = "username=?2"; values = [username];
    } else if (body.step === "kyc") {
      if (!draft.username || typeof body.kycNow !== "boolean") return err(400, "invalid_step", "Choose your username and verification preference first.");
      columns = "kyc_choice=?2"; values = [body.kycNow ? 1 : 0];
    } else if (body.step === "policies") {
      if (!draft.username || draft.kyc_choice == null) return err(409, "invalid_step", "Complete the earlier steps first.");
      const accepted = currentPolicyAcceptances(body.acceptedPolicyVersions);
      columns = "accepted_policies_json=?2"; values = [JSON.stringify(accepted)];
    } else return err(400, "invalid_step", "Choose a registration step.");
    await env.DB_META.prepare(`UPDATE hf_registration_progress SET ${columns},updated_at=?3 WHERE uid=?1`).bind(uid, ...values, Date.now()).run();
  }
  return progress(env, uid);
}

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
  if (isReservedHfUsername(username)) return json({ available: false, username, reason: "reserved" });
  const row = await env.DB_META.prepare("SELECT uid FROM hf_user_registration WHERE lower(username)=lower(?1)")
    .bind(username).first<{ uid: string }>();
  return json({ available: !row || row.uid === uid, username });
}

async function register(req: Request, env: Env, uid: string): Promise<Response> {
  const lim = await rateLimit(env, `hfreg:${uid}`, 20, 3600);
  if (lim) return lim;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return err(400, "invalid_body", "Complete every registration field.");
  const missingProofs = missingContacts(await contactProof(env, uid));
  if (missingProofs.length) return contactsRequired(missingProofs);
  const first = cleanName(body.firstName, "firstName");
  if (!first.ok) return first.response;
  const last = cleanName(body.lastName, "lastName");
  if (!last.ok) return last.response;
  const username = normalizeHfUsername(body.username);
  if (!username) return err(400, "invalid_username", "Use 3–30 lowercase letters, numbers, dots or underscores, starting with a letter.", "username");
  if (isReservedHfUsername(username)) return err(400, "username_reserved", "That username is reserved. Choose another.", "username");
  const accepted = new Set(Array.isArray(body.acceptedPolicies) ? body.acceptedPolicies.map(String) : []);
  const missing = REQUIRED_POLICIES.filter((x) => !accepted.has(x));
  if (missing.length) return json({ error: "policies_required", message: "Read and accept every agreement to continue.", missing }, 400);
  const acceptedVersions = currentPolicyAcceptances(body.acceptedPolicyVersions);
  const stale = REQUIRED_POLICIES.filter((name) => !acceptedVersions[name]);
  if (stale.length) return json({ error: "policy_versions_required", message: "The agreements changed. Read and accept the current versions.", missing: stale }, 409);

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
    const result = await env.DB_META.batch([
      env.DB_META.prepare(
        `INSERT INTO hf_user_registration
          (uid,first_name,last_name,username,terms_accepted_at,privacy_accepted_at,disclaimer_accepted_at,community_accepted_at,engagement_accepted_at,created_at)
         SELECT ?1,?2,?3,?4,?5,?5,?5,?5,?5,?5 FROM contact_verification
         WHERE uid=?1 AND phone_verified=1 AND email_verified=1`,
      ).bind(uid, first.value, last.value, username, now),
      env.DB_META.prepare("UPDATE users SET display_name=?2, updated_at=?3 WHERE uid=?1 AND EXISTS (SELECT 1 FROM hf_user_registration WHERE uid=?1)")
        .bind(uid, `${first.value} ${last.value}`.trim(), now),
      ...REQUIRED_POLICIES.map((name) => env.DB_META.prepare(
        `INSERT INTO hf_registration_policy_acceptances (uid,policy,document_version,accepted_at)
         SELECT uid,?2,?3,?4 FROM hf_user_registration WHERE uid=?1`,
      ).bind(uid, name, acceptedVersions[name]!, now)),
      env.DB_META.prepare("DELETE FROM hf_registration_progress WHERE uid=?1 AND EXISTS (SELECT 1 FROM hf_user_registration WHERE uid=?1)").bind(uid),
    ]);
    if (!Number(result[0].meta?.changes)) {
      const missing = missingContacts(await contactProof(env, uid));
      return missing.length ? contactsRequired(missing) : err(409, "verification_changed", "Your verification changed. Please try again.");
    }
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
  const allowed = path.endsWith("/username") ? ["GET"] : ["GET", "PATCH", "POST"];
  if (!allowed.includes(req.method)) return err(405, "method_not_allowed", "That action is not available.");
  const auth = await requireUser(req, env);
  if (isFail(auth)) return err(auth.status, auth.error, "Please sign in again.");
  try {
    if (path.endsWith("/username")) return await usernameAvailability(req, env, auth.uid);
    if (req.method === "GET") return await progress(env, auth.uid);
    if (req.method === "PATCH") return await saveProgress(req, env, auth.uid);
    return await register(req, env, auth.uid);
  } catch (cause) {
    await trackException(env, cause, { uid: auth.uid, route: path, method: req.method, handled: true, app_name: APP });
    return err(503, "registration_unavailable", "We could not load or save your registration. Please try again.");
  }
}
