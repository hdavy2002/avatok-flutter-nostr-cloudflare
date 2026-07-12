// [AVA-SPAM-3] Deterministic community spam scoring — Phase 2a.
//
// Spec: Specs/PLAN-2026-07-12-home-ava-tok-services-shell.md §4.4. Whether a REAL
// phone number is marked a scammer must be EXPLAINABLE, REPRODUCIBLE and APPEALABLE,
// so the verdict is a *versioned deterministic weighted formula* over aggregate
// signals — NEVER an LLM decision. AI's only role upstream is classifying optional
// free-text report reasons into `reason_category` (scam/telemarketer/robocall),
// which enters here as ONE weighted input. Given the same inputs + FORMULA_VERSION,
// scoreNumber() always returns the same {score,label} — a red verdict can be replayed
// from its stored inputs during a dispute.
//
// Pure module: no I/O, no env, no Date.now() (caller passes `now`). Unit-checkable —
// see scoring.test.ts.

export const FORMULA_VERSION = "v1";

// Thresholds. NOTE (spec §4.4): these SHOULD later move to config flags
// (`spamRedThreshold` / `spamCautionThreshold` in routes/config.ts DEFAULTS) so they
// can be tuned in KV without a redeploy. Hard-coded here for v1 until the flags land.
export const RED_THRESHOLD = 70; // score >= 70 → 'red' (known spammer)
export const CAUTION_THRESHOLD = 30; // score >= 30 → 'caution' ("reported by K users")

// Consensus: a number can only reach RED with >= this many DISTINCT spam reporters
// (weighted trust still governs the magnitude). A single report NEVER marks spam.
export const RED_MIN_REPORTERS = 5;

// New accounts start LOW so brigading (a burst of fresh accounts) barely moves a
// score; trust rises with agreement history (see computeReporterTrust).
export const BASE_TRUST = 0.3;
export const MIN_TRUST = 0.05;
export const MAX_TRUST = 1.0;

// Report age decay — carriers recycle numbers, so old reports fade. Half-life 90d.
export const DECAY_HALF_LIFE_DAYS = 90;

// Saturation constant: score = 100 * (1 - exp(-K * netWeighted)). Tuned so that
// ~5 fresh, average-trust (0.5) spam reporters ⇒ netWeighted ≈ 2.5 ⇒ ~71 (red),
// while ~5 fresh LOW-trust (0.3) reporters ⇒ ≈1.5 ⇒ ~53 (caution, not red).
export const K_SATURATION = 0.5;

// Redemption: not_spam reports subtract from the weighted spam mass so a
// wrongly-flagged number can recover (dispute/unblock path).
export const REDEMPTION_FACTOR = 1.0;

// Report velocity (last 7d) is a minor additive booster (fresh brigades already
// captured by decay≈1; this nudges bursty active campaigns). Small + capped so it
// can never by itself cross a threshold.
export const VELOCITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const VELOCITY_WEIGHT = 0.03;
export const VELOCITY_CAP = 10;

// Reason-category weights (AI-classified free text → one input). Modest multipliers.
export const REASON_WEIGHTS: Record<string, number> = {
  scam: 1.25,
  robocall: 1.15,
  harassment: 1.1,
  telemarketer: 1.0,
  other: 1.0,
};

export type Verdict = "spam" | "not_spam";
export type SpamLabel = "red" | "caution" | "none";

export interface ReportInput {
  reporterUid: string;
  trust: number; // reporter_trust 0..1 (defaults handled by caller)
  verdict: Verdict;
  reasonCategory?: string | null;
  createdMs: number;
}

// Behavioral signals — PLACEHOLDERS for v1 (all default 0, documented). When the
// native telecom layer lands (line type, number age, mass short-call pattern) these
// become real weighted inputs WITHOUT changing the formula shape — bump FORMULA_VERSION
// when their weights go live so old verdicts stay replayable under 'v1'.
export interface BehavioralInput {
  voipLine?: number; // 0..1 — number is a VoIP/temp line
  freshNumber?: number; // 0..1 — number is newly allocated
  massCallingPattern?: number; // 0..1 — mass short-duration outbound pattern
}
export const BEHAVIORAL_WEIGHT = 0.6; // applied to the summed behavioral signals

