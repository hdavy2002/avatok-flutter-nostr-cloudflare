// Messaging routes (Cloudflare-native, Nostr deprecated). The avatok-api Worker
// is the ROUTER: it authenticates (Clerk JWT), gates (KYC + block), assigns the
// message via each member's InboxDO, pushes live or enqueues FCM when offline.
// Messages are server-readable plaintext (TLS in transit) — no E2E, by design,
// so moderation/reporting can operate.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, kycVerified, dmConvId, isFail } from "../authz";
// [AVA-IDGATE-1] gatePublicAction is the ONE liveness gate now. The old
// authz.requireLiveness was removed. gatePublicAction reads identity_proofs, fails
// CLOSED, enforces the 90-day window, and returns 403 identity_required.
import { gatePublicAction, emailOf, type PublicAction } from "../lib/identity_gate";
import { nameFor } from "../lib/identity";        // resolve inviter display name
import { readConfig } from "./config";            // groupInvitesEnabled kill switch
import { novuGroupInvite } from "../notify_novu"; // optional Novu orchestration
import { delegateScan } from "./ava_delegate";   // P7 — Phase 11 hook
import { guardianScan, guardianFastScan, hasGuardianOnRecipient } from "./ava_guardian"; // P8 + G3 inline two-lane scan
import { canonicalMsgId } from "../util"; // canonical, chronologically-sortable message id
import { brainIngest } from "../lib/brain_ingest"; // One Brain B3 (§8-B3, B-D1) — metadata-only chat activity
import { inboxAcceptState } from "./safety"; // STREAM B — read-receipt suppression for pending stranger threads
// STREAM F — auto-responder ("Ava replies while you're away"). Hot-path hook only:
// on an incoming DM we decide whether to enqueue an auto-reply job; the heavy work
// (canned/AI reply generation + append) runs in the avatok-consumers auto_reply
// consumer. Reading the recipient's config is a single KV-mirror get (fast).
import { readAutoResponderConfig, isActiveNow } from "./auto_responder";

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
// F3: log the legacy-archive suppression exactly once per isolate (not per message).
let _legacyArchiveSuppressLogged = false;
function archiveLegacySuppressedOnce(): void {
  if (_legacyArchiveSuppressLogged) return;
  _legacyArchiveSuppressLogged = true;
  console.warn("archive_legacy_suppressed: CHAT_ARCHIVE_V2=1 → legacy per-message CHAT_ARCHIVE lane disabled (no double-write)");
}

const FANOUT_SYNC_MAX = 25;
const FANOUT_QUEUE_CHUNK = 80; // recipients per queue message (well under 128KB)
const BLOCKS_CHUNK = 90;       // D1 100-bound-param limit (SCALE_AUDIT P0-2)

// [MSG-CTX-WAITUNTIL-1] Background-work helper (J3). A promise that is neither
// awaited nor attached to ctx.waitUntil() may be terminated by the Workers
// runtime the instant the response is returned — the route comments used to say
// "no ctx.waitUntil" as if that were a feature; it meant guardian scans, archive
// writes, and analytics could silently vanish. `bg()` is the ONE place that
// decides how a detached job survives: if the caller threaded ExecutionContext
// through, the job rides ctx.waitUntil(); otherwise (older call sites not yet
// migrated) it falls back to the previous best-effort fire-and-forget so nothing
// regresses. Never rethrows — a background failure is recorded, not propagated.
function bg(ctx: ExecutionContext | undefined, env: Env | undefined, job: string, p: Promise<unknown>): void {
  const guarded = p.catch((e) => {
    console.error(`background_job_failed: ${job}`, String(e));
    try {
      void env?.Q_ANALYTICS?.send({
        event: "background_job_failed", uid: "server", ts: Date.now(),
        props: { job, error: String(e).slice(0, 300), app_name: "avatok", service_name: "avatok-api", worker: true },
      });
    } catch { /* best-effort */ }
  });
  if (ctx) ctx.waitUntil(guarded); else void guarded;
}

// [MSG-FANOUT-DURABLE-1] Deterministic fan-out job identity (J2 + J6). Hashing
// (conv, message client id, sender uid) means a queue retry after a consumer
// timeout, and a partial-failure re-enqueue of only the still-failed
// recipients, both address the SAME job — never a brand-new, indistinguishable
// one. Stable across attempts; the consumer forwards it unchanged on retry.
async function fanoutId(conv: string, clientId: string | null, sender: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${conv}|${clientId ?? ""}|${sender}`));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// Short, non-reversible conversation-id hash for telemetry (never a raw conv id
// in new events, per the fan-out durability spec).
async function hashShort(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest)).slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

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

// [SRV-MSG-IDEMP-1] `already_processed` surfaces the InboxDO's durable dedup verdict
// (a re-sent client_id) so the SENDER'S own append result — and, for it, the HTTP
// response — can treat a duplicate as a success the outbox completes on, not a retry.
async function appendTo(env: Env, owner: string, body: Record<string, unknown>): Promise<{ id: number; live: boolean; already_processed?: boolean }> {
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
//
// [AVANOTIF-VM-2] `fromUid` is the Worker-AUTHENTICATED sender (ctx.uid at the
// call site — never client-supplied), threaded through as PushMsg.from so the
// consumer's buildPayload("notify") forwards it to the RECIPIENT device as
// `data.fromUid`. Without this, EVERY regular chat-message push (the owner's
// reported path — a raw phone number title, "New message" body) carried no
// sender identity at all, so push_service.dart's _resolveDisplayName() had
// nothing to resolve against and fell straight to the payload fromName (the
// SENDER's own self-declared name, unverified against the recipient's own
// contacts) — the exact bug AVANOTIF-VM-1 shipped a resolver for but could not
// close from this file. No raw E.164 phone is available at this call site
// (users.phone_hash is a one-way hash, not reversible to a real number) — only
// `fromUid` travels here; see the report for why fromPhone is deliberately NOT
// fabricated from this path.
async function pushOffline(env: Env, toUid: string, fromUid: string, fromName: string, preview: string): Promise<void> {
  try {
    await env.Q_PUSH.send({
      kind: "notify", to: toUid, from: fromUid, fromName: fromName || "AvaTOK",
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
async function pushDelete(env: Env, toUid: string, conv: string, target: string, ctx?: ExecutionContext): Promise<void> {
  try {
    await env.Q_PUSH.send({ kind: "del", to: toUid, conv, target });
  } catch (e) {
    // The offline path failed to enqueue → the recipient can ONLY get this delete
    // on their next sync. Record it so a stuck delete is attributable, not silent.
    bg(ctx, env, "chat_delete_push_failed", env.Q_ANALYTICS.send({ event: "chat_delete_push_failed", uid: toUid, ts: Date.now(),
      props: { delete_id: target, conv, account_id: toUid, app_name: "avatok",
        service_name: "avatok-api", worker: true, err: String(e).slice(0, 200) } }));
  }
}

// [MSG-DELETE-1] Author-only unsend gate (Issue 3, plan §7 item 4 + §2.2). A
// per-MESSAGE delete-for-everyone ({"t":"del"|"gdel", target}) must be applied ONLY
// by the message's ORIGINAL AUTHOR — otherwise a recipient could unsend a message on
// the other person's phone (one of the two enforcement gaps behind the wipe). We ask
// the SENDER's own InboxDO for the stored author of `target` (their own copy of the
// conversation) and require it to equal ctx.uid. Fail-CLOSED: an unknown/missing
// author (message not found here) rejects the retract.
async function verifyAuthor(env: Env, uid: string, conv: string, target: string): Promise<boolean> {
  try {
    const stub = env.INBOX.get(env.INBOX.idFromName(uid));
    const res = await stub.fetch(
      `https://inbox/msg_author?conv=${encodeURIComponent(conv)}&target=${encodeURIComponent(target)}`,
    );
    const j = (await res.json().catch(() => ({}))) as { author?: string };
    return !!j.author && j.author === uid;
  } catch { return false; } // fail-closed
}

// STREAM F — decide + enqueue an auto-reply for one incoming DM.
// Gates (all must pass): feature flag ON, recipient's responder ACTIVE now,
// audience matches (known-contacts-only vs everyone-except-blocked), and the peer
// is NOT a pending stranger-gate thread. Loop protection, per-contact/day caps and
// the global circuit breaker live in the CONSUMER (single source of truth for
// counters) — this hot-path check is the cheap first filter so we don't enqueue a
// job for the overwhelming majority of messages. Best-effort; never blocks the send.
//
// `isAutoReplyEnvelope`: NEVER auto-reply to a message that is itself an auto-reply
// (envelope carries auto:true) — first line of loop defence (also re-checked in the
// consumer). Group messages are excluded by the caller (DM-only: 1 recipient).
function isAutoReplyEnvelope(text: string | null): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t.startsWith("{")) return false;
  try { const o = JSON.parse(t); return o && o.auto === true; } catch { return false; }
}

