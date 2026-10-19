// [HF-WIRE-17] WhatsApp-only accounts get an internal placeholder address in Clerk because the Clerk
// instance keeps "Require email address" on (username sign-in without passwords is not a usable
// identifier). The address lives on a subdomain with no mailbox, is unique per account (external_id),
// and must NEVER be treated as a real email: every reader below filters it out, so receipts, /me and
// account relinking only ever see a real address (the one the fan typed is kept in hf_user_email).
import { BRAND } from "./brand";

const PLACEHOLDER_HOST = `noemail.${BRAND.domain}`;

export function placeholderEmailFor(extId: string): string {
  return `wa-${extId.toLowerCase().replace(/[^a-z0-9_-]/g, "")}@${PLACEHOLDER_HOST}`;
}

export function isPlaceholderEmail(email: unknown): boolean {
  return typeof email === "string" && email.toLowerCase().endsWith(`@${PLACEHOLDER_HOST}`);
}

/** null when the address is missing or a placeholder. */
export function realEmailOrNull(email: unknown): string | null {
  return typeof email === "string" && email && !isPlaceholderEmail(email) ? email : null;
}
