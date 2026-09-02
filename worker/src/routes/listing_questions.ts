// [LIST-ASK-1] "Ask the host" — Specs/SPEC-2026-09-02-LISTING-TRUST-AND-VIBE.md §4.5.
// Schema: worker/migrations/2026-09-02-creator-stats.sql (listing_questions —
// UNIQUE(listing_id, asker_id), promotable into an existing listings.attrs key,
// content_faq). Table comment there names the companion issue explicitly.
//
// Number-masking rule (§4.5): a pre-purchase question is public-ish (the creator
// sees it, and a promoted one becomes a public FAQ entry) so it must never carry
// a phone number or an off-platform link — that is exactly the AvaTOK-number
// masking rule applied to free-text instead of a phone field.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb, metaSession } from "../db/shard";
import { track } from "../hooks";
import { brainIngest } from "../lib/brain_ingest";
import { notifyUser } from "../notify";
import { rateLimit } from "../money";

const APP = "avaexplore"; // matches routes/listings.ts and routes/reviews.ts

function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== "string" || !s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

/** Strip off-platform links and long digit runs (phone numbers) from free text
 *  before it is stored — the same "real number never public" posture as the
 *  AvaTOK-number masking rule, applied here to a free-text question/answer. */
function maskContact(s: string): string {
  return s
    .replace(/https?:\/\/\S+/gi, "[link removed]")
    .replace(/\bwww\.[^\s]+/gi, "[link removed]")
    .replace(/\d{7,}/g, "[number removed]");
}

async function nameAndAvatar(env: Env, uid: string): Promise<{ name: string; avatar_url: string | null }> {
  const r = await metaDb(env).prepare("SELECT display_name, handle, avatar_url FROM users WHERE uid=?1").bind(uid).first<any>();
  return { name: r?.display_name || r?.handle || "an AvaTOK user", avatar_url: r?.avatar_url ?? null };
}

// POST /api/listings/:id/questions {question} — one per user per listing.
export async function askQuestion(req: Request, env: Env, listingId: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const limited = await rateLimit(env, `askq:${ctx.uid}`, 5, 86_400);
  if (limited) return limited;

  const b = (await req.json().catch(() => ({}))) as any;
  const raw = String(b.question ?? "").trim();
  if (!raw) return json({ error: "question required" }, 400);
  if (raw.length > 300) return json({ error: "question must be at most 300 characters" }, 400);
  const question = maskContact(raw).slice(0, 300);

  const db = metaDb(env);
  const l = await db.prepare("SELECT creator_id FROM listings WHERE id=?1").bind(listingId).first<any>();
  if (!l) return json({ error: "not found" }, 404);
  if (l.creator_id === ctx.uid) return json({ error: "cannot ask on your own listing" }, 400);

  const now = Date.now();
  try {
    await db.prepare(
      `INSERT INTO listing_questions (id, listing_id, creator_id, asker_id, question, created_at)
       VALUES (?1,?2,?3,?4,?5,?6)`,
    ).bind(crypto.randomUUID(), listingId, l.creator_id, ctx.uid, question, now).run();
  } catch {
    // UNIQUE(listing_id, asker_id) — one open question per user per listing.
    return json({ error: "already_asked" }, 409);
  }

  try {
    await notifyUser(env, l.creator_id, {
      type: "social", title: "New question on your listing", body: question.slice(0, 80),
      data: { deeplink: `/explore/listing/${listingId}` },
    });
  } catch { /* best-effort */ }
  void brainIngest(env, {
    uid: ctx.uid, domain: "listings", kind: "listing_question_asked", sourceId: `${ctx.uid}:${listingId}`,
    text: question, meta: { listing_id: listingId },
  });
  track(env, ctx.uid, "listing_question_asked", APP, { listing_id: listingId });
  return json({ ok: true });
}

// POST /api/questions/:id/answer {answer} — creator of the listing only.
export async function answerQuestion(req: Request, env: Env, questionId: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const b = (await req.json().catch(() => ({}))) as any;
  const raw = String(b.answer ?? "").trim();
  if (!raw) return json({ error: "answer required" }, 400);
  if (raw.length > 600) return json({ error: "answer must be at most 600 characters" }, 400);
  const answer = maskContact(raw).slice(0, 600);

  const db = metaDb(env);
  const q = await db.prepare(
    "SELECT listing_id, creator_id, asker_id FROM listing_questions WHERE id=?1",
  ).bind(questionId).first<any>();
  if (!q || q.creator_id !== ctx.uid) return json({ error: "not found" }, 404);

  const now = Date.now();
  await db.prepare(
    "UPDATE listing_questions SET answer=?2, answered_at=?3 WHERE id=?1",
  ).bind(questionId, answer, now).run();

  try {
    await notifyUser(env, String(q.asker_id), {
      type: "social", title: "The host answered your question", body: answer.slice(0, 80),
      data: { deeplink: `/explore/listing/${q.listing_id}` },
    });
  } catch { /* best-effort */ }
  void brainIngest(env, {
    uid: ctx.uid, domain: "listings", kind: "listing_question_answered", sourceId: `${ctx.uid}:${questionId}`,
    text: answer, meta: { question_id: questionId, listing_id: q.listing_id },
  });
  track(env, ctx.uid, "listing_question_answered", APP, { question_id: questionId, listing_id: q.listing_id });
  return json({ ok: true, answer, answered_at: now });
}

