# Event Bus & Telemetry Contracts — Messaging Architecture

**Status:** DRAFT (**v6** telemetry mapping) — feeds the **v6 PostHog telemetry**
draft of the server-authoritative messaging architecture. This is the contracts
layer between the **ARCHITECTURALLY FROZEN v4** design — canonical spec
`ROUTING-IDENTITY-PRESENCE-ARCH.md` — and the PostHog event catalogue that v6 will
ratify. v6 evolves **independently** of the frozen v4 architecture; it maps v4's
receipt stages onto telemetry, it does not change the architecture. The nine v4
concepts (**Identity, Conversation, Routing, Delivery, Presence, Notification,
Transport, SessionDO, Event Bus**) are named identically here as in the canonical
spec. No code merged. Where a table proposes a NEW event name it is marked
**(new, v6)**; where it references an event that already exists in the live
codebase it is marked **(current)** with the source file.

**Related documents:**
- `ROUTING-IDENTITY-PRESENCE-ARCH.md` — the **frozen v4 canonical spec**; §7
  (Event Bus) and §8 (receipts) are the sections this contract instruments.
- `V4-IMPLEMENTATION-GOVERNANCE.md` — governance/cost artifact whose §6 telemetry
  registry tracks the LIVE/PLANNED status of the events specified here.
- `CURRENT-SYNC-SYSTEM-REPORT-2026-07-05.md` — as-built (legacy) restore/sync
  report feeding the **v5** Sync Engine draft.

---

## 1. Purpose & relationship to the other drafts

This document builds on two mechanisms fully defined in the canonical spec
`ROUTING-IDENTITY-PRESENCE-ARCH.md` (not restated here):

1. **Event Bus** (canonical spec §7) — every subsystem emits immutable events and
   subscribes rather than calling; Analytics/PostHog (v6) is just another
   subscriber, never on the send hot path.
2. **Delivery receipts** (canonical spec §8) — the fixed, server-generated,
   per-stage-timestamped stage sequence
   `Queued → Resolved → Persisted → Replicated → SocketDelivered → DeviceAck →
   Rendered → Read` (`Persisted ≠ Replicated`).

This document specifies **(a)** the wire contract of each bus event (fields,
firing point, subscribers) and **(b)** how those events project onto PostHog so
the v6 draft can lift the tables verbatim. It is deliberately *consistent with the
telemetry that already ships* — it does not rename existing events, it maps them
forward. The current PostHog reality it grounds against:

- Client outbox (`app/lib/sync/outbox.dart`): `msg_outbox_enqueued`,
  `msg_outbox_sent`, `msg_outbox_gave_up`, `msg_echo_received`.
- Client sync hub (`app/lib/sync/sync_hub.dart`): `sync_catchup`, `hub_connected`,
  `hub_disconnected`, `hub_reconnect`, `msg_delivery_latency`, `ttfm_ms`.
- Worker router (`worker/src/routes/messaging.ts`): `chat_message_sent`,
  `chat_delete_delivery`, `chat_delete_fanout`, `chat_reaction`, `forward_sent`,
  `poll_vote` — all fanned to `Q_ANALYTICS` and all already stamped with
  `account_id`, `app_name:"avatok"`, `service_name:"avatok-api"`, `worker:true`.
- Trace correlation (`messaging.ts` `[TRACE-ID-1]`): the client's per-message
  `client_id` **is reused as the trace id** (falls back from an optional
  `x-trace-id` header), so a message's whole send→echo journey is queryable by one
  id. Every event below inherits this convention as `trace_id`.

The two forward-looking assumptions taken from v4 that this contract encodes:
`server_sequence` (the monotonic per-conversation cursor, §8) and the **five
version stamps** — `identity_version`, `conversation_version`, `routing_version`,
`presence_version`, `policy_version` (§9). Today's code has neither; v6 telemetry
should carry them from day one so history replays exactly.

---

## 2. Internal Event Bus contract

