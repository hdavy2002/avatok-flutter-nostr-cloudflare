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
import { blocks, dmConvId } from "../authz";

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

/**
 * Marketplace system-DM delivery contract.
 *
 * Marketplace negotiation is server-authored, but it is still a normal DM as
 * far as the two users' chat lists and InboxDOs are concerned.  Keep this
 * small helper next to the delivery primitives so route code cannot silently
 * forget the conversation membership or the hard block gate.
 */
export type MarketplaceDm = {
  sellerUid: string;
  buyerUid: string;
  listingId: string;
  negotiationId: string;
};

export type MarketplaceMessage = {
  recipient: string;
  sender: string;
  conv: string;
  body: string;
  mediaRef?: string | null;
  clientId: string;
  mid: string;
  createdAt?: number;
};

export type MarketplaceAppendResult = {
  id: number;
  live: boolean;
  alreadyProcessed: boolean;
};

export type MarketplacePatchResult = {
  found: boolean;
  live: boolean;
};

/** Stable logical identity shared by both recipient copies of one artifact. */
export function marketplaceArtifactId(negotiationId: string, version = 1): string {
  return `mktdeal:${negotiationId}:v${Math.max(1, Math.trunc(version))}`;
}

/** Stable message/client identity. InboxDO dedupe is per (conv, client_id). */
export function marketplaceMessageId(artifactId: string, event = "audio"): string {
  return `${artifactId}:${event}`;
}

/** The one durable Messenger row that represents the negotiation result. */
export function marketplaceResultMessageId(artifactId: string): string {
  return marketplaceMessageId(artifactId, "result");
}

/** Ensure the canonical DM exists for both users before any InboxDO append. */
export async function ensureMarketplaceDm(env: Env, dm: MarketplaceDm): Promise<string> {
  if (!dm.sellerUid || !dm.buyerUid || dm.sellerUid === dm.buyerUid) {
    throw new Error("marketplace_dm_participants_invalid");
  }
  if (await blocks(env, dm.sellerUid, dm.buyerUid) || await blocks(env, dm.buyerUid, dm.sellerUid)) {
    throw new Error("marketplace_dm_blocked");
  }
  const conv = dmConvId(dm.sellerUid, dm.buyerUid);
  const now = Date.now();
  await env.DB_META.batch([
    env.DB_META.prepare(
      "INSERT OR IGNORE INTO conversations (id, kind, created_by, created_at, updated_at, context) VALUES (?1,'dm',?2,?3,?3,?4)",
    ).bind(conv, dm.buyerUid, now, `event:${dm.listingId}`),
    env.DB_META.prepare(
      "UPDATE conversations SET context=COALESCE(context, ?2), updated_at=?3 WHERE id=?1",
    ).bind(conv, `event:${dm.listingId}`, now),
    env.DB_META.prepare(
      "INSERT OR IGNORE INTO conversation_members (conv_id, uid, role, joined_at) VALUES (?1,?2,'member',?3)",
    ).bind(conv, dm.sellerUid, now),
    env.DB_META.prepare(
      "INSERT OR IGNORE INTO conversation_members (conv_id, uid, role, joined_at) VALUES (?1,?2,'member',?3)",
    ).bind(conv, dm.buyerUid, now),
  ]);
  return conv;
}

/**
 * Append one server-authored marketplace message and fail loudly on a non-2xx
 * InboxDO response.  The InboxDO's client_id uniqueness is the durable
 * exactly-once guard; the deterministic mid is shared by both copies.
 */
