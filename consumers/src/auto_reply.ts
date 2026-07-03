// STREAM F (AI Messenger Batch) — auto-responder "Ava replies while you're away".
//
// Producer: avatok-api sendMsg() hot-path hook enqueues ONE AutoReplyMsg per
// incoming DM that passed the cheap pre-filter (feature on, responder active,
// audience matched, not a stranger-gate thread, not itself an auto-reply). THIS
// consumer is the single source of truth for the caps + loop protection + reply
// generation, so a stale hot-path check can never over-send.
//
// What it does per job (spec AUTOREP-2/3/4):
//   1. Re-load the recipient's responder config (KV mirror, D1 fallback) + re-check
//      it is active — the config may have changed since enqueue.
//   2. LOOP PROTECTION: never reply to an auto-reply (re-checked here even though the
//      producer filters it); enforce the 3-exchanges/contact/day cap and the global
//      50-auto-replies/day/user circuit breaker via per-account KV counters
//      (arsp:<uid>:<peer>:<yyyymmdd> and arsp:<uid>:_all:<yyyymmdd>, 48h TTL).
//   3. Generate the reply — 'once' depth = the canned away message; 'chat' depth
//      (AI mode) = a short Workers-AI reply grounded on the last <=6 messages with a
//      strict persona ("You are <agent>, <owner>'s assistant; be brief; never invent
//      commitments"). Reply-in-sender's-language when the toggle is ON.
//   4. Append the reply to the thread as the RECIPIENT's OWN message (sender =
//      recipient uid) with envelope { auto:true, ... } and a visible prefix
//      "🤖 <agent> (auto-reply): " so it reads as a bot line, and so step 1's loop
//      guard trips on the reply if it ever bounced back.
//   5. URGENT ESCALATION: classify the INCOMING text (AI-mode LLM, else keyword
//      list) → if urgent, fire a high-priority push to the recipient even while away.
//   6. Telemetry (AUTOREP-5): autoreply_sent / autoreply_urgent_escalation, incl. email.
//
// READ-RECEIPT RULE (AUTOREP-3, reuses Stream B plumbing): an auto-reply must NEVER
// mark the sender's messages as read. We satisfy this by simply NEVER recording a
// "seen"/read for the incoming message here — this consumer only ever APPENDS the
// reply; it does not touch the recipient's read_state or post any receipt frame. If
// Stream B lands a shared `shouldSuppressReceipt(...)` helper on the InboxDO receipt
// path, that helper governs the InboxDO-side receipt frame; we do not duplicate the
// logic — see the clearly-commented hook in maybeMarkRead() below (left as a no-op).
import type { Env, AutoReplyMsg, AutoDigestMsg } from "./types";
import { aiText, bumpAiSpend } from "./ai";

const MODE_DEFAULTS: Record<string, string> = {
  travelling:
    "Hey — Davy is travelling and offline right now. I've noted your message; he hasn't read it yet and will see it when he's back.",
  busy: "Hi — I'm heads-down right now and can't reply. I've noted your message and will get back to you soon.",
  sleeping: "Hi — it's night here and I'm asleep. I've saved your message and will reply when I'm up.",
  driving: "Hi — I'm driving right now and can't reply. I've noted your message and will respond when I stop.",
  custom: "Hi — I'm away right now. I've noted your message and will reply as soon as I can.",
};

const PER_CONTACT_DAY_CAP = 3;   // AI-mode exchanges/contact/day (also the 'once' guard: 1st only)
const GLOBAL_DAY_CAP = 50;       // circuit breaker: auto-replies/day/user
const COUNTER_TTL_S = 48 * 3600; // 48h
const KV_CFG_PREFIX = "arsp:cfg:";
const URGENT_RE = /\b(urgent|emergency|asap|911)\b/i;

interface AutoResponderConfig {
  enabled: boolean;
  mode: string;
  message: string;
  audience: "known" | "everyone";
  durationKind: "off" | "hours" | "schedule";
  activeUntil?: number | null;
  schedStart?: number | null;
  schedEnd?: number | null;
  depth: "once" | "chat";
  replyLang: boolean;
  urgentEscalate: boolean;
  awayDigest: boolean;
}

