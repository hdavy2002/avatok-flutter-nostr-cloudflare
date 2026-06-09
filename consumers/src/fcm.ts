// Push consumer — FCM v1 (Android) fully implemented; APNs (iOS) deferred until
// the APNs auth key is provided (project is Android-first). Resolves device
// tokens from D1 push_tokens, builds the payload, delivers. Calls go out as
// high-priority DATA messages so the app can raise a CallStyle / full-screen UI.
import type { Env, PushMsg } from "./types";
import { sendApns } from "./apns";

export async function handlePush(msg: PushMsg, env: Env): Promise<void> {
  const npub = msg.to_npub || msg.to;
  if (!npub) return;
  const rs = await env.DB_META.prepare("SELECT platform, token FROM push_tokens WHERE npub=?1").bind(npub).all();
  const tokens = (rs.results ?? []) as Array<{ platform: string; token: string }>;
  if (!tokens.length) return; // recipient has no registered device — nothing to do

  const payload = buildPayload(msg);
  for (const t of tokens) {
    if (t.platform === "apns") await sendApns(env, t.token, payload);
    else await sendFcm(env, t.token, payload); // 'fcm' (Android) — default
  }
}

// Field names match what the Flutter app reads in its FCM handler (push_service):
// type, callId, from, fromName, kind.
function buildPayload(msg: PushMsg): { data: Record<string, string>; highPriority: boolean } {
  if (msg.kind === "call") {
    // NOTE: "from" is a RESERVED key in FCM data payloads — including it makes
    // Firebase reject the whole message (400 INVALID_ARGUMENT "Invalid data
    // payload key: from"), so calls never ring. Use "fromPub" instead.
    return { highPriority: true, data: {
      type: "call", callId: msg.callId ?? "", fromPub: msg.from ?? "",
      fromName: msg.fromName ?? "AvaTOK", kind: msg.callType ?? "audio",
    } };
  }
  if (msg.kind === "call-status") {
    return { highPriority: true, data: { type: "call-status", callId: msg.callId ?? "", status: msg.status ?? "" } };
  }
  if (msg.kind === "notify") {
    return { highPriority: false, data: { type: "message", fromName: msg.fromName ?? "AvaTOK" } };
  }
  // relay-event (from the relay's onEventSaved hook). "from" is reserved by FCM.
  const type = msg.event_kind === 25050 ? "call" : "message";
  return { highPriority: msg.event_kind === 25050, data: { type, fromPub: msg.from_pubkey ?? "", event_id: msg.event_id ?? "" } };
}

async function sendFcm(env: Env, token: string, payload: { data: Record<string, string>; highPriority: boolean }): Promise<void> {
  if (!env.FCM_SERVICE_ACCOUNT) { console.warn("FCM_SERVICE_ACCOUNT unset; cannot send"); return; }
  const accessToken = await getAccessToken(env);
  const body = {
    message: {
      token,
      data: payload.data,
      android: { priority: payload.highPriority ? "high" : "normal" },
    },
  };
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    // ONLY prune a token Firebase says is genuinely dead. NOT INVALID_ARGUMENT —
    // that can be a payload/config issue and was wiping perfectly good tokens,
    // leaving devices unable to receive calls ("no registered devices").
    const dead = res.status === 404 || txt.includes("UNREGISTERED") ||
      txt.includes("registration-token-not-registered") || txt.includes("NOT_FOUND");
    if (dead) {
      await env.DB_META.prepare("DELETE FROM push_tokens WHERE token=?1").bind(token).run();
      console.warn("FCM: pruned dead token", token.slice(0, 12));
    } else {
      // Keep the token; surface the error in logs (visible via `wrangler tail`).
      console.error("FCM send failed (token KEPT):", res.status, txt.slice(0, 300));
    }
  }
}

// --- OAuth: service-account JWT → access token (cached in KV ~55 min) ---
async function getAccessToken(env: Env): Promise<string> {
  const cached = await env.TOKENS.get("fcm:access_token");
  if (cached) return cached;
  const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT!);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: sa.token_uri, iat: now, exp: now + 3600,
  }));
  const input = `${header}.${claim}`;
  const key = await importPkcs8(sa.private_key);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input)));
  const jwt = `${input}.${b64urlBytes(sig)}`;
  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error("FCM token exchange failed: " + res.status);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  await env.TOKENS.put("fcm:access_token", data.access_token, { expirationTtl: Math.max(60, (data.expires_in ?? 3600) - 300) });
  return data.access_token;
}

async function importPkcs8(pem: string): Promise<CryptoKey> {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlBytes(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
