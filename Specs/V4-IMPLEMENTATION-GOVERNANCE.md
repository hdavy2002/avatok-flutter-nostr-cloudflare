# V4 Messaging Architecture — Implementation Governance & Cost Artifact

**Status:** LIVING governance document for the **FROZEN v4** server-authoritative
messaging build. Updated as increments land. This is the mandatory implementation
artifact required by the owner's engineering rules: every component in the build
must carry a **strangler mapping**, its **five-question PR answers**, a
**cost-per-scale estimate**, and an entry in the **telemetry registry** before it
is enabled.

**Canonical sources (read-only; this doc references, never restates):**
- `Specs/ROUTING-IDENTITY-PRESENCE-ARCH.md` — v4 frozen architecture (7+ layers,
  ownership boundaries, send contract, ordering/idempotency/receipts, cost §14).
- `Specs/EVENT-BUS-AND-TELEMETRY-CONTRACTS.md` — bus event + PostHog contract (feeds v6).
- `Specs/CURRENT-SYNC-SYSTEM-REPORT-2026-07-05.md` — as-built restore/sync (feeds v5).

**Code this doc maps (as landed):** `worker/src/lib/routing.ts`,
`worker/src/lib/delivery.ts`, `worker/src/lib/transport.ts`,
`worker/src/lib/event_bus.ts`, `worker/src/routes/conversations2.ts`,
`worker/migrations/identity_routing.sql`, `worker/migrations/conversations_v2.sql`,
`worker/src/index.ts` (`/api/v2/*` wiring, L308–320), `worker/src/routes/config.ts`
(`routingV2Enabled`, L173–179 / default L255). Existing production it wraps:
`worker/src/routes/messaging.ts` (`sendMsg` L242, `ensureDm` L104, `appendTo` L128,
`convList` L982, `convCreate` L999, `convAdopt` L1043), `worker/src/routes/api.ts`
(`resolve` L567), `worker/src/do/inbox.ts` (`/append`, `/sync?cursor=N`).

---

## 1. Purpose & the governance rules being satisfied

The v4 architecture is **frozen** ("freeze the architecture and build it",
ROUTING §15): no new services or abstractions are added — remaining work is
implementation, operational tuning, and load-proving. This document is the
control that keeps the build honest against six rules:

