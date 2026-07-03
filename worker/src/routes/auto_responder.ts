// STREAM F (AI Messenger Batch) — auto-responder "Ava replies while you're away".
//
//   GET  /api/auto-responder  → getAutoResponder  — the caller's own settings
//   PUT  /api/auto-responder  → putAutoResponder  — upsert the caller's settings
//
// Both are dual-auth (requireUser → Clerk-verified uid). The uid scopes EVERYTHING:
// the D1 row PK is uid and the KV mirror key is `arsp:cfg:<uid>`, so a user can only
// read/write their OWN config (parent + each child account on a shared phone are
// fully isolated — Rulebook per-account scoping).
//
// Storage model (Rulebook + spec AUTOREP-1):
//   • Authoritative row lives in D1 (DB_META, auto_responder_settings — see
//     worker/migrations/auto_responder.sql).
//   • MIRRORED to KV (TOKENS, key arsp:cfg:<uid>) so the message send hot path
//     (/api/msg/send) can read a recipient's config with a single fast KV get
//     instead of a D1 round-trip per incoming DM. PUT writes D1 first, then the
//     mirror; a mirror miss falls back to D1 in readAutoResponderConfig().
//
// This route file is intentionally SEPARATE from routes/api.ts (do not add these to
// api.ts) — mount getAutoResponder/putAutoResponder from worker/src/index.ts.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { readConfig } from "./config";

// Canonical per-user config shape shared by the route, the KV mirror, and the
// consumer (imported from consumers via a structurally-identical local type).
export interface AutoResponderConfig {
  enabled: boolean;
  mode: "travelling" | "busy" | "sleeping" | "driving" | "custom";
  message: string;            // resolved (per-mode default applied), <=200 chars
  audience: "known" | "everyone"; // 'known' = contacts only (default); 'everyone' = all except blocked
  durationKind: "off" | "hours" | "schedule";
  durationHours?: number;     // 1|4|8|24 when durationKind='hours'
  activeUntil?: number | null; // ms epoch; set_at + hours when durationKind='hours'
  schedStart?: number | null;  // minutes-from-midnight (0..1439)
  schedEnd?: number | null;
  depth: "once" | "chat";     // 'once' = one reply/contact/day; 'chat' = AI, cap 3 exchanges/contact/day
  replyLang: boolean;         // reply in sender's language (default ON)
  urgentEscalate: boolean;    // high-priority push for urgent messages (default ON)
  awayDigest: boolean;        // post an away digest on disable / schedule-end (default ON)
  setAt?: number | null;      // ms epoch when last enabled/updated
  updatedAt: number;
}

const KV_PREFIX = "arsp:cfg:"; // KV mirror key: arsp:cfg:<uid>

// Per-mode default away messages (spec AUTOREP-1). Editable by the user; <=200 chars.
export const MODE_DEFAULTS: Record<AutoResponderConfig["mode"], string> = {
  travelling:
    "Hey — Davy is travelling and offline right now. I've noted your message; he hasn't read it yet and will see it when he's back.",
  busy: "Hi — I'm heads-down right now and can't reply. I've noted your message and will get back to you soon.",
  sleeping: "Hi — it's night here and I'm asleep. I've saved your message and will reply when I'm up.",
  driving: "Hi — I'm driving right now and can't reply. I've noted your message and will respond when I stop.",
  custom: "Hi — I'm away right now. I've noted your message and will reply as soon as I can.",
};

function clampMsg(s: unknown, mode: AutoResponderConfig["mode"]): string {
  const t = typeof s === "string" ? s.trim() : "";
  if (!t) return MODE_DEFAULTS[mode] ?? MODE_DEFAULTS.custom;
  return t.slice(0, 200);
}

