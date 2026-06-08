// End-to-end DM delivery diagnosis against the live avatok-relay.
// A sends B a NIP-17 gift wrap (kind 1059, ephemeral author, p-tag B).
// Checks: (1) LIVE delivery (B online, cross-DO fan-out), (2) HISTORICAL
// delivery (B reconnects + REQ from D1). Pinpoints where delivery breaks.
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";

const RELAY = "wss://avatok-relay.getmystuffme.workers.dev/";
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));

function newKey() {
  const priv = schnorr.utils.randomPrivateKey();
  return { priv, pub: hex(schnorr.getPublicKey(priv)) };
}
function sign(ev, priv) {
  ev.id = hex(sha256(enc([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content])));
  ev.sig = hex(schnorr.sign(ev.id, priv));
  return ev;
}
const now = () => Math.floor(Date.now() / 1000);

// Connects, performs NIP-42 AUTH, resolves when authed. onEvent(subId, ev) for live.
function connect(key, label, onEvent) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY + "?pubkey=" + key.pub);
    let authed = false, authId = null;
    const t = setTimeout(() => reject(new Error(label + " connect/auth timeout")), 12000);
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d[0] === "AUTH") {
        const ev = sign({ pubkey: key.pub, created_at: now(), kind: 22242,
          tags: [["relay", RELAY], ["challenge", String(d[1])]], content: "" }, key.priv);
        authId = ev.id; ws.send(JSON.stringify(["AUTH", ev]));
      } else if (d[0] === "OK" && d[1] === authId && d[2] === true) {
        authed = true; clearTimeout(t); console.log(`[${label}] authed ✓`); resolve(ws);
      } else if (d[0] === "OK") {
        console.log(`[${label}] OK ${d[1]?.slice(0,8)} accepted=${d[2]} ${d[3]||""}`);
      } else if (d[0] === "EVENT") {
        console.log(`[${label}] <<EVENT sub=${d[1]} kind=${d[2].kind} id=${d[2].id.slice(0,8)}`);
        onEvent && onEvent(d[1], d[2]);
      } else if (d[0] === "EOSE") {
        console.log(`[${label}] EOSE ${d[1]}`);
      }
    };
    ws.onerror = (e) => { clearTimeout(t); reject(new Error(label + " ws error " + (e.message||e))); };
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const A = newKey(), B = newKey(), EPH = newKey();
  console.log("A=", A.pub.slice(0,12), " B=", B.pub.slice(0,12));

  // The gift wrap A→B: kind 1059, authored by ephemeral key, p-tag = B.
  const gift = sign({ pubkey: EPH.pub, created_at: now(),
    kind: 1059, tags: [["p", B.pub]], content: "ciphertext-placeholder" }, EPH.priv);

  let liveDelivered = false;
  // 1) B connects + subscribes to its inbox.
  const bWs = await connect(B, "B", (sub, ev) => { if (ev.id === gift.id) liveDelivered = true; });
  bWs.send(JSON.stringify(["REQ", "inbox", { kinds: [1059], "#p": [B.pub], limit: 50 }]));
  await sleep(1500);

  // 2) A connects + publishes the gift wrap.
  const aWs = await connect(A, "A");
  console.log("[A] publishing gift wrap (kind 1059, p-tag B)…");
  aWs.send(JSON.stringify(["EVENT", gift]));
  await sleep(4000); // wait for cross-DO fan-out to reach B live

  console.log("\n=== LIVE delivery (B online): " + (liveDelivered ? "WORKS ✓" : "FAILED ✗") + " ===");
  aWs.close(); bWs.close();
  await sleep(500);

  // 3) HISTORICAL: B reconnects fresh and REQs — tests D1 persistence + read gate.
  let histDelivered = false;
  const b2 = await connect(B, "B2", (sub, ev) => { if (ev.id === gift.id) histDelivered = true; });
  b2.send(JSON.stringify(["REQ", "hist", { kinds: [1059], "#p": [B.pub], limit: 50 }]));
  await sleep(3000);
  console.log("=== HISTORICAL delivery (B reconnect+REQ): " + (histDelivered ? "WORKS ✓" : "FAILED ✗") + " ===");
  b2.close();

  console.log("\nDIAGNOSIS:");
  if (liveDelivered && histDelivered) console.log("  Relay delivery is HEALTHY end-to-end. Bug is client-side.");
  else if (!liveDelivered && histDelivered) console.log("  LIVE cross-DO fan-out is BROKEN; D1/REQ works → 'messages only after reopen'.");
  else if (!liveDelivered && !histDelivered) console.log("  Neither path delivers → D1 write/read gate or auth issue.");
  process.exit(0);
})().catch((e) => { console.error("TEST ERROR:", e.message); process.exit(1); });
