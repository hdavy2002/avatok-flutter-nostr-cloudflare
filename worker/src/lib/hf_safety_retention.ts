// [HF-CALL-SAFETY-BE] Retention for call-safety data (contract rule 9), run from hf_retention.ts once per IST day:
//   clean call audio is deleted right after transcription (the pipeline does it; this sweep is the backstop)
//   flagged / reported audio: hfFlaggedAudioDays (30)      transcript: hfCleanTranscriptDays (30) clean, 1 year flagged
//   verdicts, strikes, appeals, decisions, access log, reports: 1 year
import type { Env } from "../types";
import { loadSafetyCfg, stTrack } from "./hf_safety_store";
import { YEAR_MS, DAY_MS } from "./hf_safety_rules";

const BATCH = 200;
const MAX_BATCHES = 5;

async function deleteBatched(env: Env, table: string, where: string, binds: unknown[]): Promise<{ n: number; more: boolean }> {
  let n = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const r = await env.DB_META.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${BATCH})`).bind(...binds).run();
    const c = Number(r.meta?.changes ?? 0);
    n += c;
    if (c < BATCH) return { n, more: false };
  }
  return { n, more: true };
}

export interface SafetyRetentionSummary { audio: number; transcripts: number; verdicts: number; strikes: number; appeals: number; access_log: number; reports: number; recordings: number; notices: number; more: boolean }

export async function runSafetyRetention(env: Env, now = Date.now()): Promise<SafetyRetentionSummary> {
  const s: SafetyRetentionSummary = { audio: 0, transcripts: 0, verdicts: 0, strikes: 0, appeals: 0, access_log: 0, reports: 0, recordings: 0, notices: 0, more: false };
  const cutoff = now - YEAR_MS;
  void (await loadSafetyCfg(env)); // flags are read where the dates are written; the sweep only enforces the stored dates

  // 1. audio past its date -> delete the R2 object, keep the row
  let bytes = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const rows = (await env.DB_META.prepare("SELECT id, r2_key, bytes FROM hf_call_recordings WHERE r2_key IS NOT NULL AND audio_expires_at IS NOT NULL AND audio_expires_at<?1 LIMIT 50").bind(now)
      .all<{ id: string; r2_key: string; bytes: number | null }>().catch(() => ({ results: [] }))).results ?? [];
    for (const r of rows) {
      await env.DIGITAL.delete(r.r2_key).catch(() => undefined);
      await env.DB_META.prepare("UPDATE hf_call_recordings SET r2_key=NULL, bytes=NULL, audio_expires_at=NULL, status=CASE WHEN status IN ('received','copied','transcribed') THEN 'deleted' ELSE status END, updated_at=?2 WHERE id=?1").bind(r.id, now).run();
      bytes += Number(r.bytes ?? 0);
      s.audio++;
    }
    if (rows.length < 50) break;
    if (i === MAX_BATCHES - 1) s.more = true;
  }
  if (s.audio) await stTrack(env, "system", "hf_audio_deleted", { why: "retention", count: s.audio, bytes });

  // 2. transcripts past their date -> blank the text, keep the verdict
  for (let i = 0; i < MAX_BATCHES; i++) {
    const r = await env.DB_META.prepare("UPDATE hf_call_reviews SET lines_json=NULL, updated_at=?1 WHERE rowid IN (SELECT rowid FROM hf_call_reviews WHERE lines_json IS NOT NULL AND transcript_expires_at IS NOT NULL AND transcript_expires_at<?1 LIMIT ?2)")
      .bind(now, BATCH).run().catch(() => null);
    const c = Number(r?.meta?.changes ?? 0);
    s.transcripts += c;
    if (c < BATCH) break;
    if (i === MAX_BATCHES - 1) s.more = true;
  }

  // 3. one year: verdicts / decisions, strikes (+ their appeals), the access log, reports, finished recording rows, sent notices (90 days)
  const steps: Array<[keyof SafetyRetentionSummary, string, string, unknown[]]> = [
    ["verdicts", "hf_call_reviews", "created_at<?1", [cutoff]],
    ["appeals", "hf_appeals", "strike_id IN (SELECT id FROM hf_strikes WHERE created_at<?1)", [cutoff]],
    ["strikes", "hf_strikes", "created_at<?1", [cutoff]],
    ["access_log", "hf_review_access_log", "created_at<?1", [cutoff]],
    ["reports", "hf_call_reports", "created_at<?1", [cutoff]],
    ["recordings", "hf_call_recordings", "created_at<?1 AND r2_key IS NULL", [cutoff]],
    ["notices", "hf_safety_notices", "sent_at IS NOT NULL AND created_at<?1", [now - 90 * DAY_MS]],
  ];
  for (const [key, table, where, binds] of steps) {
    try { const r = await deleteBatched(env, table, where, binds); (s[key] as number) += r.n; if (r.more) s.more = true; } catch { /* table missing: nothing to purge */ }
  }
  return s;
}
