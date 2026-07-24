// AvaTalk group conferencing — LiveKit REMOVED (CF-CALL-007A, 2026-07-24).
// Group calls now run on the Cloudflare Realtime SFU path
// (worker/src/routes/groupcall.ts, /api/groupcall/*), gated by
// `cloudflareConferenceEnabled`. This module no longer issues LiveKit tokens,
// creates LiveKit rooms, or receives LiveKit webhooks — it exists solely so
// an old (pre-cutover) installed client that still calls /api/conference/*
// gets a clear, typed failure instead of a confusing 5xx or a silent hang, so
// it knows to update rather than retry forever.
//
// Removed in this commit — see git history / rollback tag
// `pre-livekit-removal-2026-07-24` for the full LiveKit implementation that
// used to live here:
//   - token issuance + room creation (issue(), lkToken, lkApi, CreateRoom/
//     ListParticipants/ListRooms/DeleteRoom, the old conferenceStart/Join)
//   - conferenceEnd / conferenceBeat / conferenceStatus (LiveKit room
//     lifecycle + conf_min metering against a live LiveKit room)
//   - conferenceWebhook + verifyLkJwt (LiveKit → worker webhook, JWT-verified;
//     route registration removed from index.ts in the same commit)
//   - region routing: regionsConfig, pickRegion, credsFor, regionKvKey,
//     roomRegion, CONTINENT_REGION, LkCreds
//
// Deliberately KEPT (see Specs/CF-CUTOVER-AND-LIVEKIT-REMOVAL-RUNBOOK-2026-07-24.md
// §4.1/§4.4): the `conferenceEnabled` and `livekitConferenceEnabled` flag
// DECLARATIONS in routes/config.ts (old clients still read `conferenceEnabled`
// for icon gating; `livekitConferenceEnabled` is harmless to leave declared,
// prune later), the CF groupcall path (routes/groupcall.ts, untouched), and
// the LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET/LIVEKIT_REGIONS wrangler
// secrets themselves — deleting secrets isn't git-recoverable, so they're left
// orphaned for a later deliberate `wrangler secret delete` per environment.
import type { Env } from "../types";
import { json, sha256Hex } from "../util";
import { isFail, requireUser } from "../authz";
import { trackUser } from "../hooks";
import { emailFor } from "../lib/identity";

/** conference_provider_selected — kept so the migration's PostHog contract
 *  (Specs/CF-CONFERENCE-TELEMETRY-CONTRACT-2026-07-24.md §1.1) still records a
 *  row for every hit against a now-removed LiveKit endpoint, stamped
 *  `decided_provider: "disabled"` / `decision_source: "removed"` — distinct
 *  from the pre-removal flag-based rejection, which used
 *  `decision_source: "worker"` / `decision: "rejected_disabled"` while the
 *  LiveKit code path still physically existed. Best-effort: telemetry must
 *  never fail the response path. */
async function emitProviderRemoved(env: Env, req: Request, uid: string, email: string | null, groupId: string): Promise<void> {
  try {
    const cf = (req as any).cf ?? {};
    const s = (v: unknown) => (typeof v === "string" && v ? v : null);
    const [groupHash, uidHash] = await Promise.all([sha256Hex(groupId), sha256Hex(uid)]);
    await trackUser(env, uid, email, "conference_provider_selected", "avatok", {
      transport: "none",
      decision: "provider_removed",
      decided_provider: "disabled",
      decision_source: "removed",
      group_id_hash: groupHash.slice(0, 16),
      participant_hash: uidHash.slice(0, 16),
      country: s(cf.country), city: s(cf.city), region: s(cf.region),
      timezone: s(cf.timezone), continent: s(cf.continent), colo: s(cf.colo),
    });
  } catch { /* telemetry is never allowed to fail the response path */ }
}

/** Shared 410 for every /api/conference/* endpoint an old, pre-cutover client
 *  might still call. requireUser auth is kept (this stays an authenticated
 *  surface, not a public probe), but the payload tells the old client plainly
 *  that it needs to update rather than retry — it can no longer complete a
 *  LiveKit-based call. */
async function providerRemoved(req: Request, env: Env, groupId: string): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: u.error }, u.status);
  const email = await emailFor(env, u.uid).catch(() => null);
  await emitProviderRemoved(env, req, u.uid, email, groupId);
  return json({
    error: "provider_removed",
    message: "Group calls have moved. Please update AvaTOK.",
    update: true,
  }, 410);
}

export async function conferenceStart(req: Request, env: Env, groupId: string): Promise<Response> {
  return providerRemoved(req, env, groupId);
}

export async function conferenceJoin(req: Request, env: Env, groupId: string): Promise<Response> {
  return providerRemoved(req, env, groupId);
}

export async function conferenceStatus(req: Request, env: Env, groupId: string): Promise<Response> {
  return providerRemoved(req, env, groupId);
}

export async function conferenceEnd(req: Request, env: Env, groupId: string): Promise<Response> {
  return providerRemoved(req, env, groupId);
}

export async function conferenceBeat(req: Request, env: Env, groupId: string): Promise<Response> {
  return providerRemoved(req, env, groupId);
}