async function maybeEnqueueAutoReply(
  env: Env,
  args: { recipient: string; sender: string; conv: string; text: string | null; kind: string; senderKnown: boolean; mid: string },
): Promise<void> {
  try {
    // 1) Loop guard — never respond to another auto-reply.
    if (isAutoReplyEnvelope(args.text)) return;
    // 2) Recipient's responder config (KV-mirror fast read). Check FIRST so a
    //    non-away recipient (the vast majority) never pays for the DO fetches below.
    const cfg = await readAutoResponderConfig(env, args.recipient);
    if (!isActiveNow(cfg)) return;
    // 3) NEVER auto-reply into a pending stranger-gate thread (Stream B owns this),
    //    regardless of audience setting (spec AUTOREP-1). Reuse Stream B's shared
    //    inboxAcceptState() — do NOT duplicate the gate logic. accept_state other
    //    than 'accepted' means the recipient hasn't accepted this stranger yet.
    const st = await inboxAcceptState(env, args.recipient, args.conv);
    if (st.accept_state !== "accepted") return;
    // 4) Audience gate. 'known' → only if the sender is an existing contact of the
    //    recipient. 'everyone' → anyone except a blocked sender (blocks were already
    //    filtered upstream, so reaching here means not blocked).
    if (cfg.audience === "known" && !args.senderKnown) return;
    // 5) Enqueue. The consumer enforces the 3/contact/day + 50/day caps + generates
    //    the reply (canned or AI) + appends it. Dark/no-op if the queue is unbound.
    await env.Q_AUTO_REPLY?.send({
      recipient: args.recipient, sender: args.sender, conv: args.conv,
      incoming_text: args.text, incoming_kind: args.kind, incoming_mid: args.mid,
      enqueuedAt: Date.now(),
    });
  } catch { /* best-effort; a missed auto-reply never affects the human's message delivery */ }
}

