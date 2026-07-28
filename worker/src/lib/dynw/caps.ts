// [DYNW-CORE-1] Capability bindings passed INTO dynamic Workers
// (Specs/PROPOSAL-DYNAMIC-WORKERS-2026-07-28.md §2.2).
//
// Model: each class extends WorkerEntrypoint; the host creates a stub via
// ctx.exports.<Class>({ props }) and places it in the dynamic Worker's env.
// The dynamic code can ONLY call the methods defined here; props (account scope,
// consent snapshot) are set by the host and are invisible + unforgeable from
// inside the sandbox. Props must NEVER contain API keys or other secrets — any
// secret material stays in this Worker's env, read here on the host side.
//
// Owner decisions enforced here (2026-07-28):
//   • DynBrain is READ-ONLY. No ingest/embed/write method may EVER be added.
//   • Every DynBrain call re-checks: dynamicWorkersEnabled + dynAvaBrainContextEnabled
//     + master AvaBrain consent + the per-app guardrail capability. Fail-closed.
//   • Private/E2E content is excluded structurally: the only retrieval path is
//     brainSearchTyped(), whose server-side lanes (AI Search / Vectorize) index
//     consented, server-readable content only — device-private content never
//     reaches them, so it can never reach a dynamic Worker.
//   • There is deliberately NO DynConv / message-write capability (messaging is
//     out of scope for dynamic code) and NO wallet-spend capability.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../../types";
import { readConfig } from "../../routes/config";
import { brainSearchTyped, type MemoryResult } from "../ava_memory";
import { track } from "../../hooks";
import { executeTool, isConfirmableTool, confirmSummaryFor, trimToolResultForModel } from "../composio";
import { isExecutableTool, coerceArgs } from "../capabilities";

/** Thrown (as a plain Error over RPC) when a capability check fails. */
export const CAP_DENIED = "capability_denied";

// ── DynKV ────────────────────────────────────────────────────────────────────
// Prefix-scoped scratch KV on env.TOKENS. Keys are namespaced as
// `dynkv:<prefix>:<key>` where <prefix> comes from HOST-set props — the dynamic
// Worker chooses only <key>, so cross-prefix reads are impossible by construction
// (per-account scoping enforced by the sandbox, not by discipline).

export interface DynKvProps { prefix: string }
const DYNKV_MAX_VALUE = 32 * 1024; // scratch storage, not a datastore
const DYNKV_TTL_SEC = 24 * 60 * 60;

export class DynKV extends WorkerEntrypoint<Env> {
  private get p(): DynKvProps {
    const p = (this.ctx as unknown as { props?: DynKvProps }).props;
    if (!p || typeof p.prefix !== "string" || !p.prefix) throw new Error(`${CAP_DENIED}: no scope`);
    return p;
  }
  private k(key: string): string {
    const clean = String(key).replace(/[^\w.-]/g, "_").slice(0, 128);
    return `dynkv:${this.p.prefix}:${clean}`;
  }
  async get(key: string): Promise<string | null> {
    return this.env.TOKENS.get(this.k(key));
  }
  async put(key: string, value: string): Promise<void> {
    const v = String(value);
    if (v.length > DYNKV_MAX_VALUE) throw new Error("value too large");
    await this.env.TOKENS.put(this.k(key), v, { expirationTtl: DYNKV_TTL_SEC });
  }
  async delete(key: string): Promise<void> {
    await this.env.TOKENS.delete(this.k(key));
  }
}

// ── DynBrain ─────────────────────────────────────────────────────────────────
// Read-only, consent-scoped AvaBrain search. The uid comes from props (host-set);
// the dynamic Worker cannot search anyone else.

export interface DynBrainProps {
  uid: string;
  /** Per-app guardrail capability key in brain_consent (e.g. "ava_apps"). */
  guardrailCapability: string;
}

/** brain_consent is opt-out (absent row = enabled); enabled=0 = explicit OFF. */
async function consentAllows(env: Env, uid: string, capabilities: string[]): Promise<boolean> {
  try {
    const ph = capabilities.map((_, i) => `?${i + 2}`).join(",");
    const rs = await env.DB_BRAIN.prepare(
      `SELECT capability, enabled FROM brain_consent WHERE uid=?1 AND capability IN (${ph})`,
    ).bind(uid, ...capabilities).all();
    for (const r of (rs.results ?? []) as { capability: string; enabled: number }[]) {
      if (Number(r.enabled) !== 1) return false;
    }
    return true;
  } catch (e) {
    console.error("[dynw] consent check failed — fail-closed:", String(e));
    return false; // fail-closed, matching brain_assets.ts
  }
}

// ── DynComposio ──────────────────────────────────────────────────────────────
// [DYNW-CODEMODE-1] Validated Composio tool execution for Code Mode scripts.
// One method, exec(slug, args), which runs the EXACT validation chain the GenUI
// action route uses (isExecutableTool → coerceArgs → executeTool) plus:
//   • per-run tool budget, enforced HERE so the script cannot bypass it. The
//     counter lives in KV keyed by runId; increments are read-modify-write and
//     non-atomic — same accepted trade-off as ava_apps.ts checkRunQuota (a
//     sequential script can't race itself; a pathological parallel script can
//     overshoot by at most the in-flight count, and executeTool's idempotency
//     still applies).
//   • confirm-before-send: a SEND/DELETE/CREATE_EVENT-class tool (same
//     isConfirmableTool truth the legacy loop uses) is NOT executed — the
//     pending action is stored under the SAME avaapps:confirm:<token> key the
//     existing confirm-resume route path executes, details are parked at
//     dynw:cm:pending:<runId> for the host, and exec throws "needs_confirm".
//   • results are shaped by the loop's own trimToolResultForModel so both lanes
//     return identical structures to their consumers.
// Props carry NO secrets (uid, budget, flags, runId only).

