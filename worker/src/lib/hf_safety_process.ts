// [HF-CALL-SAFETY-BE] The after-call pipeline, driven by the 5-minute cron (a D1 job table, no new queue: waitUntil isolates get killed).
//   webhook -> hf_call_recordings(received) -> copy to PRIVATE R2 (DIGITAL) + delete at Vobiz -> speech-to-text -> decision model
//   -> verdict / strike / queue / danger -> retention (clean audio deleted right away, flagged audio kept hfFlaggedAudioDays).
// Every step is idempotent and re-entrant through the row's status; a failing step retries with backoff, then alerts the owner (max hourly).
import type { Env } from "../types";
import { BRAND, brandUrl } from "./brand";
import { sendHfPush } from "./hf_push";
import { enqueueEmail } from "./email_outbox";
import { emailFor } from "./identity";
import { realEmailOrNull } from "./placeholder_email";
import { verifiedWhatsAppNumber } from "./whatsapp_notify";
import { sendAdminAlert } from "./saathum_upi3";
import { messageEmailHtml } from "./hf_booking_approval";
import { sha256Hex } from "../util";
import {
  decideOutcome, retentionFor, targetUid, strikeExpiresAt, REASON_TEXT, isReportReason, REPORT_VERDICT, DAY_MS, HOUR_MS,
  type Line, type SafetyCfg, type SpeakerRole, type StrikeReason, type Verdict,
} from "./hf_safety_rules";
import { pickStt, decideWithFallback, summaryFor, type DecisionResult, type SttProvider, type DecisionProvider } from "./hf_safety_providers";
import { downloadRecording, getRecordingMeta, deleteVobizRecording, sniffAudioMime, safeVobizUrl } from "./hf_vobiz_recording";
import { loadSafetyCfg, giveStrike, pauseAccount, queueNotice, stTrack, stFail } from "./hf_safety_store";
import { executeBanMoney, heldEarningsPaise } from "./hf_safety_money";

export const MAX_ATTEMPTS = 5;
export const BACKOFF_MS = (attempts: number): number => Math.min(6 * HOUR_MS, 5 * 60_000 * 2 ** Math.max(0, attempts - 1));
export const audioKey = (callId: string, recordingId: string): string => `hf-call-audio/${callId}/${recordingId.replace(/[^A-Za-z0-9_-]/g, "_")}.mp3`;

export interface StoredLine extends Line { c?: number }
export const parseStoredLines = (json: string | null | undefined): StoredLine[] => {
  try { const v = JSON.parse(json ?? "[]"); return Array.isArray(v) ? (v as StoredLine[]) : []; } catch { return []; }
};

interface RecRow {
  id: string; call_id: string; recording_id: string; vobiz_url: string | null; duration_sec: number | null; status: string; r2_key: string | null; bytes: number | null;
  women_lane: number; flagged: number; attempts: number; vobiz_deleted_at: number | null;
}
interface CallFacts { fan_uid: string; host_uid: string; lane: string | null; connected_at: number | null; created_at: number }

