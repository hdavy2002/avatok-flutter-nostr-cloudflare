/**
 * Sharding router. Today every logical store maps to a single D1 database.
 * The relay is intentionally single (see migrations/relay.sql). When a database
 * needs to fan out, change ONLY the accessor here and add bindings in
 * wrangler.toml — call sites never change.
 *
 * To shard the relay later (Rulebook target: DB_RELAY_0..15):
 *   1. Add DB_RELAY_0..15 bindings to wrangler.toml + Env.
 *   2. Decide the axis (time-bucket recommended over author npub%16, because
 *      gift-wrap authors are random and feeds span many authors).
 *   3. Implement relayDbFor() to return the right shard; backfill is a no-op
 *      pre-launch.
 *
 * RELAY SHARD TRIGGER (P2-12): D1's practical ceiling is ~10 GB/database. Check
 * size with `SELECT page_count*page_size FROM pragma_page_count(), pragma_page_size()`.
 * When `nostr_events` passes ~5 GB, switch relayDbFor() to TIME-based sharding:
 * events before a cutoff date → a new `DB_RELAY_ARCHIVE` binding, events at/after
 * → DB_RELAY. Add DB_RELAY_ARCHIVE to relay/wrangler.toml + Env at that point.
 * This is a config change, not a rewrite — call sites already go through here.
 *
 * READ-YOUR-WRITES (P2-9): metaSession/etc use withSession("first-unconstrained"),
 * which guarantees read-after-write consistency WITHIN one request (the session
 * bookmark tracks that request's writes). ACROSS requests, a read immediately
 * after a write in a *previous* request may briefly hit a lagged replica (seconds).
 * Fine for ~99% of flows. The two flows that could surprise a user — register and
 * profile-set — already return the created/updated object in the same response, so
 * the client never needs to re-read. If a future flow needs cross-request
 * read-your-writes, thread the D1 bookmark (session.getBookmark()) back to the client.
 */
import type { Env } from "../types";

export function relayDb(env: Env): D1Database {
  return env.DB_RELAY;
}

/** Reserved for future relay sharding. Currently axis-independent. */
export function relayDbFor(env: Env, _authorPubkey?: string, _createdAt?: number): D1Database {
  return env.DB_RELAY;
}

export function metaDb(env: Env): D1Database {
  return env.DB_META;
}

export function mediaDb(env: Env): D1Database {
  return env.DB_MEDIA;
}

export function moderationDb(env: Env): D1Database {
  return env.DB_MODERATION;
}

/**
 * D1 Sessions API — global read replication. Read replication is enabled
 * (read_replication = auto) on all four databases, but plain `env.DB.prepare()`
 * always hits the PRIMARY region (APAC). A session routes reads to the nearest
 * replica while guaranteeing read-your-writes WITHIN the session (the bookmark
 * advances on every write, so a read after a write in the same session is never
 * stale). Create ONE session per database per request and reuse it.
 *
 * "first-unconstrained" = the first query may run on any replica (lowest latency).
 */
export function metaSession(env: Env): D1DatabaseSession {
  return env.DB_META.withSession("first-unconstrained");
}
export function mediaSession(env: Env): D1DatabaseSession {
  return env.DB_MEDIA.withSession("first-unconstrained");
}
export function moderationSession(env: Env): D1DatabaseSession {
  return env.DB_MODERATION.withSession("first-unconstrained");
}
export function relaySession(env: Env): D1DatabaseSession {
  return env.DB_RELAY.withSession("first-unconstrained");
}

/**
 * sha256 hex — used for phone_hash / email_hash discovery so raw PII is never
 * stored (Privacy Non-Negotiable §9 / DPDP). Normalize inputs BEFORE hashing:
 * phone → E.164, email → trim+lowercase.
 */
export async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
