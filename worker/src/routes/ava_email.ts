// ava_email.ts — the in-chat email surface (AvaTOK "Ava inbox" cards). PREMIUM +
// Gmail-connected, Powered by Composio. Returns structured JSON the Flutter
// EmailCard / EmailViewer render directly (list of 5 → view → reply; spam/delete).
// The inbox LIST itself is normally pushed as an Ava bubble by do/ava_agent.ts
// when the user asks "what's in my inbox"; these routes back the per-card actions
// (and an explicit list/get for the client).
//
//   POST /api/ava/email/list   {}                        → { ok, emails:[…] }
//   POST /api/ava/email/get    { id }                    → { ok, body, subject? }
//   POST /api/ava/email/spam   { id }                    → { ok }
//   POST /api/ava/email/trash  { id }                    → { ok }
//   POST /api/ava/email/reply  { threadId, to, body }    → { ok }
//
// Every route emits email-stamped telemetry (ava_email_list / ava_email_action)
// with ok + ms + error so design adoption, Composio speed and failures are all
// traceable in PostHog.

import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { isPremiumAI, premiumUpsell } from "../lib/premium";
import { chargeFeature } from "../feature_pricing";
import { trackUserContact } from "../hooks";
import { contactFor } from "../lib/identity";
import { connectedToolkits } from "../lib/composio";
import {
  fetchInbox, getMessageBody, markSpam, trashMessage, replyThread, toolOk, toolErr,
} from "../lib/gmail";

type Gate = { uid: string; email?: string | null; phone?: string | null };

// Shared premium + Composio gate. Returns the uid (+ contact for telemetry) or a
// ready-to-return Response (auth / not-configured / upsell).
async function gate(req: Request, env: Env): Promise<Gate | Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!env.COMPOSIO_API_KEY) return json({ error: "AvaApps not configured" }, 503);
  const { premium } = await isPremiumAI(req, env, ctx.uid);
  if (!premium) return premiumUpsell(env, ctx.uid, "email");
  const { email, phone } = await contactFor(env, ctx.uid);
  return { uid: ctx.uid, email, phone };
}

async function bodyOf(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}

// POST /api/ava/email/list — the 5 latest inbox emails (structured cards).
export async function avaEmailList(req: Request, env: Env): Promise<Response> {
  const g = await gate(req, env);
  if (g instanceof Response) return g;
  const t0 = Date.now();
  try {
    const connected = await connectedToolkits(env, g.uid);
    if (!connected.includes("gmail")) {
      trackUserContact(env, g.uid, g.email, g.phone, "ava_email_list", "avaemail",
        { ok: false, reason: "gmail_not_connected", ms: Date.now() - t0, surface: "client" });
      return json({ ok: false, error: "gmail_not_connected" }, 409);
    }
    const emails = await fetchInbox(env, g.uid, 5);
    chargeFeature(env, g.uid, "ava_mcp_tool", crypto.randomUUID()).catch(() => ({ ok: false }));
    trackUserContact(env, g.uid, g.email, g.phone, "ava_email_list", "avaemail",
      { ok: true, ms: Date.now() - t0, count: emails.length, surface: "client" });
    return json({ ok: true, emails });
  } catch (e: any) {
    trackUserContact(env, g.uid, g.email, g.phone, "ava_email_list", "avaemail",
      { ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 200), surface: "client" });
    return json({ error: "email list failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
}

// POST /api/ava/email/get — full body for the "View" overlay.
export async function avaEmailGet(req: Request, env: Env): Promise<Response> {
  const g = await gate(req, env);
  if (g instanceof Response) return g;
  const b = await bodyOf(req);
  const id = String(b.id ?? "").trim();
  if (!id) return json({ error: "id required" }, 400);
  const t0 = Date.now();
  try {
    const out = await getMessageBody(env, g.uid, id);
    trackUserContact(env, g.uid, g.email, g.phone, "ava_email_action", "avaemail",
      { action: "get", ok: true, ms: Date.now() - t0 });
    return json({ ok: true, ...out });
  } catch (e: any) {
    trackUserContact(env, g.uid, g.email, g.phone, "ava_email_action", "avaemail",
      { action: "get", ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 200) });
    return json({ error: "email get failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
}

// Shared body for the two label/trash mutations.
async function action(
  req: Request, env: Env, name: "spam" | "trash",
  run: (env: Env, uid: string, id: string) => Promise<any>,
): Promise<Response> {
  const g = await gate(req, env);
  if (g instanceof Response) return g;
  const b = await bodyOf(req);
  const id = String(b.id ?? "").trim();
  if (!id) return json({ error: "id required" }, 400);
  const t0 = Date.now();
  try {
    const r = await run(env, g.uid, id);
    const ok = toolOk(r);
    if (ok) chargeFeature(env, g.uid, "ava_mcp_tool", crypto.randomUUID()).catch(() => ({ ok: false }));
    trackUserContact(env, g.uid, g.email, g.phone, "ava_email_action", "avaemail",
      { action: name, ok, ms: Date.now() - t0, ...(ok ? {} : { error: toolErr(r) }) });
    return ok ? json({ ok: true }) : json({ error: `${name} failed`, detail: toolErr(r) }, 502);
  } catch (e: any) {
    trackUserContact(env, g.uid, g.email, g.phone, "ava_email_action", "avaemail",
      { action: name, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 200) });
    return json({ error: `${name} failed`, detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
}

// POST /api/ava/email/spam — report spam (SPAM label, drop INBOX).
export function avaEmailSpam(req: Request, env: Env): Promise<Response> {
  return action(req, env, "spam", markSpam);
}

// POST /api/ava/email/trash — move to Trash ("Delete").
export function avaEmailTrash(req: Request, env: Env): Promise<Response> {
  return action(req, env, "trash", trashMessage);
}

// POST /api/ava/email/reply — send a reply in-thread, then the client returns to
// the chat (per the design's read → reply → sent → back flow).
export async function avaEmailReply(req: Request, env: Env): Promise<Response> {
  const g = await gate(req, env);
  if (g instanceof Response) return g;
  const b = await bodyOf(req);
  const threadId = String(b.threadId ?? b.thread_id ?? "").trim();
  const to = String(b.to ?? b.recipient ?? "").trim();
  const text = String(b.body ?? "").trim();
  if (!threadId || !to || !text) return json({ error: "threadId, to, body required" }, 400);
  const t0 = Date.now();
  try {
    const r = await replyThread(env, g.uid, { threadId, to, body: text });
    const ok = toolOk(r);
    if (ok) chargeFeature(env, g.uid, "ava_mcp_tool", crypto.randomUUID()).catch(() => ({ ok: false }));
    trackUserContact(env, g.uid, g.email, g.phone, "ava_email_action", "avaemail",
      { action: "reply", ok, ms: Date.now() - t0, body_len: text.length, ...(ok ? {} : { error: toolErr(r) }) });
    return ok ? json({ ok: true }) : json({ error: "reply failed", detail: toolErr(r) }, 502);
  } catch (e: any) {
    trackUserContact(env, g.uid, g.email, g.phone, "ava_email_action", "avaemail",
      { action: "reply", ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 200) });
    return json({ error: "reply failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
}
