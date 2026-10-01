// [AUMFE-ASTRO-CLIENT-1 2026-10-01] AstrologyAPI REST client shared by the voice agents and the text chat.
// Library only: no route. Every call fails SOFT with a typed error (never throws) so a chat turn degrades
// to "I could not read the chart right now" instead of a 500. Secret: env.ASTROLOGYAPI_KEY (not set yet ->
// every call returns { ok:false, error:"astro_not_configured" }).
import type { Env } from "../../types";
import { track } from "../../hooks";
import { cacheGet, cachePut, type AstroTtl } from "./cache";
import { BRAND } from "../brand";

export const ASTRO_HOSTS = {
  json: "https://json.astrologyapi.com/v1",
  vision: "https://vision.astrologyapi.com", // pass the full "palmistry/<ep>" | "face-reading/<ep>" | "vastu/<ep>" as endpoint
} as const;
export type AstroHost = keyof typeof ASTRO_HOSTS;

export const APP = BRAND.slug;
const TIMEOUT_MS = 10_000;

export interface AstroOpts {
  host?: AstroHost;
  /** Accept-Language, only sent when given (e.g. "hi"). Part of the cache identity. */
  lang?: string;
  /** forever = natal data; day = expires at next IST midnight; none = never cached. Default none. */
  ttl?: AstroTtl;
  /** For telemetry only. */
  uid?: string;
}
export type AstroResult<T = any> = { ok: true; data: T } | { ok: false; error: string; status: number };

export async function astroCall<T = any>(
  env: Env, endpoint: string, body: Record<string, unknown> = {}, opts: AstroOpts = {},
): Promise<AstroResult<T>> {
  const t0 = Date.now();
  const uid = opts.uid ?? "system";
  const done = (r: AstroResult<T>, cached: boolean): AstroResult<T> => {
    // track() is itself best-effort and never throws; we do not await it (no ctx here).
    void track(env, uid, "astro_api_call", APP, {
      endpoint, cached, ms: Date.now() - t0, ok: r.ok, status: r.ok ? 200 : r.status,
      ...(r.ok ? {} : { error: r.error }),
    });
    return r;
  };

  const key = env.ASTROLOGYAPI_KEY;
  if (!key) return done({ ok: false, error: "astro_not_configured", status: 0 }, false);

  const ttl = opts.ttl ?? "none";
  // Language changes the text of the answer, so it must be part of the cache identity.
  const cacheBody = opts.lang ? { ...body, __lang: opts.lang } : body;
  const hit = await cacheGet<T>(env, endpoint, cacheBody, ttl);
  if (hit !== null) return done({ ok: true, data: hit }, true);

  const base = ASTRO_HOSTS[opts.host ?? "json"];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/${endpoint.replace(/^\/+/, "")}`, {
      method: "POST",
      headers: {
        "x-astrologyapi-key": key,
        "Content-Type": "application/json",
        ...(opts.lang ? { "Accept-Language": opts.lang } : {}),
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body is reported below as astro_bad_response */ }
    // The API reports some failures as 200 + {status:false, error_msg|msg}.
    if (!res.ok || (json && json.status === false)) {
      const msg = String(json?.error_msg ?? json?.msg ?? json?.error ?? `http_${res.status}`);
      return done({ ok: false, error: msg, status: res.status }, false);
    }
    if (json === null) return done({ ok: false, error: "astro_bad_response", status: res.status }, false);
    await cachePut(env, endpoint, cacheBody, ttl, json);
    return done({ ok: true, data: json as T }, false);
  } catch (e) {
    const aborted = (e as { name?: string })?.name === "AbortError";
    return done({ ok: false, error: aborted ? "astro_timeout" : "astro_network", status: 0 }, false);
  } finally {
    clearTimeout(timer);
  }
}
