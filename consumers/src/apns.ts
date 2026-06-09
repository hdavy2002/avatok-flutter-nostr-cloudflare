// APNs (iOS push) sender — token-based auth (JWT ES256), HTTP/2 via fetch.
// GATED: if APNS_KEY_ID / APNS_TEAM_ID / APNS_PRIVATE_KEY are not all set, this
// no-ops with a warning (project is Android-first; same pattern as Clerk gating).
// The provider JWT is signed with the .p8 key and cached in KV (~50 min).
import type { Env } from "./types";

export function apnsConfigured(env: Env): boolean {
  return !!(env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_PRIVATE_KEY);
}

export async function sendApns(
  env: Env,
  token: string,
  payload: { data: Record<string, string>; highPriority: boolean },
): Promise<void> {
  if (!apnsConfigured(env)) { console.warn("APNs not configured; skipping iOS token"); return; }

  const jwt = await providerToken(env);
  const host = env.APNS_PRODUCTION === "1" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
  const topic = env.APNS_BUNDLE_ID || "ai.avatok.avatok_call";
  const isCall = payload.data.type === "call";

  // Call → user-visible alert (so iOS can raise CallKit-style UI); other events
  // → silent background wake. Custom keys ride alongside `aps`.
  const body = isCall
    ? { aps: { alert: { title: payload.data.fromName || "AvaTOK", body: "Incoming call" }, sound: "default", "interruption-level": "time-sensitive" }, ...payload.data }
    : { aps: { "content-available": 1 }, ...payload.data };

  const res = await fetch(`${host}/3/device/${token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${jwt}`,
      "apns-topic": topic,
      "apns-push-type": isCall ? "alert" : "background",
      "apns-priority": payload.highPriority ? "10" : "5",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text();
    // 410 Gone / BadDeviceToken → prune stale token.
    if (res.status === 410 || txt.includes("BadDeviceToken") || txt.includes("Unregistered")) {
      await env.DB_META.prepare("DELETE FROM push_tokens_v2 WHERE token=?1").bind(token).run();
    } else {
      throw new Error("APNs send failed: " + res.status + " " + txt.slice(0, 200));
    }
  }
}

async function providerToken(env: Env): Promise<string> {
  const cached = await env.TOKENS.get("apns:provider_token");
  if (cached) return cached;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "ES256", kid: env.APNS_KEY_ID }));
  const claim = b64url(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: now }));
  const input = `${header}.${claim}`;
  const key = await importP8(env.APNS_PRIVATE_KEY!);
  // WebCrypto ECDSA returns the raw r||s (JOSE) signature ES256 expects.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input)));
  const jwt = `${input}.${b64urlBytes(sig)}`;
  // APNs tokens are valid up to 60 min; refresh at ~50.
  await env.TOKENS.put("apns:provider_token", jwt, { expirationTtl: 3000 });
  return jwt;
}

async function importP8(pem: string): Promise<CryptoKey> {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der.buffer, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlBytes(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
