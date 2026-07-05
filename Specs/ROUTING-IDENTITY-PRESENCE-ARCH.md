# Server-Authoritative Messaging Architecture — Identity, Conversation, Routing, Delivery, Presence, Notification, Transport

**Status:** v4 — **ARCHITECTURALLY FROZEN** (canonical spec; no new services or
abstractions). Implementation and operational tuning continue; the architecture
itself does not change. This is **the canonical source of truth** for the nine v4
concepts — **Identity, Conversation, Routing, Delivery, Presence, Notification,
Transport, SessionDO, Event Bus** — which are named identically across all four
documents. The npub contact migration is a *compatibility layer*, not the fix. The
**Sync Engine (v5)** and the **PostHog telemetry mapping (v6)** are separate drafts
that evolve **independently** of this frozen v4 architecture.

**Related documents:**
- `V4-IMPLEMENTATION-GOVERNANCE.md` — living governance/cost artifact mapping this
  frozen spec to landed code (strangler mapping, five-question PR answers,
  flag/telemetry registries, cost-per-scale model).
- `EVENT-BUS-AND-TELEMETRY-CONTRACTS.md` — the bus-event wire contract + PostHog
  projection that feeds the **v6** telemetry draft.
- `CURRENT-SYNC-SYSTEM-REPORT-2026-07-05.md` — as-built (legacy) restore/sync
  report that feeds the **v5** Sync Engine draft.

## Frozen principles (keep front and centre)

1. **The client never decides where a message goes.** The client only references
   a conversation. The server owns participants, routing, presence, delivery, and
   transport.
2. **Only one component may own any piece of truth. Everyone else derives or
   caches it.** No duplicated truth.

Ownership map (the second principle, made concrete):

| Truth | Sole owner |
|------|-----------|
| Identity (who) | Identity |
| Participants | Conversation |
| Current user mapping (identity → uid) | Routing |
| Reachability | Presence |
| Message lifecycle | Delivery |
| Byte movement / geography / sharding | Transport |
| Waking devices | Notification |
| Cross-device catch-up | Sync (v5) |

**v4 changes from v3:** added the single-ownership principle; **removed `region`
from Routing** (Transport owns geography/sharding); **Conversation never knows
uid/Clerk**; **Notification now subscribes to Delivery events** (reverse
ownership) via an internal **Event Bus**; **InboxDO → SessionDO**; **Sync Engine**
promoted to a first-class subsystem (spec deferred to v5); added a cost section.

---

## 1. Problem statement

A DM's physical destination is chosen by the **sender's local storage**
(`to = savedContact.uid → appendTo(INBOX.idFromName(to))`). Stale / old-npub /
merged / restored ids land the message in an inbox **nobody reads** — sender sees
"sent", recipient gets nothing, no error (incident §12). The disease is
**client-authoritative routing**; npub-vs-uid was only the trigger.

## 2. Mental model: routing is DNS

The client knows a **conversation**, never a uid, inbox, socket, region, or push
token. Identity, device, region and infrastructure change underneath; the client
never notices.

## 3. Build on what already works

Group sends are already server-authoritative (recipients from
`conversation_members`). DMs are the only path trusting a client `to`. This design
makes **DMs follow the proven group model** under a canonical Identity + layered
Delivery.

## 4. The layered pipeline

```
Client ──(conversation_id, message, client_msg_id, attachments)──▶
  Conversation ─▶ Routing ─▶ Delivery ─▶ Presence ─▶ Transport ─▶ SessionDO
                     │
                     └─ Event Bus ─▶ Notification / Sync / Analytics / AI / Moderation / Search
```

| Layer | Answers | Must NOT know |
|------|---------|---------------|
| **Identity** | Who is this user? | sockets, inboxes, regions |
| **Conversation** | Who is in this thread? | uid, Clerk, routing, transport |
| **Routing** | Who currently represents this identity? (identity → uid + capabilities) | *region, inbox, transport* |
| **Delivery** | How do we process & guarantee this message? | wire protocol, push channels |
| **Presence** | Is a device reachable, and how? | message contents |
| **Transport** | How do we physically move bytes? (region, DO, queue, shard) | who/why |
| **Notification** | Which channel wakes an unreachable device? | delivery ordering |
| **Sync (v5)** | What has a device missed? | — |

## 5. Services

### 5.1 Identity — "who is this user?"
Owns `identity_id`, name, phone, email(hash), verification, status. Never knows
sockets/inboxes/regions.

```sql
CREATE TABLE identities (
  identity_id  TEXT PRIMARY KEY,   -- durable opaque id (idn_<ulid>), never reused
  display_name TEXT, email_hash TEXT, phone TEXT,
  verification TEXT, status TEXT NOT NULL DEFAULT 'active', merged_into TEXT,
  version      INTEGER NOT NULL DEFAULT 1,       -- identity_version
  updated_at   INTEGER NOT NULL
);
-- Immutable, append-only aliases (never edited) → historical routing is explainable
CREATE TABLE identity_aliases (
  alias TEXT NOT NULL, identity_id TEXT NOT NULL, kind TEXT NOT NULL,  -- npub|uid|tel|number
  valid_from INTEGER NOT NULL, valid_to INTEGER,                        -- NULL = current
  PRIMARY KEY (alias, valid_from)
);
```

