// vertex.ts — [VERTEX-1] Google Vertex AI (aiplatform.googleapis.com) as the
// transport for our REST Gemini calls, replacing the AI-Studio Developer API
// (generativelanguage.googleapis.com + GEMINI_API_KEY).
//
// WHY (owner decision 2026-08-17): AvaTOK is being built for the Indian market at
// ~1M users. The Developer API is quota-limited per key and was already returning
// ~15% errors in the console; Vertex is the surface with production quota,
// provisioned throughput and enterprise data terms. Billing does NOT change — both
// AI-Studio keys are already service accounts inside project avatok-avaglobal
// (ais-gemini-key-…@…), so this is a transport/quota move, not a billing move.
//
// ── WHAT IS DELIBERATELY *NOT* MIGRATED ─────────────────────────────────────
// The Live (bidi WebSocket) lanes stay on generativelanguage.googleapis.com. This
// is a Google product gap, not an oversight — verified in Model Garden inside
// avatok-avaglobal on 2026-08-17:
//   • Vertex lists exactly ONE live model, gemini-live-2.5-flash-native-audio.
//     We run gemini-3.1-flash-live-preview.
//   • Vertex has NO live speech-translation model at all. Our
//     gemini-3.5-live-translate-preview (call translation + in-app translation,
//     incl. the native Android client) has no Vertex equivalent. Moving it would
//     DELETE the feature.
//   • Vertex Live has no ephemeral-token equivalent, so phones could not connect
//     directly — every call's audio would have to be relayed through this Worker.
//   • Vertex Live has no asia-* region (US/EU only) — worse latency for India.
// So: routes/ava_live.ts, avavoice.ts, avavision.ts (live), translate.ts,
// call_translation.ts, do/reception_room.ts (socket) and do/vobiz_agent_room.ts
// keep their current path. Do NOT "finish the migration" by moving them.
//
// File Search / RAG stores (lib/ava_rag.ts and the four routes that create stores)
// also stay: they are a Developer-API-only product, and the Vertex equivalent
// (RAG Engine) would mean re-uploading every user's existing knowledge base.
//
// ── SAFETY CONTRACT ─────────────────────────────────────────────────────────
// generateContentVia() NEVER hard-fails to Vertex. If Vertex is unconfigured, the
// token mint fails, or Vertex returns a non-2xx (e.g. a model id that exists on
// the Developer API but not on Vertex), it transparently retries the SAME body on
// generativelanguage.googleapis.com. There is no local Flutter/worker build here
// and CI is a 40–80 min round trip, so a wrong model name must not be able to take
// production down. Every call reports which transport served it (`via`) so the
// switch can be proven from telemetry rather than assumed.
//
// Kill switch: unset VERTEX_PROJECT in wrangler.toml and redeploy → every call
// falls back to the previous behaviour, byte-for-byte.

import { accessTokenFor, type ServiceAccount } from "./google_tts";

const DEV_BASE = "https://generativelanguage.googleapis.com/v1beta";

export interface VertexEnv {
  VERTEX_PROJECT?: string;
  VERTEX_LOCATION?: string;
  GOOGLE_TTS_SA_JSON?: string;
  GEMINI_API_KEY?: string;
  GOOGLE_API_KEY?: string;
}

/** Which transport actually served a call — emit this in telemetry. */
export type GoogleVia = "vertex" | "devapi";

/** Vertex is usable only when we have BOTH a project and the service-account JSON
 *  (the same GOOGLE_TTS_SA_JSON the Hindi WaveNet voice already uses). */
export function vertexConfigured(env: VertexEnv): boolean {
  return Boolean(env?.VERTEX_PROJECT && env?.GOOGLE_TTS_SA_JSON);
}

/** `global` is the default: it is the highest-availability Gemini endpoint on
 *  Vertex and avoids pinning to a single region's capacity. Override with
 *  VERTEX_LOCATION (e.g. asia-south1) only if data residency demands it — a
 *  regional endpoint has strictly lower capacity than global. */
function location(env: VertexEnv): string {
  return env.VERTEX_LOCATION || "global";
}

