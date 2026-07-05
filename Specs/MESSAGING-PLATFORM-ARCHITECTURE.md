# Messaging Platform — Canonical Architecture

**Status: FROZEN 2026-07-05 (owner decision).** Governed by `ENGINEERING-CONSTITUTION.md`; the
universal laws are not restated here. This is the single source of truth for how
information moves in AvaTOK. It is the consolidation of the frozen v4 messaging
architecture (`ROUTING-IDENTITY-PRESENCE-ARCH.md`) and evolves only by amendment,
appendix, deprecation notice, or ADR. Cloudflare-native, server-authoritative,
server-readable (no Nostr).

---

## Purpose

Move information between accounts, reliably and in real time.

## Scope

Identity, conversations, routing, delivery, presence, transport, notifications,
realtime guarantees, and (if ever) federation. The nine v4 concepts —
Identity, Conversation, Routing, Delivery, Presence, Notification, Transport,
SessionDO, Event Bus — are named identically here and everywhere.

## Owns

- **Conversation membership and routing** — who is in a conversation and where a
  message must go.
- **Delivery** — getting a message to every participant's device, with ordering and
  acknowledgement at the transport level.
- **Presence** — who is online, typing, or reachable right now.
- **Notification fan-out** — waking devices that aren't connected.
- **Transport** — the connection lifecycle (WebSocket/hibernation, reconnection,
  session identity).

## Never Owns

- **Persistence and reconstruction of message history** → **State Platform.** Messages
  are operations on a Conversation Stream; how they survive, replicate, and rebuild is
  State's job. Messaging *delivers*; State *remembers*.
- **Storage** of any bytes (media, snapshots) → **State Platform** (abstraction) and
  **Infrastructure Platform** (providers).
- **Whether a sender is who they claim / may participate** → **Trust Platform.**
- **AI features over messages** (in-chat assistants, summarization) → **Intelligence
  Platform.**
- **The runtime** (Workers, DOs, Queues) → **Infrastructure Platform.**

---

## 1. Frozen principles (specializations of the constitution)

1. **The client never decides where a message goes.** It references a conversation;
   the server owns participants, routing, presence, delivery, and transport.
2. **Only one component owns any piece of truth.** The ownership map below is
   authoritative; nothing duplicates it.

Ownership map:

| Truth | Owner |
|---|---|
| Account identity (device ↔ account) | Identity |
| Conversation membership | Conversation |
| Where a message routes | Routing |
| Delivery/ack state (transport) | Delivery |
| Online/typing/reachable | Presence |
| Connection/session lifecycle | Transport / SessionDO |
| Message history & content-of-record | **State Platform** (not Messaging) |

---

## 2. Identity

The mapping from a physical device to an account, and from an account to its
reachable endpoints. One phone is shared by a parent and each child account, so
identity is **per-account scoped** — every per-user value is namespaced; only the
device-level client token is global (constitution §2, §9). Identity establishes *who
is connected*; it does not establish *who can be trusted* (that is the Trust
Platform).

## 3. Conversation

The unit of membership. A conversation names its participants and its type (1:1,
group ≤25). Conversation owns the participant set; it does not own the message log —
messages are operations on the conversation's stream in the State Platform. Group
conferences (≤25, LiveKit) and 1:1 P2P calls are conversation-scoped capabilities;
their media transport is Messaging, their call records are State.

## 4. Routing

Given a conversation and a new event, routing determines the set of destination
devices. Routing is pure server logic over Conversation membership and Presence. The
client contributes nothing but the conversation reference.

## 5. Delivery

Ensures each routed event reaches each destination device, with transport-level
ordering and acknowledgement, and hands off to Notification when a device is
unreachable. Delivery guarantees *arrival*; durability of the underlying operation is
the State Platform's guarantee.

## 6. Presence

Ephemeral, real-time reachability: online, typing, last-seen. Presence is
deliberately *not* durable state — it is allowed to be lost and re-derived, which is
why it lives in Messaging and not State.

## 7. Transport

The connection substrate: hibernatable WebSockets to a per-user routing object, the
session lifecycle, reconnection, and 0-RTT concerns. Transport owns the *pipe*; it
never owns the *content of record*.

## 8. Notification

Wakes devices that are not connected (push fan-out with sender name + preview).
Notification is best-effort delivery acceleration; the durable truth always remains
reconstructable from the State Platform even if a notification is missed.

## 9. Realtime guarantees

Declares, per event class, the ordering and latency guarantees at the transport
layer (e.g., messages delivered in send order to connected peers; presence may
reorder; calls signal out-of-band). These are transport guarantees; end-to-end state
convergence is the State Platform's guarantee.

## 10. Federation (if ever)

Reserved. AvaTOK is currently a closed, KYC-gated, walled garden — federation is
explicitly *not* wanted today. If it ever arrives, it is an **amendment** to this
document, not a new architecture.

---

## 11. Telemetry contract

Messaging emits, at minimum: `message_sent`, `message_delivered`, `message_acked`,
`route_computed`, `presence_changed`, `transport_connected` /
`transport_reconnected`, `notification_sent`, `notification_missed`. These are part
of the platform contract (constitution §2.8), independent of the runtime that emits
them.

---

## 12. Evolution rules

Changes to Messaging are amendments, appendices, deprecation notices, or ADRs
(constitution §4). Adding a new conversation type or delivery guarantee is an
amendment. Introducing a new transport is an ADR. No `v5`, no parallel messaging
spec. Where this document and any older messaging spec disagree, this document wins.
