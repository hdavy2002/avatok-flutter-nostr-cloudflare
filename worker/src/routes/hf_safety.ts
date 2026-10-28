// [HF-CALL-SAFETY-BE] Call-safety HTTP API. Contract: the shared HF-CALL-SAFETY build contract; details in Specs/HF-CALL-SAFETY-1.md.
//   User   GET  /api/hf/safety/me                         POST /api/hf/safety/strikes/:id/appeal {message}
//          POST /api/hf/safety/rules/accept {version}     POST /api/hf/calls/:callId/report {reasons[], note?}
//   Admin  GET  /api/admin/hf/safety/summary | queue?tab=review|strikes|paused|access&cursor= | reviews/:id | reviews/:id/clip | users/:uid/ban-preview
//          POST /api/admin/hf/safety/reviews/:id/transcript {reason} | reviews/:id/decision | appeals/:id/decision | users/:uid/ban | users/:uid/restore
// Admin = ADMIN_UIDS, narrowed to the safety reviewers listed in KV `hf_safety_reviewers:v1` (comma separated uids) when that key is set.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { trackException } from "../hooks";
import { isAdminUid } from "../lib/preview";
import { mediaUrl } from "../lib/hf_host_store";
import {
  fmtClock, adminWindow, clipRange, clipBytes, isStrikeReason, canAppealStrike, REASON_TEXT, STRIKE_REASONS, HOUR_MS, DAY_MS,
  type StrikeReason, type SpeakerRole,
} from "../lib/hf_safety_rules";
import {
  loadSafetyCfg, hfModStatus, activeStrikes, giveStrike, pauseAccount, banAccount, restoreAccount, openAppeal, decideAppeal, stTrack, stFail,
} from "../lib/hf_safety_store";
import { banMoneyPreview, heldEarningsPaise } from "../lib/hf_safety_money";
import { ingestRecording, fileReport, parseStoredLines } from "../lib/hf_safety_process";

const NO_STORE = { "cache-control": "private, no-store" };
const err = (status: number, error: string, message?: string, extra: Record<string, unknown> = {}) => json({ ok: false, error, message: message ?? error, ...extra }, status, NO_STORE);
const UID_RE = /^[A-Za-z0-9_.:+-]{4,128}$/;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const t = await req.text().catch(() => "");
  if (!t || t.length > 12_000) return {};
  try { const v = JSON.parse(t); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

// ── admin auth ───────────────────────────────────────────────────────────────────────────────────────────────────
export async function isSafetyReviewer(env: Env, uid: string): Promise<boolean> {
  if (!isAdminUid(env, uid)) return false;
  try {
    const raw = ((await env.TOKENS.get("hf_safety_reviewers:v1")) ?? "").trim();
    if (!raw) return true; // no list set: every admin is a reviewer
    return raw.split(/[\s,]+/).filter(Boolean).includes(uid);
  } catch { return true; }
}
async function reviewerCtx(req: Request, env: Env): Promise<{ uid: string } | Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  if (!(await isSafetyReviewer(env, u.uid))) return err(403, "forbidden", "Forbidden.");
  return { uid: u.uid };
}
async function audit(env: Env, adminUid: string, action: string, target: string, meta: Record<string, unknown>): Promise<void> {
  try {
    await env.DB_WALLET.prepare("INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)")
      .bind(crypto.randomUUID(), adminUid, `hf_safety_${action}`, target, JSON.stringify(meta), Date.now()).run();
  } catch (e) { await stFail(env, e, "admin_audit", { action }); }
}
async function logAccess(env: Env, reviewId: string, adminUid: string, action: "open_lines" | "full_transcript" | "clip", reason: string | null): Promise<void> {
  await env.DB_META.prepare("INSERT INTO hf_review_access_log (id, review_id, admin_uid, action, reason, created_at) VALUES (?1,?2,?3,?4,?5,?6)").bind(crypto.randomUUID(), reviewId, adminUid, action, reason, Date.now()).run();
  await stTrack(env, adminUid, "hf_review_opened", { review_id: reviewId, action, has_reason: !!reason });
}