function ymd(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
}

/** Mirror of routes/auto_responder.isActiveNow — kept identical so the consumer's
 *  re-check matches the hot-path check exactly. */
function isActiveNow(cfg: AutoResponderConfig, now = Date.now()): boolean {
  if (!cfg.enabled) return false;
  if (cfg.durationKind === "hours") return cfg.activeUntil != null && now < cfg.activeUntil;
  if (cfg.durationKind === "schedule") {
    if (cfg.schedStart == null || cfg.schedEnd == null) return false;
    const d = new Date(now);
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    return cfg.schedStart <= cfg.schedEnd
      ? mins >= cfg.schedStart && mins < cfg.schedEnd
      : mins >= cfg.schedStart || mins < cfg.schedEnd;
  }
  return true;
}

/** Load the recipient's config from the KV mirror (fast), D1 fallback. */
async function loadConfig(env: Env, uid: string): Promise<AutoResponderConfig | null> {
  try {
    const kv = (await env.TOKENS.get(KV_CFG_PREFIX + uid, "json")) as AutoResponderConfig | null;
    if (kv) return kv;
  } catch { /* fall through */ }
  try {
    const r = await env.DB_META.prepare(
      "SELECT * FROM auto_responder_settings WHERE uid=?1",
    ).bind(uid).first<Record<string, unknown>>();
    if (!r) return null;
    const mode = String(r.mode ?? "travelling");
    return {
      enabled: !!Number(r.enabled ?? 0), mode,
      message: (typeof r.message === "string" && r.message.trim()) ? String(r.message).slice(0, 200) : (MODE_DEFAULTS[mode] ?? MODE_DEFAULTS.custom),
      audience: r.audience === "everyone" ? "everyone" : "known",
      durationKind: (["off", "hours", "schedule"].includes(String(r.duration_kind)) ? String(r.duration_kind) : "off") as AutoResponderConfig["durationKind"],
      activeUntil: r.active_until == null ? null : Number(r.active_until),
      schedStart: r.sched_start == null ? null : Number(r.sched_start),
      schedEnd: r.sched_end == null ? null : Number(r.sched_end),
      depth: r.depth === "chat" ? "chat" : "once",
      replyLang: r.reply_lang == null ? true : !!Number(r.reply_lang),
      urgentEscalate: r.urgent_escalate == null ? true : !!Number(r.urgent_escalate),
      awayDigest: r.away_digest == null ? true : !!Number(r.away_digest),
    };
  } catch { return null; }
}

/** Read a KV integer counter (0 when absent). */
async function counter(env: Env, key: string): Promise<number> {
  try { return Number((await env.TOKENS.get(key)) || 0) || 0; } catch { return 0; }
}
async function bumpCounter(env: Env, key: string): Promise<void> {
  try {
    const n = await counter(env, key);
    await env.TOKENS.put(key, String(n + 1), { expirationTtl: COUNTER_TTL_S });
  } catch { /* best-effort */ }
}

/** The owner's display name → the agent name used in the visible prefix + persona.
 *  One cheap D1 lookup; falls back to "Ava". */
async function ownerName(env: Env, uid: string): Promise<string> {
  try {
    const r = await env.DB_META.prepare(
      "SELECT display_name, handle FROM users WHERE uid=?1 LIMIT 1",
    ).bind(uid).first<{ display_name: string | null; handle: string | null }>();
    return (r?.display_name || r?.handle || "Ava").toString();
  } catch { return "Ava"; }
}

/** Recent thread text (last <=6 messages, oldest→newest) for the AI reply context.
 *  Pulled from the recipient's InboxDO /export (server-readable plaintext). */
