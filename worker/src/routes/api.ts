// Hardened API contract (replaces the compat layer). Every mutation requires a
// valid NIP-98 signature; the CALLER'S identity comes from that signature
// (auth.npub / auth.pubkeyHex), never from the request body — so a client can
// only write its own profile, register its own device, call as itself, etc.
// Clerk JWT is additionally verified when CLERK_JWKS_URL is set (see auth.ts).
// Public reads (resolve / search / communities / ice) are unauthenticated and
// cached upstream.
//
// D1 reads use the Sessions API (one session per DB per request) so they route
// to the nearest read replica; writes go to primary and the session bookmark
// keeps read-after-write consistent within the request.
import type { Env } from "../types";
import { json, sha256Hex, normalizePhone, chunk } from "../util";
import { metaSession, relaySession } from "../db/shard";
import { authenticate, isErr } from "../auth";

// ---- push: /api/register /api/call /api/notify /api/call-status ----
export async function register(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as { token?: string; platform?: string };
  if (!b.token) return json({ error: "token required" }, 400);
  const platform = b.platform === "apns" ? "apns" : "fcm";
  const db = metaSession(env);
  await db.prepare(
    "INSERT OR REPLACE INTO push_tokens (npub, platform, token, updated_at) VALUES (?1,?2,?3,?4)",
  ).bind(auth.npub, platform, b.token, Date.now()).run();
  const c = await db.prepare("SELECT count(*) AS n FROM push_tokens WHERE npub=?1").bind(auth.npub).first<{ n: number }>();
  return json({ ok: true, devices: c?.n ?? 1 });
}

async function tokenCount(db: D1DatabaseSession, npub: string): Promise<number> {
  const c = await db.prepare("SELECT count(*) AS n FROM push_tokens WHERE npub=?1").bind(npub).first<{ n: number }>();
  return c?.n ?? 0;
}

export async function call(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as { to?: string; callId?: string; kind?: string; fromName?: string };
  if (!b.to || !b.callId) return json({ error: "to and callId required" }, 400);
  const n = await tokenCount(metaSession(env), b.to);
  if (n === 0) return json({ error: "callee has no registered devices" }, 404);
  await env.Q_PUSH.send({ kind: "call", to: b.to, from: auth.npub, fromName: b.fromName ?? "AvaTOK", callId: b.callId, callType: b.kind ?? "audio", ts: Date.now() });
  return json({ sent: n });
}

export async function notify(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as { to?: string[]; fromName?: string };
  if (!Array.isArray(b.to) || !b.to.length) return json({ error: "to[] required" }, 400);
  let queued = 0;
  for (const npub of b.to.slice(0, 64)) {
    await env.Q_PUSH.send({ kind: "notify", to: npub, fromName: (b.fromName || "AvaTOK").slice(0, 60), ts: Date.now() });
    queued++;
  }
  return json({ sent: queued });
}

export async function callStatus(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as { to?: string; callId?: string; status?: string };
  if (!b.to || !b.callId || !b.status) return json({ error: "to, callId, status required" }, 400);
  await env.Q_PUSH.send({ kind: "call-status", to: b.to, callId: b.callId, status: b.status, ts: Date.now() });
  return json({ sent: 1 });
}

// ---- directory: /api/profile (auth) /api/resolve /api/search /api/handle/check (public) ----

// Handle = NIP-05 local part: 3–20 chars, lowercase letters/digits/underscore,
// must start with a letter. Kept in sync with the client-side validator.
const HANDLE_RE = /^[a-z][a-z0-9_]{2,19}$/;
export function normalizeHandle(h: string): string {
  return (h || "").trim().toLowerCase().replace(/^@/, "");
}

// GET /api/handle/check?q=<handle> — public. Reports whether a handle is validly
// formatted and still free. (Reveals nothing /api/resolve doesn't already.)
export async function handleCheck(req: Request, env: Env): Promise<Response> {
  const handle = normalizeHandle(new URL(req.url).searchParams.get("q") || "");
  if (!HANDLE_RE.test(handle)) {
    return json({ handle, valid: false, available: false, reason: "3–20 characters: letters, numbers or _, starting with a letter." });
  }
  const r = await metaSession(env).prepare("SELECT npub FROM profiles WHERE handle=?1").bind(handle).first<{ npub: string }>();
  return json({ handle, valid: true, available: !r });
}