// ── user: GET /api/hf/safety/me ─────────────────────────────────────────────────────────────────────────────────────
interface StrikeDbRow { id: string; reason: string; quote: string | null; created_at: number; expires_at: number; removed_at: number | null; removed_why: string | null; call_at: number | null; appeal_status: string | null }
export function strikeJson(r: StrikeDbRow, now: number) {
  const reason = (isStrikeReason(r.reason) ? r.reason : "abuse") as StrikeReason;
  return {
    id: r.id, reason, reasonText: REASON_TEXT[reason], callAt: Number(r.call_at ?? r.created_at), quote: r.quote ?? null, expiresAt: Number(r.expires_at),
    removedAt: r.removed_at == null ? null : Number(r.removed_at), removedWhy: r.removed_why ?? null,
    appealStatus: (r.appeal_status === "open" || r.appeal_status === "accepted" || r.appeal_status === "rejected" ? r.appeal_status : null) as null | "open" | "accepted" | "rejected",
    canAppeal: canAppealStrike({ removedAt: r.removed_at == null ? null : Number(r.removed_at), expiresAt: Number(r.expires_at), appealStatus: r.appeal_status ?? null }, now),
  };
}
async function loadStrikes(env: Env, uid: string): Promise<StrikeDbRow[]> {
  return (await env.DB_META.prepare(
    `SELECT s.id, s.reason, s.quote, s.created_at, s.expires_at, s.removed_at, s.removed_why, COALESCE(c.connected_at, c.created_at) AS call_at, a.status AS appeal_status
       FROM hf_strikes s LEFT JOIN hf_calls c ON c.id=s.call_id LEFT JOIN hf_appeals a ON a.strike_id=s.id WHERE s.uid=?1 ORDER BY s.created_at DESC LIMIT 50`,
  ).bind(uid).all<StrikeDbRow>().catch(() => ({ results: [] }))).results ?? [];
}

async function safetyMe(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const [cfg, mod, rows, host, accept] = await Promise.all([
    loadSafetyCfg(env), hfModStatus(env, u.uid), loadStrikes(env, u.uid),
    env.DB_META.prepare("SELECT 1 AS x FROM hf_hosts WHERE uid=?1").bind(u.uid).first().catch(() => null),
    env.DB_META.prepare("SELECT version FROM hf_call_rules_accept WHERE uid=?1").bind(u.uid).first<{ version: number }>().catch(() => null),
  ]);
  const now = Date.now();
  const active = rows.filter((r) => r.removed_at == null && Number(r.expires_at) > now).length;
  const held = host && mod.status !== "active" ? await heldEarningsPaise(env, u.uid) : 0;
  void stTrack(env, u.uid, "hf_safety_viewed", { status: mod.status, active_strikes: active, is_host: !!host });
  return json({
    status: mod.status, activeStrikes: active, strikesToPause: cfg.strikesToPause, reviewDueAt: mod.reviewDueAt, heldPaise: held,
    rulesAccepted: host ? !!accept && Number(accept.version) >= cfg.rulesVersion : true, rulesVersion: cfg.rulesVersion, recordingEnabled: cfg.recordingEnabled,
    strikes: rows.map((r) => strikeJson(r, now)),
  }, 200, NO_STORE);
}

async function appealRoute(req: Request, env: Env, strikeId: string): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const lim = await rateLimit(env, `hfappeal:${u.uid}`, 10, 3600);
  if (lim) return lim;
  const b = await readJson(req);
  const r = await openAppeal(env, u.uid, strikeId, str(b.message, 1000), "app");
  if (!r.ok) return err(r.status, r.error, r.error === "already_appealed" ? "You already appealed this strike." : r.error === "not_active" ? "This strike is no longer active." : "Strike not found.");
  return json({ ok: true, appealStatus: "open" }, 200, NO_STORE);
}

async function acceptRules(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const b = await readJson(req);
  const cfg = await loadSafetyCfg(env);
  const version = Math.trunc(Number(b.version));
  if (!Number.isInteger(version) || version < cfg.rulesVersion) return err(409, "stale_version", "Please read the latest call rules.", { rulesVersion: cfg.rulesVersion });
  await env.DB_META.prepare("INSERT INTO hf_call_rules_accept (uid, version, accepted_at) VALUES (?1,?2,?3) ON CONFLICT(uid) DO UPDATE SET version=MAX(version, excluded.version), accepted_at=excluded.accepted_at")
    .bind(u.uid, version, Date.now()).run();
  await stTrack(env, u.uid, "hf_rules_accepted", { version });
  return json({ ok: true }, 200, NO_STORE);
}

