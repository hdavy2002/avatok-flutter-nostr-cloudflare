import type { Env } from "../types";
import { json, sha256Hex } from "../util";
import { requireAdmin } from "./admin_money";
import { generateImage } from "./ava_image";

// Admin-only moderation queue. Poster metadata is kept in listings.attrs so this
// remains compatible with the existing schema and does not alter creator data.
export async function adminListings(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const status = new URL(req.url).searchParams.get("status") || "all";
  const where = status === "all" ? "" : "WHERE l.status=?1";
  const q = await env.DB_META.prepare(`SELECT l.id,l.title,l.description,l.kind,l.status,l.price,l.cover_media,l.attrs,l.created_at,l.updated_at,l.creator_id FROM listings l ${where} ORDER BY l.updated_at DESC LIMIT 100`).bind(...(status === "all" ? [] : [status])).all<any>();
  return json({ listings: q.results ?? [], statuses: ["draft", "pending_review", "published", "rejected"] });
}

export async function adminListingAction(req: Request, env: Env, id: string): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const body = await req.json().catch(() => ({})) as any;
  const action = String(body.action || "");
  const db = env.DB_META;
  const row = await db.prepare("SELECT id,title,description,status,attrs FROM listings WHERE id=?1").bind(id).first<any>();
  if (!row) return json({ error: "not found" }, 404);
  const now = Date.now();
  if (!["approve_listing","reject_listing","generate_poster","approve_poster","reject_poster","publish"].includes(action)) return json({ error: "invalid action" }, 400);
  let attrs: any = {}; try { attrs = row.attrs ? JSON.parse(row.attrs) : {}; } catch { attrs = {}; }
  if (action === "generate_poster") {
    const prompt = String(body.prompt || `Create a vivid Indian film-poster artwork for the event titled "${row.title || "Untitled listing"}". Scene and mood: ${row.description || "a lively creator marketplace experience"}. Use fictional characters only, bold readable typography, printed-poster texture, and no real celebrity likenesses.`).slice(0, 1800);
    // Use the existing Vertex/Gemini image provider and public media bucket. The
    // generated asset is saved as a reviewable draft; admin approval is still
    // required before publish. This keeps image generation out of the card and
    // reuses the same moderation/provider path as Ava image generation.
    attrs.poster = { ...(attrs.poster || {}), status: "generating", generated_at: now, provider: "vertex", prompt_hash: await sha256Hex(prompt) };
    await db.prepare("UPDATE listings SET attrs=?2, updated_at=?3 WHERE id=?1").bind(id, JSON.stringify(attrs), now).run();
    try {
      const generated = await generateImage(env, "", prompt, a.uid);
      const hash = await sha256Hex(generated.bytes);
      const key = `u/${a.uid}/public/posters/${id}/${hash}.png`;
      await env.BLOBS.put(key, generated.bytes, { httpMetadata: { contentType: "image/png" } });
      attrs.poster = { ...attrs.poster, status: "draft", url: `${env.BLOSSOM_BASE_URL}/${key}`, key, bytes: generated.bytes.byteLength, completed_at: Date.now() };
    } catch (e) {
      attrs.poster = { ...attrs.poster, status: "failed", error: String((e as any)?.message || "provider unavailable").slice(0, 180) };
    }
  } else if (action === "approve_poster") {
    if (!attrs.poster) return json({ error: "poster not generated" }, 409);
    attrs.poster.status = "approved";
  } else if (action === "reject_poster") {
    attrs.poster = { ...(attrs.poster || {}), status: "rejected", feedback: String(body.feedback || "") };
  }
  let next = row.status;
  if (action === "approve_listing") {
    if (!["draft", "pending_review"].includes(String(row.status))) return json({ error: "listing not awaiting approval", status: row.status }, 409);
    next = "approved";
  }
  if (action === "reject_listing") next = "rejected";
  if (action === "publish") {
    if (String(row.status) !== "approved") return json({ error: "listing approval required", status: row.status }, 409);
    if (attrs.poster?.status !== "approved") return json({ error: "poster approval required" }, 409);
    next = "published";
  }
  await db.prepare("UPDATE listings SET status=?2, attrs=?3, updated_at=?4 WHERE id=?1").bind(id, next, JSON.stringify(attrs), now).run();
  // Keep moderation actions visible in the existing admin audit stream.
  try {
    await env.DB_WALLET.prepare(
      "INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
    ).bind(crypto.randomUUID(), a.uid, `listing_${action}`, id, JSON.stringify({ previous_status: row.status, next_status: next, poster_status: attrs.poster?.status ?? null }), now).run();
  } catch { /* audit is best-effort, matching existing admin routes */ }
  return json({ ok: true, id, status: next, poster: attrs.poster || null, admin_id: a.uid });
}
