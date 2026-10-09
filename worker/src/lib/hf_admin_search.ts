// [HF-ADMIN-CREDIT-1] Pure helpers for the admin "find a caller" search: what kind of thing did the admin type?
// No I/O here so it is unit-testable. The D1 lookups live in hf_admin_users.ts.
import { normalizeE164 } from "./phone_e164";

export type AdminQueryType = "empty" | "uid" | "phone" | "email" | "name";
export interface AdminQuery {
  type: AdminQueryType;
  /** Trimmed input (lowercased for email). */
  text: string;
  /** phone: normalised E.164 with "+" (the string whose sha256 is stored as phone_hash). */
  e164?: string;
  /** phone: trailing digits used for the suffix match (last 10, or all digits when fewer). */
  suffix?: string;
}

const MAX_Q = 80;
const PHONE_CHARS = /^[+()\d\s.-]+$/;

/** Decides whether the box holds a uid, a phone number, an email or a name. */
export function classifyAdminQuery(raw: unknown): AdminQuery {
  const text = String(raw ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_Q);
  if (!text) return { type: "empty", text: "" };
  if (text.includes("@") && !text.includes(" ")) return { type: "email", text: text.toLowerCase() };
  if (PHONE_CHARS.test(text)) {
    const digits = text.replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15) {
      const e164 = normalizeE164(text);
      if (e164) {
        const d = e164.slice(1);
        return { type: "phone", text, e164, suffix: d.length >= 10 ? d.slice(-10) : d };
      }
    }
  }
  if (!text.includes(" ") && (/^user_[A-Za-z0-9]{6,}$/.test(text) || (/^[A-Za-z0-9_-]{20,64}$/.test(text) && /[\d_]/.test(text)))) {
    return { type: "uid", text };
  }
  return { type: "name", text };
}

/** Names need at least 2 characters before we scan the table. */
export const NAME_MIN = 2;
export const searchable = (q: AdminQuery): boolean => q.type !== "empty" && (q.type !== "name" || q.text.length >= NAME_MIN);

/** Escapes LIKE wildcards (use with ESCAPE '\\'). */
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (ch) => "\\" + ch);
