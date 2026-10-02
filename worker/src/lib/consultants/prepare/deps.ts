// [AUMFE-CONSULT-W2-1 2026-10-02] The one seam between the card builders and AstrologyAPI, so builders are unit-testable.
import type { Env } from "../../../types";
import { astroCall, geoLookup, tzoneFor } from "../../astrology";
import type { AstroHost, AstroResult, AstroTtl } from "../../astrology";

export type AstroCaller = (path: string, body: Record<string, unknown>, ttl: AstroTtl, host?: AstroHost) => Promise<AstroResult<any>>;
export interface PrepDeps {
  call: AstroCaller;
  geo: (place: string) => Promise<{ lat: number; lon: number } | null>;
  tzone: (lat: number, lon: number, ddmmyyyy: string) => Promise<number | null>;
}

export function realDeps(env: Env, uid: string): PrepDeps {
  return {
    call: (path, body, ttl, host) => astroCall<any>(env, path, body, { ttl, uid, ...(host ? { host } : {}) }),
    geo: async (place) => {
      const g = await geoLookup(env, place, 1, uid);
      return g.ok && g.data.length ? { lat: g.data[0].lat, lon: g.data[0].lon } : null;
    },
    tzone: async (lat, lon, date) => {
      const z = await tzoneFor(env, lat, lon, date, uid);
      return z.ok ? z.data : null;
    },
  };
}

export const short = (e: string): string => (e === "astro_not_configured" ? "AstrologyAPI is not configured" : e.slice(0, 120));
