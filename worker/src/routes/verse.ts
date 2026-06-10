// Phase 8 — AvaVerse: the creator's bird's-eye dashboard (PHASE-08.md).
// AGGREGATION ONLY — no new money/listing stores. Sources:
//   • DB_WALLET wallet_ledger + earning_holds  → earnings (settled / pending / payout-able)
//   • DB_META listings / bookings / orders     → projections, momentum, top events
//   • DB_META creator_profiles / fanout_log    → reach + announce quota (A1)
//   • DB_META reviews (reply cols, Phase 8)    → reviews-to-reply + public reply
//   • PostHog query API (HogQL)                → audience funnel, write-through cached
//     into verse_snapshots (daily) so the screen opens instantly (<1 s criterion)
// Summary is KV-cached per user+period (60 s TTL).
//
// Routes (all auth):
//   GET  /api/verse/summary?period=today|7d|30d|all
//   POST /api/verse/announce {listing_id, message?}        A1 — notify followers
//   GET  /api/verse/statement?month=YYYY-MM&format=csv|json[&email=1]   A2
//   POST /api/reviews/:id/reply {body}                     public review reply
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb, metaSession } from "../db/shard";
import { track, brainFact } from "../hooks";
import { notifyUser } from "../notify";
import { fanout } from "./listings";
import { clerkEmail } from "../ledger";

const APP = "avaverse";
const FEE = 0.20;                  // 80/20 split (§4) — keep in sync with ledger.PLATFORM_FEE_RATE
const FANOUT_DAILY_CAP = 2;        // shared with listings.ts auto-fan-out
const SUMMARY_TTL_S = 60;          // KV cache
const SNAPSHOT_MAX_AGE_MS = 24 * 3600_000;

const net = (gross: number) => Math.round(gross * (1 - FEE));
const dayUtc = (t: number) => new Date(t).toISOString().slice(0, 10);

function periodStart(period: string, now: number): number {
  if (period === "today") { const d = new Date(now); d.setUTCHours(0, 0, 0, 0); return d.getTime(); }
  if (period === "7d") return now - 7 * 86400_000;
  if (period === "30d") return now - 30 * 86400_000;
  return 0; // all
}

