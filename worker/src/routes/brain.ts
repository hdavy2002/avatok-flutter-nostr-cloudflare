// /api/brain/* — thin auth + router to the caller's UserBrain DO. Every route is
// dual-auth (NIP-98 + Clerk when enabled); uid comes from the signature, so a
// user can only ever reach their OWN brain. The DO does the real work.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";

async function toBrain(env: Env, uid: string, payload: Record<string, unknown>): Promise<Response> {
  const stub = env.USER_BRAIN.get(env.USER_BRAIN.idFromName(uid));
  const res = await stub.fetch("https://brain/op", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid, ...payload }),
  });
  // Pass the DO's JSON straight through (adds CORS via json()).
  const data = await res.json().catch(() => ({ error: "brain error" }));
  return json(data, res.status);
}

export async function brain(req: Request, env: Env, op: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = ctx.uid;

  // --- consent toggles (server-readable booleans; default ON when a row is absent) ---
  if (op === "consent") {
    if (req.method === "GET") {
      const rs = await env.DB_BRAIN.prepare("SELECT capability, enabled FROM brain_consent WHERE uid=?1").bind(uid).all();
      const out: Record<string, boolean> = {};
      for (const r of (rs.results ?? []) as any[]) out[r.capability] = Number(r.enabled) === 1;
      return json({ consent: out }); // anything absent = default ON (opt-out model)
    }
    // POST { capability, enabled }  OR  { toggles: { cap: bool, ... } }
    const cb = (await req.json().catch(() => ({}))) as any;
    const entries: Array<[string, boolean]> = cb.toggles && typeof cb.toggles === "object"
      ? Object.entries(cb.toggles).map(([k, v]) => [String(k), !!v])
      : (cb.capability ? [[String(cb.capability), !!cb.enabled]] : []);
    if (!entries.length) return json({ error: "capability required" }, 400);
    const now = Date.now();
    await env.DB_BRAIN.batch(entries.map(([cap, en]) =>
      env.DB_BRAIN.prepare(
        `INSERT INTO brain_consent (uid, capability, enabled, updated_at) VALUES (?1,?2,?3,?4)
         ON CONFLICT(uid, capability) DO UPDATE SET enabled=?3, updated_at=?4`,
      ).bind(uid, cap, en ? 1 : 0, now)));
    return json({ ok: true });
  }

  // Reads (GET) carry no body.
  if (op === "entities" || op === "timeline") return toBrain(env, uid, { op });

  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  switch (op) {
    case "ask": return toBrain(env, uid, { op, question: b.question });
    case "briefing": return toBrain(env, uid, { op });
    case "remember": return toBrain(env, uid, { op, facts: b.facts, entities: b.entities });
    case "investigate": return toBrain(env, uid, { op, complaint: b.complaint });
    case "forget": return toBrain(env, uid, { op, entity_id: b.entity_id });
    default: return json({ error: "unknown brain op" }, 404);
  }
}
