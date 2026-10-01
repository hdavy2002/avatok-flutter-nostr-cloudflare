#!/usr/bin/env node
// [AUMFE-POD-CORE-1] Printrove API probe. Prints the REAL response shapes so the `// PROBE:` guesses in
// worker/src/lib/pod/printrove.ts can be corrected. Read-only by default. Token, passwords and personal data are redacted.
//
//   PRINTROVE_EMAIL=you@example.com PRINTROVE_PASSWORD='...' node scripts/printrove_probe.mjs
//   ... node scripts/printrove_probe.mjs --create-test-order     # OFF by default, see below
//
// Calls (all GET unless noted): POST token, categories, one category's products, one product's detail (variants),
// designs list, products list, orders list, serviceability for 110001 and 248001.
//
// --create-test-order: ALSO POSTs one real order (reference_number PROBE-<timestamp>, dummy customer, quantity 1 of the first
// variant found). This creates a real order at Printrove. The OWNER MUST CANCEL IT in the Printrove dashboard straight away
// (the API has no cancel). Never run it unless the owner has said so.
//
// Requests are spaced 600 ms apart (the API allows about 2 per second).

const BASE = 'https://api.printrove.com/api/external/';
const email = process.env.PRINTROVE_EMAIL;
const password = process.env.PRINTROVE_PASSWORD;
const createTestOrder = process.argv.includes('--create-test-order');

if (!email || !password) {
  console.error('Set PRINTROVE_EMAIL and PRINTROVE_PASSWORD in the environment.');
  process.exit(2);
}

let token = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SECRET_KEYS = /token|password|authorization|secret/i;
const PII_KEYS = /^(name|first_?name|last_?name|email|number|phone|mobile|address\d?|street|landmark|pincode|city|state|awb|awb_number|tracking_number|tracking_id|tracking_url|tracking_link|invoice_url)$/i;

function redact(v, key = '', depth = 0) {
  if (SECRET_KEYS.test(key)) return '[REDACTED]';
  if (PII_KEYS.test(key) && typeof v !== 'object') return '[PII]';
  if (typeof v === 'string') {
    const s = v.split(token || '\u0000').join('[TOKEN]');
    return s.length > 120 ? `${s.slice(0, 120)}...(${s.length} chars)` : s;
  }
  if (Array.isArray(v)) {
    const head = v.slice(0, 2).map((x) => redact(x, key, depth + 1));
    return v.length > 2 ? [...head, `...(${v.length} items total)`] : head;
  }
  if (v && typeof v === 'object') {
    if (depth > 5) return '{...}';
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x, k, depth + 1)]));
  }
  return v;
}

async function call(label, method, path, { query, json } = {}) {
  await sleep(600);
  const url = new URL(path, BASE);
  for (const [k, val] of Object.entries(query ?? {})) url.searchParams.set(k, String(val));
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  let res;
  try { res = await fetch(url, { method, headers, body }); } catch (e) { console.log(`\n== ${label}\n   NETWORK ERROR: ${e.message}`); return null; }
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 300); }
  console.log(`\n== ${label}\n   ${method} ${url.pathname}${url.search}  ->  HTTP ${res.status}`);
  console.log(JSON.stringify(redact(parsed), null, 2).split('\n').map((l) => `   ${l}`).join('\n'));
  return res.ok ? parsed : null;
}

const firstArray = (b) => {
  if (Array.isArray(b)) return b;
  if (b && typeof b === 'object') {
    for (const k of ['data', 'products', 'categories', 'orders', 'designs', 'items', 'results']) {
      if (Array.isArray(b[k])) return b[k];
      if (b[k] && typeof b[k] === 'object') { const inner = firstArray(b[k]); if (inner.length) return inner; }
    }
  }
  return [];
};

// token (body holds the password: never printed)
await sleep(100);
const tokRes = await fetch(`${BASE}token`, {
  method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ email, password }),
});
const tokBody = await tokRes.json().catch(() => ({}));
console.log(`== token\n   POST token  ->  HTTP ${tokRes.status}`);
const tokData = tokBody?.data && typeof tokBody.data === 'object' ? tokBody.data : tokBody;
token = tokData?.access_token ?? tokData?.token ?? '';
console.log(`   keys: ${Object.keys(tokBody ?? {}).join(', ')}${tokBody?.data ? `  data keys: ${Object.keys(tokBody.data).join(', ')}` : ''}`);
console.log(`   token present: ${Boolean(token)}   expires_at: ${JSON.stringify(tokData?.expires_at ?? tokData?.expires_in ?? null)}  (format matters: epoch s / ms / date string)`);
if (!token) { console.error('No token; stopping.'); process.exit(1); }

const cats = await call('categories', 'GET', 'categories');
const catList = firstArray(cats);
const cat = catList.find((c) => /t-?shirt|tee/i.test(JSON.stringify(c?.name ?? ''))) ?? catList[0];
let variantId = null;
if (cat?.id !== undefined) {
  const prods = await call(`category ${cat.id} (products list)`, 'GET', `categories/${cat.id}`);
  const plist = firstArray(prods);
  const prod = plist[0];
  if (prod?.id !== undefined) {
    const detail = await call(`product ${prod.id} detail (variants)`, 'GET', `categories/${cat.id}/products/${prod.id}`);
    const find = (n, d = 0) => {
      if (!n || typeof n !== 'object' || d > 5) return null;
      if (!Array.isArray(n) && n.id !== undefined && (n.color ?? n.colour ?? n.colour_name ?? n.color_name) !== undefined) return n.id;
      for (const v of Object.values(n)) { const r = find(v, d + 1); if (r) return r; }
      return null;
    };
    variantId = find(detail);
  }
}
await call('designs list', 'GET', 'designs');
await call('products list', 'GET', 'products');
await call('orders list', 'GET', 'orders');
for (const pin of ['110001', '248001']) {
  await call(`serviceability ${pin}`, 'GET', 'serviceability', { query: { country: 'India', pincode: pin, weight: 300, cod: 'false' } });
}

if (createTestOrder) {
  if (!variantId) { console.error('\n--create-test-order: no variant id found; skipping.'); }
  else {
    console.log('\n!! Creating a REAL test order. Cancel it in the Printrove dashboard now.');
    await call('create test order', 'POST', 'orders', {
      json: {
        reference_number: `PROBE-${Date.now()}`, retail_price: 1,
        customer: { name: 'Probe Test', email: 'probe@example.com', number: '9999999999', address1: '1 Test Road', address2: 'Test Area', address3: '', pincode: '248001', state: 'Uttarakhand', city: 'Dehradun', country: 'India' },
        order_products: [{ variant_id: variantId, quantity: 1 }], cod: false,
      },
    });
  }
} else {
  console.log('\n(no order created; pass --create-test-order to POST one)');
}
console.log('\nDone. Paste this output back so the PROBE mappings can be fixed.');
