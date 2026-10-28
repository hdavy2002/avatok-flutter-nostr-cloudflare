// [HF-CALL-SAFETY-BE] Pure rules for call safety: verdicts, thresholds, strikes, expiry, retention, quiet hours, clip windows.
// No I/O and no Env, so every rule unit-tests without a Worker. Owner rules: Specs/HF-CALL-SAFETY-1.md (and the shared contract).

export const VERDICTS = ["clean", "selling", "outside_payment", "contact_sharing", "abuse", "sexual", "danger"] as const;
export type Verdict = (typeof VERDICTS)[number];
export type StrikeReason = Exclude<Verdict, "clean">;
export const STRIKE_REASONS: readonly StrikeReason[] = ["selling", "outside_payment", "contact_sharing", "abuse", "sexual", "danger"];
export type SpeakerRole = "fan" | "influencer";

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const PAUSE_REVIEW_HOURS = 72; // a pause is reviewed by an employee within this long (shown as reviewDueAt)

export const isVerdict = (v: unknown): v is Verdict => typeof v === "string" && (VERDICTS as readonly string[]).includes(v);
export const isStrikeReason = (v: unknown): v is StrikeReason => typeof v === "string" && (STRIKE_REASONS as readonly string[]).includes(v);

/** What the person is told the strike was for. Never quotes or names anyone else. */
export const REASON_TEXT: Record<StrikeReason, string> = {
  selling: "Selling something or promoting a sale on a call",
  outside_payment: "Asking for or arranging payment outside the app",
  contact_sharing: "Sharing or asking for a phone number, UPI ID or address",
  abuse: "Abusive or disrespectful language",
  sexual: "Sexual or inappropriate talk",
  danger: "Something that put a person at risk",
};

// ── config ───────────────────────────────────────────────────────────────────────────────────────────────────
export interface SafetyCfg {
  recordingEnabled: boolean; reviewEnabled: boolean; autoStrikeEnabled: boolean;
  highScore: number; queueScore: number; strikesToPause: number; expiryDays: number;
  flaggedAudioDays: number; cleanTranscriptDays: number; rulesVersion: number;
}
const num = (v: unknown, d: number, lo: number, hi: number): number => {
  const n = typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
/** Reads the contract flags from the platform config (or any object). Out-of-range values fall back to the contract defaults. */
export function safetyCfg(c: Record<string, unknown> | null | undefined): SafetyCfg {
  const x = c ?? {};
  const high = num(x.hfStrikeHighScore, 0.9, 0.5, 1);
  const queue = Math.min(num(x.hfStrikeQueueScore, 0.6, 0.05, 1), high);
  return {
    recordingEnabled: x.hfCallRecordingEnabled === true,
    reviewEnabled: x.hfCallReviewEnabled === true,
    autoStrikeEnabled: x.hfAutoStrikeEnabled === true,
    highScore: high, queueScore: queue,
    strikesToPause: Math.round(num(x.hfStrikesToPause, 3, 1, 20)),
    expiryDays: Math.round(num(x.hfStrikeExpiryDays, 90, 1, 3650)),
    flaggedAudioDays: Math.round(num(x.hfFlaggedAudioDays, 30, 1, 3650)),
    cleanTranscriptDays: Math.round(num(x.hfCleanTranscriptDays, 30, 1, 3650)),
    rulesVersion: Math.round(num(x.hfCallRulesVersion, 1, 1, 100000)),
  };
}

// ── the decision ladder (contract rule 5) ──────────────────────────────────────────────────────────────────────
export interface Finding { verdict: Verdict; score: number; speaker: SpeakerRole | null; speakerScore: number }
export type Outcome =
  | { action: "none" }                                       // clean, or below the queue score: the score is still saved
  | { action: "queue" }                                      // an employee looks (queue score <= score < high, or not sure who spoke, or auto strikes are off)
  | { action: "strike" }                                     // automatic strike on the speaker
  | { action: "danger"; autoPause: boolean };                // urgent owner alert; pause now only when automatic actions are on

export function decideOutcome(f: Finding, cfg: SafetyCfg): Outcome {
  if (f.verdict === "clean" || !(f.score >= cfg.queueScore)) return { action: "none" };
  if (f.verdict === "danger") return { action: "danger", autoPause: cfg.autoStrikeEnabled && f.speaker != null && f.speakerScore >= cfg.highScore };
  if (f.score >= cfg.highScore && cfg.autoStrikeEnabled && f.speaker != null && f.speakerScore >= cfg.highScore) return { action: "strike" };
  return { action: "queue" };
}

// ── strikes (contract rule 6) ──────────────────────────────────────────────────────────────────────────────────
export interface StrikeLite { removedAt: number | null; expiresAt: number }
export const strikeIsActive = (s: StrikeLite, now: number): boolean => s.removedAt == null && s.expiresAt > now;
export const activeStrikeCount = (list: StrikeLite[], now: number): number => list.filter((s) => strikeIsActive(s, now)).length;
export const strikeExpiresAt = (createdAt: number, expiryDays: number): number => createdAt + expiryDays * DAY_MS;
/** Pause when the person reaches the limit. */
export const shouldPause = (activeCount: number, strikesToPause: number): boolean => activeCount >= strikesToPause;
/** Warn on the strike just before the pause (the 2nd of 3). */
export const isWarningStrike = (activeCount: number, strikesToPause: number): boolean => strikesToPause > 1 && activeCount === strikesToPause - 1;
/** A strike can be appealed once, while it is still active. */
export const canAppealStrike = (s: StrikeLite & { appealStatus: string | null }, now: number): boolean => strikeIsActive(s, now) && s.appealStatus == null;

// ── retention (contract rule 9) ─────────────────────────────────────────────────────────────────────────────────
export const YEAR_MS = 365 * DAY_MS;
export interface RetentionDates { audioExpiresAt: number | null; transcriptExpiresAt: number; verdictExpiresAt: number }
/** Clean audio is deleted right after transcription (null); flagged audio is kept hfFlaggedAudioDays; transcript 30 days clean / 1 year flagged; verdicts and decisions 1 year. */
export function retentionFor(a: { flagged: boolean; now: number }, cfg: SafetyCfg): RetentionDates {
  return {
    audioExpiresAt: a.flagged ? a.now + cfg.flaggedAudioDays * DAY_MS : null,
    transcriptExpiresAt: a.now + (a.flagged ? YEAR_MS : cfg.cleanTranscriptDays * DAY_MS),
    verdictExpiresAt: a.now + YEAR_MS,
  };
}

// ── quiet hours (8 am to 11 pm IST except owner danger alerts) ───────────────────────────────────────────────────
const IST_MS = 5.5 * HOUR_MS;
export function istHour(ms: number): number { return new Date(ms + IST_MS).getUTCHours(); }
export const inQuietHours = (ms: number): boolean => { const h = istHour(ms); return h < 8 || h >= 23; };
/** The first moment at or after `ms` outside quiet hours (08:00 IST). */
export function nextSendTime(ms: number): number {
  if (!inQuietHours(ms)) return ms;
  const ist = new Date(ms + IST_MS);
  const h = ist.getUTCHours();
  const eightToday = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 8, 0, 0) - IST_MS;
  return h < 8 ? eightToday : eightToday + DAY_MS;
}

