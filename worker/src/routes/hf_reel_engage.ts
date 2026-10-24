// [HF-REEL-ENGAGE-API-1] Likes and comments on every reel (HF-REEL-53..57). Flag hfReelEngageEnabled (off -> 404 not_enabled). Contract: Specs/HF-REEL-ENGAGE-1.md §4.
//   POST   /api/hf/reels/:id/like                 signed in + WhatsApp verified, idempotent -> { ok, liked:true,  likes:{platform,ours,total} }
//   DELETE /api/hf/reels/:id/like                 signed in, idempotent                      -> { ok, liked:false, likes:{platform,ours,total} }
//   GET    /api/hf/reels/:id/comments?cursor=     public (bearer optional)  -> { ok, counts:{likes:{..},comments:{..}}, likedByMe, items:[comment], nextCursor }
//   POST   /api/hf/reels/:id/comments {body,parentId?}  -> { ok, item:comment, counts }   422 empty | too_long | no_links | not_allowed | bad_parent
//   DELETE /api/hf/reels/comments/:cid            author or admin (soft delete)              -> { ok }
//   POST   /api/hf/reels/comments/:cid/report {reason}  one report per user; hfReelCommentHideAt reports hide it -> { ok, reported:true, hidden }
// comment = { id, source:'ours'|'youtube'|'instagram', author:{name,avatar,url?}, body, likeCount?, createdAt, mine, parentId?, replies?:[comment] }. Never a uid or phone.
// Order: our newest first, then the platform's top comments (imported, YouTube only); 20 a page; replies one level deep. Imported comments are pulled by lib/hf_reel_engage.ts (read only, HF-REEL-54).
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { track, trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { readConfig } from "./config";
import { isAdminUid } from "../lib/preview";
import { verifiedWhatsAppNumber } from "../lib/whatsapp_notify";
import { obviousSexualPrompt } from "../lib/hf_merch_ai";
import { optionalUid, visibleReel } from "./hf_reels";
import { canPullComments, engageOn, importAllowed, extImportDone, hideAtOf, maxLenOf, recountStmt, refreshExtComments, split, ourCounts } from "../lib/hf_reel_engage";

const APP = BRAND.slug;
const NO_STORE = { "cache-control": "private, no-store" };
const err = (status: number, error: string, message?: string) => json({ ok: false, error, message: message ?? error }, status, NO_STORE);
const PAGE = 20;
const RE_REEL = /^\/api\/hf\/reels\/((?:hfrl|hfiv)_[a-z0-9]{8,40})\/(like|comments)$/;
const RE_DEL = /^\/api\/hf\/reels\/comments\/(hfrc_[a-f0-9]{20})$/;
const RE_REPORT = /^\/api\/hf\/reels\/comments\/(hfrc_[a-f0-9]{20}|youtube:[A-Za-z0-9_.-]{8,80}|instagram:[0-9]{5,30})\/report$/;
const OURS_ID = /^hfrc_[a-f0-9]{20}$/;
const EXT_ID = /^(?:youtube:[A-Za-z0-9_.-]{8,80}|instagram:[0-9]{5,30})$/;
const LINK = /(https?:\/\/|www\.)/i;
const NOT_VERIFIED = "Please verify your WhatsApp number first.";

interface OursRow { id: string; uid: string; parent_id: string | null; body: string; created_at: number; display_name: string | null; avatar_url: string | null }
interface ExtRow { id: string; platform: string; author_name: string | null; author_avatar: string | null; author_url: string | null; body: string; like_count: number; published_at: number | null; fetched_at: number }

/** The name other people see: the user's display name; never a phone number or an email. */
export function publicName(raw: string | null | undefined): string {
  const n = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  return !n || /\d{6,}/.test(n) || n.includes("@") ? "A fan" : n;
}
const https = (v: unknown): string | null => (typeof v === "string" && v.startsWith("https://") ? v : null);

function oursItem(r: OursRow, me: string | null) {
  return {
    id: r.id, source: "ours" as const, author: { name: publicName(r.display_name), avatar: https(r.avatar_url) }, body: r.body,
    createdAt: Number(r.created_at), mine: !!me && r.uid === me, ...(r.parent_id ? { parentId: r.parent_id } : {}),
  };
}
function extItem(r: ExtRow) {
  return {
    id: r.id, source: r.platform === "instagram" ? ("instagram" as const) : ("youtube" as const),
    author: { name: r.author_name || "YouTube user", avatar: https(r.author_avatar), url: https(r.author_url) ?? undefined },
    body: r.body, likeCount: Number(r.like_count ?? 0), createdAt: Number(r.published_at ?? r.fetched_at), mine: false,
  };
}

const parseBody = async (req: Request): Promise<Record<string, unknown> | null> => {
  const txt = await req.text().catch(() => "");
  try { const b = txt && txt.length < 4000 ? JSON.parse(txt) : null; return b && typeof b === "object" ? b : null; } catch { return null; }
};

async function countsFor(env: Env, reel: { id: string; likes: number; comments: number }) {
  const o = (await ourCounts(env, [reel.id])).get(reel.id);
  return { likes: split(reel.likes, o?.likes), comments: split(reel.comments, o?.comments) };
}

export async function hfReelEngageRoute(req: Request, env: Env, p: string, ctx?: ExecutionContext): Promise<Response | null> {
  const m1 = p.match(RE_REEL);
  const m2 = p.match(RE_DEL);
  const m3 = p.match(RE_REPORT);
  if (!m1 && !m2 && !m3) return null;
  const method = req.method;
  const kind = m1 ? m1[2] : m2 ? "delete" : "report";
  const okMethods = kind === "like" ? ["POST", "DELETE"] : kind === "comments" ? ["GET", "POST"] : kind === "delete" ? ["DELETE"] : ["POST"];
  if (!okMethods.includes(method)) return err(405, "method_not_allowed");
  const bg = (pr: Promise<unknown>) => { if (ctx) ctx.waitUntil(pr.catch(() => {})); else void pr.catch(() => {}); };
  let uidForErr: string | undefined;
  try {
    const cfg = (await readConfig(env)) as unknown as Record<string, unknown>;
    if (!engageOn(cfg)) return err(404, "not_enabled");
    const now = Date.now();

    // ── GET comments (public) ─────────────────────────────────────────────────────────────────────────────────────
    if (m1 && kind === "comments" && method === "GET") {
      const id = m1[1];
      const reel = await visibleReel(env, cfg, id);
      if (!reel) return err(404, "not_found", "That video is not available any more.");
      const me = await optionalUid(req, env);
      const cursor = new URL(req.url).searchParams.get("cursor") ?? "";
      const cOurs = cursor.match(/^o:(\d{1,15})_(hfrc_[a-f0-9]{20})$/);
      const cExt = cursor.match(/^x:(\d{1,5})$/);
      if (cursor && !cOurs && !cExt) return err(400, "invalid_field", "Bad page marker.");
      // Stale-while-revalidate: show what we have, refresh YouTube in the background (older than 6 h or never pulled).
      // [HF-REEL-COMMENTS-ONCE-1] The reel's platform comments are imported ONCE (a random 18-30), the first time its sheet opens (or by the
      // daily cron for new reels). We wait for it so the sheet opens with them; after that we never call YouTube / treg for this reel again.
      if (!cursor && (reel.platform === "youtube" || reel.platform === "instagram") && canPullComments(env, reel.platform) && (await importAllowed(env, cfg, id, reel.platform)) && !(await extImportDone(env, id))) { // [HF-CHANNEL-LOGIN-P1] [HF-IG-LOGIN-1]
        await refreshExtComments(env, id, reel.videoId, fetch, reel.platform);
      }
      const items: any[] = [];
      let nextCursor: string | null = null;
      let extOffset = 0;
      let doExt = !!cExt;
      if (cExt) extOffset = Number(cExt[1]);
      else {
        const rows = (await env.DB_META.prepare(
          `SELECT c.id, c.uid, c.parent_id, c.body, c.created_at, u.display_name AS display_name, u.avatar_url AS avatar_url
           FROM hf_reel_comments c LEFT JOIN users u ON u.uid=c.uid
           WHERE c.reel_id=?1 AND c.status='visible' AND c.parent_id IS NULL${cOurs ? " AND (c.created_at<?3 OR (c.created_at=?3 AND c.id<?4))" : ""}
           ORDER BY c.created_at DESC, c.id DESC LIMIT ?2`,
        ).bind(...(cOurs ? [id, PAGE + 1, Number(cOurs[1]), cOurs[2]] : [id, PAGE + 1])).all<OursRow>()).results ?? [];
        const page = rows.slice(0, PAGE);
        for (const r of page) items.push(oursItem(r, me));
        const last = page[page.length - 1];
        if (rows.length > PAGE && last) nextCursor = `o:${last.created_at}_${last.id}`;
        else doExt = true;
      }
      if (doExt) {
        const room = PAGE - items.length;
        const ext = (await env.DB_META.prepare(
          `SELECT e.id, e.platform, e.author_name, e.author_avatar, e.author_url, e.body, e.like_count, e.published_at, e.fetched_at FROM hf_reel_ext_comments e
           WHERE e.reel_id=?1 AND (SELECT COUNT(*) FROM hf_reel_comment_reports rp WHERE rp.comment_id=e.id)<?4
           ORDER BY e.like_count DESC, e.published_at DESC, e.id ASC LIMIT ?2 OFFSET ?3`,
        ).bind(id, room + 1, extOffset, hideAtOf(cfg)).all<ExtRow>()).results ?? [];
        for (const r of ext.slice(0, room)) items.push(extItem(r));
        if (ext.length > room) nextCursor = `x:${extOffset + room}`;
      }
      // One level of replies (ours only), oldest first, under the comments on this page.
      const parentIds = items.map((i) => i.id);
      if (parentIds.length) {
        const rep = (await env.DB_META.prepare(
          `SELECT c.id, c.uid, c.parent_id, c.body, c.created_at, u.display_name AS display_name, u.avatar_url AS avatar_url
           FROM hf_reel_comments c LEFT JOIN users u ON u.uid=c.uid
           WHERE c.reel_id=?1 AND c.status='visible' AND c.parent_id IN (${parentIds.map((_, i) => `?${i + 2}`).join(",")}) ORDER BY c.created_at ASC, c.id ASC LIMIT 200`,
        ).bind(id, ...parentIds).all<OursRow>()).results ?? [];
        for (const r of rep) {
          const parent = items.find((i) => i.id === r.parent_id);
          if (parent) (parent.replies ??= []).push(oursItem(r, me));
        }
      }
      const liked = me ? !!(await env.DB_META.prepare("SELECT 1 AS x FROM hf_reel_likes WHERE reel_id=?1 AND uid=?2").bind(id, me).first()) : false;
      return json({ ok: true, counts: await countsFor(env, reel), likedByMe: liked, items, nextCursor }, 200, NO_STORE);
    }

    // ── everything below needs a signed-in account ───────────────────────────────────────────────────────────────
    const u = await requireUser(req, env);
    if (isFail(u)) return err(u.status, u.error);
    const uid = u.uid;
    uidForErr = uid;

    // ── DELETE a comment (author or admin) ───────────────────────────────────────────────────────────────────────
    if (m2) {
      const row = await env.DB_META.prepare("SELECT id, reel_id, uid, status FROM hf_reel_comments WHERE id=?1").bind(m2[1]).first<{ id: string; reel_id: string; uid: string; status: string }>();
      if (!row || (row.uid !== uid && !isAdminUid(env, uid))) return err(404, "not_found", "We could not find that comment.");
      if (row.status !== "deleted") {
        await env.DB_META.batch([env.DB_META.prepare("UPDATE hf_reel_comments SET status='deleted', body='' WHERE id=?1").bind(row.id), recountStmt(env, row.reel_id, now)]);
      }
      return json({ ok: true }, 200, NO_STORE);
    }

    // ── POST report ──────────────────────────────────────────────────────────────────────────────────────────────
    if (m3) {
      if (!(await verifiedWhatsAppNumber(env, uid))) return err(403, "not_verified", NOT_VERIFIED);
      const limited = await rateLimit(env, `hfcmtrep:${uid}`, 20, 600);
      if (limited) return limited;
      const b = await parseBody(req);
      const reason = (typeof b?.reason === "string" ? b.reason.trim() : "").slice(0, 200) || "other";
      const cid = m3[1];
      let reelId = "";
      let hidden = false;
      const hideAt = hideAtOf(cfg);
      if (OURS_ID.test(cid)) {
        const row = await env.DB_META.prepare("SELECT reel_id, status FROM hf_reel_comments WHERE id=?1").bind(cid).first<{ reel_id: string; status: string }>();
        if (!row || row.status === "deleted") return err(404, "not_found", "We could not find that comment.");
        reelId = row.reel_id;
        await env.DB_META.batch([
          env.DB_META.prepare("INSERT OR IGNORE INTO hf_reel_comment_reports (comment_id, uid, reason, created_at) VALUES (?1,?2,?3,?4)").bind(cid, uid, reason, now),
          env.DB_META.prepare(
            `UPDATE hf_reel_comments SET reports=(SELECT COUNT(*) FROM hf_reel_comment_reports WHERE comment_id=?1),
               status=CASE WHEN status='visible' AND (SELECT COUNT(*) FROM hf_reel_comment_reports WHERE comment_id=?1)>=?2 THEN 'hidden' ELSE status END WHERE id=?1`,
          ).bind(cid, hideAt),
          recountStmt(env, reelId, now),
        ]);
        hidden = (await env.DB_META.prepare("SELECT status FROM hf_reel_comments WHERE id=?1").bind(cid).first<{ status: string }>())?.status === "hidden";
      } else if (EXT_ID.test(cid)) {
        const row = await env.DB_META.prepare("SELECT reel_id FROM hf_reel_ext_comments WHERE id=?1").bind(cid).first<{ reel_id: string }>();
        if (!row) return err(404, "not_found", "We could not find that comment.");
        reelId = row.reel_id;
        await env.DB_META.prepare("INSERT OR IGNORE INTO hf_reel_comment_reports (comment_id, uid, reason, created_at) VALUES (?1,?2,?3,?4)").bind(cid, uid, reason, now).run();
        const n = (await env.DB_META.prepare("SELECT COUNT(*) AS n FROM hf_reel_comment_reports WHERE comment_id=?1").bind(cid).first<{ n: number }>())?.n ?? 0;
        hidden = Number(n) >= hideAt;
      }
      bg(track(env, uid, "hf_reel_comment_report", APP, { reel_id: reelId, source: OURS_ID.test(cid) ? "ours" : "youtube", hidden }));
      return json({ ok: true, reported: true, hidden }, 200, NO_STORE);
    }

    // ── like / unlike / comment on a visible reel ────────────────────────────────────────────────────────────────
    const id = m1![1];
    const reel = await visibleReel(env, cfg, id);
    if (!reel) return err(404, "not_found", "That video is not available any more.");

    if (kind === "like") {
      const on = method === "POST";
      if (on) {
        if (!(await verifiedWhatsAppNumber(env, uid))) return err(403, "not_verified", NOT_VERIFIED);
        const limited = await rateLimit(env, `hflike:${uid}`, 60, 60);
        if (limited) return limited;
      }
      await env.DB_META.batch([
        on ? env.DB_META.prepare("INSERT OR IGNORE INTO hf_reel_likes (reel_id, uid, created_at) VALUES (?1,?2,?3)").bind(id, uid, now)
          : env.DB_META.prepare("DELETE FROM hf_reel_likes WHERE reel_id=?1 AND uid=?2").bind(id, uid),
        recountStmt(env, id, now),
      ]);
      const c = await countsFor(env, reel);
      bg(track(env, uid, "hf_reel_like", APP, { reel_id: id, on, platform: reel.platform }));
      return json({ ok: true, liked: on, likes: c.likes }, 200, NO_STORE);
    }

    // POST comment
    if (!(await verifiedWhatsAppNumber(env, uid))) return err(403, "not_verified", NOT_VERIFIED);
    const b = await parseBody(req);
    const text = typeof b?.body === "string" ? b.body.trim() : "";
    const parentId = typeof b?.parentId === "string" && b.parentId ? b.parentId : null;
    const max = maxLenOf(cfg);
    if (!text) return err(422, "empty", "Write something first.");
    if (text.length > max) return err(422, "too_long", `Please keep it under ${max} characters.`);
    if (LINK.test(text)) return err(422, "no_links", "Links are not allowed in comments.");
    if (obviousSexualPrompt(text)) return err(422, "not_allowed", "That comment is not allowed.");
    if (parentId) {
      let okParent = false;
      if (OURS_ID.test(parentId)) {
        const pr = await env.DB_META.prepare("SELECT parent_id, status FROM hf_reel_comments WHERE id=?1 AND reel_id=?2").bind(parentId, id).first<{ parent_id: string | null; status: string }>();
        okParent = !!pr && pr.status === "visible" && !pr.parent_id;
      } else if (EXT_ID.test(parentId)) {
        okParent = !!(await env.DB_META.prepare("SELECT 1 AS x FROM hf_reel_ext_comments WHERE id=?1 AND reel_id=?2").bind(parentId, id).first());
      }
      if (!okParent) return err(422, "bad_parent", "You can only reply to a comment on this video.");
    }
    const limited = await rateLimit(env, `hfcmt:${uid}`, 10, 600);
    if (limited) return limited;
    const cid = "hfrc_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    await env.DB_META.batch([
      env.DB_META.prepare("INSERT INTO hf_reel_comments (id, reel_id, uid, parent_id, body, status, reports, created_at) VALUES (?1,?2,?3,?4,?5,'visible',0,?6)").bind(cid, id, uid, parentId, text, now),
      recountStmt(env, id, now),
    ]);
    const me = await env.DB_META.prepare("SELECT display_name, avatar_url FROM users WHERE uid=?1").bind(uid).first<{ display_name: string | null; avatar_url: string | null }>().catch(() => null);
    const item = oursItem({ id: cid, uid, parent_id: parentId, body: text, created_at: now, display_name: me?.display_name ?? null, avatar_url: me?.avatar_url ?? null }, uid);
    bg(track(env, uid, "hf_reel_comment_sent", APP, { reel_id: id, len: text.length, is_reply: !!parentId }));
    return json({ ok: true, item, counts: await countsFor(env, reel) }, 200, NO_STORE);
  } catch (e) {
    await trackException(env, e, { uid: uidForErr, route: p, method, handled: true, app_name: APP, extra: { area: "hf_reel_engage" } });
    return err(500, "internal_error", "Something went wrong. Please try again.");
  }
}
