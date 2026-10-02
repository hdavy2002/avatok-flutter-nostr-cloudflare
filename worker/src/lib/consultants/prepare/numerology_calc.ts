// [AUMFE-CONSULT-W2-1 2026-10-02] Our own numerology arithmetic (pure). Chaldean letter values for names, digit-sum
// reduction for dates and mobile numbers, and the Lo Shu grid. Compound numbers (e.g. 23) are kept next to the root (5).

/** Chaldean values: A1 B2 C3 D4 E5 F8 G3 H5 I1 J1 K2 L3 M4 N5 O7 P8 Q1 R2 S3 T4 U6 V6 W6 X5 Y1 Z7 (9 is never assigned to a letter). */
const CHALDEAN: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 8, G: 3, H: 5, I: 1, J: 1, K: 2, L: 3, M: 4,
  N: 5, O: 7, P: 8, Q: 1, R: 2, S: 3, T: 4, U: 6, V: 6, W: 6, X: 5, Y: 1, Z: 7,
};

export interface NumberTotal { total: number; root: number }

/** Sum of digits repeatedly until one digit (1-9); 0 stays 0. */
export function reduceDigit(n: number): number {
  let x = Math.abs(Math.trunc(n));
  while (x > 9) x = String(x).split("").reduce((a, d) => a + Number(d), 0);
  return x;
}
const totalOf = (sum: number): NumberTotal => ({ total: sum, root: reduceDigit(sum) });

/** Chaldean total of a name. Only A-Z are counted (case-insensitive); spaces and punctuation are ignored. */
export function chaldeanTotal(name: string): NumberTotal {
  let sum = 0;
  for (const ch of String(name ?? "").toUpperCase()) sum += CHALDEAN[ch] ?? 0;
  return totalOf(sum);
}
export interface NameTotal extends NumberTotal { name: string; letters: number }
export function nameTotals(name: string): NameTotal {
  const letters = (String(name ?? "").toUpperCase().match(/[A-Z]/g) ?? []).length;
  return { name: String(name ?? "").trim(), letters, ...chaldeanTotal(name) };
}

/** Digit-sum of every digit in a mobile number (country code and punctuation stripped to digits; a leading 91 on 12 digits, or 0 on 11, is dropped). */
export function mobileDigits(mobile: string): string {
  let d = String(mobile ?? "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return d;
}
export function mobileTotal(mobile: string): (NumberTotal & { digits: string }) | null {
  const digits = mobileDigits(mobile);
  if (digits.length < 7) return null;
  return { digits, ...totalOf(digits.split("").reduce((a, d) => a + Number(d), 0)) };
}

/** YYYY-MM-DD -> { day, month, year } or null. */
export function parseIsoDate(s: string): { day: number; month: number; year: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ""));
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? { day, month, year } : null;
}

/** Vedic numerology numbers from a date of birth. radical (moolank) = birth day, destiny (bhagyank) = whole date. */
export function dobNumbers(dob: string): { radical: NumberTotal; destiny: NumberTotal } | null {
  const p = parseIsoDate(dob);
  if (!p) return null;
  const all = `${String(p.day).padStart(2, "0")}${String(p.month).padStart(2, "0")}${p.year}`.split("").reduce((a, d) => a + Number(d), 0);
  return { radical: totalOf(p.day), destiny: totalOf(all) };
}

/** Lo Shu grid layout (rows top to bottom): 4 9 2 / 3 5 7 / 8 1 6. Counts digits 1-9 of DDMMYYYY (zeros ignored). */
export const LO_SHU_LAYOUT: number[][] = [[4, 9, 2], [3, 5, 7], [8, 1, 6]];
export function loShu(dob: string): { counts: Record<string, number>; grid: string[][]; missing: number[]; present: number[] } | null {
  const p = parseIsoDate(dob);
  if (!p) return null;
  const digits = `${String(p.day).padStart(2, "0")}${String(p.month).padStart(2, "0")}${p.year}`.split("").map(Number).filter((d) => d > 0);
  const counts: Record<string, number> = {};
  for (let i = 1; i <= 9; i++) counts[String(i)] = digits.filter((d) => d === i).length;
  const grid = LO_SHU_LAYOUT.map((row) => row.map((n) => (counts[String(n)] ? String(n).repeat(counts[String(n)]) : "")));
  const present = Object.keys(counts).map(Number).filter((n) => counts[String(n)] > 0);
  const missingN = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((n) => !counts[String(n)]);
  return { counts, grid, missing: missingN, present };
}

/** Latin letters only (the API computes a name number from letters). Returns null when the name has non-Latin letters or too few letters. */
export function cleanLatinName(v: unknown): string | null {
  const raw = String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (/[^\x00-\x7F]/.test(raw) && /\p{L}/u.test(raw.replace(/[\x00-\x7F]/g, ""))) return null;
  const t = raw.replace(/[^A-Za-z .'-]/g, "").replace(/\s+/g, " ").trim();
  return /[A-Za-z]{2}/.test(t) ? t : null;
}
