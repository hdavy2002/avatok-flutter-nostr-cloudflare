// [AUMFE-CONSULT-W2-1 2026-10-02] Real Consultants — precompute the consultant's customer file (lane W2).
// prepareBooking(env, id): right after payment confirms (also retried by runPrepareJobs every cron tick).
// Writes EXACTLY CARD_KEYS[discipline] rows into consult_file_cards (never touching override_json / edited_*), then sets
// prep_status ready | partial | failed. Two ticks never double-run: the claim is a guarded UPDATE.
import type { Env } from "../../../types";
import { metaDb } from "../../../db/shard";
import { track, trackException } from "../../../hooks";
import { APP } from "../../astrology/client";
import type { Discipline, Intake } from "../types";
import { DISCIPLINES } from "../types";
import { type CardOut, normaliseCards, prepStatusOf, parseHm } from "./shared";
import { realDeps, type PrepDeps } from "./deps";
import { buildAstrologyCards } from "./astrology";
import { buildNumerologyCards } from "./numerology";
import { buildPalmCards, type PhotoRow } from "./palmistry";
import { buildFaceCards } from "./face";
import { buildTarotCards } from "./tarot";
import { visionId } from "./vision";

export const MAX_PREP_ATTEMPTS = 5;
const BATCH = 5;
/** A `running` claim older than this is a crashed isolate: it may be claimed again. */
export const STALE_RUNNING_MS = 10 * 60_000;
/** A failed job waits attempts x this before cron retries it. */
const RETRY_STEP_MS = 60_000;

interface BookingRow { id: string; uid: string; discipline: string; intake_json: string; status: string; prep_status: string; prep_attempts: number }

export async function buildCards(env: Env, discipline: Discipline, intake: Intake, bookingId: string, uid: string, deps: PrepDeps = realDeps(env, uid)): Promise<CardOut[]> {
  if (intake.kind !== discipline) throw new Error(`intake kind ${intake.kind} does not match discipline ${discipline}`);
  switch (intake.kind) {
    case "astrology": return buildAstrologyCards(intake, deps);
    case "numerology": return buildNumerologyCards(intake, deps);
    case "tarot": return buildTarotCards(intake, deps);
    case "palmistry": return buildPalmCards(intake, await loadPhotos(env, bookingId, deps), deps);
    case "face_reading": return buildFaceCards(intake, await loadPhotos(env, bookingId, deps), deps);
  }
}

/** Photos for the booking; any that never got an AstrologyAPI id (vision was down at upload) are checked now. */
async function loadPhotos(env: Env, bookingId: string, deps: PrepDeps): Promise<PhotoRow[]> {
  const rs = await metaDb(env).prepare("SELECT kind, api_id, status, reason, r2_key FROM consult_photos WHERE booking_id = ?1 ORDER BY kind").bind(bookingId)
    .all<PhotoRow & { r2_key: string }>();
  const photos = rs.results ?? [];
  for (const p of photos) {
    if (p.api_id || p.status === "rejected") continue;
    const obj = await env.DIGITAL.get(p.r2_key);
    if (!obj) continue;
    const st = await visionId(deps, p.kind, new Uint8Array(await obj.arrayBuffer()));
    if (st.state === "accepted") {
      p.api_id = st.id; p.status = "accepted"; p.reason = null;
      await metaDb(env).prepare("UPDATE consult_photos SET api_id = ?1, status = 'accepted', reason = NULL WHERE booking_id = ?2 AND kind = ?3").bind(st.id, bookingId, p.kind).run();
    } else if (st.state === "rejected") {
      p.status = "rejected"; p.reason = st.reason;
      await metaDb(env).prepare("UPDATE consult_photos SET status = 'rejected', reason = ?1 WHERE booking_id = ?2 AND kind = ?3").bind(st.reason, bookingId, p.kind).run();
    }
  }
  return photos.map(({ kind, api_id, status, reason }) => ({ kind, api_id, status, reason }));
}

/** Insert/refresh cards. override_json, edited_by and edited_at are never in the UPDATE list. */
export async function writeCards(env: Env, bookingId: string, cards: CardOut[], now = Date.now()): Promise<void> {
  const db = metaDb(env);
  const sql = `INSERT INTO consult_file_cards (booking_id, key, title, api_json, status, note, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7)
    ON CONFLICT(booking_id, key) DO UPDATE SET title = excluded.title, api_json = excluded.api_json, status = excluded.status, note = excluded.note, updated_at = excluded.updated_at`;
  await db.batch(cards.map((c) => db.prepare(sql).bind(bookingId, c.key, c.title, c.api == null ? null : JSON.stringify(c.api), c.status, c.note ?? null, now)));
}

