// Phase 8 smoke — lazy TTS + per-app hook. Builds a real agent conversation, then:
// synthesize (segments>0), re-synthesize (cache hit), stream audio (audio/mpeg),
// non-party blocked, and a per-app task → inbox 'action' item.
import { schnorr } from "@noble/curves/secp256k1"; import { sha256 } from "@noble/hashes/sha256";
const BASE = process.env.BASE || "https://avatok-api.getmystuffme.workers.dev";
const enc = new TextEncoder(); const hx = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const mk = () => { const p = schnorr.utils.randomPrivateKey(); return { p, pub: hx(schnorr.getPublicKey(p)) }; };
const hdr = (id, m, u) => { const e = { pubkey: id.pub, created_at: Math.floor(Date.now()/1000), kind: 27235, tags: [["u",u],["method",m]], content: "" }; const i = hx(sha256(enc.encode(JSON.stringify([0,e.pubkey,e.created_at,e.kind,e.tags,e.content])))); return Buffer.from(JSON.stringify({ ...e, id: i, sig: hx(schnorr.sign(i, id.p)) })).toString("base64"); };
async function call(id, m, p, body, wantRaw) { const u = BASE + p; const h = { "x-nostr-auth": hdr(id, m, u) }; if (body) h["content-type"] = "application/json"; const r = await fetch(u, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined }); const ct = r.headers.get("content-type")||""; if (wantRaw) return { s: r.status, ct, len: (await r.arrayBuffer()).byteLength }; let b; const t = await r.text(); try { b = JSON.parse(t); } catch { b = t.slice(0,150); } return { s: r.status, b, ct }; }
const CHARSET="qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function npub(hex){const pm=(v)=>{const G=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3];let c=1;for(const x of v){const t=c>>25;c=((c&0x1ffffff)<<5)^x;for(let i=0;i<5;i++)if((t>>i)&1)c^=G[i];}return c;};const ex=(h)=>{const o=[];for(let i=0;i<h.length;i++)o.push(h.charCodeAt(i)>>5);o.push(0);for(let i=0;i<h.length;i++)o.push(h.charCodeAt(i)&31);return o;};const cv=(d)=>{let a=0,b=0;const o=[];for(const v of d){a=(a<<8)|v;b+=8;while(b>=5){b-=5;o.push((a>>b)&31);}}if(b)o.push((a<<(5-b))&31);return o;};const by=hex.match(/.{2}/g).map(x=>parseInt(x,16));const d5=cv(by);const vals=ex("npub").concat(d5);const mod=pm(vals.concat([0,0,0,0,0,0]))^1;const chk=[];for(let i=0;i<6;i++)chk.push((mod>>(5*(5-i)))&31);let s="npub1";for(const d of d5.concat(chk))s+=CHARSET[d];return s;}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A = mk(), B = mk(), C = mk(); const Bnpub = npub(B.pub);
let pass=0, fail=0; const ok=(l,c,g)=>{if(c){pass++;console.log("  PASS",l);}else{fail++;console.log("  FAIL",l,"→",JSON.stringify(g).slice(0,180));}};

await call(A, "PUT", "/api/agent/personas/avadate", { persona_prompt: "Climber and chef in Pune, loves jazz and long walks.", looking_for: "A foodie who enjoys live music.", auto_approve: true });
await call(B, "PUT", "/api/agent/personas/avadate", { persona_prompt: "Jazz pianist and amateur cook in Pune.", looking_for: "Someone to share meals and gigs." });
console.log("[1] start conversation + wait for transcript");
let r = await call(A, "POST", "/api/agent/converse", { app: "avadate", peer_npub: Bnpub });
const cid = r.b.conversation_id; let ready = false;
for (let i=0;i<15;i++){ await sleep(3000); const d = await call(A, "GET", "/api/agent/inbox/"+( (await call(A,"GET","/api/agent/inbox")).b.inbox?.find(x=>x.conversation_id===cid)?.id || "x")); if (d.b.conversation && d.b.conversation.status==="concluded" && (d.b.conversation.transcript||[]).length){ ready=true; break;} process.stdout.write("."); }
console.log(""); ok("conversation has transcript", ready, "timeout");

console.log("[2] tts synthesize (real Aura-2, segments>0)");
r = await call(A, "POST", "/api/agent/tts", { conversation_id: cid });
ok("synthesized, not cached", r.s===200 && r.b.ready && r.b.cached===false && r.b.segments>=1, r.b);

console.log("[3] tts again → cache hit");
r = await call(A, "POST", "/api/agent/tts", { conversation_id: cid });
ok("cache hit", r.s===200 && r.b.cached===true, r.b);

console.log("[4] stream audio → audio/mpeg bytes");
r = await call(A, "GET", "/api/agent/audio/"+cid, null, true);
ok("audio/mpeg with bytes", r.s===200 && r.ct.includes("audio/mpeg") && r.len>1000, r);

console.log("[5] peer B can also fetch (shared render)");
r = await call(B, "GET", "/api/agent/audio/"+cid, null, true);
ok("B gets same audio", r.s===200 && r.len>1000, r);

console.log("[6] non-party C blocked");
r = await call(C, "GET", "/api/agent/audio/"+cid);
ok("404 for non-party", r.s===404, r);

console.log("[7] per-app task hook → inbox 'action' item");
await call(A, "POST", "/api/agent/task", { app: "avadate", kind: "find_matches", payload: { hint: "weekend" } });
let action=null; for (let i=0;i<8;i++){ await sleep(2500); const inb = await call(A,"GET","/api/agent/inbox"); action=(inb.b.inbox||[]).find(x=>x.type==="action"); if(action) break; process.stdout.write("."); }
console.log(""); ok("task created inbox action item", !!action, action||"none");

console.log(`\nRESULT: ${pass} passed, ${fail} failed (cid=${cid})`);
process.exit(fail===0?0:1);