// ---- POST /api/msg/send -----------------------------------------------------
export async function sendMsg(req: Request, env: Env, execCtx?: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  // KYC gate is flag-gated OFF until Stripe Identity ships (set KYC_REQUIRED=1 to enforce).
  if (env.KYC_REQUIRED === "1" && !(await kycVerified(env, ctx.uid))) return json({ error: "kyc required" }, 403);
  // [AVA-IDGATE-1] The old onboarding requireLiveness(msg/send) is REMOVED. It gated
  // EVERY send — including DMs to existing contacts — which the new design explicitly
  // must not do. The correct per-action gate runs lower down, AFTER we resolve
  // `dmPreexisted`: only a first DM to a stranger ('dm_stranger') or a group message
  // ('group_post') is gated; messaging a known contact never is.

  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const kind = String(b.kind || "text");
  const text = b.body == null ? null : String(b.body);
  const mediaRef = b.media_ref == null ? null : String(b.media_ref);
  const clientId = b.client_id == null ? null : String(b.client_id);
  // [TRACE-ID-1] Message-lifecycle correlation id. The client reuses the unique
  // per-message client_id AS the trace_id (documented choice: client_id is already
  // unique per message, so no separate id is minted for sends). If a client ever
  // sends an explicit x-trace-id header we honour it; otherwise we fall back to
  // client_id so the whole send→echo journey is queryable by one id in PostHog.
  const traceId = req.headers.get("x-trace-id") ?? clientId ?? "";
  // [SRV-MSG-IDEMP-1] Optional multi-device origin tag. Passed straight through to
  // the InboxDO append (stored on the row); absent for single-device clients.
  const deviceId = b.device_id == null ? null : String(b.device_id);
  if (!text && !mediaRef) return json({ error: "empty message" }, 400);

  // Resolve the conversation + its members.
  let conv: string;
  let mem: string[];
  // STREAM F — "known contact" signal for the auto-responder audience gate: the two
  // parties have an EXISTING DM thread (they've spoken before) → the sender is a
  // known contact of the recipient. Computed BEFORE ensureDm (which upserts the
  // row) so a brand-new first-contact DM correctly reads as "not known".
  let dmPreexisted = false;
  if (b.to) {
    try {
      const existing = await env.DB_META.prepare("SELECT id FROM conversations WHERE id=?1")
        .bind(dmConvId(ctx.uid, String(b.to))).first();
      dmPreexisted = !!existing;
    } catch { /* best-effort; defaults to not-known (safe) */ }
    conv = await ensureDm(env, ctx.uid, String(b.to), normContext(b.context));
    mem = [ctx.uid, String(b.to)];
  } else if (b.conv) {
    conv = String(b.conv);
    mem = await members(env, conv);
    if (!mem.includes(ctx.uid)) return json({ error: "not a member" }, 403);
    // Reaching a DM by an existing conv id means the thread already exists → the
    // parties are known contacts (STREAM F audience gate).
    dmPreexisted = true;
  } else {
    return json({ error: "conv or to required" }, 400);
  }
  const isDm = mem.length === 2;

  // [AVA-IDGATE-1] Public-action gate. Spec §3.1. CORRECTED 2026-07-10 (prod bug).
  //
  // The earlier signal (`dmPreexisted` = "a conversations row exists") was WRONG.
  // Opening a chat calls ensureDm on the read/sync paths (/api/msg/sync line ~744,
  // /api/conversations), so the row — and its created_by — already exist BEFORE the
  // first message. Every first DM therefore read as "preexisting" and skipped the
  // gate. Confirmed in prod: an unverified brand-new user cold-messaged a stranger
  // with no liveness check.
  //
  // The reliable signal is `created_by`: whoever's ensureDm ran FIRST for this pair is
  // the INITIATOR reaching out. In the b.to branch ensureDm has just run above, so a
  // brand-new thread is stamped created_by = ME. A thread the PEER opened first is
  // stamped created_by = them (I am replying, not cold-reaching). So:
  //   • DM I initiated (created_by == me)      → "dm_stranger"  (gate the outreach)
  //   • DM the peer initiated (created_by peer)→ NOT gated       (I'm replying)
  //   • any message into a group               → "group_post"
  // Fails CLOSED: if created_by can't be read, treat as my outreach and gate.
  if (isDm) {
    let iInitiated = true;
    try {
      const row = await env.DB_META.prepare("SELECT created_by FROM conversations WHERE id=?1")
        .bind(conv).first<{ created_by: string }>();
      iInitiated = !row || row.created_by === ctx.uid;
    } catch { iInitiated = true; }
    if (iInitiated) {
      const blocked = await gatePublicAction(env, ctx.uid, await emailOf(env, ctx.uid), "dm_stranger");
      if (blocked) return blocked;
    }
  } else {
    const blocked = await gatePublicAction(env, ctx.uid, await emailOf(env, ctx.uid), "group_post");
    if (blocked) return blocked;
  }

  const created = Date.now();
  // Canonical, chronologically-sortable id shared by the live Ably message, the
  // R2 archive key, and the client dedupe key (Phase 1, ABLY-R2-1).
  const mid = canonicalMsgId(created);
  const payload = { conv, sender: ctx.uid, kind, body: text, media_ref: mediaRef, client_id: clientId, created_at: created, device_id: deviceId, mid, trace_id: traceId }; // [TRACE-ID-1]

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

  // ── CALL-OUTCOME-MENU stranger note caps (owner 2026-07-09, Specs/CALL-OUTCOME-
  // MENU-SPEC-2026-07-09.md §5): a STRANGER (never-accepted first contact) gets
  // strangerVoiceNotesPerDay voice notes and strangerTextNotesPerDay texts per
  // recipient per UTC day. Known contacts are UNLIMITED. Stranger detection is a
  // cheap KV marker (`cmstranger:<sender>:<recipient>`, set on first-ever contact,
  // cleared when the recipient ACCEPTS the thread, 7-day TTL) — no DO read on the
  // hot path. Active only while callMenuEnabled && callMenuRateLimitEnabled, so
  // this ships dark; fail-open on any KV error. Delete-controls are exempt.
  if (isDm && recipients.length === 1 && !delTarget && (kind === "text" || kind === "audio")) {
    try {
      const cfgCm = await readConfig(env) as unknown as Record<string, unknown>;
      if (cfgCm.callMenuEnabled === true && cfgCm.callMenuRateLimitEnabled !== false) {
        const peer = recipients[0];
        const markerKey = `cmstranger:${ctx.uid}:${peer}`;
        let stranger: boolean;
        if (!dmPreexisted) {
          stranger = true; // first-ever contact — start tracking as a stranger
          await env.TOKENS.put(markerKey, "1", { expirationTtl: 7 * 86_400 });
        } else {
          stranger = (await env.TOKENS.get(markerKey)) === "1";
        }
        if (stranger) {
          // Classify voice vs text: the Flutter client POSTs kind='text' with the
          // real type inside the envelope ({"t":"media","kind":"audio",…} = voice
          // note), so inspect the body rather than trusting the top-level kind.
          const isVoice = kind === "audio" ||
            (!!text && text.includes('"t":"media"') && text.includes('"kind":"audio"'));
          const noteKind = isVoice ? "audio" : "text";
          const cap = isVoice
            ? Math.max(1, Math.round(Number(cfgCm.strangerVoiceNotesPerDay ?? 5)))
            : Math.max(1, Math.round(Number(cfgCm.strangerTextNotesPerDay ?? 10)));
          const day = new Date().toISOString().slice(0, 10);
          const cKey = `usage:cmnote:${noteKind}:${ctx.uid}:${peer}:${day}`;
          const used = Math.max(0, parseInt((await env.TOKENS.get(cKey)) ?? "0", 10) || 0);
          if (used >= cap) {
            bg(execCtx, env, "stranger_note_rate_limited", env.Q_ANALYTICS.send({ event: "stranger_note_rate_limited", uid: ctx.uid, ts: Date.now(),
              props: { kind: noteKind, cap, peer, email: (req.headers.get("x-user-email") || ""), account_id: ctx.uid, app_name: "avatok", service_name: "avatok-api", worker: true } }));
            return json({ error: "note_rate_limited", kind: noteKind, cap, retry: "tomorrow" }, 429);
          }
          await env.TOKENS.put(cKey, String(used + 1), { expirationTtl: 2 * 86_400 });
        }
      }
    } catch { /* fail-open — a counter error never blocks a message */ }
  }

  // [MSG-DELETE-1] AUTHOR-ONLY UNSEND (Issue 3). A per-message delete-for-everyone is
  // peer-visible, so we MUST verify ctx.uid actually authored the target message
  // BEFORE applying/fanning it out. An unauthored retract is rejected (403) and never
  // reaches any peer's InboxDO. Whole-thread clears are self-scoped (see hideMsg's
  // thread-clear branch) and never take this path.
  const _email = (req.headers.get("x-user-email") || "").toString();
  if (delTarget) {
    bg(execCtx, env, "msg_retract_requested", env.Q_ANALYTICS.send({ event: "msg_retract_requested", uid: ctx.uid, ts: Date.now(),
      props: { message_id: delTarget, author_uid: ctx.uid, target_uid: others[0] ?? null, op_id: clientId ?? "",
        message_age_seconds: 0, trace_id: traceId, email: _email, account_id: ctx.uid,
        app_name: "avatok", app_version: "", service_name: "avatok-api", worker: true } }));
    const t0 = Date.now();
    const authored = await verifyAuthor(env, ctx.uid, conv, delTarget);
    if (!authored) {
      bg(execCtx, env, "msg_retract_rejected", env.Q_ANALYTICS.send({ event: "msg_retract_rejected", uid: ctx.uid, ts: Date.now(),
        props: { message_id: delTarget, reason: "not_author", op_id: clientId ?? "", trace_id: traceId,
          email: _email, account_id: ctx.uid, app_name: "avatok", app_version: "", service_name: "avatok-api", worker: true } }));
      return json({ error: "not_author", message: "Only the author can unsend this message." }, 403);
    }
    bg(execCtx, env, "msg_retract_authorized", env.Q_ANALYTICS.send({ event: "msg_retract_authorized", uid: ctx.uid, ts: Date.now(),
      props: { message_id: delTarget, author_verified: true, message_owner_uid: ctx.uid, authorization_ms: Date.now() - t0,
        trace_id: traceId, email: _email, account_id: ctx.uid, app_name: "avatok", app_version: "", service_name: "avatok-api", worker: true } }));
  }

  // Append to the sender's own log first (its id anchors the client's cursor).
  const mine = await appendTo(env, ctx.uid, payload);

  // Rich offline banner inputs (the Ably migration made push the only offline
  // wake path on mobile, so these must be populated — not a bare "AvaTOK").
  const fromName = await senderDisplayName(env, ctx.uid);
  const preview = msgPreview(kind, text, mediaRef);

  // Phase 1 (ABLY-R2-1): durable R2 archive. Enqueue the moderated message so a
  // consumer writes the body to R2 (BACKUP_R2, chat/<conv>/<mid>.json) + indexes
  // it in D1 (message_index). This is the LEGACY per-message archive lane.
  // F3 MUTUAL EXCLUSION: when the P8 batched jsonl archive is on (CHAT_ARCHIVE_V2),
  // the legacy per-message lane is force-disabled in CODE so a misconfigured KV/var
  // can NEVER double-write. The batched lane (InboxDO) is the cost-correct successor.
  if (env.CHAT_ARCHIVE === "1" && env.CHAT_ARCHIVE_V2 === "1") {
    archiveLegacySuppressedOnce(); // log once per isolate
  }
  if (env.CHAT_ARCHIVE === "1" && env.CHAT_ARCHIVE_V2 !== "1" && env.Q_ARCHIVE) {
    bg(execCtx, env, "chat_archive_send", env.Q_ARCHIVE.send({
      conv, serial: mid, sender: ctx.uid, kind,
      body: text, media_ref: mediaRef, client_id: clientId, created_at: created,
      group: mem.length > 2,
    }));
  }

  // Sender's origin geo/network (from req.cf) — reused by both the inline fast lane
  // and the detached deep guardian scan for the spam-origination telemetry map.
  const _cf: any = (req as any).cf || {};
  const _guardGeo = {
    country: _cf.country ?? null, region: _cf.region ?? null, city: _cf.city ?? null,
    colo: _cf.colo ?? null, ip: req.headers.get("CF-Connecting-IP"),
    asn: _cf.asn ?? null, asOrganization: _cf.asOrganization ?? null, isProxy: _cf.isProxy ?? null,
  };

  // ── G3: INLINE two-lane guardian scan (dark behind guardianInlineEnabled) ────
  // When ON *and* the conv has ≥1 guardian-ON recipient, run the cheap FAST lane
  // (regex + ONE Nemotron call, hard budget) BEFORE fan-out and attach the verdict
  // to the fanned-out payload as payload.safety so the recipient paints the bubble
  // red on arrival. On timeout/error we fan out immediately (fail-open) and emit a
  // budget-breach event. The detached DEEP lane (Opus) still runs after fan-out and
  // receives fastVerdict so it does not double-warn. When guardianInlineEnabled is
  // FALSE this whole block is skipped → EXACTLY today's behaviour (deep lane only).
  let _fastVerdict: { category: string; severity: number } | null = null;
  const _guardCache = new Map<string, boolean>();
  try {
    const _cfg = await readConfig(env);
    if (_cfg.guardianInlineEnabled === true && recipients.length > 0) {
      const _guardedConv = await hasGuardianOnRecipient(env, conv, mem, ctx.uid, _guardCache);
      if (_guardedConv) {
        const _budget = Number(_cfg.guardianInlineBudgetMs) || 600;
        const _fs = await guardianFastScan(env, {
          text: text ?? "", conv, senderUid: ctx.uid, isGroup: mem.length > 2, geo: _guardGeo,
        });
        if (_fs.flag) {
          _fastVerdict = _fs.flag;
          (payload as any).safety = { category: _fs.flag.category, severity: _fs.flag.severity };
        }
        if (_fs.timed_out || _fs.ms > _budget) {
          if (env.Q_ANALYTICS) bg(execCtx, env, "guardian_inline_latency_budget_breach", env.Q_ANALYTICS.send({ event: "guardian_inline_latency_budget_breach", uid: ctx.uid, ts: Date.now(),
            props: { conv, ms: _fs.ms, budget_ms: _budget, lane: "fast", timed_out: _fs.timed_out,
              account_id: ctx.uid, app_name: "avatok", service_name: "avatok-api", worker: true } }));
        }
      }
    }
  } catch { /* fail-open: inline scan never blocks or delays a send */ }

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
        if (r.live) delLive++; else { delPush++; await pushDelete(env, m, conv, delTarget, execCtx); }
        bg(execCtx, env, "chat_delete_delivery", env.Q_ANALYTICS.send({ event: "chat_delete_delivery", uid: ctx.uid, ts: Date.now(),
          props: { delete_id: delTarget, conv, to: m, path: r.live ? "live" : "push",
            app_name: "avatok", service_name: "avatok-api", worker: true } }));
      } else if (!r.live) {
        // [MSG-SEND-TIMEOUT-1] Do NOT await the offline FCM push in the sender's
        // request path. Durability is already guaranteed by the appendTo() above
        // (the recipient's InboxDO has the message); the push is a wake-up hint.
        // Awaiting it added FCM's tail latency to every offline-recipient send and
        // pushed slow-network senders past their client timeout (PostHog
        // /api/msg/send TimeoutException x57). [MSG-CTX-WAITUNTIL-1] Still
        // detached from the response, but now riding ctx.waitUntil so the Workers
        // runtime can't kill it mid-flight once the response returns.
        bg(execCtx, env, "push_offline", pushOffline(env, m, ctx.uid, fromName, preview));
      }
      // STREAM F — auto-responder hook. DM-only (isDm), regular messages only (not a
      // delete-for-everyone control). Fires independent of socket liveness because
      // "away" means the human isn't READING even if a background socket is open —
      // the read-state, not the socket, is authoritative (see the receipt-suppression
      // note in the consumer). Best-effort; never blocks the human's message. The
      // stranger-gate check (Stream B's inboxAcceptState) is done INSIDE the helper,
      // only after the cheap KV config read says the responder is active — so a
      // non-away recipient never pays the extra DO fetch.
      if (isDm && !delTarget) {
        bg(execCtx, env, "auto_reply_enqueue", maybeEnqueueAutoReply(env, {
          recipient: m, sender: ctx.uid, conv, text, kind, senderKnown: dmPreexisted, mid,
        }));
      }
    }));
    if (delTarget) {
      bg(execCtx, env, "chat_delete_fanout", env.Q_ANALYTICS.send({ event: "chat_delete_fanout", uid: ctx.uid, ts: Date.now(),
        props: { delete_id: delTarget, conv, recipients: recipients.length,
          live: delLive, push: delPush, app_name: "avatok", service_name: "avatok-api", worker: true } }));
      // [MSG-DELETE-1] Author-only unsend committed + fanned out to the peer(s).
      bg(execCtx, env, "msg_retract_committed", env.Q_ANALYTICS.send({ event: "msg_retract_committed", uid: ctx.uid, ts: Date.now(),
        props: { message_id: delTarget, visible: false, reason: "author_retract", peer_fanout: true,
          peer_count: recipients.length, live: delLive, push: delPush, trace_id: traceId, email: _email,
          account_id: ctx.uid, app_name: "avatok", app_version: "", service_name: "avatok-api", worker: true } }));
    }
  } else {
    // Large fan-out: hand to Queues — consumers append to each InboxDO + FCM
    // offline. The router NEVER loops >FANOUT_SYNC_MAX synchronous DO calls.
    //
    // [MSG-FANOUT-DURABLE-1] (J2 + J6) Every chunk carries the SAME fanout_id
    // (hash of conv + client message id + sender — stable across retries) and
    // starts at attempt=1. The consumer (consumers/src/fcm.ts handleFanout) is
    // the ONLY place that decides whether a job is done: on a partial failure it
    // re-enqueues ONLY the still-failed recipients with attempt+1 under the same
    // fanout_id, so a queue retry can never silently ACK away a lost recipient.
    deliveryPath = "queue";
    const fid = await fanoutId(conv, clientId, ctx.uid);
    const sends: Promise<unknown>[] = [];
    for (let i = 0; i < recipients.length; i += FANOUT_QUEUE_CHUNK) {
      sends.push(env.Q_PUSH.send({
        // [AVANOTIF-VM-2] `from: ctx.uid` — see pushOffline above. handleFanout
        // (consumers/src/fcm.ts) already forwards msg.from as data.fromUid on
        // the per-recipient notify it re-enqueues; it just never had a value to
        // forward from THIS producer before now.
        kind: "fanout", payload, fromName, preview, from: ctx.uid,
        recipients: recipients.slice(i, i + FANOUT_QUEUE_CHUNK),
        fanout_id: fid, attempt: 1,
      }));
    }
    await Promise.all(sends);
    if (env.Q_ANALYTICS) {
      bg(execCtx, env, "group_fanout_job_created", env.Q_ANALYTICS.send({ event: "group_fanout_job_created", uid: ctx.uid, ts: Date.now(),
        props: { fanout_id: fid, conv_hash: await hashShort(conv), recipients: recipients.length,
          chunks: Math.ceil(recipients.length / FANOUT_QUEUE_CHUNK), attempt: 1,
          account_id: ctx.uid, app_name: "avatok", service_name: "avatok-api", worker: true } }));
    }
  }

  // Telemetry: every send records its delivery path + latency so we can SEE the
  // Ably-first win (ably_async) vs the legacy sync/queue paths on the dashboard.
  bg(execCtx, env, "chat_message_sent", env.Q_ANALYTICS.send({ event: "chat_message_sent", uid: ctx.uid, ts: Date.now(),
    props: { conv, kind, path: deliveryPath, recipients: recipients.length,
      group: mem.length > 2, archived: env.CHAT_ARCHIVE === "1",
      latency_ms: Date.now() - created, account_id: ctx.uid,
      app_name: "avatok", service_name: "avatok-api", worker: true } }));

  // ── One Brain B3 (SPEC-2026-07-17 §8-B3, B-D1) — METADATA-ONLY chat activity ──
  // The old dark `brainEnabled`-gated full-CONTENT ingestion path was REMOVED here
  // (not flipped — §9): message BODIES never enter the server brain. Content is
  // indexed on-device only (domain `msg_content`, device_private — the server edge
  // HARD-REJECTS it). All we emit server-side is a non-content `msg_meta` event
  // (who / when / thread / direction — NEVER a body or a snippet) into each
  // participant's OWN brain, through the ONE ingestion contract. brainIngest fails
  // consent CLOSED, and the consumer treats `msg_meta` as D1-event-only (no
  // Vectorize embed, no LLM fact-extraction — per-message embedding is wasteful and
  // there is no content to embed). A delete-for-everyone control is not activity.
  // Runs detached so the extra work never adds latency to the send. [MSG-CTX-
  // WAITUNTIL-1] Now riding ctx.waitUntil (via bg()) instead of a bare `void`
  // IIFE, so the runtime can't reap it after the response is written.
  if (!delTarget) {
    bg(execCtx, env, "brain_ingest_msg_meta", (async () => {
      const isGroup = mem.length > 2;
      const peerUid = isGroup ? null : (others[0] ?? null);
      const mediaType = kind && kind !== "text" ? kind : undefined;
      // Peer display name for the audit one-liner ONLY (never embedded). Best-effort.
      const peerName = isGroup
        ? "a group"
        : (peerUid ? await senderDisplayName(env, peerUid).catch(() => "a contact") : "a contact");
      // Sender's own brain — outgoing activity.
      await brainIngest(env, {
        uid: ctx.uid, domain: "msg_meta", kind: "message_sent", sourceId: String(mid),
        text: `Message to ${peerName}`,
        meta: { peer: peerUid, conv, direction: "out", group: isGroup, ...(mediaType ? { mediaType } : {}) },
        ts: created, email: _email || null,
      });
      // Each recipient's own brain — incoming activity. Mirrors the legacy dual
      // emit; bounded to the sync fan-out cap (large fan-outs skip per-recipient
      // brain events, exactly as the removed path did).
      if (recipients.length <= FANOUT_SYNC_MAX) {
        for (const m of recipients) {
          await brainIngest(env, {
            uid: m, domain: "msg_meta", kind: "message_received", sourceId: String(mid),
            text: `Message from ${fromName}`,
            meta: { peer: ctx.uid, conv, direction: "in", group: isGroup, ...(mediaType ? { mediaType } : {}) },
            ts: created,
          });
        }
      }
    })());
  }

  // Ava delegate (P7) + guardian (P8) post-fanout scans. Both self-gate on cheap
  // string heuristics → ZERO model cost for clean / non-monitored messages.
  // [MSG-CTX-WAITUNTIL-1] Run via ctx.waitUntil (bg()) — detached from the
  // response but no longer at the mercy of the runtime reaping an unattached
  // promise. `payload` is the exact fanned-out object; `mem` the member list.
  bg(execCtx, env, "delegate_scan", delegateScan(env, { conv, message: payload, members: mem, senderUid: ctx.uid }));
  // Deep (slow) guardian lane. Runs detached AFTER fan-out. Pass the sender's origin
  // geo/network for telemetry, and (G3) the fast-lane verdict so the deep lane never
  // double-warns for a category the inline fast lane already surfaced.
  bg(execCtx, env, "guardian_scan", guardianScan(env, {
    conv, message: { ...payload, client_id: payload.client_id ?? undefined }, members: mem, senderUid: ctx.uid,
    geo: _guardGeo,
    fastVerdict: _fastVerdict as any,
  }));

  // P13-B PartyKit delivery hint (dark until PARTY_ENABLED=1): nudge anyone with
  // this thread open to do a targeted fetch instantly, instead of waiting on the
  // hub frame. HINT ONLY — InboxDO stays the source of truth, so a lost hint
  // changes nothing. Best-effort; never blocks the send. Zero cost while dark.
  if (env.PARTY_ENABLED === "1") {
    bg(execCtx, env, "party_emit", partyEmit(env, `thread:${conv}`, { t: "new", conv, seq: mine.id }));
  }

  // [SRV-MSG-IDEMP-1] Surface the dedup verdict so the client outbox treats a
  // re-sent message (network retry / app-kill mid-send) as a COMPLETED success
  // instead of retrying forever. `already_processed` is present + true only on a
  // durable-index dedup; omitted on a fresh insert (backward compatible).
  return json({ id: mine.id, conv, created_at: created, ...(mine.already_processed ? { already_processed: true } : {}) });
}

