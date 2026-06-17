// Ava in-thread turn route (Phase 3 — In-Thread Ava Spine).
//   POST /api/ava/thread/turn   { conv?, to?, text, private? }
//
// Dual-auth (requireUser → Clerk JWT). Validates the request, resolves the
// conversation id (an explicit `conv`, or `to`=peer uid → deterministic DM conv),
// then forwards the turn to the CALLER'S AvaAgentDO. Returns quickly; the actual
// Ava message (and the "working…" chip) are delivered asynchronously via the
// participants' InboxDOs and rendered by the existing chat pipeline.
//
// Also exports `postAvaMessage(...)` — the clean internal helper P6 (companion),
// P8 (guardian) and P9 (image) call to "post an Ava message into conversation X"
// without touching chat UI. It routes through the owner's AvaAgentDO /post op.

import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail, dmConvId } from "../authz";
import { getStoreName } from "../lib/ava_rag";

function agentOf(env: Env, uid: string) {
  return env.AVA_AGENT.get(env.AVA_AGENT.idFromName(uid));
}

// Resolve the conversation id the same way messaging.ts does: an explicit conv,
// or a peer uid (`to`) → deterministic dm conv id.
function resolveConv(uid: string, b: { conv?: unknown; to?: unknown }): string | null {
  if (b.conv) return String(b.conv);
  if (b.to) return dmConvId(uid, String(b.to));
  return null;
}

// ---- POST /api/ava/thread/turn ---------------------------------------------
export async function avaThreadTurn(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const text = String(b.text ?? "").trim();
  if (!text) return json({ error: "text required" }, 400);
  const conv = resolveConv(ctx.uid, b);
  if (!conv) return json({ error: "conv or to required" }, 400);
  const priv = !!b.private;
  // The caller may forward their own Gemini key (free BYO tier) per-request via
  // the same header the /api/ava/gemini proxy uses. We pass it straight to the
  // DO for this turn only — never stored. No key → our-keys Workers-AI fallback.
  const byoKey = (req.headers.get("x-ava-gemini-key") || "").trim();
  // Per-user File Search store name (RAG over the user's own files + chat
  // history, all under THEIR Google key). Prefer an explicit body value; else
  // fall back to the one we remembered in KV when they first ingested. So @ava
  // RAG "just works" with no extra client plumbing once anything is indexed.
  let store = String(b.store ?? "").trim();
  if (!store && byoKey) store = (await getStoreName(env, ctx.uid)) || "";

  // Forward to the caller's per-user agent DO. The DO posts the working chip,
  // runs the loop, and fans the answer out via InboxDO — so this returns fast.
  let out: any = { ok: true };
  try {
    const res = await agentOf(env, ctx.uid).fetch("https://ava-agent/turn", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ conv, uid: ctx.uid, text, private: priv, key: byoKey, store }),
    });
    out = await res.json();
  } catch (e: any) {
    return json({ error: "agent unavailable", detail: String(e?.message ?? e) }, 502);
  }
  return json({ ok: out?.ok !== false, conv, ...(out?.status_id ? { status_id: out.status_id } : {}) });
}

// ---- internal helper: post an Ava message into a conversation ---------------
// DOWNSTREAM API for P6–P9. Drops an Ava turn into a conversation without any
// chat-UI work. The message is authored by the agent runtime owned by `ownerUid`
// (whose InboxDO is read for context if the producing phase ever needs it).
//
//   ownerUid : the user whose AvaAgentDO authors/owns the post (the recipient for
//              a private post; for a thread post, any member works — typically the
//              user the producing phase is acting on behalf of).
//   conv     : the server conversation id (dm_<lo>__<hi> or g_<uuid>).
//   text     : Ava's message text.
//   private  : true → ava_private to ownerUid ONLY (never the other party);
//              false → fan out to every participant as a normal 'ava' bubble.
//   source   : 'guardian' | 'image' | 'companion' | 'delegate' | 'tool' | 'chat'.
//   media_ref/meta : optional (image gen attaches media_ref; meta is free-form).
//
// Returns { ok: boolean }.
export async function postAvaMessage(env: Env, args: {
  ownerUid: string;
  conv: string;
  text: string;
  private?: boolean;
  source?: string;
  media_ref?: string;
  meta?: Record<string, unknown>;
}): Promise<{ ok: boolean; error?: string }> {
  if (!args.ownerUid || !args.conv || !args.text) return { ok: false, error: "ownerUid, conv, text required" };
  try {
    const res = await agentOf(env, args.ownerUid).fetch("https://ava-agent/post", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conv: args.conv, uid: args.ownerUid, text: args.text,
        private: !!args.private, source: args.source ?? "chat",
        media_ref: args.media_ref, meta: args.meta,
      }),
    });
    const out: any = await res.json();
    return { ok: out?.ok !== false, error: out?.error };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
