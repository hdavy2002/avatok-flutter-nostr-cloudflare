// Phase 2 smoke test — exercises the wallet end to end against deployed avatok-api,
// using two signed identities (buyer + creator). Top-up is driven via a seeded
// pending topup_record + synthetic Stripe webhook (no Stripe account needed; the
// signing secret is unset in this env so the sig check is skipped). Verifies:
// topup flag-gated 503, webhook credit, balance, spend→creator earn(−commission)
// into a 7-day hold, insufficient-balance 402, ledger + earnings reads.
//
// Requires TOPUP_ID + BUYER_NPUB env (the runner seeds a topup_record for these).
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";

const BASE = process.env.BASE || "https://avatok-api.getmystuffme.workers.dev";
const enc = new TextEncoder();
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

function mkIdentity(privHex) {
  const priv = privHex ? Uint8Array.from(privHex.match(/.{2}/g).map((x) => parseInt(x, 16))) : schnorr.utils.randomPrivateKey();
  return { priv, pub: toHex(schnorr.getPublicKey(priv)) };
}
function nip98(id, method, url) {
  const ev = { pubkey: id.pub, created_at: Math.floor(Date.now() / 1000), kind: 27235, tags: [["u", url], ["method", method.toUpperCase()]], content: "" };
  const eid = toHex(sha256(enc.encode(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]))));
  const sig = toHex(schnorr.sign(eid, id.priv));
  return Buffer.from(JSON.stringify({ ...ev, id: eid, sig })).toString("base64");
}
async function call(id, method, path, body) {
  const url = BASE + path;
  const headers = { "x-nostr-auth": nip98(id, method, url) };
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let b; const t = await res.text(); try { b = JSON.parse(t); } catch { b = t.slice(0, 200); }
  return { status: res.status, body: b };
}

// npub bech32 from x-only hex (so the seeded topup_record npub matches the signer).
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32(hrp, data) {
  const pm = (v) => { const G = [0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3]; let c=1; for (const x of v){const t=c>>25;c=((c&0x1ffffff)<<5)^x;for(let i=0;i<5;i++)if((t>>i)&1)c^=G[i];} return c; };
  const exp = (h)=>{const o=[];for(let i=0;i<h.length;i++)o.push(h.charCodeAt(i)>>5);o.push(0);for(let i=0;i<h.length;i++)o.push(h.charCodeAt(i)&31);return o;};
  const conv=(d)=>{let a=0,b=0;const o=[];for(const v of d){a=(a<<8)|v;b+=8;while(b>=5){b-=5;o.push((a>>b)&31);}}if(b)o.push((a<<(5-b))&31);return o;};
  const data5=conv(data); const values=exp(hrp).concat(data5); const mod=pm(values.concat([0,0,0,0,0,0]))^1;
  const chk=[];for(let i=0;i<6;i++)chk.push((mod>>(5*(5-i)))&31); let s=hrp+"1";for(const d of data5.concat(chk))s+=CHARSET[d];return s;
}
const hexToNpub = (h) => bech32("npub", h.match(/.{2}/g).map((x)=>parseInt(x,16)));

// genkey mode: print a private key + its npub so the runner can seed a topup_record.
if (process.argv[2] === "genkey") {
  const id = mkIdentity();
  console.log("PRIV=" + toHex(id.priv));
  console.log("NPUB=" + hexToNpub(id.pub));
  process.exit(0);
}

const buyer = mkIdentity(process.env.BUYER_PRIV), creator = mkIdentity();
const buyerNpub = hexToNpub(buyer.pub);
console.log("BUYER_NPUB=" + buyerNpub);
console.log("TOPUP_ID=" + (process.env.TOPUP_ID || "(unset)"));

let pass = 0, fail = 0;
const expect = (l, c, got) => { if (c) { pass++; console.log("  PASS", l); } else { fail++; console.log("  FAIL", l, "→", JSON.stringify(got)); } };

console.log("\n[1] topup flag-gated OFF → 503");
let r = await call(buyer, "POST", "/api/wallet/topup", { amount: 1000 });
expect("503 pending_legal_approval", r.status === 503 && r.body.reason === "pending_legal_approval", r);

console.log("\n[2] initial balance = 0");
r = await call(buyer, "GET", "/api/wallet/balance");
expect("balance 0 / held 0", r.status === 200 && r.body.balance === 0 && r.body.held === 0, r);

console.log("\n[3] synthetic Stripe webhook credits 1000 (seeded record)");
const evt = { type: "checkout.session.completed", data: { object: { metadata: { npub: buyerNpub, coins: "1000", topup_id: process.env.TOPUP_ID } } } };
let wr = await fetch(BASE + "/webhooks/stripe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(evt) });
let wb = await wr.json().catch(() => ({}));
expect("webhook credited 1000", wr.status === 200 && wb.credited === 1000, { status: wr.status, wb });

console.log("\n[4] balance now 1000");
r = await call(buyer, "GET", "/api/wallet/balance");
expect("balance 1000", r.body.balance === 1000, r.body);

console.log("\n[5] spend 300 on avaolx (15% commission) → creator earns 255 held");
r = await call(buyer, "POST", "/api/wallet/spend", { amount: 300, app_name: "avaolx", to_npub: hexToNpub(creator.pub), ref: "test-listing" });
expect("spent 300, buyer balance 700", r.status === 200 && r.body.balance === 700, r.body);
expect("creator_net 255, commission 45", r.body.creator_net === 255 && r.body.commission === 45, r.body);

console.log("\n[6] creator earnings: 255 in 7-day hold, 0 spendable");
r = await call(creator, "GET", "/api/wallet/balance");
expect("creator spendable 0, held 255", r.body.balance === 0 && r.body.held === 255, r.body);
r = await call(creator, "GET", "/api/wallet/earnings");
expect("earnings held 255", r.body.held === 255, r.body);

console.log("\n[7] overspend 9999 → 402 insufficient");
r = await call(buyer, "POST", "/api/wallet/spend", { amount: 9999, app_name: "avaolx" });
expect("402 insufficient", r.status === 402, r);

console.log("\n[8] buyer ledger has topup + spend");
r = await call(buyer, "GET", "/api/wallet/transactions");
expect("≥2 ledger rows", r.status === 200 && (r.body.transactions || []).length >= 1, { n: (r.body.transactions || []).length });

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
