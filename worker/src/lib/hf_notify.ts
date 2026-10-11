// [HF-CALLS-1 / HF-NOTIFY-DELIVERY-1] Notify-me is a one-shot subscription, not a caller queue.
// An offline host's online transition materializes every eligible subscription into the existing
// paced whatsapp_outbox. Provider I/O happens only in runWhatsAppOutboxDrain (scheduled cron).
import type { Env } from "../types";
import { json, sha256Hex } from "../util";
import { requireUser, isFail } from "../authz";
import { track, trackException } from "../hooks";
import { BRAND, brandUrl } from "./brand";
import { verifiedWhatsAppNumber } from "./whatsapp_notify";
import { hfCallsOn } from "./hf_reviews";
import { NOTIFY_WINDOW_MS, firstNameOf } from "./hf_reviews_pure";

const APP = BRAND.slug;
const SAFETY_SWEEP_LIMIT = 200;
const TRANSITION_PAGE_SIZE = 200;
const err = (status: number, error: string, message?: string) => json({ error, message: message ?? error }, status);

type NotifyCandidate = {
  caller_uid: string;
  host_uid: string;
  created_at: number;
  display_name: string | null;
  slug: string;
};

export type HfNotifyMaterializeResult = {
  scanned: number;
  queued: number;
  deferred: number;
  skipped: number;
  failed: number;
};

const drop = (env: Env, callerUid: string, hostUid: string) =>
  env.DB_META.prepare("DELETE FROM hf_notify WHERE caller_uid=?1 AND host_uid=?2").bind(callerUid, hostUid).run();

/** Stable outbox identity for exactly this one-shot subscription. */
async function outboxIdentity(row: Pick<NotifyCandidate, "host_uid" | "caller_uid" | "created_at">): Promise<{ checkoutId: string; urlHash: string }> {
  const digest = await sha256Hex(`hf_notify\n${row.host_uid}\n${row.caller_uid}\n${row.created_at}`);
  return { checkoutId: `hf-${digest.slice(0, 24)}`, urlHash: digest.slice(24, 40) };
}