Every event is **immutable** and append-only. Emission is a *fact that already
happened*, never a request. **Subscribers never call each other** and never call
the emitter back — they each derive independently from the stream (this is the v4
§7 rule that keeps the system sane at scale). A dropped subscriber (Analytics
down) can never affect delivery; a slow subscriber (Search reindex) can never
back-pressure the send hot path.

**Envelope common to every event** (in addition to the type-specific fields):

| Field | Meaning |
|------|---------|
| `event_id` | ULID of this bus event (idempotency key for subscribers) |
| `type` | one of the types in the table below |
| `conv_id` | conversation the event belongs to (random `conv_<ulid>`, v4 §5.2) |
| `emitted_at` | server epoch ms of emission |
| `trace_id` | the originating message's `client_id` (`[TRACE-ID-1]` convention) |
| `identity_version` / `conversation_version` / `routing_version` / `presence_version` / `policy_version` | the five v4 §9 stamps *as they were at emission* (only the ones relevant to the event need be non-null) |

### 2.1 Event catalogue

`mid` = canonical server message id (`canonicalMsgId`, `messaging.ts`).
`server_sequence` = monotonic per-conversation position (v4 §8). `identity_id` =
durable opaque actor id (v4 §5.1), NOT a uid. "Rel. version stamps" lists which of
the five carry meaning for that event.

| Event type | Fires when | Required fields (beyond envelope) | Rel. version stamps | Subscribers |
|-----------|-----------|-----------------------------------|---------------------|-------------|
| **MessagePersisted** | Delivery has written the row durably to the owner's log (the sender's `appendTo` today) and assigned `server_sequence`. This is *durable*, not yet *replicated*. | `mid`, `server_sequence`, `sender_identity_id`, `kind`, `has_media` | conversation, routing, policy | Sync, Analytics, AI, Moderation, Search, badge/unread |
| **MessageReplicated** | The row is durably replicated to every recipient's log (all `appendTo` fan-out complete, or all queue chunks accepted). Only now may a "delivered" state exist. | `mid`, `server_sequence`, `recipient_count`, `fanout_path` (sync\|queue) | conversation, routing | Notification, Sync, Analytics |
| **SocketDelivered** | Transport confirms the frame was written to at least one live SessionDO socket for a recipient. | `mid`, `server_sequence`, `recipient_identity_id`, `device_id` | presence | Notification (cancels the wake), Analytics |
| **DeviceAck** | A recipient device acknowledges receipt of the frame (transport-level ACK, before render). | `mid`, `server_sequence`, `recipient_identity_id`, `device_id` | presence | Notification, Sync, Analytics |
| **MessageRendered** (a.k.a. **Rendered**) | The recipient client has painted the bubble (client emits; server records). | `mid`, `server_sequence`, `recipient_identity_id`, `device_id` | presence | Analytics (latency/TTFM), badge/unread |
| **MessageRead** (a.k.a. **Read**) | The recipient marked the conversation read up to this position (`/api/msg/read`, stranger-gate suppression respected). | `mid` (or `read_ts`), `server_sequence`, `reader_identity_id` | conversation, policy | Notification (clears), Sync, Analytics, badge/unread |
| **NotificationSent** | Notification woke an unreachable device (FCM/APNS/Email/SMS enqueued). Emitted *by* Notification as it acts on `MessageReplicated`-without-`DeviceAck`. | `mid`, `recipient_identity_id`, `channel` (fcm\|apns\|email\|sms), `provider_result` | presence | Analytics only |
| **ReactionAdded** | A reaction toggle is durably stored (`/api/msg/react`). | `target_mid`, `actor_identity_id`, `emoji`, `op` (add\|remove) | conversation | Analytics, Search, badge/unread (AI on opt-in) |
| **MessageDeleted** | A delete-for-everyone / delete-for-me tombstone is committed. | `target_mid`, `actor_identity_id`, `scope` (everyone\|me), `delivery` (live\|push) | conversation, policy | Notification (silent del push), Sync, Analytics, Search, AI (redaction) |
| **ConversationArchived** | A participant archives/mutes a conversation. | `actor_identity_id`, `state` (archived\|muted\|active) | conversation | Sync, Analytics, badge/unread |
| **ParticipantAdded** | A participant (human or `kind='agent'`) is added to a conversation. | `added_identity_id`, `by_identity_id`, `role` | conversation, identity | Sync, Notification, Analytics, Search |

