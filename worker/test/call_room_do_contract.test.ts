import { describe, expect, it } from "vitest";
import { CallRoom } from "../src/do/call_room";

function fakeRoom(seed: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(seed));
  const failStoragePut = seed.__failStoragePut === true;
  // [CALL-ATOMIC-1 2026-08-03] Aggregate mutations now run inside
  // withAggregateLock(). Serialize like the runtime: one callback at a time,
  // FIFO. See test/call_room_atomicity.test.ts for the races this guards.
  let lock: Promise<unknown> = Promise.resolve();
  const state = {
    id: { name: "avatok-test" },
    storage: {
      get: async <T>(key: string) => data.get(key) as T | undefined,
      put: async (key: string | Record<string, unknown>, value?: unknown) => {
        if (failStoragePut) throw new Error("storage unavailable");
        if (typeof key === "string") data.set(key, value);
        else for (const [k, v] of Object.entries(key)) data.set(k, v);
      },
      delete: async (key: string) => { data.delete(key); },
      deleteAlarm: async () => undefined,
      setAlarm: async (_at: number | Date) => undefined,
    },
    getWebSockets: () => [],
    waitUntil: (_promise: Promise<unknown>) => undefined,
    blockConcurrencyWhile: <T>(fn: () => Promise<T>): Promise<T> => {
      const run = lock.then(fn, fn);
      lock = run.then(() => undefined, () => undefined);
      return run;
    },
  };
  return { room: new CallRoom(state as any, {} as any), data };
}

describe("CallRoom real credential classifier", () => {
  it("accepts reconnect credentials after the ring deadline", async () => {
    const now = Date.now();
    const { room } = fakeRoom({
      room_token_caller: "caller-token",
      room_token_callee: "callee-token",
      token_expires_at: now - 1, // ring/native action lease is already over
      room_token_expires_at: now + 60_000,
    });
    await expect((room as any).classifyRoomToken("caller-token"))
      .resolves.toEqual({ ok: true, side: "caller" });
  });

  it("rejects a credential after its independent room expiry", async () => {
    const { room } = fakeRoom({
      room_token_caller: "caller-token",
      room_token_callee: "callee-token",
      room_token_expires_at: Date.now() - 1,
    });
    await expect((room as any).classifyRoomToken("caller-token"))
      .resolves.toEqual({ ok: false, reason: "expired" });
  });
});

describe("CallRoom real receptionist ownership storage", () => {
  it("persists one winner across object re-instantiation", async () => {
    const first = fakeRoom();
    await expect((first.room as any).claimReceptionistSession("sid-a"))
      .resolves.toEqual({ already: false, sid: "sid-a" });

    const second = fakeRoom(Object.fromEntries(first.data));
    await expect((second.room as any).claimReceptionistSession("sid-b"))
      .resolves.toEqual({ already: true, sid: "sid-a" });
  });
});

