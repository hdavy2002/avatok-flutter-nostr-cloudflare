// [HF-CALL-MODES-A] Host call mode + presence + queue pause. Moved out of routes/hf_calls.ts (the old presenceRoute). Spec 2.1, 2.5; rulebook HF-CALL-7/8, HF-REEL-15/16.
//   GET|PUT /api/hosts/me/presence         PUT {mode:'online'|'bookings_only'|'offline'} OR legacy {online:boolean} (true -> online, false -> bookings_only, D6)
//        flag hfCallModesEnabled ON : -> {ok, presence (legacy, derived), mode, onCall, queue:{waiting,paused,open}, bookedCalls, [nudgesPaused on GET]}
//        flag OFF                   : -> exactly today's {ok, presence[, nudgesPaused]} (call_mode is still kept in step: true -> online, false -> bookings_only)
//   POST /api/hosts/me/presence/beat       bumps presence_at
//   PUT  /api/hosts/me/presence/nudges     {paused}  [HF-PRESENCE-NUDGE-1]
//   GET|PUT /api/hosts/me/queue            {paused} -> {ok, waiting, paused, entries:[{position, firstName, joinedAt}]} (first names only; needs modes + queue flags)
//   GET|PUT /api/hosts/me/call-option      [HF-INTRO-W2] {option:'A'|'B'} -> {ok, callOption, changed}. A = bookings only, B = bookings + live (D9). Needs hfCallOptionEnabled (else 404 not_enabled).
// Wiring: routes/hf_calls.ts (Lane C) calls hfHostModeRoute(req, env, p, ctx) in place of its old presence block.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { track, trackException } from "../hooks";
import { readConfig } from "./config";
import { verifiedWhatsAppNumber } from "../lib/whatsapp_notify";
import { notifyHostOnline } from "../lib/hf_notify";
import { isClosing, forceHostOffline, CLOSING_MESSAGE } from "../lib/hf_exit";
import { modBlock, callRulesBlock } from "../lib/hf_safety_store"; // [HF-CALL-SAFETY-BE]
import { HF_CALL_APP } from "../lib/hf_calls_store";
import { closeQueue, hostQueueView, pokeLine, setQueuePaused } from "../lib/hf_queue_store"; // [HF-CALL-MODES-INT] Lane B's real functions
import { derivePresence } from "../lib/hf_host_status";
import { lineFlags, waitingCounts } from "../lib/hf_host_line_view";
import { callOptionOn, hostCallOption, liveBlockedByOption, parseCallOption, setCallOption } from "../lib/hf_call_option"; // [HF-INTRO-W2]
import { HOST_MODES, type HostMode, type HfHostLineMessage } from "../lib/hf_call_contracts";

const err = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) => json({ error, message, ...extra }, status);
const NO_STORE = { "cache-control": "private, no-store" };
const NOT_ENABLED = () => err(404, "not_enabled", "Calls are not open yet.");

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try { const b = await req.json(); return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {}; } catch { return {}; }
}
async function callsOrReelsOn(env: Env): Promise<boolean> {
  try { const c = await readConfig(env); return c.hfCallsEnabled === true || c.hfReelsEnabled === true; } catch { return false; }
}

/** Poke the host's HfHostLineDO through Lane B's pokeLine (POST https://hfline/<op>, body + hostUid). Never throws; the 5-minute sweep repairs a missed poke. */
export async function pokeHostLine(env: Env, hostUid: string, msg: HfHostLineMessage): Promise<void> {
  await pokeLine(env, hostUid, msg).catch(() => null);
}

interface HostRow { uid: string; status: string; presence: string | null; call_mode?: string | null; on_call_since?: number | null; queue_paused?: number | null }
const asMode = (m: unknown): HostMode => (m === "offline" || m === "bookings_only" ? m : "online");

/** Confirmed future bookings that will still ring when she is Offline (D1). */
export async function countBookedCalls(env: Env, hostUid: string, now = Date.now()): Promise<number> {
  try {
    return Number((await env.DB_META.prepare("SELECT COUNT(*) AS n FROM hf_bookings WHERE host_uid=?1 AND status='confirmed' AND starts_at>?2").bind(hostUid, now).first<{ n: number }>())?.n ?? 0);
  } catch { return 0; }
}

