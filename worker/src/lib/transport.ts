// Transport — "how do we physically move the bytes?"
// Spec: Specs/ROUTING-IDENTITY-PRESENCE-ARCH.md §5.7 (Transport) + §5.8 (SessionDO).
//
// Transport owns the message SUBSTRATE and geography/sharding: it maps a resolved
// route (uid, capabilities) → a concrete SessionDO (or, tomorrow, a Queue / stream
// / other DO / a different region). It is the ONE and ONLY layer that knows the
// physical substrate — Routing must NEVER know region/inbox/transport (§5.3), and
// Delivery talks to this interface, never to a DO directly.
//
// P3 skeleton: the one implementation is InboxDO-backed (the existing per-user
// Durable Object, addressed by idFromName(uid)). It mirrors how messaging.ts
// appendTo() works. The naming target is SessionDO (§5.8) — when the DO is renamed
// / re-bound, this file changes and nothing above it does.
import type { Env } from "../types";

// A minimal shape of what Routing hands us (see lib/routing.ts `resolveRoute`).
// We depend only on `uid` here; capabilities are passed through for a future
// substrate that shards on them (e.g. video-capable regions).
type RouteLike = { uid: string; capabilities?: unknown };

// The physical-delivery abstraction. `write` durably lands one payload for the
// target and reports whether it stored (and, when known, when).
export interface Transport {
  write(env: Env, targetUid: string, payload: Record<string, unknown>):
    Promise<{ ok: boolean; stored_at?: number; id?: number; live?: boolean }>;
}

// Convenience: the SessionDO (currently InboxDO) stub for a uid. This is the only
// spot that touches env.INBOX by name; everything above uses `Transport`.
export function sessionStubFor(env: Env, uid: string): DurableObjectStub {
  return env.INBOX.get(env.INBOX.idFromName(uid));
}

// InboxDO-backed transport. Maps (uid) → the existing INBOX Durable Object and
// POSTs to its /append op — the same wire the router's messaging.ts appendTo()
// uses, so the DO's idempotency + broadcast behaviour is unchanged. When the DO
// becomes SessionDO / a Queue substrate, only this class is rewritten.
class InboxTransport implements Transport {
  async write(env: Env, targetUid: string, payload: Record<string, unknown>):
    Promise<{ ok: boolean; stored_at?: number; id?: number; live?: boolean }> {
    try {
      const stub = sessionStubFor(env, targetUid);
      const res = await stub.fetch("https://inbox/append", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The DO stamps `owner` on the row from this field (see inbox.ts append()).
        body: JSON.stringify({ ...payload, owner: targetUid }),
      });
      const j = (await res.json().catch(() => ({}))) as
        { id?: number; live?: boolean; already_processed?: boolean };
      return { ok: true, stored_at: Date.now(), id: j.id, live: j.live };
    } catch {
      // Fail loud to the caller (Delivery decides what to do); never swallow into
      // a "sent" the recipient never sees (the incident this arch fixes, §12).
      return { ok: false };
    }
  }
}

// Single shared instance — the transport is stateless.
const INBOX_TRANSPORT = new InboxTransport();

// Choose the substrate for a resolved route. For now every route lands on the
// InboxDO transport; region/shard selection (§5.7) plugs in here later, keyed on
// route.capabilities and a datacentre map — WITHOUT any change to Routing/Delivery.
export function transportFor(_env: Env, _route: RouteLike): Transport {
  return INBOX_TRANSPORT;
}