export interface DynComposioProps {
  uid: string;
  runId: string;        // per-run scope for the budget counter + pending slot
  budget: number;       // max exec() calls this run
  confirmSends: boolean;
}

interface CmLedger { n: number; tools: string[] }

export class DynComposio extends WorkerEntrypoint<Env> {
  private get p(): DynComposioProps {
    const p = (this.ctx as unknown as { props?: DynComposioProps }).props;
    if (!p || typeof p.uid !== "string" || !p.uid || typeof p.runId !== "string" || !p.runId) {
      throw new Error(`${CAP_DENIED}: no scope`);
    }
    return p;
  }

  async exec(slug: string, args: Record<string, unknown>): Promise<unknown> {
    const { uid, runId, budget, confirmSends } = this.p;
    const s = String(slug ?? "").toUpperCase().trim();
    if (!/^[A-Z0-9_]{3,80}$/.test(s)) throw new Error(`${CAP_DENIED}: bad_slug`);
    if (!(await isExecutableTool(this.env, s))) throw new Error(`${CAP_DENIED}: unknown_tool ${s}`);

    // Budget ledger (also doubles as the executed-tools record for telemetry).
    const lkey = `dynw:cm:${runId}`;
    let ledger: CmLedger = { n: 0, tools: [] };
    try { ledger = ((await this.env.TOKENS.get(lkey, "json")) as CmLedger) ?? ledger; } catch { /* fresh */ }
    if (ledger.n >= Math.max(1, budget)) throw new Error("tool_budget_exhausted");

    const coerced = await coerceArgs(this.env, s, (args && typeof args === "object" ? args : {}) as Record<string, unknown>);

    // Confirm gate BEFORE any side effect. Reuses the legacy confirm-token slot,
    // so the existing /api/ava/apps/run confirm_token path executes the resume.
    if (confirmSends && isConfirmableTool(s)) {
      const token = crypto.randomUUID();
      const human = confirmSummaryFor(s, coerced);
      try { await this.env.TOKENS.put(`avaapps:confirm:${token}`, JSON.stringify({ uid, tool: s, args: coerced }), { expirationTtl: 300 }); } catch { /* best-effort */ }
      try { await this.env.TOKENS.put(`dynw:cm:pending:${runId}`, JSON.stringify({ tool: s, human_summary: human, args_digest: JSON.stringify(coerced).slice(0, 300), confirm_token: token }), { expirationTtl: 300 }); } catch { /* best-effort */ }
      throw new Error("needs_confirm");
    }

    ledger = { n: ledger.n + 1, tools: [...ledger.tools, s].slice(0, 24) };
    try { await this.env.TOKENS.put(lkey, JSON.stringify(ledger), { expirationTtl: 300 }); } catch { /* best-effort */ }

    const r = await executeTool(this.env, uid, s, coerced);
    try { this.ctx.waitUntil(track(this.env, uid, "dyn_codemode_tool", "avaapps", { tool: s, run_id: runId, ok: !(r && (r.successful === false || r.error)) })); } catch { /* best-effort */ }
    return trimToolResultForModel(s, r);
  }
}

export class DynBrain extends WorkerEntrypoint<Env> {
  private get p(): DynBrainProps {
    const p = (this.ctx as unknown as { props?: DynBrainProps }).props;
    if (!p || typeof p.uid !== "string" || !p.uid || typeof p.guardrailCapability !== "string" || !p.guardrailCapability) {
      throw new Error(`${CAP_DENIED}: no scope`);
    }
    return p;
  }

  /**
   * Search the caller's OWN consented Brain. Returns snippet lines only.
   * Fail-closed at four gates; every denial is a telemetry event.
   */
  async search(query: string, topK = 5): Promise<{ lines: string[]; source: MemoryResult["source"] }> {
    const { uid, guardrailCapability } = this.p;
    const deny = async (reason: string): Promise<never> => {
      // waitUntil, not a bare void: un-awaited Q_ANALYTICS sends are cancelled
      // when the RPC returns (see hooks.ts track() header) — observed on the
      // first staging acceptance run (dyn_worker_run landed, dyn_brain_denied didn't).
      try { this.ctx.waitUntil(track(this.env, uid, "dyn_brain_denied", "avatok", { reason, guardrail: guardrailCapability })); } catch { /* best-effort */ }
      throw new Error(`${CAP_DENIED}: ${reason}`);
    };
    const cfg = await readConfig(this.env);
    if (!cfg.dynamicWorkersEnabled) await deny("master_flag_off");
    if (!cfg.dynAvaBrainContextEnabled) await deny("brain_context_flag_off");
    if (!(await consentAllows(this.env, uid, ["master", guardrailCapability]))) await deny("consent_off");
    const q = String(query).slice(0, 512);
    const k = Math.min(Math.max(1, Math.trunc(Number(topK) || 5)), 10);
    const res = await brainSearchTyped(this.env, uid, q, k);
    return { lines: res.lines, source: res.source };
  }
}
