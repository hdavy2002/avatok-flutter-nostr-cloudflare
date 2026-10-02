// [AUMFE-CONSULT-W4-1] Consultant admin API (ADMIN_UIDS only): create/edit/attach consultants, photo, bookings, manual
// payment confirm, manual refund bookkeeping, cancel, review moderation. Nothing here moves money by itself.
// Spec: Specs/SPEC-2026-10-02-REAL-CONSULTANTS-BUILD.md §W4.
import type { Env } from "../../types";
import { json } from "../../util";
import { requireUser, isFail } from "../../authz";
import { track, trackException } from "../../hooks";
import { BRAND } from "../../lib/brand";
import { emailFor } from "../../lib/identity";
import { metaDb } from "../../db/shard";
import { peopleQuery } from "../admin2_people";
import { isConsultAdmin } from "../../lib/consultants/access";
import { consultantById, consultantByUid, consultantBySlug, newId, ratingFor, type ConsultantRow } from "../../lib/consultants/store";
import { validateAdminPatch, slugOk, REFUNDABLE, CANCELLABLE } from "../../lib/consultants/validate";
import { DISCIPLINES } from "../../lib/consultants/types";

const APP = BRAND.slug;
const PAGE = 50;
const MAX_PHOTO = 5 * 1024 * 1024;
const err = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const t = await req.text().catch(() => "");
  if (!t || t.length > 64_000) return {};
  try { const v = JSON.parse(t); return v && typeof v === "object" ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function audit(env: Env, adminUid: string, action: string, target: string, meta: Record<string, unknown>): Promise<void> {
  try {
    await env.DB_WALLET.prepare("INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)")
      .bind(crypto.randomUUID(), adminUid, `consult_${action}`, target, JSON.stringify(meta), Date.now()).run();
  } catch (e) {
    await trackException(env, e, { route: "/api/consultants/admin", method: "POST", handled: true, app_name: APP, extra: { area: "consult_admin", step: "admin_audit", action } });
  }
}

const slugify = (s: string): string => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
const parseArr = (s: string): unknown[] => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };

/** First name the customer typed in the booking form (astrology/numerology/tarot carry one). */
function intakeName(raw: unknown): string | null {
  try {
    const i = JSON.parse(String(raw || "{}"));
    const n = i?.birth?.name ?? i?.name ?? i?.birth_name ?? null;
    return typeof n === "string" && n.trim() ? n.trim() : null;
  } catch { return null; }
}
function consultantAdminView(r: ConsultantRow, extra: Record<string, unknown> = {}) {
  const { disciplines_json, languages_json, ...rest } = r;
  return { ...rest, rate: r.rate_rupees, disciplines: parseArr(disciplines_json), languages: parseArr(languages_json), ...extra };
}
/** [AUMFE-CONSULT-LAND-1] The admin screens also show the attached user's email and the (non-seed) rating. */
async function consultantAdminFull(env: Env, r: ConsultantRow): Promise<Record<string, unknown>> {
  const [email, rating] = await Promise.all([
    r.uid ? emailFor(env, r.uid).catch(() => null) : Promise.resolve(null),
    ratingFor(env, r.id, false).catch(() => ({ rating_avg: null, rating_count: 0 })),
  ]);
  return consultantAdminView(r, { attached_email: email, ...rating });
}

