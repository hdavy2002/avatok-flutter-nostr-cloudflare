import type { Env } from "../types";

const CLERK_API = "https://api.clerk.com/v1";
type ClerkEmail = { id: string; email_address: string; verification?: { status?: string } };
type ClerkUser = { id: string; primary_email_address_id?: string | null; email_addresses: ClerkEmail[] };
type LinkResult = { ok: true } | { ok: false; error: "email_taken" | "email_link_unavailable"; status: 409 | 503 };

/** Call only after this authenticated account has proved the email OTP.
 * Never merges users or moves an identifier. Clerk owns global uniqueness.
 * A read-back from the same user is required even after a successful write.
 */
export async function attachVerifiedClerkEmail(env: Env, clerkUserId: string, email: string): Promise<LinkResult> {
  const unavailable: LinkResult = { ok: false, error: "email_link_unavailable", status: 503 };
  if (!env.CLERK_SECRET_KEY) return unavailable;
  const request = (path: string, init: RequestInit = {}) => fetch(`${CLERK_API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${env.CLERK_SECRET_KEY}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  const readUser = async (): Promise<ClerkUser | null> => {
    const response = await request(`/users/${encodeURIComponent(clerkUserId)}`);
    if (!response.ok) return null;
    const user = await response.json() as ClerkUser;
    return user?.id === clerkUserId && Array.isArray(user.email_addresses) ? user : null;
  };
  const matching = (user: ClerkUser | null) => user?.email_addresses.find((address) =>
    typeof address.email_address === "string" && address.email_address.toLowerCase() === email);
  try {
    const user = await readUser();
    if (!user) return unavailable;
    const existing = matching(user);
    if (existing?.verification?.status === "verified") return { ok: true };
    // Existing primary identifiers stay primary. First email becomes primary.
    const primary = !user.primary_email_address_id;
    const response = existing
      ? await request(`/email_addresses/${encodeURIComponent(existing.id)}`, {
        method: "PATCH", body: JSON.stringify({ verified: true, ...(primary ? { primary: true } : {}) }),
      })
      : await request("/email_addresses", {
        method: "POST", body: JSON.stringify({ user_id: clerkUserId, email_address: email, verified: true, primary }),
      });
    const result = await response.json().catch(() => null) as { errors?: { code?: string }[] } | null;
    // Reconcile a same-user race (or an earlier timed-out create) without ever
    // accepting another user's email resource as ours.
    if (matching(await readUser())?.verification?.status === "verified") return { ok: true };
    const collision = response.status === 409 || result?.errors?.some((e) => e.code === "form_identifier_exists");
    return collision ? { ok: false, error: "email_taken", status: 409 } : unavailable;
  } catch {
    // Keep the proved OTP available for a bounded retry; no local success flag.
    return unavailable;
  }
}
