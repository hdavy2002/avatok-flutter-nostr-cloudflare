/**
 * Phase 1 Messenger caller-funded billing domain.
 *
 * This module is deliberately pure. It does not read config, touch WalletDO,
 * write D1, or choose a provider by rollout. The future authorization and
 * usage authorities can use these functions without inheriting the legacy
 * human_call_usage monthly/per-seat semantics.
 */

export type MessengerMedia = "audio" | "video";
export type MessengerVideoQuality = "sd" | "hd" | "2k" | "4k";
export type MessengerQualitySku = "audio" | "video_sd" | "video_hd" | "video_2k" | "video_4k";
export type MessengerCallProvider = "cloudflare" | "stream";

export const MESSENGER_AUDIO_FREE_PARTICIPANT_SECONDS_DEFAULT = 28_800;
export const MESSENGER_CALL_RESERVATION_WALL_SECONDS_DEFAULT = 300;
export const MESSENGER_CALL_LOW_BALANCE_WARNING_WALL_SECONDS_DEFAULT = 300;
export const MESSENGER_CALL_USAGE_TICK_SECONDS_DEFAULT = 15;
export const MESSENGER_CALL_PRICE_VERSION_DEFAULT = 1;
export const MESSENGER_PARTICIPANT_COUNT = 2;
export const CENTITOKENS_PER_TOKEN = 100;
/** One token represented in the fractional centitoken-second remainder bucket. */
export const CENTITOKEN_SECONDS_PER_TOKEN = CENTITOKENS_PER_TOKEN * 60;

export interface MessengerBillingConfig {
  messengerAudioFreeParticipantSecondsDaily: number;
  messengerAudioPaidCentitokensPerParticipantMinute: number;
  messengerVideoSdCentitokensPerParticipantMinute: number;
  messengerVideoHdCentitokensPerParticipantMinute: number;
  messengerVideo2kCentitokensPerParticipantMinute: number;
  messengerVideo4kCentitokensPerParticipantMinute: number;
  messengerCallReservationWallSeconds: number;
  messengerCallLowBalanceWarningWallSeconds: number;
  messengerCallUsageTickSeconds: number;
  messengerCallPriceVersion: number;
}

export interface MessengerRate {
  media: MessengerMedia;
  qualitySku: MessengerQualitySku;
  rateCentitokensPerParticipantMinute: number;
}

export type MessengerPricingConfig = Pick<MessengerBillingConfig,
  | "messengerAudioPaidCentitokensPerParticipantMinute"
  | "messengerVideoSdCentitokensPerParticipantMinute"
  | "messengerVideoHdCentitokensPerParticipantMinute"
  | "messengerVideo2kCentitokensPerParticipantMinute"
  | "messengerVideo4kCentitokensPerParticipantMinute"
>;

export interface CallerFundedTickInput {
  /** Free allowance already consumed for the payer on the UTC day. */
  priorDailyParticipantSeconds: number;
  /** Existing fractional paid credit in centitoken-seconds (0..5999). */
  priorCentitokenSeconds: number;
  wallSeconds: number;
  participantCount?: number;
  dailyAudioAllowanceParticipantSeconds: number;
  media: MessengerMedia;
  rateCentitokensPerParticipantMinute: number;
}

export interface CallerFundedTickResult {
  wallSeconds: number;
  participantCount: number;
  participantSeconds: number;
  freeParticipantSeconds: number;
  paidParticipantSeconds: number;
  /** Only free-audio allowance consumed; paid overage is intentionally excluded. */
  dailyAllowanceParticipantSecondsTotal: number;
  dailyAudioAllowanceRemaining: number;
  chargedCentitokenSeconds: number;
  tokensToFund: number;
  centitokenSecondsRemainder: number;
}

