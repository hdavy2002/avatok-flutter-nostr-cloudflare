// ai_chat.ts — STREAM G "AI in chats" (batch of 4). Cloudflare-native, server-
// readable arch (per-user InboxDO). Cheap LLM helpers over OpenRouter — mirrors
// the auth + call pattern in ava_gemini.ts (requireUser → OpenRouter → trackUser).
//
//   POST /api/ai/catchup       { conv, since_seq? }        → { bullets:[{sender,text}], msg_count }
//   POST /api/ai/smart-replies { msgs:[{me,text}] }        → { suggestions:[..3] }
//   POST /api/ai/translate     { text, to }                → { text, to }
//   POST /api/safety/score     { conv }                    → { score, reason }   ← Stream B contract
//   POST /api/ai/group-translate { conv, lang, msgs:[{id,text}] } → { items:[{id,text,cached}], cached_pct }
//
// All AI features here are gated by the messaging AvaBrain guardrail (the
// `messaging` per-app consent capability) EXCEPT /api/safety/score, which is a
// safety surface (Stream B) and runs regardless of the learning toggle.
//
// Cost discipline: cheap model, tight max_tokens, KV caching for the two
// immutable-input surfaces (group translation per msg_id+lang, safety score per
// conv+msg-count). Summaries are NEVER stored server-side (D6).
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { trackUser } from "../hooks";
import { emailFor } from "../lib/identity";
import { readConfig } from "./config";
import { moderate } from "../lib/moderation";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Cheap chat model for these utility calls. Override via env.OPENROUTER_UTIL_MODEL.
// (Distinct from ChatAVA's z-ai/glm-5.2 — these are one-shot, latency-sensitive.)
function utilModel(env: Env): string {
  return ((env as any).OPENROUTER_UTIL_MODEL as string) || "google/gemini-2.5-flash-lite";
}

function orHeaders(key: string): Record<string, string> {
  return {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    "HTTP-Referer": "https://avatok.ai",
    "X-Title": "AvaTOK AI-in-chats",
  };
}

/// One-shot OpenRouter completion. Returns trimmed text, or throws on hard fail.
async function llm(env: Env, system: string, user: string, maxTokens = 400, temperature = 0.3): Promise<string> {
  const key = (env as any).OPENROUTER_API_KEY as string | undefined;
  if (!key) throw new Error("openrouter key missing");
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: orHeaders(key),
    body: JSON.stringify({
      model: utilModel(env),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
      temperature,
    }),
  });
  const out: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`openrouter ${res.status}: ${String(out?.error?.message ?? out?.error ?? "").slice(0, 160)}`);
  }
  return String(out?.choices?.[0]?.message?.content ?? "").trim();
}

// ---------------------------------------------------------------------------
// AvaBrain "messaging" guardrail (per-app opt-out toggle, default ON). The
// consent booleans live in DB_BRAIN.brain_consent (server-readable). We require
// BOTH the master switch AND the `messaging` capability. Absence of a row =
// enabled (opt-out model). FAIL-OPEN on a read error is acceptable here — these
// are convenience AI helpers, not private-content ingestion — but we keep an
// explicit opt-out honoured. (Safety score does NOT call this.)
// ---------------------------------------------------------------------------
async function messagingBrainOn(env: Env, uid: string): Promise<boolean> {
  try {
    const rs = await env.DB_BRAIN.prepare(
      `SELECT capability, enabled FROM brain_consent WHERE uid=?1 AND capability IN ('master','messaging')`,
    ).bind(uid).all();
    for (const r of (rs.results ?? []) as any[]) {
      if (Number(r.enabled) === 0) return false; // explicit opt-out of master or messaging
    }
    return true; // default ON
  } catch { return true; } // convenience feature → fail-open (an opt-out row would still be honoured when readable)
}

