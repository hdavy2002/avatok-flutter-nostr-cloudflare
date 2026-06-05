// Phase 7 smoke — AvaBrain agentic layer. Two users set 'avadate' personas; A's
// agent converses with B's; we poll the inbox for the generated match + summary.
// Also checks persona moderation, isolation list, rate-limit (5/app/day), inbox approve.
import { schnorr } from "@noble/curves/secp256k1"; import { sha256 } from "@noble/hashes/sha256";
const BASE = process.env.BASE || "https://avatok-api.getmystuffme.workers.dev";
const enc = new TextEncoder(); const hx = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const mk = () => { const p = schnorr.utils.randomPrivateKey(); return { p, pub: hx(schnorr.getPublicKey(p)) }; };
const hdr = (id, m, u) => { const e = { pubkey: id.pub, created_at: Math.floor(Date.now()/1000), kind: 27235, tags: [["u",u],["method",m]], content: "" }; const i = hx(sha256(enc.encode(JSON.stringify([0,e.pubkey,e.created_at,e.kind,e.tags,e.content])))); return Buffer.from(JSON.stringify({ ...e, id: i, sig: hx(schnorr.sign(i, id.p)) })).toString("base64"); };
async function call(id, m, p, body) { const u = BASE + p; const h = { "x-nostr-auth": hdr(id, m, u) }; if (body) h["content-type"] = "application/json"; const r = await fetch(u, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined }); let b; const t = await r.text(); try { b = JSON.parse(t); } catch { b = t.slice(0,150); } return { s: r.status, b }; }
const CHARSET="qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function npub(hex){const pm=(v)=>{const G=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3];let c=1;for(const x of v){const t=c>>25;c=((c&0x1ffffff)<<5)^x;for(let i=0;i<5;i++)if((t>>i)&1)c^=G[i];}return c;};const ex=(h)=>{const o=[];for(let i=0;i<h.length;i++)o.push(h.charCodeAt(i)>>5);o.push(0);for(let i=0;i<h.length;i++)o.push(h.charCodeAt(i)&31);return o;};const cv=(d)=>{let a=0,b=0;const o=[];for(const v of d){a=(a<<8)|v;b+=8;while(b>=5){b-=5;o.push((a>>b)&31);}}if(b)o.push((a<<(5-b))&31);return o;};const by=hex.match(/.{2}/g).map(x=>parseInt(x,16));const d5=cv(by);const vals=ex("npub").concat(d5);const mod=pm(vals.concat([0,0,0,0,0,0]))^1;const chk=[];for(let i=0;i<6;i++)chk.push((mod>>(5*(5-i)))&31);let s="npub1";for(const d of d5.concat(chk))s+=CHARSET[d];return s;}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A = mk(), B = mk(); const Bnpub = npub(B.pub), Anpub = npub(A.pub);
let pass=0, fail=0; const ok=(l,c,g)=>{if(c){pass++;console.log("  PASS",l);}else{fail++;console.log("  FAIL",l,"→",JSON.stringify(g).slice(0,200));}};

console.log("[1] A sets avadate persona (auto_approve on) → moderation safe");
let r = await call(A, "PUT", "/api/agent/personas/avadate", { persona_prompt: "I'm a hiker and software engineer in Bangalore who loves trekking and chai.", looking_for: "Someone who enjoys the outdoors and weekend treks.", boundaries: "Be respectful.", auto_approve: true });
ok("A persona safe", r.s === 200 && r.b.moderation === "safe", r.b);

console.log("[2] B sets avadate persona");
r = await call(B, "PUT", "/api/agent/personas/avadate", { persona_prompt: "I'm a photographer in Bangalore who loves mountains and tea.", looking_for: "An adventurous partner for trekking.", boundaries: "Be kind." });
ok("B persona safe", r.s === 200 && r.b.moderation === "safe", r.b);

console.log("[3] persona isolation: A lists only A's personas");
r = await call(A, "GET", "/api/agent/personas");
ok("A sees 1 persona (avadate)", (r.b.personas||[]).length === 1 && r.b.personas[0].app_name === "avadate", r.b);

console.log("[4] converse with no persona app → 400");
r = await call(A, "POST", "/api/agent/converse", { app: "avalinked", peer_npub: Bnpub });
ok("400 needs persona", r.s === 400, r);

console.log("[5] A's agent converses with B");
r = await call(A, "POST", "/api/agent/converse", { app: "avadate", peer_npub: Bnpub });
ok("conversation started", r.s === 200 && r.b.conversation_id, r.b);
const cid = r.b.conversation_id;

console.log("[6] poll A inbox for the generated match (real Gemma turns, up to 45s)");
let item = null;
for (let i = 0; i < 15; i++) {
  await sleep(3000);
  const inb = await call(A, "GET", "/api/agent/inbox");
  item = (inb.b.inbox || []).find((x) => x.conversation_id === cid);
  if (item) break;
  process.stdout.write(".");
}
console.log("");
ok("inbox match item generated", !!item, item || "none after 45s");
if (item) {
  ok("auto_approve → status auto_approved + undo window", item.status === "auto_approved" && item.undo_until > Date.now(), item);
  const det = await call(A, "GET", "/api/agent/inbox/" + item.id);
  ok("transcript present + concluded", det.b.conversation && det.b.conversation.status === "concluded" && (det.b.conversation.transcript||[]).length >= 1, { status: det.b.conversation?.status, turns: (det.b.conversation?.transcript||[]).length });
}

console.log("[7] rate-limit: 5 conversations/app/day → 6th total returns 429");
let got429 = false;
for (let i = 0; i < 6; i++) { const rr = await call(A, "POST", "/api/agent/converse", { app: "avadate", peer_npub: Bnpub }); if (rr.s === 429) { got429 = true; break; } }
ok("rate limit (5/app/day) trips 429", got429, "no 429");

console.log("[8] inbox approve");
if (item) { r = await call(A, "POST", "/api/agent/approve", { id: item.id, action: "undo" }); ok("undo within window works", r.s === 200 && r.b.status === "undone", r.b); }

console.log(`\nRESULT: ${pass} passed, ${fail} failed  (A=${Anpub.slice(0,16)} cid=${cid})`);
process.exit(fail === 0 ? 0 : 1);