### 5.2 Conversation — "who is in this thread?"
Owns conversation, participants, permissions, mute, archive, delete, typing. **No
routing. Never knows uid or that Clerk exists** — participants are `identity_id`
only. **Conversation ids are random** (`conv_<ulid>`) — never `dm(uidA,uidB)`,
never `hash(id+id)`; random ids survive merge, DM→group promotion, AI/bot/business
joins, archive, and import.

```sql
CREATE TABLE conversations (
  conv_id  TEXT PRIMARY KEY,      -- RANDOM; encodes nothing
  kind     TEXT NOT NULL,         -- dm|group|agent
  version  INTEGER NOT NULL DEFAULT 1,   -- conversation_version
  next_seq INTEGER NOT NULL DEFAULT 1,   -- server_sequence allocator (§8)
  created_at INTEGER NOT NULL
);
CREATE TABLE conversation_participants (
  conv_id TEXT NOT NULL, identity_id TEXT NOT NULL,   -- user OR AI agent; resolved once at add-time
  role TEXT NOT NULL DEFAULT 'member', muted INTEGER DEFAULT 0, archived INTEGER DEFAULT 0,
  joined_at INTEGER NOT NULL, PRIMARY KEY (conv_id, identity_id)
);
```

### 5.3 Routing — "who currently represents this identity?"
**Tiny.** Resolves `identity_id → current_uid + capabilities + generation`. It
does **not** know region, inbox, or transport — Transport owns geography and
sharding, so introducing Singapore/Mumbai/Tokyo/Frankfurt later never touches
Routing.

```sql
CREATE TABLE routes (
  identity_id     TEXT PRIMARY KEY,
  current_uid     TEXT NOT NULL,
  generation      INTEGER NOT NULL DEFAULT 1,    -- bumped on any re-key
  capabilities    TEXT,                          -- json: {video, sfu, receipts, ...}
  routing_version INTEGER NOT NULL DEFAULT 1,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_routes_uid ON routes(current_uid);
```

```ts
type Route = { identityId: string; uid: string; generation: number;
               routingVersion: number; capabilities: Caps };
// KV hot path route:<identity_id> (TTL 5min, §9). Unknown/disabled → null → fail loud (§10).
async function resolveRoute(env: Env, identityId: string): Promise<Route|null>;
```

### 5.4 Delivery — "how do we process & guarantee this?"
Owns queue, retry, **ordering (server_sequence)**, fanout, attachments, priority,
ack handling, backpressure, **dedupe/idempotency**, metrics, and the receipt
pipeline. Delivery **does not call push** — it emits events; Notification
subscribes (§7).

### 5.5 Presence — "is a device reachable, and how?"
Owns per-**device** reachability. **Disposable cache, never DB truth** — if lost,
it rebuilds from reconnects/heartbeats. A **state machine**, not booleans:

```
Unknown → Disconnected → Connecting → Connected
Connected × { Foreground, Background, Sleeping }
Reachability: PushOnly | CallOnly | MessageOnly     Policy: Busy | DoNotDisturb | Away
```

Multi-device: one identity → many devices; Delivery/Transport choose which
device(s) to deliver to / ring.

### 5.6 Notification — "which channel wakes an unreachable device?"
Owns APNS/FCM/Email/SMS/WebPush, token health, provider fallback. **Subscribes to
Delivery events** — e.g. `MessagePersisted` with no `DeviceACK` within X seconds →
wake the device. Completely replaceable without touching Delivery.

### 5.7 Transport — "how do we physically move the bytes?"
Owns the message substrate **and geography/sharding**: maps `(uid, capabilities)`
→ region → concrete **SessionDO** (or a Queue / stream / other DO tomorrow). The
one layer that changes when the substrate or datacentre map changes.

### 5.8 SessionDO (was InboxDO)
The per-connection Durable Object grows well beyond "inbox": it owns the
websocket, durable message log + cursor, typing, reactions, read receipts,
presence heartbeat, ephemeral state, upload progress, call signalling, and live
cursor. Naming it **SessionDO / ConnectionDO** (not InboxDO) keeps it future-proof.

## 6. The send contract (the security win)

Client sends **only** `{ conversation_id, message, client_msg_id, attachments }`.
Server: Conversation authorizes sender ∈ participants → Delivery dedupes on
`(conv_id, sender, client_msg_id)` and assigns `server_sequence` → for each other
participant, Routing → Presence → Transport → SessionDO; Delivery emits events;
Notification wakes unreachable devices. A client can never message a
non-participant. **1:1, group, AI agent, voice, video, and push are one
operation.** An **AI agent is just another participant** (`kind='agent'`).

**First contact:** `"start conversation with identity X"` → server **resolves X
server-side** (email/number/handle → identity_id) → creates a random conv, stores
identity participants, returns `conversation_id`.

> ⚠️ X must be resolved **server-side to an identity_id** — the exact spot the
> stale-npub bug lived. A client never passes a cached uid/npub as a participant.