/** Build + write + finish. The caller already holds the `running` claim. */
async function execute(env: Env, b: BookingRow, intake: Intake): Promise<"ready" | "partial" | "failed"> {
  const t0 = Date.now();
  const discipline = b.discipline as Discipline;
  let status: "ready" | "partial" | "failed" = "failed";
  let err: string | null = null;
  let missingKeys: string[] = [];
  try {
    const cards = normaliseCards(discipline, await buildCards(env, discipline, intake, b.id, b.uid));
    await writeCards(env, b.id, cards);
    status = prepStatusOf(cards);
    missingKeys = cards.filter((c) => c.status !== "ok").map((c) => c.key);
    if (status !== "ready") err = `missing: ${missingKeys.join(", ")}`.slice(0, 500);
  } catch (e) {
    status = "failed";
    err = String((e as Error)?.message ?? e).slice(0, 500);
    await trackException(env, e, { uid: b.uid, route: "consult_prepare", handled: true, app_name: APP, extra: { booking: b.id, discipline } });
  }
  try {
    await metaDb(env).prepare("UPDATE consult_bookings SET prep_status = ?1, prep_error = ?2, updated_at = ?3 WHERE id = ?4 AND prep_status = 'running'")
      .bind(status, err, Date.now(), b.id).run();
  } catch (e) {
    await trackException(env, e, { uid: b.uid, route: "consult_prepare_finish", handled: true, app_name: APP, extra: { booking: b.id } });
  }
  await track(env, b.uid, "consult_prepare", APP, { ok: status !== "failed", status, discipline, ms: Date.now() - t0, missing: missingKeys, booking_id: b.id });
  return status;
}

const loadBooking = (env: Env, id: string) =>
  metaDb(env).prepare("SELECT id, uid, discipline, intake_json, status, prep_status, prep_attempts FROM consult_bookings WHERE id = ?1").bind(id).first<BookingRow>();

function parseIntake(b: BookingRow): Intake | null {
  try { return JSON.parse(b.intake_json) as Intake; } catch { return null; }
}

/** Kick one booking's preparation right after payment confirms (also retried by cron). No-op unless pending/failed (or stale running). */
export async function prepareBooking(env: Env, bookingId: string): Promise<void> {
  const now = Date.now();
  const claim = await metaDb(env).prepare(
    `UPDATE consult_bookings SET prep_status = 'running', prep_attempts = prep_attempts + 1, prep_error = NULL, updated_at = ?1
     WHERE id = ?2 AND status IN ('confirmed','in_call') AND prep_attempts < ?3
       AND (prep_status IN ('pending','failed') OR (prep_status = 'running' AND updated_at < ?4))`,
  ).bind(now, bookingId, MAX_PREP_ATTEMPTS, now - STALE_RUNNING_MS).run();
  if (!claim.meta?.changes) return;
  const b = await loadBooking(env, bookingId);
  if (!b || !(DISCIPLINES as readonly string[]).includes(b.discipline)) return;
  const intake = parseIntake(b);
  if (!intake) {
    await metaDb(env).prepare("UPDATE consult_bookings SET prep_status = 'failed', prep_error = 'intake_unreadable', updated_at = ?1 WHERE id = ?2").bind(Date.now(), bookingId).run();
    await track(env, b.uid, "consult_prepare", APP, { ok: false, status: "failed", discipline: b.discipline, ms: 0, missing: [], booking_id: b.id });
    return;
  }
  await execute(env, b, intake);
}

/** Cron step: up to 5 confirmed bookings needing prep, oldest slot first. Returns how many were attempted. */
export async function runPrepareJobs(env: Env): Promise<number> {
  const now = Date.now();
  const rs = await metaDb(env).prepare(
    `SELECT id FROM consult_bookings
     WHERE status = 'confirmed' AND prep_attempts < ?1
       AND (prep_status = 'pending'
         OR (prep_status = 'failed' AND updated_at <= ?2 - prep_attempts * ?3)
         OR (prep_status = 'running' AND updated_at < ?2 - ?4))
     ORDER BY slot_start_ms ASC LIMIT ?5`,
  ).bind(MAX_PREP_ATTEMPTS, now, RETRY_STEP_MS, STALE_RUNNING_MS, BATCH).all<{ id: string }>();
  let n = 0;
  for (const r of rs.results ?? []) {
    try { await prepareBooking(env, r.id); n++; } catch (e) {
      await trackException(env, e, { route: "consult_prepare_job", handled: true, app_name: APP, extra: { booking: r.id } });
    }
  }
  return n;
}

export type RerunResult = { ok: true; prep_status: "ready" | "partial" | "failed" } | { ok: false; error: "not_found" | "not_astrology" | "bad_status" | "bad_tob" | "bad_intake" | "busy"; status: number };

/** Consultant rectified the birth time: store it, reset prep and recompute the astrology cards inline. */
export async function rerunAstrology(env: Env, bookingId: string, tob: string | null): Promise<RerunResult> {
  const b = await loadBooking(env, bookingId);
  if (!b) return { ok: false, error: "not_found", status: 404 };
  if (b.discipline !== "astrology") return { ok: false, error: "not_astrology", status: 400 };
  if (!["confirmed", "in_call"].includes(b.status)) return { ok: false, error: "bad_status", status: 409 };
  const intake = parseIntake(b);
  if (!intake || intake.kind !== "astrology") return { ok: false, error: "bad_intake", status: 422 };
  if (tob != null) {
    const t = parseHm(tob);
    if (!t) return { ok: false, error: "bad_tob", status: 400 };
    intake.birth = { ...intake.birth, tob: `${String(t.hour).padStart(2, "0")}:${String(t.min).padStart(2, "0")}`, tob_unknown: false };
  }
  const now = Date.now();
  const claim = await metaDb(env).prepare(
    `UPDATE consult_bookings SET intake_json = ?1, prep_status = 'running', prep_attempts = 0, prep_error = NULL, updated_at = ?2
     WHERE id = ?3 AND (prep_status <> 'running' OR updated_at < ?4)`,
  ).bind(JSON.stringify(intake), now, bookingId, now - STALE_RUNNING_MS).run();
  if (!claim.meta?.changes) return { ok: false, error: "busy", status: 409 };
  return { ok: true, prep_status: await execute(env, b, intake) };
}