// GET /api/questions/mine — the asker's own questions (with answers if given).
export async function listMyQuestions(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const db = metaSession(env);
  const rows = await db.prepare(
    `SELECT lq.id, lq.listing_id, lq.question, lq.answer, lq.answered_at, lq.promoted_to_faq, lq.created_at,
            l.title AS listing_title
       FROM listing_questions lq LEFT JOIN listings l ON l.id = lq.listing_id
      WHERE lq.asker_id=?1
      ORDER BY lq.created_at DESC
      LIMIT 100`,
  ).bind(ctx.uid).all();

  const items = ((rows.results ?? []) as any[]).map((r) => ({
    id: r.id,
    listing_id: r.listing_id,
    listing_title: r.listing_title ?? null,
    question: r.question,
    answer: r.answer ?? null,
    answered_at: r.answered_at ?? null,
    promoted_to_faq: !!r.promoted_to_faq,
    created_at: r.created_at,
  }));
  return json({ items });
}

// GET /api/questions/inbox[?listing_id=] — the creator's question inbox.
export async function listCreatorQuestions(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const url = new URL(req.url);
  const listingId = url.searchParams.get("listing_id");
  const db = metaSession(env);
  const where = ["lq.creator_id=?1"];
  const binds: unknown[] = [ctx.uid];
  if (listingId) { where.push("lq.listing_id=?2"); binds.push(listingId); }

  const rows = await db.prepare(
    `SELECT lq.id, lq.listing_id, lq.asker_id, lq.question, lq.answer, lq.answered_at, lq.promoted_to_faq, lq.created_at,
            l.title AS listing_title, u.display_name AS asker_name, u.avatar_url AS asker_avatar
       FROM listing_questions lq
       LEFT JOIN listings l ON l.id = lq.listing_id
       LEFT JOIN users u ON u.uid = lq.asker_id
      WHERE ${where.join(" AND ")}
      ORDER BY (lq.answered_at IS NULL) DESC, lq.created_at DESC
      LIMIT 100`,
  ).bind(...binds).all();

  const items = ((rows.results ?? []) as any[]).map((r) => ({
    id: r.id,
    listing_id: r.listing_id,
    listing_title: r.listing_title ?? null,
    asker: { uid: r.asker_id, name: r.asker_name || "an AvaTOK user", avatar_url: r.asker_avatar ?? null },
    question: r.question,
    answer: r.answer ?? null,
    answered_at: r.answered_at ?? null,
    promoted_to_faq: !!r.promoted_to_faq,
    created_at: r.created_at,
  }));
  return json({ items });
}

// POST /api/questions/:id/promote — creator promotes an answered Q&A into the
// listing's attrs.content_faq (max 6 — validateAttrs' own ceiling in
// routes/listings.ts). Direct read-modify-write of the `attrs` JSON column, per
// the migration file's own instructions — deliberately bypassing the full
// listing-update/validateAttrs path (a system append starting from as few as
// zero FAQ items must not be rejected by that path's 3-item minimum).
export async function promoteToFaq(req: Request, env: Env, questionId: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const db = metaDb(env);
  const q = await db.prepare(
    "SELECT listing_id, creator_id, question, answer, promoted_to_faq FROM listing_questions WHERE id=?1",
  ).bind(questionId).first<any>();
  if (!q || q.creator_id !== ctx.uid) return json({ error: "not found" }, 404);
  if (!q.answer) return json({ error: "question has no answer yet" }, 400);
  if (q.promoted_to_faq) return json({ ok: true, already_promoted: true });

  const l = await db.prepare("SELECT attrs FROM listings WHERE id=?1").bind(q.listing_id).first<any>();
  if (!l) return json({ error: "not found" }, 404);
  const attrs = parseJson<Record<string, unknown>>(l.attrs, {});
  const faq = Array.isArray(attrs.content_faq) ? (attrs.content_faq as any[]) : [];
  if (faq.length >= 6) return json({ error: "faq_full" }, 400);

  faq.push({ q: String(q.question).slice(0, 120), a: String(q.answer).slice(0, 300) });
  attrs.content_faq = faq;
  const now = Date.now();

  await db.batch([
    db.prepare("UPDATE listings SET attrs=?2, updated_at=?3 WHERE id=?1").bind(q.listing_id, JSON.stringify(attrs), now),
    db.prepare("UPDATE listing_questions SET promoted_to_faq=1 WHERE id=?1").bind(questionId),
  ]);

  track(env, ctx.uid, "listing_question_promoted_to_faq", APP, { question_id: questionId, listing_id: q.listing_id });
  return json({ ok: true, content_faq: faq });
}