// ── webhook ingest ────────────────────────────────────────────────────────────────────────────────────────────────
/** Idempotent on RecordingID: Vobiz retries a non-200 up to three times. Returns whether this was a new row. */
export async function ingestRecording(env: Env, callId: string, role: string, f: Record<string, string>): Promise<{ ok: boolean; duplicate: boolean; reason?: string }> {
  const recordingId = String(f.RecordingID ?? f.RecordingId ?? "").trim();
  if (!recordingId || !/^[A-Za-z0-9_-]{4,80}$/.test(recordingId)) return { ok: false, duplicate: false, reason: "no_recording_id" };
  const event = String(f.Event ?? "").toLowerCase();
  const url = String(f.RecordUrl ?? f.RecordFile ?? f.RecordingUrl ?? "").trim() || null;
  if (event === "record" && !url) return { ok: true, duplicate: true, reason: "start_event" }; // the initial event carries only the id; the RecordStop callback is the one we keep
  if (url && !safeVobizUrl(url)) return { ok: false, duplicate: false, reason: "bad_url" };
  const call = await env.DB_META.prepare("SELECT lane FROM hf_calls WHERE id=?1").bind(callId).first<{ lane: string | null }>().catch(() => null);
  if (!call) return { ok: false, duplicate: false, reason: "unknown_call" };
  const dur = Number(f.RecordingDuration ?? (f.RecordingDurationMs ? Number(f.RecordingDurationMs) / 1000 : NaN));
  const now = Date.now();
  const r = await env.DB_META.prepare(
    `INSERT OR IGNORE INTO hf_call_recordings (id, call_id, recording_id, role, vobiz_url, duration_sec, status, women_lane, next_attempt_at, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,'received',?7,0,?8,?8)`,
  ).bind(crypto.randomUUID(), callId, recordingId, role === "host" ? "host" : "caller", url, Number.isFinite(dur) && dur > 0 ? Math.round(dur) : null, call.lane === "women" ? 1 : 0, now).run();
  const created = Number(r.meta?.changes ?? 0) > 0;
  if (created) await stTrack(env, "system", "hf_recording_received", { call_id: callId, recording_id: recordingId, duration_sec: Number.isFinite(dur) ? Math.round(dur) : null, women_lane: call.lane === "women" });
  return { ok: true, duplicate: !created };
}

// ── steps ─────────────────────────────────────────────────────────────────────────────────────────────────────────
async function callFacts(env: Env, callId: string): Promise<CallFacts | null> {
  return env.DB_META.prepare("SELECT caller_uid AS fan_uid, host_uid, lane, connected_at, created_at FROM hf_calls WHERE id=?1").bind(callId).first<CallFacts>().catch(() => null);
}

async function setRec(env: Env, id: string, set: string, ...binds: unknown[]): Promise<void> {
  await env.DB_META.prepare(`UPDATE hf_call_recordings SET ${set}, updated_at=? WHERE id=?`).bind(...binds, Date.now(), id).run();
}

export async function stepCopy(env: Env, rec: RecRow, cfg: SafetyCfg): Promise<void> {
  if (!env.DIGITAL) throw new Error("private_bucket_missing");
  let url = rec.vobiz_url;
  let dur = rec.duration_sec;
  if (!url) {
    const meta = await getRecordingMeta(env, rec.recording_id);
    url = meta?.url ?? null; dur = dur ?? meta?.durationSec ?? null;
    if (!url) throw new Error("recording_url_unknown");
  }
  const buf = await downloadRecording(env, url);
  const key = audioKey(rec.call_id, rec.recording_id);
  await env.DIGITAL.put(key, buf, { httpMetadata: { contentType: sniffAudioMime(buf) }, customMetadata: { call: rec.call_id } });
  const head = await env.DIGITAL.head(key);
  if (!head || head.size !== buf.byteLength) throw new Error("r2_copy_unverified");
  // Until the review decides, the audio is bounded by the flagged-audio window so it can never sit forever.
  await setRec(env, rec.id, "status='copied', r2_key=?, bytes=?, duration_sec=COALESCE(?, duration_sec), audio_expires_at=?", key, buf.byteLength, dur, Date.now() + cfg.flaggedAudioDays * DAY_MS);
  rec.status = "copied"; rec.r2_key = key; rec.bytes = buf.byteLength; rec.duration_sec = dur;
  // Our copy is verified: delete the original at Vobiz (stops its storage charge and the exposure).
  if (await deleteVobizRecording(env, rec.recording_id)) {
    await setRec(env, rec.id, "vobiz_deleted_at=?", Date.now());
    rec.vobiz_deleted_at = Date.now();
  }
}

