// Store-review login bypass (Google Play / App Store reviewers).
//
// Why this exists: the Clerk instance requires a SECOND FACTOR (email code) at
// every sign-in, so the normal login always sends an email OTP. App-store
// reviewers can't receive that inbox code. This route lets ONE allowlisted
// reviewer account sign in with just email + password and NO OTP:
//   1. We verify the password against the REVIEW_PASSWORD Worker secret.
//   2. We mint a Clerk **sign-in token** (a "ticket") via the Backend API.
//   3. The app completes a normal Clerk session with `strategy=ticket`.
// Clerk sign-in tokens bypass all auth factors, so the reviewer never needs the
// emailed code. Every other account is completely unaffected.
//
// Scoped hard: only the exact allowlisted email + the matching secret password
// works; disabled entirely if REVIEW_PASSWORD / CLERK_SECRET_KEY are unset.
import type { Env } from "../types";
import { json } from "../util";

// Allowlisted store-review accounts (NOT secret — the password is the gate).
const REVIEW_EMAILS = new Set<string>(["googleplay@avatok.ai"]);

const CLERK_API = "https://api.clerk.com/v1";

/** Constant-time string compare so the password check can't be timed. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// POST /api/review/login  { email, password }  ->  { ticket }
export async function reviewLogin(req: Request, env: Env): Promise<Response> {
  const expected = env.REVIEW_PASSWORD;
  if (!expected || !env.CLERK_SECRET_KEY) {
    return json({ error: "review login not available" }, 404);
  }

  const b = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
  const email = String(b.email || "").trim().toLowerCase();
  const password = String(b.password || "");
  if (!REVIEW_EMAILS.has(email) || password.length === 0 || !safeEqual(password, expected)) {
    return json({ error: "invalid credentials" }, 401);
  }

  // Resolve the Clerk user id for the allowlisted email.
  const lookup = await fetch(`${CLERK_API}/users?email_address=${encodeURIComponent(email)}`, {
    headers: { authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
  });
  if (!lookup.ok) return json({ error: "account lookup failed" }, 502);
  const users = (await lookup.json().catch(() => [])) as Array<{ id?: string }>;
  const uid = Array.isArray(users) ? users[0]?.id : undefined;
  if (!uid) return json({ error: "account not found" }, 404);

  // Mint a short-lived sign-in token (bypasses all auth factors).
  const mint = await fetch(`${CLERK_API}/sign_in_tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CLERK_SECRET_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ user_id: uid, expires_in_seconds: 600 }),
  });
  const mj = (await mint.json().catch(() => ({}))) as { token?: string };
  if (!mint.ok || !mj.token) return json({ error: "could not start review session" }, 502);

  return json({ ticket: mj.token });
}
