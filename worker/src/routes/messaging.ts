// Messaging routes (Cloudflare-native, Nostr deprecated). The avatok-api Worker
// is the ROUTER: it authenticates (Clerk JWT), gates (KYC + block), assigns the
// message via each member's InboxDO, pushes live or enqueues FCM when offline.
// Messages are server-readable plaintext (TLS in transit) — no E2E, by design,
// so moderation/reporting can operate.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, kycVerified, dmConvId, isFail } from "../authz";
import { nameFor } from "../lib/identity";        // resolve inviter display name
import { readConfig } from "./config";            // groupInvitesEnabled kill switch
import { novuGroupInvite } from "../notify_novu"; // optional Novu orchestration
import { delegateScan } from "./ava_delegate";   // P7 — Phase 11 hook
import { guardianScan } from "./ava_guardian";    // P8 — Phase 11 hook
import { canonicalMsgId } from "../util"; // canonical, chronologically-sortable message id

// ---- WebSocket: client live socket → the caller's InboxDO --------------------
export async function wsInbox(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return new Response(ctx.error, { status: ctx.status });
  const stub = env.INBOX.get(env.INBOX.idFromName(ctx.uid));
  return stub.fetch("https://inbox/ws", req);
}

// PartyKit realtime layer (ephemeral; replaces Ably). Upgrades a WebSocket into
// the room's PartyDO. The room key comes from ?room=<type:id> (e.g. thread:<conv>,
// listing:<id>, neg:<negId>, user:<uid>, conf:<groupId>). We pass the CLERK-
// VERIFIED uid to the DO so presence/events are stamped from a real identity the
// client can't spoof. Nothing here is durable — see do/party.ts.
export async function wsParty(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return new Response(ctx.error, { status: ctx.status });
  const room = (new URL(req.url).searchParams.get("room") || "").slice(0, 200);
  if (!room) return new Response("room required", { status: 400 });
  return env.PARTY.get(env.PARTY.idFromName(room)).fetch(
    `https://party/ws?uid=${encodeURIComponent(ctx.uid)}&room=${encodeURIComponent(room)}`,
    req,
  );
}

// Server → room broadcast (e.g. the marketplace agent loop streaming negotiation
// progress into neg:<negId> from the Worker). Ephemeral, best-effort. Returns
// whether at least one socket was live in the room.
export async function partyEmit(env: Env, room: string, event: Record<string, unknown>): Promise<boolean> {
  try {
    const r = await env.PARTY.get(env.PARTY.idFromName(room)).fetch("https://party/emit", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event),
    });
    const j = (await r.json().catch(() => ({}))) as any;
    return !!j.live;
  } catch { return false; }
}

// ---- helpers ----------------------------------------------------------------
// Fan-out rule (Scale proposal Phase 1): >FANOUT_SYNC_MAX recipients NEVER loop
// synchronous DO calls in the router — they go through Q_PUSH ("fanout" kind,
// consumers append + FCM offline). ≤ the cap, deliveries run in PARALLEL.
const FANOUT_SYNC_MAX = 25;
const FANOUT_QUEUE_CHUNK = 80; // recipients per queue message (well under 128KB)
const BLOCKS_CHUNK = 90;       // D1 100-bound-param limit (SCALE_AUDIT P0-2)

/** Which of `candidates` have blocked `sender`? ONE chunked query, not N round-trips. */
async function blockersOf(env: Env, sender: string, candidates: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < candidates.length; i += BLOCKS_CHUNK) {
    const chunk = candidates.slice(i, i + BLOCKS_CHUNK);
    const rs = await env.DB_META.prepare(
      `SELECT uid FROM blocks WHERE blocked_uid = ?1 AND uid IN (${chunk.map((_, j) => `?${j + 2}`).join(",")})`,
    ).bind(sender, ...chunk).all<{ uid: string }>();
    for (const r of rs.results ?? []) out.add(r.uid);
  }
  return out;
}

async function members(env: Env, conv: string): Promise<string[]> {
  const rows = await env.DB_META
    .prepare("SELECT uid FROM conversation_members WHERE conv_id = ?1")
    .bind(conv).all<{ uid: string }>();
  return (rows.results || []).map((r) => r.uid);
}

// Phase 8 (AvaInbox): conversations carry a `context` tag — dm | event:<listingId>
// | channel:<creatorId> | consult:<bookingId> | system. Set when the thread is
// created (Phase 6 "Message" buttons pass event/channel); never overwritten once set.
const CONTEXT_RE = /^(dm|system|event:[A-Za-z0-9-]{1,64}|channel:[A-Za-z0-9_-]{1,64}|consult:[A-Za-z0-9-]{1,64})$/;
function normContext(c: unknown): string | null {
  const s = String(c ?? "").trim();
  return CONTEXT_RE.test(s) ? s : null;
}

async function ensureDm(env: Env, a: string, b: string, context?: string | null): Promise<string> {
  const conv = dmConvId(a, b);
  const now = Date.now();
  await env.DB_META.batch([
    env.DB_META.prepare(
      "INSERT OR IGNORE INTO conversations (id, kind, created_by, created_at, updated_at, context) VALUES (?1,'dm',?2,?3,?3,?4)",
    ).bind(conv, a, now, context ?? null),
    // Tag an existing untagged thread the first time a context arrives.
    env.DB_META.prepare(
      "UPDATE conversations SET context=COALESCE(context, ?2) WHERE id=?1",
    ).bind(conv, context ?? null),
    env.DB_META.prepare(
      "INSERT OR IGNORE INTO conversation_members (conv_id, uid, role, joined_at) VALUES (?1,?2,'member',?3)",
    ).bind(conv, a, now),
    env.DB_META.prepare(
      "INSERT OR IGNORE INTO conversation_members (conv_id, uid, role, joined_at) VALUES (?1,?2,'member',?3)",
    ).bind(conv, b, now),
  ]);
  return conv;
}

async function appendTo(env: Env, owner: string, body: Record<string, unknown>): Promise<{ id: number; live: boolean }> {
  const stub = env.INBOX.get(env.INBOX.idFromName(owner));
  const res = await stub.fetch("https://inbox/append", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, owner }),
  });
  return res.json();
}