function integer(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) throw new RangeError(`${name} must be a finite integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  const n = integer(value, name);
  if (n < 0) throw new RangeError(`${name} must be non-negative`);
  return n;
}

function positiveInteger(value: number, name: string): number {
  const n = integer(value, name);
  if (n < 1) throw new RangeError(`${name} must be positive`);
  return n;
}

/** UTC date key used by the caller's daily audio allowance. */
export function utcDayKey(atMs = Date.now()): string {
  if (!Number.isFinite(atMs)) throw new RangeError("atMs must be finite");
  return new Date(atMs).toISOString().slice(0, 10);
}

/** Remaining free audio participant-seconds for the payer on one UTC day. */
export function dailyAudioAllowanceRemaining(
  priorParticipantSeconds: number,
  dailyAllowanceParticipantSeconds: number,
): number {
  const prior = nonNegativeInteger(priorParticipantSeconds, "priorParticipantSeconds");
  const allowance = nonNegativeInteger(dailyAllowanceParticipantSeconds, "dailyAllowanceParticipantSeconds");
  return Math.max(0, allowance - prior);
}

/**
 * Resolve the immutable quality SKU and rate from a remote config snapshot.
 * Zero paid-audio is representable while the daily free allowance remains;
 * zero video is unavailable and can never be treated as free continuation.
 */
export function messengerRateFor(
  config: MessengerPricingConfig,
  media: MessengerMedia,
  quality?: MessengerVideoQuality | "audio",
): MessengerRate | null {
  if (media === "audio") {
    if (quality !== undefined && quality !== "audio") return null;
    return {
      media,
      qualitySku: "audio",
      rateCentitokensPerParticipantMinute: nonNegativeInteger(
        config.messengerAudioPaidCentitokensPerParticipantMinute,
        "messengerAudioPaidCentitokensPerParticipantMinute",
      ),
    };
  }
  if (quality !== "sd" && quality !== "hd" && quality !== "2k" && quality !== "4k") return null;
  const field: Record<MessengerVideoQuality, keyof MessengerBillingConfig> = {
    sd: "messengerVideoSdCentitokensPerParticipantMinute",
    hd: "messengerVideoHdCentitokensPerParticipantMinute",
    "2k": "messengerVideo2kCentitokensPerParticipantMinute",
    "4k": "messengerVideo4kCentitokensPerParticipantMinute",
  };
  const rate = nonNegativeInteger(config[field[quality]], field[quality]);
  // A zero-priced video SKU is not a free call. It is an unconfigured paid
  // option and must fail closed until an operator supplies its remote rate.
  if (rate <= 0) return null;
  return {
    media,
    qualitySku: `video_${quality}` as MessengerQualitySku,
    rateCentitokensPerParticipantMinute: rate,
  };
}

/** Provider policy: free Messenger audio uses Cloudflare; every paid call uses Stream. */
export function messengerProviderFor(media: MessengerMedia, freeAudio = false): MessengerCallProvider {
  return media === "audio" && freeAudio ? "cloudflare" : "stream";
}

/** Two-person hourly estimate in whole wallet tokens, rounded up for consent UI. */
export function hourlyCallerFundedTokenEstimate(rateCentitokensPerParticipantMinute: number): number {
  const rate = nonNegativeInteger(rateCentitokensPerParticipantMinute, "rateCentitokensPerParticipantMinute");
  return Math.ceil((rate * 60 * MESSENGER_PARTICIPANT_COUNT) / CENTITOKENS_PER_TOKEN);
}

/**
 * Apply one connected-time tick for the caller-funded two-person contract.
 *
 * Only audio can consume the daily free pool. Video has paid participant time
 * from its first connected second. The caller's WalletDO is the only wallet
 * that will later consume `tokensToFund`; this function only calculates the
 * deterministic result.
 */
export function computeCallerFundedTick(input: CallerFundedTickInput): CallerFundedTickResult {
  const priorDaily = nonNegativeInteger(input.priorDailyParticipantSeconds, "priorDailyParticipantSeconds");
  const priorCredit = nonNegativeInteger(input.priorCentitokenSeconds, "priorCentitokenSeconds");
  if (priorCredit >= CENTITOKEN_SECONDS_PER_TOKEN) throw new RangeError("priorCentitokenSeconds must be below one token");
  const wallSeconds = positiveInteger(input.wallSeconds, "wallSeconds");
  const participantCount = input.participantCount ?? MESSENGER_PARTICIPANT_COUNT;
  if (participantCount !== MESSENGER_PARTICIPANT_COUNT) throw new RangeError("Messenger 1:1 calls require two participants");
  const allowance = nonNegativeInteger(input.dailyAudioAllowanceParticipantSeconds, "dailyAudioAllowanceParticipantSeconds");
  const rate = nonNegativeInteger(input.rateCentitokensPerParticipantMinute, "rateCentitokensPerParticipantMinute");
  const participantSeconds = wallSeconds * participantCount;
  const freeParticipantSeconds = input.media === "audio"
    ? Math.min(participantSeconds, dailyAudioAllowanceRemaining(priorDaily, allowance))
    : 0;
  const paidParticipantSeconds = participantSeconds - freeParticipantSeconds;
  if (paidParticipantSeconds > 0 && rate === 0) throw new RangeError("paid time requires a configured non-zero rate");
  const chargedCentitokenSeconds = paidParticipantSeconds * rate;
  const shortfall = Math.max(0, chargedCentitokenSeconds - priorCredit);
  const tokensToFund = Math.ceil(shortfall / CENTITOKEN_SECONDS_PER_TOKEN);
  const centitokenSecondsRemainder = priorCredit + tokensToFund * CENTITOKEN_SECONDS_PER_TOKEN - chargedCentitokenSeconds;
  return {
    wallSeconds,
    participantCount,
    participantSeconds,
    freeParticipantSeconds,
    paidParticipantSeconds,
    dailyAllowanceParticipantSecondsTotal: priorDaily + freeParticipantSeconds,
    dailyAudioAllowanceRemaining: Math.max(0, allowance - priorDaily - freeParticipantSeconds),
    chargedCentitokenSeconds,
    tokensToFund,
    centitokenSecondsRemainder,
  };
}