| # | Governance rule | How it is enforced here |
|---|-----------------|-------------------------|
| G1 | **Frozen architecture** — no new layers/abstractions | §2 invariant matrix pins each layer to exactly what it owns and what it must NOT absorb; deviations are visible as a matrix edit. |
| G2 | **Additive, never destructive** | §3 strangler mapping + §4 five-question answers require every increment to declare "additive or destructive"; all four landed increments are additive (new files, new tables, new `/api/v2/*` routes). |
| G3 | **Feature-flagged** | §5 flag registry. The entire v4 path is dark behind `routingV2Enabled` (default OFF → `/api/v2/*` returns 404). |
| G4 | **Strangler (wrap, don't rip out)** | §3 maps each new service to the production component it wraps/generalizes/replaces; legacy path runs untouched until a cohort is strangled over. |
| G5 | **Telemetry-before-enable** | §6 telemetry registry. Rule: *no layer is switched on until its telemetry is emitting.* `conv2_created` / `conv2_listed` and the `bus_event` mirror already ship while the path is dark. |
| G6 | **Cost-per-scale** | §7 cost model: per-operation Cloudflare drivers, per-message hot-path total, and $ projections at 100k / 1M / 10M / 100M users. |

---

## 2. Invariant ownership matrix

One row per layer. "Owns ONLY" is the single piece of truth that layer is the sole
owner of (ROUTING §5, the "only one component owns any truth" principle). "Must NOT
absorb" is the boundary that keeps the layer replaceable. Status:
**scaffolded** = code file exists, lazy-DDL/skeleton in place; **wired-dormant** =
routed in `index.ts` but gated OFF by `routingV2Enabled`; **not-started** = spec
only, no code.

| Layer | Owns ONLY | Must NOT absorb | Current status |
|-------|-----------|-----------------|----------------|
| **Identity** (`lib/routing.ts` `identities`/`identity_aliases`) | `identity_id`, name, phone, email(hash), verification, status, `merged_into`, immutable aliases | sockets, inboxes, regions, uid-as-primary-key | scaffolded (tables + `ensureIdentityForUid`, `identityIdFor`, `activeIdentity`) |
| **Conversation** (`routes/conversations2.ts`) | participants (identity_id only), kind, permissions, mute, archive, `next_seq` allocator | uid, Clerk, routing, transport, region | wired-dormant (`/api/v2/conversations`, gated) |
| **Routing** (`lib/routing.ts` `routes`) | identity_id → `current_uid` + `generation` + `capabilities` + `routing_version` | **region, inbox, transport** (Transport owns geography) | scaffolded (`resolveRoute`, `invalidateRoute`) |
| **Delivery** (`lib/delivery.ts`) | queue, ordering (`server_sequence`), dedupe/idempotency, fanout, receipt pipeline, backpressure | wire protocol, push channels (emits events, never calls push) | scaffolded (`deliver`, `message_dedup` ledger) — not yet on any live route |
| **Presence** | per-**device** reachability state machine (disposable cache) | message contents; being a DB source of truth | not-started (v4 §5.5) |
| **Notification** | APNS/FCM/Email/SMS, token health, provider fallback | delivery ordering; being called on the send path (it *subscribes*) | not-started (subscriber of Delivery events, v4 §5.6/§7) |
| **Transport** (`lib/transport.ts`) | the byte substrate + **geography/sharding**: (uid, caps) → concrete SessionDO/Queue | who/why (identity, conversation semantics) | scaffolded (`Transport` iface + `InboxTransport` over existing `INBOX` DO) |
| **State / Sync** (v5) | cross-device catch-up by `conversation_id + last_server_sequence` | the send hot path (it is a bus subscriber) | not-started (v5 draft; today served ad-hoc by `inbox.ts` global cursor) |
| **Projection** (Event Bus consumers: Analytics/Search/AI/Moderation/badge) | derived read-models off the immutable event stream | writing back to owners; calling the emitter or each other | scaffolded (`lib/event_bus.ts` contract + Q_ANALYTICS mirror; real pub/sub is a P4 TODO) |

---

## 3. Strangler mapping

Each new service is introduced **beside** the production component that does the
job today, then that component's traffic is strangled over per-cohort by flipping
`routingV2Enabled`. Nothing is deleted until a layer is fully drained.

| New service (file) | Existing production component (does this today) | Strategy | Notes |
|--------------------|--------------------------------------------------|----------|-------|
| **Routing** `resolveRoute` (`lib/routing.ts`) | `api.ts` `resolve()` (L567): `q` → uid via `users` email_hash / avatok_number / number lookup | **wrap + extend** | `resolveRoute` accepts ANY id (identity_id \| uid \| legacy npub \| tel \| number), consults `identity_aliases` FIRST (the mapping `resolve()` lacks), follows `merged_into`, and returns an **identity_id + generation**, not a bare uid. `resolve()` remains the legacy uid-directory; Routing is the identity-aware layer over it. `conversations2.resolveParticipant` is told (TODO comment) to route ALL id kinds through `resolveRoute` so there is one resolution source of truth. |
| **Conversation** `createConversation`/`listConversations` (`conversations2.ts`) | `messaging.ts` `convCreate` (L999), `convList` (L982), `ensureDm` (L104) | **replace (successor)** | Identity-keyed successor. `conv_id` is RANDOM (`conv_<ulid>`), participants are `identity_id` only — no uid column exists, so the stale-cached-uid misroute (ROUTING §1) is structurally impossible. DM creation is idempotent by exact participant-set match. |
| **Conversation** `listConversations` | `messaging.ts` `convAdopt` (L1043) + `/api/conversations/adopt` | **replace + REMOVE** | Because Conversation owns participants keyed by identity, a new device lists its threads by its own `identity_id` automatically. This **removes the need for `/api/conversations/adopt`** — the client no longer "adopts" locally-known threads (as-built gap #5, CURRENT-SYNC §6). |
| **Delivery** `deliver` (`lib/delivery.ts`) | `messaging.ts` `sendMsg` (L242) — trusts client `to`, allocates id, fans out via `appendTo` per member | **generalize** | `deliver` takes **identity recipients**, resolves each via Routing, assigns `server_sequence` (via `allocateSequence`), enforces idempotency on `(conv_id, sender_identity, client_msg_id)` in a `message_dedup` ledger, fans out via Transport, and **emits** events (never calls push). `sendMsg`'s client-authoritative `to` is exactly the disease v4 cures. |
| **Transport** `transportFor`/`InboxTransport` (`lib/transport.ts`) | `messaging.ts` `appendTo` (L128) → `inbox.ts` `/append`; `do/inbox.ts` InboxDO (`idFromName(uid)`) | **wrap (adapter)** | `InboxTransport.write` POSTs the same `/append` wire the router uses today, so the DO's idempotency + broadcast are unchanged. This is the ONLY spot that names `env.INBOX`. When InboxDO → SessionDO (v4 §5.8) or a Queue substrate lands, only this file changes; Routing/Delivery are untouched. |
| **Event Bus** `emit` (`lib/event_bus.ts`) | (none — no prior owner; Notification is called inline today) | **net-new** | Decoupling backbone. Today a best-effort `bus_event` mirror to `Q_ANALYTICS`; the real pub/sub (Queue topic / fan-out DO) attaches at the P4 TODO. Inverts Notification's ownership: it becomes a subscriber, not a callee. |
| **Identity** `identities` / `identity_aliases` (`identity_routing.sql`) | (none — net-new) | **net-new** | No prior owner. `identity_aliases` is the backfill target for the discarded old-npub→uid mapping (ROUTING §12); it is append-only so historical routing stays explainable. |
| **`routes` table** | (none — net-new; uid was implicit in Clerk/InboxDO keying) | **net-new** | Tiny identity_id → current_uid map with `generation`. Deliberately NO region column. |

**Legacy path left fully intact while dormant:** `/api/conversations*`,
`/api/msg/send` (`sendMsg`), `ensureDm`, `appendTo`, InboxDO `/append`+`/sync`,
`api.ts` `resolve` all continue to serve 100% of production traffic. The v4 path
executes only when a request hits `/api/v2/*` AND `routingV2Enabled` is true.

---

## 4. Five-question PR answers

The mandated five questions for each landed increment:
**(1)** which frozen-arch section, **(2)** which existing component wrapped/replaced,
**(3)** additive or destructive, **(4)** rollback behind which flag,
**(5)** does it reduce tech debt.

### [ARCH-IDENTITY-1] — Identity + Routing data layer
`lib/routing.ts`, `migrations/identity_routing.sql`
1. **Frozen-arch section:** §5.1 (Identity), §5.3 (Routing), §9 (KV TTL), §10 (fail loud), §12 (backfill).
2. **Wrapped/replaced:** wraps `api.ts` `resolve()` (uid directory) with an identity-aware resolver that adds the `identity_aliases` mapping and `merged_into` following. `identities`/`routes` are net-new.
3. **Additive or destructive:** **Additive.** New tables (lazy-DDL + explicit migration), new module. No existing table altered; `resolve()` untouched.
4. **Rollback:** behind `routingV2Enabled` (nothing calls `resolveRoute` on a live path yet). Rollback = leave the flag OFF; the tables sit unused and harmless.
5. **Reduces tech debt:** **Yes.** Establishes the single missing mapping (old-npub→uid) whose absence caused the 2026-07-05 silent misroute (§12), and makes uid a mere alias so a future re-key never changes identity.

### [ARCH-CONV-1] — Conversation service (identity-keyed, random ids)
`routes/conversations2.ts`, `migrations/conversations_v2.sql`
1. **Frozen-arch section:** §5.2 (Conversation), §6 (first-contact server-side resolution), §8 (`next_seq` allocator).
2. **Wrapped/replaced:** successor to `messaging.ts` `convCreate`/`convList`/`ensureDm`; **removes the need for `convAdopt` / `/api/conversations/adopt`.**
3. **Additive or destructive:** **Additive.** New tables built alongside the legacy `conversations`/`conversation_members`, never replacing them in place.
4. **Rollback:** behind `routingV2Enabled` — `/api/v2/conversations*` returns 404 while OFF.
5. **Reduces tech debt:** **Yes.** Random `conv_id` + identity-only participants eliminate the `dm(uidA,uidB)` derived-id fragility and retire the `adopt` patch (as-built gap #5).

### [ARCH-DELIVERY-1] — Delivery + Transport + Event Bus skeleton
`lib/delivery.ts`, `lib/transport.ts`, `lib/event_bus.ts`
1. **Frozen-arch section:** §5.4 (Delivery), §5.7/§5.8 (Transport/SessionDO), §7 (Event Bus), §8 (ordering/idempotency/receipts), §10 (fail loud).
2. **Wrapped/replaced:** `deliver` generalizes `sendMsg`; `InboxTransport` wraps `appendTo`→InboxDO `/append`; `emit` is net-new (inverts Notification ownership).
3. **Additive or destructive:** **Additive.** New modules; not wired onto any live route yet (no `index.ts` binding calls `deliver`). One new `message_dedup` table (lazy-DDL).
4. **Rollback:** behind `routingV2Enabled` once wired; today simply un-referenced by any live handler. Rollback = do not wire / keep flag OFF.
5. **Reduces tech debt:** **Yes.** Replaces client-authoritative `to` with server-side identity fanout, adds real idempotency + server_sequence ordering, and decouples push (Notification subscribes) so a slow/failed subscriber can never back-pressure a send.

### [ARCH-ROUTING-V2] — Flag + `/api/v2/*` wiring
`index.ts` L308–320, `config.ts` L173–179 / L255
1. **Frozen-arch section:** §6 (send contract entrypoint), §15 (freeze-and-build); the kill-switch mechanism enabling G3/G4.
2. **Wrapped/replaced:** wraps nothing functionally — it is the **strangler seam** that lets the v4 path coexist with the legacy `/api/conversations` + `/api/msg/send` path.
3. **Additive or destructive:** **Additive.** A new flag (default `false`) and a new route prefix that answers 404 until flipped.
4. **Rollback:** the flag **is** the rollback — one KV `platform_config` edit flips the whole v4 path off with no redeploy. Reversible per-cohort.
5. **Reduces tech debt:** **Neutral-to-positive.** Adds no debt; it is the control surface that lets the debt-reducing layers ship dark and be validated by telemetry before carrying traffic.

---

## 5. Feature-flag registry

**KV-patch-required rule (critical):** a flag **absent from KV** `platform_config`
reads its **code default** — the reader does NOT fall back through code for a
partially-present object once KV is set. To ENABLE a flag you must `PUT`
`platform_config` in KV with the field present and true (this is the same lesson as
the 2026-07-04 liveness-flag KV fix and marketplace KV flag). Never assume flipping
a `config.ts` default alone changes production.

| Flag | Store | Default | Gates | Rollback |
|------|-------|---------|-------|----------|
| `routingV2Enabled` | KV `platform_config` (`config.ts` L179; default L255 `false`) | **OFF** | ALL `/api/v2/*` (Conversation now; Delivery/Routing/Transport once wired). OFF → `/api/v2/*` returns `{"error":"v2_disabled"}` 404; nothing in the v4 path runs. | Single KV edit → OFF; legacy path never touched. |
| `conferenceEnabled` (existing) | KV `platform_config` | per current KV | (unrelated — LiveKit conferences; listed to avoid confusion) | — |
| *`identityBackfillEnabled`* (PLACEHOLDER) | KV `platform_config` | OFF (planned) | P0 backfill job that populates `identity_aliases` from historical uid/npub. | flag OFF halts backfill. |
| *`deliveryV2Enabled`* (PLACEHOLDER) | KV `platform_config` | OFF (planned) | routes `sendMsg` traffic through `deliver()` per-cohort (sub-gate under `routingV2Enabled`). | flag OFF → legacy `sendMsg`. |
| *`presenceEnabled`* (PLACEHOLDER) | KV `platform_config` | OFF (planned) | Presence state machine + multi-device fan-out (v4 §5.5). | flag OFF. |
| *`eventBusLiveEnabled`* (PLACEHOLDER) | KV `platform_config` | OFF (planned) | switches `emit` from the Q_ANALYTICS mirror to the real Queue/DO pub-sub feeding Notification/Sync. | flag OFF → mirror-only. |

Per-layer flags let cohorts be strangled independently (Identity backfill can run
long before Delivery carries any traffic).

---

## 6. Telemetry registry

**Rule (G5): no layer is enabled until its telemetry is emitting.** Every v4 event
carries the base props `account_id`, `app_name:"avatok"`,
`service_name:"avatok-api"`, `worker:true`, and (per the trace convention) reuses
the client `client_id` as `trace_id` so a message's whole life is one PostHog query.

| Event | Emitter (file) | Fires when | Status | Notes |
|-------|----------------|-----------|--------|-------|
| `conv2_created` | `conversations2.ts` `createConversation` | a v2 conversation is created OR an idempotent DM is reused (`deduped` prop) | **LIVE** (fires only when `routingV2Enabled` ON — path is dormant) | props: `conv_id`, `kind`, `participants`, `deduped` |
| `conv2_listed` | `conversations2.ts` `listConversations` | a device lists its identity-keyed conversations | **LIVE** (dormant path) | prop: `count` |
| `bus_event` | `event_bus.ts` `emit` | any bus event is emitted (currently `MessagePersisted` from Delivery) | **LIVE** (contract mirror; fires when `deliver` runs) | props: `bus_type`, `conv`, `server_sequence`, `identity_id`, `uid`, `mid`, `stage` |
| `msg_routed` | Routing (planned, in `deliver` fanout) | per-recipient resolve SUCCESS before persist | **PLANNED** (v6) | `resolved_uid`, `routing_version`, `generation`, `result`, `latency_ms` — the resolve-observability win |
| `msg_route_unresolved` | Routing (planned; TODO at `delivery.ts` L154) | `resolveRoute → null` (§10 fail-loud) | **PLANNED** (v6) | `attempted_alias`, `reason` — the event whose ABSENCE was the 2026-07-05 bug |
| `msg_stage_*` (persisted/replicated/socket/ack/rendered/read) | Delivery / Transport / client | each §8 receipt stage | **PLANNED** (v6) | see EVENT-BUS-AND-TELEMETRY-CONTRACTS §3 |
| `to_kind` precursor prop | added to existing `msg_outbox_*`/`chat_message_sent` | every legacy send | **PLANNED** (cheapest early-warning; add first) | `uid`\|`npub`\|`other` — alert if `npub` non-zero |

Existing production telemetry (unchanged, coexists): `msg_outbox_*`,
`msg_echo_received`, `sync_catchup`, `chat_message_sent`, `chat_reaction`,
`forward_sent` (project 139917). v6 maps these forward without renaming.

---

## 7. Cost model

Cloudflare-native, DO/KV/Workers small-and-fast pattern (ROUTING §14). Unit prices
below are the Workers Paid published rates; where a rate is version-sensitive it is
labelled **ASSUMPTION** and computed symbolically so a price change re-derives easily.

**Published unit prices used (ASSUMPTION: current Workers Paid tier, USD):**
- D1: **$0.001 / 1M rows read**, **$1.00 / 1M rows written** (ASSUMPTION).
- KV: **$0.50 / 1M reads**, **$5.00 / 1M writes** (ASSUMPTION).
- Durable Objects: **$0.15 / 1M requests** + **$12.50 / 1M GB-s** duration (ASSUMPTION; DO request pricing is the most sensitive input — see §8).
- Workers requests: **$0.30 / 1M**; CPU: **$0.02 / 1M ms** (ASSUMPTION).
- R2: **$0.015 / GB-mo** stored, **$4.50 / 1M Class-A**, **$0.36 / 1M Class-B**, **egress $0** (R2 has no egress fee).
- Queues: **$0.40 / 1M operations** (ASSUMPTION).

### 7.1 Per-operation cost drivers (per subsystem)

| Subsystem | D1 reads | D1 writes | KV reads | KV writes | DO reqs | R2 | CPU-ms | Egress |
|-----------|---------|-----------|----------|-----------|---------|-----|--------|--------|
| **Routing** (`resolveRoute`) | 0 on KV hit; **1–3** on miss (alias → identity → route) | 0 | **1** (`route:<id>`, TTL 5min) | ~0 (1 write per cache miss only) | 0 | 0 | ~0.1 | 0 |
| **Conversation** (`createConversation`) | 1–N (DM idempotency set-match) | 1 conv + N participant rows | 0 | 0 | 0 | 0 | ~0.5 | 0 |
| **Conversation** (`listConversations`) | 1 + N (per-conv participant fetch) | 0 | 0 | 0 | 0 | 0 | ~0.3 | small |
| **Delivery** (`deliver`, per msg) | 1 (dedup check) | **1** (dedup claim) + **1** (`next_seq` UPDATE…RETURNING) | via Routing (1/recipient) | 0 | 0 (delegates) | 0 | ~0.3 | 0 |
| **Transport** (`InboxTransport.write`, per recipient) | 0 | 0 (DO owns its SQLite) | 0 | 0 | **1** DO request → `/append` (+ DO SQLite write, DO-internal) | 0 | ~0.2 | 0 |
| **Presence** (planned) | 0 | 0 | 0/1 | 0/1 | in-DO memory/heartbeat | 0 | ~0.1 | 0 |
| **Notification** (planned, only when unreachable) | 0 | 0 | 0 | 0 | 0 | 0 (external provider call) | ~0.3 | provider $ |
| **Sync/State** (`/sync` cursor replay) | 0 | 0 | 0 | 0 | **1** DO request/page (500 msgs/page) | 0 | ~0.2 | msg egress = $0 (R2 free; Workers response egress $0) |

### 7.2 Per-message hot-path total (1:1 DM, KV route cache HIT)

The send hot path (ROUTING §14: 1 Conversation lookup + 1 Routing lookup +
1 Presence lookup + 1 durable write) costs, per delivered 1:1 message:

| Driver | Count | Rationale |
|--------|-------|-----------|
| KV read | **1** | `route:<recipient>` cache hit (the dominant assumption; see §8 hit-rate) |
| D1 write | **2** | `message_dedup` claim + `next_seq` allocate (INTERIM D1; moves into SessionDO later, §8) |
| D1 read | **1** | dedup pre-check |
| DO request | **1** | one durable `/append` to the recipient's SessionDO |
| Workers req + CPU | 1 req, ~1 ms | the send invocation |

**Symbolic per-message cost** (KV hit, 1 recipient):
`C_msg ≈ 1·KVr + 2·D1w + 1·D1r + 1·DOreq + 1·Wreq + 1·CPUms`.
Plugging the assumed prices:
`≈ (0.50 + 2·1000 + 0.001 + 0.15 + 0.30 + 0.02) / 1e6 USD`
`≈ $2.0007e-3 / 1e3 …` — i.e. **≈ $2.0 per million messages**, of which the **two D1
writes dominate (~$2.0/M)** and everything else (KV read, DO request, Worker, CPU)
sums to **< $1.0/M**. **Conclusion: the routing/ordering hot path is ≈ $2 per
million messages (~$0.000002/message), driven almost entirely by the two interim
D1 writes; the KV-cached route + single DO write are together under $1/M.** Moving
the `next_seq` allocator and dedup ledger into the SessionDO (§8, planned) removes
both D1 writes from the hot path and collapses the marginal cost toward the single
DO request (~$0.15/M + DO duration).

### 7.3 Monthly volume + $ projection by scale

**ASSUMPTIONS:** 20 messages/user/day (send events); ~50% are 1:1, rest group
(avg 4 recipients) — model as **1.5 durable writes/message** average; **KV route
cache hit-rate 95%** (a miss adds ~2 D1 reads + 1 KV write, TTL 5min); DAU = 60% of
users. Monthly messages ≈ users · 0.6 · 20 · 30.

| Users | Monthly send events | Monthly durable writes (×1.5) | Routing D1/KV cost | Delivery D1-write cost | DO request cost | **Hot-path total /mo (ASSUMPTION)** |
|-------|--------------------|-------------------------------|--------------------|------------------------|-----------------|--------------------------------------|
| 100k | ~36M | ~54M | < $1 | ~$108 (2 D1w · 54M) | ~$8 | **~$120 /mo** |
| 1M | ~360M | ~540M | ~$5 | ~$1,080 | ~$81 | **~$1.2k /mo** |
| 10M | ~3.6B | ~5.4B | ~$50 | ~$10,800 | ~$810 | **~$12k /mo** |
| 100M | ~36B | ~54B | ~$500 | ~$108,000 | ~$8,100 | **~$120k /mo** |

These are **routing/ordering/transport hot-path** figures only. The two interim D1
writes are ~90% of it; the SessionDO migration (§8) is the single biggest cost
lever, projected to cut the hot path by roughly an order of magnitude at every scale.

### 7.4 Where the real money is (NOT routing)

Per ROUTING §14, the dominant ongoing costs are **outside** the routing layer and
scale with product usage, not with the number of services:

- **Attachments / R2:** storage ($0.015/GB-mo) + Class-A writes; R2 egress is $0, which is a large win vs. S3-class egress. Media dominates storage $.
- **Push providers:** APNS/FCM are free, but **SMS/email fallback** carry real per-message provider fees (Notification only fires for *unreachable* devices, bounding this).
- **AI:** receptionist / Ava / transcription / translation are per-token/per-second external spend — orders of magnitude above routing.
- **Analytics volume:** at 100M users, emitting all eight receipt stages = 8× send volume into `Q_ANALYTICS`. This is a genuine cost line (Queue ops + PostHog ingestion) and is why §8 sampling matters.

**Design cost wins (why v4 is cheaper at scale, not just cleaner):**
- **KV-cached routes ⇒ ~1 KV read on the hot path** (95%+ hit), not a D1 lookup per send.
- **One durable write per recipient**, no client-caused retries into dead inboxes.
- **No misroutes / duplicate sends:** idempotency ledger guarantees exactly-once; the eliminated retries/misroutes/support-load are a real saving (ROUTING §14: "at millions of users this design likely *saves* money").
- **Push decoupled:** Notification subscribes to events, so a provider outage never re-drives the send path.

---

## 8. Open cost / telemetry questions

1. **Analytics sampling at 100M.** Eight receipt stages per message = 8× send
   volume into `Q_ANALYTICS`. Which stages are always-on (proposal:
   `msg_routed`, `msg_route_unresolved`, `msg_stage_replicated` — correctness-critical)
   vs. sampled at 1–5% (`msg_stage_socket_delivered`, `msg_stage_rendered`)?
   Sampling MUST be `trace_id`-consistent so funnels stay coherent
   (EVENT-BUS §6 Q2). The §7.4 analytics line is unbounded until this is settled.
2. **Route cache hit-rate assumption.** §7.3 assumes **95%**. Real hit-rate depends
   on the 5-min TTL vs. conversation locality; a 70% hit-rate roughly doubles the
   Routing D1/KV line (still small in absolute terms, but worth measuring via
   `msg_routed.latency_ms` distribution before enabling Delivery).
3. **DO request pricing sensitivity.** DO requests + duration are the input most
   likely to move the SessionDO-migrated cost curve. The whole §7.2 conclusion
   ("collapse toward the single DO request") assumes DO request pricing stays near
   the assumed **$0.15/M**; a materially different rate re-orders the levers.
   Validate against a real Cloudflare bill before committing to the SessionDO move
   as the primary cost lever.
4. **Interim D1 allocator contention + cost.** The `next_seq` `UPDATE…RETURNING` and
   `message_dedup` claim are the two dominant hot-path writes AND a contention point
   under concurrent fanout (ROUTING §15 open decision). Both the cost win and the
   correctness win of the SessionDO allocator should be quantified together.

---

*Living document — update §2 status, §4 (new increments), §6 (LIVE/PLANNED
flips), and §7 (real-bill calibration) as the frozen v4 build progresses. Grounded
against: `lib/{routing,delivery,transport,event_bus}.ts`, `routes/conversations2.ts`,
`routes/config.ts`, `index.ts`, `routes/messaging.ts`, `routes/api.ts`,
`do/inbox.ts`, `migrations/{identity_routing,conversations_v2}.sql`, and the three
canonical Specs. Prices marked ASSUMPTION pending real-bill calibration.*
