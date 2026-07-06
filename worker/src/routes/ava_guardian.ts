// ava_guardian.ts — Phase 8 (Guardian: Safety).
//
// Ava's chat safety layer. Two jobs, both FREE on all plans (no premium gating):
//   1. SCAM / SPAM / GROOMING flag — cheap regex heuristics first (free, always),
//                                     then Nemotron content-safety (moderate()) and,
//                                     for WATCHED chats, the Opus deep classifier
//                                     (classifyThreat()). On a confident signal Ava
//                                     posts a PRIVATE warning to the at-risk person
//                                     ONLY (never the other party).
//   2. Weekly PARENT DIGEST builder for the parent account of a child user.
//
// SCAN PIPELINE (the cost staircase):
//   cheap regex → Nemotron moderate() → classifyThreat() deep classifier (Opus).
//   The deep classifier runs only for WATCHED recipients (prefs.secureChat || a
//   cheap-regex hit). Nemotron always runs as the illegal-content floor.
//
// ACTIVATION MODEL (G1): model scanning is skipped entirely for recipients WITHOUT
//   secure_chat=1, EXCEPT the Nemotron illegal-content floor which still runs but
//   only ACTS (flag + warning) for csae/trafficking on unwatched recipients (record
//   flag + telemetry, no user-facing warning unless the chat is guardian-ON). Cheap
//   regex may still run for free but only produces flags/warnings for guardian-ON
//   recipients. Minors are always treated as secure_chat=1 (force-ON). Everything is
//   fail-open and detached — safety machinery can never block or delay delivery.
//
// NOTE (G0): media/deepfake scanning has been DELETED. There is no synthetic-media
//   detector; the {media_ref} scan mode, checkMedia/detectSynthetic, and the
//   'deepfake' category are gone from all server code paths (the client may still
//   render a legacy 'deepfake' meta for old messages, but the server never emits it).
//
// COST DISCIPLINE: a clean message in an unwatched chat costs only the cheap regex
//   scan + one Nemotron pass; the Opus classifier is touched only in watched chats.
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
//     (`{ conv, sender, kind, body, client_id, created_at }`); `mem` is its resolved
//     member list; `ctx.uid` is the sender. `guardianScan` self-gates (cheap
//     heuristics first), so a clean message adds only a string scan.
//
// Reuses: postAvaMessage (P3 ava_thread.ts) for the PRIVATE warning; the existing
// push queue (env.Q_PUSH "notify") for the parent digest delivery hook. Per-user/
// per-chat secure-chat prefs + parent↔child links live in SELF-CREATING D1 tables
// (DB_META), mirroring P7's ava_delegate_prefs self-create pattern (no migration).

import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { postAvaMessage } from "./ava_thread";
import { classifyThreat, moderate, MOD_MODEL } from "../lib/moderation"; // security classifier (Opus) + P6 Nemotron content-safety
import { readConfig } from "./config";
import { track, trackUser } from "../hooks";
import { emailFor } from "../lib/identity";

// ─────────────────────────────────────────────────────────────────────────────
// Telemetry PII overhaul (Specs/GUARDIAN-TELEMETRY-SPEC §1). Data minimization:
// raw email + raw IP are NEVER stamped as event properties. A flagged event may
// carry an IP HASH (sha256, first 16 hex) so a spam-origination map can group by
// network without storing the raw address. Best-effort; a hash failure omits it.
// ─────────────────────────────────────────────────────────────────────────────
async function ipHash(ip?: string | null): Promise<string | null> {
  const v = (ip ?? "").trim();
  if (!v) return null;
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
    const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return hex.slice(0, 16);
  } catch {
    return null;
  }
}

/** UTC hour (0..23) of `ts` — a coarse, non-identifying time-of-day analytics dim. */
function hourUtc(ts: number): number {
  return new Date(ts).getUTCHours();
}
// Guardian Sentinel (S1) — single best-effort ingest hook. DARK behind
// sentinelEnabled (the ingest self-gates on the KV flag; the caller also checks).
// Fail-open, detached (void). Full event-bus consumption arrives with the consumers
// wiring (plan §S1.5); this hook is the minimal in-worker fan-in point at launch.
import { sentinelIngest } from "../sentinel/ingest";