async function reportRoute(req: Request, env: Env, callId: string): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const lim = await rateLimit(env, `hfreport:${u.uid}`, 20, 3600);
  if (lim) return lim;
  const b = await readJson(req);
  const reasons = Array.isArray(b.reasons) ? b.reasons.map(String) : [];
  const r = await fileReport(env, u.uid, callId, reasons, str(b.note, 500) || null);
  if (!r.ok) return err(r.status, r.error, r.error === "invalid_reasons" ? "Choose at least one reason." : "Call not found.");
  return json({ ok: true }, 200, NO_STORE);
}

// ── admin: shared row builder ──────────────────────────────────────────────────────────────────────────────────────
type Dyn = Record<string, any>;
const PHOTO_SQL = "COALESCE((SELECT m.r2_key FROM hf_host_media m WHERE m.uid=h.uid AND m.kind='profile' AND m.status='active' ORDER BY m.created_at DESC LIMIT 1), (SELECT a.image_key FROM hf_avatars a WHERE a.id=h.avatar_id))";
const REVIEW_SELECT = `SELECT r.*, COALESCE(h.display_name, u.display_name) AS name, h.uid AS host_row, ${PHOTO_SQL} AS photo_key,
  (SELECT COUNT(*) FROM hf_strikes s WHERE s.uid=COALESCE(r.target_uid, r.host_uid) AND s.removed_at IS NULL AND s.expires_at>?1) AS active_strikes
  FROM hf_call_reviews r LEFT JOIN users u ON u.uid=COALESCE(r.target_uid, r.host_uid) LEFT JOIN hf_hosts h ON h.uid=u.uid`;

export function reviewRow(env: Env, r: Dyn, now: number): Dyn {
  const uid = r.target_uid ?? r.host_uid;
  const role: SpeakerRole = uid === r.fan_uid ? "fan" : "influencer";
  return {
    id: r.id, kind: r.kind === "danger" ? "danger" : r.kind === "fan_report" ? "fan_report" : "review", uid, role: role === "fan" ? "fan" : "influencer", name: r.name ?? null,
    photo: r.photo_key && role === "influencer" ? mediaUrl(env, r.photo_key) : null, verdict: r.verdict, score: Number(r.score ?? 0), speaker: r.speaker ?? null, speakerScore: Number(r.speaker_score ?? 0),
    callAt: r.call_at == null ? null : Number(r.call_at), durationSec: r.duration_sec == null ? null : Number(r.duration_sec), activeStrikes: Number(r.active_strikes ?? 0),
    waitingMs: Math.max(0, now - Number(r.created_at)), summary: r.summary ?? null, womenLane: Number(r.women_lane) === 1,
  };
}

async function summaryRoute(env: Env): Promise<Response> {
  const now = Date.now();
  const startOfDay = Math.floor((now + 5.5 * HOUR_MS) / DAY_MS) * DAY_MS - 5.5 * HOUR_MS;
  const q = async (sql: string, ...b: unknown[]): Promise<number> => Number((await env.DB_META.prepare(sql).bind(...b).first<{ n: number }>().catch(() => null))?.n ?? 0);
  const [checked, flagged, strikes, waitingR, waitingA, oldest] = await Promise.all([
    q("SELECT COUNT(*) AS n FROM hf_call_reviews WHERE kind='review' AND created_at>=?1", startOfDay),
    q("SELECT COUNT(*) AS n FROM hf_call_reviews WHERE kind IN ('review','danger') AND verdict!='clean' AND created_at>=?1", startOfDay),
    q("SELECT COUNT(*) AS n FROM hf_strikes WHERE created_at>=?1", startOfDay),
    q("SELECT COUNT(*) AS n FROM hf_call_reviews WHERE status='queued'"),
    q("SELECT COUNT(*) AS n FROM hf_appeals WHERE status='open'"),
    q("SELECT MIN(t) AS n FROM (SELECT MIN(created_at) AS t FROM hf_call_reviews WHERE status='queued' UNION ALL SELECT MIN(created_at) FROM hf_appeals WHERE status='open')"),
  ]);
  return json({ checkedToday: checked, flaggedToday: flagged, strikesToday: strikes, waiting: waitingR + waitingA, oldestWaitingMs: oldest ? Math.max(0, now - oldest) : 0 }, 200, NO_STORE);
}