export async function adminRoutes(req: Request, env: Env, p: string, ctx?: ExecutionContext): Promise<Response | null> {
  if (!p.startsWith("/api/consultants/admin/")) return null;
  const parts = p.slice("/api/consultants/admin/".length).split("/").filter(Boolean);
  const method = req.method;
  const [a, id, sub] = parts;

  // route table: [first segment, has id, sub, methods]
  type Handler = () => Promise<Response>;
  let handler: Handler | null = null;
  let action = "";
  const db = metaDb(env);

  const auth = await requireUser(req, env);
  if (isFail(auth)) return err(auth.status, auth.error);
  if (!isConsultAdmin(env, auth.uid)) return err(403, "admin_only");
  const adminUid = auth.uid;
  const url = new URL(req.url);
  const fire = (act: string, props: Record<string, unknown> = {}) => { const t = track(env, adminUid, "consult_admin_action", APP, { action: act, ok: true, ...props }); ctx?.waitUntil(t); };

  // ---------- consultants ----------
  if (a === "consultants" && !id && method === "GET") {
    handler = async () => {
      const rs = await db.prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM consult_bookings b WHERE b.consultant_id = c.id AND b.status IN ('confirmed','in_call','completed')) AS paid_bookings
           FROM consultants c ORDER BY c.sort_order ASC, c.created_at ASC LIMIT 500`,
      ).all<ConsultantRow & { paid_bookings: number }>();
      return json({ consultants: await Promise.all((rs.results ?? []).map((r) => consultantAdminFull(env, r))) });
    };
  } else if (a === "consultants" && !id && method === "POST") {
    action = "create";
    handler = async () => {
      const b = await readJson(req);
      const name = text(b.name, 80);
      if (!name) return err(400, "bad_name");
      const slug = text(b.slug, 60) || slugify(name);
      if (!slugOk(slug)) return err(400, "bad_slug");
      if (await consultantBySlug(env, slug)) return err(409, "slug_taken");
      const patch = validateAdminPatch({ disciplines: b.disciplines ?? [DISCIPLINES[0]], ...pick(b, ["tagline", "bio", "lineage", "city", "languages", "years", "rate", "rate_floor", "rate_ceil", "sort_order", "slot_minutes", "buffer_minutes", "status"]) },
        { rate_rupees: 500, rate_floor: 300, rate_ceil: 5000 });
      if (!patch.ok) return err(400, patch.error);
      const v = patch.value;
      const now = Date.now();
      const cid = newId("cn_", 16);
      await db.prepare(
        `INSERT INTO consultants (id, uid, slug, name, disciplines_json, photo_url, photo_hero_url, tagline, bio, lineage, city, languages_json, years,
           rate_rupees, rate_floor, rate_ceil, slot_minutes, buffer_minutes, status, strikes, is_seed, sort_order, created_at, updated_at)
         VALUES (?,NULL,?,?,?,'',NULL,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?)`,
      ).bind(cid, slug, name, v.disciplines_json, v.tagline ?? null, v.bio ?? null, v.lineage ?? null, v.city ?? null, v.languages_json ?? "[]", v.years ?? null,
        v.rate_rupees ?? 500, v.rate_floor ?? 300, v.rate_ceil ?? 5000, v.slot_minutes ?? 30, v.buffer_minutes ?? 0, v.status ?? "draft", v.sort_order ?? 100, now, now).run();
      await audit(env, adminUid, "create", cid, { slug, name });
      fire("create", { consultant_id: cid });
      return json({ consultant: await consultantAdminFull(env, (await consultantById(env, cid))!) }, 201);
    };
  } else if (a === "consultants" && id && !sub && method === "PATCH") {
    action = "patch";
    handler = async () => {
      const c = await consultantById(env, id);
      if (!c) return err(404, "not_found");
      const b = await readJson(req);
      const v = validateAdminPatch(b, c);
      if (!v.ok) return err(400, v.error);
      const keys = Object.keys(v.value);
      if (v.value.slug && v.value.slug !== c.slug && (await consultantBySlug(env, String(v.value.slug)))) return err(409, "slug_taken");
      await db.prepare(`UPDATE consultants SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).bind(...keys.map((k) => v.value[k]), Date.now(), id).run();
      await audit(env, adminUid, "patch", id, { fields: v.value });
      fire("patch", { consultant_id: id, fields: keys });
      return json({ consultant: await consultantAdminFull(env, (await consultantById(env, id))!) });
    };
  } else if (a === "consultants" && id && sub === "attach" && method === "POST") {
    action = "attach";
    handler = async () => {
      const c = await consultantById(env, id);
      if (!c) return err(404, "not_found");
      const b = await readJson(req);
      let uid = text(b.uid, 200);
      if (!uid) {
        const q = await peopleQuery(text(b.email, 200) || null);
        if (!q?.emailHash) return err(400, "email_or_uid_required");
        const u = await db.prepare("SELECT uid FROM users WHERE email_hash = ? LIMIT 1").bind(q.emailHash).first<{ uid: string }>();
        if (!u) return err(404, "user_not_found");
        uid = u.uid;
      } else {
        const u = await db.prepare("SELECT uid FROM users WHERE uid = ?").bind(uid).first<{ uid: string }>();
        if (!u) return err(404, "user_not_found");
      }
      if (c.uid && c.uid !== uid) return err(409, "consultant_already_has_user");
      const other = await consultantByUid(env, uid);
      if (other && other.id !== id) return err(409, "user_attached_elsewhere", { consultant_id: other.id });
      await db.prepare("UPDATE consultants SET uid = ?, updated_at = ? WHERE id = ?").bind(uid, Date.now(), id).run();
      await audit(env, adminUid, "attach", id, { uid });
      fire("attach", { consultant_id: id });
      return json({ consultant: await consultantAdminFull(env, (await consultantById(env, id))!), email: await emailFor(env, uid).catch(() => null) });
    };
  } else if (a === "consultants" && id && sub === "detach" && method === "POST") {
    action = "detach";
    handler = async () => {
      const c = await consultantById(env, id);
      if (!c) return err(404, "not_found");
      await db.prepare("UPDATE consultants SET uid = NULL, updated_at = ? WHERE id = ?").bind(Date.now(), id).run();
      await audit(env, adminUid, "detach", id, { uid: c.uid });
      fire("detach", { consultant_id: id });
      return json({ consultant: await consultantAdminFull(env, (await consultantById(env, id))!) });
    };
  } else if (a === "consultants" && id && sub === "photo" && method === "POST") {
    action = "photo";
    handler = async () => {
      const c = await consultantById(env, id);
      if (!c) return err(404, "not_found");
      const ct = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!["image/jpeg", "image/png", "image/webp"].includes(ct)) return err(415, "image_only");
      const bytes = await req.arrayBuffer();
      if (!bytes.byteLength) return err(400, "empty_body");
      if (bytes.byteLength > MAX_PHOTO) return err(413, "too_large");
      const key = `consultants/${id}-${Date.now()}.jpg`;
      await env.BLOBS.put(key, bytes, { httpMetadata: { contentType: ct } });
      const photo = `${env.BLOSSOM_BASE_URL}/${key}`;
      await db.prepare("UPDATE consultants SET photo_url = ?, photo_hero_url = ?, updated_at = ? WHERE id = ?").bind(photo, photo, Date.now(), id).run();
      await audit(env, adminUid, "photo", id, { key, bytes: bytes.byteLength });
      fire("photo", { consultant_id: id });
      return json({ photo_url: photo, photo_hero_url: photo });
    };
  }

  // ---------- bookings ----------
  else if (a === "bookings" && !id && method === "GET") {
    handler = async () => {
      const status = url.searchParams.get("status") || "";
      const q = (url.searchParams.get("q") || "").trim();
      const where: string[] = []; const binds: unknown[] = [];
      if (status) { where.push("b.status = ?"); binds.push(status); }
      if (q) {
        const like = `%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
        const ors = ["b.ref LIKE ? ESCAPE '\\'", "c.name LIKE ? ESCAPE '\\'", "b.uid = ?"];
        binds.push(like, like, q);
        const pq = await peopleQuery(q);
        if (pq?.emailHash) { ors.push("b.uid IN (SELECT uid FROM users WHERE email_hash = ?)"); binds.push(pq.emailHash); }
        where.push(`(${ors.join(" OR ")})`);
      }
      const rs = await db.prepare(
        `SELECT b.*, c.name AS consultant_name, c.slug AS consultant_slug FROM consult_bookings b JOIN consultants c ON c.id = b.consultant_id
          ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY b.created_at DESC LIMIT 100`,
      ).bind(...binds).all<any>();
      const rows = rs.results ?? [];
      const emails = new Map<string, string | null>();
      for (const u of [...new Set(rows.map((r) => String(r.uid)))]) emails.set(u, await emailFor(env, u).catch(() => null));
      return json({
        bookings: rows.map((r) => ({
          id: r.id, ref: r.ref, status: r.status, discipline: r.discipline, consultant: { id: r.consultant_id, name: r.consultant_name, slug: r.consultant_slug },
          customer: { uid: r.uid, email: emails.get(String(r.uid)) ?? null, name: intakeName(r.intake_json) },
          payment: { utr: r.utr, payer_vpa: r.payer_vpa, confirm_source: r.confirm_source, confirmed_at: r.confirmed_at, unique_amount_paise: r.amount_paise, note: r.review_note },
          refund: r.refund_utr ? { utr: r.refund_utr, at: r.refunded_at, note: null } : null,
          slot_start_ms: r.slot_start_ms, slot_end_ms: r.slot_end_ms,
          price: { rate: r.rate_rupees, gst: r.gst_rupees, total: r.total_rupees, fee: r.fee_rupees, payout: r.payout_rupees, gst_rate_pct: 18, fee_rate_pct: 20 },
          pay_method: r.pay_method, utr: r.utr, payer_vpa: r.payer_vpa, paid_claimed_at: r.paid_claimed_at, confirm_source: r.confirm_source, review_note: r.review_note,
          refund_utr: r.refund_utr, refunded_at: r.refunded_at, cancel_reason: r.cancel_reason, prep_status: r.prep_status, created_at: r.created_at, expires_at: r.expires_at,
        })),
      });
    };
  } else if (a === "bookings" && id && sub === "confirm-payment" && method === "POST") {
    action = "confirm_payment";
    handler = async () => {
      const b = await db.prepare("SELECT id, status FROM consult_bookings WHERE id = ?").bind(id).first<{ id: string; status: string }>();
      if (!b) return err(404, "not_found");
      if (!["held", "awaiting_review"].includes(b.status)) return err(409, "not_awaiting_payment", { status: b.status });
      const note = text((await readJson(req)).note, 300);
      // Lane W1 owns the confirm transition (idempotent: stamps receipt, notifies customer + consultant, queues prep).
      const { confirmConsultBooking } = await import("../../lib/consultants/payment");
      const result = await confirmConsultBooking(env, id, { via: "admin", bankReference: null, adminUid, note: note || null });
      await audit(env, adminUid, "confirm_payment", id, { note });
      fire("confirm_payment", { booking_id: id });
      if (result !== "confirmed") return err(409, result === "lost" ? "already_settled" : "confirm_failed", { result });
      return json({ ok: true, result });
    };
  } else if (a === "bookings" && id && sub === "refund" && method === "POST") {
    action = "refund";
    handler = async () => {
      const b = await db.prepare("SELECT id, status, refund_utr FROM consult_bookings WHERE id = ?").bind(id).first<{ id: string; status: string; refund_utr: string | null }>();
      if (!b) return err(404, "not_found");
      if (!REFUNDABLE.includes(b.status)) return err(409, "not_refundable", { status: b.status });
      if (b.refund_utr) return err(409, "already_refunded");
      const body = await readJson(req);
      const utr = text(body.utr, 40);
      if (!/^[A-Za-z0-9-]{6,40}$/.test(utr)) return err(400, "utr_required");
      const note = text(body.note, 300);
      const now = Date.now();
      // Bookkeeping only: the admin has already refunded the customer by hand. No money moves here.
      await db.prepare(
        `UPDATE consult_bookings SET refund_utr = ?, refunded_at = ?, status = 'cancelled',
           cancel_reason = COALESCE(cancel_reason, ?), review_note = CASE WHEN ? <> '' THEN ? ELSE review_note END, updated_at = ? WHERE id = ? AND refund_utr IS NULL`,
      ).bind(utr, now, b.status === "cancelled" ? null : `refunded:${b.status}`, note, note, now, id).run();
      await audit(env, adminUid, "refund", id, { utr, note, from_status: b.status });
      fire("refund", { booking_id: id });
      return json({ ok: true, status: "cancelled", refund_utr: utr, refunded_at: now });
    };
  } else if (a === "bookings" && id && sub === "cancel" && method === "POST") {
    action = "cancel";
    handler = async () => {
      const b = await db.prepare("SELECT id, status FROM consult_bookings WHERE id = ?").bind(id).first<{ id: string; status: string }>();
      if (!b) return err(404, "not_found");
      if (!CANCELLABLE.includes(b.status)) return err(409, "not_cancellable", { status: b.status });
      const reason = text((await readJson(req)).reason, 300);
      if (reason.length < 3) return err(400, "reason_required");
      const r = await db.prepare("UPDATE consult_bookings SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ? AND status = ?").bind(reason, Date.now(), id, b.status).run();
      if (!r.meta?.changes) return err(409, "changed_meanwhile");
      await audit(env, adminUid, "cancel", id, { reason, from_status: b.status });
      fire("cancel", { booking_id: id });
      // A paid booking that is cancelled still owes the customer money: the admin must refund by hand, then record it via /refund.
      return json({ ok: true, status: "cancelled", refund_needed: b.status === "confirmed" });
    };
  }

  // ---------- reviews ----------
  else if (a === "reviews" && !id && method === "GET") {
    handler = async () => {
      const st = url.searchParams.get("status") || "pending";
      if (!["pending", "approved", "rejected", "seed"].includes(st)) return err(400, "bad_status");
      const page = Math.max(1, Math.floor(Number(url.searchParams.get("page") || 1)) || 1); // [AUMFE-CONSULT-LAND-1] 1-based, as the admin UI pages
      const where = st === "seed" ? "r.seed = 1" : "r.seed = 0 AND r.status = ?";
      const [rs, cnt] = await Promise.all([
        db.prepare(
          `SELECT r.id, r.booking_id, r.consultant_id, c.name AS consultant_name, c.slug AS consultant_slug, r.stars, r.text, r.display_name, r.discipline, r.status, r.seed, r.moderated_by, r.moderated_at, r.created_at
             FROM consult_reviews r LEFT JOIN consultants c ON c.id = r.consultant_id WHERE ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
        ).bind(...(st === "seed" ? [] : [st]), PAGE, (page - 1) * PAGE).all<any>(),
        db.prepare(
          `SELECT SUM(CASE WHEN seed = 0 AND status = 'pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN seed = 0 AND status = 'approved' THEN 1 ELSE 0 END) AS approved,
                  SUM(CASE WHEN seed = 0 AND status = 'rejected' THEN 1 ELSE 0 END) AS rejected, SUM(CASE WHEN seed = 1 THEN 1 ELSE 0 END) AS seed FROM consult_reviews`,
        ).first<Record<string, number | null>>(),
      ]);
      const counts = { pending: Number(cnt?.pending || 0), approved: Number(cnt?.approved || 0), rejected: Number(cnt?.rejected || 0), seed: Number(cnt?.seed || 0) };
      const total = counts[st as keyof typeof counts];
      const reviews = (rs.results ?? []).map((r) => ({
        ...r, seed: r.seed === 1, consultant: { name: r.consultant_name, slug: r.consultant_slug }, customer_name: r.display_name, verified: !!r.booking_id,
      }));
      return json({ reviews, page, pages: Math.max(1, Math.ceil(total / PAGE)), has_more: page * PAGE < total, counts });
    };
  }


  if (!handler) return null;
  try {
    return await handler();
  } catch (e) {
    await trackException(env, e, { route: `/api/consultants/admin/${a}${id ? "/:id" : ""}${sub ? "/" + sub : ""}`, method, handled: true, app_name: APP, extra: { area: "consult_admin", action, uid: adminUid } });
    if (String(e).includes("UNIQUE")) return err(409, "conflict");
    return err(500, "server_error");
  }
}

function pick(b: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of keys) if (k in b) o[k] = b[k];
  return o;
}
