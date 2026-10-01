// [AUMFE-POD-CORE-1] Address helpers for the print partner. Our checkout allows 200-char lines and an optional phone;
// the partner wants address lines of 3-50 chars and a 10-digit phone. Contract: SPEC section 3 / section 9.

export type PartnerAddressInput = { line1?: string | null; line2?: string | null; landmark?: string | null };
export type PartnerAddressSplit =
  | { ok: true; address1: string; address2: string; address3?: string }
  | { ok: false; reason: string };

const LINE_MAX = 50;
const LINE_MIN = 3;
const TOTAL_MAX = 150;
/** Used for address2 when a very short address cannot be split into two real lines (partner needs 3-50 chars). */
const ADDRESS2_FILLER = 'N/A';

/** Break one over-long word into LINE_MAX chunks. */
function chunkWord(w: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < w.length; i += LINE_MAX) out.push(w.slice(i, i + LINE_MAX));
  return out;
}

/** Greedy word-wrap into lines of at most LINE_MAX chars, never cutting a word unless a single word exceeds LINE_MAX. */
function wrap(text: string): string[] {
  const words = text.split(' ').flatMap((w) => (w.length > LINE_MAX ? chunkWord(w) : [w]));
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= LINE_MAX) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Split line1 + line2 (+ landmark) into address1/address2/address3, each 3-50 chars on word boundaries.
 * Fails (never truncates) when the whole address is empty or cannot fit in 150 chars / 3 lines.
 */
export function splitAddressForPartner(addr: PartnerAddressInput): PartnerAddressSplit {
  const joined = [addr.line1, addr.line2, addr.landmark]
    .map((p) => String(p ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(', ');
  if (joined.length < LINE_MIN) return { ok: false, reason: 'Address is too short for the print partner (needs at least 3 characters).' };
  if (joined.length > TOTAL_MAX) return { ok: false, reason: `Address is ${joined.length} characters; the print partner fits at most ${TOTAL_MAX}.` };

  let lines = wrap(joined);
  // A one-line address still needs address2 (3-50 chars): split at the word boundary nearest the middle.
  if (lines.length === 1) {
    const words = lines[0].split(' ');
    let best = -1;
    let bestGap = Infinity;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' ');
      const b = words.slice(i).join(' ');
      if (a.length < LINE_MIN || b.length < LINE_MIN) continue;
      const gap = Math.abs(a.length - b.length);
      if (gap < bestGap) { bestGap = gap; best = i; }
    }
    lines = best > 0 ? [words.slice(0, best).join(' '), words.slice(best).join(' ')] : [lines[0], ADDRESS2_FILLER];
  }
  // A trailing line under 3 chars: pull the previous line's last word down to it.
  for (let i = lines.length - 1; i > 0; i--) {
    if (lines[i].length >= LINE_MIN) continue;
    const prev = lines[i - 1].split(' ');
    if (prev.length < 2) return { ok: false, reason: 'Address cannot be split into valid lines for the print partner.' };
    const moved = prev.pop() as string;
    lines[i - 1] = prev.join(' ');
    lines[i] = `${moved} ${lines[i]}`;
  }
  if (lines.length > 3) return { ok: false, reason: 'Address needs more than three 50-character lines for the print partner.' };
  if (lines.some((l) => l.length < LINE_MIN || l.length > LINE_MAX)) {
    return { ok: false, reason: 'Address cannot be split into valid lines for the print partner.' };
  }
  const out: PartnerAddressSplit = { ok: true, address1: lines[0], address2: lines[1] };
  if (lines[2]) out.address3 = lines[2];
  return out;
}

/** Normalise an Indian mobile number to its 10 digits (strips +91 / 91 / 0), or null when it is not one. */
function tenDigits(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

/**
 * The 10-digit phone the partner needs: the address phone when it is a valid Indian mobile, else the buyer's verified
 * WhatsApp number when it is +91, else null (the owner must add one before sending).
 */
export function deliveryPhone10(addressPhone: string | null | undefined, verifiedWhatsAppE164: string | null | undefined): string | null {
  const fromAddress = tenDigits(addressPhone);
  if (fromAddress) return fromAddress;
  const wa = String(verifiedWhatsAppE164 ?? '').trim();
  if (wa.startsWith('+91')) return tenDigits(wa);
  return null;
}
