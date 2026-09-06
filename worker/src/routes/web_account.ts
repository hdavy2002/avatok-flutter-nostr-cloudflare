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
// materialise the `users` row, store the phone, and mint an AvaTOK number
// without asking the buyer to choose one ("this will be auto assigned to save
// sign up time").
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
import { autoAssignNumber } from "./number";
import { track } from "../hooks";

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
  }

  const now = Date.now();
  const db = env.DB_META;

  // 1. The row itself. ON CONFLICT DO NOTHING so a returning user keeps
  //    everything they already have.
  await db.prepare(
    "INSERT INTO users (uid, created_at, updated_at) VALUES (?1,?2,?2) ON CONFLICT(uid) DO NOTHING",
  ).bind(ctx.uid, now).run();

  // 2. Name — only when we have one and the row does not. COALESCE rather than
  //    an overwrite: the app's own profile editor is the authority on a name a
  //    user has actually chosen, and a web signup form must not clobber it.
  if (displayName) {
    await db.prepare(
      "UPDATE users SET display_name=COALESCE(NULLIF(display_name,''),?2), updated_at=?3 WHERE uid=?1",
    ).bind(ctx.uid, displayName, now).run();
  }

  // 3. Phone — see the header for why both forms are stored.
  let phoneStored = false;
  if (e164) {
    const hash = await sha256Hex(e164);
    await db.prepare(
      "UPDATE users SET phone_hash=?2, private_number=?3, show_private_number=0, updated_at=?4 WHERE uid=?1",
    ).bind(ctx.uid, hash, e164, now).run();
    phoneStored = true;
  }

  // 4. The AvaTOK number. Never fatal — an account with no number can pick one
  //    in the app; an account that failed to be created cannot be recovered at
  //    all, so a pool problem must not take the signup down with it.
  let assigned: { number: string; display: string; already: boolean } | null = null;
  try {
    assigned = await autoAssignNumber(env, ctx.uid, country);
  } catch { assigned = null; }

  try {
    void track(env, ctx.uid, "web_account_bootstrap", APP, {
      phone_stored: phoneStored,
      // The value to assert. `null` means the pool found nothing, which is the
      // one outcome that needs a human — the account is fine but the buyer has
      // no identity to be messaged on.
      number_outcome: assigned ? (assigned.already ? "existing" : "assigned") : "none",
      country,
      named: !!displayName,
    });
  } catch { /* telemetry must never fail a signup */ }

  return json({
    ok: true,
    uid: ctx.uid,
    phone_stored: phoneStored,
    avatok_number: assigned?.number ?? null,
    avatok_number_display: assigned?.display ?? null,
  });
}
