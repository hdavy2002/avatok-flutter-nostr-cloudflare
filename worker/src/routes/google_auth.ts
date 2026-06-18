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

const CLERK_API = "https://api.clerk.com/v1";

// Accepted audiences for the Google ID token = the WEB OAuth client(s) the app
// requests the token for (serverClientId). Must match Clerk's Google client id.
const ALLOWED_AUD = new Set<string>([
  "604131207750-atsjcb1f1annjp10qa6l9mtd8gj1e5ps.apps.googleusercontent.com",
]);

// POST /api/auth/google  { id_token }  ->  { ticket }
export async function googleAuth(req: Request, env: Env): Promise<Response> {
  if (!env.CLERK_SECRET_KEY) return json({ error: "auth not configured" }, 503);
  const b = (await req.json().catch(() => ({}))) as { id_token?: string };
  const idToken = String(b.id_token || "");
  if (!idToken) return json({ error: "id_token required" }, 400);

  // 1. Verify the Google ID token (Google checks signature + expiry for us).
  const ti = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!ti.ok) return json({ error: "invalid Google token" }, 401);
  const g = (await ti.json().catch(() => ({}))) as Record<string, unknown>;
  const iss = String(g.iss || "");
  if (iss !== "accounts.google.com" && iss !== "https://accounts.google.com") {
    return json({ error: "bad issuer" }, 401);
  }
  if (!ALLOWED_AUD.has(String(g.aud))) return json({ error: "bad audience" }, 401);
  const emailVerified = g.email_verified === true || g.email_verified === "true";
  const email = String(g.email || "").trim().toLowerCase();
  if (!email || !emailVerified) return json({ error: "email not verified" }, 401);

  const headers = { authorization: `Bearer ${env.CLERK_SECRET_KEY}` };

  // 2. Find the Clerk user by email; create one if this is a first-time sign-in.
  let uid: string | undefined;
  const look = await fetch(`${CLERK_API}/users?email_address=${encodeURIComponent(email)}`, { headers });
  if (look.ok) {
    const users = (await look.json().catch(() => [])) as Array<{ id?: string }>;
    uid = Array.isArray(users) ? users[0]?.id : undefined;
  }
  if (!uid) {
    const create = await fetch(`${CLERK_API}/users`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        email_address: [email],
        skip_password_checks: true,
        skip_password_requirement: true,
        first_name: (g.given_name as string) || undefined,
        last_name: (g.family_name as string) || undefined,
      }),
    });
    if (!create.ok) {
      const detail = (await create.text().catch(() => "")).slice(0, 200);
      return json({ error: "could not create account", detail }, 502);
    }
    uid = ((await create.json().catch(() => ({}))) as { id?: string }).id;
  }
  if (!uid) return json({ error: "no user" }, 502);

  // 3. Mint a short-lived Clerk sign-in token (ticket) for the app to redeem.
  const mint = await fetch(`${CLERK_API}/sign_in_tokens`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ user_id: uid, expires_in_seconds: 600 }),
  });
  const mj = (await mint.json().catch(() => ({}))) as { token?: string };
  if (!mint.ok || !mj.token) return json({ error: "could not start session" }, 502);
  return json({ ticket: mj.token });
}
