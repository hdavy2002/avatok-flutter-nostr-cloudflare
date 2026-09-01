/*
 * [PAY-PAYTM-TEST-1] Proves our Paytm signature interoperates with Paytm's own.
 *
 * WHY THIS FILE EXISTS. A wrong Paytm checksum does not fail loudly or locally.
 * It fails at the gateway, as resultCode 2005 "Checksum provided is invalid",
 * after a round trip, and it looks exactly like a credentials problem. The first
 * version of `lib/payments/paytm.ts` shipped a placeholder scheme
 * (`sha256(body|salt|key) + salt`) that could never have worked; nothing in the
 * repo could have told us that. This test can.
 *
 * WHAT IT ASSERTS — the success value, written down before the integration is
 * called done, per CLAUDE.md's ship gate:
 *
 *   1. our verifier accepts a signature Paytm's own library generated
 *   2. Paytm's own library accepts a signature we generated
 *   3. a tampered payload is rejected
 *   4. our NVP callback string is byte-identical to `getStringByParams`
 *   5. our verifier accepts a callback signature Paytm's library generated
 *
 * (1) and (2) together are the real proof: agreeing with ourselves is worth
 * nothing, and one direction alone can pass with a symmetric mistake.
 *
 * HOW TO RUN. The reference library is not a dependency of this Worker and must
 * not become one — it is Node-only (`require('crypto')`) and would not run in
 * the runtime. Fetch it just for the test:
 *
 *     mkdir -p /tmp/pcs && cd /tmp/pcs
 *     npm pack paytmchecksum && tar xzf *.tgz
 *     cp <repo>/worker/test/paytm_checksum.test.mjs . && node paytm_checksum.test.mjs
 *
 * It exits non-zero on any failure, so it can be dropped into CI once the
 * reference tarball is vendored or fetched in the job.
 *
 * The crypto below is a line-for-line mirror of `lib/payments/paytm.ts`. If you
 * change the adapter's checksum, change it here too, or this proves nothing.
 */
import PaytmChecksum from './package/PaytmChecksum.js';

const subtle = globalThis.crypto.subtle;
const getRandomValues = (b) => globalThis.crypto.getRandomValues(b);

/** Paytm's fixed IV. Their constant, not ours. */
const IV = '@@@@&&&&####$$$$';

const utf8 = (s) => new TextEncoder().encode(s);
const b64e = (b) => Buffer.from(b).toString('base64');
const b64d = (s) => new Uint8Array(Buffer.from(s, 'base64'));

async function sha256Hex(m) {
  const d = await subtle.digest('SHA-256', utf8(m));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function aesKey(k) {
  const raw = utf8(k);
  if (raw.length !== 16) throw new Error(`paytm merchant key must be 16 bytes, got ${raw.length}`);
  return subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
}

const calcHash = async (params, salt) => (await sha256Hex(`${params}|${salt}`)) + salt;

async function sign(params, key) {
  const b = new Uint8Array(3);
  getRandomValues(b);
  const salt = b64e(b);
  const hash = await calcHash(params, salt);
  const ct = await subtle.encrypt({ name: 'AES-CBC', iv: utf8(IV) }, await aesKey(key), utf8(hash));
  return b64e(new Uint8Array(ct));
}

async function valid(params, key, signature) {
  try {
    const pt = await subtle.decrypt({ name: 'AES-CBC', iv: utf8(IV) }, await aesKey(key), b64d(signature));
    const hash = new TextDecoder().decode(pt);
    if (hash.length < 5) return false;
    return hash === (await calcHash(params, hash.slice(-4)));
  } catch {
    return false;
  }
}

// A 16-character key of the shape Paytm issues. Not a real credential, and this
// file must never carry one — the real key lives only in `wrangler secret`.
const KEY = 'bKMfNxPPf_QdZppa';

const requestBody = JSON.stringify({
  requestType: 'Payment',
  mid: 'INTEGR7769XXXXXX9383',
  websiteName: 'WEBSTAGING',
  orderId: 'ORD_1',
  txnAmount: { value: '1.00', currency: 'INR' },
  userInfo: { custId: 'CUST_1' },
});

// A callback of the shape documented at paytmpayments.com/docs/payment-status.
const callback = {
  ORDERID: 'ORD_1',
  TXNAMOUNT: '1.00',
  STATUS: 'TXN_SUCCESS',
  MID: 'INTEGR7769XXXXXX9383',
  CURRENCY: 'INR',
  TXNID: '202005',
};
const nvp = Object.keys(callback).sort().map((k) => callback[k]).join('|');

const results = [
  ['ours verifies their request signature ', await valid(requestBody, KEY, await PaytmChecksum.generateSignature(requestBody, KEY))],
  ['theirs verifies our request signature ', PaytmChecksum.verifySignature(requestBody, KEY, await sign(requestBody, KEY))],
  ['a tampered body is rejected           ', !(await valid(`${requestBody} `, KEY, await PaytmChecksum.generateSignature(requestBody, KEY)))],
  ['our NVP string matches theirs exactly ', PaytmChecksum.getStringByParams({ ...callback }) === nvp],
  ['ours verifies their callback signature', await valid(nvp, KEY, await PaytmChecksum.generateSignature({ ...callback }, KEY))],
];

let failed = 0;
for (const [name, ok] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
if (failed) {
  console.error(`\n${failed} assertion(s) failed — the adapter will be refused by Paytm with resultCode 2005.`);
  process.exit(1);
}
console.log("\nAll 5 passed. The adapter's signature scheme matches Paytm's reference implementation.");
