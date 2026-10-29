// [HF-CALL-MODES-B] The call queue endpoints (HF-CALL-10, spec 2.5). Dark behind hfCallsEnabled + hfCallQueueEnabled: off -> 404 feature_off.
//   POST   /api/hf/hosts/:slug/queue  -> {ok, entryId, position, waiting}   errors queue_closed|queue_full|already_queued(+hostSlug)|low_balance(+shortfallPaise)|not_verified
//   DELETE /api/hf/hosts/:slug/queue  -> {ok}                                (leave any time, no message)
//   GET    /api/hf/queue/me           -> {ok, entry: null | {entryId, hostSlug, hostName, position, status, callId?}}
// The fan-side gates (signed in, 18+, verified WhatsApp, lane, rate limit) are here; everything about the host and the line is decided inside
// the host's HfHostLineDO (lib/hf_queue_store.ts joinQueue) so two simultaneous joins are serialised. Neither response ever carries a phone number.
import { callerKycBlocked, CALLER_KYC_ERROR, CALLER_KYC_MESSAGE } from "../lib/hf_spaces"; // [HF-CREATOR-BADGES-1]
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { trackException } from "../hooks";
import { requireHfAgeConfirmation } from "../lib/hf_age_eligibility";
import { verifiedWhatsAppNumber } from "../lib/whatsapp_notify";
import { isClosing, CLOSING_MESSAGE } from "../lib/hf_exit";
import { modBlock } from "../lib/hf_safety_store"; // [HF-CALL-SAFETY-BE]
import { isDemoHost, DEMO_MESSAGE } from "../lib/hf_demo";
import { HF_CALL_APP, hasLaneAccess } from "../lib/hf_calls_store";
import { BOOKINGS_ONLY_MESSAGE, BOOKINGS_ONLY_REASON, liveBlockedByOption } from "../lib/hf_call_option"; // [HF-INTRO-W2]
import { womenLaneRequiredExtra } from "../lib/hf_lanes"; // [HF-INTRO-W2]
import { photosRequiredBlock } from "../lib/hf_user_photos"; // [HF-PHOTO-GATE-API]
import { loadHostBySlug, myQueueEntry, pokeLine, readQueueCfg } from "../lib/hf_queue_store";

const err = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) => json({ error, message, ...extra }, status);
const SLUG_PATH = /^\/api\/hf\/hosts\/([a-z0-9-]{3,40})\/queue$/;

const JOIN_STATUS: Record<string, number> = { queue_closed: 409, queue_full: 409, already_queued: 409, low_balance: 402, not_verified: 403, call_in_progress: 409 };
const JOIN_MESSAGE: Record<string, string> = {
  queue_closed: "This queue isn't open right now.",
  queue_full: "The queue is full right now. Please try again later or book a time.",
  already_queued: "You are already in a queue.",
  low_balance: "Top up your wallet to join the queue.",
  not_verified: "Please verify your WhatsApp number first.",
  call_in_progress: "You already have a call in progress.",
};

