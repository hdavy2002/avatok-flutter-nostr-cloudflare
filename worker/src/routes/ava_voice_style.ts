// [AVA-VOICE-STYLE-1] / WS-14c — "how Ava speaks" per-user preference API.
//
//   GET /api/ava/voice-style  → getAvaVoiceStyle  — the caller's own style
//   PUT /api/ava/voice-style  → putAvaVoiceStyle  — set (or reset) it
//
// Both are dual-auth (requireUser → Clerk-verified uid), and the uid scopes
// EVERYTHING: the D1 row PK and the KV mirror key are both keyed on it, so a
// user can only read/write their OWN preference. Parent + each child account on
// a shared phone are fully isolated (Rulebook per-account scoping).
//
// Modelled line-for-line on routes/auto_responder.ts, the one proven pattern in
// this repo for a server-readable per-user setting with a hot-path read.
//
// The STORAGE + the hot-path read deliberately live in lib/ava_persona.ts, not
// here: composio.ts, ava_odl.ts and do/ava_agent.ts all need to read this value
// on the turn path, and `lib/` importing a route module is the wrong direction.
// This file is only the HTTP shell + validation + telemetry.
//
// This route file is intentionally SEPARATE from routes/api.ts (do not add these
// to api.ts) — mount them from worker/src/index.ts.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { trackUserContact } from "../hooks";
import { contactFor } from "../lib/identity";
import {
  AVA_VOICE_STYLES, AVA_VOICE_STYLE_LABELS,
  normalizeStyle, styleToCode, styleClause,
  readVoiceStyle, writeVoiceStyle, clearVoiceStyle, defaultVoiceStyle,
  type AvaVoiceStyle,
} from "../lib/ava_persona";

/** The option list the settings UI renders. Server-owned so adding a style
 *  later does not need a client release to become selectable. */
function options(): Array<{ id: AvaVoiceStyle; code: number; label: string }> {
  return AVA_VOICE_STYLES.map((id) => ({ id, code: styleToCode(id), label: AVA_VOICE_STYLE_LABELS[id] }));
}

/**
 * GET /api/ava/voice-style
 *
 * → { ok, style, styleCode, source, defaultStyle, defaultStyleCode, options }
 *
 *   style        — what Ava will actually use for this user right now
 *   source       — "user" when the user has an explicit stored preference,
 *                  "default" when they are following the platform default.
 *                  The client needs this to show "Default (Hinglish)" rather
 *                  than pretending the user chose it.
 *   defaultStyle — the platform default (prod KV `avaVoiceStyleDefault`).
 */
export async function getAvaVoiceStyle(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const [style, fallback] = await Promise.all([
    readVoiceStyle(env, ctx.uid),
    defaultVoiceStyle(env),
  ]);
  // `readVoiceStyle` already layers user → platform default, so "did the user
  // choose this?" is answered by whether a stored row exists at all. One cheap
  // extra KV get rather than a second code path that could disagree with the
  // hot-path resolver.
  let stored: AvaVoiceStyle | null = null;
  try { stored = normalizeStyle(await env.TOKENS.get("avast:style:" + ctx.uid)); } catch { /* best-effort */ }
  if (!stored) {
    try {
      const r = await env.DB_META.prepare(
        "SELECT style FROM ava_voice_style_settings WHERE uid=?1",
      ).bind(ctx.uid).first<{ style?: unknown }>();
      stored = r ? normalizeStyle(r.style) : null;
    } catch { /* table may not be migrated yet → treat as no preference */ }
  }

  return json({
    ok: true,
    style, styleCode: styleToCode(style),
    source: stored ? "user" : "default",
    defaultStyle: fallback, defaultStyleCode: styleToCode(fallback),
    options: options(),
  });
}

/**
 * PUT /api/ava/voice-style
 *
 * Body: { style: "en"|"hi"|"hinglish"|"auto"|"default" }  — or { styleCode: 0..3 }
 *   "default" (or null) CLEARS the preference so the user follows the platform
 *   default again. Anything else unrecognised is a 400 rather than a silent
 *   fallback: a typo'd style that silently "succeeds" is how a settings screen
 *   ends up lying to the user about what it saved.
 *
 * → { ok, style, styleCode, source }
 */
export async function putAvaVoiceStyle(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const raw = b?.style ?? b?.styleCode ?? b?.voice_style;
  const reset = raw === null || raw === "" || raw === undefined
    || (typeof raw === "string" && raw.trim().toLowerCase() === "default");

  const prev = await readVoiceStyle(env, ctx.uid);
  let style: AvaVoiceStyle;
  if (reset) {
    await clearVoiceStyle(env, ctx.uid);
    style = await defaultVoiceStyle(env);
  } else {
    const parsed = normalizeStyle(raw);
    if (!parsed) {
      return json({ error: "bad style", allowed: AVA_VOICE_STYLES }, 400);
    }
    await writeVoiceStyle(env, ctx.uid, parsed);
    style = parsed;
  }

  // Telemetry (WS-14f) — `ava_voice_style_set`, lowercase snake_case
  // <subject>_<verb-past>, the `autoresponder_enabled` shape. The client emits
  // the same event name with `client: true`; trackUserContact stamps the server
  // envelope (account_id, app_name, service_name, worker: true).
  //
  // ⚠️ AWAITED, not `void`-ed. workerd drops unawaited telemetry on early-return
  // paths, and an event that "isn't in the taxonomy" is almost always this.
  // ⚠️ CLAUDE.md: new telemetry MUST carry the user's email (and phone when
  // known) — with many testers it is the only way to tell whose device a report
  // came from. contactFor is a cheap cached lookup; a failure must never fail
  // the user's save, so it is wrapped.
  try {
    const { email, phone } = await contactFor(env, ctx.uid).catch(() => ({ email: null, phone: null }));
    await trackUserContact(env, ctx.uid, email, phone, "ava_voice_style_set", "avaai", {
      style, style_code: styleToCode(style),
      previous_style: prev, reset,
      source: reset ? "default" : "user",
    });
  } catch { /* best-effort — never fail a settings save on telemetry */ }

  return json({ ok: true, style, styleCode: styleToCode(style), source: reset ? "default" : "user" });
}

// Re-exported so index.ts (or a future debug route) can echo the exact clause a
// user's turns are getting, without importing two modules.
export { styleClause };