/** Regional endpoints are host-prefixed; `global` is not. */
function host(loc: string): string {
  return loc === "global" ? "aiplatform.googleapis.com" : `${loc}-aiplatform.googleapis.com`;
}

/** Model ids that differ between the Developer API and Vertex. Anything not listed
 *  is passed through unchanged (the Gemini text/vision ids are identical on both).
 *  Verified against Model Garden in avatok-avaglobal, 2026-08-17: Vertex publishes
 *  "Gemini 2.5 Flash TTS" / "Gemini 3.1 Flash TTS Preview" — i.e. WITHOUT the
 *  Developer API's `-preview-` infix. Getting this wrong is not fatal (the call
 *  falls back to the Developer API) but it silently forfeits the quota win, so
 *  keep this table honest. */
const MODEL_ALIASES: Record<string, string> = {
  "gemini-2.5-flash-preview-tts": "gemini-2.5-flash-tts",
  "gemini-2.5-pro-preview-tts": "gemini-2.5-pro-tts",
};

export function vertexModelId(model: string): string {
  return MODEL_ALIASES[model] ?? model;
}

function vertexUrl(env: VertexEnv, model: string, method: string): string {
  const loc = location(env);
  return `https://${host(loc)}/v1/projects/${env.VERTEX_PROJECT}/locations/${loc}` +
    `/publishers/google/models/${vertexModelId(model)}:${method}`;
}

/** Bearer for aiplatform.googleapis.com, minted from the SAME service account and
 *  the SAME in-isolate cache as Cloud TTS (scope cloud-platform covers both).
 *  Returns null on any failure so the caller falls back rather than throwing. */
export async function vertexToken(env: VertexEnv): Promise<string | null> {
  try {
    const raw = env.GOOGLE_TTS_SA_JSON;
    if (!raw) return null;
    const sa = JSON.parse(raw) as ServiceAccount;
    if (!sa.client_email || !sa.private_key) return null;
    return await accessTokenFor(sa);
  } catch { return null; }
}

export interface GoogleCallResult {
  ok: boolean;
  status: number;
  out: any;
  via: GoogleVia;
}

export interface GoogleCallOpts {
  /** Per-request Gemini key (BYO user key via X-Ava-Gemini-Key, or a feature-scoped
   *  key such as RECEPTIONIST_GEMINI_API_KEY). When present the Developer API is
   *  used DIRECTLY and Vertex is skipped — a user's own key must bill to them, and
   *  a feature-scoped key exists precisely to keep that spend separable. */
  apiKey?: string;
  timeoutMs?: number;
  /** Skip Vertex for this call (used by paths pinned to the Developer API). */
  forceDevApi?: boolean;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs?: number) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  const out: any = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, out };
}

/**
 * The single chokepoint for REST Gemini calls. Tries Vertex, falls back to the
 * Developer API on ANY Vertex failure. Never throws on a non-2xx — the caller
 * decides strict-throw vs soft-ladder, exactly as before.
 *
 * `method` is the verb suffix: "generateContent", "streamGenerateContent",
 * "embedContent", "predict".
 */
export async function generateContentVia(
  env: VertexEnv,
  model: string,
  body: unknown,
  method = "generateContent",
  opts: GoogleCallOpts = {},
): Promise<GoogleCallResult> {
  const useVertex = !opts.forceDevApi && !opts.apiKey && vertexConfigured(env);

  if (useVertex) {
    const token = await vertexToken(env);
    if (token) {
      try {
        const r = await postJson(
          vertexUrl(env, model, method),
          { authorization: `Bearer ${token}` },
          body,
          opts.timeoutMs,
        );
        if (r.ok) return { ...r, via: "vertex" };
        // Non-2xx from Vertex (unknown model on this surface, quota, region): fall
        // through to the Developer API rather than surfacing an outage.
      } catch { /* network/timeout — fall through */ }
    }
  }

  const key = opts.apiKey || env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  if (!key) return { ok: false, status: 401, out: { error: { message: "google api key missing" } }, via: "devapi" };
  const r = await postJson(
    `${DEV_BASE}/models/${model}:${method}`,
    { "x-goog-api-key": key },
    body,
    opts.timeoutMs,
  );
  return { ...r, via: "devapi" };
}
