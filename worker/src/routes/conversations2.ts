// P1 Conversation service — identity-keyed successor to the uid-keyed messaging
// routes (Specs/ROUTING-IDENTITY-PRESENCE-ARCH.md §5.2 + the "first contact" flow
// in §6). Built ADDITIVELY alongside routes/messaging.ts (ensureDm/members/sendMsg),
// NOT wired into index.ts yet.
//
// Frozen rules this module enforces (§5.2, §6):
//   - conv_id is RANDOM (`conv_<ulid>`), never dm(uidA,uidB) or hash(...).
//   - Participants are `identity_id` ONLY. This module NEVER stores a Clerk uid
//     as a participant. The caller's uid is turned into an identity_id via
//     ensureIdentityForUid(); every `with` target is resolved SERVER-SIDE to an
//     identity_id via resolveRoute() — the client can never name a participant by
//     a cached uid/npub (the exact spot the stale-npub misroute lived, §6).
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
// Sibling routing/identity modules (worker/src/lib/*, built in parallel — do NOT
// redefine these here). resolveRoute maps ANY id (identity_id|uid|email|number)
// to a Route (incl. its identityId); ensureIdentityForUid mints/returns the
// caller's durable identity_id; newIdentityId is the ULID id generator we reuse
// (with a `conv_` prefix swap) so conversations get random ids too.
import { resolveRoute, ensureIdentityForUid } from "../lib/routing";
import { newIdentityId } from "../lib/identity_ids";

// [ARCH-ROUTING-V2] Telemetry-before-enable: every v4 component emits PostHog
// before it is switched on (governance rule). Best-effort, never blocks a
// request. Same {event,uid,ts,props} shape as the rest of the Worker.
function track(env: Env, uid: string, event: string, props: Record<string, unknown>): void {
  try {
    void env.Q_ANALYTICS?.send({ event, uid, ts: Date.now(),
      props: { ...props, account_id: uid, app_name: "avatok", service_name: "avatok-api", worker: true } });
  } catch { /* telemetry is never load-bearing */ }
}

// Random conversation id. Reuses the same ULID generator as identities (§5.2:
// "conv_id RANDOM; encodes nothing") — we just swap the `idn_` prefix for `conv_`
// so the two id spaces never collide while sharing one monotonic-random source.
function newConvId(): string {
  const raw = newIdentityId();               // e.g. idn_<ulid>
  const ulid = raw.replace(/^idn_/, "");     // strip the identity prefix
  return `conv_${ulid}`;
}

// An already-minted identity_id (idn_<ulid>) needs no resolution — it IS the
// canonical participant key. Anything else (uid|email|number|handle) is resolved
// server-side.
function looksLikeIdentityId(s: string): boolean {
  return /^idn_[A-Za-z0-9]+$/.test(s);
}

/** Self-creating tables (codebase lazy-DDL pattern, mirrors keybackup.ts).
 *  Kept in sync with migrations/conversations_v2.sql. */
async function ensureTables(env: Env): Promise<void> {
  await env.DB_META.batch([
    env.DB_META.prepare(
      `CREATE TABLE IF NOT EXISTS conversations (
         conv_id    TEXT PRIMARY KEY,
         kind       TEXT NOT NULL,
         version    INTEGER NOT NULL DEFAULT 1,
         next_seq   INTEGER NOT NULL DEFAULT 1,
         created_at INTEGER NOT NULL
       )`,
    ),
    env.DB_META.prepare(
      `CREATE TABLE IF NOT EXISTS conversation_participants (
         conv_id     TEXT NOT NULL,
         identity_id TEXT NOT NULL,
         role        TEXT NOT NULL DEFAULT 'member',
         muted       INTEGER NOT NULL DEFAULT 0,
         archived    INTEGER NOT NULL DEFAULT 0,
         joined_at   INTEGER NOT NULL,
         PRIMARY KEY (conv_id, identity_id)
       )`,
    ),
    env.DB_META.prepare(
      "CREATE INDEX IF NOT EXISTS idx_cp_identity ON conversation_participants(identity_id)",
    ),
  ]);
}

const KINDS = new Set(["dm", "group", "agent"]);

