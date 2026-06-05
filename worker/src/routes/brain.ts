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
