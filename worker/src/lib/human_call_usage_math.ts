/** Pure math for the server-authoritative human call participant pool. */
export type HumanCallMedia = "audio" | "video";
export const HUMAN_CALL_FREE_PARTICIPANT_SECONDS = 200 * 60;
export const HUMAN_CALL_AUDIO_CENTITOKENS_PER_MINUTE = 5;
export const HUMAN_CALL_VIDEO_CENTITOKENS_PER_MINUTE = 10;
export const CENTITOKENS_PER_TOKEN = 100;
// One extra factor of 60 retains fractional centitokens for short billing ticks.
export const CENTITOKEN_SECONDS_PER_TOKEN = CENTITOKENS_PER_TOKEN * 60;

export interface HumanCallUsageMathInput {
  priorParticipantSeconds: number;
  /** Remaining prepaid credit, in centitoken-seconds (0..5,999). */
  priorCentitokenSeconds: number;
  participantSeconds: number;
  media: HumanCallMedia;
}

export interface HumanCallUsageMathResult {
  participantSeconds: number;
  freeSecondsApplied: number;
  overageSeconds: number;
  addedCentitokenSeconds: number;
  /** Whole wallet tokens to pre-fund the bucket for this tick. */
  tokensToFund: number;
  centitokenSecondsRemainder: number;
  participantSecondsTotal: number;
}

/**
 * The bucket is prepaid: at the first overage tick WalletDO buys enough whole
 * tokens to cover that tick, then spends the corresponding 0.05/0.10 token per
 * minute from the bucket. Unused credit remains available across calls/months.
 */
export function computeHumanCallUsage(input: HumanCallUsageMathInput): HumanCallUsageMathResult {
  const priorSeconds = Math.max(0, Math.trunc(Number(input.priorParticipantSeconds) || 0));
  const priorCredit = Math.max(0, Math.trunc(Number(input.priorCentitokenSeconds) || 0)) % CENTITOKEN_SECONDS_PER_TOKEN;
  const participantSeconds = Math.max(1, Math.trunc(Number(input.participantSeconds) || 0));
  const rate = input.media === "video"
    ? HUMAN_CALL_VIDEO_CENTITOKENS_PER_MINUTE
    : HUMAN_CALL_AUDIO_CENTITOKENS_PER_MINUTE;
  const freeSecondsApplied = Math.min(participantSeconds, Math.max(0, HUMAN_CALL_FREE_PARTICIPANT_SECONDS - priorSeconds));
  const overageSeconds = participantSeconds - freeSecondsApplied;
  const addedCentitokenSeconds = overageSeconds * rate;
  const shortfall = Math.max(0, addedCentitokenSeconds - priorCredit);
  const tokensToFund = shortfall > 0 ? Math.ceil(shortfall / CENTITOKEN_SECONDS_PER_TOKEN) : 0;
  // Existing credit is consumed first; any shortfall is topped up with whole
  // tokens before the tick is admitted. This keeps the bucket < one token.
  const centitokenSecondsRemainder = priorCredit + tokensToFund * CENTITOKEN_SECONDS_PER_TOKEN - addedCentitokenSeconds;
  return {
    participantSeconds,
    freeSecondsApplied,
    overageSeconds,
    addedCentitokenSeconds,
    tokensToFund,
    centitokenSecondsRemainder,
    participantSecondsTotal: priorSeconds + participantSeconds,
  };
}
