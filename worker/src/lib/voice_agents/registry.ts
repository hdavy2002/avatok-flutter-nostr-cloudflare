// [AUMFE-VOICE-RUNTIME-1 2026-10-01] The list of voice guides the runtime can open.
// [AUMFE-VOICE-AGENTS-DB-1 2026-10-02] Guides are now DATA: rows in D1 (voice_agents + the published row of
// voice_agent_prompts), edited by the owner in Admin -> Voice guides. Code supplies only tool packs (tool_packs.ts)
// and the hard rules (prompt.ts). D1 is read through a 60 s in-isolate cache; if D1 has no rows or errors, the code
// Meera (agents/astrology.ts) is served so the product never goes dark.
import type { Env } from "../../types";
import type { VoiceAgentDef, VoiceAgentPublic } from "./types";
import astrologyAgent from "./agents/astrology";
import { assemblePrompt, BRAND_TOKEN } from "./prompt";
import { packOrDefault } from "./tool_packs";
import { searchKnowledgeTool } from "./kb";
import { canSeeGuides, isPreviewer } from "../preview";
import { priceTokensPerMin } from "./billing";

export type AgentStatus = "draft" | "preview" | "live" | "archived";
export const AGENT_STATUSES: readonly AgentStatus[] = ["draft", "preview", "live", "archived"];

const CACHE_MS = 60_000;

/** One voice_agents row joined with its published prompt (persona/greeting) and a count of ready knowledge docs. */
export interface AgentRow {
  id: string; name: string; subject: string; blurb: string; initial: string; tint: string; avatar_url: string | null;
  voice: string; language: string; tool_pack: string; price_per_min_tokens: number | null; status: AgentStatus;
  sort: number; persona: string | null; greeting: string | null; docs_ready: number;
}

// ---------------------------------------------------------------------------
// Pure: who may see / open which status
// ---------------------------------------------------------------------------
export interface VisibilityCtx {
  /** canSeeGuides: the public switch is on, or the caller is a previewer. */
  canSee: boolean;
  /** Caller is on ADMIN_UIDS / AGENT_ADMIN_UIDS. */
  previewer: boolean;
  /** Caller is an admin AND the ticket asked for a test call. */
  adminTest?: boolean;
}

/** live -> canSeeGuides; preview -> previewers only; draft -> admin test calls only; archived -> nobody. */
export function agentVisibleTo(status: AgentStatus | undefined, v: VisibilityCtx): boolean {
  const s = status ?? "preview";
  if (s === "archived") return false;
  if (v.adminTest) return true;
  if (s === "live") return v.canSee;
  if (s === "preview") return v.previewer;
  return false;
}

// ---------------------------------------------------------------------------
// Pure: row -> VoiceAgentDef
// ---------------------------------------------------------------------------
export function defaultPersona(name: string, subject: string): string {
  return `You are ${name}, ${BRAND_TOKEN}'s AI ${subject} guide. Be warm, calm and respectful, and speak the customer's language.`;
}

export function buildAgentDef(row: AgentRow): VoiceAgentDef {
  const pack = packOrDefault(row.tool_pack);
  const persona = (row.persona ?? "").trim() || defaultPersona(row.name, row.subject);
  const tools = [...pack.tools, ...(Number(row.docs_ready) > 0 ? [searchKnowledgeTool(row.id)] : [])];
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    voice: row.voice,
    language: row.language,
    systemPrompt: ({ briefing, brandName, nowIst }) =>
      assemblePrompt({ brandName, nowIst, packRules: pack.baseRules(brandName), persona, greeting: row.greeting, briefing }),
    tools,
    ui: { initial: row.initial || row.name.slice(0, 1).toUpperCase(), tint: row.tint, blurb: row.blurb },
    pricePerMinTokens: row.price_per_min_tokens == null ? undefined : Number(row.price_per_min_tokens),
    avatarUrl: row.avatar_url,
    status: row.status,
  };
}

// ---------------------------------------------------------------------------
// D1 read with a 60 s cache and the code fallback
// ---------------------------------------------------------------------------
const FALLBACK: VoiceAgentDef = { ...astrologyAgent, status: "preview" };

let cache: { at: number; agents: VoiceAgentDef[] } | null = null;
export function clearVoiceAgentCache(): void { cache = null; }

const SQL = `SELECT a.id, a.name, a.subject, a.blurb, a.initial, a.tint, a.avatar_url, a.voice, a.language, a.tool_pack,
    a.price_per_min_tokens, a.status, a.sort, p.persona AS persona, p.greeting AS greeting,
    (SELECT COUNT(*) FROM voice_agent_docs d WHERE d.agent_id = a.id AND d.status = 'ready') AS docs_ready
  FROM voice_agents a LEFT JOIN voice_agent_prompts p ON p.id = a.published_prompt_id
  WHERE a.status != 'archived' ORDER BY a.sort ASC, a.name ASC`;

async function loadAll(env: Env, fresh: boolean): Promise<VoiceAgentDef[]> {
  const now = Date.now();
  if (!fresh && cache && now - cache.at < CACHE_MS) return cache.agents;
  try {
    const res = await env.DB_META.prepare(SQL).all<AgentRow>();
    const rows = res.results ?? [];
    const agents = rows.length ? rows.map(buildAgentDef) : [FALLBACK];
    cache = { at: now, agents };
    return agents;
  } catch {
    // Table missing (migration not applied yet) or D1 hiccup: serve the code Meera, retry on the next call.
    return [FALLBACK];
  }
}

/** Load one guide by id (any non-archived status; the caller enforces visibility). `fresh` skips the cache (admin test calls). */
export async function getAgent(env: Env, id: unknown, opts: { fresh?: boolean } = {}): Promise<VoiceAgentDef | null> {
  if (typeof id !== "string" || !id) return null;
  return (await loadAll(env, opts.fresh === true)).find((a) => a.id === id) ?? null;
}

export function toPublic(a: VoiceAgentDef): VoiceAgentPublic {
  return {
    id: a.id, name: a.name, subject: a.subject, initial: a.ui.initial, tint: a.ui.tint, blurb: a.ui.blurb,
    price_per_min_tokens: a.pricePerMinTokens ?? null, avatar_url: a.avatarUrl ?? null,
  };
}

/** Guides this caller may see in the list: live when canSeeGuides, preview only for previewers. Drafts never. */
export async function listAgentsPublic(env: Env, uid: string | null): Promise<VoiceAgentPublic[]> {
  const [all, canSee] = await Promise.all([loadAll(env, false), canSeeGuides(env, uid)]);
  const v: VisibilityCtx = { canSee, previewer: !!uid && isPreviewer(env, uid) };
  return all.filter((a) => agentVisibleTo(a.status, v)).map(toPublic);
}

/** Wallet tokens per started minute for this guide: its own price (0 = free), else the platform default from config. */
export function agentPriceTokens(agent: Pick<VoiceAgentDef, "pricePerMinTokens">, configPaise: number): number {
  const own = agent.pricePerMinTokens;
  if (own != null && Number.isFinite(own)) return Math.max(0, Math.trunc(own));
  return priceTokensPerMin(configPaise);
}
