// Marketplace Agent settings routes (AI Messenger Batch — STREAM A, MKT-LANG-1).
//   GET  /api/marketplace/agent-settings   — the auth user's row (defaults if none)
//   PUT  /api/marketplace/agent-settings   — upsert (validated)
//
// These persist the per-user negotiation-agent preferences (default language,
// agent name, voice, tone, negotiation guardrails, auto-respond + quiet hours,
// digest preference) into D1 `marketplace_agent_settings`. The negotiation
// pipeline in marketplace.ts reads this row server-side to resolve the buyer's
// language / floor / tone / ask-before-commit. Mirrors the auth + D1 + config-gate
// style of the other route files (requireUser → isFail → metaDb → json).
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb } from "../db/shard";
import { trackUserContact } from "../hooks";
import { contactFor } from "../lib/identity";
import { readConfig } from "./config";

/** Allowlist of default-language BCP-47 codes offered to the agent (MKT-LANG-2).
 *  Kept in sync with the client dropdown in
 *  app/lib/features/settings/marketplace_agent_settings_page.dart. A value
 *  outside this set is rejected on PUT (400) so the negotiation pipeline can
 *  trust `lang`. */
export const AGENT_LANGS = [
  "en", "es", "hi", "fr", "de", "pt", "ar", "zh", "ja",
  "ru", "id", "ur", "bn", "sw", "tr", "vi",
] as const;

const TONES = new Set(["friendly", "professional", "brief"]);
const DIGESTS = new Set(["every", "summary"]);

export interface AgentSettings {
  agent_name: string | null;
  lang: string;
  voice: string | null;
  tone: string;
  floor_pct: number;
  ask_before_commit: boolean;
  auto_respond: boolean;
  quiet_start: string | null;
  quiet_end: string | null;
  digest: string;
}

/** Idempotent create — D1 has no migration runner in the request path, so each
 *  route ensures its own table (the same pattern ensureLedger() uses in
 *  marketplace.ts). Cheap: CREATE TABLE IF NOT EXISTS is a no-op once applied. */
async function ensureTable(env: Env): Promise<void> {
  await metaDb(env).prepare(
    `CREATE TABLE IF NOT EXISTS marketplace_agent_settings (
       user_id TEXT PRIMARY KEY,
       agent_name TEXT,
       lang TEXT NOT NULL DEFAULT 'en',
       voice TEXT,
       tone TEXT NOT NULL DEFAULT 'friendly',
       floor_pct INTEGER NOT NULL DEFAULT 80,
       ask_before_commit INTEGER NOT NULL DEFAULT 0,
       auto_respond INTEGER NOT NULL DEFAULT 1,
       quiet_start TEXT,
       quiet_end TEXT,
       digest TEXT NOT NULL DEFAULT 'summary',
       updated_at INTEGER NOT NULL
     )`,
  ).run();
}

const DEFAULTS: AgentSettings = {
  agent_name: null,
  lang: "en",
  voice: null,
  tone: "friendly",
  floor_pct: 80,
  ask_before_commit: false,
  auto_respond: true,
  quiet_start: null,
  quiet_end: null,
  digest: "summary",
};

/** Read the agent settings for a user (server-internal helper used by the
 *  negotiation pipeline). Returns DEFAULTS when no row exists. */
