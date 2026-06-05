// Phase 3 smoke — AvaCalendar against deployed avatok-api. Host creates a free slot
// ~50min out; attendee books → mirrored events for both; conflicting second booking
// is rejected; both see the event; cancel works and frees the slot.
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
const BASE = process.env.BASE || "https://avatok-api.getmystuffme.workers.dev";
const enc = new TextEncoder();
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const mk = () => { const p = schnorr.utils.randomPrivateKey(); return { p, pub: toHex(schnorr.getPublicKey(p)) }; };
function nip98(id, m, url) {
  const ev = { pubkey: id.pub, created_at: Math.floor(Date.now()/1000), kind: 27235, tags: [["u",url],["method",m.toUpperCase()]], content: "" };
  const eid = toHex(sha256(enc.encode(JSON.stringify([0,ev.pubkey,ev.created_at,ev.kind,ev.tags,ev.content]))));
  return Buffer.from(JSON.stringify({ ...ev, id: eid, sig: toHex(schnorr.sign(eid, id.p)) })).toString("base64");
}
async function call(id, m, path, body) {
  const url = BASE + path; const h = { "x-nostr-auth": nip98(id, m, url) };
  if (body) h["content-type"] = "application/json";
  const r = await fetch(url, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined });
  let b; const t = await r.text(); try { b = JSON.parse(t); } catch { b = t.slice(0,200); }
  return { status: r.status, body: b };
}
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function npub(hex) {
  const pm=(v)=>{const G=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3];let c=1;for(const x of v){const t=c>>25;c=((c&0x1ffffff)<<5)^x;for(let i=0;i<5;i++)if((t>>i)&1)c^=G[i];}return c;};
  const ex=(h)=>{const o=[];for(let i=0;i<h.length;i++)o.push(h.charCodeAt(i)>>5);o.push(0);for(let i=0;i<h.length;i++)o.push(h.charCodeAt(i)&31);return o;};
  const cv=(d)=>{let a=0,b=0;const o=[];for(const v of d){a=(a<<8)|v;b+=8;while(b>=5){b-=5;o.push((a>>b)&31);}}if(b)o.push((a<<(5-b))&31);return o;};
  const bytes=hex.match(/.{2}/g).map((x)=>parseInt(x,16)); const d5=cv(bytes); const vals=ex("npub").concat(d5);
  const mod=pm(vals.concat([0,0,0,0,0,0]))^1; const chk=[];for(let i=0;i<6;i++)chk.push((mod>>(5*(5-i)))&31);
  let s="npub1";for(const d of d5.concat(chk))s+=CHARSET[d];return s;
}
const host = mk(), att = mk();
let pass=0, fail=0; const ok=(l,c,g)=>{if(c){pass++;console.log("  PASS",l);}else{fail++;console.log("  FAIL",l,"→",JSON.stringify(g));}};

const start = Date.now() + 50*60_000, end = start + 30*60_000;
console.log("[1] host creates free slot");
let r = await call(host, "POST", "/api/calendar/slots", { title: "Consult", start_at: start, end_at: end, price_coins: 0, capacity: 1 });
ok("slot created", r.status===200 && r.body.slot_id, r.body); const slotId = r.body.slot_id;

console.log("[2] public list shows the slot");
r = await call(att, "GET", "/api/calendar/slots?host=" + npub(host.pub));
ok("slot listed", r.status===200 && (r.body.slots||[]).some(s=>s.id===slotId), r.body);

console.log("[3] attendee books");
r = await call(att, "POST", "/api/calendar/book", { slot_id: slotId });
ok("booked", r.status===200 && r.body.booking_id, r.body); const bookingId = r.body.booking_id;

console.log("[4] slot now full → second booking 409");
const att2 = mk();
r = await call(att2, "POST", "/api/calendar/book", { slot_id: slotId });
ok("409 slot full", r.status===409, r);

console.log("[5] both parties see the event");
let hr = await call(host, "GET", "/api/calendar/events");
let ar = await call(att, "GET", "/api/calendar/events");
ok("host sees event (role host)", (hr.body.events||[]).some(e=>e.booking_id===bookingId && e.role==="host"), hr.body);
ok("attendee sees event (role attendee)", (ar.body.events||[]).some(e=>e.booking_id===bookingId && e.role==="attendee"), ar.body);

console.log("[6] attendee cancels → frees slot");
r = await call(att, "POST", "/api/calendar/cancel", { booking_id: bookingId });
ok("cancelled", r.status===200 && r.body.cancelled, r.body);
r = await call(att2, "POST", "/api/calendar/book", { slot_id: slotId });
ok("rebook works after cancel", r.status===200 && r.body.booking_id, r.body);

console.log("[7] cannot book own slot");
r = await call(host, "POST", "/api/calendar/book", { slot_id: slotId });
ok("400 own slot", r.status===400 || r.status===409, r);

console.log(`\nRESULT: ${pass} passed, ${fail} failed (SLOT_ID=${slotId})`);
process.exit(fail===0?0:1);