// Offline wake. Since the Ably migration this is the ONLY offline path on mobile,
// so it MUST carry the sender's name + a short preview (the WhatsApp-style
// expandable banner). The consumer's notify branch already renders both — the old
// bug was the PRODUCER sending a bare "AvaTOK" with no preview (regression noted
// 2026-06-28). We now forward the real name + preview here and in the fanout path.
async function pushOffline(env: Env, toUid: string, fromName: string, preview: string): Promise<void> {
  try {
    await env.Q_PUSH.send({
      kind: "notify", to: toUid, fromName: fromName || "AvaTOK",
      ...(preview ? { preview } : {}),
    });
  } catch { /* best-effort; never block the send */ }
}

/** Sender's display name for push banners. One cheap D1 lookup; falls back to the
 *  @handle, then "AvaTOK". */
async function senderDisplayName(env: Env, uid: string): Promise<string> {
  try {
    const r = await env.DB_META.prepare(
      "SELECT display_name, handle FROM users WHERE uid=?1 LIMIT 1",
    ).bind(uid).first<{ display_name: string | null; handle: string | null }>();
    return (r?.display_name || r?.handle || "AvaTOK").toString();
  } catch { return "AvaTOK"; }
}

/** Short, human banner preview. Control envelopes ({"t":"del"|"read"|…}) and media
 *  get a generic label rather than raw JSON. */
function msgPreview(kind: string, text: string | null, mediaRef: string | null): string {
  if (kind === "audio") return "🎤 Voice message";
  const t = (text ?? "").trim();
  if (t.startsWith("{") && t.includes('"t":"')) return "New message";
  if (!t && mediaRef) return "📎 Attachment";
  return t.slice(0, 140) || "New message";
}

// Delete-for-everyone to an OFFLINE recipient: a SILENT, high-priority DATA push
// carrying the redaction so the device applies it in (near) realtime — wakes the
// app + reconnects the InboxDO socket, and the background isolate queues the
// tombstone — instead of waiting for the next manual sync (the "deleted after 2h
// or never" bug). Online recipients already get it instantly over the DO socket
// broadcast in inbox.append(), so this path is offline-only.
async function pushDelete(env: Env, toUid: string, conv: string, target: string): Promise<void> {
  try {
    await env.Q_PUSH.send({ kind: "del", to: toUid, conv, target });
  } catch (e) {
    // The offline path failed to enqueue → the recipient can ONLY get this delete
    // on their next sync. Record it so a stuck delete is attributable, not silent.
    try {
      void env.Q_ANALYTICS.send({ event: "chat_delete_push_failed", uid: toUid, ts: Date.now(),
        props: { delete_id: target, conv, account_id: toUid, app_name: "avatok",
          service_name: "avatok-api", worker: true, err: String(e).slice(0, 200) } });
    } catch { /* best-effort */ }
  }
}

