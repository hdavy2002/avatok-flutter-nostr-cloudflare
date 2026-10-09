// [HF-VOICE-INTRO-1] Durable transcription + contact-detail flagging of a host's voice introduction.
// Replaces the ctx.waitUntil path (cut ~30 s after the response) so a 5-minute recording can finish. Never throws out of run().
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { Env } from "../types";
import { BRAND } from "../lib/brand";
import { trackException } from "../hooks";
import { geminiTranscribe, saveIntroCheck, emitIntroChecked, INTRO_WORKFLOW_TIMEOUT_MS } from "../lib/hf_intro_check";
import type { IntroFlag } from "../lib/hf_intro";

const APP = BRAND.slug;
export interface IntroCheckParams { uid: string; key: string; mime: string; uploadedAt: number }

export class IntroCheckWorkflow extends WorkflowEntrypoint<Env, IntroCheckParams> {
  async run(event: WorkflowEvent<IntroCheckParams>, step: WorkflowStep): Promise<void> {
    const env = this.env;
    const { uid, key, mime, uploadedAt } = event.payload;
    let flagCount = 0; let ok = false;
    try {
      const r = await step.do("transcribe", { retries: { limit: 2, delay: "15 seconds", backoff: "exponential" }, timeout: "3 minutes" }, async () => {
        const x = await geminiTranscribe(env, uid, key, mime, INTRO_WORKFLOW_TIMEOUT_MS);
        return { transcript: x.transcript, flags: x.flags as IntroFlag[] };
      });
      flagCount = r.flags.length;
      ok = await step.do("save", { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "1 minute" }, () =>
        saveIntroCheck(env, uid, uploadedAt, r.transcript, r.flags));
    } catch (e) {
      await trackException(env, e, { uid, route: "/workflow/hf_intro_check", handled: true, app_name: APP, extra: { area: "hf_host", step: "intro_transcribe" } }).catch(() => {});
    }
    await emitIntroChecked(env, uid, flagCount, ok).catch(() => {});
  }
}
