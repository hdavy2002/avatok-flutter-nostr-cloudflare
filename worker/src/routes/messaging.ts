// Messaging routes (Cloudflare-native, Nostr deprecated). The avatok-api Worker
// is the ROUTER: it authenticates (Clerk JWT), gates (KYC + block), assigns the
// message via each member's InboxDO, pushes live or enqueues FCM when offline.
// Messages are server-readable plaintext (TLS in transit) — no E2E, by design,
// so moderation/reporting can operate.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, kycVerified, blocks, dmConvId, isFail } from "../authz";

// ---- WebSocket: client live socket → the caller's InboxDO --------------------
export async function wsInbox(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return new Response(ctx.error, { status: ctx.status });
  const stub = env.INBOX.get(env.INBOX.idFromName(ctx.uid));
  return stub.fetch("https://inbox/ws", req);
}

// ---- helpers ----------------------------------------------------------------
async function members(env: Env, conv: string): Promise<string[]> {
  const rows = await env.DB_META
    .prepare("SELECT uid FROM conversation_members WHERE conv_id = ?1")
    .bind(conv).all<{ uid: string }>();
  return (rows.results || []).map((r) => r.uid);
}

async function ensureDm(env: Env, a: string, b: string): Promise<string> {
  const conv = dmConvId(a, b);
  const now = Date.now();
  await env.DB_META.batch([
    env.DB_META.prepare(
      "INSERT OR IGNORE INTO conversations (id, kind, created_by, created_at, updated_at) VALUES (?1,'dm',?2,?3,?3)",
    ).bind(conv, a, now),
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

async function pushOffline(env: Env, toUid: string, fromUid: string, conv: string, preview: string): Promise<void> {
  try {
    const toks = await env.DB_META
      .prepare("SELECT platform, token FROM push_tokens_v2 WHERE uid = ?1")
      .bind(toUid).all<{ platform: string; token: string }>();
    if (!toks.results?.length) return;
    await env.Q_PUSH.send({
      kind: "dm", to_uid: toUid, from_uid: fromUid, conv, preview: preview.slice(0, 140),
      tokens: toks.results,
    });
  } catch { /* best-effort; never block the send */ }
}

// ---- POST /api/msg/send -----------------------------------------------------
export async function sendMsg(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!(await kycVerified(env, ctx.uid))) return json({ error: "kyc required" }, 403);

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
    conv = await ensureDm(env, ctx.uid, String(b.to));
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

  // Append to the sender's own log first (its id anchors the client's cursor).
  const mine = await appendTo(env, ctx.uid, payload);

  // Fan out to every other member, honouring blocks; push FCM when offline.
  for (const m of mem) {
    if (m === ctx.uid) continue;
    if (await blocks(env, m, ctx.uid)) {
      if (mem.length === 2) return json({ error: "blocked" }, 403);
      continue; // group: silently skip a member who blocked the sender
    }
    const r = await appendTo(env, m, payload);
    if (!r.live) await pushOffline(env, m, ctx.uid, conv, text || "[media]");
  }

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

// ---- conversations ----------------------------------------------------------
export async function convList(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const rows = await env.DB_META.prepare(
    `SELECT c.id, c.kind, c.title, c.avatar_url, c.updated_at
       FROM conversations c JOIN conversation_members m ON m.conv_id = c.id
      WHERE m.uid = ?1 ORDER BY c.updated_at DESC LIMIT 500`,
  ).bind(ctx.uid).all();
  return json({ conversations: rows.results || [] });
}

export async function convCreate(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  if (b.to) return json({ conv: await ensureDm(env, ctx.uid, String(b.to)), kind: "dm" });
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

// ---- guarded self-test (server-side verification without a Clerk JWT) -------
// Exercises ensureDm → appendTo(recipient) → InboxDO sync. Gated on a secret
// header; no-op unless SELFTEST_KEY is set and matches. Removed in housekeeping.
export async function selfTest(req: Request, env: Env): Promise<Response> {
  if (!env.SELFTEST_KEY || req.headers.get("x-selftest") !== env.SELFTEST_KEY) {
    return json({ error: "not found" }, 404);
  }
  const a = "selftest_alice", b = "selftest_bob";
  const conv = await ensureDm(env, a, b);
  const created = Date.now();
  const clientId = "ct_" + created;
  const payload = { conv, sender: a, kind: "text", body: "hello from selftest", media_ref: null, client_id: clientId, created_at: created };
  const mine = await appendTo(env, a, payload);
  const theirs = await appendTo(env, b, payload);
  const stub = env.INBOX.get(env.INBOX.idFromName(b));
  const synced = await (await stub.fetch("https://inbox/sync?cursor=0")).json<any>();
  const got = (synced.messages || []).find((m: any) => m.client_id === clientId);
  return json({
    ok: !!got, conv, sender_id: mine.id, recipient_id: theirs.id,
    recipient_synced: got || null, recipient_msg_count: (synced.messages || []).length,
  });
}
