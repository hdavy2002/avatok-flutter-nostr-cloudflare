// [WEB-ACCOUNT-1 2026-09-05] The account a web signup never created.
//
// THE GAP
//
// Signing up on avatok.ai creates a CLERK account and nothing else. There is no
// Clerk webhook in the worker, and the web bundle never calls a profile
// endpoint — the only `INSERT INTO users` sites are the app's own
// `POST /api/profile`, the number routes' minimal placeholder, and the guest
// ladder. So a web-only buyer had no `users` row at all: no profile, no AvaTOK
// number, nothing to attach a phone to, and nothing for another user to find.
// They existed to Clerk and were invisible to avaTOK until the day they opened
// the app.
//
// That is why the owner's two asks — collect a phone at signup, and auto-assign
// an AvaTOK number — could not simply be added to a form. There was no row.
//
// WHAT THIS DOES
//
// One idempotent call, made by the web client the moment a Clerk session exists:
// materialise the `users` row, store the phone, and mark the account as
// web-born so the app knows to finish the job.
//
// ⚠️ THE NUMBER IS NOT ASSIGNED HERE — CHANGED [WEB-APP-ONBOARD-1 2026-09-06]
//
// This route used to call `autoAssignNumber` so signup would be fast ("this
// will be auto assigned to save sign up time"). The owner reversed that: the
// AvaTOK number is the user's identity in the app and picking it is a
// deliberate act, so the app's existing non-escapable number gate now does it.
//
// The decisive detail is that `autoAssignNumber` sets `free_number_used=1`
// (number.ts). Minting here spent the buyer's one free number on a number they
// never saw — and the app, finding `hasNumber:true`, would never offer them a
// choice. Leaving the column NULL keeps that free pick intact for the gate.
//
// Accepted consequence (owner decision 2026-09-06): until a web buyer installs
// the app and picks a number they are not findable by number inside AvaTOK
// (api.ts number search), and `POST /api/team/invite/accept` cannot match them
// (team.ts). Both resolve the moment they pass the gate. Nothing in `web/`
// reads the buyer's own number, and no checkout, order, booking or wallet path
// touches it, so the money lane is unaffected.
//
// ⚠️ PHONE STORAGE — A DELIBERATE EXCEPTION, OWNER DECISION 2026-09-05
//
// CLAUDE.md's pivot section says real numbers are "collected for signup only,
// stored as sha256(E.164), and shown to nobody". The owner has decided he needs
// to be able to CONTACT these buyers, which a hash cannot do. So this stores
// BOTH:
//
//   * `phone_hash`     — sha256(E.164), the existing convention. This is what
//                        matching, dedup and spam checks use, and it is the only
//                        one anything should compare against.
//   * `private_number` — the readable E.164 number.
//
// `private_number` is not new and is not a new leak: it already existed, already
// held a real number, and already stored RAW digits with the country code
// stripped (`number.ts` privateNumberSet). Writing normalised E.164 here is
// strictly better than what that path does. `show_private_number` stays 0, so it
// is never rendered to another user — it is an operator-visible field, not a
// public one.
//
// If the pivot rule is ever restored, this is the call site to change, and the
// hash is already there to fall back to.
import type { Env } from "../types";
import { json, normalizePhone } from "../util";
import { requireUser, isFail } from "../authz";
import { sha256Hex } from "../util";
import { track } from "../hooks";
import { ensureHandle } from "../lib/handles";
import { isVerifiedPhoneFor } from "./phone_otp";

const APP = "avatok";

/** E.164-ish: a leading + and 8–15 digits. Deliberately permissive about which
 *  country — this is a global marketplace and a strict per-country plan here
 *  would reject valid numbers we simply have not listed. */
function validE164(s: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(s);
}

/**
 * POST /api/account/bootstrap
 * Body: { phone?: string, country?: string, display_name?: string }
 *
 * Safe to call on every page load if the client wants to — it creates nothing
 * twice, never overwrites a name or number that is already set, and returns the
 * account's current state either way.
 */
