// AvaTOK virtual-number numbering plans (Specs/AVATOK-NUMBER-FEATURE-SPEC.md §3).
//
// Numbers FOLLOW each country's national phone-numbering standard (dial code +
// correct national-significant-number length) so they read like a normal local
// number — but they are PURE-VIRTUAL and NON-PSTN (no dial-out, no SMS, never
// routed to the telephone network). Each country reserves an AvaTOK prefix block
// inside the national number so allocations conform to the format while keeping
// AvaTOK's pool self-contained and minimizing overlap with live carrier ranges.
//
// `canonical` = E.164 digits with NO '+', e.g. '233241234567'.

export interface CountryPlan {
  iso2: string;      // ISO-3166 alpha-2
  name: string;
  dial: string;      // country calling code digits, no '+'
  nsnLen: number;    // national significant number length (digits after dial)
  avaPrefix: string; // AvaTOK-reserved leading block of the NSN (valid-format)
  groups: number[];  // display grouping of the NSN digits
  flag: string;      // emoji flag for the picker
}

// Launch set. Add countries here as we open them; the reserved avaPrefix should be
// a format-valid mobile lead that we hold for AvaTOK allocations in that country.
export const COUNTRIES: CountryPlan[] = [
  { iso2: "GH", name: "Ghana",         dial: "233", nsnLen: 9,  avaPrefix: "24", groups: [2, 3, 4], flag: "🇬🇭" },
  { iso2: "NG", name: "Nigeria",       dial: "234", nsnLen: 10, avaPrefix: "70", groups: [3, 3, 4], flag: "🇳🇬" },
  { iso2: "KE", name: "Kenya",         dial: "254", nsnLen: 9,  avaPrefix: "71", groups: [3, 3, 3], flag: "🇰🇪" },
  { iso2: "ZA", name: "South Africa",  dial: "27",  nsnLen: 9,  avaPrefix: "60", groups: [2, 3, 4], flag: "🇿🇦" },
  { iso2: "US", name: "United States", dial: "1",   nsnLen: 10, avaPrefix: "30", groups: [3, 3, 4], flag: "🇺🇸" },
  { iso2: "GB", name: "United Kingdom",dial: "44",  nsnLen: 10, avaPrefix: "74", groups: [4, 3, 3], flag: "🇬🇧" },
  { iso2: "IN", name: "India",         dial: "91",  nsnLen: 10, avaPrefix: "60", groups: [5, 5],    flag: "🇮🇳" },
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

/** Validate an NSN against the plan: right length, all digits, reserved prefix. */
export function validNsn(plan: CountryPlan, nsn: string): boolean {
  return /^[0-9]+$/.test(nsn) && nsn.length === plan.nsnLen && nsn.startsWith(plan.avaPrefix);
}

function randDigits(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
  return s;
}

/**
 * Generate up to `count` candidate NSNs conforming to the plan. If `pattern`
 * (digits only) is given, every candidate contains it. Caller still filters out
 * taken / reserved numbers before offering them.
 */
export function generate(plan: CountryPlan, count: number, pattern?: string): string[] {
  const tail = plan.nsnLen - plan.avaPrefix.length;
  const pat = (pattern || "").replace(/[^0-9]/g, "");
  const out = new Set<string>();
  let guard = 0;
  while (out.size < count && guard < count * 40) {
    guard++;
    let nsn: string;
    if (pat && pat.length <= tail) {
      // place the pattern at a random valid offset within the tail
      const maxOff = tail - pat.length;
      const off = Math.floor(Math.random() * (maxOff + 1));
      const tailStr = randDigits(off) + pat + randDigits(tail - pat.length - off);
      nsn = plan.avaPrefix + tailStr;
    } else if (pat) {
      // pattern too long to fit → no conforming candidates
      break;
    } else {
      nsn = plan.avaPrefix + randDigits(tail);
    }
    if (validNsn(plan, nsn)) out.add(nsn);
  }
  return [...out];
}
