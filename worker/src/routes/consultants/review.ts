// [AUMFE-CONSULT-W3-1 2026-10-02] Review by emailed/WhatsApp token (no sign-in; the token is the proof of a completed session).
//   GET  /api/consultants/review/:token -> { consultant:{name,photo_url,slug}, discipline, slot_start_ms, already }
//   POST /api/consultants/review/:token { stars 1-5, text?<=1000, first_name_only } -> 201, review is `pending` until moderated.
import type { Env } from "../../types";
import { json } from "../../util";
import { track, trackException } from "../../hooks";
import { metaDb } from "../../db/shard";
import { consultantById, newId } from "../../lib/consultants/store";
import { customerNameFromIntake, reviewDisplayName, type BookingRow } from "../../lib/consultants/notify";

const APP = "aumfe_consult";

export async function reviewRoutes(req: Request, env: Env, p: string, _ctx?: ExecutionContext): Promise<Response | null> {
  const m = /^\/api\/consultants\/review\/([A-Za-z0-9_-]{16,96})$/.exec(p);
  if (!m) return null;
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const db = metaDb(env);
  try {
    const b = await db.prepare("SELECT * FROM consult_bookings WHERE review_token = ?1 AND status = 'completed'").bind(m[1]).first<BookingRow>();
    if (!b) return json({ error: "not_found" }, 404);
    const c = await consultantById(env, b.consultant_id);
    if (!c) return json({ error: "not_found" }, 404);
    const existing = await db.prepare("SELECT id FROM consult_reviews WHERE booking_id = ?1").bind(b.id).first<{ id: string }>();

    if (req.method === "GET") {
      return json({ consultant: { name: c.name, photo_url: c.photo_url, slug: c.slug }, discipline: b.discipline, slot_start_ms: b.slot_start_ms, already: !!existing });
    }

    let body: { stars?: unknown; text?: unknown; first_name_only?: unknown } = {};
    try { body = (await req.json()) as typeof body; } catch { return json({ error: "bad_json" }, 400); }
    const stars = Number(body.stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) return json({ error: "bad_stars" }, 400);
    const raw = body.text == null ? "" : String(body.text);
    if (raw.length > 1000) return json({ error: "text_too_long" }, 400);
    const text = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
    if (existing) return json({ error: "already_reviewed" }, 409);

    const display = reviewDisplayName(customerNameFromIntake(b.intake_json), body.first_name_only === true);
    try {
      await db.prepare(
        `INSERT INTO consult_reviews (id, booking_id, consultant_id, uid, stars, text, display_name, discipline, status, seed, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'pending',0,?9)`,
      ).bind(newId("cr_", 16), b.id, b.consultant_id, b.uid, stars, text || null, display, b.discipline, Date.now()).run();
    } catch (e) {
      if (/UNIQUE|constraint/i.test(String(e))) return json({ error: "already_reviewed" }, 409); // two taps at once: booking_id is UNIQUE
      throw e;
    }
    void track(env, b.uid, "consult_review_submitted", APP, { stars, has_text: !!text, ok: true });
    return json({ ok: true, status: "pending" }, 201);
  } catch (e) {
    await trackException(env, e, { route: "/api/consultants/review/:token", handled: true, app_name: APP });
    return json({ error: "server_error" }, 500);
  }
}