// ---- POST /api/msg/send -----------------------------------------------------
export async function sendMsg(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  // KYC gate is flag-gated OFF until Stripe Identity ships (set KYC_REQUIRED=1 to enforce).
  if (env.KYC_REQUIRED === "1" && !(await kycVerified(env, ctx.uid))) return json({ error: "kyc required" }, 403);

  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const kind = String(b.kind || "text");
  const text = b.body == null ? null : String(b.body);
  const mediaRef = b.media_ref == null ? null : String(b.media_ref);
  const clientId = b.client_id == null ? null : String(b.client_id);
  if (!text && !mediaRef) return json({ error: "empty message" }, 400);

  // Resolve the conversation + its members.
  let conv: string;
  let mem: string[];
  if (b.to) {
    conv = await ensureDm(env, ctx.uid, String(b.to), normContext(b.context));
    mem = [ctx.uid, String(b.to)];
  } else if (b.conv) {
    conv = String(b.conv);
    mem = await members(env, conv);
    if (!mem.includes(ctx.uid)) return json({ error: "not a member" }, 403);
  } else {
    return json({ error: "conv or to required" }, 400);
  }

  const created = Date.now();
  // Canonical, chronologically-sortable id shared by the live Ably message, the
  // R2 archive key, and the client dedupe key (Phase 1, ABLY-R2-1).
  const mid = canonicalMsgId(created);
  const payload = { conv, sender: ctx.uid, kind, body: text, media_ref: mediaRef, client_id: clientId, created_at: created, mid };

  // Is this a delete-for-everyone control? Offline recipients then get a silent,
  // high-priority 'del' push (apply in realtime) instead of a "New message" banner.
  let delTarget = "";
  if (text && (text.includes('"t":"del"') || text.includes('"t":"gdel"'))) {
    try {
      const c = JSON.parse(text);
      if (c && (c.t === "del" || c.t === "gdel")) delTarget = String(c.target ?? "");
    } catch { /* not a control envelope */ }
  }

  // Blocks: ONE chunked query for all members (was a D1 round-trip per member).
  const others = mem.filter((m) => m !== ctx.uid);
  const blockers = await blockersOf(env, ctx.uid, others);
  if (others.length === 1 && blockers.has(others[0])) return json({ error: "blocked" }, 403);
  const recipients = others.filter((m) => !blockers.has(m)); // group: silently skip blockers

  // Append to the sender's own log first (its id anchors the client's cursor).
  const mine = await appendTo(env, ctx.uid, payload);

  // Rich offline banner inputs (the Ably migration made push the only offline
  // wake path on mobile, so these must be populated — not a bare "AvaTOK").
  const fromName = await senderDisplayName(env, ctx.uid);
  const preview = msgPreview(kind, text, mediaRef);

  // Phase 1 (ABLY-R2-1): durable R2 archive. Enqueue the moderated message so a
  // consumer writes the body to R2 (BACKUP_R2, chat/<conv>/<mid>.json) + indexes
  // it in D1 (message_index). This is the "never lose a chat" + AI-search source
  // of truth, DECOUPLED from the per-user InboxDO. Best-effort + flag-gated
  // (CHAT_ARCHIVE=1) so it ships dark; archives are idempotent on `mid`.
  if (env.CHAT_ARCHIVE === "1" && env.Q_ARCHIVE) {
    try {
      void env.Q_ARCHIVE.send({
        conv, serial: mid, sender: ctx.uid, kind,
        body: text, media_ref: mediaRef, client_id: clientId, created_at: created,
        group: mem.length > 2,
      });
    } catch { /* best-effort; the message still delivered live + via InboxDO */ }
  }

  // Delivery: a small fan-out is delivered synchronously in parallel; a large one
  // is handed to Queues (the router never loops >FANOUT_SYNC_MAX synchronous DO
  // calls). The delete-for-everyone path keeps precise synchronous delivery + telemetry.
  let deliveryPath = "sync";
  if (recipients.length <= FANOUT_SYNC_MAX) {
    // Small fan-out: deliver in PARALLEL (was sequential awaits).
    let delLive = 0, delPush = 0; // delete-for-everyone delivery-path counters
    await Promise.all(recipients.map(async (m) => {
      const r = await appendTo(env, m, payload);
      if (delTarget) {
        // Realtime telemetry: per recipient, did the redaction go out over the
        // live DO socket (instant) or fall back to a high-priority FCM push
        // (recipient asleep)? This is the signal for "why was a delete slow".
        if (r.live) delLive++; else { delPush++; await pushDelete(env, m, conv, delTarget); }
        try {
          void env.Q_ANALYTICS.send({ event: "chat_delete_delivery", uid: ctx.uid, ts: Date.now(),
            props: { delete_id: delTarget, conv, to: m, path: r.live ? "live" : "push",
              app_name: "avatok", service_name: "avatok-api", worker: true } });
        } catch { /* best-effort */ }
      } else if (!r.live) {
        await pushOffline(env, m, fromName, preview);
      }
    }));
    if (delTarget) {
      try {
        void env.Q_ANALYTICS.send({ event: "chat_delete_fanout", uid: ctx.uid, ts: Date.now(),
          props: { delete_id: delTarget, conv, recipients: recipients.length,
            live: delLive, push: delPush, app_name: "avatok", service_name: "avatok-api", worker: true } });
      } catch { /* best-effort */ }
    }
  } else {
    // Large fan-out: hand to Queues — consumers append to each InboxDO + FCM
    // offline. The router NEVER loops >FANOUT_SYNC_MAX synchronous DO calls.
    deliveryPath = "queue";
    const sends: Promise<unknown>[] = [];
    for (let i = 0; i < recipients.length; i += FANOUT_QUEUE_CHUNK) {
      sends.push(env.Q_PUSH.send({
        kind: "fanout", payload, fromName, preview,
        recipients: recipients.slice(i, i + FANOUT_QUEUE_CHUNK),
      }));
    }
    await Promise.all(sends);
  }

  // Telemetry: every send records its delivery path + latency so we can SEE the
  // Ably-first win (ably_async) vs the legacy sync/queue paths on the dashboard.
  try {
    void env.Q_ANALYTICS.send({ event: "chat_message_sent", uid: ctx.uid, ts: Date.now(),
      props: { conv, kind, path: deliveryPath, recipients: recipients.length,
        group: mem.length > 2, archived: env.CHAT_ARCHIVE === "1",
        latency_ms: Date.now() - created, account_id: ctx.uid,
        app_name: "avatok", service_name: "avatok-api", worker: true } });
  } catch { /* best-effort */ }

  // Phase 9 — AvaBrain ingestion producer (best-effort; consumer re-checks the
  // guardrails). Sender + each recipient (≤ sync cap) get the message indexed
  // into THEIR OWN brain. Voice notes (kind=audio) get Whisper-transcribed.
  try {
    // [BRAIN-KILL-1] Honour the brainEnabled kill switch at the PRODUCER. The
    // consumer re-checks guardrails, but enqueuing while the feature is OFF spends
    // queue ops + risks ingestion the flag is meant to suppress. brainEnabled is
    // false at launch, so this block ships dark — zero Q_BRAIN traffic from chat.
    if ((await readConfig(env)).brainEnabled) {
      const isGroup = mem.length > 2;
      const brainPayload = {
        conv, kind, body: text ? text.slice(0, 2000) : null, media_ref: mediaRef,
        group: isGroup, created_at: created,
      };
      void env.Q_BRAIN.send({ uid: ctx.uid, event_type: "message_stored", source_app: "avatok", payload: { ...brainPayload, peer: others[0] ?? null } });
      if (recipients.length <= FANOUT_SYNC_MAX) {
        for (const m of recipients) {
          void env.Q_BRAIN.send({ uid: m, event_type: "message_received", source_app: "avatok", payload: { ...brainPayload, peer: ctx.uid } });
        }
      }
    }
  } catch { /* brain feed is best-effort, never blocks the send */ }

  // Ava delegate (P7) + guardian (P8) post-fanout scans. Both self-gate on cheap
  // string heuristics → ZERO model cost for clean / non-monitored messages. Run
  // detached (no ctx.waitUntil in this route signature) so they never block the
  // send. `payload` is the exact fanned-out object; `mem` the member list.
  void delegateScan(env, { conv, message: payload, members: mem, senderUid: ctx.uid });
  // Pass the sender's origin geo/IP through so the guardian telemetry can record
  // where flagged messages come from (country/IP) alongside who→who.
  const _cf: any = (req as any).cf || {};
  void guardianScan(env, { conv, message: payload, members: mem, senderUid: ctx.uid, geo: {
    country: _cf.country ?? null, region: _cf.region ?? null, city: _cf.city ?? null,
    colo: _cf.colo ?? null, ip: req.headers.get("CF-Connecting-IP"),
  } });

  // P13-B PartyKit delivery hint (dark until PARTY_ENABLED=1): nudge anyone with
  // this thread open to do a targeted fetch instantly, instead of waiting on the
  // hub frame. HINT ONLY — InboxDO stays the source of truth, so a lost hint
  // changes nothing. Best-effort; never blocks the send. Zero cost while dark.
  if (env.PARTY_ENABLED === "1") {
    void partyEmit(env, `thread:${conv}`, { t: "new", conv, seq: mine.id });
  }

  return json({ id: mine.id, conv, created_at: created });
}