// ---- POST /api/msg/forward --------------------------------------------------
// STREAM I (AI Messenger Batch). Fan a single message out to N chosen targets
// (DMs and/or groups) in ONE call. The body carries the ALREADY-BUILT forward
// envelope (the client stamped `fwd:true` and stripped the original sender —
// privacy, FWD-1), so this route never re-reads/re-uploads media: media forwards
// re-reference the SAME content-addressed R2 object via the same `media_ref`
// (FWD-2, zero duplication — see the client `_doForward` for the E2E-key detail).
//
// Anti-spam (FWD-3): a flag-tunable KV counter caps forward TARGETS per user per
// hour; over the cap → 429. Forwarding is a spam-capable route, so it also
// requires liveness (Stream H's requireLiveness helper — see the guard below).
const FORWARD_TARGET_CAP_PER_HOUR = 200;   // flag-tunable default (FWD-3)
const FORWARD_WINDOW_MS = 3_600_000;

// KV rolling-hour counter of forward targets. Best-effort + FAIL-OPEN: the cap
// is an abuse backstop, not a correctness gate, so a KV hiccup must never brick
// forwarding. Keyed per account (per-account scoping).
async function forwardCount(env: Env, uid: string): Promise<number> {
  try {
    const raw = await env.TOKENS.get(`fwd:count:${uid}`, "json") as { n: number; t: number } | null;
    if (!raw) return 0;
    if (Date.now() - raw.t >= FORWARD_WINDOW_MS) return 0; // window rolled over
    return raw.n || 0;
  } catch { return 0; }
}
async function bumpForwardCount(env: Env, uid: string, by: number): Promise<void> {
  try {
    const raw = await env.TOKENS.get(`fwd:count:${uid}`, "json") as { n: number; t: number } | null;
    const rolled = !raw || (Date.now() - raw.t >= FORWARD_WINDOW_MS);
    const next = rolled ? { n: by, t: Date.now() } : { n: (raw!.n || 0) + by, t: raw!.t };
    await env.TOKENS.put(`fwd:count:${uid}`, JSON.stringify(next), { expirationTtl: 4000 });
  } catch { /* best-effort */ }
}