export async function appendMarketplaceMessage(env: Env, m: MarketplaceMessage): Promise<MarketplaceAppendResult> {
  if (!env.INBOX) throw new Error("marketplace_inbox_unbound");
  const stub = env.INBOX.get(env.INBOX.idFromName(m.recipient));
  const res = await stub.fetch("https://inbox/append", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      conv: m.conv,
      sender: m.sender,
      kind: "text",
      body: m.body,
      media_ref: m.mediaRef ?? null,
      client_id: m.clientId,
      mid: m.mid,
      created_at: m.createdAt ?? Date.now(),
      owner: m.recipient,
    }),
  });
  const out = await res.json().catch(() => ({})) as { id?: number; live?: boolean; already_processed?: boolean; error?: string };
  if (!res.ok || out.error) throw new Error(`marketplace_inbox_append_failed:${res.status}:${out.error || "unknown"}`);
  return {
    id: Number(out.id || 0),
    live: out.live === true,
    alreadyProcessed: out.already_processed === true,
  };
}

/** Patch the existing logical marketplace row in-place.
 *
 * InboxDO exposes this as the only server-authorised body edit path. Keeping
 * the same client_id means the text result, audio enrichment, and approval
 * decision are one Messenger message rather than three cards.
 */
export async function patchMarketplaceMessage(
  env: Env,
  recipient: string,
  clientId: string,
  body: string,
): Promise<MarketplacePatchResult> {
  if (!env.INBOX) throw new Error("marketplace_inbox_unbound");
  const stub = env.INBOX.get(env.INBOX.idFromName(recipient));
  const res = await stub.fetch("https://inbox/msg_body", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, body }),
  });
  const out = await res.json().catch(() => ({})) as { found?: boolean; live?: boolean; error?: string };
  if (!res.ok || out.error) throw new Error(`marketplace_inbox_patch_failed:${res.status}:${out.error || "unknown"}`);
  return { found: out.found === true, live: out.live === true };
}

/** Patch both recipient copies, falling back to an idempotent append if a
 * legacy/partial inbox does not yet contain the result row. */
export async function upsertMarketplaceMessage(
  env: Env,
  dm: MarketplaceDm,
  body: string,
  artifactId: string,
  event = "result",
  mediaRef: string | null = null,
): Promise<{ conv: string; clientId: string; mid: string; buyer: MarketplaceAppendResult | MarketplacePatchResult; seller: MarketplaceAppendResult | MarketplacePatchResult }> {
  const conv = await ensureMarketplaceDm(env, dm);
  const clientId = marketplaceMessageId(artifactId, event);
  const mid = clientId;
  const [buyerPatch, sellerPatch] = await Promise.all([
    patchMarketplaceMessage(env, dm.buyerUid, clientId, body),
    patchMarketplaceMessage(env, dm.sellerUid, clientId, body),
  ]);
  const createdAt = Date.now();
  const buyer = buyerPatch.found
    ? buyerPatch
    : await appendMarketplaceMessage(env, { recipient: dm.buyerUid, sender: dm.sellerUid, conv, body, mediaRef, clientId, mid, createdAt });
  const seller = sellerPatch.found
    ? sellerPatch
    : await appendMarketplaceMessage(env, { recipient: dm.sellerUid, sender: dm.buyerUid, conv, body, mediaRef, clientId, mid, createdAt });
  return { conv, clientId, mid, buyer, seller };
}

/** Deliver one identical logical event to both sides of the canonical DM. */
export async function deliverMarketplaceMessage(
  env: Env,
  dm: MarketplaceDm,
  body: string,
  artifactId: string,
  event = "audio",
  mediaRef: string | null = null,
): Promise<{ conv: string; clientId: string; mid: string; buyer: MarketplaceAppendResult; seller: MarketplaceAppendResult }> {
  const conv = await ensureMarketplaceDm(env, dm);
  const clientId = marketplaceMessageId(artifactId, event);
  const mid = clientId;
  const createdAt = Date.now();
  const [buyer, seller] = await Promise.all([
    appendMarketplaceMessage(env, { recipient: dm.buyerUid, sender: dm.sellerUid, conv, body, mediaRef, clientId, mid, createdAt }),
    appendMarketplaceMessage(env, { recipient: dm.sellerUid, sender: dm.buyerUid, conv, body, mediaRef, clientId, mid, createdAt }),
  ]);
  return { conv, clientId, mid, buyer, seller };
}

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
