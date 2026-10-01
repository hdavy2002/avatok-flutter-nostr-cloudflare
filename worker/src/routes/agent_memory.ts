// [AUMFE-AGENT-MEMORY-1] Signed-in customer's view of their agent memory. Clerk auth; every query is scoped to the
// verified uid (never a uid from the URL or body).
//   GET/PUT /api/me/astro-profile        POST /api/me/memory-consent {consent:boolean}
//   GET /api/me/memories                 DELETE /api/me/memories/:id        DELETE /api/me/memories (forget me)
//   GET /api/me/agent-sessions
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { forgetAll, forgetOne, getProfile, listMemories, listSessions, setConsent, upsertProfile } from "../lib/agent_memory";

const PROFILE_PUBLIC = (p: Awaited<ReturnType<typeof getProfile>>) =>
  p && { name: p.name, gender: p.gender, dob: p.dob, tob: p.tob, tob_unknown: !!p.tob_unknown, place: p.place, lat: p.lat, lon: p.lon,
    tzone: p.tzone, tz_id: p.tz_id, language: p.language, memory_consent: !!p.memory_consent, consent_at: p.consent_at, computed_at: p.computed_at, updated_at: p.updated_at };

export async function agentMemoryRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  const m = req.method;
  const isProfile = p === "/api/me/astro-profile";
  const isConsent = p === "/api/me/memory-consent";
  const isMem = p === "/api/me/memories";
  const memId = p.startsWith("/api/me/memories/") ? decodeURIComponent(p.slice("/api/me/memories/".length)) : null;
  const isSess = p === "/api/me/agent-sessions";
  if (!(isProfile || isConsent || isMem || memId || isSess)) return null;

  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.status === 401 ? "unauthorized" : ctx.error }, ctx.status);
  const uid = ctx.uid;
  try {
    if (isProfile && m === "GET") return json({ profile: PROFILE_PUBLIC(await getProfile(env, uid)) });
    if (isProfile && m === "PUT") {
      const text = await req.text();
      if (text.length > 4096) return json({ error: "too_large" }, 413);
      let b: unknown; try { b = JSON.parse(text || "{}"); } catch { return json({ error: "bad_json" }, 400); }
      if (!b || typeof b !== "object" || Array.isArray(b)) return json({ error: "bad_json" }, 400);
      const r = await upsertProfile(env, uid, b as Record<string, unknown>);
      return r.ok ? json({ profile: PROFILE_PUBLIC(r.profile) }) : json({ error: r.error }, 400);
    }
    if (isConsent && m === "POST") {
      const b = (await req.json().catch(() => null)) as { consent?: unknown } | null;
      if (!b || typeof b.consent !== "boolean") return json({ error: "consent_boolean_required" }, 400);
      return json({ profile: PROFILE_PUBLIC(await setConsent(env, uid, b.consent)) });
    }
    if (isMem && m === "GET") {
      const rows = await listMemories(env, uid);
      return json({ memories: rows.map((r) => ({ id: r.id, agent: r.agent, kind: r.kind, text: r.text, created_at: r.created_at })) });
    }
    if (isMem && m === "DELETE") return json({ ok: true, ...(await forgetAll(env, uid)) });
    if (memId && m === "DELETE") return (await forgetOne(env, uid, memId)) ? json({ ok: true }) : json({ error: "not_found" }, 404);
    if (isSess && m === "GET") return json({ sessions: await listSessions(env, uid) });
    return json({ error: "method_not_allowed" }, 405);
  } catch (e) {
    await trackException(env, e, { route: "agent_memory", handled: true, app_name: BRAND.slug, uid });
    return json({ error: "server_error" }, 500);
  }
}