// [AVA-IDGATE-1] requireLivenessOrKyc REMOVED. It read kyc_status and FAILED OPEN
// (no row ⇒ allowed), so it never actually gated a new user. forwardMsg now uses
// gatePublicAction('forward'), which fails CLOSED against identity_proofs.

export async function forwardMsg(req: Request, env: Env, execCtx?: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  // Feature flag (FWD-4): unlimitedForwardEnabled (default ON). Treat only an
  // explicit `false` as off, so the route is ON even before config.ts ships the
  // key into DEFAULTS.
  const cfg = await readConfig(env) as unknown as Record<string, unknown>;
  if (cfg.unlimitedForwardEnabled === false) return json({ error: "forwarding disabled" }, 403);

  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const kind = String(b.kind || "text");
  const text = b.body == null ? null : String(b.body);
  const mediaRef = b.media_ref == null ? null : String(b.media_ref);
  if (!text && !mediaRef) return json({ error: "empty message" }, 400);

  // Targets: { to?: uid, conv?: groupId }[] — a mix of DMs and groups.
  const rawTargets: Array<{ to?: string; conv?: string }> =
    Array.isArray(b.targets) ? b.targets : [];
  const dmTargets = rawTargets.map((t) => (t.to ? String(t.to) : "")).filter(Boolean);
  const groupTargets = rawTargets.map((t) => (t.conv ? String(t.conv) : "")).filter(Boolean);
  const nGroups = groupTargets.length;
  const nTargets = dmTargets.length + nGroups;
  if (nTargets === 0) return json({ error: "no targets" }, 400);

  // [AVA-IDGATE-1] HOLE CLOSED 2026-07-10. This used requireLivenessOrKyc, which reads
  // kyc_status and FAILS OPEN when no row exists — so a brand-new unverified user could
  // forward/broadcast a message to many DMs + groups with NO liveness check. Forwarding
  // is a bulk broadcast and a prime spam/grooming vector; it is exactly the kind of
  // public action the gate exists for. Now gated by the new gate (fails CLOSED,
  // identity_proofs, 90-day window). Any forward by an unverified user is blocked.
  {
    const blocked = await gatePublicAction(env, ctx.uid, await emailOf(env, ctx.uid), "forward");
    if (blocked) return blocked;
  }

  // Rate backstop (FWD-3): 200 forward TARGETS / user / rolling hour. A group
  // counts as ONE target (the per-member fan-out inside a group is handled by
  // delivery, not this abuse cap).
  const already = await forwardCount(env, ctx.uid);
  if (already + nTargets > FORWARD_TARGET_CAP_PER_HOUR) {
    try {
      const email = (req.headers.get("x-user-email") || "").toString();
      void env.Q_ANALYTICS?.send({ event: "forward_rate_capped", uid: ctx.uid, ts: Date.now(),
        props: { attempted: nTargets, window_count: already, cap: FORWARD_TARGET_CAP_PER_HOUR,
          email, account_id: ctx.uid, app_name: "avatok", service_name: "avatok-api", worker: true } });
    } catch { /* best-effort */ }
    return json({ error: "rate_limited", message: "Slow down — you're forwarding too fast." }, 429);
  }

  const fromName = await senderDisplayName(env, ctx.uid);
  const preview = msgPreview(kind, text, mediaRef);
  let totalRecipients = 0;

  // Resolve each target into a (conv, members) pair, then reuse the SAME append
  // fan-out the normal send uses. Media rides as the same media_ref → one R2 copy.
  const jobs: Array<{ conv: string; recipients: string[] }> = [];

  // DMs: ensure the 1:1 conversation, deliver to the peer (blockers respected).
  for (const to of dmTargets) {
    const conv = await ensureDm(env, ctx.uid, to, null);
    const blocked = (await blockersOf(env, ctx.uid, [to])).has(to);
    jobs.push({ conv, recipients: blocked ? [] : [to] });
  }
  // Groups: I must be a member; deliver to every OTHER member (skip blockers).
  for (const gid of groupTargets) {
    const mem = await members(env, gid);
    if (!mem.includes(ctx.uid)) continue; // silently skip groups I'm not in
    const others = mem.filter((m) => m !== ctx.uid);
    const blockers = await blockersOf(env, ctx.uid, others);
    jobs.push({ conv: gid, recipients: others.filter((m) => !blockers.has(m)) });
  }

  const created = Date.now();
  for (const job of jobs) {
    const mid = canonicalMsgId(created);
    const payload = { conv: job.conv, sender: ctx.uid, kind, body: text,
      media_ref: mediaRef, client_id: `fwd_${created}_${Math.random().toString(36).slice(2, 8)}`,
      created_at: created, mid };
    // My own log first (anchors my cursor), then each recipient.
    await appendTo(env, ctx.uid, payload);
    totalRecipients += job.recipients.length;
    // Small fan-out per target inline; large groups go through the queue like send.
    if (job.recipients.length <= FANOUT_SYNC_MAX) {
      await Promise.all(job.recipients.map(async (m) => {
        const r = await appendTo(env, m, payload);
        if (!r.live) await pushOffline(env, m, ctx.uid, fromName, preview);
      }));
    } else {
      // [MSG-FANOUT-DURABLE-1] Same durable-identity contract as sendMsg's large
      // fan-out: one fanout_id per target job, attempt=1, so the consumer can
      // retry only the failed recipients under the same job id.
      const fid = await fanoutId(job.conv, payload.client_id, ctx.uid);
      const sends: Promise<unknown>[] = [];
      for (let i = 0; i < job.recipients.length; i += FANOUT_QUEUE_CHUNK) {
        // [AVANOTIF-VM-2] from: ctx.uid — same fix as the send() fanout path above.
        sends.push(env.Q_PUSH.send({ kind: "fanout", payload, fromName, preview, from: ctx.uid,
          recipients: job.recipients.slice(i, i + FANOUT_QUEUE_CHUNK), fanout_id: fid, attempt: 1 }));
      }
      await Promise.all(sends);
    }
  }

  await bumpForwardCount(env, ctx.uid, nTargets);

  // Telemetry (FWD-4): forward_sent with the shape the spec asks for.
  if (env.Q_ANALYTICS) {
    const email = (req.headers.get("x-user-email") || "").toString();
    bg(execCtx, env, "forward_sent", env.Q_ANALYTICS.send({ event: "forward_sent", uid: ctx.uid, ts: Date.now(),
      props: { n_targets: nTargets, n_groups: nGroups, total_recipients: totalRecipients,
        media_kind: mediaRef ? kind : "text", cross_context: true, email,
        account_id: ctx.uid, app_name: "avatok", service_name: "avatok-api", worker: true } }));
  }

  return json({ ok: true, n_targets: nTargets, total_recipients: totalRecipients });
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

// ---- POST /api/poll/vote ----------------------------------------------------
// 2026-07-04: server-persisted poll votes. The poll DEFINITION rides the chat
// message envelope (t:'poll'); ONLY the votes are stored (poll_votes in DB_META)
// so tallies survive reinstall / phone transfer + the standard backup. Mirrors
// reactMsg (auth + membership + analytics) and the sendMsg fan-out (append a
// {t:'vote'} control envelope to EVERY member's InboxDO so live devices update).
//
// Body: { poll_id, conv, options:[int], multi?:bool, target? }
//   options = the voter's FULL current selection (0-based indices). Empty ⇒ the
//   voter un-voted entirely. The server replaces the voter's rows atomically, so
//   single-choice change and multi-select add/remove are one idempotent call.
export async function pollVote(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const pollId = String(b.poll_id || "");
  const conv = String(b.conv || "");
  const multi = b.multi === true;
  const raw = Array.isArray(b.options) ? b.options : [];
  if (!pollId || !conv) return json({ error: "poll_id, conv required" }, 400);
  const mem = await members(env, conv);
  if (!mem.includes(ctx.uid)) return json({ error: "not a member" }, 403);

  // Sanitise: unique non-negative ints; single-choice keeps at most one.
  let opts = Array.from(new Set(raw.map((x: any) => Number(x)).filter((n: number) => Number.isInteger(n) && n >= 0 && n < 10)));
  if (!multi && opts.length > 1) opts = [opts[0]];
  const now = Date.now();

  // Atomic replace: drop this voter's rows for the poll, then re-insert their
  // current selection. One row per chosen option (0 rows ⇒ un-voted).
  const stmts: any[] = [
    env.DB_META.prepare("DELETE FROM poll_votes WHERE poll_id=?1 AND voter_uid=?2").bind(pollId, ctx.uid),
  ];
  for (const idx of opts) {
    stmts.push(env.DB_META.prepare(
      "INSERT OR REPLACE INTO poll_votes (poll_id, conv, option_idx, voter_uid, created_at) VALUES (?1,?2,?3,?4,?5)",
    ).bind(pollId, conv, idx, ctx.uid, now));
  }
  try { await env.DB_META.batch(stmts); } catch (e) { return json({ error: "db" }, 500); }

  // Live fan-out — append a {t:'vote'} control envelope to every member's InboxDO
  // (same delivery lane as a message; offline members get it on next sync). The
  // client's existing incoming-vote handler re-hydrates the changed poll.
  const payload = { t: "vote", poll: pollId, conv, voter: ctx.uid, options: opts, multi, ts: now, fromName: "" };
  await Promise.all(mem.map(async (m) => {
    try { await appendTo(env, m, payload); } catch { /* best-effort; state endpoint is the source of truth */ }
  }));

  try {
    void env.Q_ANALYTICS.send({ event: "poll_vote", uid: ctx.uid, ts: now,
      props: { conv, poll_id: pollId, options: opts.length, cleared: opts.length === 0,
        group: mem.length > 2, multi, account_id: ctx.uid,
        app_name: "avatok", service_name: "avatok-api", worker: true } });
  } catch { /* best-effort */ }

  // Return the fresh tally for this poll so the voter's device is authoritative.
  const tally = await pollTallyFor(env, [pollId]);
  return json({ ok: true, poll: tally[pollId] || { counts: {}, voters: {} } });
}

// ---- GET /api/poll/state?conv=<id> ------------------------------------------
// 2026-07-04: batch-hydrate every poll's tally for a conversation on thread open
// so reinstalled / new devices show correct counts + who-voted. Mirrors the
// GET /api/msg/state batch-by-conv pattern.
//   → { polls: { <poll_id>: { counts: { <idx>: n }, voters: { <idx>: [uid,…] } } } }
export async function pollState(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const conv = new URL(req.url).searchParams.get("conv") || "";
  if (!conv) return json({ error: "conv required" }, 400);
  const mem = await members(env, conv);
  if (!mem.includes(ctx.uid)) return json({ error: "not a member" }, 403);
  const rows = await env.DB_META
    .prepare("SELECT poll_id, option_idx, voter_uid FROM poll_votes WHERE conv=?1")
    .bind(conv).all<{ poll_id: string; option_idx: number; voter_uid: string }>();
  const polls: Record<string, { counts: Record<string, number>; voters: Record<string, string[]> }> = {};
  for (const r of (rows.results || [])) {
    const p = polls[r.poll_id] || (polls[r.poll_id] = { counts: {}, voters: {} });
    const k = String(r.option_idx);
    p.counts[k] = (p.counts[k] || 0) + 1;
    (p.voters[k] || (p.voters[k] = [])).push(r.voter_uid);
  }
  return json({ polls });
}

// Aggregate the votes for a set of poll ids into { counts, voters } per poll.
async function pollTallyFor(env: Env, pollIds: string[]): Promise<Record<string, { counts: Record<string, number>; voters: Record<string, string[]> }>> {
  const out: Record<string, { counts: Record<string, number>; voters: Record<string, string[]> }> = {};
  if (pollIds.length === 0) return out;
  const placeholders = pollIds.map((_, i) => `?${i + 1}`).join(",");
  const rows = await env.DB_META
    .prepare(`SELECT poll_id, option_idx, voter_uid FROM poll_votes WHERE poll_id IN (${placeholders})`)
    .bind(...pollIds).all<{ poll_id: string; option_idx: number; voter_uid: string }>();
  for (const r of (rows.results || [])) {
    const p = out[r.poll_id] || (out[r.poll_id] = { counts: {}, voters: {} });
    const k = String(r.option_idx);
    p.counts[k] = (p.counts[k] || 0) + 1;
    (p.voters[k] || (p.voters[k] = [])).push(r.voter_uid);
  }
  return out;
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
  // STREAM B (stranger safety gate): if the READER (ctx.uid) has NOT yet accepted
  // this thread (their own InboxDO accept_state === 'pending'), DROP the READ
  // receipt fan-out to the sender — the stranger must not learn the recipient has
  // opened/read the pending thread. Delivery (delivered_id) still goes through so
  // the sender's single tick stays honest. On Accept the client resumes read
  // receipts; the withheld read is NEVER sent retroactively. Fails OPEN.
  let readId = b.read_id;
  try {
    const { suppress } = await inboxAcceptState(env, ctx.uid, String(b.conv));
    if (suppress) readId = undefined; // withhold read; keep delivered
  } catch { /* fail open — never block a normal receipt */ }
  const stub = env.INBOX.get(env.INBOX.idFromName(String(b.peer)));
  await stub.fetch("https://inbox/receipt", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ conv: String(b.conv), peer: ctx.uid, delivered_id: b.delivered_id, read_id: readId }),
  });
  return json({ ok: true });
}

