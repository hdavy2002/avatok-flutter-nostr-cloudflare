// [RECEPT-STATS-1] E.164 dialing-prefix → ISO-3166 alpha-2 country, for the
// receptionist call-summary analytics (caller_country dimension). Pure data +
// longest-prefix match, no engine code, no I/O — safe to import from anywhere
// (including routes/pstn.ts, which bans engine imports).
//
// Coverage: the top ~75 dialing prefixes by AvaTOK traffic likelihood (IN, NANP,
// GCC, EU, SE Asia, Africa). Anything unmatched → "??" — the dashboard renders
// that as "Unknown" and nothing downstream ever branches on it.

// 3- and 2-digit prefixes first (checked longest-first below). +1 is split
// US/CA by area code — see NANP_CA.
const E164_PREFIXES: Record<string, string> = {
  // ── 3-digit ──
  "212": "MA", "213": "DZ", "216": "TN", "218": "LY", "220": "GM", "233": "GH",
  "234": "NG", "249": "SD", "251": "ET", "254": "KE", "255": "TZ", "256": "UG",
  "260": "ZM", "263": "ZW", "852": "HK", "853": "MO", "855": "KH", "856": "LA",
  "880": "BD", "886": "TW", "960": "MV", "961": "LB", "962": "JO", "963": "SY",
  "964": "IQ", "965": "KW", "966": "SA", "967": "YE", "968": "OM", "971": "AE",
  "972": "IL", "973": "BH", "974": "QA", "975": "BT", "976": "MN", "977": "NP",
  "992": "TJ", "993": "TM", "994": "AZ", "995": "GE", "996": "KG", "998": "UZ",
  // ── 2-digit ──
  "20": "EG", "27": "ZA", "30": "GR", "31": "NL", "32": "BE", "33": "FR",
  "34": "ES", "36": "HU", "39": "IT", "40": "RO", "41": "CH", "43": "AT",
  "44": "GB", "45": "DK", "46": "SE", "47": "NO", "48": "PL", "49": "DE",
  "51": "PE", "52": "MX", "54": "AR", "55": "BR", "56": "CL", "57": "CO",
  "58": "VE", "60": "MY", "61": "AU", "62": "ID", "63": "PH", "64": "NZ",
  "65": "SG", "66": "TH", "81": "JP", "82": "KR", "84": "VN", "86": "CN",
  "90": "TR", "91": "IN", "92": "PK", "93": "AF", "94": "LK", "95": "MM",
  "98": "IR",
  // ── 1-digit ──
  "7": "RU", // +7 covers RU + KZ; RU is the overwhelmingly likelier origin
};

// NANP (+1): Canadian area codes (the finite official list); everything else on
// +1 is treated as US (covers US territories too — close enough for a dashboard).
const NANP_CA = new Set([
  "204", "226", "236", "249", "250", "263", "289", "306", "343", "354", "365",
  "367", "368", "382", "403", "416", "418", "428", "431", "437", "438", "450",
  "468", "474", "506", "514", "519", "548", "579", "581", "584", "587", "600",
  "604", "613", "639", "647", "672", "683", "705", "709", "742", "753", "778",
  "780", "782", "807", "819", "825", "867", "873", "879", "902", "905",
]);

/**
 * E.164 (or near-E.164) phone → ISO country ("??" when unknown/unparseable).
 * Tolerant of missing "+" and stray formatting characters.
 */
export function e164Country(phone: string | null | undefined): string {
  const digits = String(phone ?? "").replace(/[^\d]/g, "");
  if (!digits) return "??";
  if (digits.startsWith("1")) {
    // NANP: split US/CA by area code (digits[1..3]).
    return NANP_CA.has(digits.slice(1, 4)) ? "CA" : "US";
  }
  for (const len of [3, 2, 1]) {
    const hit = E164_PREFIXES[digits.slice(0, len)];
    if (hit) return hit;
  }
  return "??";
}