export async function stepTranscribe(env: Env, rec: RecRow, cfg: SafetyCfg, stt: SttProvider = pickStt(env)): Promise<void> {
  const facts = await callFacts(env, rec.call_id);
  if (!facts) { await dropAudio(env, rec, "no_call"); await setRec(env, rec.id, "status='skipped'"); rec.status = "skipped"; return; }
  if (rec.duration_sec != null && rec.duration_sec < 5) { await dropAudio(env, rec, "too_short"); await setRec(env, rec.id, "status='skipped'"); rec.status = "skipped"; return; }
  if (!rec.r2_key) throw new Error("no_audio");
  const obj = await env.DIGITAL.get(rec.r2_key);
  if (!obj) throw new Error("audio_missing");
  const audio = await obj.arrayBuffer();
  const res = await stt.transcribe(env, audio, sniffAudioMime(audio), { callId: rec.call_id, uid: facts.fan_uid });
  const now = Date.now();
  const stored: StoredLine[] = res.lines.map((l, i) => ({ ...l, c: Math.round((res.lineConf[i] ?? 0) * 100) / 100 }));
  const dur = rec.duration_sec ?? (stored.length ? stored[stored.length - 1].sec + 5 : null);
  await env.DB_META.prepare(
    `INSERT INTO hf_call_reviews (id, call_id, recording_id, kind, fan_uid, host_uid, women_lane, verdict, score, status, lines_json, provider, model, duration_sec, call_at, transcript_expires_at, created_at, updated_at)
     VALUES (?1,?2,?3,'review',?4,?5,?6,'clean',0,'clean',?7,?8,?9,?10,?11,?12,?13,?13)
     ON CONFLICT(call_id, kind) DO UPDATE SET lines_json=excluded.lines_json, recording_id=excluded.recording_id, duration_sec=excluded.duration_sec, updated_at=excluded.updated_at`,
  ).bind(crypto.randomUUID(), rec.call_id, rec.recording_id, facts.fan_uid, facts.host_uid, facts.lane === "women" ? 1 : rec.women_lane, JSON.stringify(stored),
    res.provider, res.model, dur, facts.connected_at ?? facts.created_at, now + cfg.cleanTranscriptDays * DAY_MS, now).run();
  await setRec(env, rec.id, "status='transcribed', duration_sec=COALESCE(duration_sec, ?)", dur);
  rec.status = "transcribed";
}

async function dropAudio(env: Env, rec: RecRow, why: string): Promise<void> {
  if (rec.r2_key) {
    await env.DIGITAL.delete(rec.r2_key).catch(() => undefined);
    await stTrack(env, "system", "hf_audio_deleted", { call_id: rec.call_id, why, bytes: rec.bytes ?? 0 });
  }
  await setRec(env, rec.id, "r2_key=NULL, bytes=NULL, audio_expires_at=NULL");
  rec.r2_key = null;
}

async function reportedCall(env: Env, callId: string): Promise<boolean> {
  try { return !!(await env.DB_META.prepare("SELECT 1 AS x FROM hf_call_reports WHERE call_id=?1 LIMIT 1").bind(callId).first()); } catch { return false; }
}