// ---- POST /api/msg/receipts (batch, per-message; groups) --------------------
// [AVAGRP-SEENBY-1] WhatsApp-style "Info → seen by": unlike /api/msg/receipt (a
// single conv+peer HIGH-WATER, addressed to exactly ONE peer's inbox — built for
// 1:1, where there is only ever one other party), a group message can be authored
// by ANY member. The reader's client already knows, from the messages it just
// rendered, which ORIGINAL SENDER each newly-seen mid belongs to — so it calls
// this once per distinct target sender in the batch (see AvaGroupDm.sendMsgReceipt
// in app/lib/sync/group_dm.dart), and THIS route does exactly one InboxDO write
// (to that sender's own inbox) per call — never one write per group member per
// message. That is the write-amplification bound: O(distinct senders touched by
// a reader's catch-up), not O(members) or O(unread backlog). Dark behind
// groupReceiptsEnabled (default false) — disabled short-circuits before any
// InboxDO fetch, so flipping it back off is a true kill switch, not just a UI hide.
export async function msgReceiptBatch(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const cfg = await readConfig(env);
  if (!cfg.groupReceiptsEnabled) return json({ ok: true, disabled: true });
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const conv = String(b.conv || "");
  const targetSender = String(b.sender || "");
  const status = b.status === "read" ? "read" : "delivered";
  const msgIds = Array.isArray(b.msg_ids) ? b.msg_ids.map(String).filter(Boolean).slice(0, 300) : [];
  if (!conv || !targetSender || !msgIds.length) return json({ error: "conv, sender, msg_ids required" }, 400);
  const mem = await members(env, conv);
  if (!mem.includes(ctx.uid)) return json({ error: "not a member" }, 403);
  if (ctx.uid === targetSender) return json({ ok: true, skipped: "own" }); // never receipt my own message

  // STREAM B parity (same gate receiptMsg already enforces for 1:1): a reader who
  // has NOT yet accepted this thread must not leak a READ signal to the sender.
  // Delivered still goes through (mirrors receiptMsg's fail-open, delivery-only
  // behaviour under suppression). Fails OPEN — never blocks a normal receipt.
  let effStatus = status;
  try {
    const { suppress } = await inboxAcceptState(env, ctx.uid, conv);
    if (suppress && effStatus === "read") effStatus = "delivered";
  } catch { /* fail open */ }

  const stub = env.INBOX.get(env.INBOX.idFromName(targetSender));
  const res = await stub.fetch("https://inbox/msg_receipt", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ conv, peer: ctx.uid, status: effStatus, msg_ids: msgIds }),
  });
  const live = await res.json().then((r: any) => r?.live === true).catch(() => false);

  const email = (req.headers.get("x-user-email") || "").toString();
  // Two-sided telemetry (CLAUDE.md): tag BOTH the reader (this event's `uid`) and
  // the sender (a second event) so either party's email retrieves the interaction.
  trackGroup(env, ctx.uid, "group_receipt_sent", {
    conv, target_sender: targetSender, status: effStatus, count: msgIds.length, live,
    group: mem.length > 2, email,
  });
  trackGroup(env, targetSender, "group_receipt_received", {
    conv, from: ctx.uid, status: effStatus, count: msgIds.length, group: mem.length > 2,
  });

  return json({ ok: true, live });
}