// ---- POST /api/msg/react ----------------------------------------------------
// Phase 4 (ABLY-R2-4): persist a per-message reaction toggle. The LIVE reaction
// rides Ably (client→react:<conv>) for instant feedback; this call durably stores
// it (message_reactions) so it survives reopen and feeds "reacted by" + restore.
export async function reactMsg(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const conv = String(b.conv || "");
  const target = String(b.target || "");
  const emoji = String(b.emoji || "");
  const op = b.op === "remove" ? "remove" : "add";
  if (!conv || !target || !emoji) return json({ error: "conv, target, emoji required" }, 400);
  const mem = await members(env, conv);
  if (!mem.includes(ctx.uid)) return json({ error: "not a member" }, 403);

  if (env.Q_ARCHIVE) {
    try {
      void env.Q_ARCHIVE.send({
        type: "reaction", conv, target, sender: ctx.uid, emoji, op,
        serial: "", kind: "reaction", created_at: Date.now(),
      });
    } catch { /* best-effort; the live Ably reaction already showed */ }
  }
  try {
    void env.Q_ANALYTICS.send({ event: "chat_reaction", uid: ctx.uid, ts: Date.now(),
      props: { conv, emoji, op, group: mem.length > 2, account_id: ctx.uid,
        app_name: "avatok", service_name: "avatok-api", worker: true } });
  } catch { /* best-effort */ }
  return json({ ok: true });
}

// ---- GET /api/msg/sync?cursor=N ---------------------------------------------
export async function syncMsg(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const cursor = new URL(req.url).searchParams.get("cursor") || "0";
  const stub = env.INBOX.get(env.INBOX.idFromName(ctx.uid));
  const res = await stub.fetch(`https://inbox/sync?cursor=${encodeURIComponent(cursor)}`);
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}

// ---- POST /api/msg/receipt --------------------------------------------------
// The reader (ctx.uid) tells the PEER that they delivered/read up to an id.
export async function receiptMsg(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!b.conv || !b.peer) return json({ error: "conv and peer required" }, 400);
  const stub = env.INBOX.get(env.INBOX.idFromName(String(b.peer)));
  await stub.fetch("https://inbox/receipt", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ conv: String(b.conv), peer: ctx.uid, delivered_id: b.delivered_id, read_id: b.read_id }),
  });
  return json({ ok: true });
}

// ---- POST /api/msg/read -----------------------------------------------------
// The owner marks a conversation read up to `read_ts` (unix seconds) in their
// OWN InboxDO. Unlike /receipt (which targets the PEER's inbox for ✓✓ ticks),
// this persists MY read position so a fresh login / second device restores it
// and stops recounting old messages as unread.
export async function readMsg(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!b.conv) return json({ error: "conv required" }, 400);
  const stub = env.INBOX.get(env.INBOX.idFromName(ctx.uid));
  await stub.fetch("https://inbox/read", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ conv: String(b.conv), read_ts: Number(b.read_ts) || 0 }),
  });
  // Phase 5 (ABLY-R2-5): mirror read position to D1 (dark, MSG_STATE_STORE=d1) so
  // the InboxDO can eventually stop holding owner-private state.
  if (env.MSG_STATE_STORE === "d1") {
    try {
      await env.DB_META.prepare(
        `INSERT INTO msg_read_state (uid, conv, read_ts) VALUES (?1, ?2, ?3)
         ON CONFLICT(uid, conv) DO UPDATE SET read_ts=MAX(read_ts, excluded.read_ts)`,
      ).bind(ctx.uid, String(b.conv), Number(b.read_ts) || 0).run();
    } catch { /* best-effort; InboxDO remains the source until cutover */ }
  }
  return json({ ok: true });
}

// ---- POST /api/msg/hide -----------------------------------------------------
// Owner soft-hides / un-hides one of their OWN messages (delete-for-me, the owner
// side of delete-for-everyone, or Undo). Writes to MY OWN InboxDO only (never the
// peer's) so the hide/Undo syncs across all of MY devices via /sync + live frame.
export async function hideMsg(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!b.conv || !b.target) return json({ error: "conv and target required" }, 400);
  const stub = env.INBOX.get(env.INBOX.idFromName(ctx.uid));
  const hideRes = await stub.fetch("https://inbox/hide", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ conv: String(b.conv), target: String(b.target), hidden: b.hidden === true }),
  });
  const live = await hideRes.json().then((r: any) => r?.live === true).catch(() => false);
  // Phase 5 (ABLY-R2-5): mirror the hide/Undo to D1 (dark, MSG_STATE_STORE=d1).
  if (env.MSG_STATE_STORE === "d1") {
    try {
      await env.DB_META.prepare(
        `INSERT INTO msg_hidden (uid, target, hidden, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(uid, target) DO UPDATE SET hidden=excluded.hidden, updated_at=excluded.updated_at`,
      ).bind(ctx.uid, String(b.target), b.hidden === true ? 1 : 0, Date.now()).run();
    } catch { /* best-effort */ }
  }
  // Multi-device parity with the call log: the DO already broadcast a live 'hide'
  // frame to my OPEN sockets; ALSO enqueue a SILENT high-priority FCM wake so my
  // ASLEEP/killed devices hide/un-hide in realtime instead of on their next sync
  // (one InboxDO serves all my devices, so the same uid reaches every token).
  let pushed = false;
  try {
    await env.Q_PUSH.send({ kind: "hide", to: ctx.uid, conv: String(b.conv), target: String(b.target), hidden: b.hidden === true });
    pushed = true;
  } catch { /* best-effort; live frame + next /sync still converge */ }
  // Multi-device fanout signal: did the live frame reach an open socket, and did we
  // enqueue the wake? Join `target` to chat_hide_sent (sender) + chat_hide_applied
  // (each device) to see, per hide/undo, where it landed and where it stalled.
  try {
    void env.Q_ANALYTICS.send({ event: "chat_hide_fanout", uid: ctx.uid, ts: Date.now(),
      props: { target: String(b.target), conv: String(b.conv), hidden: b.hidden === true,
        live, pushed, app_name: "avatok", service_name: "avatok-api", worker: true, account_id: ctx.uid } });
  } catch { /* best-effort */ }
  return json({ ok: true });
}