/** Map a raw D1 row → the canonical config. */
function rowToConfig(r: Record<string, unknown> | null | undefined): AutoResponderConfig {
  const mode = (String(r?.mode ?? "travelling") as AutoResponderConfig["mode"]);
  return {
    enabled: !!Number(r?.enabled ?? 0),
    mode,
    message: clampMsg(r?.message, mode),
    audience: r?.audience === "everyone" ? "everyone" : "known",
    durationKind: (["off", "hours", "schedule"].includes(String(r?.duration_kind))
      ? String(r?.duration_kind) : "off") as AutoResponderConfig["durationKind"],
    durationHours: r?.duration_hours == null ? undefined : Number(r?.duration_hours),
    activeUntil: r?.active_until == null ? null : Number(r?.active_until),
    schedStart: r?.sched_start == null ? null : Number(r?.sched_start),
    schedEnd: r?.sched_end == null ? null : Number(r?.sched_end),
    depth: r?.depth === "chat" ? "chat" : "once",
    replyLang: r?.reply_lang == null ? true : !!Number(r?.reply_lang),
    urgentEscalate: r?.urgent_escalate == null ? true : !!Number(r?.urgent_escalate),
    awayDigest: r?.away_digest == null ? true : !!Number(r?.away_digest),
    setAt: r?.set_at == null ? null : Number(r?.set_at),
    updatedAt: Number(r?.updated_at ?? 0),
  };
}

/** Fresh-user default (feature off). */
function defaultConfig(): AutoResponderConfig {
  return {
    enabled: false, mode: "travelling", message: MODE_DEFAULTS.travelling,
    audience: "known", durationKind: "off", depth: "once",
    replyLang: true, urgentEscalate: true, awayDigest: true,
    activeUntil: null, schedStart: null, schedEnd: null, setAt: null, updatedAt: 0,
  };
}

/** Is the auto-responder ACTIVE *right now* for this config? Honours the master
 *  toggle, the 'hours' expiry, and the daily schedule window. Used by the hot path
 *  and the consumer so "active" is computed identically everywhere. */
export function isActiveNow(cfg: AutoResponderConfig, now = Date.now()): boolean {
  if (!cfg.enabled) return false;
  if (cfg.durationKind === "hours") {
    return cfg.activeUntil != null && now < cfg.activeUntil;
  }
  if (cfg.durationKind === "schedule") {
    if (cfg.schedStart == null || cfg.schedEnd == null) return false;
    const d = new Date(now);
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    // Wrap-around window (e.g. 22:00→07:00) is handled: start>end means overnight.
    return cfg.schedStart <= cfg.schedEnd
      ? mins >= cfg.schedStart && mins < cfg.schedEnd
      : mins >= cfg.schedStart || mins < cfg.schedEnd;
  }
  return true; // 'off' = until turned off → active whenever enabled
}

/** Read a user's config, KV-mirror first (hot path), D1 fallback. Never throws. */
export async function readAutoResponderConfig(env: Env, uid: string): Promise<AutoResponderConfig> {
  try {
    const kv = (await env.TOKENS.get(KV_PREFIX + uid, "json")) as AutoResponderConfig | null;
    if (kv) return { ...defaultConfig(), ...kv };
  } catch { /* fall through to D1 */ }
  try {
    const r = await env.DB_META.prepare(
      "SELECT * FROM auto_responder_settings WHERE uid=?1",
    ).bind(uid).first<Record<string, unknown>>();
    const cfg = r ? rowToConfig(r) : defaultConfig();
    // Warm the mirror opportunistically so the next hot-path read is a KV hit.
    try { await env.TOKENS.put(KV_PREFIX + uid, JSON.stringify(cfg)); } catch { /* best-effort */ }
    return cfg;
  } catch {
    return defaultConfig();
  }
}

/** GET /api/auto-responder — the caller's own settings + the per-mode defaults so
 *  the client can pre-fill an editable field when a mode is picked. */
export async function getAutoResponder(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const featureOn = (await readConfig(env)).autoResponderEnabled;
  const cfg = await readAutoResponderConfig(env, ctx.uid);
  return json({ ok: true, featureEnabled: featureOn, config: cfg, modeDefaults: MODE_DEFAULTS });
}

/** PUT /api/auto-responder — upsert the caller's settings (D1) + refresh the KV
 *  mirror. Scoped strictly to ctx.uid. */
