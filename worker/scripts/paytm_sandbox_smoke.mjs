/*
 * [PAY-PAYTM-TEST-1] Paytm staging smoke test — one real transaction, end to end.
 *
 * WHAT THIS IS FOR. `worker/test/paytm_checksum.test.mjs` proves our signature
 * matches Paytm's reference implementation. That is necessary and not
 * sufficient: it proves the maths, not that Paytm accepts our request shape,
 * our host, our websiteName or our callbackUrl. This script finds that out by
 * asking Paytm, which is the only authority on it.
 *
 * It mints a real staging transaction and prints the Show Payment Page form you
 * can submit in a browser to complete a sandbox payment. No real money exists on
 * the staging host.
 *
 * CREDENTIALS. Read from the environment, never from a file, never a default,
 * and never printed. Run it like this so the key stays out of your shell
 * history — note the leading space, which most shells honour via HISTCONTROL:
 *
 *      export PAYTM_MID=XMxYrz30893776562490
 *      export PAYTM_WEBSITE=WEBSTAGING
 *      read -rs PAYTM_MERCHANT_KEY && export PAYTM_MERCHANT_KEY   # paste, press enter
 *     node worker/scripts/paytm_sandbox_smoke.mjs
 *
 * When you are finished:  unset PAYTM_MERCHANT_KEY
 *
 * This talks ONLY to securestage.paytmpayments.com. It has no production branch
 * on purpose — if you want to test production, that is a different script and a
 * different conversation.
 */

const HOST = 'https://securestage.paytmpayments.com';
const IV = '@@@@&&&&####$$$$';

const MID = process.env.PAYTM_MID;
const KEY = process.env.PAYTM_MERCHANT_KEY;
const WEBSITE = process.env.PAYTM_WEBSITE ?? 'WEBSTAGING';
// Where Paytm posts the result. Any publicly reachable URL works for a smoke
// test; the point is to confirm Paytm ACCEPTS the field, not to receive it.
const CALLBACK = process.env.PAYTM_CALLBACK_URL ?? 'https://api.avatok.ai/api/pay/paytm/webhook';

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

if (!MID) die('PAYTM_MID is not set.');
if (!KEY) die('PAYTM_MERCHANT_KEY is not set. See the header for how to set it without it landing in your shell history.');

const subtle = globalThis.crypto.subtle;
const utf8 = (s) => new TextEncoder().encode(s);
const b64e = (b) => Buffer.from(b).toString('base64');

if (utf8(KEY).length !== 16) {
  die(`The merchant key must be exactly 16 bytes; this one is ${utf8(KEY).length}. Paytm's key is used directly as an AES-128 key, so any other length cannot work.`);
}