export async function getAgentSettings(env: Env, uid: string): Promise<AgentSettings> {
  try {
    await ensureTable(env);
    const row = await metaDb(env).prepare(
      "SELECT agent_name, lang, voice, tone, floor_pct, ask_before_commit, auto_respond, quiet_start, quiet_end, digest FROM marketplace_agent_settings WHERE user_id=?1",
    ).bind(uid).first<any>();
    if (!row) return { ...DEFAULTS };
    return {
      agent_name: row.agent_name ?? null,
      lang: String(row.lang || "en"),
      voice: row.voice ?? null,
      tone: String(row.tone || "friendly"),
      floor_pct: Math.max(50, Math.min(100, Math.trunc(Number(row.floor_pct) || 80))),
      ask_before_commit: Number(row.ask_before_commit) === 1,
      auto_respond: Number(row.auto_respond ?? 1) === 1,
      quiet_start: row.quiet_start ?? null,
      quiet_end: row.quiet_end ?? null,
      digest: String(row.digest || "summary"),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

// GET /api/marketplace/agent-settings — the auth user's row (defaults if none).
export async function marketplaceAgentSettingsGet(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  // Feature kill switch — client hides the tile when off, but gate the API too.
  const cfg = await readConfig(env);
  if ((cfg as any).marketplaceAgentSettingsEnabled === false) {
    return json({ error: "disabled" }, 403);
  }
  const s = await getAgentSettings(env, ctx.uid);
  return json({ ok: true, settings: s, langs: AGENT_LANGS });
}

/** Validate an "HH:MM" 24h time string, or null/'' → null. */
function normTime(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : null;
}

// PUT /api/marketplace/agent-settings — upsert with validation.
export async function marketplaceAgentSettingsPut(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const cfg = await readConfig(env);
  if ((cfg as any).marketplaceAgentSettingsEnabled === false) {
    return json({ error: "disabled" }, 403);
  }
  const b = (await req.json().catch(() => ({}))) as any;

  // agent_name: optional, <=30 chars, trimmed. Empty → null (use default client-side).
  let agentName: string | null = null;
  if (b.agent_name != null) {
    const n = String(b.agent_name).trim().slice(0, 30);
    agentName = n.length ? n : null;
  }

  // lang: must be in the allowlist.
  const lang = String(b.lang || "en").trim();
  if (!(AGENT_LANGS as readonly string[]).includes(lang)) {
    return json({ error: "invalid lang", allowed: AGENT_LANGS }, 400);
  }

  // voice: optional free-string (validated against the Gemini catalog client-side).
  const voice = b.voice != null && String(b.voice).trim() ? String(b.voice).trim().slice(0, 40) : null;

  // tone: friendly | professional | brief.
  const tone = TONES.has(String(b.tone)) ? String(b.tone) : "friendly";

  // floor_pct: 50-100.
  const floorPct = Math.max(50, Math.min(100, Math.trunc(Number(b.floor_pct))));
  if (!Number.isFinite(floorPct)) {
    return json({ error: "invalid floor_pct (50-100)" }, 400);
  }

  const askBeforeCommit = b.ask_before_commit === true || b.ask_before_commit === 1 ? 1 : 0;
  const autoRespond = b.auto_respond === false || b.auto_respond === 0 ? 0 : 1;
  const quietStart = normTime(b.quiet_start);
  const quietEnd = normTime(b.quiet_end);
  const digest = DIGESTS.has(String(b.digest)) ? String(b.digest) : "summary";

  await ensureTable(env);
  await metaDb(env).prepare(
    `INSERT INTO marketplace_agent_settings
       (user_id, agent_name, lang, voice, tone, floor_pct, ask_before_commit, auto_respond, quiet_start, quiet_end, digest, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
     ON CONFLICT(user_id) DO UPDATE SET
       agent_name=excluded.agent_name, lang=excluded.lang, voice=excluded.voice,
       tone=excluded.tone, floor_pct=excluded.floor_pct,
       ask_before_commit=excluded.ask_before_commit, auto_respond=excluded.auto_respond,
       quiet_start=excluded.quiet_start, quiet_end=excluded.quiet_end,
       digest=excluded.digest, updated_at=excluded.updated_at`,
  ).bind(
    ctx.uid, agentName, lang, voice, tone, floorPct,
    askBeforeCommit, autoRespond, quietStart, quietEnd, digest, Date.now(),
  ).run();

  // MKT-LANG-5 telemetry — stamp the user's email/phone so support can pull the
  // event by contact in PostHog (trackUserContact resolves via the uid→contact map).
  const contact = await contactFor(env, ctx.uid).catch(() => ({ email: null, phone: null }));
  trackUserContact(env, ctx.uid, contact.email, contact.phone, "mkt_agent_settings_saved", "avamarketplace", {
    lang, tone, floor_pct: floorPct, ask_before_commit: askBeforeCommit === 1,
    auto_respond: autoRespond === 1, digest,
  });

  const s = await getAgentSettings(env, ctx.uid);
  return json({ ok: true, settings: s });
}