export async function stepDecide(env: Env, rec: RecRow, cfg: SafetyCfg, chain?: DecisionProvider[]): Promise<{ verdict: Verdict; action: string } | null> {
  const rev = await env.DB_META.prepare("SELECT id, fan_uid, host_uid, women_lane, lines_json, duration_sec, call_at FROM hf_call_reviews WHERE call_id=?1 AND kind='review'").bind(rec.call_id)
    .first<{ id: string; fan_uid: string; host_uid: string; women_lane: number; lines_json: string | null; duration_sec: number | null; call_at: number | null }>();
  if (!rev) throw new Error("review_row_missing");
  const stored = parseStoredLines(rev.lines_json);
  const lines: Line[] = stored.map(({ sec, t, speaker, text }) => ({ sec, t, speaker, text }));
  const conf = stored.map((l) => Number(l.c ?? 0));
  const d: DecisionResult = await decideWithFallback(env, lines, conf, { callId: rec.call_id, uid: rev.fan_uid }, chain);
  const verdict: Verdict = d.score >= cfg.queueScore ? d.verdict : "clean";
  const outcome = decideOutcome({ verdict, score: d.score, speaker: d.speaker, speakerScore: d.speakerScore }, cfg);
  const reported = await reportedCall(env, rec.call_id);
  const flagged = outcome.action !== "none" || reported;
  const ret = retentionFor({ flagged, now: Date.now() }, cfg);
  const target = d.speaker ? targetUid(d.speaker, rev.fan_uid, rev.host_uid) : null;
  const fl = d.flaggedIdx != null ? lines[d.flaggedIdx] : null;
  const kind = outcome.action === "danger" ? "danger" : "review";
  const status = outcome.action === "none" ? "clean" : outcome.action === "strike" ? "struck" : "queued";
  const now = Date.now();
  await env.DB_META.prepare(
    `UPDATE hf_call_reviews SET kind=?2, verdict=?3, score=?4, speaker=?5, speaker_score=?6, target_uid=?7, flagged_idx=?8, flagged_sec=?9, summary=?10, provider=?11, model=?12,
       status=?13, transcript_expires_at=?14, updated_at=?15 WHERE id=?1`,
  ).bind(rev.id, kind, verdict, d.score, d.speaker, d.speakerScore, target, d.flaggedIdx, fl ? fl.sec : null, summaryFor(verdict), d.provider, d.model, status, ret.transcriptExpiresAt, now).run();

  if (outcome.action === "strike" && target && d.speaker && verdict !== "clean") {
    await giveStrike(env, { uid: target, role: d.speaker, callId: rec.call_id, reviewId: rev.id, reason: verdict as StrikeReason, quote: fl?.text ?? null, auto: true, byUid: null }, cfg);
  }
  if (outcome.action === "danger") {
    void sendAdminAlert(env, `URGENT ${BRAND.name} safety: a call was flagged as DANGER. Open Safety > Review now: ${brandUrl("/admin/safety")}`).catch(() => undefined); // not held for quiet hours
    if (outcome.autoPause && target) await pauseAccount(env, target, "danger", null, cfg);
  }
  // retention: clean audio goes now; flagged audio is kept
  if (flagged) await setRec(env, rec.id, "flagged=1, audio_expires_at=?", ret.audioExpiresAt);
  else await dropAudio(env, rec, "clean");
  await setRec(env, rec.id, "status='done', last_error=NULL");
  rec.status = "done";
  await stTrack(env, rev.fan_uid, "hf_call_checked", {
    call_id: rec.call_id, verdict, score: Math.round(d.score * 1000) / 1000, speaker: d.speaker, speaker_score: Math.round(d.speakerScore * 1000) / 1000,
    outcome: outcome.action, provider: d.provider, model: d.model, flagged, reported, women_lane: rev.women_lane === 1, host_uid: rev.host_uid, fan_uid: rev.fan_uid,
  });
  return { verdict, action: outcome.action };
}

// ── job loop ──────────────────────────────────────────────────────────────────────────────────────────────────────
async function failStep(env: Env, rec: RecRow, step: string, e: unknown): Promise<void> {
  const attempts = rec.attempts + 1;
  const terminal = attempts >= MAX_ATTEMPTS;
  await env.DB_META.prepare("UPDATE hf_call_recordings SET attempts=?2, next_attempt_at=?3, last_error=?4, status=CASE WHEN ?5=1 THEN 'failed' ELSE status END, updated_at=?6 WHERE id=?1")
    .bind(rec.id, attempts, Date.now() + BACKOFF_MS(attempts), `${step}:${String(e)}`.slice(0, 300), terminal ? 1 : 0, Date.now()).run().catch(() => undefined);
  await stFail(env, e, step, { call_id: rec.call_id, attempts, terminal });
  await stTrack(env, "system", "hf_recording_failed", { call_id: rec.call_id, step, attempts, terminal, reason: String(e).slice(0, 120) });
  rec.attempts = attempts;
}