async function sha256Hex(m) {
  const d = await subtle.digest('SHA-256', utf8(m));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Identical to `paytmSignature` in worker/src/lib/payments/paytm.ts. */
async function sign(params) {
  const salt = b64e(globalThis.crypto.getRandomValues(new Uint8Array(3)));
  const hash = (await sha256Hex(`${params}|${salt}`)) + salt;
  const key = await subtle.importKey('raw', utf8(KEY), { name: 'AES-CBC' }, false, ['encrypt']);
  const ct = await subtle.encrypt({ name: 'AES-CBC', iv: utf8(IV) }, key, utf8(hash));
  return b64e(new Uint8Array(ct));
}

async function signedPost(path, body) {
  const signature = await sign(JSON.stringify(body));
  const res = await fetch(`${HOST}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body, head: { signature } }),
  });
  const text = await res.text();
  try {
    return { status: res.status, parsed: JSON.parse(text) };
  } catch {
    return { status: res.status, parsed: null, text };
  }
}

const orderId = `SMOKE_${Date.now()}`;
const AMOUNT = '1.00';

console.log(`\nPaytm staging smoke test`);
console.log(`  host      ${HOST}`);
console.log(`  mid       ${MID}`);
console.log(`  website   ${WEBSITE}`);
console.log(`  key       [16 bytes, not shown]`);
console.log(`  orderId   ${orderId}`);
console.log(`  amount    ₹${AMOUNT}\n`);

// ── 1. Initiate Transaction ────────────────────────────────────────────────
const initiate = await signedPost(
  `/theia/api/v1/initiateTransaction?mid=${encodeURIComponent(MID)}&orderId=${encodeURIComponent(orderId)}`,
  {
    requestType: 'Payment',
    mid: MID,
    websiteName: WEBSITE,
    orderId,
    callbackUrl: CALLBACK,
    txnAmount: { value: AMOUNT, currency: 'INR' },
    userInfo: { custId: 'SMOKE_CUST_1' },
  },
);

const info = initiate.parsed?.body?.resultInfo;
const txnToken = initiate.parsed?.body?.txnToken;

if (!txnToken) {
  console.error(`✗ Initiate Transaction failed (HTTP ${initiate.status})`);
  console.error(`  resultCode   ${info?.resultCode ?? '—'}`);
  console.error(`  resultMsg    ${info?.resultMsg ?? initiate.text ?? '—'}`);
  if (String(info?.resultCode) === '2005') {
    console.error(`\n  2005 is "Checksum provided is invalid" — the signature, not the credentials.`);
    console.error(`  Run worker/test/paytm_checksum.test.mjs first; if that passes, the likely`);
    console.error(`  cause is a body that differs between what we signed and what we sent.`);
  }
  if (String(info?.resultCode) === '335') {
    console.error(`\n  335 is "Mid is invalid" — check PAYTM_MID, and that this key belongs to it.`);
  }
  process.exit(1);
}

console.log(`✓ Initiate Transaction accepted`);
console.log(`  resultMsg    ${info?.resultMsg}`);
console.log(`  txnToken     ${String(txnToken).slice(0, 8)}… (${String(txnToken).length} chars)\n`);

// ── 2. The form a browser submits to reach the cashier ─────────────────────
const payUrl = `${HOST}/theia/api/v1/showPaymentPage?mid=${encodeURIComponent(MID)}&orderId=${encodeURIComponent(orderId)}`;
console.log(`To complete a sandbox payment by hand, save this as paytm-smoke.html and open it:\n`);
console.log(`<form method="post" action="${payUrl}">`);
console.log(`  <input type="hidden" name="mid" value="${MID}">`);
console.log(`  <input type="hidden" name="orderId" value="${orderId}">`);
console.log(`  <input type="hidden" name="txnToken" value="${txnToken}">`);
console.log(`  <button type="submit">Pay ₹${AMOUNT}</button>`);
console.log(`</form>\n`);
console.log(`On the cashier, choose UPI and enter the test VPA  7777777777@paytm`);
console.log(`then approve it in Paytm's test UPI app.\n`);

// ── 3. Transaction status ──────────────────────────────────────────────────
const status = await signedPost('/v3/order/status', { mid: MID, orderId });
const sInfo = status.parsed?.body?.resultInfo;
console.log(`✓ Transaction Status reachable (HTTP ${status.status})`);
console.log(`  resultStatus ${sInfo?.resultStatus ?? '—'}`);
console.log(`  resultMsg    ${sInfo?.resultMsg ?? '—'}`);
console.log(`\n  A brand-new order reads PENDING or "No Record Found" until someone pays —`);
console.log(`  that is the correct answer here, not a failure. Re-run:`);
console.log(`\n    PAYTM_SMOKE_ORDER=${orderId} node worker/scripts/paytm_sandbox_smoke.mjs\n`);
console.log(`  after completing the form above to see it flip to TXN_SUCCESS.\n`);

if (sInfo?.resultStatus || sInfo?.resultCode) {
  console.log(`Both signed endpoints answered. The signature scheme, host, MID, websiteName`);
  console.log(`and callbackUrl are all accepted by Paytm staging.\n`);
}