/** Resolve ONE `with` entry (any id) to a canonical identity_id, server-side.
 *  - already an identity_id → use as-is.
 *  - otherwise (uid|email|number|handle) → resolveRoute(env, entry).identityId.
 *  Returns null when the entry can't be resolved (caller surfaces a 404/422 —
 *  we fail loud, never silently drop a participant, §10).
 *
 *  TODO(email/number): resolveRoute is the single server resolver for ALL id
 *  kinds (identity_id|uid|email|number|handle) — email/number resolution MUST go
 *  through it (or ensureIdentityForUid once it has a uid), NOT through duplicated
 *  directory SQL here. The `users` email/number lookup in routes/api.ts:resolve()
 *  is the legacy uid-directory; the identity resolver in lib/routing.ts wraps that
 *  and returns an identity_id. Keep this the ONLY resolution path so there is one
 *  source of truth for id → identity_id. */
async function resolveParticipant(env: Env, entry: string): Promise<string | null> {
  const e = entry.trim();
  if (!e) return null;
  if (looksLikeIdentityId(e)) return e;
  const route = await resolveRoute(env, e);
  return route?.identityId ?? null;
}

// ---- POST /api/conv/create --------------------------------------------------
// Body: { kind, with: [<any id: identity_id|uid|email|number|handle>...] }.
// Every `with` target is resolved SERVER-SIDE to an identity_id; the caller's own
// identity is added too. conv_id is RANDOM. Returns { conv_id, participants }.
// A DM is IDEMPOTENT: if a `dm` conversation with EXACTLY this participant set
// already exists, it's returned instead of minting a duplicate.
export async function createConversation(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  await ensureTables(env);

  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const kind = String(b?.kind || "dm");
  if (!KINDS.has(kind)) return json({ error: "bad kind" }, 400);
  const withRaw: string[] = Array.isArray(b?.with) ? b.with.map((x: any) => String(x)) : [];
  if (withRaw.length === 0) return json({ error: "with[] required" }, 400);

  // The caller's own durable identity (never their uid).
  const mine = await ensureIdentityForUid(env, ctx.uid);
  if (!mine) return json({ error: "identity_unresolved" }, 500);

  // Resolve every target server-side. Fail LOUD on an unresolvable entry (§10) —
  // a stale/unknown id must not silently produce a half-populated conversation.
  const resolved: string[] = [];
  for (const entry of withRaw) {
    const id = await resolveParticipant(env, entry);
    if (!id) return json({ error: "unresolvable_participant", entry }, 422);
    resolved.push(id);
  }

  // Full participant set = caller + resolved targets, de-duped.
  const participants = Array.from(new Set([mine, ...resolved]));

  // DM idempotency: a `dm` with EXACTLY this participant set already exists → reuse
  // it. Matched by set equality (same members AND same count) over the `dm` kind.
  if (kind === "dm") {
    const existing = await findDmByParticipants(env, participants);
    if (existing) {
      track(env, ctx.uid, "conv2_created", { conv_id: existing, kind, participants: participants.length, deduped: true });
      return json({ conv_id: existing, participants });
    }
  }

  const convId = newConvId();
  const now = Date.now();
  const stmts = [
    env.DB_META.prepare(
      "INSERT INTO conversations (conv_id, kind, version, next_seq, created_at) VALUES (?1, ?2, 1, 1, ?3)",
    ).bind(convId, kind, now),
  ];
  for (const idp of participants) {
    stmts.push(env.DB_META.prepare(
      `INSERT OR IGNORE INTO conversation_participants (conv_id, identity_id, role, muted, archived, joined_at)
       VALUES (?1, ?2, 'member', 0, 0, ?3)`,
    ).bind(convId, idp, now));
  }
  await env.DB_META.batch(stmts);
  track(env, ctx.uid, "conv2_created", { conv_id: convId, kind, participants: participants.length, deduped: false });
  return json({ conv_id: convId, participants });
}

/** Find an existing `dm` conversation whose participant set is EXACTLY `want`
 *  (same identities, same count). Returns the conv_id or null. Used only for DM
 *  idempotency — groups/agents always mint a fresh random id. */
