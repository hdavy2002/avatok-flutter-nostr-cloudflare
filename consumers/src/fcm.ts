// Push consumer — FCM v1 (Android) fully implemented; APNs (iOS) deferred until
// the APNs auth key is provided (project is Android-first). Resolves device
// tokens from D1 push_tokens, builds the payload, delivers. Calls go out as
// high-priority DATA messages so the app can raise a CallStyle / full-screen UI.
import type { Env, PushMsg } from "./types";
import { sendApns } from "./apns";

// [MULTIACCT-2] Resolve a callee's live device tokens. PREFERS the device-mapped
// join (device_tokens ⨝ account_devices WHERE active=1) so a token orphaned by an
// account switch is never delivered to; falls back to the legacy uid-keyed
// push_tokens_v2 table when the new tables aren't migrated/populated yet. De-dups
// by token so a device present in both stores is only tried once.
//
// [CALL-TELEMETRY-1 2026-07-14] Returns a RESOLUTION REPORT, not just the token
// list, so every downstream push event can say WHICH store the tokens came from
// and what the account's device mappings looked like at send time. Motivation:
// the 2026-07-11 "user is not available" incident (PostHog, caller
// hdavy2005@gmail.com) — push_no_device reason=all_tokens_pruned told us every
// token was dead, but NOT whether they were stale legacy push_tokens_v2 rows, an
// inactive account_devices mapping (account switched out on a shared phone), or
// a rotated FCM token after an app reinstall. This report closes that gap.
type TokenResolution = {
  // [PUSH-DEVICE-OBS-1] deviceId is present for "device_join" tokens and absent
  // for "legacy" ones (push_tokens_v2 is uid-keyed and has no device column) —
  // which is itself a useful signal: a legacy-sourced send is by definition
  // un-attributable to a device.
  tokens: Array<{ platform: string; token: string; source: "device_join" | "legacy"; deviceId?: string }>;
  deviceJoinCount: number;   // tokens from account_devices(active=1) ⨝ device_tokens
  legacyCount: number;       // tokens from push_tokens_v2 (only consulted when join = 0)
  mappedInactive: number;    // account_devices rows with active=0 (switched-out devices)
  mappedActiveNoToken: number; // active mappings whose device has NO token row (rotated/never registered)
};
async function resolveTokens(env: Env, uid: string): Promise<TokenResolution> {
  const seen = new Set<string>();
  const out: TokenResolution = {
    tokens: [], deviceJoinCount: 0, legacyCount: 0, mappedInactive: 0, mappedActiveNoToken: 0,
  };
  try {
    // [PUSH-DEVICE-OBS-1] Also select ad.device_id. It costs nothing (already in
    // the join) and it is the ONLY way to answer "did we send to the device the
    // user is actually holding?" — during the 2026-07-14 silent-notification
    // incident this account had 6 device rows, 1 usable token, and a
    // `delivered:1 / error:null` fanout, while the live phone got nothing.
    // `delivered` is FCM ACCEPTANCE, never device receipt, so without device_id
    // the success row and the total-failure reality are indistinguishable.
    const rs = await env.DB_META.prepare(
      "SELECT dt.platform AS platform, dt.token AS token, ad.device_id AS device_id FROM account_devices ad " +
      "JOIN device_tokens dt ON dt.device_id=ad.device_id WHERE ad.account_id=?1 AND ad.active=1",
    ).bind(uid).all();
    for (const r of (rs.results ?? []) as Array<{ platform: string; token: string; device_id: string }>) {
      if (r.token && !seen.has(r.token)) {
        seen.add(r.token);
        out.tokens.push({ platform: r.platform, token: r.token, source: "device_join", deviceId: r.device_id });
      }
    }
    out.deviceJoinCount = out.tokens.length;
    // [CALL-TELEMETRY-1] Mapping diagnostics (best-effort, one cheap query):
    // inactive mappings = "this account was switched out on N devices";
    // active-but-tokenless = "a device this account is active on has no token row"
    // (FCM token rotated/pruned and the app hasn't re-registered yet).
    const diag = await env.DB_META.prepare(
      "SELECT sum(CASE WHEN ad.active=0 THEN 1 ELSE 0 END) AS inactive, " +
      "sum(CASE WHEN ad.active=1 AND dt.token IS NULL THEN 1 ELSE 0 END) AS active_no_token " +
      "FROM account_devices ad LEFT JOIN device_tokens dt ON dt.device_id=ad.device_id " +
      "WHERE ad.account_id=?1",
    ).bind(uid).first<{ inactive: number | null; active_no_token: number | null }>();
    out.mappedInactive = diag?.inactive ?? 0;
    out.mappedActiveNoToken = diag?.active_no_token ?? 0;
  } catch { /* tables missing → legacy only */ }
  if (out.tokens.length) return out;
  const rs = await env.DB_META.prepare("SELECT platform, token FROM push_tokens_v2 WHERE uid=?1").bind(uid).all();
  for (const r of (rs.results ?? []) as Array<{ platform: string; token: string }>) {
    if (r.token && !seen.has(r.token)) {
      seen.add(r.token);
      out.tokens.push({ platform: r.platform, token: r.token, source: "legacy" });
    }
  }
  out.legacyCount = out.tokens.length;
  return out;
}

