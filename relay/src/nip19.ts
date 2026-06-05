// NIP-19 hex → npub (bech32), for naming push recipients by npub (matches the
// push_tokens table which is keyed by npub bech32).
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}
function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0, bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad) { if (bits) out.push((acc << (to - bits)) & maxv); }
  else if (bits >= from || ((acc << (to - bits)) & maxv)) return null;
  return out;
}
function bech32Encode(hrp: string, data: number[]): string {
  const mod = polymod(hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0])) ^ 1;
  const chk: number[] = [];
  for (let i = 0; i < 6; i++) chk.push((mod >> (5 * (5 - i))) & 31);
  let ret = hrp + "1";
  for (const d of data.concat(chk)) ret += CHARSET[d];
  return ret;
}
export function hexToNpub(h: string): string | null {
  if (!/^[0-9a-f]{64}$/i.test(h)) return null;
  const bytes = h.toLowerCase().match(/.{2}/g)!.map((x) => parseInt(x, 16));
  const five = convertBits(bytes, 8, 5, true);
  if (!five) return null;
  return bech32Encode("npub", five);
}
