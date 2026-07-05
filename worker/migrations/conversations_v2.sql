-- P1 Conversation service — identity-keyed successor to the uid-keyed
-- `conversations` / `conversation_members` tables (Specs/ROUTING-IDENTITY-PRESENCE-ARCH.md §5.2).
-- Built ALONGSIDE the legacy tables (routes/messaging.ts), never replacing them in place.
--
-- Two frozen principles from the design:
--   1. Conversation ids are RANDOM (`conv_<ulid>`). They encode NOTHING — never
--      dm(uidA,uidB), never hash(id+id). A random id survives identity merge,
--      DM→group promotion, AI/bot/business joins, archive, and import.
--   2. Participants are stored as `identity_id` ONLY. Conversation MUST NOT know
--      the Clerk uid or that Clerk exists — the caller's uid is resolved to a
--      durable identity_id server-side (routing.ts) before it lands here.

-- Conversation header. `next_seq` is the per-conversation server_sequence
-- allocator (§8): monotonic, assigned atomically per send. The authoritative
-- allocator will move into the conversation's SessionDO (§8) — this D1 column is
-- the interim serialization point.
CREATE TABLE IF NOT EXISTS conversations (
  conv_id    TEXT PRIMARY KEY,               -- RANDOM (conv_<ulid>); encodes nothing
  kind       TEXT NOT NULL,                  -- dm | group | agent
  version    INTEGER NOT NULL DEFAULT 1,     -- conversation_version (§9 replay stamp)
  next_seq   INTEGER NOT NULL DEFAULT 1,     -- server_sequence allocator (§8)
  created_at INTEGER NOT NULL
);

-- Participants — `identity_id` ONLY (a human OR an AI agent; resolved once at
-- add-time). No uid column BY DESIGN: the stale-cached-uid bug (§1, §6) cannot
-- exist here because the client never names a participant by uid/npub.
CREATE TABLE IF NOT EXISTS conversation_participants (
  conv_id     TEXT NOT NULL,
  identity_id TEXT NOT NULL,                 -- durable opaque id (idn_<ulid>), never a uid
  role        TEXT NOT NULL DEFAULT 'member',
  muted       INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0,
  joined_at   INTEGER NOT NULL,
  PRIMARY KEY (conv_id, identity_id)
);

-- "List my conversations" walks participants by the caller's identity_id.
CREATE INDEX IF NOT EXISTS idx_cp_identity ON conversation_participants(identity_id);