async function presenceView(env: Env, uid: string, queueOn: boolean) {
  const r = await env.DB_META.prepare("SELECT presence, call_mode, on_call_since, queue_paused FROM hf_hosts WHERE uid=?1").bind(uid).first<HostRow>();
  const mode = asMode(r?.call_mode);
  const paused = Number(r?.queue_paused ?? 0) === 1;
  const waiting = queueOn ? (await waitingCounts(env, [uid])).get(uid) ?? 0 : 0;
  return {
    presence: (r?.presence ?? derivePresence(mode, r?.on_call_since)) as string,
    mode, onCall: r?.on_call_since != null,
    queue: { waiting, paused, open: queueOn && mode === "online" && !paused && !(await liveBlockedByOption(env, uid)) }, // [HF-INTRO-W2] option A: never open
    bookedCalls: await countBookedCalls(env, uid),
  };
}

export async function hfHostModeRoute(req: Request, env: Env, p: string, ctx?: ExecutionContext): Promise<Response | null> {
  const isPresence = p === "/api/hosts/me/presence" || p === "/api/hosts/me/presence/beat" || p === "/api/hosts/me/presence/nudges";
  const isQueue = p === "/api/hosts/me/queue";
  const isOption = p === "/api/hosts/me/call-option"; // [HF-INTRO-W2]
  if (!isPresence && !isQueue && !isOption) return null;
  const m = req.method;
  if (isOption ? !(m === "GET" || m === "PUT") : p === "/api/hosts/me/presence" ? !(m === "GET" || m === "PUT") : p === "/api/hosts/me/queue" ? !(m === "GET" || m === "PUT") : p.endsWith("/beat") ? m !== "POST" : m !== "PUT") return null;
  try {
    return isOption ? await optionRoute(req, env) : isQueue ? await queueRoute(req, env, p) : await presenceRoute(req, env, p, ctx);
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, app_name: HF_CALL_APP, extra: { area: "hf_host_mode" } });
    return err(500, "internal_error", "Try again in a little while.");
  }
}

