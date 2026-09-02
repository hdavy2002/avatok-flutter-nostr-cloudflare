// [LIST-SLOTS-1 2026-09-02] Creator-owned CRUD on the C.3 `listing_slots`
// table — the calendar-1:1 booking grain. Gated dark behind `listingSlotsEnabled`
// (worker/src/routes/config.ts DEFAULTS, default false).
// Spec: Specs/SPEC-2026-09-01-LISTING-CONTENT-AND-BOOKING.md §C.3.
//
//   GET    /api/listings/:id/slots   public: open + future only; creator sees all
//   POST   /api/listings/:id/slots   creator: create a slot
//   PATCH  /api/slots/:slotId        creator: label / capacity (>=booked_count) / status=cancelled
//   DELETE /api/slots/:slotId        creator: only when booked_count=0, else 409
//
// Every write re-syncs `listings.starts_at` via lib/slots.ts:syncListingStartsAt.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb } from "../db/shard";
import { readConfig } from "./config";
import { syncListingStartsAt } from "../lib/slots";

const MAX_CAPACITY = 500;
const MAX_CONSULT_CAPACITY = 5;
const MIN_CAPACITY = 1;

async function slotsOn(env: Env): Promise<boolean> {
  try { return (await readConfig(env)).listingSlotsEnabled === true; } catch { return false; }
}

function slotsOff(): Response {
  return json({ error: "listing_slots_disabled", message: "Slot booking is temporarily unavailable." }, 503);
}

/** Optional auth — a uid when a valid token rides the request, else null
 *  (guest). Mirrors listings.ts:maybeUid; duplicated locally rather than
 *  importing across the module boundary (listings.ts is out of scope here). */
async function maybeUid(req: Request, env: Env): Promise<string | null> {
  const hasTok = !!req.headers.get("authorization") || !!new URL(req.url).searchParams.get("token");
  if (!hasTok) return null;
  const ctx = await requireUser(req, env);
  return isFail(ctx) ? null : ctx.uid;
}

interface ListingRow { id: string; creator_id: string; kind: string }

async function loadListing(env: Env, listingId: string): Promise<ListingRow | null> {
  const row = await metaDb(env).prepare(
    "SELECT id, creator_id, kind FROM listings WHERE id=?1",
  ).bind(listingId).first<ListingRow>();
  return row ?? null;
}

interface SlotRow {
  id: string; listing_id: string; starts_at: number; ends_at: number; label: string | null;
  capacity: number; booked_count: number; status: string; created_at: number; updated_at: number;
}

// GET /api/listings/:id/slots
export async function listSlots(req: Request, env: Env, listingId: string): Promise<Response> {
  if (!(await slotsOn(env))) return slotsOff();
  const listing = await loadListing(env, listingId);
  if (!listing) return json({ error: "not found" }, 404);
  const uid = await maybeUid(req, env);
  const isOwner = !!uid && uid === listing.creator_id;
  const db = metaDb(env);
  const rows = isOwner
    ? await db.prepare(
        "SELECT * FROM listing_slots WHERE listing_id=?1 ORDER BY starts_at ASC",
      ).bind(listingId).all<SlotRow>()
    : await db.prepare(
        "SELECT * FROM listing_slots WHERE listing_id=?1 AND status='open' AND starts_at > ?2 ORDER BY starts_at ASC",
      ).bind(listingId, Date.now()).all<SlotRow>();
  return json({ ok: true, slots: rows.results ?? [] });
}

/** No two slots on the same listing under the same label may overlap in
 *  time (§C.3's unique index only catches an EXACT starts_at+label clash;
 *  this catches a genuine time overlap, e.g. 10:00-11:00 and 10:30-11:30
 *  both labelled "Morning"). `label` is compared with COALESCE so two
 *  unlabelled slots are also checked against each other. */
async function overlapsSameLabel(
  env: Env, listingId: string, label: string | null, startsAt: number, endsAt: number, excludeId?: string,
): Promise<boolean> {
  const row = await metaDb(env).prepare(
    `SELECT id FROM listing_slots
      WHERE listing_id=?1 AND status != 'cancelled'
        AND COALESCE(label,'') = COALESCE(?2,'')
        AND starts_at < ?4 AND ends_at > ?3
        AND (?5 IS NULL OR id != ?5)
      LIMIT 1`,
  ).bind(listingId, label, startsAt, endsAt, excludeId ?? null).first<{ id: string }>();
  return !!row;
}

