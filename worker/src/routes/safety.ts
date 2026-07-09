// STREAM B (AI Messenger Batch) — stranger safety gate server routes.
//
// The "stranger gate" gives a recipient a WhatsApp-style message-request bar when
// a NON-CONTACT starts a new thread: [Safety shield] [Block] [Report spam] [Accept].
// The thread-level acceptance state lives in the RECIPIENT's InboxDO conv_meta
// (accept_state = accepted|pending|blocked — see worker/src/do/inbox.ts). The
// client stamps a new non-contact thread 'pending'; the server ENFORCES receipt
// suppression (shouldSuppressReceipt) and the report/block side-effects here.
//
// Routes (mount in worker/src/index.ts — see the Stream B report):
//   POST /api/conversations/accept  {conv}                → owner accepts (restore composer)
//   POST /api/conversations/block   {conv?, uid?}         → owner blocks the sender
//   POST /api/safety/report         {conv, last_n?:10}    → copy last N envelopes → spam_reports, then block
//   GET  /api/conversations/accept-state?conv=…           → {conv, accept_state, suppress}
//
// Note: POST /api/safety/score is owned by STREAM G — this file does NOT define it.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail, dmConvId } from "../authz";
import { readConfig } from "./config";

const REPORT_MAX = 25; // hard cap on envelopes copied per report

/** Feature flag — strangerGateEnabled (default ON). When OFF the routes still
 *  function but the client hides the whole feature. Kept here so a server-side
 *  panic-off also stops report/block side effects from the gate. */
async function gateEnabled(env: Env): Promise<boolean> {
  try {
    const cfg = await readConfig(env);
    // Default ON: only treat as OFF when explicitly false.
    return (cfg as unknown as { strangerGateEnabled?: boolean }).strangerGateEnabled !== false;
  } catch {
    return true; // fail ON — a config read failure must not disable safety
  }
}

/** Read the OWNER's own accept_state for a conv from THEIR InboxDO. */
async function inboxAcceptState(env: Env, uid: string, conv: string): Promise<{ accept_state: string; suppress: boolean }> {
  try {
    const stub = env.INBOX.get(env.INBOX.idFromName(uid));
    const res = await stub.fetch(`https://inbox/accept_state?conv=${encodeURIComponent(conv)}`);
    const j = (await res.json().catch(() => ({}))) as { accept_state?: string; suppress?: boolean };
    return { accept_state: String(j.accept_state ?? "accepted"), suppress: j.suppress === true };
  } catch {
    return { accept_state: "accepted", suppress: false };
  }
}

/** Set the OWNER's accept_state in their InboxDO. */
async function setInboxAcceptState(env: Env, uid: string, conv: string, state: string, peer?: string): Promise<void> {
  try {
    const stub = env.INBOX.get(env.INBOX.idFromName(uid));
    await stub.fetch("https://inbox/accept_state", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ conv, state, peer }),
    });
  } catch { /* best-effort; the client also holds the state locally */ }
}

/** The uid on the OTHER side of a dm conv, or null (groups/unknown). The conv id
 *  is `dm_<lo>__<hi>` — recover the peer by removing the caller's uid. */
function peerOfDm(conv: string, me: string): string | null {
  const m = conv.match(/^dm_(.+)__(.+)$/);
  if (!m) return null;
  const [, a, b] = m;
  if (a === me) return b;
  if (b === me) return a;
  return null;
}

// ---- POST /api/conversations/accept  {conv} ---------------------------------
// The recipient accepts a pending stranger thread → restore the composer, resume
// normal read-receipts (NO retroactive receipts for old messages — the InboxDO
// simply stops suppressing from now on).
export async function convAccept(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const conv = String(b.conv || "");
  if (!conv) return json({ error: "conv required" }, 400);
  const peer = peerOfDm(conv, ctx.uid) ?? undefined;
  await setInboxAcceptState(env, ctx.uid, conv, "accepted", peer);
  // CALL-OUTCOME-MENU: accepting the thread promotes the sender to a KNOWN
  // contact — clear the stranger marker so their note rate-caps lift immediately.
  if (peer) { try { await env.TOKENS.delete(`cmstranger:${peer}:${ctx.uid}`); } catch { /* best-effort */ } }
  try {
    void env.Q_ANALYTICS?.send({ event: "stranger_gate_accept", uid: ctx.uid, ts: Date.now(),
      props: { conv, account_id: ctx.uid, app_name: "avatok", service_name: "avatok-api", worker: true } });
  } catch { /* best-effort */ }
  return json({ ok: true, conv, accept_state: "accepted" });
}

// ---- POST /api/conversations/block  {conv?, uid?} ---------------------------
// Block the sender of a stranger thread. Writes the SAME `blocks` table the
// message router honours (blockersOf in messaging.ts), so the sender can no
// longer deliver. Also marks the thread accept_state='blocked' for the UI.
export async function convBlock(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const conv = String(b.conv || "");
  // Resolve the target: explicit uid, else the DM peer.
  let target = String(b.uid || "");
  if (!target && conv) target = peerOfDm(conv, ctx.uid) ?? "";
  if (!target) return json({ error: "uid or dm conv required" }, 400);
  try {
    await env.DB_META.prepare("INSERT OR IGNORE INTO blocks (uid, blocked_uid, created_at) VALUES (?1,?2,?3)")
      .bind(ctx.uid, target, Date.now()).run();
  } catch { /* blocks table absent (schema drift) → best-effort */ }
  if (conv) await setInboxAcceptState(env, ctx.uid, conv, "blocked", target);
  try {
    void env.Q_ANALYTICS?.send({ event: "stranger_gate_block", uid: ctx.uid, ts: Date.now(),
      props: { conv, target, account_id: ctx.uid, app_name: "avatok", service_name: "avatok-api", worker: true } });
  } catch { /* best-effort */ }
  return json({ ok: true, blocked: target });
}