// ---- GET /api/msg/state -----------------------------------------------------
// Phase 5 (ABLY-R2-5): the owner's private state from D1 (read positions, hidden
// flags, call log). The client uses this to restore unread + deletions + calls on
// a fresh device once cut over from the InboxDO. Dark until MSG_STATE_STORE=d1.
export async function stateMsg(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (env.MSG_STATE_STORE !== "d1") return json({ read: [], hidden: [], calls: [] });
  try {
    const [read, hidden, calls] = await Promise.all([
      env.DB_META.prepare("SELECT conv, read_ts FROM msg_read_state WHERE uid=?1").bind(ctx.uid).all(),
      env.DB_META.prepare("SELECT target, hidden FROM msg_hidden WHERE uid=?1 AND hidden=1").bind(ctx.uid).all(),
      env.DB_META.prepare("SELECT entry_id, name, seed, video, dir, ts FROM call_log_d1 WHERE uid=?1 ORDER BY ts DESC LIMIT 500").bind(ctx.uid).all(),
    ]);
    return json({ read: read.results ?? [], hidden: hidden.results ?? [], calls: calls.results ?? [] });
  } catch (e) {
    return json({ error: "state read failed", detail: String(e).slice(0, 200) }, 500);
  }
}

// ---- call log (owner multi-device sync) -------------------------------------
// The call history lives in the caller's OWN InboxDO (same model as /read + /hide:
// the owner's private, multi-device state). A change on any device fans out live
// to the owner's other OPEN sockets via the DO broadcast; for asleep/killed
// devices we ALSO enqueue a SILENT high-priority FCM wake (a single InboxDO serves
// all of the user's devices, so its `live` flag can't tell us which devices are
// asleep — so deletes/clears always wake). The full snapshot on the next /sync is
// the durable backstop.
async function callOp(env: Env, uid: string, op: string, body: Record<string, unknown>): Promise<{ live: boolean }> {
  const stub = env.INBOX.get(env.INBOX.idFromName(uid));
  const res = await stub.fetch(`https://inbox/call/${op}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // Phase 5 (ABLY-R2-5): mirror the call log to D1 (dark, MSG_STATE_STORE=d1).
  if (env.MSG_STATE_STORE === "d1") {
    try {
      if (op === "append") {
        await env.DB_META.prepare(
          `INSERT INTO call_log_d1 (uid, entry_id, name, seed, video, dir, ts)
           VALUES (?1,?2,?3,?4,?5,?6,?7)
           ON CONFLICT(uid, entry_id) DO UPDATE SET name=excluded.name, seed=excluded.seed,
             video=excluded.video, dir=excluded.dir, ts=excluded.ts`,
        ).bind(uid, String(body.entry_id ?? ""), (body.name ?? "") as string, (body.seed ?? "") as string,
          body.video === true ? 1 : 0, String(body.dir ?? "outgoing"), Number(body.ts) || 0).run();
      } else if (op === "delete") {
        await env.DB_META.prepare("DELETE FROM call_log_d1 WHERE uid=?1 AND entry_id=?2")
          .bind(uid, String(body.entry_id ?? "")).run();
      } else if (op === "clear") {
        await env.DB_META.prepare("DELETE FROM call_log_d1 WHERE uid=?1").bind(uid).run();
      }
    } catch { /* best-effort */ }
  }
  try { return (await res.json()) as { live: boolean }; } catch { return { live: false }; }
}

// Wake the owner's OTHER (possibly sleeping) devices so a delete/clear applies in
// realtime instead of only on their next manual open. Silent data push; the app's
// FCM handler queues it and applies on foreground (no banner).
async function wakeOwnDevices(env: Env, uid: string, data: { kind: "call_del"; entry_id: string } | { kind: "call_clear" }): Promise<boolean> {
  try { await env.Q_PUSH.send({ ...data, to: uid }); return true; } catch { return false; /* /sync still reconciles */ }
}

// Rich telemetry so we have eyes on the multi-device call-log fan-out: did the
// change reach the user's other devices LIVE (a socket was open) and/or via an FCM
// WAKE (asleep devices)? `account_id`/`uid` make it pullable per user, alongside
// the standard worker tags used across the codebase.
function trackCallLog(env: Env, uid: string, op: "append" | "delete" | "clear", props: Record<string, unknown>): void {
  try {
    void env.Q_ANALYTICS?.send({
      event: "call_log_sync", uid, ts: Date.now(),
      props: { op, account_id: uid, app_name: "avatok", service_name: "avatok-api", worker: true, ...props },
    });
  } catch { /* telemetry is best-effort, never blocks the op */ }
}

// ---- POST /api/call-log/append  { entry_id, name, seed, video, dir, ts } -----
export async function callLogAppend(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!b.entry_id) return json({ error: "entry_id required" }, 400);
  const r = await callOp(env, ctx.uid, "append", {
    entry_id: String(b.entry_id), name: b.name == null ? "" : String(b.name),
    seed: b.seed == null ? "" : String(b.seed), video: b.video === true,
    dir: String(b.dir ?? "outgoing"), ts: Number(b.ts) || 0,
  });
  // A new entry is not urgent for asleep devices (it shows on their next open/sync),
  // so no FCM wake here — only deletes/clears wake, per the product requirement.
  trackCallLog(env, ctx.uid, "append", { live: r.live, woke_devices: false, video: b.video === true, dir: String(b.dir ?? "outgoing") });
  return json({ ok: true });
}

// ---- POST /api/call-log/delete  { entry_id } --------------------------------
export async function callLogDelete(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!b.entry_id) return json({ error: "entry_id required" }, 400);
  const entryId = String(b.entry_id);
  const r = await callOp(env, ctx.uid, "delete", { entry_id: entryId });
  const woke = await wakeOwnDevices(env, ctx.uid, { kind: "call_del", entry_id: entryId });
  trackCallLog(env, ctx.uid, "delete", { live: r.live, woke_devices: woke, entry_id: entryId });
  return json({ ok: true });
}

// ---- POST /api/call-log/clear  {} -------------------------------------------
export async function callLogClear(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const r = await callOp(env, ctx.uid, "clear", {});
  const woke = await wakeOwnDevices(env, ctx.uid, { kind: "call_clear" });
  trackCallLog(env, ctx.uid, "clear", { live: r.live, woke_devices: woke });
  return json({ ok: true });
}

// ---- conversations ----------------------------------------------------------
export async function convList(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  // Phase 8 — AvaInbox filter: ?context=event|channel|consult|dm|system matches
  // the tag's prefix ("event" hits "event:<listingId>"); untagged threads count as dm.
  const f = (new URL(req.url).searchParams.get("context") || "").replace(/[^a-z]/g, "");
  const where = f
    ? (f === "dm" ? "AND (c.context IS NULL OR c.context='dm')" : `AND c.context LIKE '${f}%'`)
    : "";
  const rows = await env.DB_META.prepare(
    `SELECT c.id, c.kind, c.title, c.avatar_url, c.updated_at, c.context
       FROM conversations c JOIN conversation_members m ON m.conv_id = c.id
      WHERE m.uid = ?1 ${where} ORDER BY c.updated_at DESC LIMIT 500`,
  ).bind(ctx.uid).all();
  return json({ conversations: rows.results || [] });
}

export async function convCreate(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  if (b.to) return json({ conv: await ensureDm(env, ctx.uid, String(b.to), normContext(b.context)), kind: "dm" });
  // group
  const list: string[] = Array.isArray(b.members) ? b.members.map(String) : [];
  if (!list.length) return json({ error: "members or to required" }, 400);
  const conv = "g_" + crypto.randomUUID();
  const now = Date.now();
  const invitees = list.filter((u) => u !== ctx.uid);
  // Pending-membership kill switch (default OFF = current behavior: invitees join
  // immediately). When ON, invitees get a PENDING invite and only become members
  // on Accept — so the router/fan-out is untouched (they aren't members yet).
  const cfg = await readConfig(env);
  const stmts = [
    env.DB_META.prepare("INSERT INTO conversations (id, kind, title, created_by, created_at, updated_at) VALUES (?1,'group',?2,?3,?4,?4)")
      .bind(conv, b.title ? String(b.title) : null, ctx.uid, now),
    env.DB_META.prepare("INSERT OR IGNORE INTO conversation_members (conv_id, uid, role, joined_at) VALUES (?1,?2,'owner',?3)").bind(conv, ctx.uid, now),
    ...(cfg.groupInvitesEnabled ? [] : invitees.map((u) =>
      env.DB_META.prepare("INSERT OR IGNORE INTO conversation_members (conv_id, uid, role, joined_at) VALUES (?1,?2,'member',?3)").bind(conv, u, now))),
  ];
  await env.DB_META.batch(stmts);
  if (cfg.groupInvitesEnabled) await recordGroupInvites(env, conv, ctx.uid, b.title ? String(b.title) : null, invitees);
  try {
    void env.Q_ANALYTICS?.send({ event: "group_created", uid: ctx.uid, ts: Date.now(),
      props: { conv, member_count: list.filter((u) => u !== ctx.uid).length + 1,
        account_id: ctx.uid, app_name: "avatok", service_name: "avatok-api", worker: true } });
  } catch { /* best-effort */ }
  // Notify every invitee (FCM wake + internal notification). Fixes "members
  // aren't told when added to a group" (owner report 2026-06-29).
  await fanGroupInvites(env, ctx.uid, conv, b.title ? String(b.title) : null, list.filter((u) => u !== ctx.uid));
  return json({ conv, kind: "group" });
}

// Adopt a client-side (pre-server-backed) group UP to D1, PRESERVING its id so the
// conv-key / message history stays consistent. Data-loss fix (2026-06-30): old
// builds kept groups local-only, so a reinstall lost them; the client now uploads
// any local-only group here so it becomes durable + restorable. SAFE: if a
// conversation with this id ALREADY exists it is left completely untouched (no
// membership injection into someone else's group) — only brand-new ids are
// created, with the caller as owner. Idempotent.
export async function convAdopt(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const id = String(b.id || "");
  if (!id) return json({ error: "id required" }, 400);
  const existing = await env.DB_META.prepare("SELECT id FROM conversations WHERE id=?1").bind(id).first();
  if (existing) return json({ conv: id, kind: "group", adopted: false, already: true });
  const members: string[] = Array.isArray(b.members) ? b.members.map(String) : [];
  const now = Date.now();
  const stmts = [
    env.DB_META.prepare("INSERT OR IGNORE INTO conversations (id, kind, title, created_by, created_at, updated_at) VALUES (?1,'group',?2,?3,?4,?4)")
      .bind(id, b.title ? String(b.title) : null, ctx.uid, now),
    env.DB_META.prepare("INSERT OR IGNORE INTO conversation_members (conv_id, uid, role, joined_at) VALUES (?1,?2,'owner',?3)").bind(id, ctx.uid, now),
    ...members.filter((u) => u && u !== ctx.uid).map((u) =>
      env.DB_META.prepare("INSERT OR IGNORE INTO conversation_members (conv_id, uid, role, joined_at) VALUES (?1,?2,'member',?3)").bind(id, u, now)),
  ];
  await env.DB_META.batch(stmts);
  return json({ conv: id, kind: "group", adopted: true });
}

// ---- group membership management --------------------------------------------
// These power the Group Info screen: add members (from contacts), remove a
// member, promote/demote admins, leave, and delete the whole group. Membership
// lives in D1 `conversation_members` (role: owner | admin | member) — the SAME
// table the message router fans out from, so an added member immediately starts
// receiving the group's messages (and the offline FCM wake) with no extra wiring.
// The client posts a system announcement message after a successful add so every
// member (incl. the just-added, offline ones) gets a "X added Y" banner.

async function convRoleOf(env: Env, conv: string, uid: string): Promise<string | null> {
  const r = await env.DB_META
    .prepare("SELECT role FROM conversation_members WHERE conv_id=?1 AND uid=?2")
    .bind(conv, uid).first<{ role: string }>();
  return r?.role ?? null;
}

async function convIsGroup(env: Env, conv: string): Promise<boolean> {
  const r = await env.DB_META
    .prepare("SELECT kind FROM conversations WHERE id=?1").bind(conv).first<{ kind: string }>();
  return r?.kind === "group";
}

// Notify newly-added group members: a dedicated FCM "group_invite" wake (taps
// straight into the group + Accept/Decline) AND a row in the internal
// notifications feed (powers the header bell + unread count). Best-effort — a
// notification failure must NEVER fail the group create / add-members call.
async function fanGroupInvites(env: Env, inviterUid: string, conv: string, groupTitle: string | null, invitees: string[]): Promise<void> {
  const list = invitees.filter((u) => u && u !== inviterUid);
  if (!list.length) return;
  const inviterName = (await nameFor(env, inviterUid).catch(() => null)) || "Someone";
  const groupName = (groupTitle && groupTitle.trim()) ? groupTitle.trim() : "a group";
  const now = Date.now();
  for (const uid of list) {
    try {
      await env.DB_META.prepare(
        "INSERT INTO notifications (id, uid, type, title, body, data, read, created_at) VALUES (?1,?2,'group_invite',?3,?4,?5,0,?6)",
      ).bind(crypto.randomUUID(), uid, `${inviterName} added you to ${groupName}`,
        "Tap to open the group.", JSON.stringify({ conv, groupName, from: inviterUid, deeplink: `avatok://group?conv=${conv}` }), now).run();
    } catch { /* notifications table absent / schema drift → best-effort */ }
    try {
      await env.Q_PUSH.send({ kind: "group_invite", to: uid, from: inviterUid, conv, groupName, fromName: inviterName, ts: now });
    } catch { /* best-effort */ }
    // Optional external orchestration (Novu) — no-op unless NOVU_API_KEY is set.
    void novuGroupInvite(env, uid, { inviter: inviterName, groupName, conv });
  }
  try {
    void env.Q_ANALYTICS?.send({ event: "group_invite_sent", uid: inviterUid, ts: now,
      props: { conv, invitees: list.length, account_id: inviterUid, app_name: "avatok", service_name: "avatok-api", worker: true } });
  } catch { /* best-effort */ }
}

