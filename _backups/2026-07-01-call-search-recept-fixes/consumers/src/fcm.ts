// Push consumer — FCM v1 (Android) fully implemented; APNs (iOS) deferred until
// the APNs auth key is provided (project is Android-first). Resolves device
// tokens from D1 push_tokens, builds the payload, delivers. Calls go out as
// high-priority DATA messages so the app can raise a CallStyle / full-screen UI.
import type { Env, PushMsg } from "./types";
import { sendApns } from "./apns";

export async function handlePush(msg: PushMsg, env: Env): Promise<void> {
  if (msg.kind === "fanout") return handleFanout(msg, env);
  const uid = msg.to_uid || msg.to;
  if (!uid) return;
  const rs = await env.DB_META.prepare("SELECT platform, token FROM push_tokens_v2 WHERE uid=?1").bind(uid).all();
  const tokens = (rs.results ?? []) as Array<{ platform: string; token: string }>;
  if (!tokens.length) {
    // SEND-side visibility: a push (call/notify/…) that can't be delivered because
    // the recipient has NO registered device. Previously a silent return — the
    // same blind spot behind the "no device registered" incident, seen from the
    // delivery side. Now queryable per recipient.
    await capturePush(env, "push_no_device", uid, { kind: msg.kind, call_id: msg.callId ?? null });
    return;
  }

  const payload = buildPayload(msg);
  for (const t of tokens) {
    if (t.platform === "apns") await sendApns(env, t.token, payload);
    else await sendFcm(env, t.token, payload, uid); // 'fcm' (Android) — default
  }
}