describe("CallRoom SFU pre-accept media gate", () => {
  const seat = {
    uid: "callee",
    session_id: "callee-session",
    audio_track: "callee-audio",
    video_track: null,
    transport_prepared: true,
    preaccept_media_ready: true,
    updated_at: Date.now(),
  };
  const callerSeat = {
    uid: "caller",
    session_id: "caller-session",
    audio_track: "caller-audio",
    video_track: null,
    updated_at: Date.now(),
  };

  it("hides a callee publication from the caller until the FSM accepts", async () => {
    const ringing = {
      call_id: "avatok-test",
      caller_uid: "caller",
      callee_uid: "callee",
      epoch: 1,
      transition_sequence: 1,
      session_state: "ringing",
      caller_leg_state: "ringing",
      callee_leg_state: "ringing",
      service_leg_state: "none",
      disposition: "none",
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    const { room } = fakeRoom({ fsm: ringing, sfuSeats: { caller: callerSeat, callee: seat } });
    const response = await room.fetch(new Request("https://call/sfu-peer?callId=avatok-test&uid=caller"));
    const body = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body.seat).toBeNull();
    expect(body.media_access).toBe("blocked_callee_not_accepted");
  });

  it("keeps caller prepublish visible to the callee before Accept", async () => {
    const ringing = {
      call_id: "avatok-test",
      caller_uid: "caller",
      callee_uid: "callee",
      epoch: 1,
      transition_sequence: 1,
      session_state: "ringing",
      caller_leg_state: "ringing",
      callee_leg_state: "ringing",
      service_leg_state: "none",
      disposition: "none",
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    const { room } = fakeRoom({ fsm: ringing, sfuSeats: { caller: callerSeat, callee: seat } });
    const response = await room.fetch(new Request("https://call/sfu-peer?callId=avatok-test&uid=callee"));
    const body = await response.json() as Record<string, any>;
    expect(response.status).toBe(200);
    expect(body.media_access).toBe("released");
    expect(body.seat.session_id).toBe("caller-session");
  });

  it("releases the callee seat only after the authoritative FSM state", async () => {
    const accepted = {
      call_id: "avatok-test",
      caller_uid: "caller",
      callee_uid: "callee",
      epoch: 1,
      transition_sequence: 2,
      session_state: "connected",
      caller_leg_state: "connected_to_callee",
      callee_leg_state: "accepted",
      service_leg_state: "none",
      disposition: "answered_by_callee",
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    const { room } = fakeRoom({ fsm: accepted, sfuSeats: { caller: callerSeat, callee: seat } });
    const response = await room.fetch(new Request("https://call/sfu-peer?callId=avatok-test&uid=caller"));
    const body = await response.json() as Record<string, any>;
    expect(body.media_access).toBe("released");
    expect(body.seat.session_id).toBe("callee-session");
  });

  it("rejects a tagged prewarm seat after another device wins Accept", async () => {
    const accepted = {
      call_id: "avatok-test",
      caller_uid: "caller",
      callee_uid: "callee",
      epoch: 1,
      transition_sequence: 2,
      session_state: "connected",
      caller_leg_state: "connected_to_callee",
      callee_leg_state: "accepted",
      service_leg_state: "none",
      disposition: "answered_by_callee",
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    const { room } = fakeRoom({
      fsm: accepted,
      answeredAt: Date.now(),
      acceptedDeviceId: "winner-device",
      silent_prewarm: {
        nonce: "nonce-1234567890123456",
        generation: 1,
        deadline_ms: Date.now() + 10_000,
        phase: "terminal",
        ring_started_at: Date.now(),
        device_id: "winner-device",
        transport_session_id: "winner-session",
        invite: {},
      },
    });
    const response = await room.fetch(new Request("https://call/sfu-seat", {
      method: "POST",
      body: JSON.stringify({
        callId: "avatok-test",
        uid: "callee",
        sessionId: "loser-session",
        deviceId: "loser-device",
        prewarmNonce: "nonce-1234567890123456",
        prewarmGeneration: 1,
      }),
    }));
    const body = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(409);
    expect(body.error).toBe("accepted_elsewhere");
  });

  it("does not let a second device replace the lease after first prewarm-ready", async () => {
    const ringing = {
      call_id: "avatok-test",
      caller_uid: "caller",
      callee_uid: "callee",
      epoch: 1,
      transition_sequence: 1,
      session_state: "ringing",
      caller_leg_state: "ringing",
      callee_leg_state: "ringing",
      service_leg_state: "none",
      disposition: "none",
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    const { room } = fakeRoom({
      fsm: ringing,
      silent_prewarm: {
        nonce: "nonce-1234567890123456",
        generation: 1,
        deadline_ms: Date.now() + 10_000,
        phase: "ringing",
        ring_started_at: Date.now(),
        device_id: "winner-device",
        transport_session_id: "winner-session",
        invite: {},
      },
      sfuSeats: {
        callee: {
          ...seat,
          session_id: "winner-session",
          device_id: "winner-device",
          prewarm_nonce: "nonce-1234567890123456",
          prewarm_generation: 1,
        },
      },
    });
    const response = await room.fetch(new Request("https://call/sfu-seat", {
      method: "POST",
      body: JSON.stringify({
        callId: "avatok-test",
        uid: "callee",
        sessionId: "loser-session",
        deviceId: "loser-device",
        prewarmNonce: "nonce-1234567890123456",
        prewarmGeneration: 1,
      }),
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "stale_prewarm" });
    const self = await room.fetch(new Request("https://call/sfu-seat-self?callId=avatok-test&uid=callee"));
    await expect(self.json()).resolves.toMatchObject({ seat: { session_id: "winner-session", device_id: "winner-device" } });
  });

  it("authorizes preaccept publish from the live bound lease", async () => {
    const ringing = {
      call_id: "avatok-test",
      caller_uid: "caller",
      callee_uid: "callee",
      epoch: 1,
      transition_sequence: 1,
      session_state: "ringing",
      caller_leg_state: "ringing",
      callee_leg_state: "ringing",
      service_leg_state: "none",
      disposition: "none",
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    const { room } = fakeRoom({
      fsm: ringing,
      silent_prewarm: {
        nonce: "nonce-1234567890123456",
        generation: 1,
        deadline_ms: Date.now() + 10_000,
        phase: "ringing",
        ring_started_at: Date.now(),
        device_id: "winner-device",
        transport_session_id: "winner-session",
        invite: {},
      },
      sfuSeats: {
        callee: {
          ...seat,
          session_id: "winner-session",
          device_id: "winner-device",
          prewarm_nonce: "nonce-1234567890123456",
          prewarm_generation: 1,
        },
      },
    });
    const response = await room.fetch(new Request("https://call/sfu-preaccept-authorize", {
      method: "POST",
      body: JSON.stringify({
        callId: "avatok-test",
        uid: "callee",
        sessionId: "winner-session",
        deviceId: "winner-device",
        prewarmNonce: "nonce-1234567890123456",
        prewarmGeneration: 1,
      }),
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, session_id: "winner-session" });

    const stale = await room.fetch(new Request("https://call/sfu-preaccept-authorize", {
      method: "POST",
      body: JSON.stringify({
        callId: "avatok-test",
        uid: "callee",
        sessionId: "other-session",
        deviceId: "other-device",
        prewarmNonce: "nonce-1234567890123456",
        prewarmGeneration: 1,
      }),
    }));
    expect(stale.status).toBe(409);
  });

  it("accepts prewarm-ready when the provider-written media marker is present", async () => {
    const ringing = {
      call_id: "avatok-test",
      caller_uid: "caller",
      callee_uid: "callee",
      epoch: 1,
      transition_sequence: 1,
      session_state: "ringing",
      caller_leg_state: "ringing",
      callee_leg_state: "not_started",
      service_leg_state: "none",
      disposition: "none",
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    const { room } = fakeRoom({
      fsm: ringing,
      silent_prewarm: {
        nonce: "nonce-1234567890123456",
        generation: 1,
        deadline_ms: Date.now() + 10_000,
        phase: "prewarming",
        ring_started_at: null,
        device_id: null,
        transport_session_id: null,
        invite: {},
      },
    });
    const marker = await room.fetch(new Request("https://call/sfu-seat", {
      method: "POST",
      body: JSON.stringify({
        callId: "avatok-test",
        uid: "callee",
        sessionId: "callee-session",
        deviceId: "device-a",
        prewarmNonce: "nonce-1234567890123456",
        prewarmGeneration: 1,
        audioTrack: "silent-audio",
        preacceptMedia: true,
      }),
    }));
    expect(marker.status).toBe(200);
    await expect(marker.json()).resolves.toMatchObject({
      ok: true,
      preaccept_media_ready: true,
      seat: { transport_prepared: true },
    });
    const response = await room.fetch(new Request("https://call/prewarm-ready", {
      method: "POST",
      body: JSON.stringify({
        callId: "avatok-test",
        nonce: "nonce-1234567890123456",
        generation: 1,
        deviceId: "device-a",
        sessionId: "callee-session",
        authenticatedUid: "callee",
        mediaReadyRequired: true,
      }),
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it("fails closed when the provider-written media marker cannot be persisted", async () => {
    const ringing = {
      call_id: "avatok-test",
      caller_uid: "caller",
      callee_uid: "callee",
      epoch: 1,
      transition_sequence: 1,
      session_state: "ringing",
      caller_leg_state: "ringing",
      callee_leg_state: "not_started",
      service_leg_state: "none",
      disposition: "none",
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    const { room } = fakeRoom({
      __failStoragePut: true,
      fsm: ringing,
      silent_prewarm: {
        nonce: "nonce-1234567890123456",
        generation: 1,
        deadline_ms: Date.now() + 10_000,
        phase: "prewarming",
        ring_started_at: null,
        device_id: null,
        transport_session_id: null,
        invite: {},
      },
    });
    const response = await room.fetch(new Request("https://call/sfu-seat", {
      method: "POST",
      body: JSON.stringify({
        callId: "avatok-test",
        uid: "callee",
        sessionId: "callee-session",
        deviceId: "device-a",
        prewarmNonce: "nonce-1234567890123456",
        prewarmGeneration: 1,
        audioTrack: "silent-audio",
        preacceptMedia: true,
      }),
    }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "media_marker_persist_failed" });
  });

  it("does not declare a media-required prewarm ready without the server marker", async () => {
    const ringing = {
      call_id: "avatok-test",
      caller_uid: "caller",
      callee_uid: "callee",
      epoch: 1,
      transition_sequence: 1,
      session_state: "ringing",
      caller_leg_state: "ringing",
      callee_leg_state: "ringing",
      service_leg_state: "none",
      disposition: "none",
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    const { room } = fakeRoom({
      fsm: ringing,
      silent_prewarm: {
        nonce: "nonce-1234567890123456",
        generation: 1,
        deadline_ms: Date.now() + 10_000,
        phase: "prewarming",
        ring_started_at: null,
        device_id: "device-a",
        transport_session_id: "callee-session",
        invite: {},
      },
      sfuSeats: {
        callee: { ...seat, preaccept_media_ready: false, device_id: "device-a", prewarm_nonce: "nonce-1234567890123456", prewarm_generation: 1 },
      },
    });
    const response = await room.fetch(new Request("https://call/prewarm-ready", {
      method: "POST",
      body: JSON.stringify({
        callId: "avatok-test",
        nonce: "nonce-1234567890123456",
        generation: 1,
        deviceId: "device-a",
        sessionId: "callee-session",
        authenticatedUid: "callee",
        mediaReadyRequired: true,
      }),
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "stale_prewarm" });
  });
});
