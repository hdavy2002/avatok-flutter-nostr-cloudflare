// [WA-LOGIN-1 2026-09-28] General E.164 phone normalization.
//
// OWNER DECISION 2026-09-28: WhatsApp login accepts international numbers, not
// just +91. This is the ONE normalizer for "phone the user typed" -> E.164
// across the codebase; routes/phone_otp.ts and routes/me_dashboard.ts now call
// it instead of the old +91-only indianMobileE164 (kept there as a thin
// wrapper for any other caller that still wants an India-only check).
//
// ACCEPTS:
//   - "+<cc><number>" with 7-15 total digits after the "+" (E.164's own length
//     rule), loosely -- we don't validate the calling-code table, just shape.
//   - legacy bare Indian mobile forms (what indianMobileE164 used to accept):
//     a plain 10-digit "9876543210", a 0-prefixed "09876543210", or a
//     91-prefixed "919876543210" -> normalized to "+91XXXXXXXXXX". Only when
//     defaultCountry is "IN" (the only default this codebase has today).
//   - any other bare digit string of 7-15 digits is accepted as-is with a "+"
//     prepended, rather than rejected outright -- better to take a real
//     international number a user typed without the "+" than to bounce it.
//
// Returns null when nothing usable survives.
export function normalizeE164(raw: unknown, defaultCountry: "IN" = "IN"): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  if (s.startsWith("+")) {
    const digits = s.replace(/[^\d]/g, "");
    if (digits.length < 7 || digits.length > 15) return null;
    return "+" + digits;
  }
  const digits = s.replace(/\D/g, "");
  if (!digits) return null;

  if (defaultCountry === "IN") {
    let d = digits;
    if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
    else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
    if (/^[6-9]\d{9}$/.test(d)) return "+91" + d;
  }

  if (digits.length >= 7 && digits.length <= 15) return "+" + digits;
  return null;
}

/** Copy shown to the user when normalizeE164 rejects their input. */
export const INVALID_PHONE_MESSAGE = "Enter your WhatsApp number with the country code.";