// Record PENDING invites (group_invites) when the kill switch is ON, so the
// invitee gets an Accept/Decline prompt and only joins conversation_members on
// Accept. Best-effort — pre-migration this catches and the (off) flag means the
// immediate-membership path ran anyway.
async function recordGroupInvites(env: Env, conv: string, inviter: string, groupTitle: string | null, invitees: string[]): Promise<void> {
  const list = invitees.filter((u) => u && u !== inviter);
  if (!list.length) return;
  const now = Date.now();
  const name = (groupTitle && groupTitle.trim()) ? groupTitle.trim() : null;
  try {
    await env.DB_META.batch(list.map((u) =>
      env.DB_META.prepare(
        "INSERT INTO group_invites (conv, uid, inviter, group_name, status, created_at) VALUES (?1,?2,?3,?4,'pending',?5) " +
        "ON CONFLICT(conv,uid) DO UPDATE SET status='pending', inviter=?3, group_name=?4, created_at=?5",
      ).bind(conv, u, inviter, name, now)));
  } catch { /* table missing (pre-migration) → best-effort */ }
}

function trackGroup(env: Env, uid: string, event: string, props: Record<string, unknown>): void {
  try {
    void env.Q_ANALYTICS?.send({ event, uid, ts: Date.now(),
      props: { ...props, account_id: uid, app_name: "avatok", service_name: "avatok-api", worker: true } });
  } catch { /* best-effort */ }
}

