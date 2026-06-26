// Hardened API contract (Cloudflare-native; Nostr deprecated). Identity is the
// Clerk user id (uid), verified from the Clerk JWT at the edge via requireUser —
// the caller can only act as themselves. The directory lives in the `users`
// table (uid PK). Public reads (resolve / search / handle/check / communities)
// are unauthenticated and cached upstream.
//
// D1 reads use the Sessions API (one session per DB per request) → nearest
// replica with read-after-write consistency within the request.
import type { Env } from "../types";
import { json, sha256Hex, normalizePhone, chunk } from "../util";
import { metaSession } from "../db/shard";
import { requireUser, isFail } from "../authz";
import { verifyClerk } from "../auth";
import { nameFor } from "../lib/identity";
import { brainFact } from "../hooks";
import { guardWrite } from "./moderate"; // save-time content validation (Nemotron)

// ---- push: /api/register /api/call /api/notify /api/call-status ----
export async function register(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as { token?: string; platform?: string };
  if (!b.token) return json({ error: "token required" }, 400);
  const platform = b.platform === "apns" ? "apns" : "fcm";
  const db = metaSession(env);
  await db.prepare(
    "INSERT OR REPLACE INTO push_tokens_v2 (uid, platform, token, updated_at) VALUES (?1,?2,?3,?4)",
  ).bind(ctx.uid, platform, b.token, Date.now()).run();
  const c = await db.prepare("SELECT count(*) AS n FROM push_tokens_v2 WHERE uid=?1").bind(ctx.uid).first<{ n: number }>();
  return json({ ok: true, devices: c?.n ?? 1 });
}

async function tokenCount(db: D1Database | D1DatabaseSession, uid: string): Promise<number> {
  const c = await db.prepare("SELECT count(*) AS n FROM push_tokens_v2 WHERE uid=?1").bind(uid).first<{ n: number }>();
  return c?.n ?? 0;
}

export async function call(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as { to?: string; callId?: string; kind?: string; fromName?: string };
  if (!b.to || !b.callId) return json({ error: "to and callId required" }, 400);
  // Read the callee's device count from the PRIMARY (plain prepare), not an
  // unconstrained replica — avoids a stale 0-token false-404 on a registered device.
  const n = await tokenCount(env.DB_META, b.to);
  if (n === 0) return json({ error: "callee has no registered devices" }, 404);
  // Resolve the caller's real name SERVER-SIDE (Clerk first name → app
  // display_name/handle) instead of trusting the client. The client was sending
  // the raw uid, so the callee's incoming-call screen showed "user_xxx…" / an
  // npub instead of the person's name. Fall back to the client value, then the
  // app name. nameFor is KV-cached, so this adds no per-call DB round-trip.
  const resolved = await nameFor(env, ctx.uid).catch(() => null);
  const clientName = (b.fromName ?? "").trim();
  const resolvedName = resolved || clientName || "AvaTOK";
  const nameSource = resolved ? "resolved" : (clientName ? "client" : "fallback");
  await env.Q_PUSH.send({ kind: "call", to: b.to, from: ctx.uid, fromName: resolvedName, callId: b.callId, callType: b.kind ?? "audio", ts: Date.now() });
  // Observability: which path produced the caller name (resolved server-side vs
  // the legacy client value vs the generic fallback), plus the call attempt — so
  // the "incoming call shows uid/npub" fix is measurable and call volume/route is
  // visible. Best-effort; telemetry must never block placing a call.
  try {
    void env.Q_ANALYTICS.send({
      event: "call_push_sent", uid: ctx.uid, ts: Date.now(),
      props: {
        to: b.to, call_id: b.callId, call_type: b.kind ?? "audio",
        name_source: nameSource, devices: n,
        app_name: "avatok", service_name: "avatok-api", worker: true, account_id: ctx.uid,
      },
    });
  } catch { /* best-effort */ }
  // AI Ringback (Specs/proposals/PROPOSAL-AI-RINGBACK-TONES.md): hand the CALLER
  // the callee's CURRENT default ringtone so it plays locally during the ring
  // phase. Resolved at dial time so changing the default takes effect next call.
  // Best-effort — a lookup failure must never block placing the call.
  let ringbackUrl = "";
  try {
    const r = await env.DB_META
      .prepare("SELECT url FROM ringtones WHERE account_id=?1 AND is_default=1 LIMIT 1")
      .bind(b.to).first<{ url: string }>();
    ringbackUrl = r?.url ?? "";
  } catch { /* table missing / no default → caller uses the bundled fallback */ }
  return json({ sent: n, ringbackUrl });
}

