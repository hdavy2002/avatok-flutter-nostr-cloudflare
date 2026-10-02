// [AUMFE-CONSULT-W2-1 2026-10-02] Real Consultants lane W2: customer photo upload, the consultant's customer file, card edits, rerun, notes.
// Spec: Specs/SPEC-2026-10-02-REAL-CONSULTANTS-BUILD.md §W2. Photos live in the PRIVATE `DIGITAL` bucket and are only ever
// streamed back through GET /desk/photo/:booking/:kind after the same auth check (private, no-store).
import type { Env } from "../../types";
import { CORS, json } from "../../util";
import { requireUser, isFail } from "../../authz";
import { rateLimit } from "../../money";
import { metaDb } from "../../db/shard";
import { track, trackException } from "../../hooks";
import { APP } from "../../lib/astrology/client";
import { consultVisible, isConsultAdmin } from "../../lib/consultants/access";
import { consultantByUid, consultantById } from "../../lib/consultants/store";
import { priceFor } from "../../lib/consultants/pricing";
import { JOIN_EARLY_MS } from "../../lib/consultants/slots";
import { CARD_KEYS } from "../../lib/consultants/types";
import type { BookingStatus, DeskBookingDTO, DeskFileDTO, Discipline, Intake, PhotoKind, PrepStatus } from "../../lib/consultants/types";
import { realDeps } from "../../lib/consultants/prepare/deps";
import { rerunAstrology } from "../../lib/consultants/prepare";
import { visionId } from "../../lib/consultants/prepare/vision";
import { titleOf } from "../../lib/consultants/prepare/shared";
import { customerFromIntake, orderCards, PHOTO_KINDS_FOR, toFileCard, type CardRow } from "../../lib/consultants/prepare/file_dto";

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const MAX_NOTES_CHARS = 10_000;
const MAX_OVERRIDE_BYTES = 100_000;
const PHOTO_STATUSES: BookingStatus[] = ["held", "awaiting_review", "confirmed"];

/** JPEG / PNG by magic bytes (never trust the header alone). */
export function sniffImage(b: Uint8Array): { mime: "image/jpeg" | "image/png"; ext: "jpg" | "png" } | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: "image/png", ext: "png" };
  return null;
}

export const photoKindAllowed = (discipline: string, kind: string): kind is PhotoKind => (PHOTO_KINDS_FOR[discipline] ?? []).includes(kind as PhotoKind);

interface BookingRow {
  id: string; ref: string; consultant_id: string; uid: string; discipline: Discipline; slot_start_ms: number; slot_end_ms: number; status: BookingStatus;
  rate_rupees: number; gst_rupees: number; total_rupees: number; fee_rupees: number; payout_rupees: number; intake_json: string; questions_json: string;
  prep_status: PrepStatus; consultant_notes: string; expires_at: number | null; created_at: number;
}
const parseJson = <T>(s: string | null | undefined, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };
const noStore = { "cache-control": "private, no-store" };
const err = (error: string, status: number) => json({ error }, status, noStore);

async function loadBooking(env: Env, id: string): Promise<BookingRow | null> {
  return (await metaDb(env).prepare("SELECT * FROM consult_bookings WHERE id = ?1").bind(id).first<BookingRow>()) ?? null;
}

type Access = { ok: true; booking: BookingRow; uid: string; admin: boolean } | { ok: false; res: Response };
/** Signed in + feature visible + (the booking's consultant | admin). 404 for everyone else so ids do not leak. */
async function deskAccess(req: Request, env: Env, bookingId: string): Promise<Access> {
  const u = await requireUser(req, env);
  if (isFail(u)) return { ok: false, res: err(u.error, u.status) };
  if (!(await consultVisible(env, u.uid))) return { ok: false, res: err("not_found", 404) };
  const booking = await loadBooking(env, bookingId);
  if (!booking) return { ok: false, res: err("not_found", 404) };
  const admin = isConsultAdmin(env, u.uid);
  if (!admin) {
    const c = await consultantByUid(env, u.uid);
    if (!c || c.id !== booking.consultant_id) return { ok: false, res: err("not_found", 404) };
  }
  return { ok: true, booking, uid: u.uid, admin };
}

const fire = (ctx: ExecutionContext | undefined, p: Promise<unknown>) => { if (ctx) ctx.waitUntil(p.catch(() => {})); return p.catch(() => {}); };

async function readBody(req: Request): Promise<unknown | undefined> { try { return await req.json(); } catch { return undefined; } }

