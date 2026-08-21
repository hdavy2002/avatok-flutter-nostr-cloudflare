import type { Env } from "../types";
import { walletOp } from "../routes/wallet";
import type { HumanCallMedia } from "./human_call_usage_math";

export type { HumanCallMedia } from "./human_call_usage_math";
export {
  computeHumanCallUsage,
  HUMAN_CALL_FREE_PARTICIPANT_SECONDS,
  HUMAN_CALL_AUDIO_CENTITOKENS_PER_MINUTE,
  HUMAN_CALL_VIDEO_CENTITOKENS_PER_MINUTE,
  CENTITOKENS_PER_TOKEN,
  CENTITOKEN_SECONDS_PER_TOKEN,
} from "./human_call_usage_math";

export interface ConsumeHumanCallUsageArgs {
  uid: string;
  callId: string;
  participantSeconds: number;
  media: HumanCallMedia;
  opId: string;
}

/** Internal server-side bridge to the per-account WalletDO meter. */
export async function consumeHumanCallParticipantSeconds(
  env: Env,
  args: ConsumeHumanCallUsageArgs,
): Promise<{ ok: boolean; metered: boolean; disconnect: boolean; body: any; status: number }> {
  const result = await walletOp(env, args.uid, {
    op: "call_usage_consume",
    uid: args.uid,
    participant_seconds: args.participantSeconds,
    media: args.media,
    op_id: args.opId,
    app_name: "human_call",
    ref: `call:${args.callId}`,
  });
  return {
    ok: result.status === 200 && result.body?.ok === true,
    metered: result.body?.metered === true,
    disconnect: result.body?.disconnect === true,
    body: result.body,
    status: result.status,
  };
}
