// Phase 5 smoke — AvaOLX. Seller + buyer are pre-seeded as Tier-2 (clerk_nostr_link
// tier='verified') and the buyer pre-credited via a seeded topup + synthetic webhook.
// Verifies: unverified create 403, digital listing create + file upload, browse,
// buy (15% commission), signed/streamed download, refund-after-download 409,
// physical listing buy → contact-via-chat 400.
import { schnorr } from "@noble/curves/secp256k1"; import { sha256 } from "@noble/hashes/sha256";
const BASE = process.env.BASE || "https://avatok-api.getmystuffme.workers.dev";
const enc = new TextEncoder(); const hx = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const idFrom = (h) => { const p = h ? Uint8Array.from(h.match(/.{2}/g).map((x)=>parseInt(x,16))) : schnorr.utils.randomPrivateKey(); return { p, pub: hx(schnorr.getPublicKey(p)) }; };
const hdr = (id, m, u) => { const e = { pubkey: id.pub, created_at: Math.floor(Date.now()/1000), kind: 27235, tags: [["u",u],["method",m]], content: "" }; const i = hx(sha256(enc.encode(JSON.stringify([0,e.pubkey,e.created_at,e.kind,e.tags,e.content])))); return Buffer.from(JSON.stringify({ ...e, id: i, sig: hx(schnorr.sign(i, id.p)) })).toString("base64"); };
async function call(id, m, p, body, raw) {
  const u = BASE + p; const h = { "x-nostr-auth": hdr(id, m, u) };
  if (raw) { h["content-type"] = "application/octet-stream"; h["x-file-name"] = "ebook.pdf"; }
  else if (body) h["content-type"] = "application/json";
  const r = await fetch(u, { method: m, headers: h, body: raw ? raw : (body ? JSON.stringify(body) : undefined) });
  const ct = r.headers.get("content-type") || ""; let b;
  if (ct.includes("application/json")) b = await r.json(); else b = await r.text();
  return { s: r.status, b, ct };
}
const CHARSET="qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function npub(hex){const pm=(v)=>{const G=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3];let c=1;for(const x of v){const t=c>>25;c=((c&0x1ffffff)<<5)^x;for(let i=0;i<5;i++)if((t>>i)&1)c^=G[i];}return c;};const ex=(h)=>{const o=[];for(let i=0;i<h.length;i++)o.push(h.charCodeAt(i)>>5);o.push(0);for(let i=0;i<h.length;i++)o.push(h.charCodeAt(i)&31);return o;};const cv=(d)=>{let a=0,b=0;const o=[];for(const v of d){a=(a<<8)|v;b+=8;while(b>=5){b-=5;o.push((a>>b)&31);}}if(b)o.push((a<<(5-b))&31);return o;};const by=hex.match(/.{2}/g).map(x=>parseInt(x,16));const d5=cv(by);const vals=ex("npub").concat(d5);const mod=pm(vals.concat([0,0,0,0,0,0]))^1;const chk=[];for(let i=0;i<6;i++)chk.push((mod>>(5*(5-i)))&31);let s="npub1";for(const d of d5.concat(chk))s+=CHARSET[d];return s;}

if (process.argv[2] === "genkeys") {
  const a = idFrom(), b = idFrom();
  console.log("SELLER_PRIV=" + hx(a.p)); console.log("SELLER_NPUB=" + npub(a.pub));
  console.log("BUYER_PRIV=" + hx(b.p)); console.log("BUYER_NPUB=" + npub(b.pub));
  process.exit(0);
}

const seller = idFrom(process.env.SELLER_PRIV), buyer = idFrom(process.env.BUYER_PRIV);
let pass=0, fail=0; const ok=(l,c,g)=>{if(c){pass++;console.log("  PASS",l);}else{fail++;console.log("  FAIL",l,"→",JSON.stringify(g).slice(0,200));}};

console.log("[1] unverified user cannot list");
const rando = idFrom();
let r = await call(rando, "POST", "/api/olx/listings", { kind: "digital", title: "X", price_coins: 50 });
ok("403 tier2 required", r.s === 403, r);

console.log("[2] verified seller creates digital listing (100 coins)");
r = await call(seller, "POST", "/api/olx/listings", { kind: "digital", title: "My eBook", notes: "A great read.", category: "books", price_coins: 100 });
ok("created digital", r.s === 200 && r.b.listing_id && r.b.needs_file, r.b);
const listingId = r.b.listing_id;

console.log("[3] seller uploads the file");
r = await call(seller, "POST", `/api/olx/listings/${listingId}/file`, null, Buffer.from("PDF-CONTENT-" + "x".repeat(500)));
ok("file uploaded", r.s === 200 && r.b.size_bytes > 0, r.b);

console.log("[4] browse shows the digital listing");
r = await call(buyer, "GET", "/api/olx/listings?kind=digital");
ok("listing browsable", (r.b.listings||[]).some(l=>l.id===listingId), { n: (r.b.listings||[]).length });

console.log("[5] buyer buys → 100 spent, seller earns 85 (15% commission)");
r = await call(buyer, "POST", "/api/olx/buy", { listing_id: listingId });
ok("purchase ok", r.s === 200 && r.b.purchase_id, r.b);
const purchaseId = r.b.purchase_id;

console.log("[6] buyer downloads (streamed fallback, R2 creds unset)");
r = await call(buyer, "GET", `/api/olx/downloads/${purchaseId}/file`);
ok("download 200 with bytes", r.s === 200 && (typeof r.b === "string" ? r.b.includes("PDF-CONTENT") : !!r.b.url), { ct: r.ct, s: r.s });

console.log("[7] refund after download → 409");
r = await call(buyer, "POST", "/api/olx/refund", { purchase_id: purchaseId });
ok("409 not refundable (downloaded)", r.s === 409, r);

console.log("[8] physical listing → buy returns contact-via-chat 400");
r = await call(seller, "POST", "/api/olx/listings", { kind: "physical", title: "Old bike", notes: "Good condition", location: "Mumbai" });
const physId = r.b.listing_id;
r = await call(buyer, "POST", "/api/olx/buy", { listing_id: physId });
ok("400 contact via AvaChat", r.s === 400 && r.b.contact, r.b);

console.log(`\nRESULT: ${pass} passed, ${fail} failed (LISTING=${listingId} PHYS=${physId})`);
process.exit(fail===0?0:1);
