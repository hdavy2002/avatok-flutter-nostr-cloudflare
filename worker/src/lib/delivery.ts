// Delivery — "how do we process & guarantee this message?"
// Spec: Specs/ROUTING-IDENTITY-PRESENCE-ARCH.md §5.4 (Delivery), §6 (send
// contract), §8 (ordering / idempotency / receipts), §10 (fail loud).
//
// Delivery owns ordering (server_sequence), dedupe/idempotency, fanout, and the
// receipt pipeline. It is the generalization of the current messaging.ts sendMsg:
// where sendMsg trusts a client `to` and calls appendTo() per member, this layer
// takes IDENTITY recipients, resolves each via Routing, and moves bytes via
// Transport — the client never picks a physical destination.
//
// Ownership boundaries kept sacred:
//   • Routing (lib/routing.ts) owns identity → uid; Delivery never reads uids.
//   • Transport (lib/transport.ts) owns the substrate; Delivery never touches DOs.
//   • Notification is NOT called here — Delivery EMITS events; Notification
//     subscribes to them (§5.6 / §7). No push from this file.
//   • Conversation owns the server_sequence allocator; we import it, not reimplement.
import type { Env } from "../types";
import { resolveRoute } from "./routing";
import { transportFor } from "./transport";
import { emit } from "./event_bus";
import { allocateSequence } from "../routes/conversations2";
import { canonicalMsgId } from "../util";

// The send contract (§6), identity-only. `recipients` are identity_ids — NEVER
// uids/npubs (a client passing a cached uid was the stale-npub bug, §6 warning).
export type DeliveryInput = {
  convId: string;
  senderIdentity: string;
  clientMsgId: string;
  kind: string;
  body: string | null;
  mediaRef?: string | null;
  recipients: string[]; // identity_ids
};

// Per-recipient outcome. 'unroutable' = resolveRoute returned null → fail loud,
// never write to a dead inbox (§10). 'store_failed' = the substrate write failed.
export type RecipientResult = {
  identityId: string;
  result: "delivered" | "unroutable" | "store_failed";
  uid?: string;
  stored_at?: number;
  live?: boolean;
};

export type DeliveryResult = {
  server_sequence: number;
  mid: string;
  deduped: boolean;              // true → this clientMsgId was already delivered
  perRecipient: RecipientResult[];
};

// Lazy-DDL (matches keybackup.ts). The idempotency ledger: the FIRST accepted
// (conv, sender, client_msg_id) wins; a duplicate returns the ORIGINAL result and
// never fans out again — no duplicate rows ever (§8).
async function ensureTables(env: Env): Promise<void> {
  await env.DB_META.prepare(
    `CREATE TABLE IF NOT EXISTS message_dedup (
       conv_id         TEXT NOT NULL,
       sender_identity TEXT NOT NULL,
       client_msg_id   TEXT NOT NULL,
       mid             TEXT NOT NULL,
       server_sequence INTEGER NOT NULL,
       created_at      INTEGER NOT NULL,
       PRIMARY KEY (conv_id, sender_identity, client_msg_id)
     )`,
  ).run();
}

// Look up a prior delivery of this exact (conv, sender, client_msg_id).
async function priorDelivery(env: Env, input: DeliveryInput):
  Promise<{ mid: string; server_sequence: number } | null> {
  const row = await env.DB_META
    .prepare(
      `SELECT mid, server_sequence FROM message_dedup
        WHERE conv_id=?1 AND sender_identity=?2 AND client_msg_id=?3 LIMIT 1`,
    )
    .bind(input.convId, input.senderIdentity, input.clientMsgId)
    .first<{ mid: string; server_sequence: number }>();
  return row ?? null;
}