// ── transcript helpers ───────────────────────────────────────────────────────────────────────────────────────────
export interface Line { sec: number; t: string; speaker: SpeakerRole | "unknown"; text: string }
export const fmtClock = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
/** Index range the admin may see by default: the flagged line and two lines each side. */
export function adminWindow(total: number, flaggedIdx: number | null, pad = 2): { from: number; to: number } {
  if (flaggedIdx == null || flaggedIdx < 0 || flaggedIdx >= total) return { from: 0, to: -1 };
  return { from: Math.max(0, flaggedIdx - pad), to: Math.min(total - 1, flaggedIdx + pad) };
}
/** 15 seconds of audio around a second mark, inside the call. */
export function clipRange(flaggedSec: number | null, durationSec: number | null, windowSec = 15): { startSec: number; endSec: number } | null {
  if (flaggedSec == null || !durationSec || durationSec <= windowSec) return null;
  const start = Math.min(Math.max(0, flaggedSec - windowSec / 2), durationSec - windowSec);
  return { startSec: start, endSec: start + windowSec };
}
/** Byte range for a constant-bit-rate recording. MP3 players resync on the next frame, so an approximate start is fine. */
export function clipBytes(bytes: number, durationSec: number, r: { startSec: number; endSec: number }): { offset: number; length: number } {
  const per = bytes / Math.max(1, durationSec);
  const offset = Math.max(0, Math.floor(r.startSec * per));
  return { offset, length: Math.max(1, Math.min(bytes - offset, Math.ceil((r.endSec - r.startSec) * per))) };
}

/** Which user a finding is about: the speaker. */
export function targetUid(speaker: SpeakerRole | null, fanUid: string, hostUid: string): string | null {
  return speaker === "fan" ? fanUid : speaker === "influencer" ? hostUid : null;
}

/** A fan's report reasons -> a verdict. */
export const REPORT_REASONS = ["selling", "outside_payment", "asked_number", "abusive"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const REPORT_VERDICT: Record<ReportReason, StrikeReason> = { selling: "selling", outside_payment: "outside_payment", asked_number: "contact_sharing", abusive: "abuse" };
export const isReportReason = (v: unknown): v is ReportReason => typeof v === "string" && (REPORT_REASONS as readonly string[]).includes(v);

/** Pick the strongest category from per-category probabilities. Ties go to the more serious category. */
const SEVERITY: Record<StrikeReason, number> = { danger: 6, sexual: 5, abuse: 4, outside_payment: 3, contact_sharing: 2, selling: 1 };
export function strongestCategory(p: Partial<Record<StrikeReason, number>>): { verdict: Verdict; score: number } {
  let best: StrikeReason | null = null, score = 0;
  for (const r of STRIKE_REASONS) {
    const v = Math.min(1, Math.max(0, Number(p[r] ?? 0)));
    if (v > score || (v === score && v > 0 && best && SEVERITY[r] > SEVERITY[best])) { best = r; score = v; }
  }
  return best ? { verdict: best, score } : { verdict: "clean", score: 0 };
}
