// [AGENT-LIVE-1] Public persona card + availability (no auth).
// Specs/SPEC-2026-09-12-AGENT-LIVE-1-BUILD.md §3 ("Public / customer"), §9
// (WS-C ownership).
import type { Env } from "../../types";
import { json } from "../../util";
import { requireUser, isFail } from "../../authz";
import { adminUid } from "../../lib/agent_live/gate";
import { SLOT_GRID_MS, type AgentLiveHandler } from "../../lib/agent_live/types";
import { metaDb } from "../../db/shard";
import { readConfig } from "../config";
// [AGENT-LIVE-1] WS-B's typed seat-authority client — see admin.ts's header
// comment on the same import for the dependency note.
import { seatAuthority } from "../../lib/agent_live/seats";
import { zonedEpoch } from "../../cal/engine";

const NO_STORE = { "cache-control": "no-store" };

function parseSlotMinutes(raw: unknown): number[] {
  return String(raw ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function parseJsonArray(raw: unknown): unknown[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** IANA timezone check the way MDN documents it — mirrors the identical
 *  helper in routes/listings.ts (not exported from there, so kept local). */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Optional auth: the caller's uid when a valid token rides the request,
 *  else null (guest) — mirrors `maybeUid` in routes/listings.ts. Used ONLY to
 *  let the sole agent admin preview a draft/unpublished card; every other
 *  answer on this public, unauthenticated route is identical for guest and
 *  signed-in visitors. */
async function maybeUid(req: Request, env: Env): Promise<string | null> {
  if (!req.headers.get("authorization")) return null;
  const ctx = await requireUser(req, env);
  return isFail(ctx) ? null : ctx.uid;
}

// ---------------------------------------------------------------------------
// GET /api/agents/:id — public persona card (no auth)
// ---------------------------------------------------------------------------
export const agentPublicGet: AgentLiveHandler = async (req, env, _ctx, params) => {
  const id = params.id;
  const cfg = await readConfig(env);
  const listing = await metaDb(env).prepare("SELECT * FROM listings WHERE id=?1 AND kind='agent'").bind(id).first<any>();
  if (!listing) return json({ error: "not found" }, 404, NO_STORE);

  const uid = await maybeUid(req, env);
  const isAdmin = !!uid && uid === adminUid(env);
  const published = String(listing.status) === "published";
  if (!published && !isAdmin) return json({ error: "not found" }, 404, NO_STORE);
  // A listing kind='agent' never renders for an ordinary visitor while the
  // whole lane is switched off (D12) — the admin can still preview it.
  if (!cfg.agentListingsEnabled && !isAdmin) return json({ error: "not found" }, 404, NO_STORE);

  const agent = await metaDb(env).prepare("SELECT * FROM agent_live_agents WHERE listing_id=?1").bind(id).first<any>();
  if (!agent) return json({ error: "not found" }, 404, NO_STORE);

  const slotMinutes = parseSlotMinutes(agent.slot_minutes);
  const now = Date.now();
  let availableNow = false;
  let nextFreeAt: number | null = null;
  if (slotMinutes.length) {
    try {
      const shortest = Math.min(...slotMinutes);
      const result = await seatAuthority(env).nextFreeStart({
        agentId: id,
        minutes: shortest,
        fromMs: now,
        agentCap: Number(agent.max_concurrent),
        platformCap: Number(cfg.agentPlatformMaxConcurrent),
      });
      if ("startMs" in result) {
        availableNow = result.startMs <= now + 60_000;
        nextFreeAt = availableNow ? null : result.startMs;
      }
    } catch {
      // Seat authority unreachable: a public card must degrade to "not
      // available now" rather than 500 — real checkout still fails closed
      // via laneGate, which is the actual money-safety boundary.
      availableNow = false;
      nextFreeAt = null;
    }
  }

  return json(
    {
      id: listing.id,
      title: listing.title,
      blurb: listing.blurb ?? null,
      description: listing.description ?? null,
      cover_media: parseJsonArray(listing.cover_media),
      category: listing.category,
      price_per_min: Number(agent.price_per_min),
      persona_kind: agent.persona_kind,
      voice: agent.voice,
      slot_minutes: slotMinutes,
      adults_only: !!listing.adults_only,
      image_reading: !!agent.image_reading,
      available_now: availableNow,
      next_free_at: nextFreeAt,
    },
    200,
    NO_STORE,
  );
};

// ---------------------------------------------------------------------------
// GET /api/agents/:id/availability?minutes=&day=YYYY-MM-DD&tz=… (no auth)
// ---------------------------------------------------------------------------
export const agentAvailability: AgentLiveHandler = async (req, env, _ctx, params) => {
  const id = params.id;
  const url = new URL(req.url);
  const minutes = Math.trunc(Number(url.searchParams.get("minutes")));
  const day = url.searchParams.get("day") || "";
  const tz = url.searchParams.get("tz") || "";

  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: "day must be YYYY-MM-DD" }, 400, NO_STORE);
  if (!tz || !isValidTimezone(tz)) return json({ error: "tz must be a valid IANA timezone" }, 400, NO_STORE);

  const cfg = await readConfig(env);
  const listing = await metaDb(env).prepare("SELECT status FROM listings WHERE id=?1 AND kind='agent'").bind(id).first<any>();
  if (!listing || String(listing.status) !== "published") return json({ error: "not found" }, 404, NO_STORE);
  const agent = await metaDb(env).prepare("SELECT * FROM agent_live_agents WHERE listing_id=?1").bind(id).first<any>();
  if (!agent) return json({ error: "not found" }, 404, NO_STORE);

  const slotMinutes = parseSlotMinutes(agent.slot_minutes);
  if (!Number.isFinite(minutes) || !slotMinutes.includes(minutes)) {
    return json({ error: `minutes must be one of ${slotMinutes.join(",")}` }, 400, NO_STORE);
  }

  let dayStartMs: number;
  let dayEndMs: number;
  try {
    dayStartMs = zonedEpoch(day, 0, tz);
    dayEndMs = zonedEpoch(day, 24 * 60, tz);
  } catch {
    return json({ error: "day must be YYYY-MM-DD" }, 400, NO_STORE);
  }

  try {
    const result = await seatAuthority(env).freeStarts({
      agentId: id,
      minutes,
      dayStartMs,
      dayEndMs,
      gridMs: SLOT_GRID_MS,
      agentCap: Number(agent.max_concurrent),
      platformCap: Number(cfg.agentPlatformMaxConcurrent),
    });
    if ("starts" in result) return json({ starts: result.starts }, 200, NO_STORE);
    return json({ error: "availability_unavailable", message: result.reason }, 503, NO_STORE);
  } catch (e) {
    return json({ error: "availability_unavailable", message: e instanceof Error ? e.message : String(e) }, 503, NO_STORE);
  }
};