async function findDmByParticipants(env: Env, want: string[]): Promise<string | null> {
  if (want.length === 0) return null;
  // Candidate dm conversations that contain the FIRST participant, then confirm
  // the full set matches (count + membership). Small N per identity, so this is
  // cheap; the authoritative matcher can move into a SessionDO later (§8).
  const rows = await env.DB_META.prepare(
    `SELECT cp.conv_id AS conv_id
       FROM conversation_participants cp
       JOIN conversations c ON c.conv_id = cp.conv_id
      WHERE c.kind = 'dm' AND cp.identity_id = ?1`,
  ).bind(want[0]).all<{ conv_id: string }>();
  const wantSet = new Set(want);
  for (const r of rows.results ?? []) {
    const mem = await env.DB_META.prepare(
      "SELECT identity_id FROM conversation_participants WHERE conv_id = ?1",
    ).bind(r.conv_id).all<{ identity_id: string }>();
    const have = (mem.results ?? []).map((m) => m.identity_id);
    if (have.length === wantSet.size && have.every((h) => wantSet.has(h))) return r.conv_id;
  }
  return null;
}

// ---- GET /api/conv/list -----------------------------------------------------
// The caller's conversations (kind + participant identity_ids), joined on the
// caller's OWN identity_id. This REPLACES the need for /api/conversations/adopt
// (routes/messaging.ts) — a device no longer "adopts" locally-known threads; the
// server is the source of truth for who is in what, keyed by identity.
export async function listConversations(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  await ensureTables(env);
  const mine = await ensureIdentityForUid(env, ctx.uid);
  if (!mine) return json({ error: "identity_unresolved" }, 500);

  const convRows = await env.DB_META.prepare(
    `SELECT c.conv_id AS conv_id, c.kind AS kind, c.created_at AS created_at
       FROM conversations c
       JOIN conversation_participants cp ON cp.conv_id = c.conv_id
      WHERE cp.identity_id = ?1
      ORDER BY c.created_at DESC
      LIMIT 500`,
  ).bind(mine).all<{ conv_id: string; kind: string; created_at: number }>();

  const conversations: Array<{ conv_id: string; kind: string; created_at: number; participants: string[] }> = [];
  for (const c of convRows.results ?? []) {
    const mem = await env.DB_META.prepare(
      "SELECT identity_id FROM conversation_participants WHERE conv_id = ?1",
    ).bind(c.conv_id).all<{ identity_id: string }>();
    conversations.push({
      conv_id: c.conv_id, kind: c.kind, created_at: c.created_at,
      participants: (mem.results ?? []).map((m) => m.identity_id),
    });
  }
  track(env, ctx.uid, "conv2_listed", { count: conversations.length });
  return json({ conversations });
}

// ---- GET /api/conv/participants?conv=<id> -----------------------------------
// Participant identity_ids + roles for a conversation. 403 unless the caller is
// a participant (identity-scoped authorization — Conversation owns membership,
// §5.2).
export async function getParticipants(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  await ensureTables(env);
  const conv = (new URL(req.url).searchParams.get("conv") || "").trim();
  if (!conv) return json({ error: "conv required" }, 400);
  const mine = await ensureIdentityForUid(env, ctx.uid);
  if (!mine) return json({ error: "identity_unresolved" }, 500);

  const rows = await env.DB_META.prepare(
    "SELECT identity_id, role FROM conversation_participants WHERE conv_id = ?1",
  ).bind(conv).all<{ identity_id: string; role: string }>();
  const parts = rows.results ?? [];
  if (!parts.some((p) => p.identity_id === mine)) return json({ error: "not a participant" }, 403);
  return json({ conv_id: conv, participants: parts.map((p) => ({ identity_id: p.identity_id, role: p.role })) });
}

// ---- server_sequence allocator (§8) -----------------------------------------
// Atomically read+increment conversations.next_seq for a conv and return the
// ASSIGNED server_sequence (the value the message renders at). Delivery calls
// this per accepted message so clients render by sequence, never by client
// timestamp (§8).
//
// D1 supports UPDATE ... RETURNING (SQLite 3.35+), so this is a single atomic
// statement — no read-then-write race. It returns the PRE-increment value as the
// assigned sequence (first message gets 1) and advances next_seq to the next
// free slot.
//
// INTERIM: the AUTHORITATIVE allocator will move into the conversation's
// SessionDO (§8) — a single serialization point that removes even the tiny D1
// contention window under concurrent fanout. This SQL version is the D1-native
// stand-in until the SessionDO lands.
export async function allocateSequence(env: Env, convId: string): Promise<number> {
  const row = await env.DB_META.prepare(
    "UPDATE conversations SET next_seq = next_seq + 1 WHERE conv_id = ?1 RETURNING (next_seq - 1) AS seq",
  ).bind(convId).first<{ seq: number }>();
  if (!row) throw new Error(`allocateSequence: unknown conv ${convId}`);
  return row.seq;
}
