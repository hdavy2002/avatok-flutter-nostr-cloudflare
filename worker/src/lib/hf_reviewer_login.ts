// [HF-PLAY-REVIEWER-1 2026-10-24] Google Play reviewer test login (owner decision).
// Play's reviewers must be able to sign in, but our sign-in is a WhatsApp code they can never receive. So ONE
// reviewer phone number may sign in with ONE fixed code, for a limited time, with no WhatsApp message sent.
//
// Nothing about the reviewer lives in code or in the public /api/config (this repo is public): the number and the
// code are stored only as SHA-256 hashes in KV (env.TOKENS key below), with an expiry. Set / clear it with
// scripts/hf_reviewer_login.py. No key, an expired key or a different number = the normal WhatsApp flow, unchanged.
// It only signs in an EXISTING account (the owner creates the reviewer account first with the normal sign-up);
// the usual 5-tries-per-code and 10-minute code lifetime still apply.
import type { Env } from "../types";
import { sha256Hex } from "../util";

export const REVIEWER_KV_KEY = "hf_play_reviewer_login:v1";
export const REVIEWER_SESSION_PREFIX = "reviewer:";

type ReviewerLogin = { phoneHash: string; codeHash: string; until: number };

async function read(env: Env): Promise<ReviewerLogin | null> {
  const raw = await env.TOKENS.get(REVIEWER_KV_KEY).catch(() => null);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ReviewerLogin>;
    if (typeof v.phoneHash !== "string" || typeof v.codeHash !== "string" || typeof v.until !== "number") return null;
    if (Date.now() > v.until) return null;
    return v as ReviewerLogin;
  } catch {
    return null;
  }
}

/** phoneHash = sha256Hex(e164), the same hash phone_otp uses. */
export async function isReviewerPhone(env: Env, phoneHash: string): Promise<boolean> {
  const r = await read(env);
  return !!r && r.phoneHash === phoneHash;
}

/** The code hash is sha256Hex(`hf-reviewer|${code}`). */
export async function reviewerCodeMatches(env: Env, phoneHash: string, code: string): Promise<boolean> {
  const r = await read(env);
  if (!r || r.phoneHash !== phoneHash) return false;
  return (await sha256Hex(`hf-reviewer|${code}`)) === r.codeHash;
}
