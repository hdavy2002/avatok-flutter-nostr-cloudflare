// Guardian Sentinel — S2 mem0 client: a MINIMAL REST client for the mem0 managed
// cloud (https://api.mem0.ai). See Specs/GUARDIAN-SENTINEL-FINAL-PLAN-2026-07-06.md §S2.
//
// CONSTITUTIONAL ANCHOR (plan §1.1 rule 5 — repeat it so nobody forgets):
//   mem0 is a DERIVED CACHE, NEVER an owner of truth. Every memory we write carries
//   `derived_from: [event_ids]`, `summary_version`, and `created_from_ruleset` in its
//   metadata. If mem0 vanished, every memory regenerates deterministically from the
//   append-only sentinel_evidence log (the single owner of truth). mem0 writes are
//   ASYNC — never on the message hot path — and there are NO LLM calls in this phase.
//
// PATTERNS, NOT CONTENT (plan §S2 hard rule): the memory text we send must NEVER
// contain raw message text, media, emails, or protected attributes. The summariser
// (summariser.ts) composes deterministic, templated, category-level pattern strings
// only. This module is transport; it does not construct text.
//
// FAIL-OPEN EVERYWHERE: mem0 is an external SaaS. Missing MEM0_API_KEY, a missing
// sentinelMem0Enabled flag, timeouts, 4xx/5xx — all no-op cleanly and never throw
// into the caller. An external dependency can never break Sentinel or a user request.
//
// user_id  = the account uid (the subject the behaviour memory is ABOUT).
// metadata = { derived_from, summary_version, created_from_ruleset, buckets }.

import type { Env } from "../types";
import { track } from "../hooks";

const MEM0_BASE = "https://api.mem0.ai/v1";
const TIMEOUT_MS = 8_000;

/** True only when BOTH the secret is present AND the S2 flag is on (checked by the
 *  caller, but re-guarded here as a backstop for the key). We never touch the network
 *  without a key. */
export function mem0Configured(env: Env): boolean {
  return typeof env.MEM0_API_KEY === "string" && env.MEM0_API_KEY.length > 0;
}

export interface Mem0Metadata {
  /** Immutable event ids this memory derives from (provenance → regenerable). */
  derived_from: string[];
  /** Bumped when the summariser template/semantics change. */
  summary_version: number;
  /** SENTINEL_RULESET_VERSION at compose time. */
  created_from_ruleset: string;
  /** Which evidence buckets fed the summary (category-level, no content). */
  buckets?: string[];
  [k: string]: unknown;
}

async function mem0Fetch(
  env: Env,
  path: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number }> {
  if (!mem0Configured(env)) return { ok: false, status: 0 };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${MEM0_BASE}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: {
        // mem0 cloud expects `Authorization: Token <key>`.
        Authorization: `Token ${env.MEM0_API_KEY}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    return { ok: res.ok, status: res.status };
  } catch {
    // Abort (timeout) or network error → treat as a soft failure, never throw.
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Write ONE behavioural pattern memory for `uid`. `content` is a deterministic,
 * templated, category-level string (built by summariser.ts) — NEVER raw content.
 * Fail-open; returns whether the write succeeded. Emits mem0_write / mem0_write_failed.
 */
export async function writeMemory(
  env: Env,
  uid: string,
  content: string,
  metadata: Mem0Metadata,
): Promise<boolean> {
  if (!uid || !content) return false;
  const t0 = Date.now();
  const { ok, status } = await mem0Fetch(env, "/memories", {
    method: "POST",
    body: JSON.stringify({
      // mem0 ingests a message list; we send a single synthetic user turn carrying
      // the pattern summary. No LLM runs here — the text is already final.
      messages: [{ role: "user", content }],
      user_id: uid,
      metadata,
    }),
  });
  const ms = Date.now() - t0;
  if (ok) {
    void track(env, uid, "mem0_write", "sentinel", {
      ms, status, summary_version: metadata.summary_version,
      created_from_ruleset: metadata.created_from_ruleset,
      derived_count: metadata.derived_from?.length ?? 0,
    });
  } else {
    void track(env, uid, "mem0_write_failed", "sentinel", { ms, status });
  }
  return ok;
}

/** List memories for a uid (diagnostics / export-redaction — S2 does NOT read on any
 *  hot path). Fail-open → returns null on any error. */
export async function listMemories(env: Env, uid: string): Promise<unknown | null> {
  if (!mem0Configured(env) || !uid) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${MEM0_BASE}/memories?user_id=${encodeURIComponent(uid)}`, {
      method: "GET",
      signal: ctrl.signal,
      headers: { Authorization: `Token ${env.MEM0_API_KEY}`, "content-type": "application/json" },
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Delete ALL memories for a uid. Used by the deletion purge queue (do.ts / purge.ts).
 * Fail-open; returns whether the delete was confirmed by mem0 (so the purge queue can
 * decide to retry). NEVER throws — canonical account deletion must never block on this.
 */
export async function deleteMemories(env: Env, uid: string): Promise<boolean> {
  if (!uid) return false;
  const t0 = Date.now();
  const { ok, status } = await mem0Fetch(env, `/memories?user_id=${encodeURIComponent(uid)}`, {
    method: "DELETE",
  });
  const ms = Date.now() - t0;
  // A 404 (nothing to delete) is a successful purge — the user has no memories.
  const confirmed = ok || status === 404;
  void track(env, uid, confirmed ? "mem0_delete" : "mem0_delete_failed", "sentinel", { ms, status });
  return confirmed;
}