// POST /api/listings/:id/slots
export async function createSlot(req: Request, env: Env, listingId: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!(await slotsOn(env))) return slotsOff();
  const listing = await loadListing(env, listingId);
  if (!listing || listing.creator_id !== ctx.uid) return json({ error: "not found" }, 404);

  const b = (await req.json().catch(() => ({}))) as any;
  const startsAt = Number(b.starts_at);
  if (!Number.isFinite(startsAt) || startsAt <= 0) {
    return json({ ok: false, error: "starts_at must be an epoch-ms number", field: "starts_at" }, 400);
  }
  let endsAt: number;
  if (b.ends_at !== undefined) {
    endsAt = Number(b.ends_at);
  } else if (b.duration_min !== undefined) {
    const dur = Number(b.duration_min);
    if (!Number.isFinite(dur) || dur <= 0) {
      return json({ ok: false, error: "duration_min must be a positive number", field: "duration_min" }, 400);
    }
    endsAt = startsAt + dur * 60_000;
  } else {
    return json({ ok: false, error: "one of ends_at or duration_min is required", field: "ends_at" }, 400);
  }
  if (!Number.isFinite(endsAt) || endsAt <= startsAt) {
    return json({ ok: false, error: "ends_at must be after starts_at", field: "ends_at" }, 400);
  }

  const label = b.label === undefined || b.label === null ? null : String(b.label).slice(0, 120);

  // Kind 'consult' is capacity-1 by default (a calendar 1:1); a caller may
  // override up to 5 (small group consult), never the general 500 ceiling.
  let capacity: number;
  if (listing.kind === "consult") {
    if (b.capacity === undefined) {
      capacity = 1;
    } else {
      capacity = Number(b.capacity);
      if (!Number.isInteger(capacity) || capacity < MIN_CAPACITY || capacity > MAX_CONSULT_CAPACITY) {
        return json({ ok: false, error: `capacity must be ${MIN_CAPACITY}-${MAX_CONSULT_CAPACITY} for a consult slot`, field: "capacity" }, 400);
      }
    }
  } else {
    capacity = Number(b.capacity);
    if (!Number.isInteger(capacity) || capacity < MIN_CAPACITY || capacity > MAX_CAPACITY) {
      return json({ ok: false, error: `capacity must be ${MIN_CAPACITY}-${MAX_CAPACITY}`, field: "capacity" }, 400);
    }
  }

  if (await overlapsSameLabel(env, listingId, label, startsAt, endsAt)) {
    return json({ ok: false, error: "overlaps an existing slot with the same label", field: "starts_at" }, 409);
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  await metaDb(env).prepare(
    `INSERT INTO listing_slots (id, listing_id, starts_at, ends_at, label, capacity, booked_count, status, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,0,'open',?7,?7)`,
  ).bind(id, listingId, startsAt, endsAt, label, capacity, now).run();

  await syncListingStartsAt(env, listingId);

  return json({ ok: true, slot: { id, listing_id: listingId, starts_at: startsAt, ends_at: endsAt, label, capacity, booked_count: 0, status: "open", created_at: now, updated_at: now } }, 201);
}

interface OwnedSlot extends SlotRow { listing_creator_id: string; kind: string }

async function loadOwnedSlot(env: Env, slotId: string, uid: string): Promise<OwnedSlot | null> {
  const row = await metaDb(env).prepare(
    `SELECT s.*, l.creator_id AS listing_creator_id, l.kind AS kind
       FROM listing_slots s JOIN listings l ON l.id = s.listing_id
      WHERE s.id=?1`,
  ).bind(slotId).first<OwnedSlot>();
  if (!row || row.listing_creator_id !== uid) return null;
  return row;
}

// PATCH /api/slots/:slotId — label / capacity (>= booked_count) / status='cancelled'.
export async function patchSlot(req: Request, env: Env, slotId: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!(await slotsOn(env))) return slotsOff();
  const slot = await loadOwnedSlot(env, slotId, ctx.uid);
  if (!slot) return json({ error: "not found" }, 404);

  const b = (await req.json().catch(() => ({}))) as any;
  const sets: string[] = [];
  const binds: unknown[] = [];
  let n = 1;

  if (b.label !== undefined) {
    const label = b.label === null ? null : String(b.label).slice(0, 120);
    if (await overlapsSameLabel(env, slot.listing_id, label, slot.starts_at, slot.ends_at, slotId)) {
      return json({ ok: false, error: "overlaps an existing slot with the same label", field: "label" }, 409);
    }
    sets.push(`label=?${++n}`); binds.push(label);
  }

  if (b.capacity !== undefined) {
    const capacity = Number(b.capacity);
    const maxCap = slot.kind === "consult" ? MAX_CONSULT_CAPACITY : MAX_CAPACITY;
    if (!Number.isInteger(capacity) || capacity < MIN_CAPACITY || capacity > maxCap) {
      return json({ ok: false, error: `capacity must be ${MIN_CAPACITY}-${maxCap}`, field: "capacity" }, 400);
    }
    if (capacity < slot.booked_count) {
      return json({ ok: false, error: `capacity cannot be below the ${slot.booked_count} seat(s) already booked`, field: "capacity" }, 400);
    }
    sets.push(`capacity=?${++n}`); binds.push(capacity);
    // Capacity moving above booked_count can reopen a 'full' slot; moving it
    // down to exactly booked_count (still >= per the check above) can close
    // one. Only when this PATCH isn't ALSO explicitly cancelling the slot —
    // a single UPDATE can't SET status twice, and an explicit cancel wins.
    if (b.status === undefined) {
      sets.push(`status=(CASE WHEN booked_count >= ?${n} THEN 'full' ELSE 'open' END)`);
    }
  }

  if (b.status !== undefined) {
    if (b.status !== "cancelled") {
      return json({ ok: false, error: "status can only be set to 'cancelled' via PATCH", field: "status" }, 400);
    }
    sets.push(`status='cancelled'`);
  }

  if (!sets.length) return json({ ok: false, error: "nothing to update" }, 400);

  sets.push(`updated_at=?${++n}`); binds.push(Date.now());
  await metaDb(env).prepare(
    `UPDATE listing_slots SET ${sets.join(", ")} WHERE id=?1`,
  ).bind(slotId, ...binds).run();

  await syncListingStartsAt(env, slot.listing_id);
  return json({ ok: true });
}

// DELETE /api/slots/:slotId — only when booked_count=0, else 409.
export async function deleteSlot(req: Request, env: Env, slotId: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!(await slotsOn(env))) return slotsOff();
  const slot = await loadOwnedSlot(env, slotId, ctx.uid);
  if (!slot) return json({ error: "not found" }, 404);
  if (slot.booked_count > 0) {
    return json({ error: "slot has bookings", message: "Cancel the slot instead of deleting a slot with existing bookings." }, 409);
  }
  await metaDb(env).prepare("DELETE FROM listing_slots WHERE id=?1").bind(slotId).run();
  await syncListingStartsAt(env, slot.listing_id);
  return json({ ok: true });
}