## 7. Internal Event Bus (the backbone)

Everything emits **immutable events**; consumers **subscribe** rather than
call each other. This is how the system stays sane at scale.

```
MessagePersisted → MessageReplicated → SocketDelivered → NotificationSent
ReadReceipt · ReactionAdded · MessageDeleted · ConversationArchived · ParticipantAdded
```

Subscribers (never on the send hot path): Notification, **Sync (v5)**, Analytics/
PostHog (v6), AI, Moderation, Search, badge/unread counters. No subsystem calls
another; they all derive from the event stream.

## 8. Ordering, idempotency, receipts

- **server_sequence**: monotonic per conversation (`conversations.next_seq`,
  allocated atomically — the conversation's SessionDO is the natural serialization
  point). Clients render by sequence; **never trust client timestamps**.
- **Idempotency**: unique `(conv_id, sender_identity, client_msg_id)`; a duplicate
  returns the **original** — no duplicate rows ever.
- **Server-generated receipts** (each stage timestamped; `Persisted` ≠
  `Replicated` — never "delivered" before durable replication):

  ```
  Queued → Resolved → Persisted → Replicated → Socket Delivered → Device ACK → Rendered → Read
  ```

## 9. Versioning + TTL (migration-proof)

Every server log carries **five version stamps** — identity, conversation,
routing, presence, policy — so history replays exactly. Migration/failover/
regional move = a generation/version bump; the client never notices. Route cache
**TTL = 5 min** bounds failover lag; **correctness never depends on the TTL**
(server resolves authoritatively per send; client caches no routing).

## 10. Fail loud, never silent

`resolveRoute → null` → `409 unroutable_recipient` + `msg_route_unresolved`
telemetry; client re-establishes the conversation, never silently retries into a
dead inbox. (The interim npub **guard** is this miss path narrowed to one dead
alias family.)

## 11. Sync Engine — first-class subsystem (spec → v5)

Offline catch-up must not be ad-hoc "give me unread / give me yesterday". Every
device synchronizes by **`conversation_id + last_server_sequence`**:

```
device: "give me everything in conv_X after server_sequence 918271"
```

Sync is an Event Bus subscriber, not on the send hot path. **Full design in the
v5 draft** — this section is the placeholder + the contract (`server_sequence` is
the cursor, assigned in §8).

## 12. Incident evidence & key constraint

PostHog `proj 139917`: Sat's sends succeeded (`msg_outbox_sent`+`msg_echo_received`
07-05 05:44); recipient online; every `sync_catchup` since 07-04 15:19 →
`messages=0` incl. a fresh login; recipient reads under Clerk uid
(`sync_hub.dart:114`, `authz.ts:25`) while a sender holds the peer's stale npub.
**Constraint:** the npub→uid rename discarded old values (`cfnative_c.sql` et al.)
— **no old_npub→uid mapping survives**, so `identity_aliases` must be backfilled
(P0) and stale contacts heal meanwhile via server-side email/number re-resolution.

## 13. Roadmap

| Phase | Deliverable |
|------|-------------|
| **P0** | Canonical **Identity** table + **immutable aliases** + backfill *(prerequisite)* |
| **P1** | **Conversation**-owned participants; **random conv ids**; identity-only (no uid); DMs match groups |
| **P2** | **Routing Service** (identity → uid + capabilities, *no region/inbox*) + `409` miss path |
| **P3** | **Delivery** + **Transport/SessionDO** — server_sequence, idempotency, ordering, fanout, receipts; **Event Bus** |
| **P4** | **Presence** (disposable state machine, multi-device) + **Notification** (subscribes to Delivery events) |
| **P5** | **Sync Engine** (conversation_id + last_server_sequence) — *v5 draft* |
| **P6** | **Remove all client-side routing** — client sends `conversation_id + message + client_msg_id` only |
| **Compat** | Client heal-by-email/number + server npub guard, alongside P0–P2 |

## 14. Cost (Cloudflare-friendly)

More *services* are logical boundaries, not necessarily more infrastructure. The
hot path per message stays: 1 Conversation lookup (often DO-cached) + 1 Routing
lookup (KV-cached) + 1 Presence lookup (memory/DO) + 1 Transport durable write —
exactly the many-small-low-latency pattern DOs/KV/Workers are built for. Dominant
ongoing costs are attachment storage/bandwidth, push providers, AI, and analytics
volume — **not** the routing layer. At millions of users this design likely *saves*
money by eliminating retries, misroutes, duplicate sends, and operational
complexity.

## 15. Status & remaining work

v4 is at **"freeze the architecture and build it"**. No more services or
abstractions should be added; remaining work is implementation, operational
tuning, and proving the design under load. Open decisions (pre-P0): opaque
`identity_id` vs. canonicalize-on-uid; `server_sequence` allocation mechanics
under concurrent fanout.

---

*Redesign precedes any migration merge. Recovery: interim heal/guard/telemetry
diffs in `/tmp/routing-heal-guard.patch` and reflog (`e02e280`, `6e71aab`).*
