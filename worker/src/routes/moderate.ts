// moderate.ts — POST /api/moderate. The save-time validation endpoint the client
// calls (debounced) to decide whether to enable a Save button. The verdict here is
// UX only; every write route ALSO re-checks server-side (see Specs §4.2).
//
// Engine: nvidia/nemotron-3.5-content-safety:free via OpenRouter (lib/moderation.ts).
// Rich telemetry: every check emits a PostHog event stamped with the user's email
// AND the request-origin country/region/city (Cloudflare `req.cf`) for analytics +
// diagnosis.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { moderate, namePlausible, firstUnsafe, type ModField } from "../lib/moderation";
import { trackUser } from "../hooks";
import { emailFor } from "../lib/identity";

// Only a real person NAME gets the no-digits plausibility gate. Handles allow
// digits/underscores (already regex-validated), and creative AI/agent/persona
// names (e.g. "Ava 2.0") are safety-checked but not name-format-gated.
const NAME_FIELDS: ModField[] = ["name"];

function geoOf(req: Request): Record<string, unknown> {
  const cf = (req as any).cf || {};
  return {
    country: cf.country ?? null,
    region: cf.region ?? null,
    city: cf.city ?? null,
    continent: cf.continent ?? null,
    colo: cf.colo ?? null,
    timezone: cf.timezone ?? null,
  };
}

// POST /api/moderate  { text, field_type?, locale? }
//   → { verdict: "allow"|"block", safe, categories, reason }
export async function moderateText(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const b = (await req.json().catch(() => ({}))) as any;
  const text = String(b.text ?? "").trim();
  const field = (String(b.field_type ?? b.field ?? "generic")) as ModField;
  const locale = b.locale ? String(b.locale) : undefined;
  const geo = geoOf(req);

  if (!text) return json({ verdict: "allow", safe: true, categories: [], reason: "" });

  // Name/handle fields: cheap LOCAL plausibility first (no model spend for the
  // obvious "that's not a name" case), then the safety model.
  if (NAME_FIELDS.includes(field) && !namePlausible(text)) {
    void trackUser(env, ctx.uid, await emailFor(env, ctx.uid), "moderation_check", "moderation", {
      field, verdict: "block", reason: "name_implausible", engine: "local", text_len: text.length, ...geo,
    });
    return json({ verdict: "block", safe: false, categories: ["name_format"], reason: "That doesn't look like a real name. Please use your name." });
  }

  const r = await moderate(env, { text, field, locale });
  const verdict = r.safe ? "allow" : "block";

  void trackUser(env, ctx.uid, await emailFor(env, ctx.uid), "moderation_check", "moderation", {
    field, verdict, categories: r.categories, classifier_ms: r.ms, classifier_ok: r.ok,
    engine: "nemotron-3.5-content-safety", text_len: text.length, ...geo,
  });

  return json({ verdict, safe: r.safe, categories: r.categories, reason: r.reason });
}

/**
 * Server-side save-time backstop for write routes. Checks the given fields and,
 * if any is unsafe, emits a telemetry block event (email + geo) and returns a 422
 * Response the caller should return directly. Returns null when everything's clean.
 *
 *   const blocked = await guardWrite(req, env, ctx.uid, "receptionist", [
 *     { text: instr, field: "prompt" }, { text: display, field: "name" }, ...
 *   ]);
 *   if (blocked) return blocked;
 */
export async function guardWrite(
  req: Request,
  env: Env,
  uid: string,
  app: string,
  fields: Array<{ text?: string | null; field: ModField }>,
): Promise<Response | null> {
  const bad = await firstUnsafe(env, fields);
  if (!bad) return null;
  void trackUser(env, uid, await emailFor(env, uid), "moderation_block", app, {
    field: bad.field, categories: bad.result.categories, reason: bad.result.reason,
    engine: bad.result.ms ? "nemotron-3.5-content-safety" : "local",
    server_side: true, ...geoOf(req),
  });
  // `message` mirrors `reason` so clients that render the user-facing string from
  // `message` (e.g. the Flutter profile screen) show the DETAILED reason instead of
  // a generic fallback. `error` is kept for back-compat. `categories` lets the client
  // prefix what was flagged (e.g. "flagged: sexual").
  return json(
    {
      ok: false,
      moderation: "unsafe",
      field: bad.field,
      categories: bad.result.categories,
      error: bad.result.reason,
      message: bad.result.reason,
    },
    422,
  );
}
