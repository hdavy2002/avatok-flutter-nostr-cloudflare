// Phase 4 smoke — AvaPayout against deployed avatok-api. Production transfers are
// flag-gated OFF (PAYOUT_ENABLED unset), so we verify: account linking stores
// 'pending' (no Wise call), request<min rejected, request≥min returns 503
// pending_legal, status lists, unsigned 401.
import { schnorr } from "@noble/curves/secp256k1"; import { sha256 } from "@noble/hashes/sha256";
const BASE = process.env.BASE || "https://avatok-api.getmystuffme.workers.dev";
const enc = new TextEncoder(); const hx = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const id = (() => { const p = schnorr.utils.randomPrivateKey(); return { p, pub: hx(schnorr.getPublicKey(p)) }; })();
const hdr = (m, u) => { const e = { pubkey: id.pub, created_at: Math.floor(Date.now()/1000), kind: 27235, tags: [["u",u],["method",m]], content: "" }; const i = hx(sha256(enc.encode(JSON.stringify([0,e.pubkey,e.created_at,e.kind,e.tags,e.content])))); return Buffer.from(JSON.stringify({ ...e, id: i, sig: hx(schnorr.sign(i, id.p)) })).toString("base64"); };
const call = async (m, p, b) => { const u = BASE + p; const h = { "x-nostr-auth": hdr(m, u) }; if (b) h["content-type"] = "application/json"; const r = await fetch(u, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined }); let j; const t = await r.text(); try { j = JSON.parse(t); } catch { j = t.slice(0,150); } return { s: r.status, b: j }; };
let pass = 0, fail = 0; const ok = (l, c, g) => { if (c) { pass++; console.log("  PASS", l); } else { fail++; console.log("  FAIL", l, "→", JSON.stringify(g)); } };

console.log("[1] link bank account (pending, no Wise call when flag off)");
let r = await call("POST", "/api/payout/setup", { account_holder: "Test User", ifsc: "HDFC0001234", account_number: "1234567890", label: "HDFC" });
ok("account linked pending", r.s === 200 && r.b.status === "pending" && r.b.payouts_enabled === false, r.b);
const acctId = r.b.account_id;

console.log("[2] accounts list shows it, only last4");
r = await call("GET", "/api/payout/accounts");
ok("listed w/ last4 7890", (r.b.accounts||[]).some(a => a.id===acctId && a.account_number_last4==="7890"), r.b);

console.log("[3] request below minimum → 400");
r = await call("POST", "/api/payout/request", { account_id: acctId, amount_coins: 500 });
ok("400 below min", r.s === 400, r);

console.log("[4] request ≥ min → 503 pending_legal (flag off)");
r = await call("POST", "/api/payout/request", { account_id: acctId, amount_coins: 1000 });
ok("503 pending_legal_approval", r.s === 503 && r.b.reason === "pending_legal_approval", r);

console.log("[5] status lists requests (none funded)");
r = await call("GET", "/api/payout/status");
ok("status ok, payouts_enabled false", r.s === 200 && r.b.payouts_enabled === false, r.b);

console.log("[6] unsigned → 401");
const res = await fetch(BASE + "/api/payout/accounts");
ok("401 unsigned", res.status === 401, res.status);

console.log(`\nRESULT: ${pass} passed, ${fail} failed (ACCT=${acctId})`);
process.exit(fail === 0 ? 0 : 1);