export async function advanceRecording(env: Env, rec: RecRow, cfg: SafetyCfg, deps: { stt?: SttProvider; chain?: DecisionProvider[] } = {}): Promise<boolean> {
  try {
    if (rec.status === "received") await stepCopy(env, rec, cfg);
    if (rec.status === "copied") {
      if (!cfg.reviewEnabled) return true; // recorded and kept (bounded by the flagged-audio window) until review is switched on
      await stepTranscribe(env, rec, cfg, deps.stt);
    }
    if (rec.status === "transcribed") await stepDecide(env, rec, cfg, deps.chain);
    return true;
  } catch (e) {
    await failStep(env, rec, rec.status === "received" ? "copy" : rec.status === "copied" ? "transcribe" : "decide", e);
    return false;
  }
}

async function throttledOwnerAlert(env: Env, key: string, ttlSec: number, text: string): Promise<boolean> {
  try {
    if (await env.TOKENS.get(key)) return false;
    await env.TOKENS.put(key, "1", { expirationTtl: ttlSec });
  } catch { /* if KV is down, alert anyway */ }
  return sendAdminAlert(env, text).catch(() => false);
}

export interface SafetyCronSummary { jobs: number; ok: number; failed: number; vobizDeleted: number; notices: number; ownerAlerts: number }
export async function runHfSafetyCron(env: Env, now = Date.now()): Promise<SafetyCronSummary> {
  const s: SafetyCronSummary = { jobs: 0, ok: 0, failed: 0, vobizDeleted: 0, notices: 0, ownerAlerts: 0 };
  const cfg = await loadSafetyCfg(env);
  let rows: RecRow[] = [];
  try {
    rows = (await env.DB_META.prepare(
      "SELECT id, call_id, recording_id, vobiz_url, duration_sec, status, r2_key, bytes, women_lane, flagged, attempts, vobiz_deleted_at FROM hf_call_recordings WHERE status IN ('received','copied','transcribed') AND next_attempt_at<=?1 AND attempts<?2 ORDER BY created_at LIMIT 3",
    ).bind(now, MAX_ATTEMPTS).all<RecRow>()).results ?? [];
  } catch { return s; } // migration not applied: nothing to do
  for (const rec of rows) {
    s.jobs++;
    if (await advanceRecording(env, rec, cfg)) s.ok++; else s.failed++;
  }
  // originals still at Vobiz whose copy is safe in R2
  try {
    const pend = (await env.DB_META.prepare("SELECT id, recording_id FROM hf_call_recordings WHERE r2_key IS NOT NULL AND vobiz_deleted_at IS NULL LIMIT 5").all<{ id: string; recording_id: string }>()).results ?? [];
    for (const p of pend) if (await deleteVobizRecording(env, p.recording_id)) { await setRec(env, p.id, "vobiz_deleted_at=?", Date.now()); s.vobizDeleted++; }
  } catch { /* ignore */ }
  s.notices = await drainNotices(env, now).catch(() => 0);
  s.ownerAlerts = await ownerAlerts(env, now, s).catch(() => 0);
  await banPayoutFollowUp(env).catch(() => undefined);
  return s;
}