export async function profileUpsert(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as { handle?: string; name?: string; email?: string; phone?: string };
  const handle = normalizeHandle(b.handle || "") || null;
  const name = (b.name || "").trim() || null;
  const email = (b.email || "").trim().toLowerCase();
  const emailHash = email ? await sha256Hex(email) : null;
  const now = Date.now();
  const db = metaSession(env);
  // Validate + enforce handle uniqueness with a clean, actionable error rather
  // than leaking a raw D1 UNIQUE-constraint 500 (which the client swallowed).
  if (handle !== null) {
    if (!HANDLE_RE.test(handle)) {
      return json({ error: "invalid_handle", reason: "3–20 characters: letters, numbers or _, starting with a letter." }, 400);
    }
    const taken = await db.prepare("SELECT npub FROM profiles WHERE handle=?1 AND npub<>?2").bind(handle, auth.npub).first<{ npub: string }>();
    if (taken) return json({ error: "handle_taken" }, 409);
  }
  try {
    await db.prepare(
      `INSERT INTO profiles (npub, handle, display_name, avatar_url, email_hash, updated_at)
       VALUES (?1,?2,?3,NULL,?4,?5)
       ON CONFLICT(npub) DO UPDATE SET handle=COALESCE(?2,handle), display_name=COALESCE(?3,display_name), email_hash=COALESCE(?4,email_hash), updated_at=?5`,
    ).bind(auth.npub, handle, name, emailHash, now).run();
  } catch (e) {
    // Lost a race for the handle between the check above and the write.
    if (String((e as Error)?.message || "").includes("UNIQUE")) return json({ error: "handle_taken" }, 409);
    throw e;
  }
  if (b.phone) {
    const ph = await sha256Hex(normalizePhone(b.phone));
    await db.prepare("INSERT OR REPLACE INTO contact_phone_index (phone_hash, npub, updated_at) VALUES (?1,?2,?3)").bind(ph, auth.npub, now).run();
  }
  return json({ ok: true, profile: { npub: auth.npub, handle, name, email: b.email || "", phone: b.phone || "" } });
}

function profOut(r: any) {
  return r ? { npub: r.npub, handle: r.handle, name: r.display_name, avatar_url: r.avatar_url } : null;
}

export async function resolve(req: Request, env: Env): Promise<Response> {
  const q = (new URL(req.url).searchParams.get("q") || "").trim();
  if (!q) return json({ error: "q required" }, 400);
  const db = metaSession(env);
  const fetchProf = (npub: string) => db.prepare("SELECT npub,handle,display_name,avatar_url FROM profiles WHERE npub=?1").bind(npub).first();

  if (q.startsWith("npub1")) return json({ npub: q, profile: profOut(await fetchProf(q)) });
  if (q.includes("@") && q.includes(".")) {
    const r = await db.prepare("SELECT npub FROM profiles WHERE email_hash=?1").bind(await sha256Hex(q.toLowerCase())).first<{ npub: string }>();
    if (!r) return json({ npub: null }, 404);
    return json({ npub: r.npub, profile: profOut(await fetchProf(r.npub)) });
  }
  if (/[0-9]/.test(q) && q.replace(/[^0-9]/g, "").length >= 6) {
    const r = await db.prepare("SELECT npub FROM contact_phone_index WHERE phone_hash=?1").bind(await sha256Hex(normalizePhone(q))).first<{ npub: string }>();
    if (r) return json({ npub: r.npub, profile: profOut(await fetchProf(r.npub)) });
  }
  const handle = q.toLowerCase().replace(/^@/, "");
  const r = await db.prepare("SELECT npub FROM profiles WHERE handle=?1").bind(handle).first<{ npub: string }>();
  if (!r) return json({ npub: null }, 404);
  return json({ npub: r.npub, profile: profOut(await fetchProf(r.npub)) });
}

