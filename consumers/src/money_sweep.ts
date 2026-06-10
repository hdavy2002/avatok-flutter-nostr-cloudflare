// Phase 7 — minute-cron money SWEEP. The session DOs fire alarm-precise
// Q_MONEY jobs; this sweep is the safety net that catches missed alarms and
// settles ended sessions. It only ENQUEUES — the engine (avatok-api consumes
// money-settlements) makes every decision and is idempotent, so the sweep can
// re-run forever without double-refunding. A (session, phase) that has been
// decided leaves a `<sid>:<phase>` marker in settlement_log and drops out of
// these queries.
import type { Env } from "./types";

const GRACE_MS = 2 * 60_000;
const LIMIT = 50; // per tick per query — backlog drains across ticks

async function waitMin(env: Env): Promise<number> {
  try {
    const r = await env.DB_META.prepare("SELECT params FROM refund_rules WHERE id='R1'").first<{ params: string }>();
    return Number(JSON.parse(r?.params ?? "{}").wait_min ?? 20) || 20;
  } catch { return 20; }
}

export async function moneySweep(env: Env): Promise<number> {
  if (!env.Q_MONEY) return 0;
  const now = Date.now();
  const wait = (await waitMin(env)) * 60_000;
  let n = 0;

  const enqueue = async (sid: string, kind: string, phase: string) => {
    await env.Q_MONEY!.send({ type: "evaluate", sid, kind, phase });
    n++;
  };

  // Consult no-show checks (start+wait passed, still-held order, undecided).
  const cn = await env.DB_META.prepare(
    `SELECT DISTINCT b.id FROM bookings b JOIN orders o ON o.id=b.order_id
      WHERE o.status='held' AND b.starts_at + ?1 < ?2
        AND NOT EXISTS (SELECT 1 FROM settlement_log s WHERE s.id = b.id || ':noshow')
      LIMIT ${LIMIT}`,
  ).bind(wait, now).all().catch(() => ({ results: [] as any[] }));
  for (const r of (cn.results ?? []) as any[]) await enqueue(String(r.id), "consult", "noshow");

  // Consult end-of-slot settlements.
  const ce = await env.DB_META.prepare(
    `SELECT DISTINCT b.id FROM bookings b JOIN orders o ON o.id=b.order_id
      WHERE o.status='held' AND b.ends_at + ?1 < ?2
        AND NOT EXISTS (SELECT 1 FROM settlement_log s WHERE s.id = b.id || ':end')
      LIMIT ${LIMIT}`,
  ).bind(GRACE_MS, now).all().catch(() => ({ results: [] as any[] }));
  for (const r of (ce.results ?? []) as any[]) await enqueue(String(r.id), "consult", "end");

  // Live events: no-show window passed.
  const ln = await env.DB_META.prepare(
    `SELECT DISTINCT l.id FROM listings l JOIN orders o ON o.listing_id=l.id
      WHERE l.kind='live_event' AND o.status='held' AND l.starts_at + ?1 < ?2
        AND NOT EXISTS (SELECT 1 FROM settlement_log s WHERE s.id = l.id || ':noshow')
      LIMIT ${LIMIT}`,
  ).bind(wait, now).all().catch(() => ({ results: [] as any[] }));
  for (const r of (ln.results ?? []) as any[]) await enqueue(String(r.id), "live_event", "noshow");

  // Live events: slot over → settle.
  const le = await env.DB_META.prepare(
    `SELECT DISTINCT l.id FROM listings l JOIN orders o ON o.listing_id=l.id
      WHERE l.kind='live_event' AND o.status='held'
        AND l.starts_at + COALESCE(l.duration_min,60)*60000 + ?1 < ?2
        AND NOT EXISTS (SELECT 1 FROM settlement_log s WHERE s.id = l.id || ':end')
      LIMIT ${LIMIT}`,
  ).bind(GRACE_MS, now).all().catch(() => ({ results: [] as any[] }));
  for (const r of (le.results ?? []) as any[]) await enqueue(String(r.id), "live_event", "end");

  // Cancelled orders whose engine pass was lost (cancel routes enqueue directly;
  // this is pure backstop).
  const cc = await env.DB_META.prepare(
    `SELECT o.id, o.booking_id, o.listing_id, o.kind FROM orders o
      WHERE o.status='held' AND o.cancelled_by IS NOT NULL AND o.cancelled_at < ?1
      LIMIT ${LIMIT}`,
  ).bind(now - 5 * 60_000).all().catch(() => ({ results: [] as any[] }));
  for (const r of (cc.results ?? []) as any[]) {
    const consult = !!r.booking_id || r.kind === "consult";
    await env.Q_MONEY!.send({ type: "cancel", sid: String(r.booking_id ?? r.listing_id), kind: consult ? "consult" : "live_event", orderId: String(r.id) });
    n++;
  }
  return n;
}