export async function notify(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as { to?: string[]; fromName?: string };
  if (!Array.isArray(b.to) || !b.to.length) return json({ error: "to[] required" }, 400);
  let queued = 0;
  for (const uid of b.to.slice(0, 64)) {
    await env.Q_PUSH.send({ kind: "notify", to: uid, fromName: (b.fromName || "AvaTOK").slice(0, 60), ts: Date.now() });
    queued++;
  }
  return json({ sent: queued });
}

export async function callStatus(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as { to?: string; callId?: string; status?: string };
  if (!b.to || !b.callId || !b.status) return json({ error: "to, callId, status required" }, 400);
  await env.Q_PUSH.send({ kind: "call-status", to: b.to, callId: b.callId, status: b.status, ts: Date.now() });
  return json({ sent: 1 });
}

// ---- directory: /api/profile (auth) /api/resolve /api/search /api/handle/check (public) ----

// Handle = 3–20 chars, lowercase letters/digits/underscore, starts with a letter.
const HANDLE_RE = /^[a-z][a-z0-9_]{2,19}$/;
export function normalizeHandle(h: string): string {
  return (h || "").trim().toLowerCase().replace(/^@/, "");
}

// GET /api/handle/check?q=<handle>&uid=<caller?> — public. A handle owned by the
// caller's own uid reads as available ("mine"); owned by anyone else → taken.
export async function handleCheck(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const handle = normalizeHandle(url.searchParams.get("q") || "");
  const uid = (url.searchParams.get("uid") || "").trim();
  if (!HANDLE_RE.test(handle)) {
    return json({ handle, valid: false, available: false, reason: "3–20 characters: letters, numbers or _, starting with a letter." });
  }
  const r = await metaSession(env).prepare("SELECT uid FROM users WHERE handle=?1").bind(handle).first<{ uid: string }>();
  if (!r) return json({ handle, valid: true, available: true });
  if (uid && r.uid === uid) return json({ handle, valid: true, available: true, mine: true });
  return json({ handle, valid: true, available: false });
}

export async function profileUpsert(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as {
    handle?: string; name?: string; email?: string; phone?: string;
    account_kind?: string; avatar_url?: string; birth_year?: number; bio?: string;
  };
  // Optional self-description — AvaBrain learns from it. Capped + trimmed; an
  // explicit empty string clears it, undefined leaves it unchanged.
  const bio = b.bio === undefined ? null : String(b.bio).trim().slice(0, 600);
  // Optional birth year — powers coarse age-group analytics only (13+); never shown publicly.
  let birthYear: number | null = null;
  if (b.birth_year !== undefined && b.birth_year !== null && b.birth_year !== 0) {
    const y = Math.trunc(Number(b.birth_year));
    if (!(y >= 1900 && y <= new Date().getFullYear() - 13)) return json({ error: "invalid_birth_year" }, 400);
    birthYear = y;
  }
  const handle = normalizeHandle(b.handle || "") || null;
  const name = (b.name || "").trim() || null;
  const avatarUrl = typeof b.avatar_url === "string" ? b.avatar_url.trim() : null;
  const email = (b.email || "").trim().toLowerCase();
  const emailHash = email ? await sha256Hex(email) : null;
  const phoneHash = b.phone ? await sha256Hex(normalizePhone(b.phone)) : null;
  const now = Date.now();
  const db = metaSession(env);
  if (handle !== null) {
    if (!HANDLE_RE.test(handle)) {
      return json({ error: "invalid_handle", reason: "3–20 characters: letters, numbers or _, starting with a letter." }, 400);
    }
    // Owned by a DIFFERENT account → taken. (No keypair reclaim — uid IS the account.)
    const taken = await db.prepare("SELECT uid FROM users WHERE handle=?1 AND uid<>?2").bind(handle, ctx.uid).first<{ uid: string }>();
    if (taken) return json({ error: "handle_taken" }, 409);
  }
  // Save-time content validation (Nemotron): block an abusive name/handle/bio
  // before it's persisted and shown in the directory.
  const blocked = await guardWrite(req, env, ctx.uid, "profile", [
    { text: name, field: "name" },
    { text: handle, field: "handle" },
    { text: bio, field: "bio" },
  ]);
  if (blocked) return blocked;
  try {
    await db.prepare(
      `INSERT INTO users (uid, handle, display_name, avatar_url, email_hash, phone_hash, birth_year, bio, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?9,?8,?8)
       ON CONFLICT(uid) DO UPDATE SET
         handle=COALESCE(?2,handle), display_name=COALESCE(?3,display_name),
         avatar_url=COALESCE(?4,avatar_url), email_hash=COALESCE(?5,email_hash),
         phone_hash=COALESCE(?6,phone_hash), birth_year=COALESCE(?7,birth_year),
         bio=COALESCE(?9,bio), updated_at=?8`,
    ).bind(ctx.uid, handle, name, avatarUrl, emailHash, phoneHash, birthYear, now, bio).run();
  } catch (e) {
    if (String((e as Error)?.message || "").includes("UNIQUE")) return json({ error: "handle_taken" }, 409);
    throw e;
  }
  // Feed a non-empty self-description to AvaBrain so Ava can personalise. Scoped
  // 'private' (personal context, not a public directory fact); the brain consumer
  // still honours the user's AvaBrain consent toggle before storing it.
  if (bio) brainFact(env, ctx.uid, "profile_bio", "profile", { bio }, "private");
  return json({ ok: true, profile: { uid: ctx.uid, handle, name, email: b.email || "", phone: b.phone || "" } });
}