async function presenceRoute(req: Request, env: Env, p: string, ctx?: ExecutionContext): Promise<Response> {
  // [HF-WIRE-5] the reels app uses presence without calls being open: calls OR reels flag.
  if (!(await callsOrReelsOn(env))) return NOT_ENABLED();
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error, u.error);
  const host = await env.DB_META.prepare("SELECT uid, status, presence FROM hf_hosts WHERE uid=?1").bind(u.uid).first<HostRow>();
  if (!host || host.status !== "live") return err(409, "not_live", "Your profile isn't live yet.");
  const flags = await lineFlags(env);
  const now = Date.now();
  // [HF-PRESENCE-NUDGE-1] nudge_paused comes from an ALTER migration: read it on its own so a worker deployed before the migration still serves presence.
  const nudgesPaused = async (): Promise<boolean> => {
    try { return Number((await env.DB_META.prepare("SELECT nudge_paused FROM hf_hosts WHERE uid=?1").bind(u.uid).first<{ nudge_paused: number }>())?.nudge_paused ?? 0) === 1; } catch { return false; }
  };
  if (req.method === "GET") {
    if (!flags.modes) return json({ ok: true, presence: host.presence ?? "offline", nudgesPaused: await nudgesPaused() }, 200, NO_STORE);
    return json({ ok: true, ...(await presenceView(env, u.uid, flags.queue)), nudgesPaused: await nudgesPaused() }, 200, NO_STORE);
  }
  if (p.endsWith("/nudges")) { // PUT {paused:boolean} -> {ok, paused}: pause / resume the 3-hourly "you're offline" reminders
    const b = await readJson(req);
    if (typeof b.paused !== "boolean") return err(400, "invalid_field", "paused must be true or false.");
    try {
      await env.DB_META.prepare("UPDATE hf_hosts SET nudge_paused=?1 WHERE uid=?2").bind(b.paused ? 1 : 0, u.uid).run();
    } catch (e) {
      await trackException(env, e, { route: p, method: "PUT", uid: u.uid, handled: true, app_name: HF_CALL_APP, extra: { area: "hf_presence_nudge" } });
      return err(503, "unavailable", "Try again in a little while.");
    }
    void track(env, u.uid, "hf_presence_nudge_paused", HF_CALL_APP, { area: "hf_presence_nudge", paused: b.paused }).catch(() => undefined);
    return json({ ok: true, paused: b.paused });
  }
  if (p.endsWith("/beat")) {
    await env.DB_META.prepare("UPDATE hf_hosts SET presence_at=?1 WHERE uid=?2 AND presence IN ('online','busy')").bind(now, u.uid).run();
    return json({ ok: true, presence: host.presence ?? "offline" });
  }

  const body = await readJson(req);
  // Target mode: {mode} wins; the legacy {online:boolean} maps true -> online, false -> bookings_only (D6: shipped apps' "Offline" means Bookings only).
  let target: HostMode;
  if (typeof body.mode === "string" && (HOST_MODES as readonly string[]).includes(body.mode)) target = body.mode as HostMode;
  else if (body.mode === undefined && typeof body.online === "boolean") target = body.online ? "online" : "bookings_only";
  else return err(400, "invalid_field", flags.modes ? "mode must be online, bookings_only or offline." : "online must be true or false.");
  if (!flags.modes && typeof body.online !== "boolean") return err(400, "invalid_field", "online must be true or false.");

  if (target !== "offline") { // [HF-CALL-SAFETY-BE] a paused or banned influencer takes no calls or bookings; going Online also needs the call rules
    const blocked = await modBlock(env, u.uid, "online");
    if (blocked) return blocked;
    if (target === "online") { const rules = await callRulesBlock(env, u.uid); if (rules) return rules; }
  }
  if (target === "online") {
    if (await isClosing(env, u.uid)) { await forceHostOffline(env, u.uid); return err(409, "account_closing", CLOSING_MESSAGE, { reason: "account_closing" }); } // [HF-WALLET-EXIT-1]
    if (!(await verifiedWhatsAppNumber(env, u.uid))) return err(403, "not_verified", "Verify your WhatsApp number to take calls.");
  }

  if (!flags.modes) {
    // Flag OFF: today's behaviour byte for byte; call_mode is kept in step (best effort: the column may not exist yet).
    const legacySql = target === "online"
      ? "UPDATE hf_hosts SET presence=CASE WHEN presence='busy' OR presence_call_id IS NOT NULL THEN 'busy' ELSE 'online' END, presence_at=?1 WHERE uid=?2"
      : "UPDATE hf_hosts SET presence='offline', presence_at=?1 WHERE uid=?2";
    try { await env.DB_META.prepare(legacySql.replace(" WHERE uid=?2", `, call_mode='${target === "online" ? "online" : "bookings_only"}' WHERE uid=?2`)).bind(now, u.uid).run(); }
    catch { await env.DB_META.prepare(legacySql).bind(now, u.uid).run(); }
    const after = (await env.DB_META.prepare("SELECT presence FROM hf_hosts WHERE uid=?1").bind(u.uid).first<{ presence: string }>())?.presence ?? "offline";
    if (target === "online" && (host.presence ?? "offline") === "offline" && after === "online") {
      const work = notifyHostOnline(env, ctx, u.uid).catch(() => undefined);
      if (ctx) ctx.waitUntil(work); else await work;
    }
    void track(env, u.uid, "hf_host_presence", HF_CALL_APP, { area: "hf_call", presence: after }).catch(() => undefined);
    return json({ ok: true, presence: after });
  }

  // Flag ON. The mode and the derived presence are written in ONE statement (busy if she is on a joined call, else online/offline by mode).
  const prev = asMode((await env.DB_META.prepare("SELECT call_mode FROM hf_hosts WHERE uid=?1").bind(u.uid).first<{ call_mode: string | null }>())?.call_mode);
  await env.DB_META.prepare(
    "UPDATE hf_hosts SET call_mode=?1, presence=CASE WHEN on_call_since IS NOT NULL THEN 'busy' WHEN ?1='online' THEN 'online' ELSE 'offline' END, presence_at=?2 WHERE uid=?3",
  ).bind(target, now, u.uid).run();
  if (prev !== target) {
    // rule 8: any mode but Online closes the queue (waiters are told once, the 'q:' lock is released). Online again wakes the line.
    if (target !== "online") await closeQueue(env, u.uid, "host_offline").catch(() => 0);
    else await pokeHostLine(env, u.uid, { op: "mode", mode: target });
    const surface = body.surface === "web" || body.surface === "app" ? body.surface : typeof body.online === "boolean" ? "legacy" : "unknown";
    void track(env, u.uid, "hf_host_mode_changed", HF_CALL_APP, { area: "hf_call", from: prev, to: target, surface }).catch(() => undefined);
    const after = (await env.DB_META.prepare("SELECT presence FROM hf_hosts WHERE uid=?1").bind(u.uid).first<{ presence: string }>())?.presence ?? "offline";
    if (target === "online" && after === "online") {
      const work = notifyHostOnline(env, ctx, u.uid).catch(() => undefined);
      if (ctx) ctx.waitUntil(work); else await work;
    }
  }
  void track(env, u.uid, "hf_host_presence", HF_CALL_APP, { area: "hf_call", presence: target === "online" ? "online" : "offline" }).catch(() => undefined);
  return json({ ok: true, ...(await presenceView(env, u.uid, flags.queue)) });
}