// Best-effort single-event PostHog capture so push-delivery failures are
// queryable (not just visible in `wrangler tail`). Mirrors captureBatch's
// transport in index.ts; never throws — telemetry must not block delivery.
async function capturePush(env: Env, event: string, uid: string, props: Record<string, unknown>): Promise<void> {
  if (!env.POSTHOG_API_KEY || !env.POSTHOG_HOST) return;
  try {
    await fetch(`${env.POSTHOG_HOST}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: env.POSTHOG_API_KEY,
        event,
        distinct_id: uid || "anonymous",
        properties: { ...props, source: "consumer", service_name: "avatok-consumers", account_id: uid },
        timestamp: new Date().toISOString(),
      }),
    });
  } catch { /* best-effort */ }
}

// Large-group message delivery (router enqueues "fanout" for >25 recipients —
// Scale proposal Phase 1: never loop sync DO calls in the request path). Appends
// the message to each recipient's InboxDO (cross-script binding) and wakes
// offline devices via the proven high-priority notify path. Recipients are
// processed in parallel chunks; a single failed append never poisons the batch.
const FANOUT_PARALLEL = 10;
async function handleFanout(msg: PushMsg, env: Env): Promise<void> {
  if (!env.INBOX || !msg.payload || !Array.isArray(msg.recipients)) return;
  for (let i = 0; i < msg.recipients.length; i += FANOUT_PARALLEL) {
    const chunk = msg.recipients.slice(i, i + FANOUT_PARALLEL);
    await Promise.all(chunk.map(async (uid) => {
      try {
        const stub = env.INBOX!.get(env.INBOX!.idFromName(uid));
        const res = await stub.fetch("https://inbox/append", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...msg.payload, owner: uid }),
        });
        const r = (await res.json()) as { live?: boolean };
        // Forward the sender name + preview the router attached so offline (group)
        // recipients get the WhatsApp-style banner, not a bare "AvaTOK" (regression
        // fixed 2026-06-28 — fanout pushes previously carried no name/preview).
        if (!r.live) await handlePush({
          kind: "notify", to: uid,
          fromName: msg.fromName || "AvaTOK",
          ...(msg.preview ? { preview: msg.preview } : {}),
        }, env);
      } catch (e) {
        console.warn("fanout append failed", uid, String(e));
      }
    }));
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
  if (msg.kind === "group_invite") {
    // "X added you to <group>" — HIGH priority so it wakes the device. The app
    // reads conv + groupName + fromName in its FCM handler to deep-link into the
    // group and show the Accept/Decline prompt.
    return { highPriority: true, data: {
      type: "group_invite", conv: msg.conv ?? "",
      groupName: msg.groupName ?? "", fromName: msg.fromName ?? "AvaTOK",
    } };
  }
  if (msg.kind === "notify") {
    // HIGH priority: a normal-priority data message is batched/deferred by
    // Android Doze, so a sleeping phone only learns of a new message minutes
    // later (the "message arrived after 10 min" symptom). Chat messages must
    // wake the device immediately, exactly like calls.
    return { highPriority: true, data: {
      type: "message", fromName: msg.fromName ?? "AvaTOK",
      // Short preview (when the sender included one) → the app renders an
      // expandable banner so the message reads from the shade without opening.
      ...(msg.preview ? { preview: msg.preview } : {}),
    } };
  }
  if (msg.kind === "del") {
    // Delete-for-everyone: silent (no banner) but HIGH priority so it punches
    // through Doze and the device redacts the message in realtime. The app reads
    // `target` (the message client_id) + `conv` in its FCM handler.
    return { highPriority: true, data: { type: "del", conv: msg.conv ?? "", target: msg.target ?? "" } };
  }
  if (msg.kind === "hide") {
    // Delete-for-me / Undo on another of MY devices: silent HIGH-priority wake so
    // every asleep device hides/un-hides the same message in realtime. hidden=1 →
    // hide, 0 → undo. The app reads conv/target/hidden in its FCM handler.
    return { highPriority: true, data: { type: "hide", conv: msg.conv ?? "", target: msg.target ?? "", hidden: msg.hidden ? "1" : "0" } };
  }
  if (msg.kind === "call_del") {
    // One call-log entry deleted on another of MY devices. Silent + HIGH priority
    // so an asleep device wakes and removes the entry in realtime (the app reads
    // `entry_id`), instead of only on its next manual open.
    return { highPriority: true, data: { type: "call_del", entry_id: msg.entry_id ?? "" } };
  }
  if (msg.kind === "call_clear") {
    // Whole call history cleared on another device → silent HIGH-priority wake so
    // every asleep device empties its log in realtime.
    return { highPriority: true, data: { type: "call_clear" } };
  }
  // relay-event (from the relay's onEventSaved hook). "from" is reserved by FCM.
  const type = msg.event_kind === 25050 ? "call" : "message";
  // Both calls (25050) and DM gift-wraps (1059) are high priority so they punch
  // through Doze and ring/notify the instant they land.
  return { highPriority: true, data: { type, fromPub: msg.from_pubkey ?? "", event_id: msg.event_id ?? "" } };
}

async function sendFcm(env: Env, token: string, payload: { data: Record<string, string>; highPriority: boolean }, uid: string): Promise<void> {
  if (!env.FCM_SERVICE_ACCOUNT) {
    console.warn("FCM_SERVICE_ACCOUNT unset; cannot send");
    await capturePush(env, "push_send_failed", uid, { reason: "no_service_account" });
    return;
  }
  let res: Response;
  try {
    const accessToken = await getAccessToken(env);
    const body = {
      message: {
        token,
        data: payload.data,
        android: { priority: payload.highPriority ? "high" : "normal" },
      },
    };
    res = await fetch(`https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT}/messages:send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // OAuth token-exchange or network failure — e.g. a broken/deleted FCM project
    // or service account. This is the SEND-side equivalent of the client
    // FIS_AUTH_ERROR and was previously console-only. Surface it, then rethrow so
    // the queue still retries.
    await capturePush(env, "push_send_error", uid, { reason: "send_threw", error: String(e).slice(0, 180) });
    throw e;
  }
  if (!res.ok) {
    const txt = await res.text();
    // ONLY prune a token Firebase says is genuinely dead. NOT INVALID_ARGUMENT —
    // that can be a payload/config issue and was wiping perfectly good tokens,
    // leaving devices unable to receive calls ("no registered devices").
    const dead = res.status === 404 || txt.includes("UNREGISTERED") ||
      txt.includes("registration-token-not-registered") || txt.includes("NOT_FOUND");
    if (dead) {
      await env.DB_META.prepare("DELETE FROM push_tokens_v2 WHERE token=?1").bind(token).run();
      console.warn("FCM: pruned dead token", token.slice(0, 12));
      await capturePush(env, "push_token_pruned", uid, { status: res.status });
    } else {
      // Keep the token; surface the error in logs (visible via `wrangler tail`)
      // AND in PostHog so a project/credential/payload break is queryable, not
      // just a log line nobody is tailing.
      console.error("FCM send failed (token KEPT):", res.status, txt.slice(0, 300));
      await capturePush(env, "push_send_failed", uid, { status: res.status, error: txt.slice(0, 180) });
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