// ---------------------------------------------------------------------------
// GET /api/verse/summary
// ---------------------------------------------------------------------------
export async function verseSummary(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = ctx.uid;
  const u = new URL(req.url).searchParams;
  const period = ["today", "7d", "30d", "all"].includes(u.get("period") || "") ? u.get("period")! : "7d";

  const ck = `verse:${uid}:${period}`;
  if (u.get("fresh") !== "1") {
    try { const hit = await env.TOKENS.get(ck, "json"); if (hit) return json({ ...(hit as object), cached: true }); } catch { /* miss */ }
  }

  const now = Date.now();
  const since = periodStart(period, now);
  const acct = `user:${uid}`;
  const meta = metaSession(env);
  const wallet = env.DB_WALLET;

  // ---- earnings (wallet_ledger is the truth; escrow_release amounts are NET,
  //      donation credits are GROSS with the fee as a separate debit row) ----
  const [settledIn, feesOut, paidOut, holds, todayIn, ydayIn] = await Promise.all([
    wallet.prepare("SELECT COALESCE(SUM(amount),0) AS v FROM wallet_ledger WHERE credit=?1 AND type IN ('escrow_release','donation') AND created_at>=?2")
      .bind(acct, since).first<{ v: number }>(),
    wallet.prepare("SELECT COALESCE(SUM(amount),0) AS v FROM wallet_ledger WHERE debit=?1 AND type='fee' AND created_at>=?2")
      .bind(acct, since).first<{ v: number }>(),
    wallet.prepare("SELECT COALESCE(SUM(amount),0) AS v FROM wallet_ledger WHERE debit=?1 AND type='payout'")
      .bind(acct).first<{ v: number }>(),
    wallet.prepare("SELECT COALESCE(SUM(CASE WHEN released=0 THEN amount ELSE 0 END),0) AS maturing, COALESCE(SUM(CASE WHEN released=1 THEN amount ELSE 0 END),0) AS matured FROM earning_holds WHERE uid=?1")
      .bind(uid).first<{ maturing: number; matured: number }>(),
    wallet.prepare("SELECT COALESCE(SUM(amount),0) AS v FROM wallet_ledger WHERE credit=?1 AND type IN ('escrow_release','donation') AND created_at>=?2")
      .bind(acct, periodStart("today", now)).first<{ v: number }>(),
    wallet.prepare("SELECT COALESCE(SUM(amount),0) AS v FROM wallet_ledger WHERE credit=?1 AND type IN ('escrow_release','donation') AND created_at>=?2 AND created_at<?3")
      .bind(acct, periodStart("today", now) - 86400_000, periodStart("today", now)).first<{ v: number }>(),
  ]);
  const pendingEscrow = await meta.prepare(
    "SELECT COALESCE(SUM(amount),0) AS v FROM orders WHERE creator_id=?1 AND status='held'",
  ).bind(uid).first<{ v: number }>();

  // ---- projections: per upcoming event joined × price × 0.8; today's consults ----
  const upcoming = await meta.prepare(
    `SELECT id, title, starts_at, duration_min, price, joined_count, status FROM listings
      WHERE creator_id=?1 AND kind='live_event' AND status IN ('published','live') AND starts_at>?2
      ORDER BY starts_at ASC LIMIT 10`,
  ).bind(uid, now).all();
  const projections = ((upcoming.results ?? []) as any[]).map((l) => ({
    listing_id: l.id, title: l.title, starts_at: l.starts_at, status: l.status,
    joined: Number(l.joined_count), price: Number(l.price),
    projected_net: net(Number(l.joined_count) * Number(l.price)),
  }));
  const dayStart = periodStart("today", now);
  const consultToday = await meta.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(price),0) AS gross FROM bookings
      WHERE creator_id=?1 AND kind LIKE 'consult%' AND status='confirmed' AND starts_at>=?2 AND starts_at<?3`,
  ).bind(uid, dayStart, dayStart + 86400_000).first<{ n: number; gross: number }>();

  // ---- momentum: joins in the last 24 h per event (+ delta vs previous 24 h) ----
  const [mom, mom24, momPrev] = await Promise.all([
    meta.prepare(
      `SELECT b.listing_id, COUNT(*) AS joins_24h, l.title, l.joined_count, l.starts_at
         FROM bookings b JOIN listings l ON l.id=b.listing_id
        WHERE b.creator_id=?1 AND b.created_at>?2 AND b.status IN ('confirmed','completed')
        GROUP BY b.listing_id ORDER BY joins_24h DESC LIMIT 5`,
    ).bind(uid, now - 86400_000).all(),
    meta.prepare("SELECT COUNT(*) AS n FROM bookings WHERE creator_id=?1 AND created_at>?2 AND status IN ('confirmed','completed')")
      .bind(uid, now - 86400_000).first<{ n: number }>(),
    meta.prepare("SELECT COUNT(*) AS n FROM bookings WHERE creator_id=?1 AND created_at>?2 AND created_at<=?3 AND status IN ('confirmed','completed')")
      .bind(uid, now - 2 * 86400_000, now - 86400_000).first<{ n: number }>(),
  ]);

  // ---- top events by revenue / joins (period-scoped) ----
  const top = await meta.prepare(
    `SELECT l.id, l.title, l.kind, l.status, l.joined_count, l.rating_avg,
            COALESCE(SUM(o.amount),0) AS revenue, COUNT(o.id) AS orders
       FROM orders o JOIN listings l ON l.id=o.listing_id
      WHERE o.creator_id=?1 AND o.status IN ('held','released','free') AND o.created_at>=?2
      GROUP BY l.id ORDER BY revenue DESC, orders DESC LIMIT 5`,
  ).bind(uid, since).all();

  // ---- audience: followers (D1) + funnel/countries (PostHog via snapshot) ----
  const prof = await meta.prepare("SELECT follower_count FROM creator_profiles WHERE user_id=?1").bind(uid).first<any>();
  const audience = await audienceSnapshot(env, uid, now);

  // ---- reviews to reply (Phase 8 reply cols) ----
  const reviews = await meta.prepare(
    `SELECT r.id, r.listing_id, r.author_id, r.rating, r.body, r.created_at, l.title AS listing_title,
            u.display_name AS author_name, u.avatar_url AS author_avatar
       FROM reviews r JOIN listings l ON l.id=r.listing_id LEFT JOIN users u ON u.uid=r.author_id
      WHERE r.creator_id=?1 AND r.reply IS NULL ORDER BY r.created_at DESC LIMIT 10`,
  ).bind(uid).all();

  // ---- reach + A1 announce quota + auto-suggest nudges ----
  const fo = await meta.prepare("SELECT count FROM fanout_log WHERE creator_id=?1 AND day=?2").bind(uid, dayUtc(now)).first<{ count: number }>();
  const quotaLeft = Math.max(0, FANOUT_DAILY_CAP - (fo?.count ?? 0));
  // Nudge: event <24 h away with joins below the creator's average joins/event.
  const avgJoins = projections.length ? projections.reduce((s, p) => s + p.joined, 0) / projections.length : 0;
  const nudges = projections
    .filter((p) => p.starts_at - now < 86400_000 && p.joined < avgJoins && quotaLeft > 0)
    .map((p) => ({ kind: "remind_followers", listing_id: p.listing_id, title: p.title, starts_at: p.starts_at, joined: p.joined }));

  const out = {
    period, generated_at: now,
    earnings: {
      settled: Number(settledIn?.v ?? 0) - Number(feesOut?.v ?? 0),
      pending_escrow_net: net(Number(pendingEscrow?.v ?? 0)),
      maturing: Number(holds?.maturing ?? 0),                              // 7-day hold, not yet payable
      payoutable: Math.max(0, Number(holds?.matured ?? 0) - Number(paidOut?.v ?? 0)),
      paid_out_total: Number(paidOut?.v ?? 0),
      today: Number(todayIn?.v ?? 0),
      delta_vs_yesterday: Number(todayIn?.v ?? 0) - Number(ydayIn?.v ?? 0), // "morning feel"
    },
    projections: {
      events: projections,
      consult_today: { sessions: Number(consultToday?.n ?? 0), projected_net: net(Number(consultToday?.gross ?? 0)) },
    },
    momentum: {
      joins_24h: Number(mom24?.n ?? 0),
      delta_vs_prev_24h: Number(mom24?.n ?? 0) - Number(momPrev?.n ?? 0),
      by_event: mom.results ?? [],
    },
    top_events: top.results ?? [],
    audience: { followers: Number(prof?.follower_count ?? 0), ...audience },
    reviews_to_reply: reviews.results ?? [],
    reach: { followers: Number(prof?.follower_count ?? 0), announce_quota_left: quotaLeft, announce_daily_cap: FANOUT_DAILY_CAP },
    nudges,
  };
  try { await env.TOKENS.put(ck, JSON.stringify(out), { expirationTtl: SUMMARY_TTL_S }); } catch { /* best-effort */ }
  track(env, uid, "verse_summary_viewed", APP, { period });
  return json(out);
}

// Audience funnel via PostHog HogQL, write-through cached in verse_snapshots
// (daily) — a warm open never waits on PostHog. Missing key/project → nulls.
async function audienceSnapshot(env: Env, uid: string, now: number): Promise<{ views: number | null; opens: number | null; joins: number | null; top_countries: { code: string; n: number }[]; snapshot_day: string | null }> {
  const empty = { views: null, opens: null, joins: null, top_countries: [] as { code: string; n: number }[], snapshot_day: null as string | null };
  try {
    const row = await metaSession(env).prepare("SELECT day, data, updated_at FROM verse_snapshots WHERE uid=?1").bind(uid).first<any>();
    if (row && now - Number(row.updated_at) < SNAPSHOT_MAX_AGE_MS) {
      return { ...empty, ...JSON.parse(String(row.data)), snapshot_day: String(row.day) };
    }
    const key = env.POSTHOG_PERSONAL_API_KEY;
    if (!key) return row ? { ...empty, ...JSON.parse(String(row.data)), snapshot_day: String(row.day) } : empty;
    const host = env.POSTHOG_QUERY_HOST || "https://us.posthog.com";
    const project = env.POSTHOG_PROJECT_ID || "";
    const safe = uid.replace(/[^A-Za-z0-9_-]/g, "");
    const hogql = `SELECT event, count() AS n FROM events
      WHERE event IN ('listing_viewed','listing_opened','booking_created','listing_booked')
        AND (properties.creator_id = '${safe}' OR properties.creator = '${safe}')
        AND timestamp > now() - INTERVAL 30 DAY GROUP BY event`;
    const countries = `SELECT properties.$geoip_country_code AS code, count() AS n FROM events
      WHERE event IN ('listing_viewed','listing_opened')
        AND (properties.creator_id = '${safe}' OR properties.creator = '${safe}')
        AND timestamp > now() - INTERVAL 30 DAY GROUP BY code ORDER BY n DESC LIMIT 5`;
    const run = async (q: string): Promise<any[]> => {
      const r = await fetch(`${host}/api/projects/${project}/query/`, {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: { kind: "HogQLQuery", query: q } }),
      });
      if (!r.ok) throw new Error(`posthog ${r.status}`);
      return ((await r.json()) as any).results ?? [];
    };
    const [funnel, geo] = await Promise.all([run(hogql), run(countries)]);
    const by: Record<string, number> = {};
    for (const [event, n] of funnel) by[String(event)] = Number(n);
    const data = {
      views: by.listing_viewed ?? 0,
      opens: by.listing_opened ?? 0,
      joins: (by.booking_created ?? 0) + (by.listing_booked ?? 0),
      top_countries: geo.filter((g: any[]) => g[0]).map((g: any[]) => ({ code: String(g[0]), n: Number(g[1]) })),
    };
    const day = dayUtc(now);
    await metaDb(env).prepare(
      "INSERT INTO verse_snapshots (uid, day, data, updated_at) VALUES (?1,?2,?3,?4) ON CONFLICT(uid) DO UPDATE SET day=?2, data=?3, updated_at=?4",
    ).bind(uid, day, JSON.stringify(data), now).run();
    return { ...empty, ...data, snapshot_day: day };
  } catch {
    return empty; // PostHog down ≠ dashboard down
  }
}

// ---------------------------------------------------------------------------
// POST /api/verse/announce {listing_id, message?} — A1 "Notify followers".
// Rides the SAME fanout() + fanout_log cap as auto-fan-out (shared quota).
// ---------------------------------------------------------------------------
export async function verseAnnounce(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const lid = String(b.listing_id || "");
  if (!lid) return json({ error: "listing_id required" }, 400);
  const db = metaDb(env);
  const l = await db.prepare("SELECT creator_id, title, kind, status, starts_at FROM listings WHERE id=?1").bind(lid).first<any>();
  if (!l || l.creator_id !== ctx.uid) return json({ error: "not found" }, 404);
  if (!["published", "live"].includes(String(l.status))) return json({ error: "listing not announceable", status_now: l.status }, 409);
  if (l.kind === "live_event" && l.status !== "live" && Number(l.starts_at) < Date.now()) return json({ error: "event already started" }, 409);

  const who = await db.prepare("SELECT display_name, handle FROM users WHERE uid=?1").bind(ctx.uid).first<any>();
  const name = who?.display_name || who?.handle || "An AvaTOK creator";
  const when = l.starts_at ? new Date(Number(l.starts_at)).toUTCString().slice(0, 22) : null;
  const title = `${name} invites you: ${String(l.title).slice(0, 60)}`;
  const body = b.message ? String(b.message).slice(0, 200) : (when ? `Happening ${when} — book your spot` : "Book your spot");

  const fo = await fanout(env, ctx.uid, title, body, `/explore/listing/${lid}`);
  if (fo.capped) {
    return json({ error: "daily_cap", detail: `You've already sent ${FANOUT_DAILY_CAP} announcements today — try again tomorrow.`, remaining: 0 }, 429);
  }
  const cnt = await db.prepare("SELECT count FROM fanout_log WHERE creator_id=?1 AND day=?2").bind(ctx.uid, dayUtc(Date.now())).first<{ count: number }>();
  const remaining = Math.max(0, FANOUT_DAILY_CAP - (cnt?.count ?? 0));
  brainFact(env, ctx.uid, "followers_announced", APP, { listing: lid, sent: fo.sent });
  track(env, ctx.uid, "verse_announce", APP, { listing: lid, sent: fo.sent, remaining });
  return json({ ok: true, sent: fo.sent, remaining });
}

