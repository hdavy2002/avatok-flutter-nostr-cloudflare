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
      void track(this.env, uid, "dyn_brain_denied", "avatok", { reason, guardrail: guardrailCapability });
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
