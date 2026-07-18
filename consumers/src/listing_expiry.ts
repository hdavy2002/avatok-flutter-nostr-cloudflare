// PLAN §5 — marketplace listing-expiry LIFECYCLE (notify T−3d, expire T, archive
// T+30d). Until now expiry was filtered at QUERY time only (browse/search carry
// `expires_at IS NULL OR expires_at > now`, listings.ts:1008,1122) and there was
// NO cron — so nobody was ever told a listing was about to lapse, and expired
// rows sat "published" forever. Billing needs a real clock: this sweep runs on
// the 6-hour cron tick and is cheap, bounded, idempotent, and re-runnable.
//
// Design decisions (see the handover / report):
//   • Marketplace kinds only (sell/buy/social). Creator services (live_event/
//     consult) are time-bound differently and settle via money_sweep — never
//     touched here (mirrors MARKET_KINDS in worker/src/routes/listings.ts:59).
//   • T (expire) sets NO new status. The client already treats
//     `status='published' AND expires_at < now` as "Expired" (archived_screen.dart
//     _label / _isArchived) and hides it from browse + My Listings via expires_at.
//     `expires_at` IS the source of truth for expiry, so the resting expired state
//     stays 'published'. Adding an 'expired' status would break the client (no such
//     value in its vocabulary — it would render the raw string), and reusing
//     'cancelled' at T would MISLABEL a naturally-expired listing as owner-"Removed".
//   • T+30d (archive) is the ONE status flip: published → 'cancelled'. That is the
//     client's terminal "archived/removed" state (still shown in Archived, still
//     Restore-able → draft). It is NOT a hard delete — the record and its media
//     survive; permanent delete stays an explicit owner action ("Delete forever").
//     The flip also makes the archive step self-terminating (rows drop out of the
//     scan once status≠'published'), i.e. idempotent.
//   • No config-flag read is plumbed into consumers, so the sweep is gated by being
//     a NO-OP when there is nothing to do: every query is `status='published' AND
//     kind IN (marketplace) AND expires_at IS NOT NULL AND …`. When the marketplace
//     is dark there are no such rows, so a run costs 2-3 indexed D1 reads and writes
//     nothing — safe to fire on every cadence.
import type { Env } from "./types";
import { notifyUser } from "./notify";

const MS_DAY = 86_400_000;
const WARN_BEFORE = 3 * MS_DAY;      // T−3d approaching-expiry notice
const ARCHIVE_AFTER = 30 * MS_DAY;   // T+30d final archive
const LIMIT = 200;                   // per phase per run; a backlog drains across ticks
const MARKET_KINDS_SQL = "('sell','buy','social')";

/** email_hash for telemetry (raw email is never stored server-side; PostHog maps
 *  uid→person via the client's setUserKeys, so uid + email_hash is pullable by the
 *  owner's email). Mirrors ownerEmail() in auto_reply.ts. */
async function ownerEmailHash(env: Env, uid: string): Promise<string | null> {
  try {
    const r = await env.DB_META.prepare("SELECT email_hash FROM users WHERE uid=?1 LIMIT 1").bind(uid).first<{ email_hash: string | null }>();
    return r?.email_hash ?? null;
  } catch { return null; }
}

async function track(env: Env, uid: string, event: string, props: Record<string, unknown>): Promise<void> {
  try {
    await env.Q_ANALYTICS?.send({ event, uid, ts: Date.now(),
      props: { ...props, app_name: "avatok", service_name: "avatok-consumers", worker: true, account_id: uid } });
  } catch { /* best-effort */ }
}

export interface ExpirySweepResult { notified: number; expiredNow: number; archived: number; }