export async function putAutoResponder(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const now = Date.now();

  // Detect an enabled→disabled transition so we can fire the away digest (AUTOREP-4).
  const prev = await readAutoResponderConfig(env, ctx.uid);
  const wasActive = isActiveNow(prev, now);
  const mode = (["travelling", "busy", "sleeping", "driving", "custom"].includes(String(b.mode))
    ? String(b.mode) : "travelling") as AutoResponderConfig["mode"];
  const enabled = b.enabled === true;
  const durationKind = (["off", "hours", "schedule"].includes(String(b.durationKind))
    ? String(b.durationKind) : "off") as AutoResponderConfig["durationKind"];
  const durationHours = [1, 4, 8, 24].includes(Number(b.durationHours)) ? Number(b.durationHours) : null;
  // 'hours' anchors from NOW when (re)enabling so "for 4 hours" means 4h from set.
  const activeUntil = durationKind === "hours" && durationHours ? now + durationHours * 3_600_000 : null;
  const schedStart = b.schedStart == null ? null : Math.max(0, Math.min(1439, Number(b.schedStart) | 0));
  const schedEnd = b.schedEnd == null ? null : Math.max(0, Math.min(1439, Number(b.schedEnd) | 0));

  const cfg: AutoResponderConfig = {
    enabled, mode,
    message: clampMsg(b.message, mode),
    audience: b.audience === "everyone" ? "everyone" : "known",
    durationKind, durationHours: durationHours ?? undefined, activeUntil,
    schedStart, schedEnd,
    depth: b.depth === "chat" ? "chat" : "once",
    replyLang: b.replyLang !== false,        // default ON
    urgentEscalate: b.urgentEscalate !== false, // default ON
    awayDigest: b.awayDigest !== false,      // default ON
    setAt: now, updatedAt: now,
  };

  await env.DB_META.prepare(
    `INSERT INTO auto_responder_settings
       (uid, enabled, mode, message, audience, duration_kind, duration_hours, active_until,
        sched_start, sched_end, depth, reply_lang, urgent_escalate, away_digest, set_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
     ON CONFLICT(uid) DO UPDATE SET
       enabled=?2, mode=?3, message=?4, audience=?5, duration_kind=?6, duration_hours=?7,
       active_until=?8, sched_start=?9, sched_end=?10, depth=?11, reply_lang=?12,
       urgent_escalate=?13, away_digest=?14, set_at=?15, updated_at=?16`,
  ).bind(
    ctx.uid, cfg.enabled ? 1 : 0, cfg.mode, cfg.message, cfg.audience, cfg.durationKind,
    cfg.durationHours ?? null, cfg.activeUntil ?? null, cfg.schedStart ?? null, cfg.schedEnd ?? null,
    cfg.depth, cfg.replyLang ? 1 : 0, cfg.urgentEscalate ? 1 : 0, cfg.awayDigest ? 1 : 0,
    cfg.setAt ?? null, cfg.updatedAt,
  ).run();

  // Refresh the KV hot-path mirror.
  try { await env.TOKENS.put(KV_PREFIX + ctx.uid, JSON.stringify(cfg)); } catch { /* best-effort; readAutoResponderConfig falls back to D1 */ }

  // Away digest (AUTOREP-4): if the responder just went from ACTIVE → not active
  // (user turned it off), enqueue a digest job. The consumer reads the day's
  // replied-peer log and posts "While you were away I replied to N people: …" to
  // the owner's self-thread. Only when awayDigest is on (default) + there was a
  // real transition. Rides the same auto-reply queue (kind:"digest").
  if (prev.awayDigest && wasActive && !isActiveNow(cfg, now)) {
    try { await env.Q_AUTO_REPLY?.send({ kind: "digest", uid: ctx.uid }); } catch { /* best-effort */ }
  }

  // Telemetry (AUTOREP-5): autoresponder_enabled — include the owner email so the
  // event is pullable for support. Best-effort.
  try {
    void env.Q_ANALYTICS?.send({
      event: "autoresponder_enabled", uid: ctx.uid, ts: now,
      props: {
        enabled: cfg.enabled, mode: cfg.mode, ai_mode: cfg.depth === "chat",
        audience: cfg.audience, duration_kind: cfg.durationKind, reply_lang: cfg.replyLang,
        urgent_escalate: cfg.urgentEscalate,
        // Raw email isn't in D1 (privacy: email_hash only); PostHog maps uid → the
        // person whose email was set client-side, so account_id makes this pullable.
        account_id: ctx.uid, app_name: "avatok", service_name: "avatok-api", worker: true,
      },
    });
  } catch { /* best-effort */ }

  return json({ ok: true, config: cfg });
}