async function queueRoute(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const tab = url.searchParams.get("tab") ?? "review";
  const offset = Math.max(0, Math.trunc(Number(url.searchParams.get("cursor") ?? 0)) || 0);
  const LIM = 50;
  const now = Date.now();
  let items: Dyn[] = [];
  if (tab === "review") {
    const rows = (await env.DB_META.prepare(`${REVIEW_SELECT} WHERE r.status='queued' ORDER BY (r.kind='danger') DESC, r.created_at ASC LIMIT ?2 OFFSET ?3`).bind(now, LIM + 1, offset).all<Dyn>()).results ?? [];
    items = rows.map((r) => reviewRow(env, r, now));
  } else if (tab === "strikes") {
    const appeals = (await env.DB_META.prepare(
      `SELECT a.id AS appeal_id, a.message AS appeal_message, a.created_at AS appeal_at, a.strike_id, s.review_id, s.role AS s_role, s.reason AS s_reason, s.call_id,
              COALESCE(h.display_name, u.display_name) AS name, h.uid AS host_row, ${PHOTO_SQL} AS photo_key, a.uid AS a_uid,
              (SELECT COUNT(*) FROM hf_strikes x WHERE x.uid=a.uid AND x.removed_at IS NULL AND x.expires_at>?1) AS active_strikes,
              r.score, r.speaker_score, r.duration_sec, r.call_at, r.women_lane
         FROM hf_appeals a JOIN hf_strikes s ON s.id=a.strike_id LEFT JOIN hf_call_reviews r ON r.id=s.review_id LEFT JOIN users u ON u.uid=a.uid LEFT JOIN hf_hosts h ON h.uid=a.uid
        WHERE a.status='open' ORDER BY a.created_at ASC LIMIT ?2 OFFSET ?3`,
    ).bind(now, LIM + 1, offset).all<Dyn>()).results ?? [];
    items = appeals.map((a) => ({
      id: a.appeal_id, kind: "appeal", uid: a.a_uid, role: a.s_role, name: a.name ?? null, photo: a.photo_key && a.s_role === "influencer" ? mediaUrl(env, a.photo_key) : null,
      verdict: a.s_reason, score: Number(a.score ?? 0), speaker: a.s_role, speakerScore: Number(a.speaker_score ?? 0), callAt: a.call_at == null ? null : Number(a.call_at),
      durationSec: a.duration_sec == null ? null : Number(a.duration_sec), activeStrikes: Number(a.active_strikes ?? 0), waitingMs: Math.max(0, now - Number(a.appeal_at)),
      summary: a.appeal_message ? String(a.appeal_message).slice(0, 200) : "Appeal of a strike", womenLane: Number(a.women_lane) === 1, reviewId: a.review_id ?? null, strikeId: a.strike_id,
    }));
    if (items.length < LIM) { // then the most recent strikes (30 days), so an employee can see what was given
      const strikes = (await env.DB_META.prepare(`${REVIEW_SELECT} WHERE r.status='struck' AND r.updated_at>?4 ORDER BY r.updated_at DESC LIMIT ?2 OFFSET ?3`).bind(now, LIM + 1 - items.length, offset, now - 30 * DAY_MS).all<Dyn>()).results ?? [];
      items.push(...strikes.map((r) => ({ ...reviewRow(env, r, now), summary: `Strike given: ${REASON_TEXT[(isStrikeReason(r.verdict) ? r.verdict : "abuse") as StrikeReason]}` })));
    }
  } else if (tab === "paused") {
    const rows = (await env.DB_META.prepare(
      `SELECT m.uid, m.status, m.reason, m.updated_at, COALESCE(h.display_name, u.display_name) AS name, h.uid AS host_row, ${PHOTO_SQL} AS photo_key,
              (SELECT COUNT(*) FROM hf_strikes s WHERE s.uid=m.uid AND s.removed_at IS NULL AND s.expires_at>?1) AS active_strikes
         FROM hf_mod_state m LEFT JOIN users u ON u.uid=m.uid LEFT JOIN hf_hosts h ON h.uid=m.uid WHERE m.status IN ('paused','banned') ORDER BY m.updated_at ASC LIMIT ?2 OFFSET ?3`,
    ).bind(now, LIM + 1, offset).all<Dyn>().catch(() => ({ results: [] as Dyn[] }))).results ?? [];
    items = rows.map((m) => ({
      id: m.uid, kind: "paused", uid: m.uid, role: m.host_row ? "influencer" : "fan", name: m.name ?? null, photo: m.photo_key && m.host_row ? mediaUrl(env, m.photo_key) : null, verdict: null, score: 0,
      speaker: null, speakerScore: 0, callAt: null, durationSec: null, activeStrikes: Number(m.active_strikes ?? 0), waitingMs: Math.max(0, now - Number(m.updated_at)),
      summary: m.status === "banned" ? "Banned" : m.reason === "danger" ? "Paused: danger" : m.reason === "admin" ? "Paused by an employee" : "Paused: strikes", womenLane: false, status: m.status,
    }));
  } else if (tab === "access") {
    const rows = (await env.DB_META.prepare(
      `SELECT l.id, l.review_id, l.admin_uid, l.action, l.reason, l.created_at, r.verdict, r.score, r.fan_uid, r.host_uid, r.target_uid, r.women_lane, r.duration_sec, r.call_at,
              COALESCE(h.display_name, u.display_name) AS name
         FROM hf_review_access_log l LEFT JOIN hf_call_reviews r ON r.id=l.review_id LEFT JOIN users u ON u.uid=COALESCE(r.target_uid, r.host_uid) LEFT JOIN hf_hosts h ON h.uid=u.uid
        ORDER BY l.created_at DESC LIMIT ?1 OFFSET ?2`,
    ).bind(LIM + 1, offset).all<Dyn>().catch(() => ({ results: [] as Dyn[] }))).results ?? [];
    items = rows.map((l) => {
      const uid = l.target_uid ?? l.host_uid ?? null;
      return {
        id: l.id, kind: "review", uid, role: uid && uid === l.fan_uid ? "fan" : "influencer", name: l.name ?? null, photo: null, verdict: l.verdict ?? null, score: Number(l.score ?? 0), speaker: null, speakerScore: 0,
        callAt: l.call_at == null ? null : Number(l.call_at), durationSec: l.duration_sec == null ? null : Number(l.duration_sec), activeStrikes: 0, waitingMs: Math.max(0, now - Number(l.created_at)),
        summary: `${l.action === "full_transcript" ? "Opened the full transcript" : l.action === "clip" ? "Played the audio clip" : "Opened the flagged lines"}${l.reason ? `: ${String(l.reason).slice(0, 120)}` : ""}`,
        womenLane: Number(l.women_lane) === 1, reviewId: l.review_id, access: { adminUid: l.admin_uid, action: l.action, reason: l.reason ?? null, at: Number(l.created_at) },
      };
    });
  } else return err(400, "invalid_tab", "tab must be review, strikes, paused or access.");
  const more = items.length > LIM;
  return json({ ok: true, items: items.slice(0, LIM), nextCursor: more ? String(offset + LIM) : null }, 200, NO_STORE);
}