export async function search(req: Request, env: Env): Promise<Response> {
  const q = (new URL(req.url).searchParams.get("q") || "").trim().toLowerCase();
  if (q.length < 2) return json({ results: [] });
  // FTS5 prefix match (index-backed, no table scan). Sanitize to bare tokens and
  // append `*` for prefix search: "da ro" → `da* ro*`.
  const terms = q.split(/[^a-z0-9]+/).filter((t) => t.length >= 2).slice(0, 6);
  if (!terms.length) return json({ results: [] });
  const matchExpr = terms.map((t) => `${t}*`).join(" ");
  const rs = await metaSession(env).prepare(
    `SELECT p.npub, p.handle, p.display_name, p.avatar_url
     FROM profiles_fts f JOIN profiles p ON p.rowid = f.rowid
     WHERE profiles_fts MATCH ?1 LIMIT 20`,
  ).bind(matchExpr).all();
  return json({ results: (rs.results ?? []).map((r: any) => ({ npub: r.npub, handle: r.handle, name: r.display_name, avatar_url: r.avatar_url })) });
}

// ---- contacts: /api/contacts/sync /api/contacts/match (auth) /list ----
interface RawContact { name?: string; emails?: string[]; phones?: string[]; }

async function matchContacts(db: D1DatabaseSession, contacts: RawContact[]): Promise<any[]> {
  const phoneHashes = new Map<string, RawContact>();
  const emailHashes = new Map<string, RawContact>();
  for (const c of contacts) {
    for (const p of c.phones ?? []) phoneHashes.set(await sha256Hex(normalizePhone(p)), c);
    for (const e of c.emails ?? []) emailHashes.set(await sha256Hex(String(e).toLowerCase().trim()), c);
  }
  const matched: any[] = [];
  const seen = new Set<string>();
  // Chunk IN(...) into batches of ≤90 — D1 caps bound params at 100 per query.
  for (const hs of chunk([...phoneHashes.keys()])) {
    const rs = await db.prepare(
      `SELECT cpi.phone_hash AS h, cpi.npub, p.handle, p.display_name FROM contact_phone_index cpi
       LEFT JOIN profiles p ON p.npub=cpi.npub WHERE cpi.phone_hash IN (${hs.map((_, i) => `?${i + 1}`).join(",")})`,
    ).bind(...hs).all();
    for (const r of (rs.results ?? []) as any[]) {
      if (seen.has(r.npub)) continue; seen.add(r.npub);
      matched.push({ name: phoneHashes.get(r.h)?.name ?? "", npub: r.npub, handle: r.handle, display_name: r.display_name });
    }
  }
  for (const hs of chunk([...emailHashes.keys()])) {
    const rs = await db.prepare(
      `SELECT email_hash AS h, npub, handle, display_name FROM profiles WHERE email_hash IN (${hs.map((_, i) => `?${i + 1}`).join(",")})`,
    ).bind(...hs).all();
    for (const r of (rs.results ?? []) as any[]) {
      if (seen.has(r.npub)) continue; seen.add(r.npub);
      matched.push({ name: emailHashes.get(r.h)?.name ?? "", npub: r.npub, handle: r.handle, display_name: r.display_name });
    }
  }
  return matched;
}

export async function contactsSync(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as { contacts?: RawContact[] };
  const contacts = Array.isArray(b.contacts) ? b.contacts.slice(0, 5000) : [];
  // Stateless: we do NOT store the caller's address book (privacy). Just match.
  return json({ stored: contacts.length, matched: await matchContacts(metaSession(env), contacts) });
}

export async function contactsMatch(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as { contacts?: RawContact[] };
  return json({ matched: await matchContacts(metaSession(env), Array.isArray(b.contacts) ? b.contacts : []) });
}

export function contactsList(): Response {
  return json({ updated: 0, contacts: [] });
}