// ─────────────────────────────────────────────────────────────────────────────
// G0: the guardian / shield watchdog is FREE on ALL plans — no premium gating
// (owner decision 2026-06-24). The former isEntitled() stub + all entitlement
// checks have been DELETED; everything is treated as always-entitled.
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
         secure_chat   INTEGER NOT NULL DEFAULT 0,  -- 1 → Guardian is watching this chat
         deep_monitor  INTEGER NOT NULL DEFAULT 0,  -- G0: DEPRECATED/IGNORED (kept for D1 compat)
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
         category    TEXT NOT NULL,        -- 'scam' | 'spam' | 'grooming' | 'csae' | ...
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
    // F6: ACCOUNT-WIDE guardian prefs (one row per uid). Currently holds the
    // adult-content opt-out: when adult_optout=1 the user has chosen NOT to see
    // adult-only content warnings (they accept adult content without the extra
    // caution card). Adults only — the write is REFUSED server-side for minors
    // (users.birth_year < 18), so a child can never turn the warnings off.
    env.DB_META.prepare(
      `CREATE TABLE IF NOT EXISTS ava_guardian_account_prefs (
         uid           TEXT PRIMARY KEY,
         adult_optout  INTEGER NOT NULL DEFAULT 0,  -- 1 → hide adult-only content warnings
         updated_at    INTEGER NOT NULL DEFAULT 0
       )`,
    ),
    // U1-lite: MANUAL "Require verification" gate (Specs/GUARDIAN-SENTINEL §U1).
    // One row per (conv, peer) verification request. status 'pending' until the
    // peer passes/declines a live face check. DARK behind guardianGateEnabled — no
    // row is ever written unless the flag is ON. Self-creating (no migration).
    env.DB_META.prepare(
      `CREATE TABLE IF NOT EXISTS ava_guardian_gate (
         conv         TEXT NOT NULL,
         uid          TEXT NOT NULL,        -- the PEER being asked to verify
         requested_by TEXT NOT NULL,        -- the owner who tapped "Require verification"
         status       TEXT NOT NULL,        -- 'pending' | 'passed' | 'declined'
         created_at   INTEGER NOT NULL,
         updated_at   INTEGER NOT NULL,
         PRIMARY KEY (conv, uid)
       )`,
    ),
  ]);
  _ensured = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// F6 — account-wide adult-content opt-out. Adults may opt OUT of the extra
// "adult-only content" warning cards. Minors CANNOT (the write is refused).
// ─────────────────────────────────────────────────────────────────────────────

/** Is this uid a self-declared minor (< 18 by users.birth_year)? Null year → adult. */
async function isMinorAccount(env: Env, uid: string): Promise<boolean> {
  try {
    const r = await env.DB_META
      .prepare("SELECT birth_year FROM users WHERE uid=?1")
      .bind(uid)
      .first<{ birth_year: number | null }>();
    const by = r?.birth_year ?? null;
    if (!by) return false; // no declared year → treated as adult
    return new Date().getFullYear() - by < 18;
  } catch {
    return false; // fail-open toward adult (never traps an adult as a minor)
  }
}

/** Read the account-wide adult opt-out. Default false (warnings shown). */
export async function getAdultOptOut(env: Env, uid: string): Promise<boolean> {
  if (!uid) return false;
  try {
    await ensureTables(env);
    const r = await env.DB_META
      .prepare("SELECT adult_optout FROM ava_guardian_account_prefs WHERE uid=?1")
      .bind(uid)
      .first<{ adult_optout: number }>();
    return !!(r && Number(r.adult_optout) === 1);
  } catch {
    return false;
  }
}

/**
 * Set the account-wide adult opt-out. Refused for minors (returns
 * { refused: true }); the caller surfaces nothing for a child (the client hides
 * the toggle entirely, this is the server backstop).
 */