async function materializeCandidate(env: Env, row: NotifyCandidate, now: number): Promise<"queued" | "duplicate" | "deferred" | "skipped" | "failed"> {
  try {
    const id = await outboxIdentity(row);
    // Recovery after an interruption between INSERT and subscription cleanup: prove the exact
    // deterministic outbox row exists, then finish terminating the one-shot subscription.
    const exact = await env.DB_META.prepare(
      "SELECT 1 AS x FROM whatsapp_outbox WHERE checkout_id=?1 AND kind='hf_notify' AND url_hash=?2 LIMIT 1",
    ).bind(id.checkoutId, id.urlHash).first();
    if (exact) { await drop(env, row.caller_uid, row.host_uid); return "duplicate"; }

    // Preserve the original once-per-24h scope: one caller + one host. A fresh subscription made
    // inside that window waits (it is not dropped) and the cron materializer picks it up later.
    const recent = await env.DB_META.prepare(
      `SELECT status, COALESCE(sent_at,created_at) AS delivered_at FROM whatsapp_outbox
        WHERE kind='hf_notify' AND uid=?1 AND listing_id=?2
          AND (status='queued' OR COALESCE(sent_at,created_at)>?3)
        ORDER BY COALESCE(sent_at,created_at) DESC LIMIT 1`,
    ).bind(row.caller_uid, row.host_uid, now - NOTIFY_WINDOW_MS).first<{ status: string; delivered_at: number }>();
    if (recent) {
      await env.DB_META.prepare("UPDATE hf_notify SET notified_at=?3 WHERE caller_uid=?1 AND host_uid=?2")
        .bind(row.caller_uid, row.host_uid, Number(recent.delivered_at)).run();
      return "deferred";
    }

    // Privacy gates are deliberately silent. A block in either direction or a removed verified
    // WhatsApp number terminates the one-shot subscription without creating a delivery artifact.
    const blocked = await env.DB_META.prepare(
      "SELECT 1 AS x FROM hf_blocks WHERE (blocker_uid=?1 AND blocked_uid=?2) OR (blocker_uid=?2 AND blocked_uid=?1)",
    ).bind(row.caller_uid, row.host_uid).first();
    if (blocked) { await drop(env, row.caller_uid, row.host_uid); return "skipped"; }
    const e164 = await verifiedWhatsAppNumber(env, row.caller_uid);
    if (!e164) { await drop(env, row.caller_uid, row.host_uid); return "skipped"; }

    const name = firstNameOf(row.display_name);
    const message = `${name} is online now on ${BRAND.name}. Call: ${brandUrl("/h/" + row.slug)}`;
    const inserted = await env.DB_META.prepare(
      `INSERT OR IGNORE INTO whatsapp_outbox
        (checkout_id, uid, listing_id, kind, url_hash, e164, message, status, attempts, created_at, updated_at)
       VALUES (?1,?2,?3,'hf_notify',?4,?5,?6,'queued',0,?7,?7)`,
    ).bind(id.checkoutId, row.caller_uid, row.host_uid, id.urlHash, e164, message, now).run();

    // Insert first, then terminate. If execution stops between these statements, the safety sweep
    // observes the subscription again, INSERT OR IGNORE proves the outbox row, then cleans it up.
    await drop(env, row.caller_uid, row.host_uid);
    if (inserted.meta?.changes) {
      await track(env, row.caller_uid, "hf_notify_queued", APP, {
        host_uid: row.host_uid,
        subscription_created_at: row.created_at,
        channel: "whatsapp",
      }).catch(() => undefined);
      return "queued";
    }
    return "duplicate";
  } catch (cause) {
    await track(env, row.caller_uid, "hf_notify_failed", APP, {
      host_uid: row.host_uid,
      subscription_created_at: row.created_at,
      stage: "materialize",
      retryable: true,
    }).catch(() => undefined);
    await trackException(env, cause, {
      uid: row.caller_uid,
      route: "hf_notify.materialize",
      handled: true,
      app_name: APP,
      extra: { area: "hf_notify", host: row.host_uid },
    }).catch(() => undefined);
    return "failed";
  }
}

async function materializeRows(env: Env, rows: NotifyCandidate[], now: number): Promise<HfNotifyMaterializeResult> {
  const out: HfNotifyMaterializeResult = { scanned: rows.length, queued: 0, deferred: 0, skipped: 0, failed: 0 };
  for (const row of rows) {
    const status = await materializeCandidate(env, row, now);
    if (status === "queued") out.queued++;
    else if (status === "deferred") out.deferred++;
    else if (status === "skipped") out.skipped++;
    else if (status === "failed") out.failed++;
  }
  return out;
}

/**
 * Materialize ALL eligible subscriptions for one offline -> online transition. Pagination is by
 * the immutable subscription key, not by a delivery cap, so recipient 26+ is never stranded.
 * No WhatsApp/FCM provider call occurs here.
 */
export async function notifyHostOnline(env: Env, ctx: ExecutionContext | undefined, hostUid: string): Promise<void> {
  void ctx;
  const now = Date.now();
  let cursorCreated = -1;
  let cursorCaller = "";
  try {
    if (!(await hfCallsOn(env))) return;
    for (;;) {
      const rows = (await env.DB_META.prepare(
        `SELECT n.caller_uid, n.host_uid, n.created_at, h.display_name, h.slug
           FROM hf_notify n JOIN hf_hosts h ON h.uid=n.host_uid
          WHERE n.host_uid=?1 AND h.status='live' AND h.presence='online'
            AND (n.created_at>?2 OR (n.created_at=?2 AND n.caller_uid>?3))
            AND (n.notified_at IS NULL OR n.notified_at<=?4)
            AND NOT EXISTS (
              SELECT 1 FROM whatsapp_outbox w
               WHERE w.kind='hf_notify' AND w.uid=n.caller_uid AND w.listing_id=n.host_uid
                 AND w.status IN ('queued','sending')
            )
          ORDER BY n.created_at, n.caller_uid LIMIT ?5`,
      ).bind(hostUid, cursorCreated, cursorCaller, now - NOTIFY_WINDOW_MS, TRANSITION_PAGE_SIZE).all<NotifyCandidate>()).results ?? [];
      if (!rows.length) break;
      await materializeRows(env, rows, now);
      const last = rows[rows.length - 1];
      cursorCreated = Number(last.created_at);
      cursorCaller = last.caller_uid;
      if (rows.length < TRANSITION_PAGE_SIZE) break;
    }
  } catch (cause) {
    await trackException(env, cause, {
      route: "hf_notify.notifyHostOnline",
      handled: true,
      app_name: APP,
      extra: { area: "hf_notify", host: hostUid },
    }).catch(() => undefined);
  }
}