/** Owner WhatsApp: a queue item older than 24 h (once a day), job failures (max hourly). */
async function ownerAlerts(env: Env, now: number, s: SafetyCronSummary): Promise<number> {
  let sent = 0;
  const day = new Date(now + 5.5 * HOUR_MS).toISOString().slice(0, 10);
  const old = await env.DB_META.prepare(
    "SELECT (SELECT COUNT(*) FROM hf_call_reviews WHERE status='queued' AND created_at<?1) + (SELECT COUNT(*) FROM hf_appeals WHERE status='open' AND created_at<?1) AS n",
  ).bind(now - 24 * HOUR_MS).first<{ n: number }>().catch(() => null);
  if (old && Number(old.n) > 0 && (await throttledOwnerAlert(env, `hf_safety_old:${day}`, 2 * 24 * 3600, `${BRAND.name} safety: ${old.n} item(s) have waited more than 24 hours for a decision. Open Safety > Review.`))) sent++;
  const failing = await env.DB_META.prepare("SELECT COUNT(*) AS n FROM hf_call_recordings WHERE status='failed' OR (attempts>=2 AND status IN ('received','copied','transcribed'))").first<{ n: number }>().catch(() => null);
  if (failing && Number(failing.n) > 0 && (s.failed > 0 || Number(failing.n) > 0) && (await throttledOwnerAlert(env, `hf_safety_fail:${Math.floor(now / HOUR_MS)}`, 2 * 3600, `${BRAND.name} safety: ${failing.n} call review job(s) are failing. Check the worker logs (area hf_call_safety).`))) sent++;
  return sent;
}

// ── notices: push + WhatsApp (paced outbox) + email, one row each, never throws ───────────────────────────────────────
export async function drainNotices(env: Env, now = Date.now(), limit = 30): Promise<number> {
  const rows = (await env.DB_META.prepare("SELECT id, uid, event, title, body, path FROM hf_safety_notices WHERE sent_at IS NULL AND send_after<=?1 ORDER BY send_after LIMIT ?2")
    .bind(now, limit).all<{ id: string; uid: string; event: string; title: string; body: string; path: string | null }>().catch(() => ({ results: [] }))).results ?? [];
  let n = 0;
  for (const r of rows) {
    const claim = await env.DB_META.prepare("UPDATE hf_safety_notices SET sent_at=?2 WHERE id=?1 AND sent_at IS NULL").bind(r.id, now).run();
    if (!Number(claim.meta?.changes ?? 0)) continue;
    n++;
    const res: Record<string, string> = {};
    try { res.push = (await sendHfPush(env, r.uid, { kind: "safety", title: r.title, body: r.body, path: r.path ?? "/dashboard/safety" })) ? "queued" : "skipped"; } catch { res.push = "failed"; }
    try {
      const e164 = await verifiedWhatsAppNumber(env, r.uid);
      if (!e164) res.whatsapp = "no_verified_whatsapp";
      else {
        const w = await env.DB_META.prepare(
          `INSERT OR IGNORE INTO whatsapp_outbox (checkout_id, uid, listing_id, kind, url_hash, e164, message, status, attempts, created_at, updated_at)
           VALUES (?1,?2,?3,'hf_safety',?4,?5,?6,'queued',0,?7,?7)`,
        ).bind(`hfs:${r.id}`, r.uid, r.id, (await sha256Hex(r.event)).slice(0, 16), e164, `${r.title}\n${r.body}\n— ${BRAND.name}`, now).run();
        res.whatsapp = w.meta?.changes ? "queued" : "duplicate";
      }
    } catch { res.whatsapp = "failed"; }
    try {
      const email = realEmailOrNull(await emailFor(env, r.uid).catch(() => null));
      if (!email) res.email = "no_email";
      else {
        const q = await enqueueEmail(env, { to: email, subject: r.title, html: messageEmailHtml(r.title, r.body), outboxKey: `hfs:${r.id}`, kind: "hf_safety", orderId: r.id, recipientId: r.uid, replyTo: { email: BRAND.emails.support, name: BRAND.name } });
        res.email = q.status === "failed" || q.status === "bounced" || q.status === "unavailable" ? "failed" : q.queued ? "queued" : "duplicate";
      }
    } catch { res.email = "failed"; }
    for (const [channel, result] of Object.entries(res)) await stTrack(env, r.uid, "hf_safety_notice_sent", { event: r.event, channel, result, notice_id: r.id });
  }
  return n;
}

