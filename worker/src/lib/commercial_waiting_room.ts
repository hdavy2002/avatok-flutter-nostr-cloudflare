// [WAITROOM-1] Prepaid waiting-room grant for commercial 1:1 consultations.
// RULEBOOK-PAID-SESSIONS.md v2 §3: opening the appointment connects the
// device to the session's Durable Object socket (StreamSessionDO,
// `consult:<bookingId>`) — NOT to GetStream media. This is the single place
// that mints the room token + room_ws URL and arms the DO clock
// (`schedule`) for a commercial booking. WP1's prejoin route and WP4/WP6
// (web/app waiting-room UIs) all consume this.
import type { Env } from "../types";
import { signSessionToken, sessionOp } from "../routes/live";
import { readConfig } from "../routes/config";

export interface WaitingRoomParams {
  bookingId: string;
  uid: string;
  role: "host" | "attendee";
  // Nullable: callers (e.g. commercialConsultPrejoin) source this from
  // `users.display_name ?? handle`, which can be null for an incomplete
  // profile. Falls back to "Someone" — same default `nameOf()` uses in
  // routes/consult.ts and routes/live.ts's `displayName()`.
  name: string | null;
  startsAt: number;
  endsAt: number;
  creatorId: string;
}

export interface WaitingRoomGrant {
  room_ws: string;
  room_token: string;
  check_in_by: number;
}

/** Same env-driven host selection as `routes/media.ts` (privateMediaReadUrl). */
function apiHost(env: Env): string {
  return env.ENVIRONMENT_NAME === "staging" ? "api-staging.avatok.ai" : "api.avatok.ai";
}

/**
 * Signs a session-DO token for the booking and arms the DO's clock
 * (`schedule`, idempotent re-arm) with `commercial:true` so the DO's own
 * money alarms (`money_noshow` / `money_end`) become no-ops for this
 * session — the commercial settlement engine (WP3) is the only thing
 * allowed to move money for a commercial booking (RULEBOOK §5).
 */
export async function buildWaitingRoomGrant(env: Env, p: WaitingRoomParams): Promise<WaitingRoomGrant> {
  const cfg = await readConfig(env);
  const waitMin = Math.trunc(Number(cfg.sessionCreatorCheckInMin)) || 20;

  const token = await signSessionToken(env, {
    sid: p.bookingId,
    uid: p.uid,
    role: p.role,
    order: null,
    name: p.name || "Someone",
    exp: p.endsAt + 2 * 3_600_000,
  });

  await sessionOp(env, `consult:${p.bookingId}`, {
    op: "schedule",
    sid: p.bookingId,
    kind: "consult",
    starts_at: p.startsAt,
    ends_at: p.endsAt,
    host_id: p.creatorId,
    wait_min: waitMin,
    commercial: true,
  });

  return {
    room_ws: `wss://${apiHost(env)}/api/consult/${p.bookingId}/room?token=${token}`,
    room_token: token,
    check_in_by: p.startsAt + waitMin * 60_000,
  };
}
