// Messaging routes (Cloudflare-native, Nostr deprecated). The avatok-api Worker
// is the ROUTER: it authenticates (Clerk JWT), gates (KYC + block), assigns the
// message via each member's InboxDO, pushes live or enqueues FCM when offline.
// Messages are server-readable plaintext (TLS in transit) — no E2E, by design,
// so moderation/reporting can operate.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, kycVerified, dmConvId, isFail } from "../authz";
import { delegateScan } from "./ava_delegate";   // P7 — Phase 11 hook
import { guardianScan } from "./ava_guardian";    // P8 — Phase 11 hook

// ---- WebSocket: client live socket → the caller's InboxDO --------------------
export async function wsInbox(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return new Response(ctx.error, { status: ctx.status });
  const stub = env.INBOX.get(env.INBOX.idFromName(ctx.uid));
  return stub.fetch("https://inbox/ws", req);
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
      `SELECT uid FROM blocks WHERE blocked_npub = ?1 AND uid IN (${chunk.map((_, j) => `?${j + 2}`).join(",")})`,
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

async function pushOffline(env: Env, toUid: string, _fromUid: string, _conv: string, _preview: string): Promise<void> {
  // Reuse the consumer's proven high-priority 'notify' path (fcm.ts looks up the
  // recipient's tokens in push_tokens_v2 by uid and wakes the device).
  try {
    await env.Q_PUSH.send({ kind: "notify", to: toUid, fromName: "AvaTOK" });
  } catch { /* best-effort; never block the send */ }
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
  const payload = { conv, sender: ctx.uid, kind, body: text, media_ref: mediaRef, client_id: clientId, created_at: created };

  // Blocks: ONE chunked query for all members (was a D1 round-trip per member).
  const others = mem.filter((m) => m !== ctx.uid);
  const blockers = await blockersOf(env, ctx.uid, others);
  if (others.length === 1 && blockers.has(others[0])) return json({ error: "blocked" }, 403);
  const recipients = others.filter((m) => !blockers.has(m)); // group: silently skip blockers

  // Append to the sender's own log first (its id anchors the client's cursor).
  const mine = await appendTo(env, ctx.uid, payload);

  if (recipients.length <= FANOUT_SYNC_MAX) {
    // Small fan-out: deliver in PARALLEL (was sequential awaits).
    await Promise.all(recipients.map(async (m) => {
      const r = await appendTo(env, m, payload);
      if (!r.live) await pushOffline(env, m, ctx.uid, conv, text || "[media]");
    }));
  } else {
    // Large fan-out: hand to Queues — consumers append to each InboxDO + FCM
    // offline. The router NEVER loops >FANOUT_SYNC_MAX synchronous DO calls.
    const sends: Promise<unknown>[] = [];
    for (let i = 0; i < recipients.length; i += FANOUT_QUEUE_CHUNK) {
      sends.push(env.Q_PUSH.send({
        kind: "fanout", payload, recipients: recipients.slice(i, i + FANOUT_QUEUE_CHUNK),
      }));
    }
    await Promise.all(sends);
  }

  // Phase 9 — AvaBrain ingestion producer (best-effort; consumer re-checks the
  // guardrails). Sender + each recipient (≤ sync cap) get the message indexed
  // into THEIR OWN brain. Voice notes (kind=audio) get Whisper-transcribed.
  try {
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

  return json({ id: mine.id, conv, created_at: created });
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
  await stub.fetch("https://inbox/hide", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ conv: String(b.conv), target: String(b.target), hidden: b.hidden === true }),
  });
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
  const stmts = [
    env.DB_META.prepare("INSERT INTO conversations (id, kind, title, created_by, created_at, updated_at) VALUES (?1,'group',?2,?3,?4,?4)")
      .bind(conv, b.title ? String(b.title) : null, ctx.uid, now),
    env.DB_META.prepare("INSERT OR IGNORE INTO conversation_members (conv_id, uid, role, joined_at) VALUES (?1,?2,'owner',?3)").bind(conv, ctx.uid, now),
    ...list.filter((u) => u !== ctx.uid).map((u) =>
      env.DB_META.prepare("INSERT OR IGNORE INTO conversation_members (conv_id, uid, role, joined_at) VALUES (?1,?2,'member',?3)").bind(conv, u, now)),
  ];
  await env.DB_META.batch(stmts);
  return json({ conv, kind: "group" });
}