// GET /api/me — restore endpoint. Authenticated by the Clerk JWT. Looks the
// account up by uid and returns the public profile so a fresh install rehydrates.
export async function me(req: Request, env: Env): Promise<Response> {
  const clerk = await verifyClerk(env, req.headers.get("authorization"));
  if ("skipped" in clerk) return json({ found: false, clerk_enabled: false });
  if ("error" in clerk) return json({ error: "clerk: " + clerk.error }, 401);
  const uid = clerk.clerkUserId;
  const prof = await metaSession(env).prepare(
    "SELECT handle, display_name, avatar_url, birth_year, bio FROM users WHERE uid=?1",
  ).bind(uid).first<{ handle: string | null; display_name: string | null; avatar_url: string | null; birth_year: number | null; bio: string | null }>();
  if (!prof) return json({ found: false, clerk_enabled: true, uid });
  return json({
    found: true, clerk_enabled: true, uid,
    handle: prof.handle ?? null, display_name: prof.display_name ?? null, avatar_url: prof.avatar_url ?? null,
    birth_year: prof.birth_year ?? null, bio: prof.bio ?? null,
  });
}

// ---- encrypted per-user vault: /api/vault (auth) — uid-keyed opaque blobs ----
const VAULT_KINDS = new Set(["contacts", "settings", "apps"]);
const VAULT_MAX = 600_000;

export async function vaultPut(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as { kind?: string; blob?: string };
  const kind = (b.kind || "").trim().toLowerCase();
  const blob = typeof b.blob === "string" ? b.blob : "";
  if (!VAULT_KINDS.has(kind)) return json({ error: "bad kind" }, 400);
  if (!blob || blob.length > VAULT_MAX) return json({ error: "blob missing or too large" }, 400);
  await metaSession(env).prepare(
    `INSERT INTO user_vault (uid, kind, blob, updated_at) VALUES (?1,?2,?3,?4)
     ON CONFLICT(uid, kind) DO UPDATE SET blob=?3, updated_at=?4`,
  ).bind(ctx.uid, kind, blob, Date.now()).run();
  return json({ ok: true });
}

export async function vaultGet(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const kind = (new URL(req.url).searchParams.get("kind") || "").trim().toLowerCase();
  if (!VAULT_KINDS.has(kind)) return json({ error: "bad kind" }, 400);
  const r = await metaSession(env).prepare(
    "SELECT blob, updated_at FROM user_vault WHERE uid=?1 AND kind=?2",
  ).bind(ctx.uid, kind).first<{ blob: string; updated_at: number }>();
  return json({ blob: r?.blob ?? null, updated_at: r?.updated_at ?? 0 });
}

function profOut(r: any) {
  return r ? { uid: r.uid, handle: r.handle, name: r.display_name, avatar_url: r.avatar_url } : null;
}

