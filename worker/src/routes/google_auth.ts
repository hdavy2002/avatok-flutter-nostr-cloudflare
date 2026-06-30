// Native Google sign-in → Clerk session, via a SERVER-minted sign-in ticket.
//
// The app does native google_sign_in to get a Google ID token, POSTs it here; we
// verify the token with Google, find-or-create the Clerk user, and mint a Clerk
// "sign-in token" (ticket) the app redeems with strategy=ticket. Reliable and
// fully server-controlled — avoids Clerk's native google_one_tap (which fails
// with "no account to transfer" for native clients). Same mechanism the old
// store-review login used successfully.
import type { Env } from "../types";
import { json } from "../util";
import { trackUser } from "../hooks";

const CLERK_API = "https://api.clerk.com/v1";

// Accepted audiences for the Google ID token = the WEB OAuth client(s) the app
// requests the token for (serverClientId). Must match Clerk's Google client id.
const ALLOWED_AUD = new Set<string>([
  // NEW (2026-06-30): serverClientId moved to the healthy avatok-e19ef project
  // (#1098288797441) after the old `avatok` project (#604131207750) was deleted
  // and its restored OAuth clients stopped minting tokens (Android 12500).
  "1098288797441-rkj7rbifn7uipi639dmhsnf7tpgq1kno.apps.googleusercontent.com",
  // OLD — kept during rollout so older builds still work if the old project recovers.
  "604131207750-atsjcb1f1annjp10qa6l9mtd8gj1e5ps.apps.googleusercontent.com",
]);

// POST /api/auth/google  { id_token }  ->  { ticket }
export async function googleAuth(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Server-side signup telemetry. The Google→Clerk exchange is where signups
  // silently die ("could not create account") with the real Clerk reason in
  // `detail` — until now that detail never left this function. Every branch
  // emits a `signup_server` event so support can see, per email, exactly which
  // step failed and why. `uid` is filled in once known so events join the
  // eventual person; before that they ride on the email. Best-effort.
  const t0 = Date.now();
  let uid: string | undefined;
  const sx = (step: string, email: string | null, props: Record<string, unknown> = {}) =>
    // waitUntil keeps the isolate alive until the queue send completes, so these
    // signup_server events actually reach PostHog instead of being cancelled.
    ctx.waitUntil(
      trackUser(env, uid ?? "anon_signup", email, "signup_server", "avatok", {
        provider: "google",
        step,
        ms: Date.now() - t0,
        ...props,
      }),
    );

  if (!env.CLERK_SECRET_KEY) {
    sx("config_missing", null, { ok: false });
    return json({ error: "auth not configured" }, 503);
  }
  const b = (await req.json().catch(() => ({}))) as { id_token?: string };
  const idToken = String(b.id_token || "");
  if (!idToken) {
    sx("no_id_token", null, { ok: false });
    return json({ error: "id_token required" }, 400);
  }

  // 1. Verify the Google ID token (Google checks signature + expiry for us).
  const ti = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!ti.ok) {
    sx("google_verify_failed", null, { ok: false, http_status: ti.status });
    return json({ error: "invalid Google token" }, 401);
  }
  const g = (await ti.json().catch(() => ({}))) as Record<string, unknown>;
  const iss = String(g.iss || "");
  if (iss !== "accounts.google.com" && iss !== "https://accounts.google.com") {
    sx("bad_issuer", null, { ok: false, iss });
    return json({ error: "bad issuer" }, 401);
  }
  if (!ALLOWED_AUD.has(String(g.aud))) {
    sx("bad_audience", null, { ok: false, aud: String(g.aud) });
    return json({ error: "bad audience" }, 401);
  }
  const emailVerified = g.email_verified === true || g.email_verified === "true";
  const email = String(g.email || "").trim().toLowerCase();
  if (!email || !emailVerified) {
    sx("email_not_verified", email || null, { ok: false, email_verified: emailVerified });
    return json({ error: "email not verified" }, 401);
  }

  const headers = { authorization: `Bearer ${env.CLERK_SECRET_KEY}` };

  // 2. Find the Clerk user by email; create one if this is a first-time sign-in.
  const look = await fetch(`${CLERK_API}/users?email_address=${encodeURIComponent(email)}`, { headers });
  if (look.ok) {
    const users = (await look.json().catch(() => [])) as Array<{ id?: string }>;
    uid = Array.isArray(users) ? users[0]?.id : undefined;
  } else {
    sx("clerk_lookup_failed", email, { ok: false, http_status: look.status });
  }
  if (!uid) {
    // The Clerk instance requires username + first/last on user creation
    // (2026-06-23 config). Google returns email + (usually) given/family name;
    // derive a unique username from the email local-part with a random suffix so
    // a first-time Google sign-up satisfies the instance's required fields.
    const local = (email.split("@")[0] || "ava").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 26) || "ava";
    const username = `${local}_${Math.random().toString(36).slice(2, 8)}`.slice(0, 40);
    const firstName = (g.given_name as string) || local;
    const lastName = (g.family_name as string) || "Ava";
    const create = await fetch(`${CLERK_API}/users`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        email_address: [email],
        username,
        first_name: firstName,
        last_name: lastName,
        skip_password_checks: true,
        skip_password_requirement: true,
      }),
    });
    if (!create.ok) {
      // THE blind spot: Clerk rejected user creation. `detail` is Clerk's own
      // reason (e.g. "form_identifier_exists", a plan/restriction error) — now
      // captured server-side instead of only echoed to the client as a vague
      // "could not create account".
      const detail = (await create.text().catch(() => "")).slice(0, 200);
      sx("clerk_create_failed", email, { ok: false, http_status: create.status, detail, new_user: true });
      return json({ error: "could not create account", detail }, 502);
    }
    uid = ((await create.json().catch(() => ({}))) as { id?: string }).id;
    sx("clerk_user_created", email, { ok: true, new_user: true });
  } else {
    sx("clerk_user_found", email, { ok: true, new_user: false });
  }
  if (!uid) {
    sx("no_uid", email, { ok: false });
    return json({ error: "no user" }, 502);
  }

  // 3. Mint a short-lived Clerk sign-in token (ticket) for the app to redeem.
  const mint = await fetch(`${CLERK_API}/sign_in_tokens`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ user_id: uid, expires_in_seconds: 600 }),
  });
  const mj = (await mint.json().catch(() => ({}))) as { token?: string };
  if (!mint.ok || !mj.token) {
    sx("ticket_mint_failed", email, { ok: false, http_status: mint.status });
    return json({ error: "could not start session" }, 502);
  }
  sx("ticket_minted", email, { ok: true });
  return json({ ticket: mj.token });
}