export async function handlePush(msg: PushMsg, env: Env): Promise<void> {
  if (msg.kind === "fanout") return handleFanout(msg, env);
  const uid = msg.to_uid || msg.to;
  if (!uid) return;
  const res = await resolveTokens(env, uid);
  const tokens = res.tokens;
  // [CALL-TELEMETRY-1] Token-resolution context threaded into every push event
  // below, so a single PostHog row explains the callee's device state.
  const resolutionProps = {
    token_source: res.deviceJoinCount > 0 ? "device_join" : (res.legacyCount > 0 ? "legacy" : "none"),
    device_join_tokens: res.deviceJoinCount,
    legacy_tokens: res.legacyCount,
    mapped_inactive: res.mappedInactive,
    mapped_active_no_token: res.mappedActiveNoToken,
  };
  // [AVACALL-RING-CANCEL-1] Don't ring a call the caller already cancelled. FCM
  // fan-out routinely lags the caller's cancel (2026-07-20 incident: the ring
  // reached the callee 2s AFTER the cancel). Before we hand a `call` push to FCM,
  // consult the CallRoom DO's strongly-consistent terminal state (set by the
  // caller's cancel via routes/api.ts callStatus → /mark-terminal). If it's
  // already terminal, suppress the ring entirely. Best-effort — a DO hiccup must
  // never block a legitimate ring, so any error falls through to the normal send.
  if (msg.kind === "call" && msg.callId && env.CALL_ROOMS) {
    try {
      const stub = env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(msg.callId));
      const r = await stub.fetch("https://call/state", { method: "GET" });
      if (r.ok) {
        const st = (await r.json()) as { terminal_status?: string | null; ended?: boolean };
        if (st && (st.terminal_status || st.ended === true)) {
          await capturePush(env, "call_ring_suppressed", uid, {
            call_id: msg.callId, reason: st.terminal_status || "ended", ...resolutionProps,
          });
          return; // caller is already gone — do not ring
        }
      }
    } catch { /* best-effort — never block a real ring on a state probe */ }
  }
  if (!tokens.length) {
    // SEND-side visibility: a push (call/notify/…) that can't be delivered because
    // the recipient has NO registered device. Previously a silent return — the
    // same blind spot behind the "no device registered" incident, seen from the
    // delivery side. Now queryable per recipient.
    await capturePush(env, "push_no_device", uid, {
      kind: msg.kind, call_id: msg.callId ?? null, reason: "zero_tokens", ...resolutionProps,
    });
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
  // [AVANOTIF-VM-2] Proof-in-prod: does this "message" push actually carry the
  // sender identity the client's _resolveDisplayName() needs, or did it fall
  // through empty (the exact class of bug this issue closes — messaging.ts's
  // fanout/pushOffline producers used to enqueue with NO `from` at all)? Cheap
  // boolean derived from the already-built FCM data payload, not re-derived —
  // so this can never drift from what actually ships to the device.
  const notifIdentityProps = payload.data.type === "message" ? {
    has_from_uid: !!payload.data.fromUid,
    has_from_phone: !!payload.data.fromPhone,
  } : {};
  // DEMO KILL-SWITCH (owner request 2026-07-01, demo): when DEMO_MUTE_NONCALL_PUSH="1",
  // suppress EVERY push except incoming calls + call-status, so a live demo isn't
  // interrupted by message / voicemail / reminder banners or silent sync wakes. We
  // gate on the OUTGOING payload type (not msg.kind) so a call delivered via the
  // relay path — kind:"relay-event", event_kind 25050 → type:"call" — still rings.
  // Reversible: set the var to "0" (or delete it) in consumers/wrangler.toml and
  // redeploy avatok-consumers to restore all notifications.
  if ((env as any).DEMO_MUTE_NONCALL_PUSH === "1" &&
      payload.data.type !== "call" && payload.data.type !== "call-status" && payload.data.type !== "now_free") {
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
  // [PUSH-DEVICE-OBS-1] Record WHICH devices/tokens we actually accepted a send
  // for. Cross-referenced with the client's `push_token_registered.device_id` +
  // `token_prefix`, this turns "delivered:1, live phone silent" from a theory
  // into a one-query fact: if delivered_device_ids does not contain the live
  // device's id, the push went somewhere else. Only 12-char token prefixes are
  // emitted — a full FCM token is a sending credential, never analytics data.
  const deliveredDeviceIds: string[] = [];
  const deliveredTokenPrefixes: string[] = [];
  for (const t of tokens) {
    if (t.platform === "apns") { await sendApns(env, t.token, payload); continue; }
    // [CALL-TELEMETRY-1] Thread call_id + token source so push_token_pruned /
    // push_send_failed rows stitch to the call and name the store they came from.
    const r = await sendFcm(env, t.token, payload, uid, { callId: callId || null, source: t.source });
    if (r.ok) {
      anyOk = true; delivered++;
      if (!firstMsgId && r.messageId) firstMsgId = r.messageId;
      deliveredDeviceIds.push(t.deviceId ?? "legacy_no_device");
      deliveredTokenPrefixes.push(t.token.slice(0, 12));
    }
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
    // [PUSH-DEVICE-OBS-1] join keys — see deliveredDeviceIds above.
    delivered_device_ids: deliveredDeviceIds,
    delivered_token_prefixes: deliveredTokenPrefixes,
    // Restated explicitly: `delivered` counts FCM 200s, NOT device receipt.
    // Pair with the client's `fcm_bg_received` / `push_shown` to measure the
    // real gap. This label exists so nobody reads `delivered:1` as "user pinged".
    delivered_semantics: "fcm_accepted_not_device_receipt",
    ...resolutionProps, // [CALL-TELEMETRY-1]
    ...notifIdentityProps, // [AVANOTIF-VM-2]
  });
  // [MULTIACCT-1] If we entered with tokens but NONE delivered AND every failure
  // was a prune (all tokens were dead — the stale-token-after-relogin case), this
  // callee is effectively device-less right now. Emit push_no_device so it looks
  // identical to the zero-token path and downstream reachability queries catch it.
  if (delivered === 0 && tokensTried > 0 && pruned === tokensTried) {
    await capturePush(env, "push_no_device", uid, {
      kind: msg.kind, call_id: callId || null, reason: "all_tokens_pruned", pruned,
      ...resolutionProps, // [CALL-TELEMETRY-1] which store held the dead tokens
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
      ...resolutionProps, // [CALL-TELEMETRY-1]
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
          // [AVANOTIF-VM-1 / AVANOTIF-VM-2] Forward the sender uid when the fanout
          // carried one so the recipient can resolve a name from their own
          // contacts. GAP CLOSED 2026-07-16: messaging.ts's large-group fanout
          // producers (send() + forwardMsg()) now set `from: ctx.uid` on every
          // "fanout" enqueue — see [AVANOTIF-VM-2] there. Also forward `fromPhone`
          // for parity, for any future producer that supplies one (no current
          // messaging.ts path has an unhashed phone to send).
          ...(msg.from ? { fromUid: msg.from } : {}),
          ...(msg.fromPhone ? { fromPhone: msg.fromPhone } : {}),
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
      // [TRACE-ID-1] Correlation id -> the callee's push handler reads it and
      // stitches its CallSession telemetry to the caller's + Worker's trace.
      trace_id: msg.traceId ?? "",
      ...(msg.ringReceiptToken ? { ringReceiptToken: msg.ringReceiptToken } : {}),
      ...(msg.tokenExpiresAt ? { tokenExpiresAt: msg.tokenExpiresAt.toString() } : {}),
    } };
  }
  if (msg.kind === "call-status") {
    // [BUSY-CARD-1] "Now free" — the busy callee returned to idle; ping the waiter
    // who tapped "Notify me". The client listens for type:"now_free" (not
    // call-status), so translate here. The caller resolves the callee's display
    // name locally from callee_uid (they just called them), so no name lookup here.
    if (msg.status === "now_free") {
      return { highPriority: true, data: {
        type: "now_free",
        fromPub: msg.from ?? msg.callee_uid ?? "",
        callee_uid: msg.callee_uid ?? msg.from ?? "",
        generation: String(msg.generation ?? ""),
      } };
    }
    // [BUSY-CARD-1] Forward the busy metadata (why + whether Ava can take a message)
    // so the CALLER shows the personalized busy card. Absent → legacy "User is busy".
    return { highPriority: true, data: {
      type: "call-status", callId: msg.callId ?? "", status: msg.status ?? "",
      ...(msg.busy_reason ? { busy_reason: String(msg.busy_reason) } : {}),
      ...(msg.receptionist_enabled != null ? { receptionist_enabled: msg.receptionist_enabled ? "1" : "0" } : {}),
      ...(msg.pronoun ? { pronoun: String(msg.pronoun) } : {}),
    } };
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
    // [AVANOTIF-VM-1] Forward the SENDER's identity so the RECIPIENT resolves a
    // display name from THEIR OWN contact book, instead of trusting the
    // sender-declared `fromName` (root cause of the "919820436843 / New message"
    // report: fromName is whatever the SENDER's own device had set as its local
    // display name — un-verified against the recipient's contacts). Priority:
    // a missed-call/voicemail DO's `caller_uid`/`caller_phone` (pstn.ts,
    // reception_room*.ts put these on `msg.data`) > `msg.from` (the Worker-
    // authenticated sender uid set by postNotify) > an optional client-supplied
    // `msg.fromUid`/`msg.fromPhone` hint.
    const fromUid = (msg.data as any)?.caller_uid || msg.from || msg.fromUid || "";
    const fromPhone = (msg.data as any)?.caller_phone || msg.fromPhone || "";
    // Sub-kind of a "notify" push (e.g. "receptionist" | "voicemail"). Lets the
    // client route PSTN missed-call/voicemail pushes to the Calls channel even
    // though their `fromName` is the caller's raw phone number, not 'Ava' — the
    // old fromName=='Ava' heuristic never matched these, so a PSTN missed call
    // rendered as a plain chat-message banner titled with a raw number (the
    // reported bug). Additive: does not replace the existing recept/fromName checks.
    const subKind = (msg.data as any)?.type ? String((msg.data as any).type) : "";
    return { highPriority: true, data: {
      type: "message", fromName: msg.fromName ?? "AvaTOK",
      ...(fromUid ? { fromUid: String(fromUid) } : {}),
      ...(fromPhone ? { fromPhone: String(fromPhone) } : {}),
      ...(subKind ? { subKind } : {}),
      // Short preview — the sender's own `preview`, or (fallback) the internal
      // DO senders' `body` field (e.g. a voicemail transcript snippet), so those
      // pushes stop arriving content-less. The app renders an expandable banner
      // so the message/voicemail reads from the shade without opening.
      ...(msg.preview ?? msg.body ? { preview: String(msg.preview ?? msg.body) } : {}),
      ...(isRecept ? { recept: "1" } : {}),
      // [PUSH-FG-BANNER-1 2026-07-14] Forward the conversation key. `del`, `hide`
      // and `group_invite` already carry `conv`; `notify` — the one kind that
      // actually shows a banner — did not, purely by omission.
      //
      // The client's FOREGROUND handler needs it. It used to show NO banner for
      // any foreground message, on the assumption "app is open ⇒ the user is
      // looking at it". False: FCM calls a message "foreground" whenever the app
      // PROCESS is foreground, which includes the phone being in a pocket with
      // the screen off, and the user being on a different thread or a different
      // app tab entirely. That is why the 2026-07-14 report — "she replied while
      // I was walking with my screen off and I never heard a ping" — produced
      // `fcm_fg_received` and no `push_shown`. With `conv` the client can
      // suppress the banner ONLY for the exact thread being read.
      ...(msg.conv ? { conv: String(msg.conv) } : {}),
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
async function sendFcm(
  env: Env, token: string, payload: { data: Record<string, string>; highPriority: boolean }, uid: string,
  // [CALL-TELEMETRY-1] optional send context — call_id + which store the token
  // came from — so prune/fail events are self-explanatory in PostHog.
  ctx?: { callId?: string | null; source?: string },
): Promise<{ ok: boolean; messageId?: string; error?: string; pruned?: boolean }> {
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
      // [MULTIACCT-2] also drop the device-level row so the device-mapped join
      // stops resolving this dead token for EVERY account on that device.
      //
      // [DEVICE-ROW-GC-1 2026-07-14] …and now ALSO drop that device's
      // account_devices mappings.
      //
      // The old comment claimed the leftover mappings were "harmless — they
      // resolve to nothing". They are not harmless; they are exactly what
      // manufactures `mapped_active_no_token`. This prune deleted device_tokens
      // while leaving account_devices(active=1), i.e. it CREATED an active
      // mapping with no token, by construction, every single time it ran. On
      // 2026-07-14 the reporting account had accumulated 6 device rows —
      // `mapped_active_no_token:2`, `mapped_inactive:3` — with exactly ONE
      // usable token between them. `DeviceId` re-mints on every reinstall/data
      // clear, so rows accrue forever and nothing ever collected them.
      //
      // Safe to delete: a device whose only token FCM just declared UNREGISTERED
      // is unreachable by definition, so the mapping addresses nothing. If that
      // device is still alive it re-registers on next launch (`_postToken` →
      // /api/register writes both rows back). Worst case we cost one live device
      // one push before it re-registers — versus permanently polluting every
      // fan-out decision and every diagnostic for that account.
      //
      // Scoped by device_id (NOT by uid): the mapping is device-owned, so this
      // correctly clears the dead device for every account on a shared phone,
      // and touches no other device.
      let mappingsDropped = -1;
      let prunedDeviceId: string | null = null;
      let affectedAccounts: string[] = [];
      try {
        const row = await env.DB_META
          .prepare("SELECT device_id FROM device_tokens WHERE token=?1")
          .bind(token)
          .first<{ device_id: string }>();
        await env.DB_META.prepare("DELETE FROM device_tokens WHERE token=?1").bind(token).run();
        if (row?.device_id) {
          prunedDeviceId = row.device_id;
          // [CALL-REACH-1] Record WHO becomes unreachable by this prune BEFORE
          // deleting, so a single PostHog row answers "whose calls will start
          // falling to the Ava agent from this moment". The client is never
          // notified (its push channel is the thing that just died), so this
          // event is the only server-side record of the blast radius; the
          // client-side heal is the 12h TTL re-register ([CALL-REACH-1] in
          // push_service.dart) + forced re-register on account switch-in.
          try {
            const acc = await env.DB_META
              .prepare("SELECT account_id FROM account_devices WHERE device_id=?1")
              .bind(row.device_id)
              .all<{ account_id: string }>();
            affectedAccounts = (acc.results ?? []).map(r => r.account_id).slice(0, 10);
          } catch { /* best-effort */ }
          const r = await env.DB_META
            .prepare("DELETE FROM account_devices WHERE device_id=?1")
            .bind(row.device_id)
            .run();
          mappingsDropped = (r.meta?.changes as number | undefined) ?? -1;
        }
      } catch { /* pre-migration / table missing — never block delivery */ }
      console.warn("FCM: pruned dead token", token.slice(0, 12));
      // [MULTIACCT-1] carry account context so prune events are queryable per user.
      // [CALL-TELEMETRY-1] + call_id, token source, token prefix, and FCM's error
      // text so a prune row alone answers: which call, which store, which token,
      // and what FCM actually said (UNREGISTERED vs NOT_FOUND vs 404).
      await capturePush(env, "push_token_pruned", uid, {
        status: res.status, account_id: uid,
        call_id: ctx?.callId ?? null, token_source: ctx?.source ?? null,
        token_prefix: token.slice(0, 12), fcm_error: txt.slice(0, 180),
        // [DEVICE-ROW-GC-1] How many account_devices rows this prune collected.
        // Should trend to ~1. A persistent 0 means the GC isn't firing; a large
        // number means a shared device is being cleared for many accounts.
        mappings_dropped: mappingsDropped,
        // [CALL-REACH-1] Blast radius: the device and every account that just
        // lost its ring path. Join key for the client's device_id-tagged
        // register/skip events, and the query answering "who is deaf right now".
        device_id: prunedDeviceId,
        affected_accounts: affectedAccounts,
        affected_account_count: affectedAccounts.length,
      });
      return { ok: false, error: `http_${res.status}`, pruned: true };
    } else {
      // Keep the token; surface the error in logs (visible via `wrangler tail`)
      // AND in PostHog so a project/credential/payload break is queryable, not
      // just a log line nobody is tailing.
      console.error("FCM send failed (token KEPT):", res.status, txt.slice(0, 300));
      await capturePush(env, "push_send_failed", uid, {
        status: res.status, error: txt.slice(0, 180),
        call_id: ctx?.callId ?? null, token_source: ctx?.source ?? null, // [CALL-TELEMETRY-1]
      });
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
