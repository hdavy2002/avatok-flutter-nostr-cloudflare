// AVACALLS-002 — exact destination classification. This route deliberately
// returns only callable classification; it never returns directory identities
// or partial matches.
import type { Env } from "../types";
import { json } from "../util";
import { isFail, requireUser } from "../authz";
import { metaDb, sha256hex } from "../db/shard";
import { rateLimit } from "../money";
import { readConfig } from "./config";
import { normalizeDestination } from "../lib/telephony_numbers";

export async function avacallsResolve(req: Request, env: Env): Promise<Response> {
  const cfg = await readConfig(env);
  if (cfg.avaCallsEnabled !== true || cfg.avaCallsUniversalDialpadEnabled !== true || cfg.avaCallsAvatokResolveEnabled !== true) {
    return json({ error: "ava_calls_disabled" }, 503);
  }
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const limited = await rateLimit(env, `avacalls-resolve:${ctx.uid}`, 120, 3600);
  if (limited) return limited;
  const body = (await req.json().catch(() => ({}))) as { number?: string; region?: string };
  const destination = normalizeDestination(String(body.number ?? ""), String(body.region ?? "IN"));
  if (!destination) return json({ state: "unsupported", reason: "invalid_destination" }, 200);
  const hash = await sha256hex(destination.canonical);
  const db = metaDb(env);
  // Exact match only. `virtual_lines` is canonical; the legacy table remains a
  // compatibility fallback for existing AvaTOK identities during migration.
  const line = await db.prepare(
    `SELECT kind, display_number, country_iso2 FROM virtual_lines
       WHERE canonical_number=?1 AND number_hash=?2 AND status='active' LIMIT 1`,
  ).bind(destination.canonical, hash).first<{ kind: string; display_number: string; country_iso2: string | null }>();
  const legacy = line ? null : await db.prepare(
    `SELECT number, display, country FROM avatok_numbers WHERE number=?1 AND status='active' LIMIT 1`,
  ).bind(destination.canonical).first<{ number: string; display: string; country: string }>();
  if (line?.kind === "avatok" || legacy) {
    return json({ state: "avatok", kind: "avatok", displayNumber: line?.display_number ?? legacy?.display ?? destination.display, countryIso2: line?.country_iso2 ?? legacy?.country ?? destination.countryIso2, rateSubunitsPerMinute: 0 });
  }
  return json({ state: "pstn", kind: "pstn", displayNumber: destination.display, countryIso2: destination.countryIso2, rateSubunitsPerMinute: 500 });
}
