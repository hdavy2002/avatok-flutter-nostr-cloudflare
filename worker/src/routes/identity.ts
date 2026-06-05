// Identity + directory: profile upsert, resolve, search, push-token register.
// All move from KV (prof:/handle:/email:/phone:) to D1 DB_META.
import type { Env } from "../types";
import { json, sha256Hex, normalizePhone } from "../util";
import { metaDb } from "../db/shard";
import { authenticate, isErr } from "../auth";

// POST /profile — identity comes from the signed request, not client-claimed fields.
export async function postProfile(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const now = Date.now();
  const handle = b.handle ? String(b.handle).toLowerCase().trim() : null;
  const email_hash = b.email ? await sha256Hex(String(b.email).toLowerCase().trim()) : null;

  await metaDb(env).prepare(
    `INSERT INTO profiles (npub, handle, display_name, bio, avatar_url, email_hash, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7)
     ON CONFLICT(npub) DO UPDATE SET
       handle=COALESCE(?2, handle), display_name=COALESCE(?3, display_name),
       bio=COALESCE(?4, bio), avatar_url=COALESCE(?5, avatar_url),
       email_hash=COALESCE(?6, email_hash), updated_at=?7`,
  ).bind(auth.npub, handle, b.display_name ?? null, b.bio ?? null, b.avatar_url ?? null, email_hash, now).run();

  if (b.phone) {
    const ph = await sha256Hex(normalizePhone(String(b.phone)));
    await metaDb(env).prepare(
      `INSERT OR REPLACE INTO contact_phone_index (phone_hash, npub, updated_at) VALUES (?1,?2,?3)`,
    ).bind(ph, auth.npub, now).run();
  }
  return json({ ok: true, npub: auth.npub });
}

// GET /resolve?q=  (public read) — npub / @handle / email / phone
export async function getResolve(req: Request, env: Env): Promise<Response> {
  const q = (new URL(req.url).searchParams.get("q") || "").trim();
  if (!q) return json({ error: "q required" }, 400);
  const db = metaDb(env);
  let npub: string | null = null;

  if (q.startsWith("npub1")) {
    npub = q;
  } else if (q.startsWith("@")) {
    npub = (await db.prepare("SELECT npub FROM profiles WHERE handle=?1").bind(q.slice(1).toLowerCase()).first<{ npub: string }>())?.npub ?? null;
  } else if (q.includes("@")) {
    npub = (await db.prepare("SELECT npub FROM profiles WHERE email_hash=?1").bind(await sha256Hex(q.toLowerCase())).first<{ npub: string }>())?.npub ?? null;
  } else if (/^[+\d][\d\s\-]{4,}$/.test(q)) {
    npub = (await db.prepare("SELECT npub FROM contact_phone_index WHERE phone_hash=?1").bind(await sha256Hex(normalizePhone(q))).first<{ npub: string }>())?.npub ?? null;
  } else {
    npub = (await db.prepare("SELECT npub FROM profiles WHERE handle=?1").bind(q.toLowerCase()).first<{ npub: string }>())?.npub ?? null;
  }
  if (!npub) return json({ found: false });
  const profile = await db.prepare(
    "SELECT npub, handle, display_name, bio, avatar_url FROM profiles WHERE npub=?1",
  ).bind(npub).first();
  return json({ found: true, profile: profile ?? { npub } });
}

// GET /search?q=  (public read)
export async function getSearch(req: Request, env: Env): Promise<Response> {
  const q = (new URL(req.url).searchParams.get("q") || "").trim().toLowerCase();
  if (q.length < 2) return json({ results: [] });
  const like = `%${q}%`;
  const rs = await metaDb(env).prepare(
    "SELECT npub, handle, display_name, avatar_url FROM profiles WHERE handle LIKE ?1 OR LOWER(display_name) LIKE ?1 LIMIT 25",
  ).bind(like).all();
  return json({ results: rs.results ?? [] });
}

// POST /register — push token registry → D1 (was KV).
export async function postRegister(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.token || !["fcm", "apns"].includes(b.platform)) {
    return json({ error: "platform ('fcm'|'apns') + token required" }, 400);
  }
  await metaDb(env).prepare(
    "INSERT OR REPLACE INTO push_tokens (npub, platform, token, updated_at) VALUES (?1,?2,?3,?4)",
  ).bind(auth.npub, b.platform, b.token, Date.now()).run();
  return json({ ok: true });
}