export interface ScoreInput {
  now: number;
  reports: ReportInput[];
  behavioral?: BehavioralInput;
}

export interface ScoreResult {
  score: number; // 0..100
  label: SpamLabel;
  distinctReporters: number; // distinct spam reporters (drives the RED gate + report_count)
  formulaVersion: string;
}

function decay(ageMs: number): number {
  if (ageMs <= 0) return 1;
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
}

function reasonWeight(cat?: string | null): number {
  if (!cat) return 1.0;
  const w = REASON_WEIGHTS[cat.toLowerCase()];
  return w ?? 1.0;
}

function clampTrust(t: number): number {
  if (!Number.isFinite(t)) return BASE_TRUST;
  return Math.max(MIN_TRUST, Math.min(MAX_TRUST, t));
}

/**
 * Deterministic score for a single number. Same inputs + FORMULA_VERSION ⇒ same
 * output, always. Never marks spam on a single report; RED requires
 * RED_MIN_REPORTERS distinct spam reporters AND score >= RED_THRESHOLD.
 */
export function scoreNumber(input: ScoreInput): ScoreResult {
  const { now, reports } = input;

  let spamWeight = 0;
  let notSpamWeight = 0;
  let velocityCount = 0;
  const distinctSpam = new Set<string>();

  for (const r of reports) {
    const t = clampTrust(r.trust);
    const d = decay(now - r.createdMs);
    if (r.verdict === "spam") {
      spamWeight += t * d * reasonWeight(r.reasonCategory);
      distinctSpam.add(r.reporterUid);
      if (now - r.createdMs <= VELOCITY_WINDOW_MS) velocityCount++;
    } else {
      // not_spam: redemption (trust-weighted, same decay).
      notSpamWeight += t * d;
    }
  }

  const b = input.behavioral ?? {};
  const behavioralSum =
    (b.voipLine ?? 0) + (b.freshNumber ?? 0) + (b.massCallingPattern ?? 0);
  const velocityTerm = Math.min(velocityCount, VELOCITY_CAP) * VELOCITY_WEIGHT;

  const netWeighted =
    spamWeight -
    REDEMPTION_FACTOR * notSpamWeight +
    BEHAVIORAL_WEIGHT * behavioralSum +
    velocityTerm;

  let score = 0;
  if (netWeighted > 0) {
    score = Math.round(100 * (1 - Math.exp(-K_SATURATION * netWeighted)));
  }
  score = Math.max(0, Math.min(100, score));

  const distinctReporters = distinctSpam.size;

  // Consensus gate: below the distinct-reporter floor a number can NEVER be red
  // (single/few reports stay BLUE with an honest "reported by K users" line).
  if (distinctReporters < RED_MIN_REPORTERS && score >= RED_THRESHOLD) {
    score = RED_THRESHOLD - 1;
  }

  let label: SpamLabel = "none";
  if (score >= RED_THRESHOLD && distinctReporters >= RED_MIN_REPORTERS) label = "red";
  else if (score >= CAUTION_THRESHOLD) label = "caution";

  return { score, label, distinctReporters, formulaVersion: FORMULA_VERSION };
}

/**
 * Reporter trust from agreement history. Deterministic, replayable. Trust rises as a
 * reporter agrees with community consensus, falls as they disagree. Starts at
 * BASE_TRUST (0.3) for accounts with no history.
 *
 *   trust = clamp( BASE_TRUST + 0.5 * (agree - disagree) / max(total,1) )
 *
 * `agree` = reports whose verdict matched the number's final label direction
 * (spam-ish label vs 'spam' verdict, or 'none' label vs 'not_spam'); `disagree` the
 * opposite. Convergence over nightly runs is intentional and bounded.
 */
export function computeReporterTrust(agree: number, disagree: number): number {
  const total = agree + disagree;
  if (total <= 0) return BASE_TRUST;
  const t = BASE_TRUST + 0.5 * ((agree - disagree) / total);
  return Math.max(MIN_TRUST, Math.min(MAX_TRUST, t));
}