// ---- GET /api/msg/seen?conv=&mids=a,b,c -------------------------------------
// [AVAGRP-SEENBY-1] On-demand "Info → seen by" fetch for the sheet (chat_thread.dart
// owns the UI). Reads the CALLER's OWN InboxDO — msg_receipts rows only ever exist
// on the ORIGINAL SENDER's inbox (see msgReceipt() in inbox.ts), so this route is
// naturally scoped: nobody can read another member's "who read my message" data
// through it, membership check or not. Not part of /sync (see the write-side
// comment) — the sheet fetches this the moment it opens, then rides the live
// {type:'msg_receipt'} frame (via SyncHub) for anything that changes while open.
export async function msgSeenState(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const url = new URL(req.url);
  const conv = url.searchParams.get("conv") || "";
  const mids = (url.searchParams.get("mids") || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200);
  if (!conv || !mids.length) return json({ receipts: [] });
  const stub = env.INBOX.get(env.INBOX.idFromName(ctx.uid));
  const res = await stub.fetch(`https://inbox/msg_receipt?conv=${encodeURIComponent(conv)}&mids=${encodeURIComponent(mids.join(","))}`);
  const j = (await res.json().catch(() => ({ receipts: [] }))) as { receipts?: unknown[] };
  return json({ receipts: j.receipts || [] });
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

// [MSG-DELETE-1] SELF-SCOPED whole-thread clear (Issue 3, plan §2.2 permanent model).
// Writes the per-account clear cursor to the ACTOR's OWN InboxDO and NOTHING else —
// PROVABLY zero peer writes / zero peer pushes (that is the whole fix). The cursor is
// anchored on the GLOBAL canonical mid (cursor_mid), the InboxDO enforces
// monotonic-max so a stale device can't move it backward. Body:
//   { clear:true, conv, cursor_mid, cursor_seq?, op_id?, client_cursor? }
async function threadClear(req: Request, env: Env, uid: string, b: any): Promise<Response> {
  const conv = String(b.conv ?? "");
  const cursorMid = String(b.cursor_mid ?? b.cursor ?? "");
  const opId = b.op_id != null ? String(b.op_id) : "";
  const traceId = req.headers.get("x-trace-id") ?? opId ?? "";
  const email = (req.headers.get("x-user-email") || "").toString();
  if (!conv || !cursorMid) return json({ error: "conv and cursor_mid required" }, 400);
  // Decision/Mutation telemetry (plan §9.1). scope:"self" is the invariant PostHog
  // uses to prove no recipient ever receives a self-clear.
  try {
    void env.Q_ANALYTICS.send({ event: "thread_clear_requested", uid, ts: Date.now(),
      props: { conv_id: conv, op_id: opId, account_uid: uid, scope: "self", requested_cursor: cursorMid,
        client_cursor: b.client_cursor != null ? String(b.client_cursor) : "", client_message_id: cursorMid,
        client_device_id: b.device_id != null ? String(b.device_id) : "", trace_id: traceId, email, account_id: uid,
        app_name: "avatok", app_version: "", service_name: "avatok-api", worker: true } });
  } catch { /* best-effort */ }
  // The ONLY DO touched is the actor's own InboxDO. No pushDelete, no peer append.
  const stub = env.INBOX.get(env.INBOX.idFromName(uid));
  const res = await stub.fetch("https://inbox/thread_clear", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ conv, cursor_mid: cursorMid, cursor_seq: Number(b.cursor_seq) || 0, op_id: opId || null }),
  });
  const r = (await res.json().catch(() => ({}))) as { ok?: boolean; cursor_before?: string; cursor_after?: string; cursor_seq?: number; clamped?: boolean; live?: boolean };
  const before = r.cursor_before ?? "";
  const after = r.cursor_after ?? cursorMid;
  const clamped = r.clamped === true;
  // Wake the actor's OTHER (possibly sleeping) devices so the clear applies in
  // realtime — SELF only (same uid → all my tokens; never the peer). Silent data push.
  let pushed = false;
  try { await env.Q_PUSH.send({ kind: "thread_clear", to: uid, conv, cursor_mid: after }); pushed = true; }
  catch { /* best-effort; live frame + next /sync converge */ }
  // The canonical event (plan §9.1). peer_writes:0 / peer_pushes:0 are INVARIANT
  // fields emitted on the happy path so PostHog can compute compliance, not just catch
  // catastrophes. cursor_clamped flags a stale-device attempt to move the cursor back.
  try {
    void env.Q_ANALYTICS.send({ event: "thread_clear_committed", uid, ts: Date.now(),
      props: { conv_id: conv, op_id: opId, cursor_before: before, cursor_after: after,
        canonical_message_id: after, canonical_seq: r.cursor_seq ?? 0, monotonic_applied: true,
        cursor_clamped: clamped, scope: "self", peer_writes: 0, peer_pushes: 0, live: r.live === true,
        pushed, trace_id: traceId, email, account_id: uid,
        app_name: "avatok", app_version: "", service_name: "avatok-api", worker: true } });
  } catch { /* best-effort */ }
  if (clamped) {
    try {
      void env.Q_ANALYTICS.send({ event: "thread_clear_cursor_clamped", uid, ts: Date.now(),
        props: { conv_id: conv, existing_cursor: before, incoming_cursor: cursorMid, effective_cursor: after,
          device_id: b.device_id != null ? String(b.device_id) : "", app_version: "", trace_id: traceId,
          email, account_id: uid, app_name: "avatok", service_name: "avatok-api", worker: true } });
    } catch { /* best-effort */ }
  }
  return json({ ok: true, conv, cursor_after: after, cursor_before: before, clamped });
}

// ---- POST /api/msg/hide -----------------------------------------------------
// Owner soft-hides / un-hides one of their OWN messages (delete-for-me, the owner
// side of delete-for-everyone, or Undo). Writes to MY OWN InboxDO only (never the
// peer's) so the hide/Undo syncs across all of MY devices via /sync + live frame.
export async function hideMsg(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  // [MSG-DELETE-1] WHOLE-THREAD CLEAR (Issue 3) — SELF-SCOPED, never touches the peer.
  // A "clear/delete thread for me" is a per-account append-only cursor write to the
  // ACTOR's OWN InboxDO. It fixes the data-loss wipe: no pushDelete, no peer InboxDO
  // write, no tombstone on anyone else. Rides this existing route (b.clear===true) so
  // it fixes ALL app versions without a new route/wiring. Anchored on the GLOBAL
  // canonical mid the client passes (cursor_mid), enforced monotonic-max server-side.
  if (b.clear === true) return await threadClear(req, env, ctx.uid, b);
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
function trackCallLog(env: Env, uid: string, op: "append" | "delete" | "clear", props: Record<string, unknown>, ctx?: ExecutionContext): void {
  if (!env.Q_ANALYTICS) return;
  bg(ctx, env, "call_log_sync", env.Q_ANALYTICS.send({
    event: "call_log_sync", uid, ts: Date.now(),
    props: { op, account_id: uid, app_name: "avatok", service_name: "avatok-api", worker: true, ...props },
  }));
}

// ---- POST /api/call-log/append  { entry_id, name, seed, video, dir, ts } -----
export async function callLogAppend(req: Request, env: Env, execCtx?: ExecutionContext): Promise<Response> {
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
  trackCallLog(env, ctx.uid, "append", { live: r.live, woke_devices: false, video: b.video === true, dir: String(b.dir ?? "outgoing") }, execCtx);
  return json({ ok: true });
}

// ---- POST /api/call-log/delete  { entry_id } --------------------------------
export async function callLogDelete(req: Request, env: Env, execCtx?: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!b.entry_id) return json({ error: "entry_id required" }, 400);
  const entryId = String(b.entry_id);
  const r = await callOp(env, ctx.uid, "delete", { entry_id: entryId });
  const woke = await wakeOwnDevices(env, ctx.uid, { kind: "call_del", entry_id: entryId });
  trackCallLog(env, ctx.uid, "delete", { live: r.live, woke_devices: woke, entry_id: entryId }, execCtx);
  return json({ ok: true });
}