export async function webAccountBootstrap(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const b = (await req.json().catch(() => ({}))) as any;
  const rawPhone = typeof b?.phone === "string" ? b.phone.trim() : "";
  const country = typeof b?.country === "string" && b.country.length === 2
    ? b.country.toUpperCase() : "IN";
  const displayName = typeof b?.display_name === "string" ? b.display_name.trim().slice(0, 80) : "";

  // A phone that was sent but is unusable is an ERROR, not something to store
  // half of. Silently dropping it would leave the owner with an account he
  // believes he can call and cannot.
  let e164: string | null = null;
  if (rawPhone) {
    const norm = normalizePhone(rawPhone);
    if (!validE164(norm)) {
      return json({
        error: "invalid_phone",
        message: "Enter the number with its country code, like +91 98765 43210.",
        field: "phone",
      }, 400);
    }
    e164 = norm;
    // [WEB-PHONE-OTP-1 2026-09-10] A phone is only stored once it has been
    // proven by SMS OTP (routes/phone_otp.ts). Before this, any well-formed
    // number was written unverified. Callers that send no phone (checkout) are
    // unaffected; the sign-up page only sends the number it just verified.
    if (!(await isVerifiedPhoneFor(env, ctx.uid, e164))) {
      try { void track(env, ctx.uid, "web_account_bootstrap", APP, { outcome: "phone_not_verified" }); } catch { /* */ }
      return json({
        error: "phone_not_verified",
        message: "Verify your phone number with the SMS code first.",
        field: "phone",
      }, 403);
    }
  }

  const now = Date.now();
  const db = env.DB_META;

  // 1. The row itself. ON CONFLICT DO NOTHING so a returning user keeps
  //    everything they already have.
  //
  //    `created_via='web'` is set ONLY on the INSERT, never on the conflict
  //    path. That is what makes this safe to ship to a live product: an account
  //    that already exists — every current app user, and any web buyer who was
  //    already an app user — keeps `created_via` NULL and is never sent back
  //    through onboarding. Only rows this route actually creates are marked.
  await db.prepare(
    "INSERT INTO users (uid, created_at, updated_at, created_via) VALUES (?1,?2,?2,'web') ON CONFLICT(uid) DO NOTHING",
  ).bind(ctx.uid, now).run();

  // 2. Name — only when we have one and the row does not. COALESCE rather than
  //    an overwrite: the app's own profile editor is the authority on a name a
  //    user has actually chosen, and a web signup form must not clobber it.
  if (displayName) {
    await db.prepare(
      "UPDATE users SET display_name=COALESCE(NULLIF(display_name,''),?2), updated_at=?3 WHERE uid=?1",
    ).bind(ctx.uid, displayName, now).run();
  }

  // [WEB-HANDLE-1] A name is available right here (either just submitted, or
  // already on the row) — good enough to seed a handle now rather than wait
  // for the app's own profile save or a first listing publish (which also
  // hook ensureHandle; this call is idempotent so there is no double-write).
  // Never blocks signup: ensureHandle swallows every failure and returns null.
  try { await ensureHandle(env, ctx.uid, displayName ? { displayName } : undefined); } catch { /* ensureHandle never throws, but stay defensive */ }

  // 3. Phone — see the header for why both forms are stored.
  let phoneStored = false;
  if (e164) {
    const hash = await sha256Hex(e164);
    await db.prepare(
      "UPDATE users SET phone_hash=?2, private_number=?3, show_private_number=0, updated_at=?4 WHERE uid=?1",
    ).bind(ctx.uid, hash, e164, now).run();
    phoneStored = true;
  }

  // 4. Read back what this account now is, so the response and the telemetry
  //    describe reality rather than what we hoped we wrote. `created_via` tells
  //    us whether we created this row or found one — the single most useful
  //    fact when a signup later behaves unexpectedly.
  const state = await db.prepare(
    "SELECT created_via, app_onboarded_at, avatok_number FROM users WHERE uid=?1",
  ).bind(ctx.uid).first<any>().catch(() => null);
  const webBorn = state?.created_via === "web";
  const needsAppOnboarding = webBorn && state?.app_onboarded_at == null;

  try {
    void track(env, ctx.uid, "web_account_bootstrap", APP, {
      phone_stored: phoneStored,
      // [WEB-APP-ONBOARD-1] Was `number_outcome`, asserting that a number had
      // been minted. No number is minted here any more, so the value to assert
      // is that the account was created and is correctly owed the app gate.
      created_via: state?.created_via ?? "existing",
      needs_app_onboarding: needsAppOnboarding,
      has_number: !!state?.avatok_number,
      country,
      named: !!displayName,
    });
  } catch { /* telemetry must never fail a signup */ }

  return json({
    ok: true,
    uid: ctx.uid,
    phone_stored: phoneStored,
    // The web bundle reads none of these; they are here so a failing signup can
    // be diagnosed from a single response body.
    created_via: state?.created_via ?? null,
    needs_app_onboarding: needsAppOnboarding,
  });
}

/**
 * POST /api/account/app-onboarded
 *
 * Stamped once by the Flutter app when its onboarding flow completes, which is
 * what lifts `needs_app_onboarding` for a web-born account. Idempotent: the
 * COALESCE keeps the FIRST completion time, so a re-run (a reinstall, a second
 * device, a retry after a dropped response) never rewrites history.
 *
 * Deliberately its own tiny route rather than a field on `POST /api/profile`:
 * the profile save is a different gate with its own moderation path, and a user
 * can finish terms and permissions without ever saving a profile.
 */
export async function webAccountAppOnboarded(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const now = Date.now();
  await env.DB_META.prepare(
    "UPDATE users SET app_onboarded_at=COALESCE(app_onboarded_at,?2), updated_at=?3 WHERE uid=?1",
  ).bind(ctx.uid, now, now).run();

  const row = await env.DB_META.prepare(
    "SELECT created_via, app_onboarded_at FROM users WHERE uid=?1",
  ).bind(ctx.uid).first<any>().catch(() => null);

  try {
    void track(env, ctx.uid, "app_onboarding_completed", APP, {
      created_via: row?.created_via ?? null,
      // true on the first stamp, false on a repeat — tells a duplicate apart
      // from a genuine completion without needing to diff timestamps.
      first_time: row?.app_onboarded_at === now,
    });
  } catch { /* telemetry must never fail the gate */ }

  return json({ ok: true, app_onboarded_at: row?.app_onboarded_at ?? now });
}