// ── admin: one review ───────────────────────────────────────────────────────────────────────────────────────────────
async function loadReview(env: Env, id: string): Promise<Dyn | null> {
  return (await env.DB_META.prepare(`${REVIEW_SELECT} WHERE r.id=?2`).bind(Date.now(), id).first<Dyn>().catch(() => null)) ?? null;
}
/** The transcript lives on the call's 'review' row; a fan_report row borrows it. */
async function transcriptOf(env: Env, r: Dyn): Promise<{ lines: ReturnType<typeof parseStoredLines>; flaggedIdx: number | null; flaggedSec: number | null; recordingKey: string | null; recordingBytes: number | null; audioUntil: number | null; duration: number | null }> {
  const src = r.kind === "review" || r.kind === "danger" ? r : await env.DB_META.prepare("SELECT lines_json, flagged_idx, flagged_sec, duration_sec FROM hf_call_reviews WHERE call_id=?1 AND kind IN ('review','danger') LIMIT 1").bind(r.call_id).first<Dyn>().catch(() => null);
  const rec = await env.DB_META.prepare("SELECT r2_key, bytes, audio_expires_at, duration_sec FROM hf_call_recordings WHERE call_id=?1 AND r2_key IS NOT NULL ORDER BY created_at DESC LIMIT 1").bind(r.call_id).first<Dyn>().catch(() => null);
  return {
    lines: parseStoredLines(src?.lines_json), flaggedIdx: src?.flagged_idx == null ? null : Number(src.flagged_idx), flaggedSec: src?.flagged_sec == null ? null : Number(src.flagged_sec),
    recordingKey: rec?.r2_key ?? null, recordingBytes: rec?.bytes == null ? null : Number(rec.bytes), audioUntil: rec?.audio_expires_at == null ? null : Number(rec.audio_expires_at),
    duration: Number(src?.duration_sec ?? rec?.duration_sec ?? r.duration_sec ?? 0) || null,
  };
}

