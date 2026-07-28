// [DYNW-RECEPT-RULES-1] Owner API for receptionist rule scripts (WS-2).
//
//   PUT    /api/receptionist/rules   { source } — moderate, wrap, save, activate
//   GET    /api/receptionist/rules              — current status (+ own source)
//   DELETE /api/receptionist/rules              — disable
//
// Gated on dynamicWorkersEnabled + dynReceptionistRulesEnabled (403 while dark).
// The source is treated as UNTRUSTED user content: moderated via the standard
// guardWrite pipeline (field "prompt" — jailbreak/abuse rules apply) and then
// only ever executed inside the no-network dynw sandbox, scoped to the owner's
// own receptionist.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { readConfig } from "./config";
import { guardWrite } from "./moderate";
import { saveReceptRules, getReceptRules, disableReceptRules } from "../lib/dynw/recept_rules";
import { track } from "../hooks";

export async function receptRules(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: u.error }, u.status);
  const cfg = await readConfig(env);
  if (!cfg.dynamicWorkersEnabled || !cfg.dynReceptionistRulesEnabled) {
    return json({ error: "receptionist rules not enabled" }, 403);
  }

  if (req.method === "GET") {
    const row = await getReceptRules(env, u.uid);
    return json(row
      ? { active: true, code_id: row.code_id, created_at: row.created_at, source: row.source }
      : { active: false });
  }

  if (req.method === "DELETE") {
    await disableReceptRules(env, u.uid);
    ctx.waitUntil(track(env, u.uid, "recept_rules_disabled", "receptionist", {}));
    return json({ ok: true });
  }

  // PUT — save + activate.
  let b: { source?: unknown };
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const source = String(b.source ?? "");
  if (!source.trim()) return json({ error: "source required" }, 400);
  const mod = await guardWrite(req, env, u.uid, "receptionist", [{ text: source, field: "prompt" }]);
  if (mod) return mod;
  const saved = await saveReceptRules(env, u.uid, source);
  if (!saved.ok) return json({ error: saved.error }, 400);
  ctx.waitUntil(track(env, u.uid, "recept_rules_saved", "receptionist", { code_id: saved.code_id, chars: source.length }));
  return json({ ok: true, code_id: saved.code_id });
}
