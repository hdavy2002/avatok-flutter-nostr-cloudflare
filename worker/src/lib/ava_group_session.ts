// [AVA-GROUP-SESSION-1 2026-08-16] Shared group media (song/video) sessions.
//
// Owner decision 2026-08-16: in a GROUP thread, the person who initiates a
// public (#ava) song/video creation owns the session and pays for it; other
// members' public #ava turns JOIN that conversation (routed to the initiator's
// AvaAgentDO) instead of spawning a parallel per-user Ava, and only the
// initiator can approve the paid generate step.
//
// This module is only the durable session pointer: WHICH user's AvaAgentDO a
// group's public media turns should route to. The conversation state itself
// stays where it always was — in the owner's AvaAgentDO storage
// (song_flow:<conv> / video_flow:<conv>). The pointer lives in the TOKENS KV
// namespace, self-expires after 30 minutes of silence (plus a hard KV TTL
// backstop), and stores only uids — never any conversation text.
import type { Env } from "../types";

export interface GroupMediaSession {
  owner_uid: string;
  started_at: number;
  updated_at: number;
}

const IDLE_EXPIRY_MS = 30 * 60_000;
const KV_TTL_SECONDS = 2 * 60 * 60; // hard backstop well past idle expiry

function key(conv: string): string {
  return `ava_group_media_session:${conv}`;
}

export async function readGroupMediaSession(env: Env, conv: string): Promise<GroupMediaSession | null> {
  try {
    const raw = await env.TOKENS.get(key(conv));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GroupMediaSession;
    if (!parsed?.owner_uid || !Number.isFinite(parsed.updated_at)) return null;
    if (Date.now() - Number(parsed.updated_at) > IDLE_EXPIRY_MS) {
      await env.TOKENS.delete(key(conv)).catch(() => {});
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeGroupMediaSession(env: Env, conv: string, ownerUid: string): Promise<void> {
  const now = Date.now();
  const session: GroupMediaSession = { owner_uid: ownerUid, started_at: now, updated_at: now };
  await env.TOKENS.put(key(conv), JSON.stringify(session), { expirationTtl: KV_TTL_SECONDS }).catch(() => {});
}

export async function touchGroupMediaSession(env: Env, conv: string, session: GroupMediaSession): Promise<void> {
  await env.TOKENS.put(
    key(conv),
    JSON.stringify({ ...session, updated_at: Date.now() }),
    { expirationTtl: KV_TTL_SECONDS },
  ).catch(() => {});
}

export async function clearGroupMediaSession(env: Env, conv: string): Promise<void> {
  await env.TOKENS.delete(key(conv)).catch(() => {});
}