// Resolve a query (uid / @handle / email / phone) → the target's uid + profile.
export async function resolve(req: Request, env: Env): Promise<Response> {
  const q = (new URL(req.url).searchParams.get("q") || "").trim();
  if (!q) return json({ error: "q required" }, 400);
  const db = metaSession(env);
  const fetchProf = (uid: string) => db.prepare("SELECT uid,handle,display_name,avatar_url FROM users WHERE uid=?1").bind(uid).first();

  if (q.startsWith("user_")) return json({ uid: q, profile: profOut(await fetchProf(q)) });
  if (q.includes("@") && q.includes(".")) {
    const r = await db.prepare("SELECT uid FROM users WHERE email_hash=?1 ORDER BY updated_at DESC LIMIT 1").bind(await sha256Hex(q.toLowerCase())).first<{ uid: string }>();
    if (!r) return json({ uid: null }, 404);
    return json({ uid: r.uid, profile: profOut(await fetchProf(r.uid)) });
  }
  if (/[0-9]/.test(q) && q.replace(/[^0-9]/g, "").length >= 6) {
    const r = await db.prepare("SELECT uid FROM users WHERE phone_hash=?1 ORDER BY updated_at DESC LIMIT 1").bind(await sha256Hex(normalizePhone(q))).first<{ uid: string }>();
    if (r) return json({ uid: r.uid, profile: profOut(await fetchProf(r.uid)) });
  }
  const handle = q.toLowerCase().replace(/^@/, "");
  const r = await db.prepare("SELECT uid FROM users WHERE handle=?1").bind(handle).first<{ uid: string }>();
  if (!r) return json({ uid: null }, 404);
  return json({ uid: r.uid, profile: profOut(await fetchProf(r.uid)) });
}

// Directory search by handle / display name (prefix LIKE; index-backed on handle).
export async function search(req: Request, env: Env): Promise<Response> {
  const q = (new URL(req.url).searchParams.get("q") || "").trim().toLowerCase();
  if (q.length < 2) return json({ results: [] });
  const safe = q.replace(/[%_]/g, "");
  const pre = safe + "%";          // prefix match for handle / display name
  const sub = "%" + safe + "%";    // substring match for bio ("find that designer")
  // People search now also matches BIO, so "designer", "photographer", etc. surface
  // the right AvaTOK person even when it isn't in their name or handle.
  const rs = await metaSession(env).prepare(
    `SELECT uid, handle, display_name, avatar_url, bio FROM users
      WHERE handle LIKE ?1 OR lower(display_name) LIKE ?1 OR lower(bio) LIKE ?2 LIMIT 20`,
  ).bind(pre, sub).all();
  return json({ results: (rs.results ?? []).map((r: any) => ({ uid: r.uid, handle: r.handle, name: r.display_name, avatar_url: r.avatar_url, bio: r.bio ?? null })) });
}

// ---- contacts: /api/contacts/sync /api/contacts/match (auth) /list ----
interface RawContact { name?: string; emails?: string[]; phones?: string[]; }

async function matchContacts(db: D1DatabaseSession, contacts: RawContact[]): Promise<any[]> {
  // hash -> the exact normalized phone/email that produced it, so we can echo it
  // back: the client maps the match to the precise number/address. `name` is also
  // echoed for backward-compat with older clients that key the result on it.
  const phoneHashes = new Map<string, { name: string; phone: string }>();
  const emailHashes = new Map<string, { name: string; email: string }>();
  for (const c of contacts) {
    for (const p of c.phones ?? []) {
      const norm = normalizePhone(p);
      phoneHashes.set(await sha256Hex(norm), { name: c.name ?? "", phone: norm });
    }
    for (const e of c.emails ?? []) {
      const norm = String(e).toLowerCase().trim();
      emailHashes.set(await sha256Hex(norm), { name: c.name ?? "", email: norm });
    }
  }
  const matched: any[] = [];
  const seen = new Set<string>();
  for (const hs of chunk([...phoneHashes.keys()])) {
    const rs = await db.prepare(
      `SELECT phone_hash AS h, uid, handle, display_name, avatar_url FROM users WHERE phone_hash IN (${hs.map((_, i) => `?${i + 1}`).join(",")})`,
    ).bind(...hs).all();
    for (const r of (rs.results ?? []) as any[]) {
      if (seen.has(r.uid)) continue; seen.add(r.uid);
      const m = phoneHashes.get(r.h);
      matched.push({ name: m?.name ?? "", phone: m?.phone ?? "", uid: r.uid, handle: r.handle, display_name: r.display_name, avatar_url: r.avatar_url ?? "" });
    }
  }
  for (const hs of chunk([...emailHashes.keys()])) {
    const rs = await db.prepare(
      `SELECT email_hash AS h, uid, handle, display_name, avatar_url FROM users WHERE email_hash IN (${hs.map((_, i) => `?${i + 1}`).join(",")})`,
    ).bind(...hs).all();
    for (const r of (rs.results ?? []) as any[]) {
      if (seen.has(r.uid)) continue; seen.add(r.uid);
      const m = emailHashes.get(r.h);
      matched.push({ name: m?.name ?? "", email: m?.email ?? "", uid: r.uid, handle: r.handle, display_name: r.display_name, avatar_url: r.avatar_url ?? "" });
    }
  }
  return matched;
}