async function cardRows(env: Env, bookingId: string): Promise<CardRow[]> {
  const rs = await metaDb(env).prepare("SELECT key, title, api_json, override_json, edited_by, edited_at, status, note FROM consult_file_cards WHERE booking_id = ?1").bind(bookingId).all<CardRow>();
  return rs.results ?? [];
}

// ---------------------------------------------------------------------------------------------------------------------
// POST /api/consultants/bookings/:id/photo  (customer)
// ---------------------------------------------------------------------------------------------------------------------
async function uploadPhoto(req: Request, env: Env, bookingId: string, ctx?: ExecutionContext): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.error, u.status);
  if (!(await consultVisible(env, u.uid))) return err("not_found", 404);
  const b = await loadBooking(env, bookingId);
  if (!b || b.uid !== u.uid) return err("not_found", 404);
  if (!PHOTO_STATUSES.includes(b.status)) return err("booking_not_open", 409);
  const kind = String(req.headers.get("x-photo-kind") || "");
  if (!photoKindAllowed(b.discipline, kind)) return err("bad_photo_kind", 400);
  const limited = await rateLimit(env, `consult_photo:${u.uid}`, 20, 3600);
  if (limited) return limited;

  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_PHOTO_BYTES) return err("photo_too_large", 413);
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.length) return err("empty_body", 400);
  if (bytes.length > MAX_PHOTO_BYTES) return err("photo_too_large", 413);
  const img = sniffImage(bytes);
  if (!img) return err("photo_must_be_jpeg_or_png", 415);

  try {
    const key = `consult/${b.id}/${kind}.${img.ext}`;
    const prev = await metaDb(env).prepare("SELECT r2_key FROM consult_photos WHERE booking_id = ?1 AND kind = ?2").bind(b.id, kind).first<{ r2_key: string }>();
    await env.DIGITAL.put(key, bytes, { httpMetadata: { contentType: img.mime } });
    if (prev?.r2_key && prev.r2_key !== key) await env.DIGITAL.delete(prev.r2_key).catch(() => {});

    const st = await visionId(realDeps(env, u.uid), kind, bytes);
    // A vendor outage keeps the photo (accepted, not machine-checked): the customer must not be blocked by our provider.
    const dbStatus = st.state === "accepted" ? "accepted" : st.state === "rejected" ? "rejected" : "uploaded";
    const apiId = st.state === "accepted" ? st.id : null;
    const reason = st.state === "accepted" ? null : st.reason;
    await metaDb(env).prepare(
      `INSERT INTO consult_photos (booking_id, kind, r2_key, api_id, status, reason, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)
       ON CONFLICT(booking_id, kind) DO UPDATE SET r2_key = excluded.r2_key, api_id = excluded.api_id, status = excluded.status, reason = excluded.reason, created_at = excluded.created_at`,
    ).bind(b.id, kind, key, apiId, dbStatus, reason, Date.now()).run();
    // A photo changed after payment: have the file rebuilt (a running job is left alone).
    if (b.status === "confirmed" && st.state !== "rejected") {
      await metaDb(env).prepare("UPDATE consult_bookings SET prep_status = 'pending', prep_attempts = 0, updated_at = ?1 WHERE id = ?2 AND status = 'confirmed' AND prep_status <> 'running'").bind(Date.now(), b.id).run();
    }
    const out = { kind, status: st.state === "rejected" ? ("rejected" as const) : ("accepted" as const), reason };
    await fire(ctx, track(env, u.uid, "consult_photo_uploaded", APP, { kind, status: out.status, reason, checked: !!apiId, booking_id: b.id }));
    return json({ photo: out }, 200, noStore);
  } catch (e) {
    await fire(ctx, trackException(env, e, { uid: u.uid, route: "consult_photo", method: "POST", handled: true, app_name: APP, extra: { booking: b.id, kind } }));
    return err("photo_failed", 500);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// GET /api/consultants/desk/bookings/:id/file
// ---------------------------------------------------------------------------------------------------------------------
async function getFile(req: Request, env: Env, bookingId: string): Promise<Response> {
  const a = await deskAccess(req, env, bookingId);
  if (!a.ok) return a.res;
  const b = a.booking;
  const intake = parseJson<Intake | null>(b.intake_json, null);
  if (!intake) return err("intake_unreadable", 422);
  const consultant = await consultantById(env, b.consultant_id);
  const db = metaDb(env);
  const [prior, past, photos, rows] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM consult_bookings WHERE uid = ?1 AND consultant_id = ?2 AND id <> ?3 AND slot_start_ms < ?4 AND status IN ('completed','no_show_customer')").bind(b.uid, b.consultant_id, b.id, b.slot_start_ms).first<{ n: number }>(),
    db.prepare("SELECT id, slot_start_ms, consultant_notes FROM consult_bookings WHERE uid = ?1 AND consultant_id = ?2 AND id <> ?3 AND consultant_notes <> '' ORDER BY slot_start_ms DESC LIMIT 10").bind(b.uid, b.consultant_id, b.id).all<{ id: string; slot_start_ms: number; consultant_notes: string }>(),
    db.prepare("SELECT kind FROM consult_photos WHERE booking_id = ?1 AND status <> 'rejected' ORDER BY kind").bind(b.id).all<{ kind: PhotoKind }>(),
    cardRows(env, b.id),
  ]);
  const cust = customerFromIntake(intake, Date.now());
  const price = { ...priceFor(b.rate_rupees), rate: b.rate_rupees, gst: b.gst_rupees, total: b.total_rupees, fee: b.fee_rupees, payout: b.payout_rupees };
  const booking: DeskBookingDTO = {
    id: b.id, ref: b.ref,
    consultant: { slug: consultant?.slug ?? "", name: consultant?.name ?? "", photo_url: consultant?.photo_url ?? "" },
    discipline: b.discipline, slot_start_ms: b.slot_start_ms, slot_end_ms: b.slot_end_ms, status: b.status, price,
    questions: parseJson<string[]>(b.questions_json, []), prep_status: b.prep_status, join_opens_ms: b.slot_start_ms - JOIN_EARLY_MS,
    expires_at: b.expires_at, created_at: b.created_at,
    customer: { uid: b.uid, name: cust.name, city: cust.city, age: cust.age, repeat: Number(prior?.n || 0) > 0 },
  };
  const dto: DeskFileDTO = {
    booking, intake, cards: orderCards(b.discipline, rows), notes: b.consultant_notes || "",
    past_notes: (past.results ?? []).map((r) => ({ booking_id: r.id, at: r.slot_start_ms, note: r.consultant_notes })),
    photos: (photos.results ?? []).map((p) => ({ kind: p.kind, url: `/api/consultants/desk/photo/${b.id}/${p.kind}` })),
  };
  return json(dto, 200, noStore);
}

