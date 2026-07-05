// Routing Service — "who currently represents this identity?".
// Design: Specs/ROUTING-IDENTITY-PRESENCE-ARCH.md (v4) §5.3, §9 (KV TTL),
//         §10 (fail loud), §12 (backfill / first-contact get-or-create).
//
// Resolves ANY id (opaque identity_id, current Clerk uid, or a legacy alias
// such as an old npub / tel / number) to the CURRENT route: identity_id →
// current_uid + generation + capabilities. It NEVER returns a region, inbox,
// or transport — Transport (§5.7) owns geography/sharding, so introducing new
// datacentres later never touches this layer.
//
// Tables are created lazily (matching keybackup.ts's ensureTable pattern) so
// the first resolve/get-or-create in a fresh env just works; migrations/
// identity_routing.sql provisions the same schema explicitly.
import type { Env } from "../types";
import { newIdentityId, isIdentityId } from "./identity_ids";

export type Route = {
  identityId: string;
  uid: string;
  generation: number;
  routingVersion: number;
  capabilities: any;
};

const ROUTE_KV_PREFIX = "route:";
const ROUTE_TTL_SECONDS = 300; // §9 — bounds failover lag; correctness never depends on it.
const MERGE_DEPTH_MAX = 8; // follow identities.merged_into up to this many hops.