// ---- GET /api/conversations/members?conv=ID ---------------------------------
export async function convMembers(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const conv = new URL(req.url).searchParams.get("conv") || "";
  if (!conv) return json({ error: "conv required" }, 400);
  if (!(await convRoleOf(env, conv, ctx.uid))) return json({ error: "not a member" }, 403);
  const c = await env.DB_META
    .prepare("SELECT title, kind, created_by FROM conversations WHERE id=?1")
    .bind(conv).first<{ title: string | null; kind: string; created_by: string }>();
  const rows = await env.DB_META
    .prepare("SELECT uid, role FROM conversation_members WHERE conv_id=?1")
    .bind(conv).all<{ uid: string; role: string }>();
  return json({
    conv, title: c?.title ?? null, kind: c?.kind ?? null, created_by: c?.created_by ?? null,
    members: rows.results || [],
  });
}

// ---- POST /api/conversations/members/add  { conv, members:[uid] } -----------
export async function convAddMembers(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const conv = String(b.conv || "");
  const add: string[] = Array.isArray(b.members) ? b.members.map(String).filter(Boolean) : [];
  if (!conv || !add.length) return json({ error: "conv and members required" }, 400);
  if (!(await convIsGroup(env, conv))) return json({ error: "not a group" }, 400);
  const myRole = await convRoleOf(env, conv, ctx.uid);
  if (myRole !== "owner" && myRole !== "admin") return json({ error: "forbidden" }, 403);
  const now = Date.now();
  // Pending-membership kill switch (default OFF). When ON, added users get a
  // PENDING invite instead of immediate membership (they join on Accept).
  const cfg = await readConfig(env);
  const stmts = [
    env.DB_META.prepare("UPDATE conversations SET updated_at=?2 WHERE id=?1").bind(conv, now),
    ...(cfg.groupInvitesEnabled ? [] : add.map((u) =>
      env.DB_META.prepare("INSERT OR IGNORE INTO conversation_members (conv_id, uid, role, joined_at) VALUES (?1,?2,'member',?3)").bind(conv, u, now))),
  ];
  await env.DB_META.batch(stmts);
  const grp = await env.DB_META.prepare("SELECT title FROM conversations WHERE id=?1").bind(conv).first<{ title: string | null }>();
  if (cfg.groupInvitesEnabled) await recordGroupInvites(env, conv, ctx.uid, grp?.title ?? null, add);
  trackGroup(env, ctx.uid, "group_members_added", { conv, count: add.length });
  // Notify the newly-added members (FCM wake + internal notification).
  await fanGroupInvites(env, ctx.uid, conv, grp?.title ?? null, add);
  return json({ ok: true, added: add });
}

// ---- GET /api/conversations/invites — my PENDING group invites --------------
export async function convInvites(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  try {
    const rows = await env.DB_META.prepare(
      `SELECT gi.conv, gi.inviter, COALESCE(c.title, gi.group_name) AS group_name, gi.created_at,
              (SELECT COUNT(*) FROM conversation_members m WHERE m.conv_id = gi.conv) AS member_count
         FROM group_invites gi LEFT JOIN conversations c ON c.id = gi.conv
        WHERE gi.uid = ?1 AND gi.status = 'pending'
        ORDER BY gi.created_at DESC LIMIT 100`,
    ).bind(ctx.uid).all();
    return json({ invites: rows.results ?? [] });
  } catch {
    return json({ invites: [] }); // table missing (pre-migration) → empty
  }
}