// ---------------------------------------------------------------------------
// Pull TEXT-ONLY messages for one conversation from the CALLER's OWN InboxDO
// (server-readable arch). `sinceSeq` (InboxDO row id) filters to unread. Media
// rows are skipped per D6 (kind != 'text' or empty body). Returns oldest-first.
// Uses the DO's /convtext endpoint (added in do/inbox.ts for this stream).
// ---------------------------------------------------------------------------
interface ConvMsg { id: number; conv: string; sender: string; kind: string; body: string; created_at: number; }
async function convText(env: Env, uid: string, conv: string, sinceSeq: number, limit: number): Promise<ConvMsg[]> {
  const stub = env.INBOX.get(env.INBOX.idFromName(uid));
  const url = `https://inbox/convtext?conv=${encodeURIComponent(conv)}&since=${sinceSeq}&limit=${limit}`;
  const res = await stub.fetch(url);
  if (!res.ok) return [];
  const j: any = await res.json().catch(() => ({}));
  const rows: ConvMsg[] = Array.isArray(j?.messages) ? j.messages : [];
  // Belt-and-braces: keep only real text (the DO already filters, but this
  // guarantees the media-skip rule even if an older DO build answers).
  return rows.filter((r) => (r.kind === "text" || r.kind === "ava") && typeof r.body === "string" && r.body.trim().length > 0);
}

/// Best-effort display name for a uid (KV-cached email local-part fallback). We
/// avoid a Clerk round-trip per sender — the caller's own copy usually already
/// carries a label, but for attribution a short handle is enough.
function shortName(sender: string): string {
  if (!sender) return "Someone";
  // uids are opaque; use a stable short suffix so bullets read distinctly.
  return `@${sender.slice(0, 6)}`;
}