export async function sweepListingExpiry(env: Env): Promise<ExpirySweepResult> {
  const out: ExpirySweepResult = { notified: 0, expiredNow: 0, archived: 0 };
  if (!env.DB_META) return out;
  const now = Date.now();
  const db = env.DB_META;

  // ── Phase A — T−3d approaching-expiry notice ────────────────────────────────
  // Published marketplace listings whose expiry falls in the next 3 days. For each
  // we notify the owner ONCE per expiry window. Dedup uses the notifications feed
  // itself (no schema change / KV needed): a prior notice for the same
  // (listing_id, phase, expires_at) means we already warned this window. Because a
  // renewal recomputes `expires_at` to a fresh absolute value (listings.ts:709),
  // the new window has a different expires_at and DOES get its own warning.
  try {
    const due = await db.prepare(
      `SELECT id, creator_id, title, expires_at FROM listings
        WHERE status='published' AND kind IN ${MARKET_KINDS_SQL}
          AND expires_at IS NOT NULL AND expires_at > ?1 AND expires_at <= ?2
        LIMIT ${LIMIT}`,
    ).bind(now, now + WARN_BEFORE).all().catch(() => ({ results: [] as any[] }));
    for (const r of (due.results ?? []) as any[]) {
      const uid = String(r.creator_id);
      const id = String(r.id);
      const expAt = Number(r.expires_at);
      const seen = await db.prepare(
        `SELECT 1 FROM notifications
          WHERE uid=?1 AND type='listing'
            AND json_extract(data,'$.listing_id')=?2
            AND json_extract(data,'$.phase')='expiry_soon'
            AND json_extract(data,'$.expires_at')=?3
          LIMIT 1`,
      ).bind(uid, id, expAt).first().catch(() => null);
      if (seen) continue; // already warned this window — idempotent
      await notifyUser(env, uid, {
        type: "listing",
        title: "Your listing expires in 3 days",
        body: `"${String(r.title ?? "Your listing").slice(0, 60)}" expires soon. Renew it for another 30 days to keep it live.`,
        data: { listing_id: id, phase: "expiry_soon", expires_at: expAt, deeplink: `/explore/listing/${id}` },
      });
      out.notified++;
      const emailHash = await ownerEmailHash(env, uid);
      await track(env, uid, "listing_expiry_notified", { listing_id: id, expires_at: expAt, days_left: Math.max(0, Math.round((expAt - now) / MS_DAY)), email_hash: emailHash });
    }
  } catch (e) { console.error("[listing-expiry:notify]", String(e)); }

  // ── Phase B — T (expire) ────────────────────────────────────────────────────
  // No write: an expired marketplace listing rests at `status='published' AND
  // expires_at < now`. Browse/search (expires_at filter), My Listings (isExpired
  // filter) and Archived ("Expired" label) already honour that state client-side —
  // flipping status here would only mislabel it (see file header). We emit a
  // read-only count for observability so "how many are sitting expired, unrenewed"
  // is visible without a per-row write (which would need its own dedup marker).
  try {
    const c = await db.prepare(
      `SELECT COUNT(*) AS n FROM listings
        WHERE status='published' AND kind IN ${MARKET_KINDS_SQL}
          AND expires_at IS NOT NULL AND expires_at < ?1`,
    ).bind(now).first<{ n: number }>().catch(() => ({ n: 0 }));
    out.expiredNow = Number(c?.n ?? 0);
  } catch (e) { console.error("[listing-expiry:count]", String(e)); }

  // ── Phase C — T+30d (archive) ───────────────────────────────────────────────
  // Marketplace listings expired for 30+ days and never renewed → soft-archive
  // (status → 'cancelled', the client's terminal Archived/"Removed" state). NOT a
  // hard delete: the row + media survive and Restore→draft still works. The flip
  // is self-terminating (rows leave the scan once status≠'published'), so the step
  // is idempotent. Search/browse already excluded them via expires_at, so no FTS
  // touch is needed. Bounded via SELECT+IN (SQLite UPDATE has no LIMIT on D1).
  try {
    const stale = await db.prepare(
      `SELECT id FROM listings
        WHERE status='published' AND kind IN ${MARKET_KINDS_SQL}
          AND expires_at IS NOT NULL AND expires_at < ?1
        LIMIT ${LIMIT}`,
    ).bind(now - ARCHIVE_AFTER).all().catch(() => ({ results: [] as any[] }));
    const ids = (stale.results ?? []).map((r: any) => String(r.id));
    if (ids.length) {
      const placeholders = ids.map((_, i) => `?${i + 2}`).join(",");
      const res = await db.prepare(
        `UPDATE listings SET status='cancelled', updated_at=?1 WHERE id IN (${placeholders})`,
      ).bind(now, ...ids).run();
      out.archived = res.meta?.changes ?? ids.length;
      for (const id of ids) await track(env, "system", "listing_archived_expired", { listing_id: id });
    }
  } catch (e) { console.error("[listing-expiry:archive]", String(e)); }

  return out;
}
