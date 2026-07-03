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
    // P1: a call to a device-less callee can never ring — tell the caller so the
    // Ava takeover fires immediately instead of waiting out the ring window.
    if (msg.kind === "call" && msg.callId) {
      await capturePush(env, "call_push_sent", uid, {
        stage: "fcm_send", call_id: msg.callId, to_uid: uid,
        fcm_message_id: null, ok: false, error: "no_device", devices: 0,
      });
      await relayRingAck(env, msg.callId, false);
    }
    return;
  }

  const payload = buildPayload(msg);
  // DEMO KILL-SWITCH (owner request 2026-07-01, demo): when DEMO_MUTE_NONCALL_PUSH="1",
  // suppress EVERY push except incoming calls + call-status, so a live demo isn't
  // interrupted by message / voicemail / reminder banners or silent sync wakes. We
  // gate on the OUTGOING payload type (not msg.kind) so a call delivered via the
  // relay path — kind:"relay-event", event_kind 25050 → type:"call" — still rings.
  // Reversible: set the var to "0" (or delete it) in consumers/wrangler.toml and
  // redeploy avatok-consumers to restore all notifications.
  if ((env as any).DEMO_MUTE_NONCALL_PUSH === "1" &&
      payload.data.type !== "call" && payload.data.type !== "call-status") {
    await capturePush(env, "push_muted_demo", uid, { kind: msg.kind, type: payload.data.type });
    return;
  }
  // P1 (Phase 1): for INCOMING CALLS, instrument the true FCM hand-off and relay the
  // outcome to the caller's CallRoom so a push-confirmation gate is possible. The
  // enqueue-time `call_push_sent` (api.ts) can't know fcm_message_id/ok/error — only
  // here, at the actual messages:send, can we. We aggregate across the callee's
  // devices: the push "succeeded" if ANY device accepted it.
  const isCall = payload.data.type === "call";
  const callId = payload.data.callId || msg.callId || "";
  // [MULTIACCT-1] Prune-and-retry fan-out. sendFcm() already DELETEs a token the
  // instant FCM says it's dead (UNREGISTERED/404/NOT_FOUND); here we COUNT those
  // prunes so we can distinguish "every device the callee had was stale" from a
  // transient send error. This is the silent-fan-out bug (2026-07-03): the callee
  // re-logged-in, the server held ONE stale token, tokenCount>0 so api.ts enqueued
  // (and never emitted push_no_device), the token failed UNREGISTERED and was
  // pruned — but NOTHING told the caller the ring never landed. We now always emit
  // push_fanout_result, and if the entire token set turns out dead we emit
  // push_no_device (the same signal a zero-token callee would produce), so the
  // ring-ack tells the caller "unreachable" instead of ringing into the void.
  const tokensTried = tokens.length;
  let anyOk = false, firstMsgId = "", lastErr = "", delivered = 0, pruned = 0;
  for (const t of tokens) {
    if (t.platform === "apns") { await sendApns(env, t.token, payload); continue; }
    const r = await sendFcm(env, t.token, payload, uid); // 'fcm' (Android) — default
    if (r.ok) { anyOk = true; delivered++; if (!firstMsgId && r.messageId) firstMsgId = r.messageId; }
    else {
      if (r.error) lastErr = r.error;
      if (r.pruned) pruned++;
    }
  }
  // [MULTIACCT-1] Universal per-attempt fan-out result — always emitted (call or
  // not) so reachability is queryable per recipient. `email` is resolved by
  // PostHog from distinct_id=uid (raw email is never stored server-side; only
  // email_hash), and account_id=uid is attached by capturePush().
  await capturePush(env, "push_fanout_result", uid, {
    kind: msg.kind, call_id: callId || null, to_uid: uid,
    tokens_tried: tokensTried, delivered, pruned,
    ok: anyOk, error: anyOk ? null : (lastErr || "no_delivery"),
  });
  // [MULTIACCT-1] If we entered with tokens but NONE delivered AND every failure
  // was a prune (all tokens were dead — the stale-token-after-relogin case), this
  // callee is effectively device-less right now. Emit push_no_device so it looks
  // identical to the zero-token path and downstream reachability queries catch it.
  if (delivered === 0 && tokensTried > 0 && pruned === tokensTried) {
    await capturePush(env, "push_no_device", uid, {
      kind: msg.kind, call_id: callId || null, reason: "all_tokens_pruned", pruned,
    });
  }
  if (isCall) {
    // The real FCM-hand-off event (stage:'fcm_send' distinguishes it from the
    // enqueue-time event of the same name in api.ts). Includes failures.
    await capturePush(env, "call_push_sent", uid, {
      stage: "fcm_send", call_id: callId, to_uid: uid,
      fcm_message_id: firstMsgId || null, ok: anyOk,
      error: anyOk ? null : (lastErr || "no_delivery"),
      devices: tokensTried, delivered, pruned,
    });
    // receptTakeoverGuard: tell the caller (the only peer in the room during ring)
    // whether the callee's phone could ring. Best-effort; never blocks delivery.
    // anyOk===false now correctly covers the all-pruned case → caller sees the
    // ring never landed and shows "unreachable" instead of fake ringback.
    await relayRingAck(env, callId, anyOk);
  }
}