async function reviewDetail(env: Env, adminUid: string, id: string): Promise<Response> {
  const r = await loadReview(env, id);
  if (!r) return err(404, "not_found", "Not found.");
  const t = await transcriptOf(env, r);
  await logAccess(env, id, adminUid, "open_lines", null);
  const w = adminWindow(t.lines.length, t.flaggedIdx);
  const lines = t.lines.slice(w.from, w.to + 1).map((l, i) => ({ t: l.t, speaker: l.speaker, // "unknown" is returned as-is (the admin screen shows "Not sure"); never guessed text: l.text, flagged: w.from + i === t.flaggedIdx }));
  const uid = r.target_uid ?? r.host_uid;
  const hist = await loadStrikes(env, uid);
  const now = Date.now();
  const reports = (await env.DB_META.prepare("SELECT reasons_json, note, created_at FROM hf_call_reports WHERE call_id=?1 ORDER BY created_at").bind(r.call_id).all<Dyn>().catch(() => ({ results: [] as Dyn[] }))).results ?? [];
  const struck = await env.DB_META.prepare("SELECT id FROM hf_strikes WHERE review_id=?1").bind(id).first<{ id: string }>().catch(() => null);
  return json({
    ...reviewRow(env, r, now), lines, hasTranscript: t.lines.length > 0, audioUntil: t.recordingKey ? t.audioUntil : null, clipAvailable: !!t.recordingKey,
    callId: r.call_id, status: r.status, strikeId: struck?.id ?? null, decision: r.decision_action ? { action: r.decision_action, by: r.decided_by, at: r.decided_at == null ? null : Number(r.decided_at), note: r.decision_note ?? null } : null,
    history: hist.map((s) => strikeJson(s, now)).map(({ quote: _q, ...x }) => x),
    reports: reports.map((x) => ({ reasons: JSON.parse(x.reasons_json ?? "[]"), note: x.note ?? null, at: Number(x.created_at) })),
  }, 200, NO_STORE);
}

async function fullTranscript(req: Request, env: Env, adminUid: string, id: string): Promise<Response> {
  const b = await readJson(req);
  const reason = str(b.reason, 300);
  if (reason.length < 5) return err(400, "reason_required", "Type why you need the full transcript.");
  const r = await loadReview(env, id);
  if (!r) return err(404, "not_found", "Not found.");
  const t = await transcriptOf(env, r);
  await logAccess(env, id, adminUid, "full_transcript", reason);
  await audit(env, adminUid, "full_transcript", id, { reason });
  return json({ ok: true, lines: t.lines.map((l, i) => ({ t: l.t, speaker: l.speaker, // "unknown" is returned as-is (the admin screen shows "Not sure"); never guessed text: l.text, flagged: i === t.flaggedIdx })) }, 200, NO_STORE);
}

async function clipRoute(env: Env, adminUid: string, id: string): Promise<Response> {
  const r = await loadReview(env, id);
  if (!r) return err(404, "not_found", "Not found.");
  const t = await transcriptOf(env, r);
  if (!t.recordingKey) return err(404, "audio_gone", "The audio is no longer kept.");
  const range = clipRange(t.flaggedSec, t.duration);
  const size = t.recordingBytes ?? (await env.DIGITAL.head(t.recordingKey))?.size ?? 0;
  const part = range && t.duration && size ? clipBytes(size, t.duration, range) : null;
  const obj = await env.DIGITAL.get(t.recordingKey, part ? { range: { offset: part.offset, length: part.length } } : undefined);
  if (!obj) return err(404, "audio_gone", "The audio is no longer kept.");
  await logAccess(env, id, adminUid, "clip", null);
  return new Response(obj.body, { headers: { "content-type": "audio/mpeg", "cache-control": "private, no-store", "x-clip-seconds": range ? "15" : "full" } });
}

async function decisionRoute(req: Request, env: Env, adminUid: string, id: string): Promise<Response> {
  const b = await readJson(req);
  const action = str(b.action, 20);
  const target = str(b.target, 20);
  if (action !== "confirm_strike" && action !== "dismiss" && action !== "pause") return err(400, "invalid_action", "action must be confirm_strike, dismiss or pause.");
  if (target !== "fan" && target !== "influencer") return err(400, "invalid_target", "target must be fan or influencer.");
  const r = await loadReview(env, id);
  if (!r) return err(404, "not_found", "Not found.");
  const reason = str(b.reason, 200);
  const note = str(b.note, 500) || null;
  const finalStatus = action === "confirm_strike" ? "struck" : action === "dismiss" ? "dismissed" : "paused";
  const strikeReason: StrikeReason | null = action === "confirm_strike" ? (isStrikeReason(reason) ? reason : isStrikeReason(r.verdict) ? r.verdict : null) : null;
  if (action === "confirm_strike" && !strikeReason) return err(400, "invalid_reason", `reason must be one of ${STRIKE_REASONS.join(", ")}.`);
  const claim = await env.DB_META.prepare("UPDATE hf_call_reviews SET status=?2, decided_by=?3, decided_at=?4, decision_action=?5, decision_note=?6, updated_at=?4 WHERE id=?1 AND status='queued'")
    .bind(id, finalStatus, adminUid, Date.now(), action, note ?? (reason || null)).run();
  if (!Number(claim.meta?.changes ?? 0)) return err(409, "already_decided", "Someone already decided this.");
  const uid = target === "fan" ? r.fan_uid : r.host_uid;
  try {
    if (action === "confirm_strike") {
      const t = await transcriptOf(env, r);
      const fl = t.flaggedIdx != null ? t.lines[t.flaggedIdx] : null;
      await giveStrike(env, { uid, role: target, callId: r.call_id, reviewId: id, reason: strikeReason!, quote: fl && fl.speaker === target ? fl.text : null, auto: false, byUid: adminUid });
    } else if (action === "pause") {
      await pauseAccount(env, uid, "admin", adminUid);
    }
  } catch (e) {
    await env.DB_META.prepare("UPDATE hf_call_reviews SET status='queued', decided_by=NULL, decided_at=NULL, decision_action=NULL WHERE id=?1").bind(id).run().catch(() => undefined);
    await stFail(env, e, "decision", { review_id: id, action });
    return err(502, "action_failed", "The action did not go through. Nothing was changed; try again.");
  }
  await audit(env, adminUid, `review_${action}`, id, { target, uid, reason, note });
  await stTrack(env, adminUid, "hf_review_decided", { review_id: id, call_id: r.call_id, action, target, target_uid: uid, reason: reason || strikeReason, women_lane: Number(r.women_lane) === 1 });
  return json({ ok: true, status: finalStatus }, 200, NO_STORE);
}

async function appealDecision(req: Request, env: Env, adminUid: string, id: string): Promise<Response> {
  const b = await readJson(req);
  const decision = str(b.decision, 10);
  if (decision !== "accept" && decision !== "reject") return err(400, "invalid_decision", "decision must be accept or reject.");
  const r = await decideAppeal(env, id, decision, str(b.note, 500) || null, adminUid);
  if (!r.ok) return err(r.status, r.error, r.error === "already_decided" ? "Someone already decided this appeal." : "Appeal not found.");
  await audit(env, adminUid, `appeal_${decision}`, id, { uid: r.uid });
  return json({ ok: true, decision, restored: r.restored }, 200, NO_STORE);
}

async function banPreview(env: Env, uid: string): Promise<Response> {
  const [pre, host, strikes] = await Promise.all([
    banMoneyPreview(env, uid),
    env.DB_META.prepare("SELECT display_name FROM hf_hosts WHERE uid=?1").bind(uid).first<{ display_name: string | null }>().catch(() => null),
    loadStrikes(env, uid),
  ]);
  const u = host ? null : await env.DB_META.prepare("SELECT display_name FROM users WHERE uid=?1").bind(uid).first<{ display_name: string | null }>().catch(() => null);
  const now = Date.now();
  return json({
    name: host?.display_name ?? u?.display_name ?? null, strikes: strikes.map((s) => strikeJson(s, now)), heldPaise: pre.heldPaise, refunds: pre.refunds, refundTotalPaise: pre.refundTotalPaise, payoutPaise: pre.payoutPaise,
  }, 200, NO_STORE);
}

async function banRoute(req: Request, env: Env, adminUid: string, uid: string): Promise<Response> {
  const b = await readJson(req);
  const reason = str(b.reason, 200);
  if (reason.length < 3) return err(400, "reason_required", "Type the reason for the ban.");
  if (isAdminUid(env, uid)) return err(409, "not_allowed", "An admin account cannot be banned here.");
  const r = await banAccount(env, uid, reason, adminUid, b.refundFans !== false);
  await audit(env, adminUid, "ban", uid, { reason, refundTotalPaise: r.refundTotalPaise, payout: r.payout });
  return json({ ok: true, refunds: r.refunded, refundTotalPaise: r.refundTotalPaise, payout: r.payout, failedCalls: r.failedCalls }, 200, NO_STORE);
}

async function restoreRoute(req: Request, env: Env, adminUid: string, uid: string): Promise<Response> {
  const b = await readJson(req);
  const ids = Array.isArray(b.removeStrikeIds) ? b.removeStrikeIds.map(String).filter((x) => ID_RE.test(x) || /^[0-9a-f-]{36}$/.test(x)) : [];
  const r = await restoreAccount(env, uid, ids, adminUid);
  await audit(env, adminUid, "restore", uid, { removed: r.removed });
  return json({ ok: true, strikesRemoved: r.removed }, 200, NO_STORE);
}

// ── recording webhook (called from the Vobiz webhook router after the secret check) ─────────────────────────────────────
export async function hfSafetyRecordingWebhook(req: Request, env: Env, callId: string, role: string): Promise<Response> {
  const ok = () => new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', { status: 200, headers: { "content-type": "application/xml" } });
  try {
    const f: Record<string, string> = {};
    if (req.method === "POST") { try { for (const [k, v] of new URLSearchParams(await req.text()).entries()) f[k] = v; } catch { /* empty */ } }
    else for (const [k, v] of new URL(req.url).searchParams.entries()) f[k] = v;
    const r = await ingestRecording(env, callId, role, f);
    if (!r.ok) await stTrack(env, "system", "hf_recording_failed", { call_id: callId, step: "webhook", reason: r.reason ?? "rejected" });
    return ok(); // always 200 for a well-formed delivery: a retry cannot fix a bad one
  } catch (e) {
    await stFail(env, e, "recording_webhook", { call_id: callId });
    return new Response("error", { status: 500 }); // transient (D1): let Vobiz retry; the insert is idempotent
  }
}

// ── router ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
export async function hfSafetyRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  const m = req.method;
  try {
    if (p === "/api/hf/safety/me" && m === "GET") return await safetyMe(req, env);
    if (p === "/api/hf/safety/rules/accept" && m === "POST") return await acceptRules(req, env);
    const ap = p.match(/^\/api\/hf\/safety\/strikes\/([A-Za-z0-9_-]{8,64})\/appeal$/);
    if (ap && m === "POST") return await appealRoute(req, env, ap[1]);
    const rp = p.match(/^\/api\/hf\/calls\/([A-Za-z0-9_-]{8,64})\/report$/);
    if (rp && m === "POST") return await reportRoute(req, env, rp[1]);

    if (!p.startsWith("/api/admin/hf/safety/")) return null;
    const a = await reviewerCtx(req, env);
    if (a instanceof Response) return a;
    if (p === "/api/admin/hf/safety/summary" && m === "GET") return await summaryRoute(env);
    if (p === "/api/admin/hf/safety/queue" && m === "GET") return await queueRoute(req, env);
    const rv = p.match(/^\/api\/admin\/hf\/safety\/reviews\/([A-Za-z0-9_-]{8,64})(?:\/(transcript|clip|decision))?$/);
    if (rv) {
      if (!rv[2] && m === "GET") return await reviewDetail(env, a.uid, rv[1]);
      if (rv[2] === "transcript" && m === "POST") return await fullTranscript(req, env, a.uid, rv[1]);
      if (rv[2] === "clip" && m === "GET") return await clipRoute(env, a.uid, rv[1]);
      if (rv[2] === "decision" && m === "POST") return await decisionRoute(req, env, a.uid, rv[1]);
    }
    const ad = p.match(/^\/api\/admin\/hf\/safety\/appeals\/([A-Za-z0-9_-]{8,64})\/decision$/);
    if (ad && m === "POST") return await appealDecision(req, env, a.uid, ad[1]);
    const us = p.match(/^\/api\/admin\/hf\/safety\/users\/([^/]+)\/(ban-preview|ban|restore)$/);
    if (us) {
      const uid = decodeURIComponent(us[1]);
      if (!UID_RE.test(uid)) return err(400, "invalid_uid", "Bad user id.");
      if (us[2] === "ban-preview" && m === "GET") return await banPreview(env, uid);
      if (us[2] === "ban" && m === "POST") return await banRoute(req, env, a.uid, uid);
      if (us[2] === "restore" && m === "POST") return await restoreRoute(req, env, a.uid, uid);
    }
    return err(404, "not_found", "Not found.");
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, app_name: "hf_call_safety", extra: { area: "hf_call_safety" } });
    return err(500, "internal_error", "Something went wrong.");
  }
}
export { fmtClock };
