// [AUMFE-ASTRO-CLIENT-1] Place -> coordinates -> timezone offset, the two lookups every natal call needs.
import type { Env } from "../../types";
import { astroCall, type AstroResult } from "./client";

export interface GeoPlace { place_name: string; lat: number; lon: number; timezone_id: string; country_code: string }

/** geo_details: free-text place -> candidate places. Cached forever (places do not move). */
export async function geoLookup(env: Env, place: string, maxRows = 5, uid?: string): Promise<AstroResult<GeoPlace[]>> {
  const r = await astroCall<any>(env, "geo_details", { place: place.trim(), maxRows }, { ttl: "forever", uid });
  if (!r.ok) return r;
  const rows: any[] = Array.isArray(r.data) ? r.data : (Array.isArray(r.data?.geonames) ? r.data.geonames : []);
  return {
    ok: true,
    data: rows.map((g) => ({
      place_name: String(g.place_name ?? g.name ?? ""),
      lat: Number(g.latitude ?? g.lat),
      lon: Number(g.longitude ?? g.lon),
      timezone_id: String(g.timezone_id ?? ""),
      country_code: String(g.country_code ?? ""),
    })).filter((g) => Number.isFinite(g.lat) && Number.isFinite(g.lon)),
  };
}

/** timezone_with_dst: UTC offset in hours (e.g. 5.5) for a place on a date. `date` is "DD-MM-YYYY". Cached forever. */
export async function tzoneFor(
  env: Env, lat: number, lon: number, date: string, uid?: string,
): Promise<AstroResult<number>> {
  const r = await astroCall<any>(env, "timezone_with_dst", { latitude: lat, longitude: lon, date }, { ttl: "forever", uid });
  if (!r.ok) return r;
  const tz = Number(r.data?.timezone ?? r.data);
  return Number.isFinite(tz) ? { ok: true, data: tz } : { ok: false, error: "astro_bad_response", status: 200 };
}
