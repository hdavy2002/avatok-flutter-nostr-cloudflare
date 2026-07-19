// [RECEPT-STATS-1] Receptionist/Voicemail analytics API (plan §C2,
// Specs/PLAN-2026-07-19-onboarding-bonus-analytics.md).
//
//   GET /api/receptionist/analytics?days=30&tz_offset_min=330
//
// requireUser — an owner reads ONLY their own rows. All data comes from the D1
// mirror `recept_call_stats` (lib/recept_stats.ts) — never PostHog (user-facing
// analytics must not depend on PostHog query latency/limits). Retention is 90
// days, so `days` clamps to 1..90.
//
// `tz_offset_min` (minutes EAST of UTC, e.g. IST = 330) comes from the owner's
// device (Dart has no IANA tz name, only the offset) and drives the owner-LOCAL
// hour + day bucketing. Absent/invalid → UTC buckets.

import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb } from "../db/shard";
import { ensureReceptStatsTable } from "../lib/recept_stats";

interface StatsRow {
  id: string; ts: number; caller_key: string | null; caller_name: string | null;
  country: string | null; mode: string | null; transport: string | null;
  duration_s: number | null; tokens: number | null; outcome: string | null;
}

const MAX_ROWS = 10_000; // 90d of receptionist calls for one owner is far below this

export async function receptionistAnalytics(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const url = new URL(req.url);
  const days = Math.min(90, Math.max(1, Math.trunc(Number(url.searchParams.get("days")) || 30)));
  // Clamp to real-world UTC offsets (-14h..+14h).
  const rawOff = Number(url.searchParams.get("tz_offset_min"));
  const tzOffMin = Number.isFinite(rawOff) ? Math.min(840, Math.max(-840, Math.trunc(rawOff))) : 0;

  const now = Date.now();
  const since = now - days * 86_400_000;

  await ensureReceptStatsTable(env);
  let rows: StatsRow[] = [];
  try {
    const rs = await metaDb(env).prepare(
      `SELECT id, ts, caller_key, caller_name, country, mode, transport, duration_s, tokens, outcome
         FROM recept_call_stats WHERE owner_uid=?1 AND ts>=?2 ORDER BY ts DESC LIMIT ${MAX_ROWS}`,
    ).bind(ctx.uid, since).all();
    rows = (rs.results ?? []) as unknown as StatsRow[];
  } catch { rows = []; }

  // Aggregate in JS (row counts are small; one D1 query total).
  let calls = 0, seconds = 0, tokens = 0, vm = 0, agent = 0;
  const byHour = new Array<number>(24).fill(0);
  const byCountry = new Map<string, number>();
  const byDay = new Map<string, number>();
  const callers = new Map<string, { caller: string; name: string | null; count: number; seconds: number }>();

  const localDate = (ts: number): string => new Date(ts + tzOffMin * 60_000).toISOString().slice(0, 10);

  for (const r of rows) {
    calls++;
    const dur = Math.max(0, Number(r.duration_s) || 0);
    seconds += dur;
    tokens += Math.max(0, Number(r.tokens) || 0);
    if (r.mode === "vm") vm++; else agent++;
    const local = new Date(r.ts + tzOffMin * 60_000);
    byHour[local.getUTCHours() % 24]++;
    const country = (r.country || "??").toUpperCase();
    byCountry.set(country, (byCountry.get(country) ?? 0) + 1);
    const day = localDate(r.ts);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
    const key = r.caller_key || "unknown";
    const c = callers.get(key) ?? { caller: key, name: null, count: 0, seconds: 0 };
    c.count++; c.seconds += dur;
    if (!c.name && r.caller_name) c.name = r.caller_name;
    callers.set(key, c);
  }

  const topCallers = [...callers.values()]
    .sort((a, b) => b.count - a.count || b.seconds - a.seconds)
    .slice(0, 10)
    .map((c) => ({ caller: c.caller, name: c.name, count: c.count, minutes: Math.round(c.seconds / 6) / 10 }));

  const countryList = [...byCountry.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([country, count]) => ({ country, count }));

  // Daily trend: every day in the window (owner-local), zero-filled, ascending.
  const trend: Array<{ date: string; count: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = localDate(now - i * 86_400_000);
    trend.push({ date: d, count: byDay.get(d) ?? 0 });
  }

  return json({
    ok: true,
    days,
    tz_offset_min: tzOffMin,
    totals: {
      calls,
      minutes: Math.round(seconds / 6) / 10,
      tokens: Math.round(tokens * 100) / 100,
      voicemails: vm,
      agent_calls: agent,
    },
    top_callers: topCallers,
    by_country: countryList,
    by_hour: byHour,
    mode_split: { agent, vm },
    by_day: trend,
  });
}
