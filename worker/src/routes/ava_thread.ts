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
import { track, trackUser } from "../hooks";
import { emailFor, nameFor } from "../lib/identity";
// [AVA-GROUP-SESSION-1] shared public Ava sessions — see lib/ava_group_session.ts
import { readConfig } from "./config";
import { classifySongRequest } from "../lib/song_flow";
import { looksLikeImageRequest, looksLikeVideoRequest } from "../lib/composio";
import {
  readGroupMediaSession, writeGroupMediaSession, touchGroupMediaSession,
  type GroupMediaSession,
} from "../lib/ava_group_session";

async function isConvMember(env: Env, conv: string, uid: string): Promise<boolean> {
  // DMs encode both participants and do not reliably have D1 membership rows.
  if (conv.startsWith("dm_")) {
    const parts = conv.slice(3).split("__");
    return parts.length === 2 && parts.includes(uid);
  }
  try {
    const row = await env.DB_META
      .prepare("SELECT 1 AS ok FROM conversation_members WHERE conv_id = ?1 AND uid = ?2 LIMIT 1")
      .bind(conv, uid).first<{ ok: number }>();
    return !!row;
  } catch {
    return false;
  }
}

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

type RouteTurnProps = {
  conv_kind?: "dm" | "group";
  private?: boolean;
  text_len?: number;
  status: number;
  duration_ms: number;
  error_category?: string;
  do_ok?: boolean;
};

// Route telemetry deliberately knows nothing about raw text or conversation IDs.
// The route schedules these promises on its ExecutionContext; helpers also
// swallow failures so analytics can neither delay nor change the reply.
async function trackRouteTurn(
  env: Env,
  uid: string,
  email: string | null,
  event: string,
  props: RouteTurnProps,
): Promise<void> {
  try { await trackUser(env, uid, email, event, "avaai", props); } catch { /* best-effort */ }
}

async function trackAnonymousRouteTurn(
  env: Env,
  event: string,
  props: RouteTurnProps,
): Promise<void> {
  try { await track(env, "anonymous", event, "avaai", props); } catch { /* best-effort */ }
}

function errorCategory(error: unknown): string {
  const message = String((error as { message?: unknown })?.message ?? error).toLowerCase();
  if (message.includes("timeout") || message.includes("abort")) return "timeout";
  if (message.includes("json")) return "bad_response";
  return "agent_transport";
}

