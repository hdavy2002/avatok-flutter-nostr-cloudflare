// Identity + directory: profile upsert, resolve, search, push-token register.
// All move from KV (prof:/handle:/email:/phone:) to D1 DB_META.
import type { Env } from "../types";
import { json, sha256Hex, normalizePhone } from "../util";
import { metaDb } from "../db/shard";
import { requireUser, isFail } from "../authz";

// POST /profile — identity comes from the signed request, not client-claimed fields.
export async function postProfile(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const now = Date.now();
  const handle = b.handle ? String(b.handle).toLowerCase().trim() : null;
  const email_hash = b.email ? await sha256Hex(String(b.email).toLowerCase().trim()) : null;

  await metaDb(env).prepare(
    `INSERT INTO users (uid, handle, display_name, bio, avatar_url, email_hash, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7)
     ON CONFLICT(uid) DO UPDATE SET
       handle=COALESCE(?2, handle), display_name=COALESCE(?3, display_name),
       bio=COALESCE(?4, bio), avatar_url=COALESCE(?5, avatar_url),
       email_hash=COALESCE(?6, email_hash), updated_at=?7`,
  ).bind(ctx.uid, handle, b.display_name ?? null, b.bio ?? null, b.avatar_url ?? null, email_hash, now).run();

  if (b.phone) {
    const ph = await sha256Hex(normalizePhone(String(b.phone)));
    await metaDb(env).prepare(
      `INSERT OR REPLACE INTO contact_phone_index (phone_hash, uid, updated_at) VALUES (?1,?2,?3)`,
    ).bind(ph, ctx.uid, now).run();
  }
  return json({ ok: true, uid: ctx.uid });
}

// GET /resolve?q=  (public read) — uid / @handle / email / phone
export async function getResolve(req: Request, env: Env): Promise<Response> {
  const q = (new URL(req.url).searchParams.get("q") || "").trim();
  if (!q) return json({ error: "q required" }, 400);
  const db = metaDb(env);
  let uid: string | null = null;

  if (q.startsWith("npub1")) {
    uid = q;
  } else if (q.startsWith("@")) {
    uid = (await db.prepare("SELECT uid FROM users WHERE handle=?1").bind(q.slice(1).toLowerCase()).first<{ uid: string }>())?.uid ?? null;
  } else if (q.includes("@")) {
    uid = (await db.prepare("SELECT uid FROM users WHERE email_hash=?1").bind(await sha256Hex(q.toLowerCase())).first<{ uid: string }>())?.uid ?? null;
  } else if (/^[+\d][\d\s\-]{4,}$/.test(q)) {
    uid = (await db.prepare("SELECT uid FROM contact_phone_index WHERE phone_hash=?1").bind(await sha256Hex(normalizePhone(q))).first<{ uid: string }>())?.uid ?? null;
  } else {
    uid = (await db.prepare("SELECT uid FROM users WHERE handle=?1").bind(q.toLowerCase()).first<{ uid: string }>())?.uid ?? null;
  }
  if (!uid) return json({ found: false });
  const profile = await db.prepare(
    "SELECT uid, handle, display_name, bio, avatar_url FROM users WHERE uid=?1",
  ).bind(uid).first<{ uid: string; handle?: string; display_name?: string; bio?: string; avatar_url?: string }>();
  // `uid` MUST be at the TOP LEVEL — the app (Directory.resolve) reads j['uid']
  // as the addressing id. Nesting it only under `profile` made every email/
  // handle/phone resolve return null, so the contact had no routable id and DMs
  // to them never left "waiting to reach phone". Also expose `name` (mapped from
  // display_name), which the client reads.
  return json({
    found: true,
    uid,
    avatar_url: profile?.avatar_url ?? "",
    profile: {
      uid,
      handle: profile?.handle ?? "",
      name: profile?.display_name ?? "",
      display_name: profile?.display_name ?? "",
      avatar_url: profile?.avatar_url ?? "",
      bio: profile?.bio ?? "",
    },
  });
}

// GET /search?q=  (public read)
export async function getSearch(req: Request, env: Env): Promise<Response> {
  const q = (new URL(req.url).searchParams.get("q") || "").trim().toLowerCase();
  if (q.length < 2) return json({ results: [] });
  const like = `%${q}%`;
  const rs = await metaDb(env).prepare(
    "SELECT uid, handle, display_name, avatar_url FROM users WHERE handle LIKE ?1 OR LOWER(display_name) LIKE ?1 LIMIT 25",
  ).bind(like).all();
  return json({ results: rs.results ?? [] });
}

// POST /register — push token registry → D1 (was KV).
export async function postRegister(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.token || !["fcm", "apns"].includes(b.platform)) {
    return json({ error: "platform ('fcm'|'apns') + token required" }, 400);
  }
  await metaDb(env).prepare(
    "INSERT OR REPLACE INTO push_tokens_v2 (uid, platform, token, updated_at) VALUES (?1,?2,?3,?4)",
  ).bind(ctx.uid, b.platform, b.token, Date.now()).run();
  return json({ ok: true });
}
