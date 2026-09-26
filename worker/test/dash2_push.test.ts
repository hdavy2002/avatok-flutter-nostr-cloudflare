// [DASH2-PUSH 2026-09-26] Web Push crypto (RFC 8291 / RFC 8292) and reminder window/dedup rules.
import { describe, it, expect } from "vitest";
import {
  encryptPayload, vapidJwt, b64urlDecode, b64urlEncode, importEcPrivateKey, validSubscriptionKeys,
  reminderDecisions, reminderPayload, refundPayload, rupees, pushAllowed, runPushReminders, claimPush,
  sendPushToUser, T15_MS, type ReminderRow,
} from "../src/lib/web_push";
import { validEndpoint } from "../src/routes/me_push";

// RFC 8291 Appendix A.
const V = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  message: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

describe("aes128gcm payload encryption (RFC 8291)", () => {
  it("matches the RFC 8291 Appendix A test vector byte for byte", async () => {
    const out = await encryptPayload(new TextEncoder().encode(V.plaintext), V.uaPublic, V.auth, {
      asPrivate: V.asPrivate, asPublic: V.asPublic, salt: b64urlDecode(V.salt),
    });
    expect(b64urlEncode(out)).toBe(V.message);
  });

  it("random-key output decrypts with the browser's private key", async () => {
    const msg = '{"title":"🪔 test","body":"x"}';
    const out = await encryptPayload(new TextEncoder().encode(msg), V.uaPublic, V.auth);
    // Parse the RFC 8188 header, redo the receiver-side derivation, decrypt.
    const salt = out.slice(0, 16);
    const rs = new DataView(out.buffer, out.byteOffset).getUint32(16);
    const idlen = out[20];
    const asPublic = out.slice(21, 21 + idlen);
    expect(rs).toBe(4096); expect(idlen).toBe(65);
    const uaPriv = await importEcPrivateKey(V.uaPrivate, b64urlDecode(V.uaPublic), "deriveBits");
    const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as never, uaPriv, 256));
    const hk = async (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) => {
      const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
      return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info }, k, n * 8));
    };
    const enc = (s: string) => new TextEncoder().encode(s);
    const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
    const ikm = await hk(b64urlDecode(V.auth), ecdh, cat(enc("WebPush: info\0"), b64urlDecode(V.uaPublic), asPublic), 32);
    const cek = await hk(salt, ikm, enc("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hk(salt, ikm, enc("Content-Encoding: nonce\0"), 12);
    const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, out.slice(21 + idlen)));
    expect(pt[pt.length - 1]).toBe(2);
    expect(new TextDecoder().decode(pt.slice(0, -1))).toBe(msg);
  });

  it("validates subscription keys", () => {
    expect(validSubscriptionKeys(V.uaPublic, V.auth)).toBe(true);
    expect(validSubscriptionKeys(V.uaPublic.slice(0, 40), V.auth)).toBe(false);
    expect(validSubscriptionKeys(V.uaPublic, "AAAA")).toBe(false);
    expect(validSubscriptionKeys(null, V.auth)).toBe(false);
  });
});

describe("VAPID JWT (RFC 8292)", () => {
  it("is an ES256 JWT with aud = push origin, exp <= 24h, sub, and a verifiable signature", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer);
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey;
    const keys = { publicKey: b64urlEncode(pub), privateKey: jwk.d!, subject: "mailto:support@saathum.com" };
    const now = 1_790_000_000;
    const jwt = await vapidJwt("https://fcm.googleapis.com/fcm/send/abc123", keys, now);
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(h)))).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(c)));
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.sub).toBe("mailto:support@saathum.com");
    expect(claims.exp).toBeGreaterThan(now);
    expect(claims.exp - now).toBeLessThanOrEqual(24 * 3600);
    const sig = b64urlDecode(s);
    expect(sig.length).toBe(64);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, sig, new TextEncoder().encode(`${h}.${c}`));
    expect(ok).toBe(true);
  });

  it("accepts a PKCS8 private key too", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer);
    const pk8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey) as ArrayBuffer);
    const jwt = await vapidJwt("https://updates.push.services.mozilla.com/wpush/v2/x", { publicKey: b64urlEncode(pub), privateKey: b64urlEncode(pk8), subject: "mailto:a@b.c" });
    expect(jwt.split(".")).toHaveLength(3);
  });
});

const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);
const row = (startOffsetMs: number, over: Partial<ReminderRow> = {}): ReminderRow => ({
  listing_id: "L1", uid: "u1", title: "Ganesh Havan", kind: "live_event", status: "published",
  starts_at: NOW + startOffsetMs, duration_min: 60, ...over,
});

