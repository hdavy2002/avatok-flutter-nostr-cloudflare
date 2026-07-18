// /api/brain/* — thin auth + router to the caller's UserBrain DO. Every route is
// dual-auth (NIP-98 + Clerk when enabled); uid comes from the signature, so a
// user can only ever reach their OWN brain. The DO does the real work.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";

async function toBrain(env: Env, uid: string, payload: Record<string, unknown>): Promise<Response> {
  const stub = env.USER_BRAIN.get(env.USER_BRAIN.idFromName(uid));
  const res = await stub.fetch("https://brain/op", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid, ...payload }),
  });
  // Pass the DO's JSON straight through (adds CORS via json()).
  const data = await res.json().catch(() => ({ error: "brain error" }));
  return json(data, res.status);
}

export async function brain(req: Request, env: Env, op: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = ctx.uid;

  // --- Phase 9: AvaChat — RAG chat over the user's own content -------------
  // POST /api/brain/chat {message, conversationId?} → {answer, sources}.
  // History rides in the user's own InboxDO under conv 'brain' (no new store).
  if (op === "chat" && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as any;
    const message = String(b.message || "").trim().slice(0, 4000);
    if (!message) return json({ error: "message required" }, 400);
    const stub = env.USER_BRAIN.get(env.USER_BRAIN.idFromName(uid));
    const res = await stub.fetch("https://brain/op", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ uid, op: "chat", message }),
    });
    const data = (await res.json().catch(() => ({ answer: "Something went wrong — try again.", sources: [] }))) as any;
    // Persist both turns to the user's InboxDO (conv 'brain') — best-effort.
    try {
      const inbox = env.INBOX.get(env.INBOX.idFromName(uid));
      const now = Date.now();
      await inbox.fetch("https://inbox/append", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ conv: "brain", sender: uid, owner: uid, kind: "text", body: message, created_at: now }),
      });
      await inbox.fetch("https://inbox/append", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conv: "brain", sender: "brain", owner: uid, kind: "brain",
          body: JSON.stringify({ text: data.answer ?? "", sources: data.sources ?? [] }).slice(0, 16_000),
          created_at: now + 1,
        }),
      });
    } catch { /* history is best-effort */ }
    return json({ answer: data.answer ?? "", sources: data.sources ?? [] });
  }

  // GET /api/brain/history — the AvaChat transcript (conv 'brain' in InboxDO).
  if (op === "history" && req.method === "GET") {
    try {
      const inbox = env.INBOX.get(env.INBOX.idFromName(uid));
      const res = await inbox.fetch("https://inbox/sync?cursor=0");
      const data = (await res.json()) as any;
      const msgs = ((data.messages ?? []) as any[]).filter((m) => m.conv === "brain").slice(-200);
      return json({ messages: msgs });
    } catch { return json({ messages: [] }); }
  }

  // POST /api/brain/purge — "Delete my AvaBrain data" (vectors + transcripts +
  // graph). Queued: the wipe touches Vectorize in batches.
  if (op === "purge" && req.method === "POST") {
    try { await env.Q_BRAIN.send({ uid, event_type: "purge", source_app: "avabrain", payload: {} }); } catch { return json({ error: "queue unavailable" }, 503); }
    return json({ ok: true, queued: true });
  }

  // POST /api/brain/delete_all — the stateful deletion contract (§5.1). Inserts a
  // brain_deletions row (state 'pending') and enqueues the async deletion job, which
  // wipes every store idempotently and drives the row to 'complete' (with a per-store
  // counts audit) or pins it at 'partial' + alerts. Optional body {domains:[...]} to
  // scope the deletion; absent → everything. Returns {id, state}.
  if (op === "delete_all" && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as any;
    const id = crypto.randomUUID();
    const now = Date.now();
    const targets = Array.isArray(b.domains) && b.domains.length ? b.domains.map((d: any) => String(d)) : "all";
    try {
      await env.DB_BRAIN.prepare(
        `INSERT INTO brain_deletions (id, uid, requested_at, targets, state, attempts, counts, completed_at)
         VALUES (?1,?2,?3,?4,'pending',0,NULL,NULL)`,
      ).bind(id, uid, now, JSON.stringify(targets)).run();
    } catch { return json({ error: "deletion store unavailable" }, 503); }
    try { await env.Q_BRAIN.send({ uid, event_type: "delete_all", source_app: "avabrain", payload: { deletionId: id, targets } }); }
    catch { /* row is 'pending'; a redrive/cron can still pick it up */ }
    // Telemetry — pullable by the user's email (uid maps to the PostHog person).
    try {
      await env.Q_ANALYTICS?.send({
        event: "brain_deletion_requested", uid, ts: now,
        props: { deletion_id: id, targets, app_name: "avatok", service_name: "avatok-api", worker: true, account_id: uid },
      });
    } catch { /* best-effort */ }
    return json({ id, state: "pending" });
  }

  // GET|POST /api/brain/delete_status — the latest deletion for this uid (§5.1
  // audit). Returns {id, state, requested_at, completed_at, counts}; 'none' if never.
  // POST is accepted too so the op works the moment the index regex allows the
  // underscore, without also needing the GET/readOp allowlist widened (see report).
  if (op === "delete_status" && (req.method === "GET" || req.method === "POST")) {
    const row = await env.DB_BRAIN.prepare(
      "SELECT id, state, requested_at, completed_at, counts FROM brain_deletions WHERE uid=?1 ORDER BY requested_at DESC LIMIT 1",
    ).bind(uid).first<any>().catch(() => null);
    if (!row) return json({ id: null, state: "none", requested_at: null, completed_at: null, counts: null });
    let counts: unknown = null;
    try { counts = row.counts ? JSON.parse(row.counts) : null; } catch { counts = null; }
    return json({ id: row.id, state: row.state, requested_at: row.requested_at, completed_at: row.completed_at, counts });
  }

  // POST /api/brain/backfill — admin-triggered re-index of existing history.
  // Body {uid?} lets an admin backfill another user; self-serve backfills self.
  if (op === "backfill" && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as any;
    const admins = (env.ADMIN_UIDS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const target = b.uid && admins.includes(uid) ? String(b.uid) : uid;
    try { await env.Q_BRAIN.send({ uid: target, event_type: "backfill", source_app: "avabrain", payload: {} }); } catch { return json({ error: "queue unavailable" }, 503); }
    return json({ ok: true, queued: true, uid: target });
  }

  // --- consent toggles (server-readable booleans; default ON when a row is absent) ---
  // 'settings' is the Phase-9 alias the AvaBrain guardrails screen uses (GET/PUT).
  if (op === "consent" || op === "settings") {
    if (req.method === "GET") {
      const rs = await env.DB_BRAIN.prepare("SELECT capability, enabled FROM brain_consent WHERE uid=?1").bind(uid).all();
      const out: Record<string, boolean> = {};
      for (const r of (rs.results ?? []) as any[]) out[r.capability] = Number(r.enabled) === 1;
      return json({ consent: out }); // anything absent = default ON (opt-out model)
    }
    // POST { capability, enabled }  OR  { toggles: { cap: bool, ... } }
    const cb = (await req.json().catch(() => ({}))) as any;
    const entries: Array<[string, boolean]> = cb.toggles && typeof cb.toggles === "object"
      ? Object.entries(cb.toggles).map(([k, v]) => [String(k), !!v])
      : (cb.capability ? [[String(cb.capability), !!cb.enabled]] : []);
    if (!entries.length) return json({ error: "capability required" }, 400);
    const now = Date.now();
    await env.DB_BRAIN.batch(entries.map(([cap, en]) =>
      env.DB_BRAIN.prepare(
        `INSERT INTO brain_consent (uid, capability, enabled, updated_at) VALUES (?1,?2,?3,?4)
         ON CONFLICT(uid, capability) DO UPDATE SET enabled=?3, updated_at=?4`,
      ).bind(uid, cap, en ? 1 : 0, now)));
    // §5.1 (One Brain B0): toggling a capability OFF ALWAYS retro-deletes the
    // already-indexed data for it — NO LONGER env-gated. One retro_delete job per
    // capability turned off (vectors + transcripts + derived facts).
    for (const [cap, en] of entries) {
      if (!en && cap !== "master") {
        try { void env.Q_BRAIN.send({ uid, event_type: "retro_delete", source_app: "avabrain", payload: { capability: cap } }); } catch { /* best-effort */ }
      }
    }
    return json({ ok: true });
  }

  // Reads (GET) carry no body.
  if (op === "entities" || op === "timeline") return toBrain(env, uid, { op });

  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  switch (op) {
    case "ask": return toBrain(env, uid, { op, question: b.question });
    case "briefing": return toBrain(env, uid, { op });
    // One Brain B4 (§6, §8-B4): POST /api/brain/recall {query, domains?, k?} →
    // {hits:[{text, domain, scope:'account_private', score, ts}]}. Server-lane
    // only; the device lane is merged client-side (B4-app).
    case "recall": return toBrain(env, uid, { op, query: b.query, domains: b.domains, k: b.k });
    case "remember": return toBrain(env, uid, { op, facts: b.facts, entities: b.entities });
    case "investigate": return toBrain(env, uid, { op, complaint: b.complaint });
    case "forget": return toBrain(env, uid, { op, entity_id: b.entity_id });
    default: return json({ error: "unknown brain op" }, 404);
  }
}