/** Self-creating tables (lazy-DDL, mirrors migrations/identity_routing.sql). */
async function ensureIdentityTables(env: Env): Promise<void> {
  await env.DB_META.prepare(
    `CREATE TABLE IF NOT EXISTS identities (
       identity_id  TEXT PRIMARY KEY,
       display_name TEXT, email_hash TEXT, phone TEXT,
       verification TEXT, status TEXT NOT NULL DEFAULT 'active', merged_into TEXT,
       version      INTEGER NOT NULL DEFAULT 1,
       updated_at   INTEGER NOT NULL
     )`,
  ).run();
  await env.DB_META.prepare(
    `CREATE TABLE IF NOT EXISTS identity_aliases (
       alias TEXT NOT NULL, identity_id TEXT NOT NULL, kind TEXT NOT NULL,
       valid_from INTEGER NOT NULL, valid_to INTEGER,
       PRIMARY KEY (alias, valid_from)
     )`,
  ).run();
  await env.DB_META.prepare(
    `CREATE INDEX IF NOT EXISTS idx_alias_identity ON identity_aliases(identity_id)`,
  ).run();
  await env.DB_META.prepare(
    `CREATE TABLE IF NOT EXISTS routes (
       identity_id     TEXT PRIMARY KEY,
       current_uid     TEXT NOT NULL,
       generation      INTEGER NOT NULL DEFAULT 1,
       capabilities    TEXT,
       routing_version INTEGER NOT NULL DEFAULT 1,
       updated_at      INTEGER NOT NULL
     )`,
  ).run();
  await env.DB_META.prepare(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_routes_uid ON routes(current_uid)`,
  ).run();
}

type IdentityRow = { identity_id: string; status: string; merged_into: string | null };
type RouteRow = {
  identity_id: string;
  current_uid: string;
  generation: number;
  capabilities: string | null;
  routing_version: number;
};

/** Resolve `anyId` → its owning identity_id, following any alias row.
 *  Prefers the current alias (valid_to IS NULL); falls back to the most recent
 *  historical one. Returns null when nothing maps. */
async function identityIdFor(env: Env, anyId: string): Promise<string | null> {
  if (isIdentityId(anyId)) return anyId;
  // (1) alias table — current row preferred, else most recent by valid_from.
  const alias = await env.DB_META
    .prepare(
      `SELECT identity_id FROM identity_aliases WHERE alias = ?1
         ORDER BY (valid_to IS NULL) DESC, valid_from DESC LIMIT 1`,
    )
    .bind(anyId)
    .first<{ identity_id: string }>();
  if (alias) return alias.identity_id;
  // (2) direct route by current_uid (covers a uid with no explicit uid-alias row).
  const byUid = await env.DB_META
    .prepare(`SELECT identity_id FROM routes WHERE current_uid = ?1 LIMIT 1`)
    .bind(anyId)
    .first<{ identity_id: string }>();
  return byUid?.identity_id ?? null;
}

/** Follow identities.status='merged' via merged_into to the active identity.
 *  Depth-bounded (MERGE_DEPTH_MAX) so a cyclic/broken chain can't spin. */
async function activeIdentity(env: Env, identityId: string): Promise<IdentityRow | null> {
  let cur = identityId;
  for (let hop = 0; hop < MERGE_DEPTH_MAX; hop++) {
    const row = await env.DB_META
      .prepare(`SELECT identity_id, status, merged_into FROM identities WHERE identity_id = ?1`)
      .bind(cur)
      .first<IdentityRow>();
    if (!row) return null;
    if (row.status === "merged" && row.merged_into) {
      cur = row.merged_into;
      continue;
    }
    return row; // active / disabled / any non-merged terminal state.
  }
  return null; // merge chain too deep → treat as unroutable.
}

/** Resolve ANY id to the CURRENT route, or null (unknown/disabled → §10 fail loud).
 *  KV hot path first (route:<anyId>, TTL 5min), then D1. Never returns a
 *  region/inbox. */
export async function resolveRoute(env: Env, anyId: string): Promise<Route | null> {
  const key = ROUTE_KV_PREFIX + anyId;
  // (1) KV hot path.
  try {
    const cached = await env.TOKENS.get(key, "json");
    if (cached) return cached as Route;
  } catch {
    /* KV miss / transient → fall through to D1 */
  }

  // (2) D1 authoritative resolve.
  await ensureIdentityTables(env);
  const identityId = await identityIdFor(env, anyId);
  if (!identityId) return null;

  const ident = await activeIdentity(env, identityId);
  if (!ident) return null;
  if (ident.status !== "active") return null; // disabled/merged-with-no-target → unroutable.

  const r = await env.DB_META
    .prepare(
      `SELECT identity_id, current_uid, generation, capabilities, routing_version
         FROM routes WHERE identity_id = ?1`,
    )
    .bind(ident.identity_id)
    .first<RouteRow>();
  if (!r || !r.current_uid) return null;

  let capabilities: any = null;
  try {
    capabilities = r.capabilities ? JSON.parse(r.capabilities) : null;
  } catch {
    capabilities = null;
  }
  const route: Route = {
    identityId: r.identity_id,
    uid: r.current_uid,
    generation: r.generation,
    routingVersion: r.routing_version,
    capabilities,
  };

  // (3) cache under the id the caller actually used (300s TTL).
  try {
    await env.TOKENS.put(key, JSON.stringify(route), { expirationTtl: ROUTE_TTL_SECONDS });
  } catch {
    /* best-effort cache */
  }
  return route;
}

/** Invalidate cached routes for the given ids (call on re-key / merge / disable). */
export async function invalidateRoute(env: Env, ids: string[]): Promise<void> {
  await Promise.all(
    ids.map((id) =>
      env.TOKENS.delete(ROUTE_KV_PREFIX + id).catch(() => {
        /* best-effort */
      }),
    ),
  );
}

/** Get-or-create the identity for a Clerk uid; returns its identity_id.
 *  Idempotent — used by backfill and first-contact. If a uid-alias already
 *  exists we return its identity_id; otherwise we mint a fresh opaque
 *  identity_id and insert identities + routes(current_uid=uid) +
 *  identity_aliases(uid, kind='uid'). The uid is stored as an ALIAS, never as
 *  the identity_id, so a future uid re-key never changes identity_id. */
export async function ensureIdentityForUid(env: Env, uid: string): Promise<string> {
  await ensureIdentityTables(env);

  // Fast path — existing current uid-alias.
  const existing = await env.DB_META
    .prepare(
      `SELECT identity_id FROM identity_aliases
         WHERE alias = ?1 AND kind = 'uid'
         ORDER BY (valid_to IS NULL) DESC, valid_from DESC LIMIT 1`,
    )
    .bind(uid)
    .first<{ identity_id: string }>();
  if (existing) return existing.identity_id;

  // Defensive: a route may already exist (uid mapped without an explicit alias).
  const byRoute = await env.DB_META
    .prepare(`SELECT identity_id FROM routes WHERE current_uid = ?1 LIMIT 1`)
    .bind(uid)
    .first<{ identity_id: string }>();
  const identityId = byRoute?.identity_id ?? newIdentityId();
  const now = Date.now();

  // Idempotent inserts (safe to re-run): identities, routes, alias.
  await env.DB_META
    .prepare(
      `INSERT INTO identities (identity_id, status, version, updated_at)
         VALUES (?1, 'active', 1, ?2)
         ON CONFLICT(identity_id) DO NOTHING`,
    )
    .bind(identityId, now)
    .run();
  await env.DB_META
    .prepare(
      `INSERT INTO routes (identity_id, current_uid, generation, routing_version, updated_at)
         VALUES (?1, ?2, 1, 1, ?3)
         ON CONFLICT(identity_id) DO NOTHING`,
    )
    .bind(identityId, uid, now)
    .run();
  // Append-only alias. PK is (alias, valid_from); DO NOTHING guards a re-run
  // that lands on the same millisecond.
  await env.DB_META
    .prepare(
      `INSERT INTO identity_aliases (alias, identity_id, kind, valid_from, valid_to)
         VALUES (?1, ?2, 'uid', ?3, NULL)
         ON CONFLICT(alias, valid_from) DO NOTHING`,
    )
    .bind(uid, identityId, now)
    .run();

  return identityId;
}
