#!/usr/bin/env node
// [DASH2-PUSH 2026-09-26] Prints a NEW VAPID key pair for Saa Thum web push.
//   node worker/scripts/gen_vapid.mjs
// Formats (what lib/web_push.ts reads):
//   VAPID_PUBLIC_KEY  = base64url, 65-byte uncompressed P-256 point (0x04||x||y), 87 chars
//   VAPID_PRIVATE_KEY = base64url, raw 32-byte private scalar (JWK "d"), 43 chars
//   VAPID_SUBJECT     = mailto:support@saathum.com
// Set them as worker secrets (coordinator only), e.g.:
//   cd worker && npx wrangler secret put VAPID_PUBLIC_KEY   (paste the value)
// Rotating the pair invalidates every existing browser subscription.
import { webcrypto as crypto } from "node:crypto";

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
if (pub.length !== 65 || pub[0] !== 4 || !jwk.d) throw new Error("unexpected key shape");

console.log(`VAPID_PUBLIC_KEY=${b64url(pub)}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
console.log("VAPID_SUBJECT=mailto:support@saathum.com");