export async function hfQueueRoute(req: Request, env: Env, _ctx?: ExecutionContext): Promise<Response | null> {
  const url = new URL(req.url);
  const p = url.pathname;
  const m = SLUG_PATH.exec(p);
  const isMe = p === "/api/hf/queue/me";
  if (!m && !isMe) return null;
  if (!m && req.method !== "GET") return null;
  if (m && req.method !== "POST" && req.method !== "DELETE") return null;

  const cfg = await readQueueCfg(env);
  if (!cfg.enabled) return err(404, "feature_off", "Queues are not open yet.");
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error, u.error);
  const uid = u.uid;

  if (isMe) return json(await myQueueEntry(env, uid));

  const slug = m![1];
  const host = await loadHostBySlug(env, slug);
  if (!host || host.status !== "live") return err(404, "not_found", "This influencer isn't available.");

  if (req.method === "DELETE") {
    const r = await pokeLine(env, host.uid, { op: "leave", fanUid: uid });
    if (!r) return err(502, "queue_unavailable", "We couldn't update the queue. Please try again.");
    return json({ ok: true });
  }

  // POST: join
  const ageGate = await requireHfAgeConfirmation(env, uid);
  if (ageGate) return ageGate;
  if (await isClosing(env, uid)) return err(409, "account_closing", CLOSING_MESSAGE, { reason: "account_closing" });
  { const blocked = await modBlock(env, uid, "queue"); if (blocked) return blocked; } // [HF-CALL-SAFETY-BE]
  { const pg = await photosRequiredBlock(env, uid, "queue"); if (pg) return pg; } // [HF-PHOTO-GATE-API]
  if (host.uid === uid) return err(409, "queue_closed", JOIN_MESSAGE.queue_closed, { reason: "unavailable" });
  if (await isDemoHost(env, host.uid)) return err(409, "demo_host", DEMO_MESSAGE, { reason: "demo_host" });
  if (await liveBlockedByOption(env, host.uid)) return err(409, "queue_closed", BOOKINGS_ONLY_MESSAGE, { reason: BOOKINGS_ONLY_REASON, canQueue: false, canBook: cfg.bookingsOn }); // [HF-INTRO-W2] option A takes bookings only
  if (!(await verifiedWhatsAppNumber(env, uid))) return err(403, "not_verified", JOIN_MESSAGE.not_verified);
  const limited = await rateLimit(env, `hfqueue:${uid}`, 10, 600);
  if (limited) return limited;
  if (!(await verifiedWhatsAppNumber(env, host.uid))) return err(409, "queue_closed", JOIN_MESSAGE.queue_closed, { reason: "unavailable" });
  let lane: { women_lane: number; lgbtq_lane: number; caller_level: string | null; creator_kind: string | null } | null = null;
  try {
    lane = await env.DB_META.prepare("SELECT women_lane, lgbtq_lane, caller_level, creator_kind FROM hf_hosts WHERE uid=?1").bind(host.uid).first<{ women_lane: number; lgbtq_lane: number; caller_level: string | null; creator_kind: string | null }>().catch(() => null);
    if (lane?.women_lane === 1 && !(await hasLaneAccess(env, uid, "women"))) return err(403, "lane_required", "This host takes calls from verified women only.", await womenLaneRequiredExtra(env, uid));
    if (lane?.lgbtq_lane === 1 && !(await hasLaneAccess(env, uid, "lgbtq"))) return err(403, "lane_required", "This LGBTQ+ channel needs a full video KYC.", { lane: "lgbtq" }); // [HF-CREATOR-SPACES-1]
  } catch (e) {
    await trackException(env, e, { uid, route: "/api/hf/hosts/:slug/queue", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_queue", step: "lane" } }).catch(() => undefined);
  }

  if (lane && (await callerKycBlocked(env, uid, lane))) return err(403, CALLER_KYC_ERROR, CALLER_KYC_MESSAGE, { level: "video_kyc" }); // [HF-CREATOR-BADGES-1] fail closed
  const r = await pokeLine(env, host.uid, { op: "join", fanUid: uid, entryId: crypto.randomUUID() });
  if (!r) return err(502, "queue_unavailable", "We couldn't join the queue. Please try again.");
  if (r.ok) return json({ ok: true, entryId: r.entryId, position: r.position, waiting: r.waiting });
  const code = String(r.error ?? "queue_closed");
  const status = JOIN_STATUS[code] ?? 409;
  return err(status, code, JOIN_MESSAGE[code] ?? JOIN_MESSAGE.queue_closed, {
    ...(code === "low_balance" ? { shortfallPaise: r.shortfallPaise ?? 0 } : {}),
    ...(code === "already_queued" && r.hostSlug ? { hostSlug: r.hostSlug } : {}),
    ...(code === "queue_closed" && r.reason ? { reason: r.reason } : {}),
    ...(code === "queue_closed" && r.reason === BOOKINGS_ONLY_REASON ? { canQueue: false, canBook: cfg.bookingsOn } : {}), // [HF-INTRO-W2]
    ...(code === "queue_full" ? { waiting: r.waiting } : {}),
  });
}
