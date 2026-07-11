// mem0.ts — caller memory layer for the Ava AI Voice Agent (WP4, plan §4 "Memory
// + speed" / §9 of Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md).
//
// Grok Collections (lib/grok.ts) is DOCUMENT RAG (the owner's knowledge base).
// mem0 is CONVERSATIONAL memory — "who is this caller, what have we talked about
// before" — scoped per (business, caller) pair so a returning caller to Business A
// is remembered independently of the same caller ringing Business B.
//
// user_id convention: `${business_uid}::${caller_uid}` — one mem0 "user" per
// business/caller PAIR, never a single global caller identity (keeps memories
// scoped exactly like every other per-account rule in this codebase).
//
// REUSES env.MEM0_API_KEY — the SAME secret Guardian Sentinel S2 already reads
// (types.ts, `wrangler secret put MEM0_API_KEY`, mirrored in staging+prod). No
// new secret needed. Unset → both functions cleanly no-op (fail-open), exactly
// like Sentinel's mem0 usage: the agent works with zero caller memory rather
// than failing the call.
import type { Env } from "../types";

const BASE = "https://api.mem0.ai/v1";

function userIdFor(businessUid: string, callerUid: string): string {
  return `${businessUid}::${callerUid}`;
}

async function mfetch(env: Env, path: string, init?: RequestInit): Promise<any | null> {
  const key = env.MEM0_API_KEY;
  if (!key) return null; // graceful no-op — no key configured
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Token ${key}`,
        "Content-Type": "application/json",
        ...(init?.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null; // best-effort — a mem0 hiccup never blocks/breaks the call
  }
}

/**
 * Load this caller's memories for this business, formatted as short text lines
 * ready to splice into the Grok session `instructions`. Empty array when mem0
 * is unset/unreachable or the caller has no prior history — the agent then just
 * runs with zero caller memory (never a hard failure).
 */
export async function loadCallerMemory(env: Env, businessUid: string, callerUid: string): Promise<string[]> {
  if (!businessUid || !callerUid) return [];
  const userId = userIdFor(businessUid, callerUid);
  const j = await mfetch(env, `/memories/?user_id=${encodeURIComponent(userId)}`, { method: "GET" });
  const items: any[] = Array.isArray(j) ? j : (Array.isArray(j?.results) ? j.results : []);
  return items
    .map((m) => String(m?.memory ?? m?.text ?? "").trim())
    .filter(Boolean)
    .slice(0, 20); // cap — this rides inline in the session instructions, keep it tight
}

/**
 * Write a short end-of-call summary into mem0 for this (business, caller) pair.
 * No-op when mem0 is unset/unreachable — the transcript itself (InboxDO thread,
 * R2) is the durable record; mem0 is purely a derived "remember this caller"
 * cache, never an owner of truth (same rule as Guardian Sentinel S2).
 */
export async function writeCallSummary(env: Env, businessUid: string, callerUid: string, summary: string): Promise<void> {
  if (!businessUid || !callerUid || !summary?.trim()) return;
  const userId = userIdFor(businessUid, callerUid);
  await mfetch(env, `/memories/`, {
    method: "POST",
    body: JSON.stringify({
      user_id: userId,
      messages: [{ role: "assistant", content: summary.slice(0, 2000) }],
    }),
  });
}

/**
 * Caller-side GDPR erasure (plan §15.4): delete this caller's mem0 memories
 * across ALL businesses they've called. mem0's REST API scopes deletion by
 * user_id, and our user_id is `${business}::${caller}` (not a plain caller id),
 * so we can't target "all businesses for this caller" in one call without an
 * index of which businesses this caller has talked to — callers of this
 * function are expected to pass the specific business_uid(s) from
 * agent_call_log (routes/agent_profiles.ts owns that lookup). Best-effort.
 */
export async function deleteCallerMemory(env: Env, businessUid: string, callerUid: string): Promise<void> {
  if (!businessUid || !callerUid) return;
  const userId = userIdFor(businessUid, callerUid);
  await mfetch(env, `/memories/?user_id=${encodeURIComponent(userId)}`, { method: "DELETE" });
}