describe("reminder window rules", () => {
  it("T-15: fires once start is within 15 min, not before", () => {
    expect(reminderDecisions([row(16 * 60_000)], NOW)).toEqual([]);
    expect(reminderDecisions([row(15 * 60_000)], NOW)).toEqual([{ listing_id: "L1", uid: "u1", title: "Ganesh Havan", kind: "t15" }]);
    expect(reminderDecisions([row(60_000)], NOW)[0].kind).toBe("t15");
  });
  it("go-live: start reached, or listing_schedule says live (even early)", () => {
    expect(reminderDecisions([row(0)], NOW)[0].kind).toBe("live");
    expect(reminderDecisions([row(-5 * 60_000)], NOW)[0].kind).toBe("live");
    expect(reminderDecisions([row(10 * 60_000, { status: "live" })], NOW)[0].kind).toBe("live");
  });
  it("only looks at the next 20 min / last 10 min", () => {
    expect(reminderDecisions([row(21 * 60_000)], NOW)).toEqual([]);
    expect(reminderDecisions([row(-11 * 60_000)], NOW)).toEqual([]);
    expect(reminderDecisions([row(-11 * 60_000, { status: "live" })], NOW)).toEqual([]);
  });
  it("skips cancelled/ended rows and seconds-epoch rows are normalised", () => {
    expect(reminderDecisions([row(5 * 60_000, { status: "cancelled" })], NOW)).toEqual([]);
    expect(reminderDecisions([row(0, { status: "completed" })], NOW)).toEqual([]);
    expect(reminderDecisions([row(0, { starts_at: Math.floor((NOW + 10 * 60_000) / 1000) })], NOW)[0].kind).toBe("t15");
  });
  it("T15_MS is 15 minutes", () => expect(T15_MS).toBe(900_000));
});

describe("copy and preferences", () => {
  it("payload copy", () => {
    expect(reminderPayload("t15", "L1", "Ganesh Havan")).toMatchObject({ title: "🪔 Your havan starts in 15 minutes — Ganesh Havan", url: "/dashboard/my-events", tag: "t15-L1" });
    expect(reminderPayload("live", "L1", "Ganesh Havan")).toMatchObject({ title: "Ganesh Havan is live now — join", url: "/dashboard/my-events" });
    expect(refundPayload("p1", 110000)).toMatchObject({ title: "Your refund of ₹1,100 has been sent", url: "/dashboard/billing" });
    expect(rupees(12550)).toBe("₹125.50");
  });
  it("notify.push=false opts out; missing prefs do not", () => {
    expect(pushAllowed(JSON.stringify({ push: false }))).toBe(false);
    expect(pushAllowed(JSON.stringify({ push: true }))).toBe(true);
    expect(pushAllowed(null)).toBe(true);
  });
  it("endpoint validation", () => {
    expect(validEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(validEndpoint("http://example.com/x")).toBe(false);
    expect(validEndpoint("javascript:alert(1)")).toBe(false);
  });
});

// Minimal in-memory D1 for the dedup path.
function fakeDb(reminderRows: ReminderRow[]) {
  const sent = new Set<string>();
  const calls: string[] = [];
  const stmt = (sql: string) => {
    let args: unknown[] = [];
    const s = {
      bind: (...a: unknown[]) => { args = a; return s; },
      run: async () => {
        calls.push(sql);
        if (sql.includes("INSERT OR IGNORE INTO push_sent")) {
          const k = `${args[0]}|${args[1]}|${args[2]}`;
          if (sent.has(k)) return { meta: { changes: 0 } };
          sent.add(k); return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
      all: async () => ({ results: sql.includes("FROM listings l JOIN orders o") ? reminderRows : [] }),
      first: async () => null,
    };
    return s;
  };
  return { db: { prepare: stmt } as unknown as D1Database, sent, calls };
}

describe("dedup (push_sent)", () => {
  it("claims each (listing, uid, kind) once", async () => {
    const { db } = fakeDb([]);
    const env = { DB_META: db } as never;
    expect(await claimPush(env, "L1", "u1", "t15", NOW)).toBe(true);
    expect(await claimPush(env, "L1", "u1", "t15", NOW)).toBe(false);
    expect(await claimPush(env, "L1", "u1", "live", NOW)).toBe(true);
  });
  it("a cron run claims due reminders once across ticks; no keys = no-op that burns nothing", async () => {
    const f = fakeDb([row(10 * 60_000), row(10 * 60_000, { uid: "u2" })]);
    const noKeys = await runPushReminders({ DB_META: f.db } as never, NOW);
    expect(noKeys).toEqual({ scanned: 0, sent: 0 });
    expect(f.sent.size).toBe(0);
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]) as CryptoKeyPair;
    const pub = b64urlEncode(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer);
    const d = (await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey).d!;
    const env = { DB_META: f.db, VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: d, VAPID_SUBJECT: "mailto:support@saathum.com" } as never;
    const r1 = await runPushReminders(env, NOW);
    expect(r1.scanned).toBe(2);
    expect([...f.sent].sort()).toEqual(["L1|u1|t15", "L1|u2|t15"]);
    await runPushReminders(env, NOW + 5 * 60_000);
    expect(f.sent.size).toBe(2); // still T-5: same kind, deduped
    await runPushReminders(env, NOW + 10 * 60_000);
    expect([...f.sent].sort()).toEqual(["L1|u1|live", "L1|u1|t15", "L1|u2|live", "L1|u2|t15"]);
  });
  it("sendPushToUser without keys is a silent no-op", async () => {
    const r = await sendPushToUser({ DB_META: fakeDb([]).db } as never, "u1", reminderPayload("live", "L1", "x"));
    expect(r.skipped).toBe("no_keys");
  });
});
