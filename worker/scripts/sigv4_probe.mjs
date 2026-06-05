// Phase 0.3 probe — verify the SigV4 signing-key derivation (Web Crypto only,
// the same primitives available in a Cloudflare Worker) against AWS's published
// test vector. Mirrors signingKey() in src/aws/sigv4.ts exactly.
//
// AWS reference vector (https://docs.aws.amazon.com/general/latest/gr/signature-v4-examples.html):
//   secret    = wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY
//   dateStamp = 20120215 , region = us-east-1 , service = iam
//   expected kSigning (hex) = f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d
import { webcrypto as crypto } from "node:crypto";
const enc = new TextEncoder();
const toHex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", key instanceof Uint8Array ? key : new Uint8Array(key),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(msg));
}
async function signingKey(secret, dateStamp, region, service) {
  const kDate = await hmac(enc.encode("AWS4" + secret), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

const got = toHex(await signingKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20120215", "us-east-1", "iam"));
const want = "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d";
console.log("derived :", got);
console.log("expected:", want);
console.log(got === want ? "PROBE 3 PASS — SigV4 signing-key derivation correct in Web Crypto" : "PROBE 3 FAIL");
process.exit(got === want ? 0 : 1);
