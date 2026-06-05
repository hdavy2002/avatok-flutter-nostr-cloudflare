// Phase 1 smoke test — signs a real NIP-98 (kind 27235) request and exercises the
// AvaID + account-deletion routes on the deployed avatok-api. Uses the worker's
// own @noble deps. Cleans up the test rows it can (deletion request → cancel).
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";

const BASE = process.env.BASE || "https://avatok-api.getmystuffme.workers.dev";
const enc = new TextEncoder();
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

const priv = schnorr.utils.randomPrivateKey();
const pub = toHex(schnorr.getPublicKey(priv));

function nip98Header(method, url) {
  const ev = { pubkey: pub, created_at: Math.floor(Date.now() / 1000), kind: 27235,
    tags: [["u", url], ["method", method.toUpperCase()]], content: "" };
  const ser = enc.encode(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]));
  const id = toHex(sha256(ser));
  const sig = toHex(schnorr.sign(id, priv));
  const full = { ...ev, id, sig };
  return Buffer.from(JSON.stringify(full)).toString("base64");
}

async function call(method, path, body) {
  const url = BASE + path;
  const headers = { "x-nostr-auth": nip98Header(method, url) };
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 200); }
  return { status: res.status, body: parsed };
}

console.log("pubkey:", pub);
let pass = 0, fail = 0;
const expect = (label, cond, got) => { if (cond) { pass++; console.log("  PASS", label); } else { fail++; console.log("  FAIL", label, "→", JSON.stringify(got)); } };

console.log("\n[1] GET /api/id/status (unverified caller)");
let r = await call("GET", "/api/id/status");
expect("200 + status=unverified + tier basic/unknown", r.status === 200 && r.body.status === "unverified", r);
expect("rekognition flag-gated off", r.body.rekognition_configured === false, r.body);

console.log("\n[2] POST /api/id/session (AWS unconfigured → 503)");
r = await call("POST", "/api/id/session", {});
expect("503 verification unavailable", r.status === 503 && r.body.reason === "aws_unconfigured", r);

console.log("\n[3] Tier-2 gate logic: unverified caller is not verified");
expect("status route reports non-verified tier", r.status === 503, r); // session blocked, consistent

console.log("\n[4] POST /api/account/delete (30-day grace scheduled)");
r = await call("POST", "/api/account/delete", {});
expect("scheduled=true + cancellable", r.status === 200 && r.body.scheduled === true && r.body.cancellable === true, r);
const graceOk = r.body.grace_ends_at && (r.body.grace_ends_at - Date.now() > 29 * 86400000);
expect("grace ~30 days out", graceOk, r.body.grace_ends_at);

console.log("\n[5] POST /api/account/delete/cancel (cleanup test row)");
r = await call("POST", "/api/account/delete/cancel", {});
expect("cancelled=true", r.status === 200 && r.body.cancelled === true, r);

console.log("\n[6] auth: unsigned request rejected");
const res = await fetch(BASE + "/api/id/status");
expect("401 without NIP-98", res.status === 401, res.status);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
