// AvaBrain Agentic layer routes (Phase 7, §7/§20). Per-app persona isolation;
// agent-to-agent conversations run in ConversationDO (triggered via the agent-tasks
// queue). All dual-auth. The Agent Inbox is the single agent surface.
//   GET  /api/agent/personas            list my personas
//   PUT  /api/agent/personas/:app       upsert a persona (moderated on save)
//   POST /api/agent/converse            start an agent↔agent conversation { app, peer_uid }
//   GET  /api/agent/inbox               my inbox
//   GET  /api/agent/inbox/:id           one inbox item (with transcript)
//   POST /api/agent/approve             approve / dismiss / undo an inbox item { id, action }
//   POST /api/agent/task                enqueue an agent task (generic) { app, kind, ... }
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb, metaSession } from "../db/shard";
import { track } from "../hooks";
import { isSafeText } from "../lib/moderation";

// Persona text is moderated on save with Nemotron (nvidia/nemotron-3.5-content-safety
// via OpenRouter) — replaces the retired @cf/meta/llama-guard-3-8b. Fails OPEN on a
// classifier outage; a confident "unsafe" marks the persona inactive.
async function personaSafe(env: Env, text: string): Promise<boolean> {
  return isSafeText(env, text, "persona");
}

// GET /api/agent/personas
export async function listPersonas(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const rs = await metaSession(env).prepare(
    "SELECT app_name, persona_prompt, looking_for, boundaries, auto_approve, enabled, moderation, updated_at FROM agent_personas WHERE uid=?1",
  ).bind(ctx.uid).all();
  return json({ personas: rs.results ?? [] });
}

// PUT /api/agent/personas/:app  — persona moderated on save (§20.9).
export async function upsertPersona(req: Request, env: Env, app: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.persona_prompt) return json({ error: "persona_prompt required" }, 400);

  const blob = [b.persona_prompt, b.looking_for, b.boundaries].filter(Boolean).join("\n");
  const moderation = (await personaSafe(env, blob)) ? "safe" : "unsafe";

  await metaDb(env).prepare(
    `INSERT INTO agent_personas (uid, app_name, persona_prompt, looking_for, boundaries, auto_approve, enabled, moderation, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
     ON CONFLICT(uid, app_name) DO UPDATE SET persona_prompt=?3, looking_for=?4, boundaries=?5, auto_approve=?6, enabled=?7, moderation=?8, updated_at=?9`,
  ).bind(
    ctx.uid, app, String(b.persona_prompt), b.looking_for ?? null, b.boundaries ?? null,
    b.auto_approve ? 1 : 0, b.enabled === false ? 0 : 1, moderation, Date.now(),
  ).run();

  track(env, ctx.uid, "agent_persona_saved", app, { moderation, auto_approve: !!b.auto_approve });
  if (moderation === "unsafe") return json({ ok: false, moderation, error: "persona failed safety review; not active" }, 422);
  return json({ ok: true, app, moderation });
}

// POST /api/agent/converse { app, peer_uid } — reserve a slot, create the convo, enqueue.
export async function converse(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const app = String(b.app || ""); const peer = String(b.peer_uid || "");
  if (!app || !peer) return json({ error: "app + peer_uid required" }, 400);
  if (peer === ctx.uid) return json({ error: "cannot converse with yourself" }, 400);

  const mine = await metaDb(env).prepare("SELECT enabled, moderation FROM agent_personas WHERE uid=?1 AND app_name=?2").bind(ctx.uid, app).first<any>();
  if (!mine || !mine.enabled || mine.moderation !== "safe") return json({ error: "set up a safe, enabled persona for this app first" }, 400);

  // Rate-limit + neuron-budget reservation (AgentDO).
  const reserve = await env.AGENT_DO.get(env.AGENT_DO.idFromName(ctx.uid)).fetch("https://agent/op", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "reserve", app }),
  });
  const rb = await reserve.json() as any;
  if (!rb.ok) return json({ error: "agent limit reached", reason: rb.reason }, 429);

  const cid = crypto.randomUUID();
  const now = Date.now();
  await metaDb(env).prepare(
    `INSERT INTO agent_conversations (id, uid, app_name, peer_uid, status, turns, created_at, updated_at, expires_at)
     VALUES (?1,?2,?3,?4,'active',0,?5,?5,?6)`,
  ).bind(cid, ctx.uid, app, peer, now, now + 30 * 86_400_000).run();

  // Enqueue the conversation task (runs in ConversationDO via the agent-tasks consumer).
  try { await env.Q_AGENT.send({ type: "converse", conversation_id: cid, uid: ctx.uid, app, peer_uid: peer }); } catch { /* will retry */ }
  track(env, ctx.uid, "agent_conversation_started", app, { remaining: rb.remaining });
  return json({ ok: true, conversation_id: cid, status: "active" });
}

// GET /api/agent/inbox
export async function getInbox(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const rs = await metaSession(env).prepare(
    "SELECT id, app_name, conversation_id, type, title, body, summary, proposed_action, status, undo_until, data, created_at FROM agent_inbox WHERE uid=?1 ORDER BY created_at DESC LIMIT 100",
  ).bind(ctx.uid).all();
  return json({ inbox: rs.results ?? [] });
}

// GET /api/agent/inbox/:id — item + conversation transcript.
export async function getInboxItem(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const item = await metaSession(env).prepare(
    "SELECT id, uid, app_name, conversation_id, type, title, body, summary, proposed_action, status, undo_until, data, created_at FROM agent_inbox WHERE id=?1",
  ).bind(id).first<any>();
  if (!item || item.uid !== ctx.uid) return json({ error: "not found" }, 404);
  let transcript: any = null;
  if (item.conversation_id) {
    const c = await metaDb(env).prepare("SELECT transcript, summary, status, match_score FROM agent_conversations WHERE id=?1").bind(item.conversation_id).first<any>();
    transcript = c ? { transcript: c.transcript ? JSON.parse(c.transcript) : [], summary: c.summary, status: c.status, match_score: c.match_score } : null;
  }
  return json({ item, conversation: transcript });
}

// POST /api/agent/approve { id, action }  action: 'approve'|'dismiss'|'undo'
export async function approveInbox(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const id = String(b.id || ""); const action = String(b.action || "");
  const item = await metaDb(env).prepare("SELECT uid, status, undo_until, proposed_action FROM agent_inbox WHERE id=?1").bind(id).first<any>();
  if (!item || item.uid !== ctx.uid) return json({ error: "not found" }, 404);

  let status: string | null = null;
  if (action === "approve") status = "approved";
  else if (action === "dismiss") status = "dismissed";
  else if (action === "undo") {
    if (item.status !== "auto_approved") return json({ error: "nothing to undo" }, 409);
    if (item.undo_until && Date.now() > item.undo_until) return json({ error: "undo window expired" }, 409);
    status = "undone";
  } else return json({ error: "action must be approve|dismiss|undo" }, 400);

  await metaDb(env).prepare("UPDATE agent_inbox SET status=?2 WHERE id=?1").bind(id, status).run();
  track(env, ctx.uid, "agent_inbox_action", "avabrain", { action, proposed: item.proposed_action });
  return json({ ok: true, status });
}

// POST /api/agent/task — generic agent task enqueue (per-app hooks use this).
export async function agentTask(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.app || !b.kind) return json({ error: "app + kind required" }, 400);
  try { await env.Q_AGENT.send({ type: "task", uid: ctx.uid, app: String(b.app), kind: String(b.kind), payload: b.payload ?? {} }); } catch { return json({ error: "enqueue failed" }, 502); }
  return json({ ok: true, queued: true });
}
