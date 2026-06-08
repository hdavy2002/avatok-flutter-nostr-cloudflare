// /api/brain/* — thin auth + router to the caller's UserBrain DO. Every route is
// dual-auth (NIP-98 + Clerk when enabled); npub comes from the signature, so a
// user can only ever reach their OWN brain. The DO does the real work.
import type { Env } from "../types";
import { json } from "../util";
import { authenticate, isErr } from "../auth";

async function toBrain(env: Env, npub: string, payload: Record<string, unknown>): Promise<Response> {
  const stub = env.USER_BRAIN.get(env.USER_BRAIN.idFromName(npub));
  const res = await stub.fetch("https://brain/op", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ npub, ...payload }),
  });
  // Pass the DO's JSON straight through (adds CORS via json()).
  const data = await res.json().catch(() => ({ error: "brain error" }));
  return json(data, res.status);
}

export async function brain(req: Request, env: Env, op: string): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const npub = auth.npub;

  // --- consent toggles (server-readable booleans; default ON when a row is absent) ---
  if (op === "consent") {
    if (req.method === "GET") {
      const rs = await env.DB_BRAIN.prepare("SELECT capability, enabled FROM brain_consent WHERE npub=?1").bind(npub).all();
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
        `INSERT INTO brain_consent (npub, capability, enabled, updated_at) VALUES (?1,?2,?3,?4)
         ON CONFLICT(npub, capability) DO UPDATE SET enabled=?3, updated_at=?4`,
      ).bind(npub, cap, en ? 1 : 0, now)));
    return json({ ok: true });
  }

  // Reads (GET) carry no body.
  if (op === "entities" || op === "timeline") return toBrain(env, npub, { op });

  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  switch (op) {
    case "ask": return toBrain(env, npub, { op, question: b.question });
    case "briefing": return toBrain(env, npub, { op });
    case "remember": return toBrain(env, npub, { op, facts: b.facts, entities: b.entities });
    case "investigate": return toBrain(env, npub, { op, complaint: b.complaint });
    case "forget": return toBrain(env, npub, { op, entity_id: b.entity_id });
    default: return json({ error: "unknown brain op" }, 404);
  }
}
