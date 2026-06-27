// AvaTOK virtual-number numbering plans (Specs/AVATOK-NUMBER-FEATURE-SPEC.md §3).
//
// IMPORTANT: AvaTOK numbers are PURELY INTERNAL, app-to-app identifiers. They are
// NEVER routed over the PSTN — there is no dial-out, no inbound from carriers, no
// SMS to/from the telephone network. A call/message to an AvaTOK number is an
// in-app AvaTOK↔AvaTOK action only. Because nothing ever leaves the app onto the
// real network, these identifiers cannot "collide" with a real subscriber in any
// operational sense (we never place a call to the number on the PSTN).
//
// Numbers still FOLLOW each country's national format (dial code + correct
// national-significant-number length) so they read like a familiar local number.
// To avoid the old monotony (every US number starting "30…") and to keep the pool
// varied across regions/carriers, each country draws its leading block from a SET
// of format-valid leads (`leadPool`) rather than one fixed prefix. This is generic
// across every supported country — not US-specific.
//
// `canonical` = E.164 digits with NO '+', e.g. '233241234567'.

export interface CountryPlan {
  iso2: string;       // ISO-3166 alpha-2
  name: string;
  dial: string;       // country calling code digits, no '+'
  nsnLen: number;     // national significant number length (digits after dial)
  leadPool: string[]; // format-valid leading blocks (mobile prefixes / area codes)
  groups: number[];   // display grouping of the NSN digits
  flag: string;       // emoji flag for the picker
}

// Launch set. `leadPool` per country = a spread of real, format-valid leading
// blocks so generated numbers vary across the country (different regions/carriers)
// instead of all sharing one prefix. All entries for a given country share the
// same length so the NSN always totals `nsnLen`.
export const COUNTRIES: CountryPlan[] = [
  { iso2: "GH", name: "Ghana",         dial: "233", nsnLen: 9,  groups: [2, 3, 4],
    leadPool: ["24", "54", "55", "59", "20", "50", "26", "27", "57"], flag: "🇬🇭" },
  { iso2: "NG", name: "Nigeria",       dial: "234", nsnLen: 10, groups: [3, 3, 4],
    leadPool: ["70", "80", "81", "90", "91", "71"], flag: "🇳🇬" },
  { iso2: "KE", name: "Kenya",         dial: "254", nsnLen: 9,  groups: [3, 3, 3],
    leadPool: ["71", "72", "74", "79", "70", "11", "10"], flag: "🇰🇪" },
  { iso2: "ZA", name: "South Africa",  dial: "27",  nsnLen: 9,  groups: [2, 3, 4],
    leadPool: ["60", "61", "62", "63", "71", "72", "73", "74", "76", "81", "82", "83", "84"], flag: "🇿🇦" },
  { iso2: "US", name: "United States", dial: "1",   nsnLen: 10, groups: [3, 3, 4],
    // Spread across many real US area codes so numbers vary by region (not all 30X).
    leadPool: ["201", "202", "212", "213", "305", "312", "404", "415", "469", "512",
               "602", "617", "646", "702", "713", "718", "773", "786", "917", "972"], flag: "🇺🇸" },
  { iso2: "GB", name: "United Kingdom",dial: "44",  nsnLen: 10, groups: [4, 3, 3],
    leadPool: ["74", "75", "76", "77", "78", "79"], flag: "🇬🇧" },
  { iso2: "IN", name: "India",         dial: "91",  nsnLen: 10, groups: [5, 5],
    leadPool: ["63", "70", "73", "80", "81", "90", "91", "98", "99", "62"], flag: "🇮🇳" },
];

export function planFor(iso2: string): CountryPlan | undefined {
  return COUNTRIES.find((c) => c.iso2 === (iso2 || "").toUpperCase());
}

/** E.164 digits (no '+') for a national-significant number under a plan. */
export function canonical(plan: CountryPlan, nsn: string): string {
  return plan.dial + nsn;
}

/** Pretty display, e.g. '+233 24 555 0148'. */
export function display(plan: CountryPlan, nsn: string): string {
  let i = 0;
  const parts: string[] = [];
  for (const g of plan.groups) { parts.push(nsn.slice(i, i + g)); i += g; }
  if (i < nsn.length) parts.push(nsn.slice(i));
  return `+${plan.dial} ${parts.join(" ")}`.trim();
}

/** A representative example NSN for the picker hint (first lead + zero-padded). */
export function exampleNsn(plan: CountryPlan): string {
  const lead = plan.leadPool[0] ?? "";
  return (lead + "0".repeat(Math.max(0, plan.nsnLen - lead.length))).slice(0, plan.nsnLen);
}

/**
 * Validate a MINTED AvaTOK NSN against the plan: right length, all digits, and a
 * leading block drawn from the reserved AvaTOK pool for that country.
 */
export function validNsn(plan: CountryPlan, nsn: string): boolean {
  if (!/^[0-9]+$/.test(nsn) || nsn.length !== plan.nsnLen) return false;
  return plan.leadPool.some((lead) => nsn.startsWith(lead));
}

/**
 * Validate a BRING-YOUR-OWN number's NSN: format-level country validity only
 * (right length, all digits, leading digit not 0 — true for every supported
 * national plan). Used by the "use my own number" path, where the user supplies a
 * number we don't mint, so it need not come from the AvaTOK lead pool.
 */
export function validOwnNsn(plan: CountryPlan, nsn: string): boolean {
  return /^[1-9][0-9]*$/.test(nsn) && nsn.length === plan.nsnLen;
}

function randDigits(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
  return s;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generate up to `count` candidate NSNs conforming to the plan, varied across the
 * country's lead pool. If `pattern` (digits only) is given, every candidate
 * contains it within the line portion. Caller filters out taken numbers before
 * offering them.
 */
export function generate(plan: CountryPlan, count: number, pattern?: string): string[] {
  const pat = (pattern || "").replace(/[^0-9]/g, "");
  const out = new Set<string>();
  let guard = 0;
  const maxGuard = count * 60;
  while (out.size < count && guard < maxGuard) {
    guard++;
    const lead = pick(plan.leadPool);
    const tail = plan.nsnLen - lead.length;
    if (tail <= 0) continue;
    let nsn: string;
    if (pat && pat.length <= tail) {
      const maxOff = tail - pat.length;
      const off = Math.floor(Math.random() * (maxOff + 1));
      nsn = lead + randDigits(off) + pat + randDigits(tail - pat.length - off);
    } else if (pat) {
      break; // pattern longer than any line portion → no conforming candidate
    } else {
      nsn = lead + randDigits(tail);
    }
    if (validNsn(plan, nsn)) out.add(nsn);
  }
  return [...out];
}