// ---- POST /api/call-log/clear  {} -------------------------------------------
export async function callLogClear(req: Request, env: Env, execCtx?: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const r = await callOp(env, ctx.uid, "clear", {});
  const woke = await wakeOwnDevices(env, ctx.uid, { kind: "call_clear" });
  trackCallLog(env, ctx.uid, "clear", { live: r.live, woke_devices: woke }, execCtx);
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
  if (b.to) {
    // [AVA-IDGATE-1] THIS is the "initiate contact with a stranger" moment — the
    // client calls POST /api/conversations when OPENING a chat, which is why the
    // sendMsg gate alone missed it: convCreate's ensureDm creates the conversation
    // row BEFORE the first message, so by send time dmPreexisted is already true.
    //
    // Gate here, checking existence BEFORE ensureDm creates the row. A row that does
    // NOT yet exist ⇒ this is a NEW conversation with a non-contact ⇒ 'dm_stranger'.
    // Opening an EXISTING conversation (row present) is a known contact ⇒ never gated.
    const to = String(b.to);
    const existed = await env.DB_META.prepare("SELECT 1 FROM conversations WHERE id=?1")
      .bind(dmConvId(ctx.uid, to)).first();
    if (!existed) {
      const g = await gatePublicAction(env, ctx.uid, await emailOf(env, ctx.uid), "dm_stranger");
      if (g) return g;
    }
    return json({ conv: await ensureDm(env, ctx.uid, to, normContext(b.context)), kind: "dm" });
  }
  // group
  const list: string[] = Array.isArray(b.members) ? b.members.map(String) : [];
  if (!list.length) return json({ error: "members or to required" }, 400);
  // [AVA-IDGATE-1] Gate GROUP CREATION on a valid liveness pass (spec §3.1). Was the
  // old onboarding requireLiveness (fail-open, flag livenessOnboardingGate); now the
  // per-action gate: fails CLOSED, 90-day expiry, 403 identity_required → the client
  // opens the consent-first flow and retries.
  { const g = await gatePublicAction(env, ctx.uid, await emailOf(env, ctx.uid), "group_create"); if (g) return g; }
  const conv = "g_" + crypto.randomUUID();
  const now = Date.now();
  const invitees = list.filter((u) => u !== ctx.uid);
  // Pending-membership kill switch (default OFF = current behavior: invitees join
  // immediately). When ON, invitees get a PENDING invite and only become members
  // on Accept — so the router/fan-out is untouched (they aren't members yet).
  const cfg = await readConfig(env);
  // [MSG-GROUP-CAP-1] (J4) Reject an oversized group BEFORE any D1 write. The
  // owner counts as one member, so the resulting size is invitees + 1.
  if (invitees.length + 1 > (Number(cfg.maxGroupMembers) || 256)) {
    return json({ error: "group_too_large", max_members: Number(cfg.maxGroupMembers) || 256 }, 400);
  }
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
  // [MSG-GROUP-CAP-1] (J4) Reject an oversized adopt payload before any D1 write.
  const uniqueMembers = Array.from(new Set(members.filter((u) => u && u !== ctx.uid)));
  const cfg = await readConfig(env);
  if (uniqueMembers.length + 1 > (Number(cfg.maxGroupMembers) || 256)) {
    return json({ error: "group_too_large", max_members: Number(cfg.maxGroupMembers) || 256 }, 400);
  }
  const stmts = [
    env.DB_META.prepare("INSERT OR IGNORE INTO conversations (id, kind, title, created_by, created_at, updated_at) VALUES (?1,'group',?2,?3,?4,?4)")
      .bind(id, b.title ? String(b.title) : null, ctx.uid, now),
    env.DB_META.prepare("INSERT OR IGNORE INTO conversation_members (conv_id, uid, role, joined_at) VALUES (?1,?2,'owner',?3)").bind(id, ctx.uid, now),
    ...uniqueMembers.map((u) =>
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

function trackGroup(env: Env, uid: string, event: string, props: Record<string, unknown>, ctx?: ExecutionContext): void {
  if (!env.Q_ANALYTICS) return;
  bg(ctx, env, event, env.Q_ANALYTICS.send({ event, uid, ts: Date.now(),
    props: { ...props, account_id: uid, app_name: "avatok", service_name: "avatok-api", worker: true } }));
}

// ---- GET /api/conversations/members?conv=ID ---------------------------------
export async function convMembers(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const conv = new URL(req.url).searchParams.get("conv") || "";
  if (!conv) return json({ error: "conv required" }, 400);
  if (!(await convRoleOf(env, conv, ctx.uid))) return json({ error: "not a member" }, 403);
  // [GROUP-AVATAR-1] avatar_url added: this endpoint is what GroupApi.refresh()
  // reads, and refresh() is the ONLY thing that upserts the local Group. If the
  // photo weren't returned here, every refresh would rebuild the group without it
  // and silently wipe the avatar the user just set.
  const c = await env.DB_META
    .prepare("SELECT title, kind, created_by, avatar_url FROM conversations WHERE id=?1")
    .bind(conv).first<{ title: string | null; kind: string; created_by: string; avatar_url: string | null }>();
  const rows = await env.DB_META
    .prepare("SELECT uid, role FROM conversation_members WHERE conv_id=?1")
    .bind(conv).all<{ uid: string; role: string }>();
  return json({
    conv, title: c?.title ?? null, kind: c?.kind ?? null, created_by: c?.created_by ?? null,
    avatar_url: c?.avatar_url ?? null,
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
  // [MSG-GROUP-CAP-1] (J4) Reject before any D1 write if the RESULTING member
  // count (current members + this add batch) would exceed the cap. Applies
  // whether the add lands immediately or as a pending invite — an accepted
  // invite must not be able to push the group over the line either (see the
  // accept-path check in convInviteRespond below).
  const cap = Number(cfg.maxGroupMembers) || 256;
  const currentCount = await env.DB_META.prepare("SELECT COUNT(*) AS n FROM conversation_members WHERE conv_id=?1").bind(conv).first<{ n: number }>();
  if ((currentCount?.n ?? 0) + add.length > cap) {
    return json({ error: "group_too_large", max_members: cap }, 400);
  }
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
    const invites = rows.results ?? [];
    // STREAM B (SAFE-GATE-4): emit one shown event per pending invite the client
    // is about to render as an invite card (group name, adder, member count).
    if (invites.length) {
      trackGroup(env, ctx.uid, "group_invite_shown", { count: invites.length });
    }
    return json({ invites });
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
  // [AVA-IDGATE-1] Gate JOINING a group (accepting an invite) on a valid liveness
  // pass. Declining is always allowed (accept === false skips the gate).
  if (accept) { const g = await gatePublicAction(env, ctx.uid, await emailOf(env, ctx.uid), "group_join"); if (g) return g; }
  const now = Date.now();
  if (accept) {
    // [MSG-GROUP-CAP-1] (J4) An accepted invite must not be able to push a group
    // over the cap either — reject before the membership INSERT.
    const cfg = await readConfig(env);
    const cap = Number(cfg.maxGroupMembers) || 256;
    const currentCount = await env.DB_META.prepare("SELECT COUNT(*) AS n FROM conversation_members WHERE conv_id=?1").bind(conv).first<{ n: number }>();
    if ((currentCount?.n ?? 0) + 1 > cap) {
      return json({ error: "group_too_large", max_members: cap }, 400);
    }
    // Become a real member → the router now fans group messages to this user.
    await env.DB_META.batch([
      env.DB_META.prepare("INSERT OR IGNORE INTO conversation_members (conv_id, uid, role, joined_at) VALUES (?1,?2,'member',?3)").bind(conv, ctx.uid, now),
      env.DB_META.prepare("UPDATE group_invites SET status='accepted' WHERE conv=?1 AND uid=?2").bind(conv, ctx.uid),
      env.DB_META.prepare("UPDATE conversations SET updated_at=?2 WHERE id=?1").bind(conv, now),
    ]);
    trackGroup(env, ctx.uid, "group_invite_accepted", { conv });
    // STREAM B (SAFE-GATE-4): the spec's group-invite telemetry event name.
    trackGroup(env, ctx.uid, "group_invite_joined", { conv });
  } else {
    // STREAM B (SAFE-GATE-4): "Block adder" — when declining, the client may pass
    // block:true to also block the inviter (a non-contact who added them). Reads
    // the inviter BEFORE the decline update, then writes the same `blocks` table
    // the router honours. Best-effort; never fails the decline.
    let adder: string | null = null;
    if (b.block === true) {
      adder = (await env.DB_META.prepare("SELECT inviter FROM group_invites WHERE conv=?1 AND uid=?2").bind(conv, ctx.uid).first<{ inviter: string | null }>())?.inviter ?? null;
    }
    await env.DB_META.batch([
      env.DB_META.prepare("UPDATE group_invites SET status='declined' WHERE conv=?1 AND uid=?2").bind(conv, ctx.uid),
      env.DB_META.prepare("DELETE FROM conversation_members WHERE conv_id=?1 AND uid=?2").bind(conv, ctx.uid),
    ]);
    trackGroup(env, ctx.uid, "group_invite_declined", { conv });
    if (adder) {
      try { await env.DB_META.prepare("INSERT OR IGNORE INTO blocks (uid, blocked_uid, created_at) VALUES (?1,?2,?3)").bind(ctx.uid, adder, now).run(); } catch { /* best-effort */ }
      trackGroup(env, ctx.uid, "group_invite_block_adder", { conv, adder });
    }
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

// ---- POST /api/conversations/avatar  { conv, avatar_url } ------------------
// [GROUP-AVATAR-1] (owner request 2026-07-15) Set or clear a group's photo.
//
// `conversations.avatar_url` already existed and convList already SELECTs it —
// there was simply no way to write it, so every group rendered the generated
// initials tile forever. No migration needed.
//
// The URL must be one WE issued via /upload/public (the same public-R2 pipeline
// as user avatars, so the CDN transform + on-device AvatarCache work unchanged).
// Accepting an arbitrary string here would let any admin point a group photo at
// any third-party URL — a tracking pixel served to every member, and an SSRF
// vector for the moderation fetch below.
export async function convSetAvatar(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const conv = String(b.conv || "");
  if (!conv) return json({ error: "conv required" }, 400);
  // '' clears the photo (owner request: "remove a group profile image").
  const raw = typeof b.avatar_url === "string" ? b.avatar_url.trim() : "";
  if (raw && !isOwnPublicUrl(env, raw)) return json({ error: "bad_avatar_url" }, 400);
  // Admins/owner only — same rule as rename/role changes.
  const myRole = await convRoleOf(env, conv, ctx.uid);
  if (myRole !== "owner" && myRole !== "admin") return json({ error: "forbidden" }, 403);
  await env.DB_META.prepare(
    "UPDATE conversations SET avatar_url=?2, updated_at=?3 WHERE id=?1 AND kind='group'",
  ).bind(conv, raw || null, Date.now()).run();
  trackGroup(env, ctx.uid, raw ? "group_avatar_set" : "group_avatar_removed", { conv });
  return json({ ok: true, avatar_url: raw || null });
}

/// [GROUP-AVATAR-1] True only for a URL on our OWN public blob host — i.e. one
/// that came back from /upload/public. Compared on the parsed origin, never with
/// startsWith: "https://blossom.avatok.ai.evil.com/x" passes a naive prefix test.
function isOwnPublicUrl(env: Env, u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol !== "https:") return false;
    const base = new URL((env as any).BLOSSOM_BASE_URL || "https://blossom.avatok.ai");
    return url.host === base.host;
  } catch {
    return false;
  }
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

