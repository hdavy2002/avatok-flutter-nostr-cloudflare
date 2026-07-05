// Internal Event Bus — the backbone of the server-authoritative messaging arch.
// Spec: Specs/ROUTING-IDENTITY-PRESENCE-ARCH.md §7 (Event Bus) + §8 (receipts).
//
// Everything in the pipeline emits IMMUTABLE events; consumers (Notification,
// Sync, Analytics, AI, Moderation, Search, badge counters) SUBSCRIBE rather than
// call each other. No subsystem calls another on the send hot path — they all
// derive from this event stream (§7). Delivery must therefore emit a
// `MessagePersisted` event and NEVER call push directly; Notification subscribes
// to Delivery events instead (reverse ownership, §5.6).
//
// P3 skeleton: this is the CONTRACT + a best-effort publish. A real pub/sub fan
// out (Queue topic / DO fanout) attaches at the TODO hook below. The telemetry
// mirror to Q_ANALYTICS ships today so events are observable from day one.
import type { Env } from "../types";

// Ordered delivery stages (§8). Persisted != Replicated — we NEVER report a
// message "delivered" before durable replication, so these are distinct stages
// and a receipt pipeline must not collapse them.
export const DELIVERY_STAGES = [
  "Queued",         // accepted, awaiting processing
  "Resolved",       // recipient identity → route resolved (Routing)
  "Persisted",      // written to a durable substrate (single copy)
  "Replicated",     // durably replicated — safe to report "delivered"
  "SocketDelivered", // pushed over a live SessionDO socket
  "DeviceAck",      // the device acknowledged receipt
  "Rendered",       // the device rendered it on screen
  "Read",           // the human read it
] as const;

export type DeliveryStage = (typeof DELIVERY_STAGES)[number];

// The event vocabulary (§7). Immutable, append-only in spirit: an event is a
// record of something that HAS happened, never a command.
export type BusEventType =
  | "MessagePersisted"
  | "MessageReplicated"
  | "SocketDelivered"
  | "DeviceAck"
  | "MessageRendered"
  | "MessageRead"
  | "NotificationSent"
  | "ReactionAdded"
  | "MessageDeleted"
  | "ConversationArchived"
  | "ParticipantAdded";

// The immutable event envelope. Carries the ordering + identity coordinates a
// subscriber needs to act without calling back into another owner. `ts` is the
// server emit instant (ms). Extra fields ride in `meta` so the contract stays
// additive (never a breaking change to add a subscriber-specific detail).
export type BusEvent = {
  type: BusEventType;
  ts: number;                    // server emit time (ms)
  conv_id?: string;
  server_sequence?: number;      // §8 monotonic-per-conversation cursor
  identity_id?: string;          // the subject identity (recipient/sender by type)
  uid?: string;                  // resolved current uid (Transport-facing), when known
  mid?: string;                  // canonical message id, when the event is message-scoped
  client_msg_id?: string;        // idempotency key echoed for correlation
  stage?: DeliveryStage;         // which §8 stage this event corresponds to, if any
  meta?: Record<string, unknown>; // additive, subscriber-specific detail
};

// Best-effort publish. NEVER throws — the event bus is a decoupling layer, not a
// correctness gate; a failed emit must never take down a send. Today it forwards
// a telemetry mirror to Q_ANALYTICS so every event is queryable in PostHog. The
// real pub/sub (a Queue topic or a fan-out DO that wakes Notification/Sync) hooks
// in at the marked TODO; subscribers are documented, NOT invoked here (§7).
export async function emit(env: Env, e: BusEvent): Promise<void> {
  // TODO(P4): publish `e` to the real bus — a Q_EVENTS Queue topic (or a fan-out
  // DO) that Notification / Sync / Analytics subscribe to. Notification will, on
  // a `MessagePersisted` with no `DeviceAck` within X seconds, wake the device
  // (§5.6). Nothing in this module may call push/Notification directly.
  try {
    // Telemetry mirror (Analytics is one of the documented subscribers). Shaped
    // like the rest of the codebase's Q_ANALYTICS events (event/uid/ts/props) so
    // it lands in the same PostHog project without a new pipeline.
    if ((env as { Q_ANALYTICS?: { send(m: unknown): Promise<void> } }).Q_ANALYTICS) {
      void env.Q_ANALYTICS.send({
        event: "bus_event",
        uid: e.identity_id ?? e.uid ?? "",
        ts: e.ts,
        props: {
          bus_type: e.type,
          conv: e.conv_id ?? null,
          server_sequence: e.server_sequence ?? null,
          identity_id: e.identity_id ?? null,
          uid: e.uid ?? null,
          mid: e.mid ?? null,
          stage: e.stage ?? null,
          app_name: "avatok",
          service_name: "avatok-api",
          worker: true,
        },
      });
    }
  } catch { /* best-effort; the bus never blocks or breaks the pipeline */ }
}