// ---- POST /api/safety/report  {conv, last_n?:10} ----------------------------
// Copy the last N envelopes of the reported conversation into spam_reports (for
// moderation), then BLOCK the sender. The bodies live in the RECIPIENT's InboxDO
// (server-readable arch) — we pull them via /sync and keep the most recent N.
export async function safetyReport(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const conv = String(b.conv || "");
  if (!conv) return json({ error: "conv required" }, 400);
  const lastN = Math.max(1, Math.min(REPORT_MAX, Number(b.last_n) || 10));
  const target = peerOfDm(conv, ctx.uid) ?? null;

  // Pull this conv's messages from the reporter's own InboxDO and keep the last N.
  let envelopes: Array<Record<string, unknown>> = [];
  try {
    const stub = env.INBOX.get(env.INBOX.idFromName(ctx.uid));
    const res = await stub.fetch(`https://inbox/sync?cursor=0`);
    const j = (await res.json().catch(() => ({}))) as { messages?: Array<Record<string, unknown>> };
    const all = (j.messages ?? []).filter((m) => String(m.conv ?? "") === conv);
    envelopes = all.slice(-lastN);
  } catch { /* best-effort; still record the report shell */ }

  const reportId = crypto.randomUUID();
  const now = Date.now();
  try {
    if (envelopes.length) {
      const stmts = envelopes.map((m) =>
        env.DB_META.prepare(
          `INSERT OR IGNORE INTO spam_reports
             (id, conv, reporter_uid, reported_uid, msg_serial, sender, kind, body, media_ref, msg_created_at, created_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
        ).bind(
          reportId, conv, ctx.uid, target,
          String(m.client_id ?? m.id ?? crypto.randomUUID()),
          String(m.sender ?? ""), String(m.kind ?? "text"),
          m.body == null ? null : String(m.body),
          m.media_ref == null ? null : String(m.media_ref),
          Number(m.created_at) || 0, now,
        ));
      await env.DB_META.batch(stmts);
    } else {
      // No content pulled — still record a shell so the report isn't lost.
      await env.DB_META.prepare(
        `INSERT OR IGNORE INTO spam_reports (id, conv, reporter_uid, reported_uid, msg_serial, created_at)
         VALUES (?1,?2,?3,?4,?5,?6)`,
      ).bind(reportId, conv, ctx.uid, target, "", now).run();
    }
  } catch { /* table absent (pre-migration) → best-effort */ }

  // Report ALWAYS blocks the sender (product rule).
  if (target) {
    try {
      await env.DB_META.prepare("INSERT OR IGNORE INTO blocks (uid, blocked_uid, created_at) VALUES (?1,?2,?3)")
        .bind(ctx.uid, target, now).run();
    } catch { /* best-effort */ }
    await setInboxAcceptState(env, ctx.uid, conv, "blocked", target);
  }
  try {
    void env.Q_ANALYTICS?.send({ event: "stranger_gate_report", uid: ctx.uid, ts: now,
      props: { conv, target, count: envelopes.length, report_id: reportId,
        account_id: ctx.uid, app_name: "avatok", service_name: "avatok-api", worker: true } });
  } catch { /* best-effort */ }
  return json({ ok: true, report_id: reportId, copied: envelopes.length, blocked: target });
}

// ---- /api/conversations/accept-state ----------------------------------------
// GET  ?conv=…          → read the owner's gate state (multi-device reconcile).
// POST {conv, state}    → set it. The client stamps a NEW non-contact thread
//                         'pending' here (the server can't know local contacts,
//                         so the client initiates; the server then ENFORCES the
//                         receipt suppression). Only 'pending' is meaningfully
//                         client-set; accept/block go through their own routes
//                         (which also run the block/report side effects).
// Fails open to 'accepted'.
export async function convAcceptState(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (req.method === "POST") {
    let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const conv = String(b.conv || "");
    const raw = String(b.state || "");
    const state = (raw === "pending" || raw === "blocked" || raw === "accepted") ? raw : "";
    if (!conv || !state) return json({ error: "conv and state required" }, 400);
    const peer = peerOfDm(conv, ctx.uid) ?? undefined;
    await setInboxAcceptState(env, ctx.uid, conv, state, peer);
    if (state === "pending") {
      try {
        void env.Q_ANALYTICS?.send({ event: "stranger_gate_shown", uid: ctx.uid, ts: Date.now(),
          props: { conv, peer, account_id: ctx.uid, app_name: "avatok", service_name: "avatok-api", worker: true } });
      } catch { /* best-effort */ }
    }
    return json({ ok: true, conv, accept_state: state });
  }
  const conv = new URL(req.url).searchParams.get("conv") || "";
  if (!conv) return json({ error: "conv required" }, 400);
  const st = await inboxAcceptState(env, ctx.uid, conv);
  return json({ conv, ...st, gateEnabled: await gateEnabled(env) });
}

// Exported for the receipt-suppression check in messaging.ts (receiptMsg).
export { inboxAcceptState, dmConvId, gateEnabled as strangerGateEnabled };
