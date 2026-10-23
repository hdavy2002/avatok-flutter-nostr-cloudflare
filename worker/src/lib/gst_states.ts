// [HF-MERCH-GST-1 2026-10-23] Indian state / UT name -> 2-digit GST state code (the first two digits of a GSTIN). Pure, no I/O.
// Used to decide the place of supply of a merch order: buyer state == supplier state (hfStateCode) -> CGST + SGST, else IGST.
// The address form takes the state as free text, so matching is forgiving: case, "&" vs "and", punctuation and common old names are ignored.

export const GST_STATES: ReadonlyArray<{ code: string; name: string }> = [
  { code: "01", name: "Jammu and Kashmir" }, { code: "02", name: "Himachal Pradesh" }, { code: "03", name: "Punjab" }, { code: "04", name: "Chandigarh" },
  { code: "05", name: "Uttarakhand" }, { code: "06", name: "Haryana" }, { code: "07", name: "Delhi" }, { code: "08", name: "Rajasthan" },
  { code: "09", name: "Uttar Pradesh" }, { code: "10", name: "Bihar" }, { code: "11", name: "Sikkim" }, { code: "12", name: "Arunachal Pradesh" },
  { code: "13", name: "Nagaland" }, { code: "14", name: "Manipur" }, { code: "15", name: "Mizoram" }, { code: "16", name: "Tripura" },
  { code: "17", name: "Meghalaya" }, { code: "18", name: "Assam" }, { code: "19", name: "West Bengal" }, { code: "20", name: "Jharkhand" },
  { code: "21", name: "Odisha" }, { code: "22", name: "Chhattisgarh" }, { code: "23", name: "Madhya Pradesh" }, { code: "24", name: "Gujarat" },
  { code: "26", name: "Dadra and Nagar Haveli and Daman and Diu" }, { code: "27", name: "Maharashtra" }, { code: "29", name: "Karnataka" }, { code: "30", name: "Goa" },
  { code: "31", name: "Lakshadweep" }, { code: "32", name: "Kerala" }, { code: "33", name: "Tamil Nadu" }, { code: "34", name: "Puducherry" },
  { code: "35", name: "Andaman and Nicobar Islands" }, { code: "36", name: "Telangana" }, { code: "37", name: "Andhra Pradesh" }, { code: "38", name: "Ladakh" },
];

const ALIASES: Record<string, string> = {
  "orissa": "21", "uttaranchal": "05", "pondicherry": "34", "nct of delhi": "07", "new delhi": "07", "delhi ncr": "07", "j and k": "01", "jk": "01",
  "daman and diu": "26", "dadra and nagar haveli": "26", "dadra nagar haveli": "26", "dnhdd": "26", "andaman nicobar islands": "35", "andaman and nicobar": "35",
  "andaman": "35", "chattisgarh": "22", "tamilnadu": "33", "telengana": "36", "other territory": "97",
};

const norm = (s: string): string => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
const BY_NAME = new Map<string, string>([...GST_STATES.map((s) => [norm(s.name), s.code] as [string, string]), ...Object.entries(ALIASES)]);
const CODES = new Set([...GST_STATES.map((s) => s.code), "97"]);

/** "Maharashtra" -> "27"; also accepts a 2-digit code ("27", "7" -> "07"). Unknown / empty -> null. */
export function gstStateCode(state: string | null | undefined): string | null {
  const raw = String(state ?? "").trim();
  if (!raw) return null;
  if (/^\d{1,2}$/.test(raw)) { const c = raw.padStart(2, "0"); return CODES.has(c) ? c : null; }
  const n = norm(raw);
  return BY_NAME.get(n) ?? null;
}

export function gstStateName(code: string | null | undefined): string | null {
  return GST_STATES.find((s) => s.code === code)?.name ?? (code === "97" ? "Other Territory" : null);
}
