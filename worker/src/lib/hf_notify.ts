// [HF-CALLS-1] Notify-me: a busy/offline host shows "Notify me"; when the host goes online each subscriber gets ONE WhatsApp
// (at most one per subscriber per 24 h), then the subscription is removed (they can subscribe again). No queue.
//   notifyHostOnline(env, ctx, hostUid)      called by the calls agent from PUT /api/hosts/me/presence {online:true}
//   GET|POST|DELETE /api/hf/hosts/:slug/notify    (signed in; POST needs a verified WhatsApp) -> { subscribed } / { ok, subscribed } / { ok, subscribed:false }
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { track, trackException } from "../hooks";
import { BRAND, brandUrl } from "./brand";
import { sendWhatsAppText } from "./whatsapp_send";
import { verifiedWhatsAppNumber } from "./whatsapp_notify";
import { hfCallsOn } from "./hf_reviews";
import { NOTIFY_WINDOW_MS, firstNameOf } from "./hf_reviews_pure";

const APP = BRAND.slug;
const err = (status: number, error: string, message?: string) => json({ error, message: message ?? error }, status);
/** WasenderAPI is an unofficial gateway: never burst. One send per second, and a bounded batch per invocation (leftovers stay subscribed). */
const SEND_GAP_MS = 1000;
const MAX_PER_RUN = 25;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function notifyHostOnline(env: Env, ctx: ExecutionContext | undefined, hostUid: string): Promise<void> {
  const work = (async () => {
    try {
      const host = await env.DB_META.prepare("SELECT display_name, slug FROM hf_hosts WHERE uid=?1").bind(hostUid).first<{ display_name: string | null; slug: string | null }>();
      if (!host?.slug) return;
      const now = Date.now();
      // Candidates: never notified, or last notified > 24 h ago (a row kept after a transient send failure).
      const rows = (await env.DB_META.prepare(
        "SELECT caller_uid FROM hf_notify WHERE host_uid=?1 AND (notified_at IS NULL OR notified_at <= ?2) ORDER BY created_at LIMIT ?3",
      ).bind(hostUid, now - NOTIFY_WINDOW_MS, MAX_PER_RUN).all<{ caller_uid: string }>()).results ?? [];
      const name = host.display_name?.trim() || firstNameOf(host.display_name);
      const text = `${name} is online now on ${BRAND.name}. Call: ${brandUrl("/h/" + host.slug)}`;
      let sent = 0;
      for (const r of rows) {
        // Claim atomically so two concurrent runs (host toggling quickly) cannot both message the same subscriber.
        const claim = await env.DB_META.prepare(
          "UPDATE hf_notify SET notified_at=?3 WHERE caller_uid=?1 AND host_uid=?2 AND (notified_at IS NULL OR notified_at <= ?4)",
        ).bind(r.caller_uid, hostUid, now, now - NOTIFY_WINDOW_MS).run();
        if (!claim.meta?.changes) continue;
        // Blocked either way: drop silently, never reveal why.
        const blocked = await env.DB_META.prepare(
          "SELECT 1 AS x FROM hf_blocks WHERE (blocker_uid=?1 AND blocked_uid=?2) OR (blocker_uid=?2 AND blocked_uid=?1)",
        ).bind(r.caller_uid, hostUid).first().catch(() => null);
        const e164 = blocked ? null : await verifiedWhatsAppNumber(env, r.caller_uid);
        if (!e164) { await drop(env, r.caller_uid, hostUid); continue; }
        const res = await sendWhatsAppText(env, e164, text);
        if (res.ok || res.reason === "not_on_whatsapp") await drop(env, r.caller_uid, hostUid);
        else await env.DB_META.prepare("UPDATE hf_notify SET notified_at=NULL WHERE caller_uid=?1 AND host_uid=?2").bind(r.caller_uid, hostUid).run(); // transient: stay subscribed
        if (res.ok) sent++;
        await sleep(SEND_GAP_MS);
      }
      if (rows.length) void track(env, hostUid, "hf_notify_sent", APP, { count: sent });
    } catch (e) {
      await trackException(env, e, { route: "hf_notify.notifyHostOnline", handled: true, app_name: APP, extra: { area: "hf_notify", host: hostUid } });
    }
  })();
  if (ctx) ctx.waitUntil(work); else await work;
}

const drop = (env: Env, callerUid: string, hostUid: string) =>
  env.DB_META.prepare("DELETE FROM hf_notify WHERE caller_uid=?1 AND host_uid=?2").bind(callerUid, hostUid).run();

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
  } catch (e) {
    await trackException(env, e, { route: p, method: req.method, handled: true, app_name: APP, extra: { area: "hf_notify" } });
    return err(500, "internal_error");
  }
}
