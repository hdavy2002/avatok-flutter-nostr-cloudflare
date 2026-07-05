// Identity id minting + id-shape helpers.
// Design: Specs/ROUTING-IDENTITY-PRESENCE-ARCH.md (v4) §5.1.
//
// identity_id is an OPAQUE, durable id of the form `idn_<ulid>` — a 26-char
// lowercase Crockford-base32 ULID. It is minted ONCE per user and NEVER reused
// or re-derived from the uid: the current Clerk uid is stored as an ALIAS
// (kind='uid'), so a future uid re-key never changes the identity_id. No
// external deps — the ULID is built from Date.now() + crypto random bytes.

// Crockford base32 (ULID alphabet): no I, L, O, U to avoid ambiguity.
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** Encode `n` bytes of a big-endian value into `len` Crockford-base32 chars. */
function encodeTime(ms: number): string {
  // 48-bit timestamp → 10 base32 chars (ULID spec).
  let out = "";
  let t = Math.max(0, Math.floor(ms));
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/** 80 bits of randomness → 16 base32 chars (ULID spec). */
function encodeRandom(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10)); // 80 bits
  // Accumulate the 80-bit value across 16 5-bit groups.
  let out = "";
  let bitBuffer = 0;
  let bits = 0;
  for (const b of bytes) {
    bitBuffer = (bitBuffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(bitBuffer >> bits) & 0x1f];
    }
  }
  if (bits > 0) out += CROCKFORD[(bitBuffer << (5 - bits)) & 0x1f];
  return out.slice(0, 16);
}

/** A monotonic-ish, lowercase 26-char ULID (10 time + 16 random). */
export function ulid(now: number = Date.now()): string {
  return (encodeTime(now) + encodeRandom()).toLowerCase();
}

/** Mint a fresh opaque identity id: `idn_<ulid>`. Never reused. */
export function newIdentityId(): string {
  return "idn_" + ulid();
}

/** Is `s` a well-formed opaque identity id (idn_<26-char lowercase base32>)? */
export function isIdentityId(s: string): boolean {
  return /^idn_[0-9a-z]{26}$/.test(s);
}

/** Legacy Nostr public key (deprecated alias family, kind='npub'). */
export function isLegacyNpub(s: string): boolean {
  return /^npub1[0-9a-z]+$/.test(s);
}

/** Clerk user id (current alias family, kind='uid'). */
export function isClerkUid(s: string): boolean {
  return /^user_/.test(s);
}