// ---- POST /api/conversations/invite/respond { conv, accept } ----------------
export async function convInviteRespond(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const conv = String(b.conv || "");
  const accept = b.accept === true;
  if (!conv) return json({ error: "conv required" }, 400);
  const inv = await env.DB_META.prepare("SELECT status FROM group_invites WHERE conv=?1 AND uid=?2").bind(conv, ctx.uid).first<{ status: string }>();
  if (!inv) return json({ error: "no_invite" }, 404);
  const now = Date.now();
  if (accept) {
    // Become a real member → the router now fans group messages to this user.
    await env.DB_META.batch([
      env.DB_META.prepare("INSERT OR IGNORE INTO conversation_members (conv_id, uid, role, joined_at) VALUES (?1,?2,'member',?3)").bind(conv, ctx.uid, now),
      env.DB_META.prepare("UPDATE group_invites SET status='accepted' WHERE conv=?1 AND uid=?2").bind(conv, ctx.uid),
      env.DB_META.prepare("UPDATE conversations SET updated_at=?2 WHERE id=?1").bind(conv, now),
    ]);
    trackGroup(env, ctx.uid, "group_invite_accepted", { conv });
  } else {
    await env.DB_META.batch([
      env.DB_META.prepare("UPDATE group_invites SET status='declined' WHERE conv=?1 AND uid=?2").bind(conv, ctx.uid),
      env.DB_META.prepare("DELETE FROM conversation_members WHERE conv_id=?1 AND uid=?2").bind(conv, ctx.uid),
    ]);
    trackGroup(env, ctx.uid, "group_invite_declined", { conv });
  }
  return json({ ok: true, conv, accepted: accept });
}

// ---- POST /api/conversations/members/remove  { conv, uid } ------------------
export async function convRemoveMember(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const conv = String(b.conv || "");
  const target = String(b.uid || "");
  if (!conv || !target) return json({ error: "conv and uid required" }, 400);
  const myRole = await convRoleOf(env, conv, ctx.uid);
  if (myRole !== "owner" && myRole !== "admin") return json({ error: "forbidden" }, 403);
  const targetRole = await convRoleOf(env, conv, target);
  if (targetRole === "owner") return json({ error: "cannot_remove_owner" }, 400);
  // Admins can't remove other admins; only the owner can.
  if (targetRole === "admin" && myRole !== "owner") return json({ error: "forbidden" }, 403);
  await env.DB_META.prepare("DELETE FROM conversation_members WHERE conv_id=?1 AND uid=?2").bind(conv, target).run();
  await env.DB_META.prepare("UPDATE conversations SET updated_at=?2 WHERE id=?1").bind(conv, Date.now()).run();
  trackGroup(env, ctx.uid, "group_member_removed", { conv, target });
  return json({ ok: true });
}

// ---- POST /api/conversations/members/role  { conv, uid, role } --------------
export async function convSetRole(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const conv = String(b.conv || "");
  const target = String(b.uid || "");
  const role = String(b.role || "");
  if (!conv || !target || (role !== "admin" && role !== "member")) return json({ error: "conv, uid, role required" }, 400);
  const myRole = await convRoleOf(env, conv, ctx.uid);
  if (myRole !== "owner" && myRole !== "admin") return json({ error: "forbidden" }, 403);
  const targetRole = await convRoleOf(env, conv, target);
  if (!targetRole) return json({ error: "not_a_member" }, 404);
  if (targetRole === "owner") return json({ error: "cannot_change_owner" }, 400);
  await env.DB_META.prepare("UPDATE conversation_members SET role=?3 WHERE conv_id=?1 AND uid=?2").bind(conv, target, role).run();
  trackGroup(env, ctx.uid, "group_role_changed", { conv, target, role });
  return json({ ok: true, role });
}

// ---- POST /api/conversations/leave  { conv } -------------------------------
export async function convLeave(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const conv = String(b.conv || "");
  if (!conv) return json({ error: "conv required" }, 400);
  const myRole = await convRoleOf(env, conv, ctx.uid);
  if (!myRole) return json({ ok: true }); // already not a member
  await env.DB_META.prepare("DELETE FROM conversation_members WHERE conv_id=?1 AND uid=?2").bind(conv, ctx.uid).run();
  // If the owner leaves, hand ownership to the next member (oldest join) so the
  // group isn't left admin-less; if nobody remains, drop the empty conversation.
  if (myRole === "owner") {
    const next = await env.DB_META
      .prepare("SELECT uid FROM conversation_members WHERE conv_id=?1 ORDER BY (role='admin') DESC, joined_at ASC LIMIT 1")
      .bind(conv).first<{ uid: string }>();
    if (next?.uid) {
      await env.DB_META.prepare("UPDATE conversation_members SET role='owner' WHERE conv_id=?1 AND uid=?2").bind(conv, next.uid).run();
    } else {
      await env.DB_META.prepare("DELETE FROM conversations WHERE id=?1").bind(conv).run();
    }
  }
  await env.DB_META.prepare("UPDATE conversations SET updated_at=?2 WHERE id=?1").bind(conv, Date.now()).run();
  trackGroup(env, ctx.uid, "group_left", { conv, was_owner: myRole === "owner" });
  return json({ ok: true });
}

// ---- POST /api/conversations/delete  { conv } ------------------------------
// Owner-only hard delete: removes every membership + the conversation row. Other
// members' devices drop the group on their next sync (it stops appearing in their
// conversation list); the client also broadcasts a 'gdel' system message so open
// clients remove it live.
export async function convDelete(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const conv = String(b.conv || "");
  if (!conv) return json({ error: "conv required" }, 400);
  const myRole = await convRoleOf(env, conv, ctx.uid);
  if (myRole !== "owner") return json({ error: "forbidden" }, 403);
  await env.DB_META.batch([
    env.DB_META.prepare("DELETE FROM conversation_members WHERE conv_id=?1").bind(conv),
    env.DB_META.prepare("DELETE FROM conversations WHERE id=?1").bind(conv),
  ]);
  trackGroup(env, ctx.uid, "group_deleted", { conv });
  return json({ ok: true });
}

