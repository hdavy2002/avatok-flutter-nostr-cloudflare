// ava_guardian.ts — Phase 8 (Guardian: Safety).
//
// Ava's safety layer. Three jobs, all behind a CHEAP CLASSIFIER GATE so a normal
// message costs (almost) nothing:
//   1. SCAM / SPAM flag           — FREE tier, always-on. Keyword/heuristic first;
//                                     llama-guard only on a heuristic hit.
//   2. GROOMING / LURING detect    — escalates a suspicious thread; on a confident
//                                     signal Ava posts a PRIVATE warning to the
//                                     at-risk person ONLY (never the other party).
//   3. DEEPFAKE / AI-IMAGE check   — on incoming media: structure is real; the
//                                     score is STUBBED until a detector model is
//                                     wired (documented TODO + model choice below).
// Plus a weekly PARENT DIGEST builder for the parent account of a child user.
//
// COST DISCIPLINE (the hard rule, same shape as P7 delegate):
//   • Every fanned-out message hits the FREE cheap gate (string heuristics). Only a
//     heuristic hit escalates to llama-guard (`@cf/meta/llama-guard-3-8b` via
//     ai_gate.isSafe), and a confident scam/grooming verdict triggers the warning.
//   • ALWAYS-ON DEEP MONITORING (running the classifier on every message even with
//     no heuristic hit, for premium guardians) is PREMIUM — gated by `isEntitled`.
//     The basic scam/spam flag + a child's guardian monitoring (parent-paid) are free.
//
// ── WIRING (index.ts is wired; messaging.ts is FROZEN — one Phase-11 hook) ──
//   • ROUTE: index.ts ALREADY routes `POST /api/ava/guardian/scan` →
//     `avaGuardianScan(req, env)` (Phase 0). A client can call it to scan a
//     message or a piece of media on demand.
//   • LIVE MONITORING: like P7, live monitoring of *incoming* messages needs a
//     post-fanout hook in messaging.ts. messaging.ts is FROZEN/not-owned, so Phase
//     11 adds ONE best-effort call (see INTEGRATION-NOTES Phase 8 for the exact
//     line):
//
//         // top of messaging.ts:
//         import { guardianScan } from "./ava_guardian";
//         // after the fan-out, before `return json(...)` (best-effort, detached):
//         void guardianScan(env, { conv, message: payload, members: mem, senderUid: ctx.uid });
//
//     `payload` is the object messaging.ts already builds
//     (`{ conv, sender, kind, body, media_ref, client_id, created_at }`); `mem` is
//     its resolved member list; `ctx.uid` is the sender. `guardianScan` self-gates
//     (cheap heuristics first), so a clean message adds only a string scan.
//
// Reuses: postAvaMessage (P3 ava_thread.ts) for the PRIVATE warning; isSafe
// (P2 ai_gate.ts) as the heavier classifier; the existing push queue (env.Q_PUSH
// "notify") for the parent digest delivery hook. Per-user/per-chat secure-chat
// prefs + parent↔child links live in SELF-CREATING D1 tables (DB_META), mirroring
// P7's ava_delegate_prefs self-create pattern (no migration).

import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { postAvaMessage } from "./ava_thread";
import { classifyThreat, moderate, MOD_MODEL } from "../lib/moderation"; // security classifier (Opus) + P6 Nemotron content-safety
import { readConfig } from "./config";
import { track, trackUser } from "../hooks";
import { emailFor } from "../lib/identity";