export async function contactsSync(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as { contacts?: RawContact[] };
  const contacts = Array.isArray(b.contacts) ? b.contacts.slice(0, 5000) : [];
  return json({ stored: contacts.length, matched: await matchContacts(metaSession(env), contacts) });
}

export async function contactsMatch(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as { contacts?: RawContact[] };
  return json({ matched: await matchContacts(metaSession(env), Array.isArray(b.contacts) ? b.contacts : []) });
}

export function contactsList(): Response {
  return json({ updated: 0, contacts: [] });
}

// ---- communities: /api/community /api/community/join (auth) /communities (public) ----
export async function communityUpsert(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.name) return json({ error: "name required" }, 400);
  const owner = ctx.uid;
  const id = String(b.id || crypto.randomUUID());
  const now = Date.now();
  const db = metaSession(env);
  await db.prepare(
    `INSERT INTO communities (id, name, description, avatar_url, owner_uid, created_at)
     VALUES (?1,?2,?3,NULL,?4,?5) ON CONFLICT(id) DO UPDATE SET name=?2, description=?3`,
  ).bind(id, String(b.name).trim(), String(b.about || "").trim(), owner, now).run();
  const members: string[] = Array.from(new Set([owner, ...((b.members) || [])]));
  for (const m of members) {
    await db.prepare("INSERT OR IGNORE INTO community_members (community_id, uid, role, joined_at) VALUES (?1,?2,?3,?4)")
      .bind(id, m, m === owner ? "owner" : "member", now).run();
  }
  return json({ ok: true, community: await communityObj(db, id) });
}

export async function communityJoin(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as { id?: string };
  if (!b.id) return json({ error: "id required" }, 400);
  const db = metaSession(env);
  const exists = await db.prepare("SELECT 1 FROM communities WHERE id=?1").bind(b.id).first();
  if (!exists) return json({ error: "not found" }, 404);
  await db.prepare("INSERT OR IGNORE INTO community_members (community_id, uid, role, joined_at) VALUES (?1,?2,'member',?3)")
    .bind(b.id, ctx.uid, Date.now()).run();
  return json({ ok: true, community: await communityObj(db, b.id) });
}

async function communityObj(db: D1DatabaseSession, id: string): Promise<any> {
  const c = await db.prepare("SELECT id,name,description,owner_uid,created_at FROM communities WHERE id=?1").bind(id).first<any>();
  if (!c) return null;
  const m = await db.prepare("SELECT uid FROM community_members WHERE community_id=?1").bind(id).all();
  return { id: c.id, name: c.name, about: c.description, owner: c.owner_uid, created: c.created_at, members: (m.results ?? []).map((x: any) => x.uid), groups: [] };
}

export async function communities(req: Request, env: Env): Promise<Response> {
  const sp = new URL(req.url).searchParams;
  const db = metaSession(env);
  const id = sp.get("id");
  if (id) { const c = await communityObj(db, id); return c ? json({ community: c }) : json({ error: "not found" }, 404); }
  const member = (sp.get("member") || "").trim();
  if (!member) return json({ communities: [] });
  const ids = await db.prepare("SELECT community_id FROM community_members WHERE uid=?1 LIMIT 100").bind(member).all();
  const out: any[] = [];
  for (const r of (ids.results ?? []) as any[]) { const c = await communityObj(db, r.community_id); if (c) out.push(c); }
  return json({ communities: out });
}

// ---- backup: deprecated with the relay. Message history now lives in InboxDO;
// a uid-scoped export will be re-added off the InboxDO sync log if needed. ----
export async function backup(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  return json({ error: "backup deprecated — relay removed; history lives in your InboxDO" }, 501);
}