/** Bounded cron safety net for subscriptions missed by an interrupted online transition. */
export async function runHfNotifyMaterializer(env: Env, limit = SAFETY_SWEEP_LIMIT, now = Date.now()): Promise<HfNotifyMaterializeResult> {
  if (!(await hfCallsOn(env))) return { scanned: 0, queued: 0, deferred: 0, skipped: 0, failed: 0 };
  const rows = (await env.DB_META.prepare(
    `SELECT n.caller_uid, n.host_uid, n.created_at, h.display_name, h.slug
       FROM hf_notify n JOIN hf_hosts h ON h.uid=n.host_uid
      WHERE h.status='live' AND h.presence='online'
        AND (n.notified_at IS NULL OR n.notified_at<=?1)
        AND NOT EXISTS (
          SELECT 1 FROM whatsapp_outbox w
           WHERE w.kind='hf_notify' AND w.uid=n.caller_uid AND w.listing_id=n.host_uid
             AND w.status IN ('queued','sending')
        )
      ORDER BY n.created_at, n.host_uid, n.caller_uid LIMIT ?2`,
  ).bind(now - NOTIFY_WINDOW_MS, Math.max(1, Math.min(SAFETY_SWEEP_LIMIT, limit))).all<NotifyCandidate>()).results ?? [];
  return materializeRows(env, rows, now);
}

export async function hfNotifyRoute(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
  void ctx;
  const p = new URL(req.url).pathname;
  const m = p.match(/^\/api\/hf\/hosts\/([a-z0-9-]{3,40})\/notify$/);
  if (!m) return null;
  if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") return err(405, "method_not_allowed");
  try {
    if (!(await hfCallsOn(env))) return err(404, "not_enabled");
    const u = await requireUser(req, env);
    if (isFail(u)) return err(u.status, u.error);
    const host = await env.DB_META.prepare("SELECT uid FROM hf_hosts WHERE slug=?1 AND status='live'").bind(m[1]).first<{ uid: string }>();
    if (!host) return err(404, "not_found", "Host not found.");
    if (req.method === "GET") {
      const r = await env.DB_META.prepare("SELECT 1 AS x FROM hf_notify WHERE caller_uid=?1 AND host_uid=?2").bind(u.uid, host.uid).first();
      return json({ subscribed: !!r });
    }
    if (req.method === "DELETE") {
      await drop(env, u.uid, host.uid);
      return json({ ok: true, subscribed: false });
    }
    if (host.uid === u.uid) return err(409, "own_profile", "You can't follow your own profile.");
    if (!(await verifiedWhatsAppNumber(env, u.uid))) return err(403, "not_verified", "Verify your WhatsApp number first.");
    await env.DB_META.prepare("INSERT OR REPLACE INTO hf_notify (caller_uid, host_uid, created_at, notified_at) VALUES (?1,?2,?3,NULL)").bind(u.uid, host.uid, Date.now()).run();
    void track(env, u.uid, "hf_notify_subscribed", APP, {});
    return json({ ok: true, subscribed: true });
  } catch (cause) {
    await trackException(env, cause, { route: p, method: req.method, handled: true, app_name: APP, extra: { area: "hf_notify" } });
    return err(500, "internal_error");
  }
}