// ---------------------------------------------------------------------------
// GET /api/verse/statement?month=YYYY-MM&format=csv|json[&email=1] — A2.
// Creator credit rows (escrow_release NET + donation GROSS w/ meta fee split);
// footer totals reconcile against the ledger by construction (same rows).
// ---------------------------------------------------------------------------
export async function verseStatement(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const u = new URL(req.url).searchParams;
  const month = u.get("month") || new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: "month=YYYY-MM required" }, 400);
  const from = Date.parse(`${month}-01T00:00:00Z`);
  const m = Number(month.slice(5, 7));
  const to = Date.parse(m === 12 ? `${Number(month.slice(0, 4)) + 1}-01-01T00:00:00Z` : `${month.slice(0, 4)}-${String(m + 1).padStart(2, "0")}-01T00:00:00Z`);

  const rs = await env.DB_WALLET.prepare(
    `SELECT id, amount, type, ref, meta, created_at FROM wallet_ledger
      WHERE credit=?1 AND type IN ('escrow_release','donation') AND created_at>=?2 AND created_at<?3
      ORDER BY created_at ASC`,
  ).bind(`user:${ctx.uid}`, from, to).all();
  const rows = (rs.results ?? []) as any[];

  // Resolve order → listing/kind in ONE chunked IN query (orders live in DB_META).
  const orderIds = [...new Set(rows.filter((r) => r.type === "escrow_release" && r.ref).map((r) => String(r.ref)))];
  const orderKind = new Map<string, { kind: string; listing_id: string }>();
  for (let i = 0; i < orderIds.length; i += 90) {
    const chunk = orderIds.slice(i, i + 90);
    const os = await metaSession(env).prepare(
      `SELECT id, kind, listing_id FROM orders WHERE id IN (${chunk.map((_, j) => `?${j + 1}`).join(",")})`,
    ).bind(...chunk).all();
    for (const o of (os.results ?? []) as any[]) orderKind.set(String(o.id), { kind: String(o.kind || ""), listing_id: String(o.listing_id || "") });
  }

  const items = rows.map((r) => {
    let meta: any = {}; try { meta = r.meta ? JSON.parse(r.meta) : {}; } catch { /* raw */ }
    const ord = orderKind.get(String(r.ref ?? ""));
    const type = r.type === "donation" ? "donation" : (ord?.kind === "consult" ? "consult" : "ticket");
    // escrow_release row amount = NET (meta carries gross/fee); donation row amount = GROSS.
    const gross = Number(meta.gross ?? r.amount);
    const fee = Number(meta.fee ?? (r.type === "donation" ? Math.round(gross * FEE) : gross - Number(r.amount)));
    const netAmt = Number(meta.net ?? (gross - fee));
    return {
      date: new Date(Number(r.created_at)).toISOString().slice(0, 10),
      type, listing: String(meta.title ?? ""), gross, platform_fee: fee, net: netAmt,
      order_id: String(r.ref ?? r.id),
    };
  });
  const totals = items.reduce((t, i) => ({ gross: t.gross + i.gross, fee: t.fee + i.platform_fee, net: t.net + i.net }), { gross: 0, fee: 0, net: 0 });
  track(env, ctx.uid, "verse_statement", APP, { month, n: items.length, format: u.get("format") || "csv" });

  if (u.get("format") === "json") return json({ month, items, totals });

  const esc = (s: string) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const usd = (c: number) => (c / 100).toFixed(2);
  const csv = [
    "date,type,listing,gross_usd,platform_fee_usd,net_usd,order_id",
    ...items.map((i) => [i.date, i.type, esc(i.listing), usd(i.gross), usd(i.platform_fee), usd(i.net), i.order_id].join(",")),
    `TOTAL,,,${usd(totals.gross)},${usd(totals.fee)},${usd(totals.net)},`,
  ].join("\n");

  if (u.get("email") === "1") {
    const email = await clerkEmail(env, ctx.uid);
    if (email) {
      const tbl = items.map((i) => `<tr><td>${i.date}</td><td>${i.type}</td><td>${i.listing}</td><td align="right">$${usd(i.gross)}</td><td align="right">$${usd(i.platform_fee)}</td><td align="right">$${usd(i.net)}</td></tr>`).join("");
      const html = `<div style="font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;padding:24px">
        <h2>AvaTok earnings statement — ${month}</h2>
        <table style="width:100%;border-collapse:collapse" border="1" cellpadding="6">
          <tr><th>Date</th><th>Type</th><th>Listing</th><th>Gross</th><th>Fee</th><th>Net</th></tr>${tbl}
          <tr><th colspan="3">Total</th><th align="right">$${usd(totals.gross)}</th><th align="right">$${usd(totals.fee)}</th><th align="right">$${usd(totals.net)}</th></tr>
        </table></div>`;
      try { await env.Q_EMAIL.send({ to: email, subject: `Your AvaTok earnings statement — ${month}`, html }); } catch { /* best-effort */ }
      return json({ ok: true, emailed: true, month, items: items.length, totals });
    }
    return json({ error: "no email on file" }, 404);
  }

  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="avatok-statement-${month}.csv"`,
      "access-control-allow-origin": "*",
    },
  });
}

// ---------------------------------------------------------------------------
// POST /api/reviews/:id/reply {body} — creator's single public reply.
// ---------------------------------------------------------------------------
export async function reviewReply(req: Request, env: Env, reviewId: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const body = String(b.body || "").trim().slice(0, 1000);
  if (!body) return json({ error: "body required" }, 400);
  const db = metaDb(env);
  const r = await db.prepare("SELECT creator_id, author_id, listing_id FROM reviews WHERE id=?1").bind(reviewId).first<any>();
  if (!r || r.creator_id !== ctx.uid) return json({ error: "not found" }, 404);
  await db.prepare("UPDATE reviews SET reply=?2, reply_at=?3 WHERE id=?1").bind(reviewId, body, Date.now()).run();
  try {
    await notifyUser(env, String(r.author_id), {
      type: "social", title: "The creator replied to your review", body: body.slice(0, 80),
      data: { deeplink: `/explore/listing/${r.listing_id}` },
    });
  } catch { /* best-effort */ }
  brainFact(env, ctx.uid, "review_replied", APP, { review: reviewId });
  track(env, ctx.uid, "review_reply_posted", APP, {});
  return json({ ok: true });
}