export async function setAdultOptOut(
  env: Env,
  uid: string,
  optOut: boolean,
): Promise<{ ok: boolean; refused?: boolean; adultOptOut: boolean }> {
  await ensureTables(env);
  if (await isMinorAccount(env, uid)) {
    // A child account may never turn adult-content warnings off.
    return { ok: false, refused: true, adultOptOut: false };
  }
  const now = Date.now();
  await env.DB_META.prepare(
    `INSERT INTO ava_guardian_account_prefs (uid, adult_optout, updated_at)
     VALUES (?1,?2,?3)
     ON CONFLICT(uid) DO UPDATE SET adult_optout=?2, updated_at=?3`,
  ).bind(uid, optOut ? 1 : 0, now).run();
  return { ok: true, adultOptOut: optOut };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prefs read/write.
// ─────────────────────────────────────────────────────────────────────────────
// G0: deep_monitor is DEPRECATED. `secureChat` is the single "Guardian is watching
// this chat" switch. `deepMonitor` is retained on the type only for wire/back-compat
// but is ALWAYS false (never read in logic). The D1 column is kept (written as 0) so
// old rows and clients don't break.
export interface GuardianPrefs {
  secureChat: boolean;
  deepMonitor: boolean; // G0: always false — deprecated, ignored in all logic
  updatedAt: number;
}
const PREFS_OFF: GuardianPrefs = { secureChat: false, deepMonitor: false, updatedAt: 0 };

export async function getGuardianPrefs(env: Env, uid: string, conv: string): Promise<GuardianPrefs> {
  if (!uid || !conv) return PREFS_OFF;
  try {
    await ensureTables(env);
    const r = await env.DB_META
      .prepare("SELECT secure_chat, updated_at FROM ava_guardian_prefs WHERE uid=?1 AND conv=?2")
      .bind(uid, conv)
      .first<{ secure_chat: number; updated_at: number }>();
    if (!r) return PREFS_OFF;
    // G0: deepMonitor collapsed into secureChat — always false in the returned prefs.
    return { secureChat: !!r.secure_chat, deepMonitor: false, updatedAt: r.updated_at ?? 0 };
  } catch {
    return PREFS_OFF;
  }
}

export async function setGuardianPrefs(
  env: Env,
  uid: string,
  conv: string,
  prefs: { secureChat?: boolean; deepMonitor?: boolean }, // deepMonitor accepted but IGNORED (G0)
): Promise<GuardianPrefs> {
  await ensureTables(env);
  const cur = await getGuardianPrefs(env, uid, conv);
  const next: GuardianPrefs = {
    secureChat: prefs.secureChat ?? cur.secureChat,
    deepMonitor: false, // G0: deprecated — never persisted as anything but 0
    updatedAt: Date.now(),
  };
  await env.DB_META.prepare(
    `INSERT INTO ava_guardian_prefs (uid, conv, secure_chat, deep_monitor, updated_at)
     VALUES (?1,?2,?3,0,?4)
     ON CONFLICT(uid, conv) DO UPDATE SET secure_chat=?3, deep_monitor=0, updated_at=?4`,
  ).bind(uid, conv, next.secureChat ? 1 : 0, next.updatedAt).run();
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// G3 — cheap "is Guardian ON for anyone in this conversation?" gate. Used ONLY to
// decide whether to pay for the fast-lane inline scan BEFORE fan-out. ONE chunked
// IN query over ava_guardian_prefs for all recipients (secure_chat=1), plus a
// minor-account check (minors are force-ON). Per-REQUEST memoised so a send that
// scans + fans out doesn't re-read D1. Fail-open toward "scan" is NOT wanted here
// (we don't want to pay latency on unwatched chats), so on error we return false
// (no inline scan → today's behaviour: the detached deep lane still runs).
// ─────────────────────────────────────────────────────────────────────────────
const _GUARDIAN_ON_CHUNK = 90; // D1 100-bound-param limit
export async function hasGuardianOnRecipient(
  env: Env,
  conv: string,
  members: string[],
  senderUid: string,
  cache?: Map<string, boolean>,
): Promise<boolean> {
  const key = `${conv}`;
  if (cache && cache.has(key)) return cache.get(key)!;
  let result = false;
  try {
    await ensureTables(env);
    const recips = (members ?? []).filter((u) => u && u !== senderUid);
    if (!recips.length) { cache?.set(key, false); return false; }
    // Any explicit secure_chat=1 for this conv among the recipients?
    for (let i = 0; i < recips.length && !result; i += _GUARDIAN_ON_CHUNK) {
      const chunk = recips.slice(i, i + _GUARDIAN_ON_CHUNK);
      const rs = await env.DB_META.prepare(
        `SELECT uid FROM ava_guardian_prefs
          WHERE conv=?1 AND secure_chat=1
            AND uid IN (${chunk.map((_, j) => `?${j + 2}`).join(",")}) LIMIT 1`,
      ).bind(conv, ...chunk).all<{ uid: string }>();
      if ((rs.results ?? []).length) result = true;
    }
    // Minors are force-ON regardless of the stored pref.
    if (!result) {
      for (const uid of recips) {
        if (await isMinorAccount(env, uid)) { result = true; break; }
      }
    }
  } catch {
    result = false; // never delay a send on this gate's read failure
  }
  cache?.set(key, result);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// U1-lite — MANUAL "Require verification" gate (Specs/GUARDIAN-SENTINEL §U1).
// Fully DARK behind guardianGateEnabled; the route handler enforces the flag (403
// feature_off) before any of this runs. These helpers never enforce anything —
// they record a request and, when a liveness pass is confirmed, mark it passed.
// ─────────────────────────────────────────────────────────────────────────────

export interface GateRow {
  conv: string; uid: string; requested_by: string;
  status: string; created_at: number; updated_at: number;
}

/** Record a pending verification request for `peerUid` in `conv`. Idempotent
 *  (re-requesting refreshes updated_at, keeps a prior 'passed' if already passed). */
async function requireVerify(env: Env, conv: string, peerUid: string, requestedBy: string): Promise<void> {
  await ensureTables(env);
  const now = Date.now();
  await env.DB_META.prepare(
    `INSERT INTO ava_guardian_gate (conv, uid, requested_by, status, created_at, updated_at)
     VALUES (?1,?2,?3,'pending',?4,?4)
     ON CONFLICT(conv, uid) DO UPDATE SET
        requested_by=?3,
        updated_at=?4,
        status=CASE WHEN ava_guardian_gate.status='passed' THEN 'passed' ELSE 'pending' END`,
  ).bind(conv, peerUid, requestedBy, now).run();
}

/** Read all gate rows for a conv (for the owner to see the peer's verification state). */
async function gateStatus(env: Env, conv: string): Promise<GateRow[]> {
  try {
    await ensureTables(env);
    const rs = await env.DB_META
      .prepare("SELECT conv, uid, requested_by, status, created_at, updated_at FROM ava_guardian_gate WHERE conv=?1")
      .bind(conv).all<GateRow>();
    return rs.results ?? [];
  } catch {
    return [];
  }
}

/**
 * Mark EVERY pending verification gate for `uid` as passed. Called (best-effort,
 * guarded by guardianGateEnabled) from the liveness verify SUCCESS path so that
 * when the peer completes a live face check, any conv that asked them to verify
 * flips to 'passed'. Fail-open, never throws. Returns how many rows flipped.
 *
 * TODO(liveness-wire): the ONE authoritative call site is the liveness verify
 * success point in worker/src/routes/liveness*.ts (see LIVE-GATE markGatePassed).
 * If the liveness pipeline moves, keep this the single place that flips gate rows.
 */
export async function markGatePassed(env: Env, uid: string): Promise<number> {
  if (!uid) return 0;
  try {
    if ((await readConfig(env)).guardianGateEnabled !== true) return 0;
    await ensureTables(env);
    const now = Date.now();
    const r = await env.DB_META.prepare(
      "UPDATE ava_guardian_gate SET status='passed', updated_at=?2 WHERE uid=?1 AND status='pending'",
    ).bind(uid, now).run();
    const n = Number((r as any)?.meta?.changes ?? 0);
    if (n > 0) {
      void track(env, uid, "verify_human_passed", "guardian", { rows: n, trigger: "manual_t4" });
    }
    return n;
  } catch {
    return 0;
  }
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

// G0: 'deepfake' REMOVED — media/deepfake scanning is deleted; the server never
// emits it. (The client may still render a legacy 'deepfake' meta for old messages.)
export type GuardianCategory = "scam" | "spam" | "grooming"
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
// G0: media/deepfake detection has been DELETED. There is no synthetic-media
// detector in the platform and the 'deepfake' surface was a dead path (the old
// detectSynthetic() always returned not_checked). Removed: DeepfakeResult,
// DEEPFAKE_FLAG_THRESHOLD, detectSynthetic, fetchMediaBytes, checkMedia, the
// {media_ref} API mode, and the mediaHit branch in guardianScan.
// ─────────────────────────────────────────────────────────────────────────────

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
//   { conv, sender, kind, body, client_id, created_at }
//
// Flow (each step short-circuits to keep cost near zero):
//   1. Skip Ava's own kinds. Read text.
//   2. CHEAP scam/spam/grooming heuristic scan (FREE) on the text. NO model.
//   3. G1 ACTIVATION GATE — per recipient, work out whether Guardian is ON
//      (secure_chat=1, or a minor account = always-ON). For OFF recipients we skip
//      ALL model scanning; only the Nemotron illegal-content floor is honoured, and
//      even then it only ACTS on csae/trafficking (flag + telemetry, NO user-facing
//      warning). The cheap regex may flag but only warns guardian-ON recipients.
//   4. For guardian-ON recipients: run the Nemotron content-safety pass + the Opus
//      deep classifier (classifyThreat), record a flag + PRIVATE warning on a hit.
//   5. Escalation (grooming/scam): repeat offenders auto-block + parent alert.
// ─────────────────────────────────────────────────────────────────────────────

export interface GuardianScanArgs {
  conv: string;
  message: { sender?: string; body?: string | null; kind?: string; client_id?: string; created_at?: number; [k: string]: unknown };
  members: string[];
  senderUid: string;
  // Origin geo/IP of the sender's request (from messaging.ts req.cf) for telemetry.
  // G3/PII-overhaul: extended with asn/as_org/is_proxy from req.cf; raw ip is HASHED
  // (never stamped raw). Country + colo stay on clean scans; full geo on flags.
  geo?: {
    country?: string | null; region?: string | null; city?: string | null; colo?: string | null;
    ip?: string | null; asn?: number | string | null; asOrganization?: string | null;
    isProxy?: boolean | null;
  };
  // G3: the FAST-lane verdict already surfaced pre-fanout (if any). The detached
  // DEEP lane receives this so it does NOT double-warn for the same category the
  // fast lane already flagged. undefined ⇒ inline lane didn't run (today's path).
  fastVerdict?: { category: GuardianCategory; severity: number } | null;
}

export interface GuardianScanResult {
  scanned: boolean;
  flagged: number;
  warned: number;
  reason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// G3 — FAST-lane inline scan (Specs/GUARDIAN-SENTINEL-FINAL-PLAN §G3).
//
//   guardianFastScan(env, { text, conv, senderUid, isGroup, geo })
//
// The CHEAP lane only: regex heuristics (free, sync) + ONE Nemotron moderate()
// call under a HARD timeout (Promise.race vs guardianInlineBudgetMs, default 600).
// NO Opus call here — the deep classifier stays in the detached slow lane. Returns
// {flag, ms, timed_out}. Fail-open: on timeout/error → flag reflects only what the
// cheap regex found (or null), timed_out=true. Never throws. The caller awaits this
// BEFORE fan-out ONLY when guardianInlineEnabled AND a guarded recipient exists.
// ─────────────────────────────────────────────────────────────────────────────
export interface FastScanResult {
  flag: { category: GuardianCategory; severity: number } | null;
  ms: number;
  timed_out: boolean;
  cheap_hit: boolean;
  rule_id?: string | null; // matched cheap-signal name(s), for guardian_rule_hit
}

export async function guardianFastScan(
  env: Env,
  args: {
    text: string; conv: string; senderUid: string; isGroup?: boolean;
    geo?: GuardianScanArgs["geo"];
  },
): Promise<FastScanResult> {
  const t0 = Date.now();
  const text = extractText(String(args.text ?? ""));

  // 1. CHEAP regex scan (sync, free). This alone can flag even if the model times out.
  const cheap = cheapScan(text);
  let flag: { category: GuardianCategory; severity: number } | null =
    cheap.hit && cheap.category ? { category: cheap.category, severity: cheap.severity } : null;

  // Fast lane can be model-free if there's no text; still emit the scan telemetry.
  let timedOut = false;
  let budget = 600;
  try { budget = Number((await readConfig(env)).guardianInlineBudgetMs) || 600; } catch { budget = 600; }

  if (text.trim()) {
    // ONE Nemotron moderate() call, HARD-bounded by Promise.race. On timeout we keep
    // whatever the cheap regex produced (fail-open) — delivery is NEVER delayed past
    // the budget. Nemotron is the illegal-content floor; adult content is not flagged.
    let scanOn = true;
    try { scanOn = (await readConfig(env)).safetyScanEnabled !== false; } catch { scanOn = true; }
    if (scanOn) {
      const timeout = new Promise<"__timeout__">((resolve) =>
        setTimeout(() => resolve("__timeout__"), Math.max(50, budget)));
      try {
        const raced = await Promise.race([moderate(env, { text }), timeout]);
        if (raced === "__timeout__") {
          timedOut = true;
        } else if (raced && (raced as any).ok) {
          const mod = raced as { safe: boolean; categories: string[] };
          const nemo = mod.safe ? null : mapNemotronCategories(mod.categories);
          // The Nemotron floor upgrades/fills the verdict but never DOWNGRADES a
          // cheap-regex hit (max severity, prefer the more specific category).
          if (nemo) {
            if (!flag) flag = nemo;
            else flag = { category: flag.category, severity: Math.max(flag.severity, nemo.severity) };
          }
        }
      } catch {
        // moderate() itself fails open (ok:false) — treated as no model signal.
      }
    }
  }

  const ms = Date.now() - t0;
  const budgetExceeded = ms > budget;

  // guardian_inline_scan {lane:'fast', ...} per scan (§2.2).
  try {
    void track(env, args.senderUid, "guardian_inline_scan", "guardian", {
      lane: "fast", conv: args.conv, is_group: !!args.isGroup,
      verdict: flag?.category ?? null, severity: flag?.severity ?? 0,
      ms, timed_out: timedOut, budget_exceeded: budgetExceeded, budget_ms: budget,
      model: MOD_MODEL, cheap_hit: cheap.hit,
    });
    // guardian_rule_hit — the cheap deterministic rule(s) that fired, pre-classifier.
    if (cheap.hit && cheap.category) {
      void track(env, args.senderUid, "guardian_rule_hit", "guardian", {
        conv: args.conv, rule_id: cheap.signals.join(",") || cheap.category,
        category: cheap.category, is_group: !!args.isGroup,
      });
    }
    // guardian_budget_fallback — the Nemotron escalation was blocked by the latency
    // budget (timed out) so the fast lane fell back to the cheap regex verdict alone.
    if (timedOut) {
      void track(env, args.senderUid, "guardian_budget_fallback", "guardian", {
        conv: args.conv, lane: "fast", reason: "latency_budget", ms, budget_ms: budget,
        fell_back_to: "cheap_regex", verdict: flag?.category ?? null,
      });
    }
  } catch { /* telemetry best-effort */ }

  return {
    flag, ms, timed_out: timedOut, cheap_hit: cheap.hit,
    rule_id: cheap.signals.join(",") || null,
  };
}

export async function guardianScan(env: Env, args: GuardianScanArgs): Promise<GuardianScanResult> {
  const conv = String(args.conv ?? "");
  const senderUid = args.senderUid || String(args.message?.sender ?? "");
  const kind = String(args.message?.kind ?? "text");
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

  // 2. CHEAP heuristic scan (free, every message).
  const cheap = cheapScan(text);

  const recipients = (args.members ?? []).filter((u) => u && u !== senderUid);
  if (!recipients.length) return { scanned: true, flagged: 0, warned: 0, reason: "no_recipient" };

  // Telemetry context (best-effort). geo/IP comes from messaging.ts (sender's req.cf).
  const geo = args.geo ?? {};
  const isGroup = (args.members?.length ?? 0) > 2;
  // Standard ruleset/flag-state props (telemetry spec §6 + §1 KV lesson).
  let cfgSnapshot: { guardianInlineEnabled?: boolean; safetyScanEnabled?: boolean } = {};
  try {
    const c = await readConfig(env);
    cfgSnapshot = { guardianInlineEnabled: c.guardianInlineEnabled, safetyScanEnabled: c.safetyScanEnabled };
  } catch { /* best-effort */ }
  // PII OVERHAUL (telemetry spec §1): CLEAN scans stamp NO raw email + NO raw IP.
  // Identity is the track() distinct id (uid); geo is coarse (country + colo) plus
  // hour_utc + guardian_enabled. Full geo + ip_hash are added only on guardian_flag.
  // Every scan: who sent (uid via track), to how many, where from (country/colo).
  void track(env, senderUid, "guardian_scan", "guardian", {
    conv, kind, is_group: isGroup, recipients: recipients.length, msg_len: text.length,
    cheap_hit: cheap.hit,
    country: geo.country ?? null, colo: geo.colo ?? null,
    hour_utc: hourUtc(Date.now()),
    guardian_enabled: cfgSnapshot.guardianInlineEnabled ?? false,
    guardianInlineEnabled: cfgSnapshot.guardianInlineEnabled ?? false,
    safetyScanEnabled: cfgSnapshot.safetyScanEnabled ?? true,
  });

  // ILLEGAL-CONTENT FLOOR: message-level safety scan via Nemotron (:free). Runs once
  // per message (text is identical for all recipients). Async + FAIL-OPEN: any error
  // → no flag, `safety_scan_error`, delivery already happened. Adult sexual content
  // is NOT flagged (policy in mapNemotronCategories). Ships ON (safetyScanEnabled).
  // G1: for guardian-OFF recipients this still runs, but only csae/trafficking are
  // ACTED on (flag + telemetry, no user-facing warning) — see the per-recipient gate.
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

    // G1 ACTIVATION GATE. Guardian is ON for this recipient when they have
    // secure_chat=1 for this conv, OR they are a MINOR account (force-ON always).
    // Minors can never be guardian-OFF regardless of the stored pref.
    const minor = await isMinorAccount(env, uid);
    const guardianOn = prefs.secureChat || minor;

    let category: GuardianCategory | null = null;
    let severity = 0;
    let detail: string | undefined;
    let advisory: string | undefined;   // tailored private heads-up from the model
    let classifierMs = 0;                // AI classifier latency (telemetry)
    let modelCategory = "";              // the model's raw category label (telemetry)

    if (guardianOn) {
      // Guardian-ON: full pipeline. Cheap keyword heuristic is a fast first flag.
      if (cheap.hit) { category = cheap.category; severity = cheap.severity; detail = cheap.signals.join(", "); }
      // Run the AI SECURITY classifier (Claude Opus 4.8): the deep classifier runs
      // when the chat is watched OR to triage a cheap-regex hit. THIS is what catches
      // nuanced grooming the keyword list misses ("don't tell your mom, meet me
      // secretly tonight").
      if (prefs.secureChat || minor || cheap.hit) {
        const threat = await classifyThreat(env, text);
        classifierMs = threat.ms; modelCategory = threat.category;
        if (threat.unsafe) {
          category = mapThreatCategory(threat.category);
          severity = Math.max(severity, threat.severity);
          if (threat.reason) { detail = threat.reason; advisory = threat.reason; }
        }
      }
      // Nemotron illegal-content floor fills in when nothing more specific fired.
      if (!category && nemotron) { category = nemotron.category; severity = Math.max(severity, nemotron.severity); detail = detail ?? `nemotron:${nemotron.category}`; }
    } else {
      // G1 GUARDIAN-OFF: no model scanning for this recipient. We honour ONLY the
      // Nemotron illegal-content floor, and only for csae/trafficking — recorded as
      // a flag + telemetry with NO user-facing warning (see suppressWarning below).
      // The cheap regex does NOT flag guardian-OFF recipients.
      if (nemotron && (nemotron.category === "csae" || nemotron.category === "trafficking")) {
        category = nemotron.category;
        severity = nemotron.severity;
        detail = `nemotron:${nemotron.category}`;
      }
    }

    if (!category) return; // clean / not acted on for this recipient → no cost beyond the scan

    // G3: DON'T double-warn. If the FAST lane already surfaced this same category
    // pre-fanout (fastVerdict), the recipient already saw a red bubble/warning on
    // arrival — the slow lane records the (possibly higher-severity) flag for
    // evidence/parent-digest but SUPPRESSES a second user-facing warning for the
    // same category. A DIFFERENT/escalated category still warns.
    const fastSameCategory = !!(args.fastVerdict && args.fastVerdict.category === category);

    // G1: a guardian-OFF recipient never gets a user-facing warning frame/message
    // (illegal-content floor is recorded silently for platform T&S, not shown).
    const suppressWarning = !guardianOn;

    await recordFlag(env, { uid, conv, peer: senderUid, category, severity, detail });
    flagged++;

    // Guardian Sentinel (S1) — best-effort, detached, fail-open. The FLAGGED actor
    // is the SENDER (senderUid), so the evidence is ABOUT them. DARK behind
    // sentinelEnabled (sentinelIngest self-gates on the KV flag; a no-op when off).
    // This is the single minimal in-worker fan-in point; full event-bus consumption
    // arrives with the consumers wiring (plan §S1.5). Never blocks or throws.
    void sentinelIngest(env, {
      type: "guardian_flag",
      uid: senderUid,
      source_event: `guardian_flag:${conv}:${flaggedClientId || Date.now()}:${category}`,
      ts: Date.now(),
      payload: { category, severity, conv, is_group: isGroup },
    }, { source: "guardianScan" });

    // F6 + G2: dedicated safety_flag over the recipient's InboxDO — the chat marks
    // THAT bubble red directly, without parsing the private-warning message. G2 makes
    // this STORE-AND-FORWARD: the InboxDO /safety_flag endpoint PERSISTS the flag in
    // DO-local SQLite (so the red bubble survives reinstall + reaches every device via
    // /sync seeding) AND broadcasts it live — replacing the old broadcast-only /event
    // push. Offline recipients still also get the durable warning + ava_guardian_flags
    // row. The SENDER never receives this. Best-effort, detached.
    // G1: suppressed for guardian-OFF recipients (silent illegal-content floor).
    try {
      if (!suppressWarning && env.INBOX && flaggedClientId) {
        const stub = env.INBOX.get(env.INBOX.idFromName(uid));
        void stub.fetch("https://inbox/safety_flag", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "safety_flag", conv, msg_id: flaggedClientId, category, severity }),
        });
      }
    } catch { /* best-effort — the private warning + red bubble still fire */ }

    // Telemetry: a flag was raised. PII OVERHAUL (telemetry spec §1): NO raw emails,
    // NO raw IP. Identity = uid props (sender_uid/recipient_uid + PostHog person map
    // via track's distinct id, so email lookup still works). FULL geo (country/region/
    // city/colo) + network facts (asn/as_org/ip_hash/is_proxy) for the spam-origination
    // map (§3). Plus ruleset/flag-state standard props (§6).
    void track(env, uid, "guardian_flag", "guardian", {
      conv, is_group: isGroup, category, severity, detail,
      sender_uid: senderUid, recipient_uid: uid,
      watched: prefs.secureChat, guardian_on: guardianOn, minor, suppressed: suppressWarning,
      classifier_ms: classifierMs, model_category: modelCategory,
      engine: "claude-opus-4.8",
      country: geo.country ?? null, region: geo.region ?? null, city: geo.city ?? null,
      colo: geo.colo ?? null,
      asn: geo.asn ?? null, as_org: geo.asOrganization ?? null,
      is_proxy: geo.isProxy ?? null, ip_hash: await ipHash(geo.ip),
      hour_utc: hourUtc(Date.now()),
      guardianInlineEnabled: cfgSnapshot.guardianInlineEnabled ?? false,
      safetyScanEnabled: cfgSnapshot.safetyScanEnabled ?? true,
      fast_prewarned: fastSameCategory,
    });

    // Warn privately for the harmful categories. Spam is logged but only warned
    // at severity≥2 (avoid nagging). Always private → the sender never sees it.
    // The warning carries the offending message's id so the client paints it red.
    // G1: no user-facing warning for guardian-OFF recipients (suppressWarning).
    // G3: no SECOND warning if the fast lane already warned the same category
    // (fastSameCategory) — the red bubble + private warning already fired on arrival.
    const shouldWarn = !suppressWarning && !fastSameCategory && (category === "grooming" || category === "scam"
      || category === "csae" || category === "trafficking" || category === "threat" || category === "hate"
      || (category === "spam" && severity >= 2));
    if (shouldWarn && (await warnPrivately(env, {
      uid, conv, category, severity, peer: senderUid, advisory, flaggedClientId, flaggedCreatedAt,
    }))) {
      warned++;
      void track(env, uid, "guardian_warning_sent", "guardian", {
        conv, is_group: isGroup, category, severity, sender_uid: senderUid, recipient_uid: uid,
        country: geo.country ?? null, // PII: raw ip removed (spec §1)
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
          country: geo.country ?? null, // PII: raw ip removed (spec §1)
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
//   { prefs: { conv, secureChat?, source? } }          → set secure-chat prefs
//        (G0: deepMonitor is accepted but IGNORED; source: 'tap'|'stranger_accept')
//   { get_prefs: { conv } }                             → read secure-chat prefs
//   { digest: true, windowDays? }                       → the caller's parent digest
//   { link_child: { child_uid } }                       → record a parent↔child link
// (G0: the {media_ref} deepfake mode has been REMOVED.)
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
    // No premium gate — the guardian/shield is free on all plans (owner decision
    // 2026-06-24). G0: deepMonitor is accepted for wire compat but IGNORED.
    const next = await setGuardianPrefs(env, ctx.uid, conv, {
      secureChat: typeof b.prefs.secureChat === "boolean" ? b.prefs.secureChat : undefined,
    });
    // G1.4: the client passes source:'tap'|'stranger_accept' so we can distinguish
    // an explicit shield tap from a stranger-accept auto-enable in telemetry.
    const src = typeof b.prefs.source === "string" ? b.prefs.source : "tap";
    // Telemetry: shield toggle, stamped with email + origin country for analytics.
    const cf: any = (req as any).cf || {};
    void trackUser(env, ctx.uid, await emailFor(env, ctx.uid), "guardian_shield_toggled", "guardian", {
      secure_chat: next.secureChat, source: src, is_group: conv.startsWith("g"),
      country: cf.country ?? null, region: cf.region ?? null, city: cf.city ?? null, colo: cf.colo ?? null,
    });
    return json({ ok: true, prefs: { conv, secureChat: next.secureChat, deepMonitor: false, updatedAt: next.updatedAt } });
  }
  if (b && b.get_prefs && typeof b.get_prefs === "object") {
    const conv = String(b.get_prefs.conv ?? "").trim();
    if (!conv) return json({ error: "conv required" }, 400);
    const p = await getGuardianPrefs(env, ctx.uid, conv);
    return json({ conv, secureChat: p.secureChat, deepMonitor: p.deepMonitor, updatedAt: p.updatedAt });
  }

  // --- F6: account-wide adult-content opt-out (set / read) --------------------
  // { adult_optout: bool }  → set (refused for minors, 403)
  // { get_adult_optout: true } → read the caller's current value + whether they
  //                               are eligible to change it (adults only).
  if (b && typeof b.adult_optout === "boolean") {
    const res = await setAdultOptOut(env, ctx.uid, b.adult_optout);
    if (res.refused) {
      return json({ error: "minor_cannot_opt_out", adultOptOut: false }, 403);
    }
    const cf: any = (req as any).cf || {};
    void trackUser(env, ctx.uid, await emailFor(env, ctx.uid), "guardian_adult_optout_set", "guardian", {
      opt_out: res.adultOptOut, country: cf.country ?? null,
    });
    return json({ ok: true, adultOptOut: res.adultOptOut });
  }
  if (b && b.get_adult_optout === true) {
    const minor = await isMinorAccount(env, ctx.uid);
    const adultOptOut = await getAdultOptOut(env, ctx.uid);
    return json({ adultOptOut, eligible: !minor });
  }

  // --- link a child (custodial) -----------------------------------------------
  if (b && b.link_child && typeof b.link_child === "object") {
    const childUid = String(b.link_child.child_uid ?? "").trim();
    if (!childUid) return json({ error: "child_uid required" }, 400);
    await linkChild(env, ctx.uid, childUid);
    return json({ ok: true });
  }

  // --- U1-lite: MANUAL "Require verification" (fully DARK) ---------------------
  // { require_verify: { conv, peer_uid } } → the CALLER (owner) asks the PEER to
  // complete a live face check. Writes a pending ava_guardian_gate row and posts a
  // PRIVATE ava_private-style system message to the PEER only. 403 feature_off when
  // guardianGateEnabled is off. Nothing is enforced — this is Detect, not Act.
  if (b && b.require_verify && typeof b.require_verify === "object") {
    let gateOn = false;
    try { gateOn = (await readConfig(env)).guardianGateEnabled === true; } catch { gateOn = false; }
    if (!gateOn) return json({ error: "feature_off" }, 403);
    const conv = String(b.require_verify.conv ?? "").trim();
    const peerUid = String(b.require_verify.peer_uid ?? "").trim();
    if (!conv || !peerUid) return json({ error: "conv and peer_uid required" }, 400);
    if (peerUid === ctx.uid) return json({ error: "cannot verify self" }, 400);
    await requireVerify(env, conv, peerUid, ctx.uid);
    // Post a private system message to the PEER (only they see it) — reuses the
    // ava_private bubble path. meta flags it as a verify request for future UI.
    void postAvaMessage(env, {
      ownerUid: peerUid,
      conv,
      text: "The other person asked Ava to confirm there is a human here. Complete a quick face check to continue.",
      private: true,
      source: "guardian",
      meta: { guardian: true, verify_request: true, requested_by: ctx.uid },
    });
    void track(env, ctx.uid, "verify_human_requested", "guardian", {
      conv, peer_uid: peerUid, trigger: "manual_t4", is_group: conv.startsWith("g"),
    });
    return json({ ok: true, requested: true });
  }
  // { gate_status: { conv } } → the owner reads the verification state of a conv.
  if (b && b.gate_status && typeof b.gate_status === "object") {
    let gateOn = false;
    try { gateOn = (await readConfig(env)).guardianGateEnabled === true; } catch { gateOn = false; }
    if (!gateOn) return json({ error: "feature_off" }, 403);
    const conv = String(b.gate_status.conv ?? "").trim();
    if (!conv) return json({ error: "conv required" }, 400);
    const rows = await gateStatus(env, conv);
    return json({ conv, gates: rows });
  }

  // --- G2: dismiss a safety flag ("This is fine") -----------------------------
  // { dismiss_flag: { msg_id, conv } } → mark the flag dismissed in the CALLER's
  // OWN InboxDO (store-and-forward: persists + broadcasts to the caller's other
  // devices). The client also writes it locally first; this is the cross-device
  // path. Best-effort, detached — a failed forward never blocks the local dismiss.
  if (b && b.dismiss_flag && typeof b.dismiss_flag === "object") {
    const msgId = String(b.dismiss_flag.msg_id ?? "").trim();
    const conv = String(b.dismiss_flag.conv ?? "").trim();
    if (!msgId) return json({ error: "msg_id required" }, 400);
    try {
      if (env.INBOX) {
        const stub = env.INBOX.get(env.INBOX.idFromName(ctx.uid));
        void stub.fetch("https://inbox/safety_flag", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "safety_flag", conv, msg_id: msgId, dismissed: 1 }),
        });
      }
    } catch { /* best-effort — local dismiss already applied client-side */ }
    // Telemetry: a red-flagged message was dismissed by the recipient — the primary
    // signal for false-positive rate. msg_id_present avoids leaking the raw id.
    void track(env, ctx.uid, "guardian_false_positive_dismissed", "guardian", {
      conv, msg_id_present: !!msgId,
    });
    return json({ ok: true });
  }

  // --- parent digest (the caller's own) ---------------------------------------
  if (b && b.digest === true) {
    const windowDays = Number(b.windowDays) > 0 ? Math.min(31, Number(b.windowDays)) : 7;
    const digest = await buildParentDigest(env, ctx.uid, windowDays);
    return json({ digest });
  }

  // (G0: the {media_ref} deepfake check mode has been REMOVED.)

  // --- scan a message NOW (protect the caller) --------------------------------
  // The caller scans a chat they're in. We protect the CALLER, so we model the
  // scan with the caller as the (sole) recipient and the message's sender as peer.
  const conv = String(b.conv ?? "").trim();
  if (!conv) return json({ error: "conv required" }, 400);
  const message = (b.message && typeof b.message === "object")
    ? b.message
    : { sender: String(b.sender ?? "peer"), body: String(b.text ?? ""), kind: String(b.kind ?? "text") };
  const sender = String(message.sender ?? b.sender ?? "peer");
  // members = [sender, caller] so the caller is the protected recipient.
  const members = Array.isArray(b.members) && b.members.length
    ? b.members.map(String)
    : [sender, ctx.uid];

  const result = await guardianScan(env, { conv, message, members, senderUid: sender });
  return json({ ok: true, ...result });
}