**Subscriber-fan-out rule (restated for the contract):** Notification is the only
subscriber allowed to *emit a new event* in response to one it consumes
(`MessageReplicated` → `NotificationSent`). Every other subscriber is a pure sink.
No subscriber may synchronously call the emitter, another subscriber, or the send
path. This is what lets v6 add PostHog as "just another subscriber" with zero risk
to delivery — Analytics is the last, most-droppable consumer.

---

## 3. Delivery receipt → telemetry mapping

The eight v4 §8 stages each project to exactly one PostHog event. Every event
carries `trace_id` (= `client_id`), so **one PostHog query on `trace_id`
reconstructs a message's whole life**. Stages are strictly ordered by
`server_sequence` + `emitted_at`; a missing stage in the trace *is the signal*
(e.g. `msg_stage_replicated` present but no `msg_stage_socket_delivered` =
recipient offline).

All events additionally inherit the **already-shipping base props**: `account_id`,
`app_name:"avatok"`, and, on server-emitted rows, `service_name:"avatok-api"`,
`worker:true`. Client-emitted rows inherit `Analytics._base` (platform, email,
cellular).

| v4 stage | PostHog event | Emitter | Key properties (+ common: `trace_id`, `conv_id`, `server_sequence`) |
|---------|--------------|---------|----------------------------------------------------------------------|
| Queued | `msg_stage_queued` **(new, v6)** — supersedes client `msg_outbox_enqueued` | client outbox | `kind`, `conv_kind` (dm\|group), `queued_depth` |
| Resolved | `msg_routed` **(new, v6)** — see §4 | worker Routing | `sender_uid`, `recipient_identity`, `resolved_uid`, `routing_version`, `generation`, `result`, `latency_ms` |
| Persisted | `msg_stage_persisted` **(new, v6)** | worker Delivery | `mid`, `sender_identity`, `kind`, `has_media`, `policy_version` |
| Replicated | `msg_stage_replicated` **(new, v6)** — pairs with current `chat_message_sent` | worker Delivery | `mid`, `recipient_count`, `fanout_path` (sync\|queue), `latency_ms` |
| SocketDelivered | `msg_stage_socket_delivered` **(new, v6)** | worker Transport | `mid`, `recipient_identity`, `device_id`, `presence_version` |
| DeviceAck | `msg_stage_device_ack` **(new, v6)** | client (recipient) | `mid`, `device_id`, `ack_latency_ms` |
| Rendered | `msg_stage_rendered` **(new, v6)** — subsumes current `ttfm_ms` / `msg_delivery_latency` | client (recipient) | `mid`, `render_latency_ms`, `via` (live\|sync) |
| Read | `msg_stage_read` **(new, v6)** — pairs with the read receipt path | client (reader) → worker | `read_ts`, `reader_identity`, `suppressed` (stranger-gate) |

**Sender-side echo completion** remains the exactly-once anchor and keeps its
current name: `msg_echo_received` **(current, `outbox.dart`)** carries
`client_msg_id` (= `trace_id`), `ack_to_echo_ms`, `acked`, `conv_kind`. In v6 it
correlates the sender's `msg_stage_queued` to the durable echo through the same
`trace_id`, closing the loop on the sender's own timeline.

**Correlation contract:** every stage row MUST carry the same `trace_id`. Because
`client_id` is already unique per message and already reused as `trace_id` server
side, no new id is minted — v6 only has to *stamp it on the stage events it adds*.
A single PostHog funnel keyed on `trace_id` then yields the per-message waterfall
(queued→read) and, aggregated, the per-stage drop-off across all traffic.

---

## 4. New server events (the routing-observability win)

Two events instrument the exact layer whose *absence* caused the 2026-07-05
incident: **Routing** (v4 §5.3), where `identity_id → current_uid` is resolved.

