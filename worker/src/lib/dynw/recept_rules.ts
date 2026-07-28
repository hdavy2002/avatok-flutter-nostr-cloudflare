// [DYNW-RECEPT-RULES-1] Per-owner receptionist rule scripts (WS-2,
// Specs/PROPOSAL-DYNAMIC-WORKERS-2026-07-28.md).
//
// An owner's deterministic call rules ("my brother calls → tell him X", "sales
// call → decline") run as a sandboxed pure function BEFORE the LLM turn:
// a `say` verdict skips the LLM entirely (0 inference), a `promptAddendum`
// verdict steers it, null falls through unchanged. FAIL-OPEN EVERYWHERE — a
// broken rules script must never break a live call; the worst outcome is the
// legacy LLM-only behavior.
//
// Module contract (wrapped at save time — the stored dyn_modules source is the
// WRAPPED module, sha-verified on load): the owner/AI-authored BODY must
// `return { onTurn(payload) {...}, onCallStart(caller) {...} }` (either handler
// optional). Handlers are pure: no network (enforced by the sandbox), no
// capabilities (env is empty), ≤ ~1.5s wall clock (enforced by the host).
//
// Verdict shape (anything else → null):
//   { say?: string, end?: boolean }          → speak `say` verbatim; end the call after when `end`
//   { promptAddendum?: string }              → inject an owner rule into THIS LLM turn
import type { Env } from "../../types";
import { runDynamic } from "./host";
import { saveModule, setStatus, loadActive, type DynModuleRow } from "./registry";

const PTR_KEY = (uid: string) => `dynw:rules:recept:${uid}`;
const MAX_BODY_CHARS = 16 * 1024;

export interface RuleVerdict { say?: string; end?: boolean; promptAddendum?: string }
export interface LoadedRules { codeId: string; modules: Record<string, string> }

// String-concat wrapper (never a template literal — owner code may contain ` and ${）.
export function wrapRulesModule(body: string): string {
  return [
    "export default {",
    "  async fetch(req) {",
    "    let msg = null; try { msg = await req.json(); } catch {}",
    "    try {",
    "      const rules = await (async () => {",
    body,
    "      })();",
    "      const fn = rules && msg && rules[msg.hook];",
    "      const out = (typeof fn === \"function\") ? await fn(msg.payload) : null;",
    "      return new Response(JSON.stringify({ ok: true, out }));",
    "    } catch (e) {",
    "      return new Response(JSON.stringify({ ok: false, err: String((e && e.message) || e) }), { status: 500 });",
    "    }",
    "  }",
    "};",
  ].join("\n");
}

/** Save + activate an owner's rules body (route must moderate BEFORE calling). */
export async function saveReceptRules(
  env: Env, uid: string, body: string,
): Promise<{ ok: true; code_id: string } | { ok: false; error: string }> {
  const src = String(body ?? "").trim();
  if (!src || src.length > MAX_BODY_CHARS) return { ok: false, error: "bad_size" };
  if (/\bimport\s|\brequire\s*\(|\bexport\s/.test(src)) return { ok: false, error: "module_syntax_forbidden" };
  if (!/\breturn\b/.test(src)) return { ok: false, error: "must_return_handlers" };
  const wrapped = wrapRulesModule(src);
  const saved = await saveModule(env, { area: "recept_rules", ownerUid: uid, source: wrapped, requesterUid: uid, requesterIsAdmin: false });
  if (!saved.ok) return { ok: false, error: saved.error };
  // Owner-scoped rules affect only the owner's own receptionist; source was
  // moderated by the route → auto-advance draft→pending_review→active.
  await setStatus(env, saved.code_id, "pending_review", uid);
  await setStatus(env, saved.code_id, "active", uid);
  try { await env.TOKENS.put(PTR_KEY(uid), saved.code_id); } catch { return { ok: false, error: "pointer_write_failed" }; }
  return { ok: true, code_id: saved.code_id };
}

export async function getReceptRules(env: Env, uid: string): Promise<DynModuleRow | null> {
  let codeId: string | null = null;
  try { codeId = await env.TOKENS.get(PTR_KEY(uid)); } catch { return null; }
  if (!codeId) return null;
  const r = await loadActive(env, codeId, { requesterUid: uid });
  return r.ok ? r.row : null;
}

export async function disableReceptRules(env: Env, uid: string): Promise<void> {
  try {
    const codeId = await env.TOKENS.get(PTR_KEY(uid));
    if (codeId) await setStatus(env, codeId, "disabled", uid);
    await env.TOKENS.delete(PTR_KEY(uid));
  } catch { /* best-effort */ }
}

/** Resolve the owner's active rules for execution (null = no rules / any failure). */
export async function loadReceptRules(env: Env, uid: string): Promise<LoadedRules | null> {
  try {
    const row = await getReceptRules(env, uid);
    if (!row) return null;
    return { codeId: row.code_id, modules: { "rules.js": row.source } };
  } catch { return null; }
}

function sanitizeVerdict(v: unknown): RuleVerdict | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const out: RuleVerdict = {};
  if (typeof o.say === "string" && o.say.trim()) out.say = o.say.trim().slice(0, 400);
  if (o.end === true) out.end = true;
  if (typeof o.promptAddendum === "string" && o.promptAddendum.trim()) out.promptAddendum = o.promptAddendum.trim().slice(0, 500);
  return (out.say || out.promptAddendum) ? out : null;
}

/**
 * Evaluate one hook. FAIL-OPEN: every failure path (flags off, load error,
 * script throw, timeout, bad verdict shape) returns null and the caller
 * proceeds to the LLM exactly as before.
 */
export async function evalCallRules(
  env: Env,
  wait: ExecutionContext,
  uid: string,
  hook: "onTurn" | "onCallStart",
  payload: unknown,
  loaded: LoadedRules,
): Promise<RuleVerdict | null> {
  try {
    const run = await runDynamic<unknown>(env, wait, {
      area: "recept_rules",
      codeId: loaded.codeId,
      uid,
      modules: loaded.modules,
      mainModule: "rules.js",
      env: {},          // pure function — no capabilities
      method: "run",    // dispatch is on the JSON body's `hook`, not the path
      input: { hook, payload },
      timeoutMs: 1500,  // a live call is waiting — hard budget, then LLM as usual
    });
    if (!run.ok) return null;
    return sanitizeVerdict(run.result);
  } catch { return null; }
}