async function recentThread(env: Env, recipient: string, conv: string): Promise<Array<{ sender: string; body: string }>> {
  try {
    const INBOX = env.INBOX!;
    const stub = INBOX.get(INBOX.idFromName(recipient));
    const res = await stub.fetch("https://inbox/export?limit=200", { method: "GET" });
    const j = (await res.json().catch(() => ({}))) as { messages?: Array<{ conv: string; sender: string; body: string }> };
    const rows = (j.messages || []).filter((m) => m.conv === conv && typeof m.body === "string" && m.body.trim());
    // /export returns newest-first; take the last 6 and re-order oldest→newest.
    return rows.slice(0, 6).reverse().map((m) => ({ sender: m.sender, body: String(m.body).slice(0, 500) }));
  } catch { return []; }
}

/** Append a message to a user's InboxDO as their OWN message (cross-script DO). */
async function inboxAppend(env: Env, owner: string, sender: string, conv: string, body: string): Promise<void> {
  const INBOX = env.INBOX!;
  const stub = INBOX.get(INBOX.idFromName(owner));
  await stub.fetch("https://inbox/append", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ conv, sender, kind: "text", body, media_ref: null, created_at: Date.now(), owner }),
  });
}

// READ-RECEIPT SUPPRESSION HOOK (AUTOREP-3). Deliberately a NO-OP: an auto-reply
// must never mark the sender's message read, so we simply never record a seen here.
// If/when Stream B ships a shared `shouldSuppressReceipt(...)` on the InboxDO receipt
// path, THAT governs any receipt frame — we do NOT duplicate receipt logic. This
// function exists only to make the intent explicit and greppable.
function maybeMarkRead(): void {
  /* intentionally empty — never mark sender messages read from an auto-reply */
}

/** AI-mode short reply grounded on recent thread + strict persona. Falls back to the
 *  canned message on any error/empty. */