// ─────────────────────────────────────────────────────────────────────────────
// Entitlement — the premium authority. STUB (mirrors routes/ava_tools.ts +
// routes/backup.ts): returns false until the wallet/subscription phase lands.
// "Always-on deep monitoring" is the only PREMIUM guardian capability; the basic
// scam/spam flag and a child's parent-paid monitoring are FREE. Signature stable.
// ─────────────────────────────────────────────────────────────────────────────
async function isEntitled(_env: Env, _uid: string): Promise<boolean> {
  // Owner decision 2026-06-24: the guardian / shield watchdog is FREE on ALL plans
  // — no premium gating. (Deep monitoring is redundant now anyway: secure-chat ON
  // already runs the AI security classifier on every message.)
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-creating D1 tables (DB_META): secure-chat prefs + parent↔child links.
//   ava_guardian_prefs : per-(uid,conv) "secure-chat mode" + deep-monitor opt-in.
//   ava_guardian_flags : a log of flags raised (powers the parent digest).
//   ava_parent_links   : parent_uid ↔ child_uid (custodial). Until the real
//                         registration/tenancy flow writes this, it is the single
//                         place a parent↔child relationship is recorded; the digest
//                         reads it. A child has at most one parent here.
// ─────────────────────────────────────────────────────────────────────────────
let _ensured = false;
async function ensureTables(env: Env): Promise<void> {
  if (_ensured) return;
  await env.DB_META.batch([
    env.DB_META.prepare(
      `CREATE TABLE IF NOT EXISTS ava_guardian_prefs (
         uid           TEXT NOT NULL,
         conv          TEXT NOT NULL,
         secure_chat   INTEGER NOT NULL DEFAULT 0,  -- 1 → monitor this chat-with-stranger
         deep_monitor  INTEGER NOT NULL DEFAULT 0,  -- 1 → PREMIUM always-on deep scan
         updated_at    INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (uid, conv)
       )`,
    ),
    env.DB_META.prepare(
      `CREATE TABLE IF NOT EXISTS ava_guardian_flags (
         id          TEXT PRIMARY KEY,
         uid         TEXT NOT NULL,        -- the at-risk / protected user
         conv        TEXT NOT NULL,
         peer        TEXT,                 -- the other party (sender), if any
         category    TEXT NOT NULL,        -- 'scam' | 'spam' | 'grooming' | 'deepfake'
         severity    INTEGER NOT NULL,     -- 1 low … 3 high
         detail      TEXT,                 -- short human note
         created_at  INTEGER NOT NULL
       )`,
    ),
    env.DB_META.prepare(
      `CREATE INDEX IF NOT EXISTS idx_guardian_flags_uid ON ava_guardian_flags (uid, created_at)`,
    ),
    env.DB_META.prepare(
      `CREATE TABLE IF NOT EXISTS ava_parent_links (
         parent_uid  TEXT NOT NULL,
         child_uid   TEXT NOT NULL,
         created_at  INTEGER NOT NULL,
         PRIMARY KEY (parent_uid, child_uid)
       )`,
    ),
  ]);
  _ensured = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prefs read/write.
// ─────────────────────────────────────────────────────────────────────────────
export interface GuardianPrefs {
  secureChat: boolean;
  deepMonitor: boolean;
  updatedAt: number;
}
const PREFS_OFF: GuardianPrefs = { secureChat: false, deepMonitor: false, updatedAt: 0 };

export async function getGuardianPrefs(env: Env, uid: string, conv: string): Promise<GuardianPrefs> {
  if (!uid || !conv) return PREFS_OFF;
  try {
    await ensureTables(env);
    const r = await env.DB_META
      .prepare("SELECT secure_chat, deep_monitor, updated_at FROM ava_guardian_prefs WHERE uid=?1 AND conv=?2")
      .bind(uid, conv)
      .first<{ secure_chat: number; deep_monitor: number; updated_at: number }>();
    if (!r) return PREFS_OFF;
    return { secureChat: !!r.secure_chat, deepMonitor: !!r.deep_monitor, updatedAt: r.updated_at ?? 0 };
  } catch {
    return PREFS_OFF;
  }
}

export async function setGuardianPrefs(
  env: Env,
  uid: string,
  conv: string,
  prefs: { secureChat?: boolean; deepMonitor?: boolean },
): Promise<GuardianPrefs> {
  await ensureTables(env);
  const cur = await getGuardianPrefs(env, uid, conv);
  const next: GuardianPrefs = {
    secureChat: prefs.secureChat ?? cur.secureChat,
    deepMonitor: prefs.deepMonitor ?? cur.deepMonitor,
    updatedAt: Date.now(),
  };
  await env.DB_META.prepare(
    `INSERT INTO ava_guardian_prefs (uid, conv, secure_chat, deep_monitor, updated_at)
     VALUES (?1,?2,?3,?4,?5)
     ON CONFLICT(uid, conv) DO UPDATE SET secure_chat=?3, deep_monitor=?4, updated_at=?5`,
  ).bind(uid, conv, next.secureChat ? 1 : 0, next.deepMonitor ? 1 : 0, next.updatedAt).run();
  return next;
}

/** Record a parent↔child link (custodial). Self-creating table; idempotent. */
export async function linkChild(env: Env, parentUid: string, childUid: string): Promise<void> {
  if (!parentUid || !childUid || parentUid === childUid) return;
  await ensureTables(env);
  await env.DB_META.prepare(
    `INSERT OR IGNORE INTO ava_parent_links (parent_uid, child_uid, created_at) VALUES (?1,?2,?3)`,
  ).bind(parentUid, childUid, Date.now()).run();
}

/** The children a parent account is responsible for. */
async function childrenOf(env: Env, parentUid: string): Promise<string[]> {
  try {
    await ensureTables(env);
    const rs = await env.DB_META
      .prepare("SELECT child_uid FROM ava_parent_links WHERE parent_uid=?1 ORDER BY created_at ASC LIMIT 100")
      .bind(parentUid)
      .all<{ child_uid: string }>();
    return (rs.results ?? []).map((r) => r.child_uid);
  } catch {
    return [];
  }
}

/** The parent account (if any) for a child user. At most one here. */
async function parentOf(env: Env, childUid: string): Promise<string | null> {
  try {
    await ensureTables(env);
    const r = await env.DB_META
      .prepare("SELECT parent_uid FROM ava_parent_links WHERE child_uid=?1 LIMIT 1")
      .bind(childUid)
      .first<{ parent_uid: string }>();
    return r?.parent_uid ?? null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE CHEAP CLASSIFIER GATE — string heuristics, NO model call.
//
// Scam/spam keyword + pattern scan (free, always-on) and grooming/luring lexical
// signals. A heuristic HIT is what escalates to the heavier llama-guard classifier
// (ai_gate.isSafe). Tuned conservative: a single weak signal is "watch", multiple
// strong signals are "flag". This is deliberately not exhaustive — it is the cheap
// pre-filter so the model is touched only on a plausible hit.
// ─────────────────────────────────────────────────────────────────────────────

// Scam / financial-lure markers.
const SCAM_PATTERNS: RegExp[] = [
  /\b(gift\s?cards?|google\s?play\s?cards?|steam\s?cards?|itunes)\b/i,
  /\b(crypto|bitcoin|btc|usdt|ethereum|wallet\s?address)\b.*\b(send|transfer|invest|double|profit)\b/i,
  /\b(wire\s?transfer|western\s?union|moneygram|bank\s?details|routing\s?number|cashapp|zelle|venmo)\b/i,
  /\b(verify|confirm|update)\b.*\b(account|password|otp|one[-\s]?time|code|login|bank)\b/i,
  /\b(you('?| ha)ve won|claim your prize|lottery|inheritance|beneficiary)\b/i,
  /\b(investment opportunity|guaranteed returns?|risk[-\s]?free|forex signal)\b/i,
  /\bhttps?:\/\/[^\s]*\b(bit\.ly|tinyurl|cutt\.ly|t\.me)\b/i,
];
// Spam markers (bulk/solicitation).
const SPAM_PATTERNS: RegExp[] = [
  /\b(click here|act now|limited time|subscribe now|buy now|free trial)\b/i,
  /\b(follow me on|dm me for|check my (profile|bio|link)|promo code)\b/i,
];
// Grooming / luring markers (predatory). Scored higher; we OR with secrecy +
// off-platform + meeting + age-asymmetry signals.
const GROOM_SECRECY = /\b(don'?t tell (anyone|your (mom|dad|parents|mum))|our (little )?secret|keep (this|it) (between us|secret)|delete (this|the|our) (chat|messages?))\b/i;
const GROOM_OFFPLATFORM = /\b(let'?s (talk|chat|move) on (snap(chat)?|whatsapp|telegram|kik|discord|insta(gram)?)|what'?s your (number|snap|insta)|send me your (number|address|location))\b/i;
const GROOM_MEET = /\b(meet (up|in person|me)|come (over|to my)|can i (see|visit) you|where do you live|are you (home )?alone)\b/i;
const GROOM_AGE = /\b(how old are you|are you (over )?\d{1,2}|don'?t (act|look) your age|mature for your age)\b/i;
const GROOM_INTIMATE = /\b(send (me )?(a )?(pic|photo|selfie|picture)|what are you wearing|you'?re (so )?(cute|pretty|hot|beautiful)|our (relationship|love))\b/i;

export type GuardianCategory = "scam" | "spam" | "grooming" | "deepfake"
  | "hate" | "csae" | "trafficking" | "threat"; // P6 Nemotron categories

export interface CheapVerdict {
  hit: boolean;                 // any heuristic fired
  category: GuardianCategory | null;
  severity: number;             // 1..3
  signals: string[];            // human-readable matched signal names
}

function cheapScan(text: string): CheapVerdict {
  const t = text ?? "";
  if (!t.trim()) return { hit: false, category: null, severity: 0, signals: [] };

  const signals: string[] = [];

  // Grooming first (highest harm). Count distinct strong signals.
  let groom = 0;
  if (GROOM_SECRECY.test(t)) { groom++; signals.push("secrecy"); }
  if (GROOM_OFFPLATFORM.test(t)) { groom++; signals.push("move-off-platform"); }
  if (GROOM_MEET.test(t)) { groom++; signals.push("meet-request"); }
  if (GROOM_AGE.test(t)) { groom++; signals.push("age-probe"); }
  if (GROOM_INTIMATE.test(t)) { groom++; signals.push("intimacy"); }
  if (groom >= 1) {
    // 1 weak signal → severity 2 (watch + warn); 2+ → severity 3 (strong flag).
    return { hit: true, category: "grooming", severity: groom >= 2 ? 3 : 2, signals };
  }

  // Scam.
  const scam = SCAM_PATTERNS.filter((re) => re.test(t)).length;
  if (scam >= 1) {
    return { hit: true, category: "scam", severity: scam >= 2 ? 3 : 2, signals: ["scam-pattern"] };
  }

  // Spam (lowest harm).
  const spam = SPAM_PATTERNS.filter((re) => re.test(t)).length;
  if (spam >= 2) {
    return { hit: true, category: "spam", severity: 1, signals: ["spam-pattern"] };
  }

  return { hit: false, category: null, severity: 0, signals: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// DEEPFAKE / AI-IMAGE detection on incoming media.
//
// STRUCTURE IS REAL; the SCORE is STUBBED. There is no first-party deepfake /
// synthetic-image detector in the Workers-AI catalog today
// (`@cf/meta/llama-guard-*` is text-only; image models are caption/embed/gen, not
// authenticity classifiers). So this fetches the media bytes (real), runs a
// pluggable detector, and — until a real model is wired — returns a conservative
// stub score with a clear TODO.
//
// DOCUMENTED MODEL CHOICE (for whoever wires it): a binary "real vs AI-generated /
// manipulated" classifier. Options, in order of preference:
//   1. A Workers-AI image-classification model fine-tuned for synthetic detection,
//      if/when one appears in the catalog (call via env.AI.run(<model>, { image })).
//   2. An external detector (Hive, Sightengine, Reality Defender) behind a Worker
//      secret + fetch — return {score, label}.
//   3. A self-hosted ONNX classifier (e.g. an EfficientNet/ViT trained on the
//      DFDC / FaceForensics++ corpus) reached over a self-hosted endpoint/sidecar.
// Wire by replacing `detectSynthetic` below; the pipeline + flag-raising stays.
// ─────────────────────────────────────────────────────────────────────────────

export interface DeepfakeResult {
  checked: boolean;
  score: number;        // 0..1 likelihood of being AI-generated / manipulated
  label: "likely_real" | "uncertain" | "likely_synthetic" | "not_checked";
  stub: boolean;        // true while the score is the documented stub
  detail?: string;
}

const DEEPFAKE_FLAG_THRESHOLD = 0.7;

async function detectSynthetic(env: Env, bytes: Uint8Array | null): Promise<DeepfakeResult> {
  // Pipeline is real: we have the bytes; a real detector plugs in here.
  // TODO(deepfake-model): replace this stub with a real authenticity classifier
  // (see the documented model choices above). For now we DO NOT raise false
  // alarms — we return an "uncertain" stub so the structure is exercised end to
  // end without blocking on a model that isn't in the catalog yet.
  void env; void bytes;
  return {
    checked: true,
    score: 0.0,
    label: "not_checked",
    stub: true,
    detail: "deepfake detector not yet wired (structure ready; see detectSynthetic TODO)",
  };
}

/** Fetch media bytes for a media ref/url (best-effort; null on failure). */
async function fetchMediaBytes(env: Env, mediaRef: string): Promise<Uint8Array | null> {
  try {
    // media_ref is typically an R2 object key under the media bucket, or an
    // absolute URL. Try R2 first (if a MEDIA-style bucket exists), then a plain
    // fetch for absolute URLs. Kept defensive — a miss just means "not checked".
    const anyEnv = env as any;
    if (anyEnv.MEDIA && typeof anyEnv.MEDIA.get === "function" && !/^https?:\/\//i.test(mediaRef)) {
      const obj = await anyEnv.MEDIA.get(mediaRef);
      if (obj) return new Uint8Array(await obj.arrayBuffer());
    }
    if (/^https?:\/\//i.test(mediaRef)) {
      const res = await fetch(mediaRef);
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
    }
  } catch { /* best-effort */ }
  return null;
}

/** Public: run the deepfake/AI-image check on a media ref. */
export async function checkMedia(env: Env, mediaRef: string): Promise<DeepfakeResult> {
  if (!mediaRef) return { checked: false, score: 0, label: "not_checked", stub: true };
  const bytes = await fetchMediaBytes(env, mediaRef);
  return detectSynthetic(env, bytes);
}

// ─────────────────────────────────────────────────────────────────────────────
// Flag log + the PRIVATE warning. A confident signal records a flag (powers the
// parent digest) and, for grooming/scam, posts a PRIVATE warning to the at-risk
// person ONLY — via P3's postAvaMessage(private:true), which writes ONLY that
// user's InboxDO as kind 'ava_private' / scope to:<uid>. It NEVER reaches the
// other party. (Verified against do/ava_agent.ts postAva: priv ⇒ appendTo(uid)
// only; the other member's InboxDO is never written.)
// ─────────────────────────────────────────────────────────────────────────────

async function recordFlag(
  env: Env,
  f: { uid: string; conv: string; peer?: string | null; category: GuardianCategory; severity: number; detail?: string },
): Promise<void> {
  try {
    await ensureTables(env);
    const id = crypto.randomUUID();
    await env.DB_META.prepare(
      `INSERT INTO ava_guardian_flags (id, uid, conv, peer, category, severity, detail, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
    ).bind(id, f.uid, f.conv, f.peer ?? null, f.category, f.severity, f.detail ?? null, Date.now()).run();
  } catch { /* best-effort; a failed log must never block the warning */ }
}

// After how many flagged (sev≥2) messages from the SAME sender in a chat Ava
// auto-blocks them from messaging the at-risk user. The child was warned on each.
const BLOCK_THRESHOLD = 3;

/** Count recent (30d) sev≥2 flags raised for `uid` against sender `peer` in `conv`. */
async function recentFlagCount(env: Env, uid: string, conv: string, peer: string): Promise<number> {
  try {
    const since = Date.now() - 30 * 86_400_000;
    const r = await env.DB_META
      .prepare("SELECT COUNT(*) AS n FROM ava_guardian_flags WHERE uid=?1 AND conv=?2 AND peer=?3 AND severity>=2 AND created_at>=?4")
      .bind(uid, conv, peer, since).first<{ n: number }>();
    return Number(r?.n ?? 0);
  } catch { return 0; }
}

/** Block `sender` from messaging `recipient` (recipient blocks sender → messaging
 *  gate `blockersOf` rejects all future sends). Same `blocks` table social.ts uses. */
async function blockSender(env: Env, recipient: string, sender: string): Promise<void> {
  try {
    await env.DB_META
      .prepare("INSERT OR IGNORE INTO blocks (uid, blocked_uid, created_at) VALUES (?1,?2,?3)")
      .bind(recipient, sender, Date.now()).run();
  } catch { /* best-effort */ }
}

/** Alert the at-risk user's linked parent/guardian (push) on a serious flag. */
async function notifyParentAlert(env: Env, childUid: string, preview: string): Promise<void> {
  try {
    const parent = await parentOf(env, childUid);
    if (!parent) return;
    await env.Q_PUSH.send({ kind: "notify", to: parent, fromName: "Ava Guardian", preview, ts: Date.now() });
  } catch { /* best-effort */ }
}

function warningText(category: GuardianCategory, severity: number): string {
  switch (category) {
    case "grooming":
      return severity >= 3
        ? "⚠️ Ava safety: This conversation has several warning signs of someone trying to gain "
          + "your trust unsafely — asking you to keep secrets, move to another app, meet up, or share "
          + "private things. You don't have to reply. Consider talking to an adult you trust, and you "
          + "can block or report this person. (Only you can see this message.)"
        : "⚠️ Ava safety: Something in this chat looked off — a request to keep a secret, move "
          + "platforms, or share something private. Trust your gut. You can block or report anytime, "
          + "and tell an adult you trust if anything feels wrong. (Only you can see this message.)";
    case "scam":
      return "⚠️ Ava safety: This message looks like a possible scam — it asks about money, gift "
        + "cards, crypto, account codes, or a link. Never send money or codes to someone you don't "
        + "fully trust. If unsure, don't act on it. (Only you can see this message.)";
    case "spam":
      return "Ava noticed this might be spam or an unsolicited promo. You can ignore, block, or "
        + "report it. (Only you can see this message.)";
    case "deepfake":
      return "⚠️ Ava safety: This image may be AI-generated or manipulated. Treat it with caution — "
        + "things that look real can be faked. (Only you can see this message.)";
    default:
      // P6 Nemotron categories (hate / csae / trafficking / threat) and any future
      // harm label — one careful, non-graphic safety line.
      return "⚠️ Ava safety: This message may contain harmful content. You don't have to engage — "
        + "you can block or report this person, and tell an adult you trust if anything feels wrong. "
        + "(Only you can see this message.)";
  }
}

// P6: map Nemotron content-safety labels → our flag decision. POLICY (encode
// exactly): adult sexual content is ALLOWED and NEVER flagged; flag hate, CSAE,
// grooming, trafficking, threats/violence, and scams. Returns null = do not flag.
function mapNemotronCategories(cats: string[]): { category: GuardianCategory; severity: number } | null {
  const s = (cats ?? []).map((c) => String(c).toLowerCase());
  const has = (...ks: string[]) => s.some((c) => ks.some((k) => c.includes(k)));
  if (has("csae", "csam", "child", "minor", "underage", "pedo")) return { category: "csae", severity: 3 };
  if (has("traffick")) return { category: "trafficking", severity: 3 };
  if (has("groom", "lure", "sextort")) return { category: "grooming", severity: 3 };
  if (has("hate", "harass", "racis", "slur")) return { category: "hate", severity: 2 };
  if (has("threat", "violence", "kill", "weapon")) return { category: "threat", severity: 2 };
  if (has("scam", "fraud", "phish")) return { category: "scam", severity: 2 };
  // Adult sexual content / nudity (no minor signal above) is explicitly allowed.
  // Anything else unmapped errs toward NOT red-flagging adult peer speech.
  return null;
}

// Map the security model's free-form category onto our GuardianCategory union.
// Only called when the model returned unsafe, so 'none' never reaches here; any
// non-scam threat (grooming/sextortion/sexual/threat/harassment) maps to a warned
// 'grooming' category so the at-risk user always gets a private heads-up.
function mapThreatCategory(c: string): GuardianCategory {
  if (/scam|fraud|phish/.test(c)) return "scam";
  return "grooming";
}

async function warnPrivately(
  env: Env,
  args: {
    uid: string; conv: string; category: GuardianCategory; severity: number; peer?: string | null;
    advisory?: string; flaggedClientId?: string; flaggedCreatedAt?: number;
  },
): Promise<boolean> {
  const text = (args.advisory && args.advisory.trim()) ? args.advisory.trim() : warningText(args.category, args.severity);
  const res = await postAvaMessage(env, {
    ownerUid: args.uid,            // the at-risk person authors/owns it → recipient
    conv: args.conv,
    text,
    private: true,                 // ava_private to this uid ONLY — never the other party
    source: "guardian",
    meta: {
      guardian: true, category: args.category, severity: args.severity,
      red_flag: true,              // client paints this warning + the flagged message red
      flagged_client_id: args.flaggedClientId || null,
      flagged_created_at: args.flaggedCreatedAt || null,
      peer: args.peer ?? null,
    },
  });
  return res.ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// guardianScan — the post-fanout entry point (called from messaging.ts by P11).
//
//   guardianScan(env, { conv, message, members, senderUid })
//
// `message` is the same `payload` messaging.ts fanned out:
//   { conv, sender, kind, body, media_ref, client_id, created_at }
//
// Flow (each step short-circuits to keep cost near zero):
//   1. Skip Ava's own kinds. Read text + media_ref.
//   2. CHEAP scam/spam/grooming heuristic scan (FREE) on the text. NO model.
//   3. If a media ref is present → deepfake/AI-image check (structure real).
//   4. The PROTECTED users are the RECIPIENTS (the ones at risk from the sender),
//      not the sender. For each recipient:
//        • free basic flag is always evaluated;
//        • PREMIUM "deep monitoring" additionally runs llama-guard even with NO
//          heuristic hit (entitlement-gated; a child's parent-paid monitoring is
//          treated as entitled via the parent's entitlement);
//        • a secure-chat-mode pref or being a monitored child raises the floor.
//   5. On a confident scam/grooming signal → record a flag + PRIVATE warning to
//      that recipient only.
// ─────────────────────────────────────────────────────────────────────────────

export interface GuardianScanArgs {
  conv: string;
  message: { sender?: string; body?: string | null; kind?: string; media_ref?: string | null; [k: string]: unknown };
  members: string[];
  senderUid: string;
  // Origin geo/IP of the sender's request (from messaging.ts req.cf) for telemetry.
  geo?: { country?: string | null; region?: string | null; city?: string | null; colo?: string | null; ip?: string | null };
}

export interface GuardianScanResult {
  scanned: boolean;
  flagged: number;
  warned: number;
  reason?: string;
}

export async function guardianScan(env: Env, args: GuardianScanArgs): Promise<GuardianScanResult> {
  const conv = String(args.conv ?? "");
  const senderUid = args.senderUid || String(args.message?.sender ?? "");
  const kind = String(args.message?.kind ?? "text");
  const mediaRef = args.message?.media_ref ? String(args.message.media_ref) : "";
  // The offending message's client id + timestamp → the warning carries these so
  // the client can paint THAT message red (an obvious red flag for the child).
  const flaggedClientId = String(args.message?.client_id ?? "");
  const flaggedCreatedAt = Number(args.message?.created_at ?? 0);

  if (!conv || !senderUid) return { scanned: false, flagged: 0, warned: 0, reason: "no_conv" };
  if (kind === "ava" || kind === "ava_private" || kind === "ava_status") {
    return { scanned: false, flagged: 0, warned: 0, reason: "ava_kind" };
  }

  // Master kill-switch (config.ts `guardianEnabled`). Off → no-op.
  try {
    const cfg = await readConfig(env);
    if (cfg.guardianEnabled === false) return { scanned: false, flagged: 0, warned: 0, reason: "disabled" };
  } catch { /* readConfig best-effort; default on */ }

  // The text envelope from messaging.ts is the raw body string (the app wraps it
  // as a JSON envelope for rich kinds; for plain text it's the text). Be tolerant.
  const rawBody = String(args.message?.body ?? "");
  const text = extractText(rawBody);

  // 2. CHEAP heuristic scan (free). 3. Deepfake check if media present.
  const cheap = cheapScan(text);
  let media: DeepfakeResult | null = null;
  if (mediaRef) media = await checkMedia(env, mediaRef);
  const mediaHit = !!media && media.label === "likely_synthetic" && media.score >= DEEPFAKE_FLAG_THRESHOLD;

  const recipients = (args.members ?? []).filter((u) => u && u !== senderUid);
  if (!recipients.length) return { scanned: true, flagged: 0, warned: 0, reason: "no_recipient" };

  // Telemetry context (best-effort). geo/IP comes from messaging.ts (sender's req.cf).
  const geo = args.geo ?? {};
  const senderEmail = await emailFor(env, senderUid).catch(() => null);
  const isGroup = (args.members?.length ?? 0) > 2;
  // Every scan: who sent, to how many, where from. "eyes" on all traffic in watched chats.
  void track(env, senderUid, "guardian_scan", "guardian", {
    conv, kind, is_group: isGroup, recipients: recipients.length, msg_len: text.length,
    cheap_hit: cheap.hit, sender_email: senderEmail,
    country: geo.country ?? null, region: geo.region ?? null, city: geo.city ?? null,
    colo: geo.colo ?? null, ip: geo.ip ?? null,
  });

  // P6: ALWAYS-ON message-level safety scan via Nemotron (:free). Runs once per
  // message (text is identical for all recipients). Async + FAIL-OPEN: any error
  // → no flag, `safety_scan_error`, delivery already happened. Adult sexual content
  // is NOT flagged (policy in mapNemotronCategories). Ships ON (safetyScanEnabled).
  let nemotron: { category: GuardianCategory; severity: number } | null = null;
  try {
    let scanOn = true;
    try { scanOn = (await readConfig(env)).safetyScanEnabled !== false; } catch { scanOn = true; }
    if (scanOn && text.trim()) {
      const mod = await moderate(env, { text });
      if (!mod.ok) {
        void track(env, senderUid, "safety_scan_error", "guardian", { conv, ms: mod.ms, engine: "nemotron", model: MOD_MODEL });
      } else {
        nemotron = mod.safe ? null : mapNemotronCategories(mod.categories);
        void track(env, senderUid, "safety_scan", "guardian", {
          conv, is_group: isGroup, flagged: !!nemotron, category: nemotron?.category ?? null,
          raw_categories: mod.categories, ms: mod.ms, engine: "nemotron", model: MOD_MODEL,
        });
      }
    }
  } catch { void track(env, senderUid, "safety_scan_error", "guardian", { conv, engine: "nemotron" }); }

  let flagged = 0;
  let warned = 0;

  await Promise.all(recipients.map(async (uid) => {
    const prefs = await getGuardianPrefs(env, uid, conv);
    // Is this recipient eligible for ALWAYS-ON DEEP monitoring? (PREMIUM)
    //   • their own deep_monitor pref + entitlement, OR
    //   • they are a child whose parent is entitled (parent-paid protection).
    let deep = false;
    if (prefs.deepMonitor && (await isEntitled(env, uid))) deep = true;
    if (!deep) {
      const parent = await parentOf(env, uid);
      if (parent && (await isEntitled(env, parent))) deep = true; // child protected by parent's plan
    }

    let category: GuardianCategory | null = null;
    let severity = 0;
    let detail: string | undefined;
    let advisory: string | undefined;   // tailored private heads-up from the model
    let classifierMs = 0;                // AI classifier latency (telemetry)
    let modelCategory = "";              // the model's raw category label (telemetry)

    if (mediaHit) {
      category = "deepfake"; severity = 2;
      detail = `synthetic media score ${(media!.score).toFixed(2)}`;
    } else {
      // Cheap keyword heuristic is a fast first flag (free, every recipient).
      if (cheap.hit) { category = cheap.category; severity = cheap.severity; detail = cheap.signals.join(", "); }
      // Run the AI SECURITY classifier (Claude Opus 4.8) when this chat is being
      // WATCHED — shield / secure-chat ON (FREE), under deep monitoring, or to
      // triage a cheap hit. THIS is what catches nuanced grooming the keyword
      // list misses (e.g. "don't tell your mom, meet me secretly tonight").
      if (prefs.secureChat || deep || cheap.hit) {
        const threat = await classifyThreat(env, text);
        classifierMs = threat.ms; modelCategory = threat.category;
        if (threat.unsafe) {
          category = mapThreatCategory(threat.category);
          severity = Math.max(severity, threat.severity);
          if (threat.reason) { detail = threat.reason; advisory = threat.reason; }
        }
      }
    }

    // P6: the message-level Nemotron flag applies to EVERY recipient (adult sexual
    // content already excluded). Only fills in when nothing more specific fired.
    if (!category && nemotron) { category = nemotron.category; severity = Math.max(severity, nemotron.severity); detail = detail ?? `nemotron:${nemotron.category}`; }

    if (!category) return; // clean for this recipient → no cost beyond the scan

    await recordFlag(env, { uid, conv, peer: senderUid, category, severity, detail });
    flagged++;

    // F6: dedicated safety_flag annotation frame over the recipient's InboxDO — the
    // chat marks THAT bubble red directly, without parsing the private-warning
    // message. Live-only (offline recipients still get the warning + the durable
    // ava_guardian_flags row). The SENDER never receives this. Best-effort.
    try {
      if (env.INBOX && flaggedClientId) {
        const stub = env.INBOX.get(env.INBOX.idFromName(uid));
        void stub.fetch("https://inbox/event", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "safety_flag", conv, msg_id: flaggedClientId, category }),
        });
      }
    } catch { /* best-effort — the private warning + red bubble still fire */ }

    // Telemetry: a flag was raised. WHO→WHO (sender→recipient + emails), WHAT
    // (category/severity/detail), WHERE (country/IP), and the classifier used.
    void trackUser(env, uid, await emailFor(env, uid).catch(() => null), "guardian_flag", "guardian", {
      conv, is_group: isGroup, category, severity, detail,
      sender_uid: senderUid, sender_email: senderEmail, recipient_uid: uid,
      watched: prefs.secureChat, deep_monitor: deep, classifier_ms: classifierMs, model_category: modelCategory,
      engine: mediaHit ? "deepfake-detector" : "claude-opus-4.8",
      country: geo.country ?? null, region: geo.region ?? null, city: geo.city ?? null,
      colo: geo.colo ?? null, ip: geo.ip ?? null,
    });

    // Warn privately for the harmful categories. Spam is logged but only warned
    // at severity≥2 (avoid nagging). Always private → the sender never sees it.
    // The warning carries the offending message's id so the client paints it red.
    const shouldWarn = category === "grooming" || category === "scam" || category === "deepfake"
      || category === "csae" || category === "trafficking" || category === "threat" || category === "hate"
      || (category === "spam" && severity >= 2);
    if (shouldWarn && (await warnPrivately(env, {
      uid, conv, category, severity, peer: senderUid, advisory, flaggedClientId, flaggedCreatedAt,
    }))) {
      warned++;
      void track(env, uid, "guardian_warning_sent", "guardian", {
        conv, is_group: isGroup, category, severity, sender_uid: senderUid, recipient_uid: uid,
        country: geo.country ?? null, ip: geo.ip ?? null,
      });
    }

    // ESCALATION — repeated predatory messages from the SAME sender → auto-block
    // them from messaging this user (the child was warned each time), and alert a
    // linked parent. Only for the serious predatory/scam categories.
    if (category === "grooming" || category === "scam") {
      const count = await recentFlagCount(env, uid, conv, senderUid);
      if (count >= BLOCK_THRESHOLD) {
        await blockSender(env, uid, senderUid);
        void track(env, uid, "guardian_sender_blocked", "guardian", {
          conv, is_group: isGroup, sender_uid: senderUid, recipient_uid: uid, flags: count, category,
          country: geo.country ?? null, ip: geo.ip ?? null,
        });
        await warnPrivately(env, {
          uid, conv, category, severity,
          advisory: "🛡️ For your safety, Ava has blocked this person from messaging you. If this is someone you know, please talk to a parent or trusted adult.",
        });
        void notifyParentAlert(env, uid, "Ava blocked someone who was sending unsafe messages to your child.");
      } else if (severity >= 2) {
        // Serious single flag → alert the linked parent immediately too.
        void notifyParentAlert(env, uid, `Ava flagged a ${category} message sent to your child.`);
      }
    }
  }));

  return { scanned: true, flagged, warned };
}

/** Pull display text out of the message body (plain text or a {t,body|text} envelope). */
function extractText(rawBody: string): string {
  const b = rawBody ?? "";
  if (!b) return "";
  if (b[0] === "{") {
    try {
      const e = JSON.parse(b);
      if (e && typeof e === "object") {
        const v = e.body ?? e.text ?? "";
        return typeof v === "string" ? v : "";
      }
    } catch { /* not JSON — treat as plain text */ }
  }
  return b;
}

// ─────────────────────────────────────────────────────────────────────────────
// PARENT DIGEST — a weekly safety digest for the parent account of a child user.
//
// Builds (server-side) a structured digest from the flag log for each child the
// parent is linked to over a window (default 7 days). Delivery REUSES the existing
// push queue (env.Q_PUSH "notify") as the hook — a one-line enqueue per parent; a
// richer email/in-app delivery can be layered later (documented). Phase 11 (or a
// cron) calls `runParentDigests(env)` weekly, or a parent client GETs its own
// digest via the route below.
// ─────────────────────────────────────────────────────────────────────────────

export interface ChildDigest {
  childUid: string;
  total: number;
  byCategory: Record<string, number>;
  highSeverity: number;
  recent: Array<{ category: string; severity: number; conv: string; peer: string | null; detail: string | null; at: number }>;
}

export interface ParentDigest {
  parentUid: string;
  windowDays: number;
  generatedAt: number;
  children: ChildDigest[];
  summary: string;
}

export async function buildParentDigest(env: Env, parentUid: string, windowDays = 7): Promise<ParentDigest> {
  await ensureTables(env);
  const since = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const kids = await childrenOf(env, parentUid);

  const children: ChildDigest[] = [];
  for (const childUid of kids) {
    let rows: Array<{ category: string; severity: number; conv: string; peer: string | null; detail: string | null; created_at: number }> = [];
    try {
      const rs = await env.DB_META.prepare(
        `SELECT category, severity, conv, peer, detail, created_at
           FROM ava_guardian_flags
          WHERE uid=?1 AND created_at>=?2
          ORDER BY created_at DESC LIMIT 200`,
      ).bind(childUid, since).all<{ category: string; severity: number; conv: string; peer: string | null; detail: string | null; created_at: number }>();
      rows = rs.results ?? [];
    } catch { /* a read failure → empty digest for this child, never throws */ }

    const byCategory: Record<string, number> = {};
    let highSeverity = 0;
    for (const r of rows) {
      byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
      if (r.severity >= 3) highSeverity++;
    }
    children.push({
      childUid,
      total: rows.length,
      byCategory,
      highSeverity,
      recent: rows.slice(0, 10).map((r) => ({
        category: r.category, severity: r.severity, conv: r.conv, peer: r.peer, detail: r.detail, at: r.created_at,
      })),
    });
  }

  const totalFlags = children.reduce((s, c) => s + c.total, 0);
  const highTotal = children.reduce((s, c) => s + c.highSeverity, 0);
  const summary = totalFlags === 0
    ? `No safety flags for your ${kids.length} linked ${kids.length === 1 ? "child" : "children"} in the last ${windowDays} days. All clear.`
    : `${totalFlags} safety flag${totalFlags === 1 ? "" : "s"} across ${kids.length} ${kids.length === 1 ? "child" : "children"} in the last ${windowDays} days`
      + (highTotal > 0 ? ` — ${highTotal} high-severity. Review recommended.` : ".");

  return { parentUid, windowDays, generatedAt: Date.now(), children, summary };
}

/**
 * Delivery HOOK — reuse the existing push queue to notify the parent their weekly
 * digest is ready. Best-effort (mirrors P7's alert push). A richer channel (email
 * via the consumers' BREVO path, or an in-app digest card) can replace this body;
 * the digest itself is built by buildParentDigest and readable via the route.
 */
async function deliverDigest(env: Env, parentUid: string, digest: ParentDigest): Promise<boolean> {
  try {
    await env.Q_PUSH.send({
      kind: "notify",
      to: parentUid,
      fromName: "Ava Guardian",
      preview: digest.summary,
      ts: Date.now(),
    });
    return true;
  } catch {
    return false; // best-effort
  }
}

/**
 * Run the weekly digest for EVERY parent that has at least one linked child.
 * Intended for a weekly cron (Phase 11 may add a scheduled handler) or an admin
 * trigger. Returns how many parents were delivered to.
 */
export async function runParentDigests(env: Env, windowDays = 7): Promise<{ parents: number; delivered: number }> {
  await ensureTables(env);
  let parents: string[] = [];
  try {
    const rs = await env.DB_META
      .prepare("SELECT DISTINCT parent_uid FROM ava_parent_links ORDER BY parent_uid LIMIT 5000")
      .all<{ parent_uid: string }>();
    parents = (rs.results ?? []).map((r) => r.parent_uid);
  } catch { return { parents: 0, delivered: 0 }; }

  let delivered = 0;
  for (const p of parents) {
    const digest = await buildParentDigest(env, p, windowDays);
    if (await deliverDigest(env, p, digest)) delivered++;
  }
  return { parents: parents.length, delivered };
}

// ─────────────────────────────────────────────────────────────────────────────
// avaGuardianScan — the public route handler.
//   index.ts: POST /api/ava/guardian/scan → avaGuardianScan(req, env)  (Phase 0).
//
// Modes (one request, dual-auth via requireUser — uid is the caller, never body):
//   { conv, message:{...} | text, members?, sender? }  → scan a message NOW
//        (the caller scans a chat they're in; we protect the caller).
//   { media_ref }                                       → deepfake/AI-image check
//   { prefs: { conv, secureChat?, deepMonitor? } }      → set secure-chat prefs
//   { get_prefs: { conv } }                             → read secure-chat prefs
//   { digest: true, windowDays? }                       → the caller's parent digest
//   { link_child: { child_uid } }                       → record a parent↔child link
// ─────────────────────────────────────────────────────────────────────────────

export async function avaGuardianScan(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  // --- set / read secure-chat prefs -------------------------------------------
  if (b && b.prefs && typeof b.prefs === "object") {
    const conv = String(b.prefs.conv ?? "").trim();
    if (!conv) return json({ error: "conv required" }, 400);
    // No premium gate — the guardian/shield is free on all plans (owner decision 2026-06-24).
    const next = await setGuardianPrefs(env, ctx.uid, conv, {
      secureChat: typeof b.prefs.secureChat === "boolean" ? b.prefs.secureChat : undefined,
      deepMonitor: typeof b.prefs.deepMonitor === "boolean" ? b.prefs.deepMonitor : undefined,
    });
    // Telemetry: shield toggle, stamped with email + origin country for analytics.
    const cf: any = (req as any).cf || {};
    void trackUser(env, ctx.uid, await emailFor(env, ctx.uid), "guardian_shield_toggled", "guardian", {
      secure_chat: next.secureChat, deep_monitor: next.deepMonitor, is_group: conv.startsWith("g"),
      country: cf.country ?? null, region: cf.region ?? null, city: cf.city ?? null, colo: cf.colo ?? null,
    });
    return json({ ok: true, prefs: { conv, secureChat: next.secureChat, deepMonitor: next.deepMonitor, updatedAt: next.updatedAt } });
  }
  if (b && b.get_prefs && typeof b.get_prefs === "object") {
    const conv = String(b.get_prefs.conv ?? "").trim();
    if (!conv) return json({ error: "conv required" }, 400);
    const p = await getGuardianPrefs(env, ctx.uid, conv);
    return json({ conv, secureChat: p.secureChat, deepMonitor: p.deepMonitor, updatedAt: p.updatedAt });
  }

  // --- link a child (custodial) -----------------------------------------------
  if (b && b.link_child && typeof b.link_child === "object") {
    const childUid = String(b.link_child.child_uid ?? "").trim();
    if (!childUid) return json({ error: "child_uid required" }, 400);
    await linkChild(env, ctx.uid, childUid);
    return json({ ok: true });
  }

  // --- parent digest (the caller's own) ---------------------------------------
  if (b && b.digest === true) {
    const windowDays = Number(b.windowDays) > 0 ? Math.min(31, Number(b.windowDays)) : 7;
    const digest = await buildParentDigest(env, ctx.uid, windowDays);
    return json({ digest });
  }

  // --- deepfake / AI-image check on a media ref -------------------------------
  if (b && b.media_ref && !b.message && !b.text) {
    const result = await checkMedia(env, String(b.media_ref));
    return json({ media: result });
  }

  // --- scan a message NOW (protect the caller) --------------------------------
  // The caller scans a chat they're in. We protect the CALLER, so we model the
  // scan with the caller as the (sole) recipient and the message's sender as peer.
  const conv = String(b.conv ?? "").trim();
  if (!conv) return json({ error: "conv required" }, 400);
  const message = (b.message && typeof b.message === "object")
    ? b.message
    : { sender: String(b.sender ?? "peer"), body: String(b.text ?? ""), kind: String(b.kind ?? "text"), media_ref: b.media_ref ?? null };
  const sender = String(message.sender ?? b.sender ?? "peer");
  // members = [sender, caller] so the caller is the protected recipient.
  const members = Array.isArray(b.members) && b.members.length
    ? b.members.map(String)
    : [sender, ctx.uid];

  const result = await guardianScan(env, { conv, message, members, senderUid: sender });
  return json({ ok: true, ...result });
}
