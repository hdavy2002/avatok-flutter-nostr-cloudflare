// [JOIN-LINK-1] Server-minted Clerk sign-in tickets — ONE implementation.
//
// This was already being done inline in routes/google_auth.ts ("mint a Clerk
// sign-in token (ticket) for the app to redeem with strategy=ticket"); the
// emailed join link needs exactly the same thing for the browser, so the call
// moved here rather than being written a second time.
//
// WHY A TICKET AND NOT A JWT. The Worker cannot mint a session token this
// codebase would accept: `requireUser` (authz.ts) → `verifyClerk` (auth.ts)
// verifies an RS256 JWT against Clerk's JWKS, and the Worker holds no Clerk
// signing key. A sign-in token IS Clerk's own supported answer to "the server
// knows who this is, give the client a session": the client redeems it with
// `signIn.create({ strategy: 'ticket', ticket })` + `setActive`, and what comes
// out the other end is the very same Clerk session the email-code gate
// (islands/auth/passwordless.ts) would have produced — same account, same
// claims, same `getToken()`. Short-lived by construction: the ticket dies in
// minutes and is consumed on redemption, so an emailed link that is forwarded
// later still has to pass the entitlement check, not a stale credential.
import type { Env } from "../types";

const CLERK_API = "https://api.clerk.com/v1";

export type TicketMint =
  | { ok: true; ticket: string }
  | { ok: false; reason: "unconfigured" | "mint_failed"; status: number };

export async function mintClerkSignInTicket(
  env: Env, userId: string, expiresInSeconds = 600,
): Promise<TicketMint> {
  if (!env.CLERK_SECRET_KEY) return { ok: false, reason: "unconfigured", status: 503 };
  const res = await fetch(`${CLERK_API}/sign_in_tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CLERK_SECRET_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ user_id: userId, expires_in_seconds: expiresInSeconds }),
  });
  const body = (await res.json().catch(() => ({}))) as { token?: string };
  if (!res.ok || !body.token) return { ok: false, reason: "mint_failed", status: res.status };
  return { ok: true, ticket: body.token };
}

/** `da***@gmail.com` — enough for "you're joining as…", never the whole address. */
export function maskEmail(email: string | null | undefined): string | null {
  const raw = (email ?? "").trim();
  const at = raw.indexOf("@");
  if (at <= 0) return null;
  const local = raw.slice(0, at);
  const domain = raw.slice(at);
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}${"*".repeat(Math.max(1, local.length - head.length))}${domain}`;
}
