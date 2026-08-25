import { COUNTRIES, planFor, validOwnNsn } from "./numbering";

export interface NormalizedDestination {
  canonical: string;
  display: string;
  countryIso2: string;
}

/** Normalize common pasted/national/international input without exposing a
 * directory search. Region is an ISO-3166 alpha-2 hint for national input. */
export function normalizeDestination(raw: string, region = "IN"): NormalizedDestination | null {
  const input = String(raw ?? "").trim();
  if (!input) return null;
  const compact = input.replace(/[\s().-]/g, "");
  let digits = compact.replace(/^00/, "").replace(/^\+/, "");
  if (!/^\d+$/.test(digits)) return null;

  let plan = COUNTRIES.find((candidate) => digits.startsWith(candidate.dial) && digits.length === candidate.dial.length + candidate.nsnLen);
  if (!plan) {
    plan = planFor(region);
    if (!plan) return null;
    if (digits.startsWith("0")) digits = digits.slice(1);
    if (!validOwnNsn(plan, digits)) return null;
    digits = plan.dial + digits;
  }
  const nsn = digits.slice(plan.dial.length);
  if (!validOwnNsn(plan, nsn)) return null;
  const groups = plan.groups;
  let offset = 0;
  const parts: string[] = [];
  for (const size of groups) { parts.push(nsn.slice(offset, offset + size)); offset += size; }
  if (offset < nsn.length) parts.push(nsn.slice(offset));
  return { canonical: digits, display: `+${plan.dial} ${parts.join(" ")}`, countryIso2: plan.iso2 };
}