// ===========================================================================
// [GROUP-AI-1] POST /api/ai/catchup { conv, since_seq? }
// "What did I miss?" — summarise unread text into ≤6 attributed bullets.
// NEVER stored server-side. Guardrail-gated (button hidden client-side too).
// ===========================================================================
export async function aiCatchup(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const email = await emailFor(env, ctx.uid);

  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const conv = String(b?.conv ?? "").trim();
  if (!conv) return json({ error: "conv required" }, 400);
  const sinceSeq = Math.max(0, Math.trunc(Number(b?.since_seq ?? 0)));

  if (!(await messagingBrainOn(env, ctx.uid))) {
    return json({ error: "messaging AI is off", reason: "guardrail_off", flag: "brain:messaging" }, 403);
  }

  const msgs = await convText(env, ctx.uid, conv, sinceSeq, 200);
  if (msgs.length === 0) return json({ bullets: [], msg_count: 0 });

  // Build a compact, attributed transcript (sender label the client sent along,
  // else a short handle). Cap total chars so a huge unread pile stays cheap.
  const transcript = msgs
    .map((m) => `${shortName(m.sender)}: ${m.body.replace(/\s+/g, " ").trim()}`)
    .join("\n")
    .slice(0, 8000);

  const system = [
    "You summarise a group chat's unread messages so a returning member can catch up fast.",
    "Output AT MOST 6 short bullets. Each bullet starts with the speaker's handle in the form",
    "'@handle:' then a one-line paraphrase of what they contributed. Attribute correctly.",
    "Do NOT invent facts. Do NOT include greetings or filler. Output ONLY the bullets, one per line,",
    "each beginning with '- '.",
  ].join(" ");

  let raw = "";
  try {
    raw = await llm(env, system, transcript, 350, 0.2);
  } catch (e: any) {
    trackUser(env, ctx.uid, email, "ai_catchup_error", "messaging", { conv, msg_count: msgs.length, reason: String(e?.message ?? e).slice(0, 160) });
    return json({ error: "summary failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }

  // Parse "- @handle: text" lines into structured bullets.
  const bullets = raw
    .split("\n")
    .map((l) => l.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((line) => {
      const m = line.match(/^(@?[^:]{1,40}):\s*(.+)$/);
      return m ? { sender: m[1].trim(), text: m[2].trim() } : { sender: "", text: line };
    });

  trackUser(env, ctx.uid, email, "ai_catchup_used", "messaging", { conv, msg_count: msgs.length, bullets: bullets.length });
  // D6: summary is returned, never persisted server-side.
  return json({ bullets, msg_count: msgs.length });
}

// ===========================================================================
// [GROUP-AI-4] POST /api/ai/smart-replies { msgs:[{me,text}] (last<=4) }
// 3 short reply suggestions. Guardrail-gated. Flag smartRepliesEnabled (ON).
// ===========================================================================
export async function aiSmartReplies(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const email = await emailFor(env, ctx.uid);

  const cfg = await readConfig(env);
  if ((cfg as any).smartRepliesEnabled === false) {
    return json({ suggestions: [], reason: "disabled", flag: "smartRepliesEnabled" });
  }
  if (!(await messagingBrainOn(env, ctx.uid))) {
    return json({ suggestions: [], reason: "guardrail_off", flag: "brain:messaging" });
  }

  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const raw = Array.isArray(b?.msgs) ? b.msgs : [];
  const msgs = raw.slice(-4).map((m: any) => ({ me: m?.me === true, text: String(m?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 500) })).filter((m: { text: string }) => m.text);
  if (msgs.length === 0) return json({ suggestions: [] });

  const transcript = msgs.map((m: { me: boolean; text: string }) => `${m.me ? "Me" : "Them"}: ${m.text}`).join("\n");
  const system = [
    "You suggest 3 very short chat replies (each under 6 words) the user ('Me') could send next,",
    "in reply to the latest message. Keep them natural, distinct, and safe. No emoji unless natural.",
    "Output ONLY the 3 replies, one per line, no numbering, no quotes.",
  ].join(" ");

  let out = "";
  try {
    out = await llm(env, system, transcript, 60, 0.6);
  } catch {
    return json({ suggestions: [] }); // silent — chips just don't show
  }
  const suggestions = out.split("\n").map((s) => s.replace(/^[-*\d.\)\s"]+/, "").replace(/"$/, "").trim()).filter(Boolean).slice(0, 3);

  trackUser(env, ctx.uid, email, "smart_reply_shown", "messaging", { n: suggestions.length });
  return json({ suggestions });
}

// ===========================================================================
// [GROUP-AI-5] POST /api/ai/translate { text, to }
// One-shot text translation to the user's Stream-A language. Guardrail-gated.
// Client caches the result in its local drift message cache (scoped).
// ===========================================================================
export async function aiTranslate(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const email = await emailFor(env, ctx.uid);

  if (!(await messagingBrainOn(env, ctx.uid))) {
    return json({ error: "messaging AI is off", reason: "guardrail_off", flag: "brain:messaging" }, 403);
  }

  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const text = String(b?.text ?? "").trim().slice(0, 4000);
  const to = String(b?.to ?? "").trim().slice(0, 40);
  if (!text) return json({ error: "text required" }, 400);
  if (!to) return json({ error: "to (target language) required" }, 400);

  const system = `Translate the user's message into ${to}. Output ONLY the translation, preserving meaning and tone. If it is already in ${to}, return it unchanged.`;
  let translated = "";
  try {
    translated = await llm(env, system, text, 600, 0.2);
  } catch (e: any) {
    return json({ error: "translate failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }

  trackUser(env, ctx.uid, email, "inline_translate_used", "messaging", { lang: to, len: text.length });
  return json({ text: translated, to });
}

// ===========================================================================
// [GROUP-AI-2] POST /api/ai/group-translate { conv, lang, msgs:[{id,text}] }
// Translate on FETCH for an opted-in group member. Immutable msgs → KV cache
// key tr:<msg_id>:<lang> (30-day TTL). Voice notes are NOT translated (client
// only sends text rows). Flag groupTranslationEnabled (default OFF, cost watch).
// ===========================================================================
const TR_TTL = 30 * 24 * 3600; // 30 days

export async function aiGroupTranslate(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const email = await emailFor(env, ctx.uid);

  const cfg = await readConfig(env);
  if ((cfg as any).groupTranslationEnabled !== true) {
    return json({ error: "group translation disabled", flag: "groupTranslationEnabled" }, 503);
  }
  if (!(await messagingBrainOn(env, ctx.uid))) {
    return json({ error: "messaging AI is off", reason: "guardrail_off", flag: "brain:messaging" }, 403);
  }

  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const conv = String(b?.conv ?? "").trim();
  const lang = String(b?.lang ?? "").trim().slice(0, 40);
  if (!lang) return json({ error: "lang required" }, 400);
  const inMsgs = (Array.isArray(b?.msgs) ? b.msgs : [])
    .map((m: any) => ({ id: String(m?.id ?? "").slice(0, 128), text: String(m?.text ?? "").trim().slice(0, 2000) }))
    .filter((m: { id: string; text: string }) => m.id && m.text)
    .slice(0, 50); // cap batch
  if (inMsgs.length === 0) return json({ items: [], cached_pct: 100 });

  let cachedHits = 0;
  const items: Array<{ id: string; text: string; cached: boolean }> = [];
  for (const m of inMsgs) {
    const kvKey = `tr:${m.id}:${lang}`;
    let translated: string | null = null;
    try { translated = await env.TOKENS.get(kvKey); } catch { /* miss */ }
    if (translated !== null) {
      cachedHits++;
      items.push({ id: m.id, text: translated, cached: true });
      continue;
    }
    try {
      const t = await llm(env, `Translate the user's message into ${lang}. Output ONLY the translation.`, m.text, 600, 0.2);
      try { await env.TOKENS.put(kvKey, t, { expirationTtl: TR_TTL }); } catch { /* best-effort cache */ }
      items.push({ id: m.id, text: t, cached: false });
    } catch {
      items.push({ id: m.id, text: m.text, cached: false }); // fall back to original on failure
    }
  }

  const cachedPct = Math.round((cachedHits / inMsgs.length) * 100);
  trackUser(env, ctx.uid, email, "group_translate_msgs", "messaging", { conv, lang, count: inMsgs.length, cached_pct: cachedPct });
  return json({ items, cached_pct: cachedPct });
}

// ===========================================================================
// [GROUP-AI-6] POST /api/safety/score { conv }   ← STREAM B CONTRACT (stable)
// Take the stranger thread's first <=20 messages, cheap classification →
// { score:0..1, reason:string }. Cached per conv+msg-count in KV. NOT guardrail-
// gated (safety surface). Called by the Safety Shield button (Stream B) and
// auto-called once when a stranger thread first renders (scamAutoScanEnabled).
// CONTRACT: always returns { score:number, reason:string }. Keep stable.
// ===========================================================================
export async function safetyScore(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const email = await emailFor(env, ctx.uid);

  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const conv = String(b?.conv ?? "").trim();
  const auto = b?.auto === true;
  if (!conv) return json({ error: "conv required" }, 400);

  // Pull first <=20 messages of the thread from the caller's OWN InboxDO.
  const msgs = (await convText(env, ctx.uid, conv, 0, 20)).slice(0, 20);
  if (msgs.length === 0) return json({ score: 0, reason: "No messages to assess yet." });

  // Cache per conv + message count — the score only changes as new messages
  // arrive, so keying on the count gives a stable, cheap re-read.
  const cacheKey = `safety:${conv}:${msgs.length}`;
  try {
    const cached = await env.TOKENS.get(cacheKey, "json");
    if (cached && typeof (cached as any).score === "number") {
      const c = cached as { score: number; reason: string };
      trackUser(env, ctx.uid, email, "safety_score_shown", "messaging", { conv, score_bucket: bucket(c.score), auto, cached: true });
      return json({ score: c.score, reason: c.reason });
    }
  } catch { /* miss */ }

  const transcript = msgs.map((m) => `${m.sender === ctx.uid ? "Me" : "Them"}: ${m.body.replace(/\s+/g, " ").trim()}`).join("\n").slice(0, 6000);
  const system = [
    "You are a scam/phishing/spam classifier for a chat with a stranger.",
    "Assess the likelihood the OTHER party ('Them') is running a scam. Look for: payment redirection,",
    "crypto/investment lures, artificial urgency, impersonation, and link/domain mismatch.",
    'Respond with STRICT JSON only: {"score": <0..1 float>, "reason": "<one short line>"}.',
    "score 0 = clearly safe, 1 = almost certainly a scam. No prose outside the JSON.",
  ].join(" ");

  let score = 0;
  let reason = "Unable to assess.";
  try {
    const out = await llm(env, system, transcript, 120, 0.1);
    const parsed = parseScore(out);
    score = parsed.score;
    reason = parsed.reason;
    try { await env.TOKENS.put(cacheKey, JSON.stringify({ score, reason }), { expirationTtl: 7 * 24 * 3600 }); } catch { /* best-effort */ }
  } catch (e: any) {
    // Fail-open on the classifier: never block, return a neutral score.
    trackUser(env, ctx.uid, email, "safety_score_error", "messaging", { conv, reason: String(e?.message ?? e).slice(0, 160) });
    return json({ score: 0, reason: "Couldn't assess this chat right now." });
  }

  trackUser(env, ctx.uid, email, "safety_score_shown", "messaging", { conv, score_bucket: bucket(score), auto, cached: false });
  return json({ score, reason });
}

// ===========================================================================
// [PROFILE-BIO-1] POST /api/ai/bio { seed }
// "Write my bio" sparkle button on the profile-setup screen. The user types 1–2
// rough lines about themselves; we expand them into a friendly, safe, ≤200-char
// first-person profile description. The prompt HARD-refuses to produce any
// solicitation / adult / unsafe content, and we re-moderate the output server-
// side so a jailbroken seed can't slip an unsafe bio through. NOT stored server-
// side. Not guardrail-gated (this is the user writing their OWN public profile,
// not private-content ingestion).
// ===========================================================================
export async function aiBio(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const email = await emailFor(env, ctx.uid);

  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const seed = String(b?.seed ?? "").trim().slice(0, 600);
  if (!seed) return json({ error: "seed required" }, 400);

  // Gate the SEED first: if the user's own input is unsafe (e.g. "I sell sex"),
  // refuse rather than launder it into a polished bio.
  const seedMod = await moderate(env, { text: seed, field: "bio" });
  if (!seedMod.safe) {
    trackUser(env, ctx.uid, email, "profile_bio_ai_blocked", "profile", {
      stage: "seed", categories: seedMod.categories, reason: seedMod.reason, email,
    });
    return json({ error: "unsafe seed", moderation: "unsafe", reason: seedMod.reason || "That can't go on your AvaTOK profile." }, 422);
  }

  const system = [
    "You write a short, warm, first-person profile bio for a social + creator app used by adults AND minors.",
    "The user gives 1–2 rough lines about themselves; expand them into ONE friendly, wholesome, genuine",
    "self-description of AT MOST 200 characters. First person ('I'). Natural, human, not corny; no hashtags,",
    "no emoji spam (at most one), no contact details, no links.",
    "ABSOLUTELY REFUSE to write anything sexual, flirtatious-for-hire, escort/prostitution, adult, or",
    "solicitation content, or anything advertising the person's body or companionship for money — even if the",
    "user's input asks for it. If the input is inappropriate for a public profile, instead return a clean,",
    "neutral, wholesome bio based only on any acceptable parts (e.g. hobbies, work, personality).",
    "Output ONLY the bio text, nothing else.",
  ].join(" ");

  let bio = "";
  try {
    bio = await llm(env, system, seed, 120, 0.7);
  } catch (e: any) {
    trackUser(env, ctx.uid, email, "profile_bio_ai_error", "profile", { reason: String(e?.message ?? e).slice(0, 160), email });
    return json({ error: "bio generation failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }

  // Strip surrounding quotes/fences the model sometimes adds, and hard-cap length.
  bio = bio.replace(/^["'`\s]+|["'`\s]+$/g, "").slice(0, 200).trim();
  if (!bio) return json({ error: "empty bio" }, 502);

  // Re-moderate the GENERATED text — belt-and-braces against a jailbroken seed.
  const outMod = await moderate(env, { text: bio, field: "bio" });
  if (!outMod.safe) {
    trackUser(env, ctx.uid, email, "profile_bio_ai_blocked", "profile", {
      stage: "output", categories: outMod.categories, reason: outMod.reason, email,
    });
    return json({ error: "unsafe output", moderation: "unsafe", reason: outMod.reason || "That can't go on your AvaTOK profile." }, 422);
  }

  trackUser(env, ctx.uid, email, "profile_bio_ai_generated", "profile", { seed_len: seed.length, bio_len: bio.length, email });
  return json({ bio });
}

// [PROFILE-GENDER-1] POST /api/ai/gender { name } → { gender, confidence }
// Best-effort gender inference from a person's given name, used to PREFILL and
// lock the profile's pronoun field (owner request 2026-07-08). Returns one of
// 'male' | 'female' | 'unknown'. 'unknown' (or low confidence) tells the client to
// let the user pick manually. Convenience only — not stored server-side here.
// ===========================================================================
export async function aiGender(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const email = await emailFor(env, ctx.uid);

  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const name = String(b?.name ?? "").trim().slice(0, 80);
  if (!name) return json({ error: "name required" }, 400);

  const system = [
    "You infer the most likely gender associated with a person's GIVEN name, for setting pronouns.",
    "Reply with STRICT JSON only: {\"gender\":\"male|female|unknown\",\"confidence\":0.0-1.0}.",
    "Use 'male' or 'female' only when reasonably confident from the first name; otherwise 'unknown'.",
    "Do not guess from a surname alone. Output ONLY the JSON object, no prose.",
  ].join(" ");

  let out = "";
  try {
    out = await llm(env, system, name, 40, 0.0);
  } catch (e: any) {
    trackUser(env, ctx.uid, email, "profile_gender_ai_error", "profile", { reason: String(e?.message ?? e).slice(0, 160), email });
    return json({ gender: "unknown", confidence: 0 }); // fail soft → client lets user pick
  }

  let gender = "unknown";
  let confidence = 0;
  const m = out.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      const g = String(j?.gender ?? "").toLowerCase();
      if (g === "male" || g === "female") gender = g;
      const c = Number(j?.confidence);
      confidence = Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0;
    } catch { /* keep unknown */ }
  }
  // Only lock when reasonably confident; otherwise hand control back to the user.
  if (gender !== "unknown" && confidence < 0.6) gender = "unknown";
  trackUser(env, ctx.uid, email, "profile_gender_ai_detected", "profile", { gender, confidence, email });
  return json({ gender, confidence });
}

function bucket(score: number): string {
  if (score >= 0.8) return "high";
  if (score >= 0.5) return "med";
  if (score >= 0.2) return "low";
  return "none";
}

/// Parse the classifier's JSON (tolerant of code fences / stray prose).
function parseScore(out: string): { score: number; reason: string } {
  const m = out.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      const s = Math.max(0, Math.min(1, Number(j?.score)));
      return { score: Number.isFinite(s) ? s : 0, reason: String(j?.reason ?? "").slice(0, 200) || "No specific concern found." };
    } catch { /* fall through */ }
  }
  return { score: 0, reason: "No specific concern found." };
}
