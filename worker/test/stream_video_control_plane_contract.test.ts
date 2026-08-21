import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { selectCallProvider, streamCallCancel } from "../src/routes/stream_video_calls";

describe("GetStream Video pilot control plane contract", () => {
  const route = readFileSync("src/routes/stream_video_calls.ts", "utf8");
  const api = readFileSync("src/routes/api.ts", "utf8");
  const config = readFileSync("src/routes/config.ts", "utf8");
  const index = readFileSync("src/index.ts", "utf8");
  const migration = readFileSync("migrations/2026-08-19-stream-video-webhooks.sql", "utf8");

  it("ships dark and keeps a separate route from Cloudflare Stream Live", () => {
    expect(config).toContain("streamCallPilotEnabled: false");
    expect(config).toContain("streamCallPilotPercent: 0");
    expect(config).toContain('"streamCallPilotPercent"');
    expect(index).toContain('"/webhooks/stream"');
    expect(index).toContain('"/webhooks/stream-video"');
    expect(route).toContain('return json({ error: "stream video pilot disabled" }, 404)');
  });

  it("allows production, keeps staging allowlisted, stays audio-only, and uses server auth", () => {
    expect(route).toContain('env.ENVIRONMENT_NAME === "prod"');
    expect(route).toContain('env.ENVIRONMENT_NAME !== "staging"');
    expect(route).toContain('env.ENVIRONMENT_NAME !== "staging" && env.ENVIRONMENT_NAME !== "prod"');
    expect(route).toContain("STREAM_VIDEO_PILOT_UIDS");
    expect(route).toContain('(args.media ?? "audio") === "audio"');
    expect(route).toContain("server: true");
    expect(route).toContain("Authorization: serverToken");
    expect(route).toContain("ensureStreamUsers");
  });

  it("never trusts caller identity from the request body", () => {
    expect(route).toContain("const auth = await requireUser(req, env)");
    expect(route).toContain("created_by_id: callerUid");
    expect(route).not.toContain("created_by_id: body.");
  });

  it("keeps server authority short-lived but supports killed-app native ringing", () => {
    expect(route).toContain("SERVER_TOKEN_TTL_SECONDS = 15 * 60");
    expect(route).toContain("BACKGROUND_USER_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60");
    expect(route).toContain("now + SERVER_TOKEN_TTL_SECONDS");
    expect(route).toContain("now + BACKGROUND_USER_TOKEN_TTL_SECONDS");
  });

  it("uses Stream's signed webhook id for D1 idempotency", () => {
    expect(route).toContain("x-webhook-id");
    expect(route).toContain("x-signature");
    expect(route).toContain("INSERT OR IGNORE INTO stream_video_webhooks");
    expect(migration).toContain("webhook_id TEXT PRIMARY KEY");
    expect(migration).toContain("stream_video_provider_decisions");
    expect(migration).toContain("call_id TEXT PRIMARY KEY");
  });

  it("keeps provider and ring/session/missed outcomes in call telemetry", () => {
    expect(route).toContain("rtc_provider: PROVIDER");
    expect(route).toContain('case "call.ring"');
    expect(route).toContain('case "call.missed"');
    expect(route).toContain('case "call.session_started"');
    expect(route).toContain('case "call.session_ended"');
  });

  it("selects Stream only for staging allowlist members and a positive rollout", () => {
    const env = {
      ENVIRONMENT_NAME: "staging",
      STREAM_VIDEO_API_KEY: "key",
      STREAM_VIDEO_API_SECRET: "secret",
      STREAM_VIDEO_PILOT_UIDS: "caller,callee",
    } as any;
    const stream = selectCallProvider({
      env,
      config: { streamCallPilotEnabled: true, streamCallPilotPercent: 100 },
      callerUid: "caller",
      calleeUid: "callee",
      callId: "call-sticky-1",
      clientSupportsStream: true,
    });
    expect(stream.provider).toBe("stream");
    expect(stream.allowlisted).toBe(true);

    const disabled = selectCallProvider({
      env,
      config: { streamCallPilotEnabled: true, streamCallPilotPercent: 0 },
      callerUid: "caller",
      calleeUid: "callee",
      callId: "call-sticky-1",
      clientSupportsStream: true,
    });
    expect(disabled.provider).toBe("cloudflare");

    const outsideAllowlist = selectCallProvider({
      env,
      config: { streamCallPilotEnabled: true, streamCallPilotPercent: 100 },
      callerUid: "caller",
      calleeUid: "other",
      callId: "call-sticky-1",
      clientSupportsStream: true,
    });
    expect(outsideAllowlist.provider).toBe("cloudflare");
  });

  it("selects production audio for capable clients but never selects video", () => {
    const env = {
      ENVIRONMENT_NAME: "prod",
      STREAM_VIDEO_API_KEY: "key",
      STREAM_VIDEO_API_SECRET: "secret",
    } as any;
    const base = {
      env,
      config: { streamCallPilotEnabled: true, streamCallPilotPercent: 100 },
      callerUid: "caller",
      calleeUid: "callee",
      callId: "production-audio-call",
      clientSupportsStream: true,
    };
    expect(selectCallProvider({ ...base, media: "audio" }).provider).toBe("stream");
    expect(selectCallProvider({ ...base, media: "video" }).provider).toBe("cloudflare");
  });

  it("keeps one call sticky while a rollout flag is read again", () => {
    const env = {
      ENVIRONMENT_NAME: "staging",
      STREAM_VIDEO_API_KEY: "key",
      STREAM_VIDEO_API_SECRET: "secret",
      STREAM_VIDEO_PILOT_UIDS: "caller,callee",
    } as any;
    const first = selectCallProvider({
      env,
      config: { streamCallPilotEnabled: true, streamCallPilotPercent: 50 },
      callerUid: "caller",
      calleeUid: "callee",
      callId: "same-call-id",
      clientSupportsStream: true,
    });
    const retry = selectCallProvider({
      env,
      config: { streamCallPilotEnabled: true, streamCallPilotPercent: 50 },
      callerUid: "caller",
      calleeUid: "callee",
      callId: "same-call-id",
      clientSupportsStream: true,
    });
    expect(retry).toEqual(first);
  });

  it("does not alter the Cloudflare provider when the pilot is off", () => {
    const env = {
      ENVIRONMENT_NAME: "staging",
      STREAM_VIDEO_API_KEY: "key",
      STREAM_VIDEO_API_SECRET: "secret",
      STREAM_VIDEO_PILOT_UIDS: "caller,callee",
    } as any;
    expect(selectCallProvider({
      env,
      config: { streamCallPilotEnabled: false, streamCallPilotPercent: 100 },
      callerUid: "caller",
      calleeUid: "callee",
      callId: "rollback-call",
      clientSupportsStream: true,
    }).provider).toBe("cloudflare");
  });

  it("keeps old clients and group calls on Cloudflare", () => {
    const env = {
      ENVIRONMENT_NAME: "staging",
      STREAM_VIDEO_API_KEY: "key",
      STREAM_VIDEO_API_SECRET: "secret",
      STREAM_VIDEO_PILOT_UIDS: "caller,callee",
    } as any;
    const base = {
      env,
      config: { streamCallPilotEnabled: true, streamCallPilotPercent: 100 },
      callerUid: "caller",
      calleeUid: "callee",
      callId: "capability-call",
    };
    expect(selectCallProvider(base).provider).toBe("cloudflare");
    expect(selectCallProvider({ ...base, scope: "group", clientSupportsStream: true }).provider)
      .toBe("cloudflare");
    expect(route).toContain("stream_capable");
    expect(route).toContain("stream_video_provider_decisions");
    expect(route).toContain("persistStickyProvider");
    // The preparation wrapper must forward media into the selector. Omitting
    // it silently applies selectCallProvider's audio default to video calls.
    expect(route).toContain("media: args.media");
  });

  it("branches the existing /api/call before any Cloudflare ring side effect", () => {
    const providerBranch = api.indexOf("prepareStreamCall({");
    const routingDecision = api.indexOf('if (routingResult && routingResult.action !== "ring")');
    const ringToken = api.indexOf("const ringReceiptToken", providerBranch);
    expect(providerBranch).toBeGreaterThan(-1);
    expect(providerBranch).toBeGreaterThan(routingDecision);
    expect(providerBranch).toBeLessThan(ringToken);
    expect(api).toContain("b.stream_capable === true");
    expect(api).toContain("admissionAlreadyGranted: true");
  });

  it("bounds provider ringing and compensates every timeout or cancellation", () => {
    const admission = route.indexOf("const admission = await admitCall");
    const authority = route.indexOf("const recorded = await persistStickyProvider", admission);
    const streamCreate = route.indexOf("const created = await createRingingStreamCall", authority);
    expect(admission).toBeGreaterThan(-1);
    expect(authority).toBeGreaterThan(admission);
    expect(streamCreate).toBeGreaterThan(authority);
    expect(route).toContain("STREAM_PLACE_TOTAL_DEADLINE_MS = 7_500");
    expect(route).toContain("deadlineAt: requestStartedAt + STREAM_PLACE_TOTAL_DEADLINE_MS");
    expect(route).toContain("new AbortController()");
    expect(route).toContain('created.stage === "provider_timeout"');
    expect(route).toContain("await endStreamCall(env, callId)");
  });

  it("supports cancelling an attempt before place returns its server call id", () => {
    expect(streamCallCancel).toBeTypeOf("function");
    expect(route).toContain("stream-place:active:");
    expect(route).toContain("stream-place:cancel:");
    expect(route).toContain('return json({ cancelled: true, call_id: callId })');
    expect(route).toContain('"call_cancelled"');
  });

  it("emits stage latency for fast-call production diagnosis", () => {
    expect(route).toContain("auth_and_admission_ms");
    expect(route).toContain("stream_users_ms");
    expect(route).toContain("stream_create_ms");
    expect(route).toContain("stream_provider_total_ms");
    expect(route).toContain("place_total_ms");
  });
});
