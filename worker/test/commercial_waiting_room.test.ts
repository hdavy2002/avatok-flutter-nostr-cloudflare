import { describe, expect, it, vi } from "vitest";
import { buildWaitingRoomGrant } from "../src/lib/commercial_waiting_room";
import { bustConfigMemo } from "../src/routes/config";

// Minimal KV fake — mirrors the pattern in test/ai_free_budget.test.ts.
class FakeKv {
  private store = new Map<string, string>();
  gets = 0;
  async get(key: string, type?: string) {
    this.gets += 1;
    const v = this.store.get(key);
    if (v === undefined) return null;
    return type === "json" ? JSON.parse(v) : v;
  }
  async put(key: string, value: string) { this.store.set(key, value); }
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  const kv = new FakeKv();
  void kv.put("platform_config", JSON.stringify(overrides));
  const scheduleCalls: any[] = [];
  const env: any = {
    ENVIRONMENT_NAME: `test-${Math.random()}`, // dodge the 10s config memo across tests
    TOKENS: kv,
    JOIN_LINK_SECRET: "test-secret",
    STREAM_SESSION_DO: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: async (_url: string, init?: RequestInit) => {
          const body = init?.body ? JSON.parse(String(init.body)) : {};
          scheduleCalls.push(body);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      }),
    },
  };
  return { env, scheduleCalls, kv };
}

const BASE_PARAMS = {
  bookingId: "commercial-booking-abc123",
  uid: "buyer-1",
  role: "attendee" as const,
  name: "Buyer One",
  startsAt: 1_000_000,
  endsAt: 1_000_000 + 60 * 60_000,
  creatorId: "creator-1",
};

describe("buildWaitingRoomGrant", () => {
  it("signs a room token, builds room_ws for the right host, and derives check_in_by from sessionCreatorCheckInMin", async () => {
    const { env, scheduleCalls } = makeEnv({ sessionCreatorCheckInMin: 20 });
    const grant = await buildWaitingRoomGrant(env, BASE_PARAMS);

    expect(grant.room_ws).toBe(
      `wss://api.avatok.ai/api/consult/${BASE_PARAMS.bookingId}/room?token=${grant.room_token}`,
    );
    expect(grant.room_token.split(".")).toHaveLength(2);
    expect(grant.check_in_by).toBe(BASE_PARAMS.startsAt + 20 * 60_000);

    // Armed the DO with `schedule` + commercial:true (RULEBOOK §5 — only the
    // commercial settlement engine may move money for this booking).
    expect(scheduleCalls).toHaveLength(1);
    expect(scheduleCalls[0]).toMatchObject({
      op: "schedule",
      sid: BASE_PARAMS.bookingId,
      kind: "consult",
      starts_at: BASE_PARAMS.startsAt,
      ends_at: BASE_PARAMS.endsAt,
      host_id: BASE_PARAMS.creatorId,
      wait_min: 20,
      commercial: true,
    });
  });

  it("falls back to the 20-minute default when the flag is absent", async () => {
    const { env } = makeEnv({});
    const grant = await buildWaitingRoomGrant(env, BASE_PARAMS);
    expect(grant.check_in_by).toBe(BASE_PARAMS.startsAt + 20 * 60_000);
  });

  it("honors a non-default sessionCreatorCheckInMin", async () => {
    const { env, scheduleCalls } = makeEnv({ sessionCreatorCheckInMin: 5 });
    const grant = await buildWaitingRoomGrant(env, BASE_PARAMS);
    expect(grant.check_in_by).toBe(BASE_PARAMS.startsAt + 5 * 60_000);
    expect(scheduleCalls[0].wait_min).toBe(5);
  });

  it("uses api-staging.avatok.ai when ENVIRONMENT_NAME is staging", async () => {
    const { env } = makeEnv({});
    env.ENVIRONMENT_NAME = "staging";
    const grant = await buildWaitingRoomGrant(env, BASE_PARAMS);
    expect(grant.room_ws.startsWith("wss://api-staging.avatok.ai/")).toBe(true);
  });

  it("falls back to a display name of 'Someone' when name is null", async () => {
    const { env } = makeEnv({});
    const grant = await buildWaitingRoomGrant(env, { ...BASE_PARAMS, name: null });
    // Decode the token body to confirm the signed payload, not just that it didn't throw.
    const [body] = grant.room_token.split(".");
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    expect(payload.name).toBe("Someone");
    expect(payload.role).toBe("attendee");
    expect(payload.sid).toBe(BASE_PARAMS.bookingId);
  });
});

describe("buildWaitingRoomGrant honors a caller-supplied config (W10)", () => {
  it("skips its own readConfig call when the caller already fetched config", async () => {
    const { env, kv } = makeEnv({ sessionCreatorCheckInMin: 7 });
    kv.gets = 0; // reset after the makeEnv setup read, if any
    const config = { sessionCreatorCheckInMin: 7 } as any;
    const grant = await buildWaitingRoomGrant(env, { ...BASE_PARAMS, config });
    expect(grant.check_in_by).toBe(BASE_PARAMS.startsAt + 7 * 60_000);
    expect(kv.gets).toBe(0); // no extra readConfig KV read — the shared config was used
  });

  it("still falls back to readConfig(env) when no config is supplied (direct callers)", async () => {
    const { env, kv } = makeEnv({ sessionCreatorCheckInMin: 9 });
    kv.gets = 0;
    const grant = await buildWaitingRoomGrant(env, BASE_PARAMS);
    expect(grant.check_in_by).toBe(BASE_PARAMS.startsAt + 9 * 60_000);
    expect(kv.gets).toBeGreaterThan(0);
  });
});

describe("buildWaitingRoomGrant cleanup", () => {
  it("resets the module-scope config memo between suites", () => {
    bustConfigMemo();
    expect(true).toBe(true);
  });
});