async function aiReply(env: Env, agent: string, owner: string, cfg: AutoResponderConfig, thread: Array<{ sender: string; body: string }>, incoming: string): Promise<string> {
  const model = env.BRAIN_EXTRACT_MODEL || "@cf/google/gemma-4-26b-a4b-it";
  const langRule = cfg.replyLang
    ? "Reply in the SAME language the last incoming message is written in. "
    : "";
  const sys =
    `You are ${agent}, ${owner}'s assistant. ${owner} is away right now. ` +
    "Reply to the person messaging in ONE short, warm sentence on their behalf. " +
    "Be brief. NEVER invent commitments, times, prices, or promises. Do not answer questions you cannot know — " +
    `just acknowledge and say ${owner} will reply when back. ${langRule}` +
    "Return ONLY the reply text, no quotes, no prefix.";
  const convText = thread.map((m) => `${m.sender === owner ? owner : "Them"}: ${m.body}`).join("\n");
  const started = Date.now();
  try {
    const out = await env.AI.run(model as any, {
      messages: [{ role: "user", content: `${sys}\n\nRecent conversation:\n${convText}\n\nLatest incoming message:\n${incoming}\n\n${agent}'s one-sentence reply:` }],
      max_tokens: 160,
      temperature: 0.4,
    });
    await bumpAiSpend(env, Date.now() - started);
    const txt = aiText(out).trim().replace(/^["']|["']$/g, "");
    return txt || cfg.message;
  } catch {
    return cfg.message;
  }
}

/** AI-mode urgency classification; keyword fallback in canned mode. */
async function classifyUrgent(env: Env, aiMode: boolean, incoming: string): Promise<boolean> {
  if (!incoming) return false;
  if (!aiMode) return URGENT_RE.test(incoming);
  const model = env.BRAIN_EXTRACT_MODEL || "@cf/google/gemma-4-26b-a4b-it";
  const started = Date.now();
  try {
    const out = await env.AI.run(model as any, {
      messages: [{ role: "user", content: `Is the following message URGENT (an emergency, time-critical, or needs an immediate human)? Answer ONLY "yes" or "no".\n\nMessage: ${incoming.slice(0, 600)}` }],
      max_tokens: 6, temperature: 0,
    });
    await bumpAiSpend(env, Date.now() - started);
    return /\byes\b/i.test(aiText(out));
  } catch {
    return URGENT_RE.test(incoming); // fail to the cheap keyword check
  }
}

async function track(env: Env, uid: string, event: string, props: Record<string, unknown>): Promise<void> {
  try {
    await env.Q_ANALYTICS?.send({ event, uid, ts: Date.now(),
      props: { ...props, app_name: "avatok", service_name: "avatok-consumers", worker: true, account_id: uid } });
  } catch { /* best-effort */ }
}

/** Owner email identifier for telemetry (spec AUTOREP-5: events must be pullable by
 *  email). Raw email is NOT stored server-side (privacy: users holds email_hash only),
 *  so we emit the email_hash. PostHog already maps the uid → the person whose email
 *  was set via Analytics.setUserKeys() on the client, so an event carrying uid +
 *  email_hash is fully pullable by the user's email. */
async function ownerEmail(env: Env, uid: string): Promise<string | null> {
  try {
    const r = await env.DB_META.prepare("SELECT email_hash FROM users WHERE uid=?1 LIMIT 1").bind(uid).first<{ email_hash: string | null }>();
    return r?.email_hash ?? null;
  } catch { return null; }
}

export async function handleAutoReply(m: AutoReplyMsg, env: Env): Promise<void> {
  const { recipient, sender, conv } = m;
  const incoming = (m.incoming_text || "").trim();
  const now = Date.now();
  const day = ymd(now);

  // 1) Re-load + re-check active (config may have changed since enqueue).
  const cfg = await loadConfig(env, recipient);
  if (!cfg || !isActiveNow(cfg, now)) return;
  const aiMode = cfg.depth === "chat";

  // 2) Loop protection — never respond to an auto-reply (belt-and-braces; the
  //    producer already filters, but a job could be replayed on retry).
  if (incoming.startsWith("{")) {
    try { const o = JSON.parse(incoming); if (o && o.auto === true) return; } catch { /* not JSON */ }
  }

  // 3) Caps. Per-account KV counters (48h TTL). Per-contact: 'once' = 1/contact/day,
  //    'chat' = up to 3/contact/day. Global circuit breaker = 50/day/user.
  const perKey = `arsp:${recipient}:${sender}:${day}`;
  const allKey = `arsp:${recipient}:_all:${day}`;
  const perContactCap = aiMode ? PER_CONTACT_DAY_CAP : 1;
  const [perCount, allCount] = await Promise.all([counter(env, perKey), counter(env, allKey)]);
  const capped = perCount >= perContactCap || allCount >= GLOBAL_DAY_CAP;

  // Urgent escalation runs EVEN IF capped (a capped contact can still have an
  // emergency): classify first so we can escalate regardless of the reply gate.
  let urgent = false;
  if (cfg.urgentEscalate) {
    urgent = await classifyUrgent(env, aiMode, incoming);
    if (urgent) {
      try {
        await env.Q_PUSH?.send({ kind: "notify", to: recipient, fromName: "⚠️ Urgent message", preview: incoming.slice(0, 140) || "Someone marked a message urgent" });
      } catch { /* best-effort */ }
      const emailHash = await ownerEmail(env, recipient);
      await track(env, recipient, "autoreply_urgent_escalation", { peer: sender, conv, ai_mode: aiMode, email_hash: emailHash });
    }
  }

  if (capped) {
    await track(env, recipient, "autoreply_sent", { ai_mode: aiMode, lang: cfg.replyLang, capped: true, peer: sender, conv, mode: cfg.mode });
    return;
  }

  // 4) Generate the reply. `owner` = the away user's display name; the assistant
  //    identity is "Ava" (the app's assistant). The visible prefix uses the agent
  //    name ("Ava") per spec ("🤖 <agent name> (auto-reply): ").
  const owner = await ownerName(env, recipient);
  const agent = "Ava";
  let replyText: string;
  if (aiMode) {
    const thread = await recentThread(env, recipient, conv);
    replyText = await aiReply(env, agent, owner, cfg, thread, incoming);
  } else {
    replyText = cfg.message;
  }
  const envelope = JSON.stringify({ t: "text", auto: true, mode: cfg.mode, ai: aiMode, body: `🤖 ${agent} (auto-reply): ${replyText}` });

  // Append the auto-reply to the thread AS the recipient (their own outgoing msg).
  // Fan it out to BOTH inboxes so the sender sees it and the away user has a record.
  try { await inboxAppend(env, sender, recipient, conv, envelope); } catch { /* best-effort */ }
  try { await inboxAppend(env, recipient, recipient, conv, envelope); } catch { /* best-effort */ }

  // READ-RECEIPT RULE: do NOT mark the sender's message read (Stream B plumbing).
  maybeMarkRead();

  // 5) Count it + record the peer for the away digest (AUTOREP-4). We keep a small
  //    per-day JSON log (arsp:<uid>:digest:<day>) of {peer, name, snippet} — one entry
  //    per contact (first reply wins the snippet) — because KV can't be listed by
  //    prefix. The digest handler reads + clears this on disable / schedule-end.
  await Promise.all([bumpCounter(env, perKey), bumpCounter(env, allKey)]);
  const peerName = await ownerName(env, sender); // the sender's display name for the digest line
  await recordDigestPeer(env, recipient, sender, peerName, replyText);

  await track(env, recipient, "autoreply_sent", { ai_mode: aiMode, lang: cfg.replyLang, capped: false, peer: sender, conv, mode: cfg.mode, urgent });
}

interface DigestEntry { peer: string; name: string; snippet: string }

async function recordDigestPeer(env: Env, uid: string, peer: string, peerName: string, snippet: string): Promise<void> {
  const key = `arsp:${uid}:digest:${ymd()}`;
  try {
    const cur = ((await env.TOKENS.get(key, "json")) as DigestEntry[] | null) ?? [];
    if (cur.some((e) => e.peer === peer)) return; // one line per contact
    cur.push({ peer, name: peerName, snippet: snippet.slice(0, 80) });
    await env.TOKENS.put(key, JSON.stringify(cur.slice(0, 200)), { expirationTtl: COUNTER_TTL_S });
  } catch { /* best-effort */ }
}

// STREAM F (AUTOREP-4) — Away digest. On disable / schedule-end, Ava posts a
// SELF-THREAD digest ("While you were away I replied to N people: …") with per-contact
// one-liners. Triggered by an AutoDigestMsg (producer: the PUT route on an
// enabled→disabled transition, and the cron schedule-end sweep). The self-thread is
// the user's own conv with themselves (dm_<uid>__<uid>), so it appears as an Ava note.
export async function handleAutoDigest(m: AutoDigestMsg, env: Env): Promise<void> {
  const uid = m.uid;
  const day = m.day || ymd();
  const key = `arsp:${uid}:digest:${day}`;
  let entries: DigestEntry[] = [];
  try { entries = ((await env.TOKENS.get(key, "json")) as DigestEntry[] | null) ?? []; } catch { /* none */ }
  if (!entries.length) return; // nothing replied → no digest
  const lines = entries.slice(0, 20).map((e) => {
    const nm = e.name && e.name.trim() ? e.name : e.peer;
    return `• ${nm}${e.snippet ? ` — "${e.snippet}"` : ""}`;
  }).join("\n");
  const more = entries.length > 20 ? `\n…and ${entries.length - 20} more.` : "";
  const body = JSON.stringify({
    t: "text", auto: true, digest: true,
    body: `🤖 Ava — while you were away I auto-replied to ${entries.length} ${entries.length === 1 ? "person" : "people"}:\n${lines}${more}`,
  });
  const selfConv = `dm_${uid}__${uid}`; // self-thread (Ava's note channel to the owner)
  try { await inboxAppend(env, uid, uid, selfConv, body); } catch { /* best-effort */ }
  try { await env.TOKENS.delete(key); } catch { /* best-effort */ }
  // `replies` = total auto-replies sent that day (global counter); `contacts` = distinct people.
  const totalReplies = await counter(env, `arsp:${uid}:_all:${day}`);
  await track(env, uid, "autoresponder_digest", { replies: totalReplies || entries.length, contacts: entries.length, email_hash: await ownerEmail(env, uid) });
}
