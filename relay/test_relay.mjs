import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
const hex = (b) => [...b].map(x=>x.toString(16).padStart(2,"0")).join("");
const priv = schnorr.utils.randomPrivateKey();
const pub = hex(schnorr.getPublicKey(priv));
const ev = { pubkey: pub, created_at: Math.floor(Date.now()/1000), kind: 1, tags: [["t","avatoktest"]], content: "hello from relay test" };
const id = hex(sha256(new TextEncoder().encode(JSON.stringify([0,ev.pubkey,ev.created_at,ev.kind,ev.tags,ev.content]))));
ev.id = id; ev.sig = hex(schnorr.sign(id, priv));
const ws = new WebSocket("wss://avatok-relay.getmystuffme.workers.dev/");
let gotOk=false, gotEvent=false, gotEose=false;
ws.onopen = () => { ws.send(JSON.stringify(["EVENT", ev])); };
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  console.log("<<", JSON.stringify(d).slice(0,90));
  if (d[0]==="OK"){ gotOk = d[2]===true; ws.send(JSON.stringify(["REQ","sub1",{kinds:[1],"#t":["avatoktest"],limit:5}])); }
  if (d[0]==="EVENT" && d[2].id===id) gotEvent=true;
  if (d[0]==="EOSE"){ gotEose=true; console.log("RESULT ok="+gotOk+" event="+gotEvent+" eose="+gotEose); ws.close(); process.exit(gotOk&&gotEvent&&gotEose?0:1); }
};
ws.onerror = (e)=>{ console.log("ws error", e.message||e); process.exit(2); };
setTimeout(()=>{ console.log("timeout"); process.exit(3); }, 12000);
