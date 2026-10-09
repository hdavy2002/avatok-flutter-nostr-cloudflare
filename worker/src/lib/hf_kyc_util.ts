// [HF-HOST-KYC-1 2026-10-09] Pure helpers for Hello Fraands host KYC (no I/O — unit-testable).

// ── Aadhaar number checksum (Verhoeff) — rejects typos before we pay Sandbox ~₹1 for a doomed OTP ──
const D = [
  [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],
  [5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0],
];
const P = [
  [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],
  [9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8],
];
/** 12 digits, first digit 2-9, valid Verhoeff checksum. */
export function validAadhaar(n: string): boolean {
  if (!/^[2-9]\d{11}$/.test(n)) return false;
  let c = 0;
  const rev = n.split("").reverse();
  for (let i = 0; i < rev.length; i++) c = D[c][P[i % 8][Number(rev[i])]];
  return c === 0;
}

/** Accepts "1234 5678 9012" / "1234-5678-9012"; returns 12 digits or null. */
export function cleanAadhaar(raw: unknown): string | null {
  const s = String(raw ?? "").replace(/[\s-]/g, "");
  return validAadhaar(s) ? s : null;
}

// ── Gender / age ─────────────────────────────────────────────────────────────
/** Vendor gender -> 'F' | 'M' | 'T' (anything non-binary maps to T); null when unreadable. */
export function mapGender(v: string): "F" | "M" | "T" | null {
  const g = String(v ?? "").trim().toUpperCase();
  if (g === "F" || g === "FEMALE") return "F";
  if (g === "M" || g === "MALE") return "M";
  if (g === "T" || g === "O" || g === "TG" || g === "TRANSGENDER" || g === "OTHER") return "T";
  return null;
}

/**
 * Is the person 18+ today? Returns true/false, or null when it cannot be proven (year-only DOB in the
 * boundary year). Year-only DOB: >= 19 years by year arithmetic is a safe yes, <= 17 a safe no.
 */
export function isAdult(dobIso: string | null, yearOfBirth: number | null, now = new Date()): boolean | null {
  if (dobIso && /^\d{4}-\d{2}-\d{2}$/.test(dobIso)) {
    const [y, m, d] = dobIso.split("-").map(Number);
    let age = now.getUTCFullYear() - y;
    const bm = now.getUTCMonth() + 1 - m;
    if (bm < 0 || (bm === 0 && now.getUTCDate() < d)) age--;
    return age >= 18;
  }
  if (yearOfBirth) {
    const diff = now.getUTCFullYear() - yearOfBirth;
    if (diff >= 19) return true;
    if (diff <= 17) return false;
  }
  return null;
}

// ── Name matching (Aadhaar name vs bank name) ────────────────────────────────
const HONORIFICS = new Set(["MR", "MRS", "MS", "MISS", "SHRI", "SHRIMATI", "SMT", "SRI", "SHREE", "KUMARI", "KU", "DR", "LATE", "SRIMATI", "MASTER"]);
export function nameTokens(s: string): string[] {
  return String(s ?? "")
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !HONORIFICS.has(t));
}
/**
 * Token-overlap score in [0,1] = matched / max(|a|,|b|). A single-letter token (initial) matches any token
 * starting with that letter. Order-insensitive. "RAHUL KUMAR SHARMA" vs "Rahul Sharma": 2/3 = 0.67.
 */
export function nameScore(a: string, b: string): number {
  const ta = nameTokens(a), tb = nameTokens(b);
  if (!ta.length || !tb.length) return 0;
  const pool = [...tb];
  let matched = 0;
  for (const t of ta) {
    let idx = pool.indexOf(t);
    if (idx < 0) idx = pool.findIndex((u) => (t.length === 1 && u.startsWith(t)) || (u.length === 1 && t.startsWith(u)));
    if (idx >= 0) { matched++; pool.splice(idx, 1); }
  }
  return matched / Math.max(ta.length, tb.length);
}
/** HF-KYC-4: bank name must match the Aadhaar name. Pass at >= 0.6. */
export function namesMatch(aadhaarName: string, bankName: string): boolean {
  return nameScore(aadhaarName, bankName) >= 0.6;
}

// ── Payout field formats ─────────────────────────────────────────────────────
export const UPI_RE = /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9]{1,31}$/;
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const ACCOUNT_RE = /^\d{9,18}$/;

export function firstNameOf(full: string): string {
  const t = nameTokens(full)[0] ?? "";
  return t ? t.charAt(0) + t.slice(1).toLowerCase() : "";
}
