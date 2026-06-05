// Contact discovery (hashed phone match) + communities. All D1 DB_META.
import type { Env } from "../types";
import { json, sha256Hex, normalizePhone } from "../util";
import { metaDb } from "../db/shard";
import { authenticate, isErr } from "../auth";

// POST /contacts/match  (and /contacts/sync alias)
// Body: { phones: ["+91...", ...] }  → which are on AvaTok, via hashed lookup.
// Stateless: we do NOT store the caller's address book (privacy; reverse-lookup
// is a deferred product feature). Forward index contact_phone_index is populated
// by /profile when a user opts to be discoverable.
export async function postContactsMatch(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const phones: string[] = Array.isArray(b.phones) ? b.phones.slice(0, 1000) : [];
  if (!phones.length) return json({ matches: [] });

  const hashes = await Promise.all(phones.map((p) => sha256Hex(normalizePhone(String(p)))));
  // batched WHERE phone_hash IN (...) — the Rulebook-prescribed pattern.
  const placeholders = hashes.map((_, i) => `?${i + 1}`).join(",");
  const rs = await metaDb(env).prepare(
    `SELECT cpi.phone_hash, cpi.npub, p.handle, p.display_name, p.avatar_url
     FROM contact_phone_index cpi
     LEFT JOIN profiles p ON p.npub = cpi.npub
     WHERE cpi.phone_hash IN (${placeholders})`,
  ).bind(...hashes).all();
  // Map results back to input index so the client knows which contact matched.
  const byHash = new Map<string, any>();
  for (const row of (rs.results ?? []) as any[]) byHash.set(row.phone_hash, row);
  const matches = hashes.map((h, i) => byHash.has(h) ? { input_index: i, ...byHash.get(h) } : null).filter(Boolean);
  return json({ matches });
}

// GET /contacts/list — stateless server, so this is empty. Client keeps its own
// contact list locally; use /contacts/match to refresh "who's on AvaTok".
export async function getContactsList(_req: Request, _env: Env): Promise<Response> {
  return json({ contacts: [], note: "stateless — use POST /contacts/match" });
}

// POST /community  { name, description?, avatar_url?, id? }
export async function postCommunity(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.name) return json({ error: "name required" }, 400);
  const id = String(b.id || crypto.randomUUID());
  const now = Date.now();
  await metaDb(env).prepare(
    `INSERT INTO communities (id, name, description, avatar_url, owner_npub, created_at)
     VALUES (?1,?2,?3,?4,?5,?6)
     ON CONFLICT(id) DO UPDATE SET name=?2, description=?3, avatar_url=?4`,
  ).bind(id, b.name, b.description ?? null, b.avatar_url ?? null, auth.npub, now).run();
  await metaDb(env).prepare(
    `INSERT OR IGNORE INTO community_members (community_id, npub, role, joined_at) VALUES (?1,?2,'owner',?3)`,
  ).bind(id, auth.npub, now).run();
  return json({ ok: true, id });
}

// POST /community/join  { id }
export async function joinCommunity(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.id) return json({ error: "id required" }, 400);
  await metaDb(env).prepare(
    `INSERT OR IGNORE INTO community_members (community_id, npub, role, joined_at) VALUES (?1,?2,'member',?3)`,
  ).bind(String(b.id), auth.npub, Date.now()).run();
  return json({ ok: true });
}

// GET /communities?id=<id>  |  ?member=<npub>
export async function getCommunities(req: Request, env: Env): Promise<Response> {
  const sp = new URL(req.url).searchParams;
  const id = sp.get("id");
  const member = sp.get("member");
  const db = metaDb(env);
  if (id) {
    const c = await db.prepare("SELECT * FROM communities WHERE id=?1").bind(id).first();
    if (!c) return json({ found: false });
    const m = await db.prepare("SELECT npub, role FROM community_members WHERE community_id=?1").bind(id).all();
    return json({ found: true, community: c, members: m.results ?? [] });
  }
  if (member) {
    const rs = await db.prepare(
      `SELECT c.* FROM communities c
       JOIN community_members m ON m.community_id = c.id
       WHERE m.npub = ?1 ORDER BY c.created_at DESC`,
    ).bind(member).all();
    return json({ communities: rs.results ?? [] });
  }
  return json({ error: "id or member required" }, 400);
}