### 4.1 `msg_routed` **(new, v6)** — the resolve-success row

Emitted by Routing once per recipient resolution on the send path, *before*
Delivery persists.

| Property | Value |
|---------|-------|
| `sender_uid` | authenticated sender uid (`ctx.uid`) |
| `recipient_identity` | the `identity_id` the client referenced (never a client-passed uid/npub) |
| `resolved_uid` | `routes.current_uid` the identity resolved to |
| `conversation_id` | `conv_id` |
| `server_sequence` | assigned position |
| `routing_version` | `routes.routing_version` at resolve time |
| `generation` | `routes.generation` (bumped on any re-key) |
| `result` | `routed` \| `unresolved` \| `merged_followed` (resolved via `merged_into`) |
| `latency_ms` | resolve time incl. KV hot-path lookup |
| + base | `trace_id`, `account_id`, `app_name`, `service_name`, `worker` |

### 4.2 `msg_route_unresolved` **(new, v6)** — the fail-loud miss path

Emitted when `resolveRoute → null` (v4 §10). This is the event that must exist for
a misroute to be *visible instead of silent*. It pairs with the `409
unroutable_recipient` the server returns; the client re-establishes the
conversation rather than retrying into a dead inbox.

| Property | Value |
|---------|-------|
| `sender_uid` | `ctx.uid` |
| `recipient_identity` | the identity that failed to resolve |
| `attempted_alias` | the alias family that missed (`npub` \| `uid` \| `tel` \| `number`) — the `to_kind` precursor (§5) |
| `conversation_id` | `conv_id` (or null on first-contact) |
| `reason` | `no_route` \| `disabled` \| `merged_dangling` |
| + base | `trace_id`, `account_id`, `app_name`, `service_name`, `worker` |

### 4.3 How this makes the npub incident a one-query diagnosis