async function queueRoute(req: Request, env: Env, _p: string): Promise<Response> {
  const flags = await lineFlags(env);
  if (!flags.modes || !flags.queue) return NOT_ENABLED();
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error, u.error);
  const host = await env.DB_META.prepare("SELECT uid, status FROM hf_hosts WHERE uid=?1").bind(u.uid).first<HostRow>();
  // [HF-PHOTO-GATE-API] GET for a host who is not live yet (pending check / no row) is an empty queue, not an error: the app's Settings row said
  // "We could not load your queue" for an influencer still waiting for approval. PUT (pause) still needs a live profile.
  if (req.method === "GET" && (!host || host.status !== "live")) return json({ ok: true, waiting: 0, paused: false, entries: [], not_live: true }, 200, NO_STORE);
  if (!host || host.status !== "live") return err(409, "not_live", "Your profile isn't live yet.");
  if (req.method === "GET") return json(await hostQueueView(env, u.uid), 200, NO_STORE);
  const b = await readJson(req);
  if (typeof b.paused !== "boolean") return err(400, "invalid_field", "paused must be true or false.");
  // Only a real change goes through the line DO (it WhatsApps the waiters on pause and tracks hf_queue_paused itself).
  const cur = Number((await env.DB_META.prepare("SELECT queue_paused FROM hf_hosts WHERE uid=?1").bind(u.uid).first<{ queue_paused: number }>())?.queue_paused ?? 0) === 1;
  if (cur !== b.paused) await setQueuePaused(env, u.uid, b.paused, "host");
  return json(await hostQueueView(env, u.uid));
}

/** [HF-INTRO-W2] GET|PUT /api/hosts/me/call-option. The influencer (auth = the host) picks A (bookings only) or B (bookings + live). Any host row may set it
 *  (onboarding sets it before approval); only a live host is ever shown or called. Switching to A closes a running queue exactly like going Offline. */
async function optionRoute(req: Request, env: Env): Promise<Response> {
  if (!(await callOptionOn(env))) return NOT_ENABLED();
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error, u.error);
  const host = await env.DB_META.prepare("SELECT uid, status FROM hf_hosts WHERE uid=?1").bind(u.uid).first<{ uid: string; status: string }>();
  if (!host) return err(409, "not_host", "You are not an influencer yet.");
  if (req.method === "GET") return json({ ok: true, callOption: await hostCallOption(env, u.uid) }, 200, NO_STORE);
  const b = await readJson(req);
  const option = parseCallOption(b.option);
  if (!option) return err(400, "invalid_field", "option must be A or B.");
  const r = await setCallOption(env, u.uid, option);
  if (!r.ok) return err(503, "unavailable", "Try again in a little while.");
  const changed = r.prev !== option;
  if (changed && option === "A") await closeQueue(env, u.uid, "host_offline").catch(() => 0); // waiters are told once and the 'q:' lock is released
  if (changed) {
    const surface = b.surface === "web" || b.surface === "app" || b.surface === "onboarding" ? b.surface : "unknown";
    void track(env, u.uid, "hf_host_call_option_changed", HF_CALL_APP, { area: "hf_call", from: r.prev, to: option, surface }).catch(() => undefined);
  }
  return json({ ok: true, callOption: option, changed });
}