// P1 ring-ack: POST the incoming-call push outcome to the callee's CallRoom DO
// (cross-script binding), which broadcasts {type:'ring-ack', ok} to the connected
// caller. Inert unless the client honors it (receptTakeoverGuard ON). Never throws.
async function relayRingAck(env: Env, callId: string, ok: boolean): Promise<void> {
  if (!env.CALL_ROOMS || !callId) return;
  try {
    const stub = env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(callId));
    await stub.fetch("https://call-room/control", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "ring-ack", ok, callId }),
    });
  } catch { /* best-effort — a signaling hiccup must never block a push */ }
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
    //
    // [FIX-FCM-2 2026-07-03] Forward a receptionist tag when the producer marks
    // this notify as a "Ava took a message" voicemail (reception DO sends
    // data:{type:"receptionist"}). Without this the tag was DROPPED here, so the
    // client couldn't route it to the dedicated "Calls" channel — it fell back to
    // fragile fromName=='Ava' sniffing. `recept:"1"` lets the app post a
    // "Missed call — Ava took a message from <name>" banner on the calls channel.
    const isRecept = (msg.data as any)?.type === "receptionist";
    return { highPriority: true, data: {
      type: "message", fromName: msg.fromName ?? "AvaTOK",
      // Short preview (when the sender included one) → the app renders an
      // expandable banner so the message reads from the shade without opening.
      ...(msg.preview ? { preview: msg.preview } : {}),
      ...(isRecept ? { recept: "1" } : {}),
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

// Returns the per-token send outcome so the caller can aggregate call-push results
// (P1). Existing failure telemetry is preserved (additive) — this only adds a
// return value and a success-path message-id parse.
async function sendFcm(env: Env, token: string, payload: { data: Record<string, string>; highPriority: boolean }, uid: string): Promise<{ ok: boolean; messageId?: string; error?: string; pruned?: boolean }> {
  if (!env.FCM_SERVICE_ACCOUNT) {
    console.warn("FCM_SERVICE_ACCOUNT unset; cannot send");
    await capturePush(env, "push_send_failed", uid, { reason: "no_service_account" });
    return { ok: false, error: "no_service_account" };
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
      // [MULTIACCT-1] carry account context so prune events are queryable per user.
      await capturePush(env, "push_token_pruned", uid, { status: res.status, account_id: uid });
      return { ok: false, error: `http_${res.status}`, pruned: true };
    } else {
      // Keep the token; surface the error in logs (visible via `wrangler tail`)
      // AND in PostHog so a project/credential/payload break is queryable, not
      // just a log line nobody is tailing.
      console.error("FCM send failed (token KEPT):", res.status, txt.slice(0, 300));
      await capturePush(env, "push_send_failed", uid, { status: res.status, error: txt.slice(0, 180) });
    }
    return { ok: false, error: `http_${res.status}` };
  }
  // Success — FCM returns { name: "projects/<p>/messages/<id>" }. Extract the id
  // so call_push_sent carries fcm_message_id for end-to-end delivery tracing.
  let messageId = "";
  try {
    const j = (await res.json()) as { name?: string };
    messageId = (j?.name ?? "").split("/").pop() ?? "";
  } catch { /* body already consumed / not JSON — ok stays true */ }
  return { ok: true, messageId };
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