The 2026-07-05 incident (v4 §12): Sat's `msg_outbox_sent` + `msg_echo_received`
both fired (sender's own log echoed fine), the recipient was online, yet every
`sync_catchup` since returned `messages=0`. The sender held the peer's **stale
npub**; the recipient reads under a Clerk **uid**; the messages landed in an inbox
nobody read — **and no event recorded the misroute**, so the only way to see it was
to correlate two separate telemetry streams by hand and infer the identity mismatch.

With §4 in place, the diagnosis is a single PostHog query:

```
SELECT recipient_identity, attempted_alias, reason, count()
FROM events WHERE event = 'msg_route_unresolved'
  AND properties.sender_uid = '<Sat-uid>'
GROUP BY recipient_identity, attempted_alias, reason
```

One row: `attempted_alias = npub, reason = merged_dangling` — the stale-npub family
named explicitly, per recipient, with a timestamp. Equivalently, a `msg_routed`
query where `result != 'routed'` surfaces the same class in aggregate. The
"sender sees sent, recipient gets nothing, no error" failure mode of v4 §1 becomes
impossible to have *silently*: either `msg_routed(result=routed)` exists for that
`trace_id`, or `msg_route_unresolved` does. There is no third, invisible outcome.

---

## 5. Migration / back-compat

v6 is additive: the current events keep flowing while the stage events roll in, so
dashboards never go dark mid-migration. The precursor property `to_kind`
(`uid` \| `npub` \| `other`) is added to the *current* send/outbox events **first**
— before Routing ships — so that even under the legacy
client-authoritative path we can immediately see how much traffic still addresses
by npub. That single prop is the cheapest early-warning signal for the exact
incident class, and it becomes `attempted_alias` once Routing exists.

| Old event (current) | Source | New / coexisting event | Coexistence rule |
|--------------------|--------|------------------------|------------------|
| `msg_outbox_enqueued` | `outbox.dart` | `msg_stage_queued` **(new)** | Keep `msg_outbox_enqueued`; emit `msg_stage_queued` alongside with `trace_id` + `to_kind`. Retire the old name only after v6 dashboards cut over. |
| `msg_outbox_sent` | `outbox.dart` | `msg_stage_replicated` **(new)** + keep `msg_outbox_sent` | `msg_outbox_sent` is the sender's ACK-latency signal (UX "sent"); `msg_stage_replicated` is the server durability truth. Both coexist — they measure different stages. Add `to_kind` to `msg_outbox_sent` now. |
| `msg_echo_received` | `outbox.dart` | **unchanged** | Stays the exactly-once echo anchor; gains nothing but the shared `trace_id` framing. |
| `sync_catchup` | `sync_hub.dart` | `msg_stage_rendered` (per-message) + `sync_catchup` (per-batch) | `sync_catchup` stays as the *batch* connect-sync metric (`messages`, `ms`, `trigger`); per-message render latency moves to `msg_stage_rendered`. Add `cursor` → `last_server_sequence` mapping when v5 lands. |
| `chat_message_sent` | `messaging.ts` | `msg_stage_replicated` **(new)** | `chat_message_sent` already carries `path`/`recipients`/`latency_ms` — it IS the replicated-stage row today. v6 renames-forward to `msg_stage_replicated` and adds `mid` + `server_sequence`; keep `chat_message_sent` as an alias for one migration window. |
| `msg_delivery_latency` | `sync_hub.dart` | folded into `msg_stage_rendered` (`via`) | The live/sync latency split becomes the `via` prop on the render stage. |
| (none — silent misroute) | — | `msg_routed` / `msg_route_unresolved` **(new)** | Net-new; no old equivalent — that absence *was* the bug. |

`to_kind` precursor (add to `msg_outbox_enqueued`, `msg_outbox_sent`,
`chat_message_sent` immediately):

| `to_kind` | Meaning |
|----------|---------|
| `uid` | recipient addressed by a current Clerk uid — the healthy path |
| `npub` | recipient still addressed by a legacy npub — the incident class; alert if non-zero |
| `other` | tel/number/handle or anything else — watch for first-contact resolution gaps |

---

## 6. Open questions (for v6 to resolve)

1. **PII / id redaction.** `sender_uid`, `resolved_uid`, `recipient_identity`,
   `email`, `phone` flow through several events today (`forward_sent` already
   carries `email`). Do we hash identity ids before they reach PostHog, or keep
   them raw for support-driven "pull this user's trace" workflows (the
   CLAUDE.md telemetry rule wants email/phone *present* for issue triage)? Proposal
   to settle in v6: keep `account_id`/`email` for the ops need, but hash
   `recipient_identity` in aggregate dashboards and expose the raw id only in a
   restricted, support-scoped view.
2. **Sampling at scale.** At millions of users, emitting all eight stage events per
   message is 8× the send volume into `Q_ANALYTICS`. Which stages are always-on
   (proposal: `msg_routed`, `msg_route_unresolved`, `msg_stage_replicated` — the
   correctness-critical ones) vs. sampled (proposal: `msg_stage_socket_delivered`,
   `msg_stage_rendered` at, say, 1–5%)? Sampling MUST be `trace_id`-consistent (a
   sampled message emits *all* its stages or none) so funnels stay coherent.
3. **Version-stamp cost.** Carrying all five version stamps on every event is cheap
   in bytes but only useful if history actually replays by them — does v6 index on
   them, or store-only-for-forensics?
4. **Client-emitted stage trust.** `msg_stage_rendered` / `msg_stage_device_ack`
   originate on the recipient device; a clock-skewed or hostile client can lie.
   v6 should decide whether these are advisory (UX/latency only) or ever
   load-bearing for delivery guarantees (they should not be — server stages are
   authoritative, per v4 §8 "never trust client timestamps").

---

*Feeds: the v6 PostHog telemetry draft. Depends on: `ROUTING-IDENTITY-PRESENCE-ARCH.md`
(v4, §6–10), `CURRENT-SYNC-SYSTEM-REPORT-2026-07-05.md`. Grounded against live code:
`app/lib/sync/outbox.dart`, `app/lib/sync/sync_hub.dart`,
`worker/src/routes/messaging.ts` (`[TRACE-ID-1]`, `Q_ANALYTICS`). PostHog project
139917.*