// ---- communities: /api/community /api/community/join (auth) /communities (public) ----
export async function communityUpsert(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.name) return json({ error: "name required" }, 400);
  const owner = auth.npub;
  const id = String(b.id || crypto.randomUUID());
  const now = Date.now();
  const db = metaSession(env);
  await db.prepare(
    `INSERT INTO communities (id, name, description, avatar_url, owner_npub, created_at)
     VALUES (?1,?2,?3,NULL,?4,?5) ON CONFLICT(id) DO UPDATE SET name=?2, description=?3`,
  ).bind(id, String(b.name).trim(), String(b.about || "").trim(), owner, now).run();
  const members: string[] = Array.from(new Set([owner, ...((b.members) || [])]));
  for (const m of members) {
    await db.prepare("INSERT OR IGNORE INTO community_members (community_id, npub, role, joined_at) VALUES (?1,?2,?3,?4)")
      .bind(id, m, m === owner ? "owner" : "member", now).run();
  }
  return json({ ok: true, community: await communityObj(db, id) });
}

export async function communityJoin(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as { id?: string };
  if (!b.id) return json({ error: "id required" }, 400);
  const db = metaSession(env);
  const exists = await db.prepare("SELECT 1 FROM communities WHERE id=?1").bind(b.id).first();
  if (!exists) return json({ error: "not found" }, 404);
  await db.prepare("INSERT OR IGNORE INTO community_members (community_id, npub, role, joined_at) VALUES (?1,?2,'member',?3)")
    .bind(b.id, auth.npub, Date.now()).run();
  return json({ ok: true, community: await communityObj(db, b.id) });
}

async function communityObj(db: D1DatabaseSession, id: string): Promise<any> {
  const c = await db.prepare("SELECT id,name,description,owner_npub,created_at FROM communities WHERE id=?1").bind(id).first<any>();
  if (!c) return null;
  const m = await db.prepare("SELECT npub FROM community_members WHERE community_id=?1").bind(id).all();
  return { id: c.id, name: c.name, about: c.description, owner: c.owner_npub, created: c.created_at, members: (m.results ?? []).map((x: any) => x.npub), groups: [] };
}

export async function communities(req: Request, env: Env): Promise<Response> {
  const sp = new URL(req.url).searchParams;
  const db = metaSession(env);
  const id = sp.get("id");
  if (id) { const c = await communityObj(db, id); return c ? json({ community: c }) : json({ error: "not found" }, 404); }
  const member = (sp.get("member") || "").trim();
  if (!member) return json({ communities: [] });
  const ids = await db.prepare("SELECT community_id FROM community_members WHERE npub=?1 LIMIT 100").bind(member).all();
  const out: any[] = [];
  for (const r of (ids.results ?? []) as any[]) { const c = await communityObj(db, r.community_id); if (c) out.push(c); }
  return json({ communities: out });
}

// ---- backup: POST /api/backup → export the caller's relay data → R2 link ----
export async function backup(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const pubkey = auth.pubkeyHex;
  if (!env.DB_RELAY) return json({ error: "relay db not bound" }, 503);
  const rs = await relaySession(env).prepare(
    `SELECT DISTINCT e.id,e.pubkey,e.created_at,e.kind,e.tags,e.content,e.sig FROM nostr_events e
     LEFT JOIN nostr_tags t ON t.event_id=e.id
     WHERE e.deleted=0 AND (e.pubkey=?1 OR (e.kind=1059 AND t.tag='p' AND t.value=?1))
     ORDER BY e.created_at DESC LIMIT 10000`,
  ).bind(pubkey).all();
  const events = (rs.results ?? []).map((r: any) => ({ id: r.id, pubkey: r.pubkey, created_at: r.created_at, kind: r.kind, tags: JSON.parse(r.tags), content: r.content, sig: r.sig }));
  const key = `u/${auth.npub}/backups/${Date.now()}.json`; // under the user's folder → caught by erasure
  const data = JSON.stringify({ pubkey, count: events.length, exported_at: Date.now(), events });
  await env.BLOBS.put(key, data, { httpMetadata: { contentType: "application/json" } });
  return json({ url: `${env.BLOSSOM_BASE_URL}/${key}`, size: data.length, count: events.length });
}