/** Banned influencers whose earnings were still maturing: pay out what has matured, daily, until nothing is left. */
async function banPayoutFollowUp(env: Env): Promise<void> {
  const rows = (await env.DB_META.prepare("SELECT uid FROM hf_mod_state WHERE status='banned' AND payout_pending=1 AND updated_at<?1 LIMIT 10").bind(Date.now() - 6 * HOUR_MS).all<{ uid: string }>().catch(() => ({ results: [] }))).results ?? [];
  for (const r of rows) {
    await executeBanMoney(env, r.uid, "system", false);
    if ((await heldEarningsPaise(env, r.uid)) <= 0) await env.DB_META.prepare("UPDATE hf_mod_state SET payout_pending=0 WHERE uid=?1").bind(r.uid).run();
    else await env.DB_META.prepare("UPDATE hf_mod_state SET updated_at=?2 WHERE uid=?1").bind(r.uid, Date.now()).run();
  }
}

// ── a party's report on a call ───────────────────────────────────────────────────────────────────────────────────────
export async function fileReport(env: Env, uid: string, callId: string, reasons: string[], note: string | null): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const call = await env.DB_META.prepare("SELECT caller_uid, host_uid, lane, status FROM hf_calls WHERE id=?1").bind(callId).first<{ caller_uid: string; host_uid: string; lane: string | null; status: string }>().catch(() => null);
  if (!call || (call.caller_uid !== uid && call.host_uid !== uid)) return { ok: false, status: 404, error: "not_found" };
  const clean = [...new Set(reasons.filter(isReportReason))];
  if (!clean.length) return { ok: false, status: 400, error: "invalid_reasons" };
  const cfg = await loadSafetyCfg(env);
  const now = Date.now();
  await env.DB_META.prepare("INSERT OR IGNORE INTO hf_call_reports (id, call_id, reporter_uid, reasons_json, note, created_at) VALUES (?1,?2,?3,?4,?5,?6)")
    .bind(crypto.randomUUID(), callId, uid, JSON.stringify(clean), note ? note.slice(0, 500) : null, now).run();
  // keep the audio (if it still exists) for the flagged-audio window
  await env.DB_META.prepare("UPDATE hf_call_recordings SET flagged=1, audio_expires_at=?2, updated_at=?3 WHERE call_id=?1 AND r2_key IS NOT NULL").bind(callId, now + cfg.flaggedAudioDays * DAY_MS, now).run().catch(() => undefined);
  // queue the call for an employee (about the OTHER person); one report row per call
  const other = call.caller_uid === uid ? call.host_uid : call.caller_uid;
  const verdict = REPORT_VERDICT[clean[0]];
  await env.DB_META.prepare(
    `INSERT OR IGNORE INTO hf_call_reviews (id, call_id, kind, fan_uid, host_uid, women_lane, verdict, score, speaker, speaker_score, target_uid, summary, status, call_at, transcript_expires_at, created_at, updated_at)
     VALUES (?1,?2,'fan_report',?3,?4,?5,?6,0,?7,0,?8,?9,'queued',?10,?11,?12,?12)`,
  ).bind(crypto.randomUUID(), callId, call.caller_uid, call.host_uid, call.lane === "women" ? 1 : 0, verdict, call.caller_uid === uid ? "influencer" : "fan", other,
    `Reported by the other person: ${REASON_TEXT[verdict]}`, now, now + 365 * DAY_MS, now).run();
  // a transcript that exists should now live a year (flagged), not 30 days
  await env.DB_META.prepare("UPDATE hf_call_reviews SET transcript_expires_at=MAX(COALESCE(transcript_expires_at,0), ?2) WHERE call_id=?1").bind(callId, now + 365 * DAY_MS).run().catch(() => undefined);
  await stTrack(env, uid, "hf_call_report", { call_id: callId, reasons: clean, reporter_role: call.caller_uid === uid ? "fan" : "influencer", other_uid: other });
  return { ok: true };
}

export { strikeExpiresAt, queueNotice };
export type { SpeakerRole };