// ---------------------------------------------------------------------------------------------------------------------
// GET /api/consultants/desk/photo/:booking/:kind   (streams from the private bucket)
// ---------------------------------------------------------------------------------------------------------------------
async function getPhoto(req: Request, env: Env, bookingId: string, kind: string): Promise<Response> {
  const a = await deskAccess(req, env, bookingId);
  if (!a.ok) return a.res;
  if (!photoKindAllowed(a.booking.discipline, kind)) return err("not_found", 404);
  const row = await metaDb(env).prepare("SELECT r2_key FROM consult_photos WHERE booking_id = ?1 AND kind = ?2 AND status <> 'rejected'").bind(bookingId, kind).first<{ r2_key: string }>();
  const obj = row ? await env.DIGITAL.get(row.r2_key) : null;
  if (!obj) return err("not_found", 404);
  return new Response(obj.body, {
    headers: { ...CORS, "content-type": obj.httpMetadata?.contentType || "image/jpeg", "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-disposition": "inline" },
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// PATCH /desk/bookings/:id/cards/:key  { override }
// ---------------------------------------------------------------------------------------------------------------------
async function editCard(req: Request, env: Env, bookingId: string, key: string, ctx?: ExecutionContext): Promise<Response> {
  const a = await deskAccess(req, env, bookingId);
  if (!a.ok) return a.res;
  if (!CARD_KEYS[a.booking.discipline].includes(key)) return err("unknown_card", 404);
  const body = (await readBody(req)) as { override?: unknown } | undefined;
  if (!body || typeof body !== "object" || !("override" in body)) return err("override_required", 400);
  const clear = body.override === null;
  const text = clear ? null : JSON.stringify(body.override);
  if (text !== null && (text === undefined || text.length > MAX_OVERRIDE_BYTES)) return err(text === undefined ? "bad_override" : "override_too_large", text === undefined ? 400 : 413);
  const now = Date.now();
  try {
    await metaDb(env).prepare(
      `INSERT INTO consult_file_cards (booking_id, key, title, status, note, override_json, edited_by, edited_at, updated_at) VALUES (?1,?2,?3,'missing','Not prepared yet',?4,?5,?6,?7)
       ON CONFLICT(booking_id, key) DO UPDATE SET override_json = excluded.override_json, edited_by = excluded.edited_by, edited_at = excluded.edited_at, updated_at = excluded.updated_at`,
    ).bind(bookingId, key, titleOf(key), text, clear ? null : a.uid, clear ? null : now, now).run();
    const row = (await cardRows(env, bookingId)).find((r) => r.key === key);
    await fire(ctx, track(env, a.uid, "consult_card_edited", APP, { key, cleared: clear, discipline: a.booking.discipline, booking_id: bookingId }));
    return json({ card: row ? toFileCard(row) : null }, 200, noStore);
  } catch (e) {
    await fire(ctx, trackException(env, e, { uid: a.uid, route: "consult_card_edit", method: "PATCH", handled: true, app_name: APP, extra: { booking: bookingId, key } }));
    return err("edit_failed", 500);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// POST /desk/bookings/:id/rerun  { tob? }
// ---------------------------------------------------------------------------------------------------------------------
async function rerun(req: Request, env: Env, bookingId: string, ctx?: ExecutionContext): Promise<Response> {
  const a = await deskAccess(req, env, bookingId);
  if (!a.ok) return a.res;
  const body = ((await readBody(req)) ?? {}) as { tob?: unknown };
  if (body.tob != null && typeof body.tob !== "string") return err("bad_tob", 400);
  const limited = await rateLimit(env, `consult_rerun:${a.uid}`, 20, 3600);
  if (limited) return limited;
  try {
    const r = await rerunAstrology(env, bookingId, typeof body.tob === "string" ? body.tob : null);
    if (!r.ok) return err(r.error, r.status);
    const rows = await cardRows(env, bookingId);
    return json({ prep_status: r.prep_status, cards: orderCards(a.booking.discipline, rows) }, 200, noStore);
  } catch (e) {
    await fire(ctx, trackException(env, e, { uid: a.uid, route: "consult_rerun", method: "POST", handled: true, app_name: APP, extra: { booking: bookingId } }));
    return err("rerun_failed", 500);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// PUT /desk/bookings/:id/notes  { notes }
// ---------------------------------------------------------------------------------------------------------------------
async function putNotes(req: Request, env: Env, bookingId: string, ctx?: ExecutionContext): Promise<Response> {
  const a = await deskAccess(req, env, bookingId);
  if (!a.ok) return a.res;
  const body = (await readBody(req)) as { notes?: unknown } | undefined;
  if (!body || typeof body.notes !== "string") return err("notes_required", 400);
  if (body.notes.length > MAX_NOTES_CHARS) return err("notes_too_long", 413);
  try {
    await metaDb(env).prepare("UPDATE consult_bookings SET consultant_notes = ?1, updated_at = ?2 WHERE id = ?3").bind(body.notes, Date.now(), bookingId).run();
    return json({ ok: true, length: body.notes.length }, 200, noStore);
  } catch (e) {
    await fire(ctx, trackException(env, e, { uid: a.uid, route: "consult_notes", method: "PUT", handled: true, app_name: APP, extra: { booking: bookingId } }));
    return err("notes_failed", 500);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
const RE_PHOTO_UP = /^\/api\/consultants\/bookings\/([^/]+)\/photo$/;
const RE_FILE = /^\/api\/consultants\/desk\/bookings\/([^/]+)\/file$/;
const RE_CARD = /^\/api\/consultants\/desk\/bookings\/([^/]+)\/cards\/([^/]+)$/;
const RE_RERUN = /^\/api\/consultants\/desk\/bookings\/([^/]+)\/rerun$/;
const RE_NOTES = /^\/api\/consultants\/desk\/bookings\/([^/]+)\/notes$/;
const RE_PHOTO_GET = /^\/api\/consultants\/desk\/photo\/([^/]+)\/([^/]+)$/;

export async function fileRoutes(req: Request, env: Env, p: string, ctx?: ExecutionContext): Promise<Response | null> {
  const m = req.method;
  let x: RegExpExecArray | null;
  if (m === "POST" && (x = RE_PHOTO_UP.exec(p))) return uploadPhoto(req, env, x[1], ctx);
  if (m === "GET" && (x = RE_FILE.exec(p))) return getFile(req, env, x[1]);
  if (m === "GET" && (x = RE_PHOTO_GET.exec(p))) return getPhoto(req, env, x[1], x[2]);
  if (m === "PATCH" && (x = RE_CARD.exec(p))) return editCard(req, env, x[1], decodeURIComponent(x[2]), ctx);
  if (m === "POST" && (x = RE_RERUN.exec(p))) return rerun(req, env, x[1], ctx);
  if (m === "PUT" && (x = RE_NOTES.exec(p))) return putNotes(req, env, x[1], ctx);
  return null;
}