// ---- POST /api/ava/thread/turn ---------------------------------------------
export async function avaThreadTurn(req: Request, env: Env, execCtx: ExecutionContext): Promise<Response> {
  const t0 = Date.now();
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) {
    execCtx.waitUntil(trackAnonymousRouteTurn(env, "ava_thread_route_rejected", {
      status: ctx.status, duration_ms: Date.now() - t0, error_category: "auth",
    }));
    return json({ error: ctx.error }, ctx.status);
  }
  // Email is telemetry-only and cached. Start it now, but never let a lookup
  // failure affect validation or dispatch.
  const emailP = emailFor(env, ctx.uid).catch(() => null);

  let b: any;
  try { b = await req.json(); } catch {
    execCtx.waitUntil(emailP.then((email) => trackRouteTurn(env, ctx.uid, email, "ava_thread_route_rejected", {
      status: 400, duration_ms: Date.now() - t0, error_category: "bad_json",
    })));
    return json({ error: "bad json" }, 400);
  }

  const text = String(b.text ?? "").trim();
  if (!text) {
    execCtx.waitUntil(emailP.then((email) => trackRouteTurn(env, ctx.uid, email, "ava_thread_route_rejected", {
      status: 400, duration_ms: Date.now() - t0, error_category: "text_required",
    })));
    return json({ error: "text required" }, 400);
  }
  const conv = resolveConv(ctx.uid, b);
  if (!conv) {
    execCtx.waitUntil(emailP.then((email) => trackRouteTurn(env, ctx.uid, email, "ava_thread_route_rejected", {
      status: 400, duration_ms: Date.now() - t0, text_len: text.length, error_category: "conversation_required",
    })));
    return json({ error: "conv or to required" }, 400);
  }
  const priv = !!b.private;
  const routeProps = {
    conv_kind: conv.startsWith("g_") ? "group" as const : "dm" as const,
    private: priv,
    text_len: text.length,
  };
  // The caller may forward their own Gemini key (free BYO tier) per-request via
  // the same header the /api/ava/gemini proxy uses. We pass it straight to the
  // DO for this turn only — never stored. No key → our-keys Workers-AI fallback.
  const byoKey = (req.headers.get("x-ava-gemini-key") || "").trim();
  // Per-user File Search store name (RAG over the user's own files + chat
  // history, all under THEIR Google key). Prefer an explicit body value; else
  // fall back to the one we remembered in KV when they first ingested. So @ava
  // RAG "just works" with no extra client plumbing once anything is indexed.
  let store = String(b.store ?? "").trim();
  if (!store && byoKey) store = (await getStoreName(env, ctx.uid).catch(() => null)) || "";

  // [AVA-GROUP-SESSION-1] Public Ava is one shared third participant in the
  // thread. The first public summon anchors conversational state; subsequent
  // public turns from either side use the same AvaAgentDO and recent transcript.
  // Private @ava turns never join the shared session. Membership is verified
  // before any cross-user forward, and the guest's BYO key/store are dropped —
  // the owner's tier governs the shared conversation.
  let targetUid = ctx.uid;
  let speaker: { uid: string; name: string | null } | null = null;
  let activeSession: GroupMediaSession | null = null;
  if (!priv) {
    try {
      const cfg = await readConfig(env);
      if (cfg.groupSharedMediaSessionEnabled === true) {
        activeSession = await readGroupMediaSession(env, conv);
        const requestedKind = classifySongRequest(text) ? "song"
          : looksLikeVideoRequest(text) ? "video"
            : looksLikeImageRequest(text) ? "image" : undefined;
        // A general public-Ava conversation has no payer yet. If another member
        // becomes the first person to request paid media, move the anchor to
        // them before dispatch so their own wallet and approval own that job.
        if (activeSession && !activeSession.media_kind && requestedKind && activeSession.owner_uid !== ctx.uid) {
          const ownerName = await nameFor(env, ctx.uid).catch(() => null);
          await writeGroupMediaSession(env, conv, ctx.uid, ownerName, requestedKind);
          activeSession = {
            owner_uid: ctx.uid, owner_name: ownerName, media_kind: requestedKind,
            started_at: Date.now(), updated_at: Date.now(),
          };
        }
        if (activeSession && !activeSession.media_kind && requestedKind && activeSession.owner_uid === ctx.uid) {
          await writeGroupMediaSession(env, conv, ctx.uid, activeSession.owner_name, requestedKind);
          activeSession = { ...activeSession, media_kind: requestedKind, updated_at: Date.now() };
        }
        if (activeSession && activeSession.owner_uid !== ctx.uid) {
          if (await isConvMember(env, conv, ctx.uid)) {
            targetUid = activeSession.owner_uid;
            speaker = { uid: ctx.uid, name: await nameFor(env, ctx.uid).catch(() => null) };
          }
        } else if (!activeSession) {
          const ownerName = await nameFor(env, ctx.uid).catch(() => null);
          await writeGroupMediaSession(
            env, conv, ctx.uid, ownerName, requestedKind,
          );
          activeSession = {
            owner_uid: ctx.uid, owner_name: ownerName, media_kind: requestedKind,
            started_at: Date.now(), updated_at: Date.now(),
          };
        } else if (activeSession) {
          await touchGroupMediaSession(env, conv, activeSession);
        }
        if (speaker && activeSession) await touchGroupMediaSession(env, conv, activeSession);
        if (speaker) {
          execCtx.waitUntil(emailP.then((email) => trackRouteTurn(env, ctx.uid, email, "ava_group_media_session", {
            ...routeProps, status: 202, duration_ms: Date.now() - t0,
          })));
        }
      }
    } catch { /* session routing is best-effort — fall back to the caller's own agent */ }
  }

  // Forward to the target agent DO. The DO posts the working chip,
  // runs the loop, and fans the answer out via InboxDO — so this returns fast.
  execCtx.waitUntil(emailP.then((email) => trackRouteTurn(env, ctx.uid, email, "ava_thread_route_accepted", {
    ...routeProps, status: 202, duration_ms: Date.now() - t0,
  })));
  let out: any = { ok: true };
  try {
    const initiator = activeSession
      ? {
          uid: activeSession.owner_uid,
          name: activeSession.owner_name ?? await nameFor(env, activeSession.owner_uid).catch(() => null),
          mediaKind: activeSession.media_kind,
        }
      : undefined;
    const body = speaker
      ? {
          conv, uid: targetUid, text, private: false, key: "", store: "", speaker,
          initiator,
        }
      : { conv, uid: ctx.uid, text, private: priv, key: byoKey, store, initiator };
    const res = await agentOf(env, targetUid).fetch("https://ava-agent/turn", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    out = await res.json();
    // If an active media interview identifies a real topic switch, retry on the
    // SAME shared agent with media lanes bypassed. Never fall back to a separate
    // personal Ava: that loses the thread transcript and turns Ava into a
    // messenger between participants.
    if (speaker && out?.deferred_to_speaker) {
      const res2 = await agentOf(env, targetUid).fetch("https://ava-agent/turn", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, forceGeneral: true }),
      });
      out = await res2.json();
    }
    const ok = res.ok && out?.ok !== false;
    execCtx.waitUntil(emailP.then((email) => trackRouteTurn(env, ctx.uid, email, "ava_thread_route_dispatch_result", {
      ...routeProps, status: res.status, duration_ms: Date.now() - t0, do_ok: ok,
      ...(!ok ? { error_category: out?.error ? errorCategory(out.error) : "agent_response" } : {}),
    })));
  } catch (e: any) {
    execCtx.waitUntil(emailP.then((email) => trackRouteTurn(env, ctx.uid, email, "ava_thread_route_dispatch_result", {
      ...routeProps, status: 502, duration_ms: Date.now() - t0, do_ok: false, error_category: errorCategory(e),
    })));
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
  /** Optional durable InboxDO idempotency key for retried internal posts. */
  client_id?: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!args.ownerUid || !args.conv || !args.text) return { ok: false, error: "ownerUid, conv, text required" };
  try {
    const res = await agentOf(env, args.ownerUid).fetch("https://ava-agent/post", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conv: args.conv, uid: args.ownerUid, text: args.text,
        private: !!args.private, source: args.source ?? "chat",
        media_ref: args.media_ref, meta: args.meta, client_id: args.client_id,
      }),
    });
    const out: any = await res.json();
    return { ok: out?.ok !== false, error: out?.error };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