// The core pipeline (§6 order): dedupe → order → fanout(resolve→transport→emit).
// One bad recipient never throws the whole delivery — it's recorded 'unroutable'
// / 'store_failed' and the rest proceed (§10 fail-loud, per-recipient granularity).
export async function deliver(env: Env, input: DeliveryInput): Promise<DeliveryResult> {
  await ensureTables(env);

  // (a) Idempotency. A duplicate returns the ORIGINAL result with no re-fanout.
  const prior = await priorDelivery(env, input);
  if (prior) {
    return {
      server_sequence: prior.server_sequence,
      mid: prior.mid,
      deduped: true,
      // A dedup is a client retry of an already-completed send — the first
      // delivery already fanned out. We surface the identity list without
      // re-writing any inbox (exactly-once), matching InboxDO's dedup semantics.
      perRecipient: input.recipients.map((identityId) => ({ identityId, result: "delivered" as const })),
    };
  }

  // (b) Ordering. Conversation owns the atomic allocator; we never invent our own.
  const server_sequence = await allocateSequence(env, input.convId);
  const created = Date.now();
  const mid = canonicalMsgId(created);

  // Claim the idempotency slot BEFORE fanout so a concurrent retry can't double
  // send. INSERT OR IGNORE: if a racing request won the PK, we fall back to its
  // record (return deduped) rather than fanning out a second time.
  const claim = await env.DB_META
    .prepare(
      `INSERT OR IGNORE INTO message_dedup
         (conv_id, sender_identity, client_msg_id, mid, server_sequence, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(input.convId, input.senderIdentity, input.clientMsgId, mid, server_sequence, created)
    .run();
  const won = (claim.meta?.changes ?? 0) > 0;
  if (!won) {
    const raced = await priorDelivery(env, input);
    if (raced) {
      return {
        server_sequence: raced.server_sequence,
        mid: raced.mid,
        deduped: true,
        perRecipient: input.recipients.map((identityId) => ({ identityId, result: "delivered" as const })),
      };
    }
  }

  // The substrate payload. Mirrors the sendMsg envelope so the SessionDO append
  // path is unchanged; `mid` + `server_sequence` carry the §8 ordering cursor.
  const basePayload: Record<string, unknown> = {
    conv: input.convId,
    sender: input.senderIdentity,
    kind: input.kind,
    body: input.body,
    media_ref: input.mediaRef ?? null,
    client_id: input.clientMsgId,
    created_at: created,
    mid,
    server_sequence,
  };

  // (c) Fanout. For each recipient identity: Routing → Transport → emit events.
  const perRecipient: RecipientResult[] = [];
  await Promise.all(input.recipients.map(async (identityId) => {
    // Routing owns identity → uid. Null → fail LOUD for THIS recipient only; emit
    // nothing to a dead inbox (§10). The whole delivery is NOT thrown.
    const route = await resolveRoute(env, identityId);
    if (!route) {
      perRecipient.push({ identityId, result: "unroutable" });
      // TODO(§10): surface `msg_route_unresolved` telemetry + a 409-style signal
      // to the caller so the client re-establishes the conversation. No dead write.
      return;
    }

    // Transport owns the substrate; we never touch a DO here.
    const t = transportFor(env, route);
    const w = await t.write(env, route.uid, basePayload);
    if (!w.ok) {
      perRecipient.push({ identityId, result: "store_failed", uid: route.uid });
      return;
    }

    perRecipient.push({
      identityId, result: "delivered", uid: route.uid,
      stored_at: w.stored_at, live: w.live,
    });

    // Persisted (§8): a durable write landed. Emit — Notification subscribes and
    // wakes the device if no DeviceAck follows; Delivery NEVER calls push here.
    await emit(env, {
      type: "MessagePersisted", ts: Date.now(), stage: "Persisted",
      conv_id: input.convId, server_sequence, identity_id: identityId,
      uid: route.uid, mid, client_msg_id: input.clientMsgId,
    });

    // TODO(§8): emit `MessageReplicated` once the substrate confirms durable
    // replication (Persisted != Replicated — never report delivered before this).
    // TODO(§8): on SessionDO socket delivery emit `SocketDelivered`; on the device
    // ack emit `DeviceAck`; then `MessageRendered` / `MessageRead` from receipts.
    // TODO(§7): Notification is a SUBSCRIBER of `MessagePersisted` — do NOT enqueue
    // push from this file; it derives the wake from the event stream.
  }));

  // (d) Result. deduped=false (this was the first, real delivery).
  return { server_sequence, mid, deduped: false, perRecipient };
}
