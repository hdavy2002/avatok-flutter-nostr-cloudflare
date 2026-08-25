import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOM = readFileSync("src/do/call_room.ts", "utf8");
const BILLING_DO = readFileSync("src/do/messenger_call_billing.ts", "utf8");
const SFU = readFileSync("src/routes/call_sfu.ts", "utf8");
const API = readFileSync("src/routes/api.ts", "utf8");
const FLUTTER_SESSION = readFileSync("../app/lib/core/calls/call_session.dart", "utf8");

function method(source: string, signature: string, endMarker: string): string {
  const start = source.indexOf(signature);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end <= start) throw new Error("method boundary not found: " + signature);
  return source.slice(start, end);
}

function executable(source: string): string {
  return source
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("Cloudflare Messenger media-attestation boundary", () => {
  it("requires two authenticated current-generation media attestations before opening a billable interval", () => {
    // Two signalling sockets are not media proof. The Cloudflare lane must
    // persist an explicit provider/media attestation for each authenticated
    // caller/callee seat, bound to the same current generation, before it can
    // call the provider-neutral billing adapter.
    expect(ROOM).toMatch(/media[-_]attest|attest[-_]media|recordMediaConnected/);
    expect(ROOM).toMatch(/authenticated(?:_side|Side|[ -]participant)|caller_uid/);
    expect(ROOM).toMatch(/callee_uid/);
    expect(ROOM).toMatch(/currentGen|generation/);
    expect(ROOM).toMatch(/both.*(?:media|attest)|(?:media|attest).*both/i);
    expect(ROOM).toMatch(/consumeMessengerCallUsage|messengerCallUsageTick/);
  });

  it("rejects a media attestation with a stale nonce, replayed event, spoofed uid, or old generation", () => {
    const marker = ROOM.match(/(?:media[-_]attest|attest[-_]media|recordMediaConnected)/i);
    expect(marker, "a concrete media-attestation handler is required").not.toBeNull();
    const start = marker?.index ?? -1;
    const handler = ROOM.slice(start, start + 3200);
    for (const required of ["nonce", "generation", "event_id", "uid", "replay"]) {
      expect(handler, required + " attestation guard").toContain(required);
    }
    expect(handler).toMatch(/uid[^\n]*(?:caller_uid|callee_uid)|(?:caller_uid|callee_uid)[^\n]*uid/);
    expect(handler).toMatch(/stale|mismatch|invalid|already|duplicate/i);
    expect(handler).toMatch(/currentGen|generation/);
  });

  it("admits Cloudflare media only after the exact Messenger authorization, never by signaling identity", () => {
    const join = executable(method(SFU, "export async function callSfuJoin", "export async function callSfuPrepare"));
    // Provider minting must not accept billing identity or price terms from the
    // request body. The separate admission test below checks the server-owned
    // authorization lookup itself (after stripping comments).
    expect(join).not.toMatch(/body\.(?:callId|call_id|provider|payer_uid|rate|quality)/);
  });

  it("does not let a direct Cloudflare SFU join bypass Messenger D1 authorization", () => {
    const join = method(SFU, "export async function callSfuJoin", "export async function callSfuPrepare");
    const providerMint = join.indexOf('sfu(env, "/sessions/new"');
    expect(providerMint).toBeGreaterThan(0);
    const admission = executable(join.slice(0, providerMint));

    // Comments describing admission through /api/call are not an enforcement
    // boundary. The provider route must either load the immutable authorization
    // itself or require an equivalent server-issued authorization context before
    // minting a provider session. Otherwise a direct join can bypass pricing and
    // payer checks.
    expect(admission).toMatch(/loadMessengerCallAuthorization|messenger_call_authorizations/);
    expect(admission).toMatch(/status[^\n]*authorized|authorized[^\n]*status/);
    expect(admission).toMatch(/provider[^\n]*cloudflare|cloudflare[^\n]*provider/i);
    expect(admission).toMatch(/authorization_id|call_id/);
  });

  it("detects the actual audio-vs-video gate used by the SFU authorization branch", () => {
    const join = executable(method(SFU, "export async function callSfuJoin", "export async function callSfuPrepare"));
    const authStart = join.indexOf("let messengerAudioAuthorization");
    const authEnd = join.indexOf("const prewarm =", authStart);
    expect(authStart).toBeGreaterThanOrEqual(0);
    expect(authEnd).toBeGreaterThan(authStart);
    const authBranch = join.slice(authStart, authEnd);

    // `g.video` means the SFU is capable of video, not that this call is
    // actually video. Messenger audio carries the billing identifiers in the
    // request; gating on `!g.video` would skip D1 validation whenever the SFU
    // supports video and would reopen the unmetered audio path.
    expect(authBranch).not.toContain("messengerCallBillingEnabled === true && !g.video");
    expect(authBranch).toContain("if (cfg.messengerCallBillingEnabled === true)");
    expect(authBranch).not.toContain("g.video");
    expect(authBranch).toMatch(/authorizationId|body\.authorization_id/);
  });

  it("rejects media evidence after the durable terminal marker, not only after ended=true", () => {
    const start = ROOM.indexOf('if (data.type === "media_established" || data.type === "media_lost" || data.type === "media_heartbeat")');
    const end = ROOM.indexOf("    data.from = this.state.getTags(ws)[0];", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const mediaBranch = ROOM.slice(start, end);

    // markTerminal intentionally precedes markEnded on several command paths;
    // checking only the legacy ended bit leaves a short terminal window in which
    // a valid client challenge can reopen evidence/billing.
    expect(mediaBranch).toMatch(/terminalStatus|session_state/);
  });

  it("keeps the free-prefix receipt wall time consistent when paid suffix is denied", () => {
    const partialStart = BILLING_DO.indexOf("private async persistDeniedFreeTick");
    const partialEnd = BILLING_DO.indexOf("  private async drainPendingTicks", partialStart);
    expect(partialStart).toBeGreaterThanOrEqual(0);
    expect(partialEnd).toBeGreaterThan(partialStart);
    const partial = BILLING_DO.slice(partialStart, partialEnd);

    // The receipt schema requires participant_seconds = connected_wall_seconds
    // * 2. A boundary tick must therefore persist the accepted free prefix's
    // wall time, not the entire interval that included denied paid seconds.
    expect(partial).toMatch(/free_(?:wall_seconds|participant_seconds)|freeSeconds/);
    expect(partial).not.toContain("Math.floor((end - start) / 1000)");
  });

  it("does not let heartbeat, ringing, one-sided media, or reconnect presence reopen a paid interval", () => {
    const heartbeat = method(SFU, "export async function callSfuHeartbeat", "export async function callSfuPull");
    const close = method(ROOM, "private async beginAwayOrEnd", "  /** Single alarm");
    const alarmStart = ROOM.indexOf("async alarm(): Promise<void>");
    expect(alarmStart).toBeGreaterThanOrEqual(0);
    const alarm = ROOM.slice(alarmStart);

    expect(heartbeat).not.toMatch(/consumeMessengerCallUsage|messengerCallUsageTick/);
    expect(close).toContain("stopHumanCallSide");
    expect(close).toMatch(/reconnect|away|gap/i);
    expect(ROOM).toMatch(/active_since\[[^\]]+\]\s*=\s*undefined/);
    expect(alarm).toMatch(/both.*(?:attest|media)|media.*both/i);
    expect(alarm).not.toMatch(/liveSeatCount\(\)\s*[>=]+\s*2[\s\S]{0,240}billHumanCallUsage/);
  });

  it("never resurrects billing after a terminal call state", () => {
    const start = method(ROOM, "private async ensureHumanCallUsageStarted", "  /** Bill one 1:1 seat");
    const join = ROOM.slice(ROOM.indexOf("if (otherIds.length > 0)"), ROOM.indexOf("async webSocketMessage"));
    expect(start).toMatch(/session\.session_state\s*!==\s*["'](?:completed|handoff|ended)["']/);
    expect(start).toMatch(/terminal|ended|completed/i);
    expect(join).toMatch(/session_state|humanRoomAcceptsNewPeer/);
    expect(join).toMatch(/terminal|completed|ended/i);
  });

  it("keeps the existing Cloudflare signaling behavior when Messenger billing is dark", () => {
    const callStart = API.indexOf("export async function call(");
    const callEnd = API.indexOf("export async function callNativeDecline", callStart);
    const route = API.slice(callStart, callEnd);
    expect(route).toContain("messengerCallBillingEnabled");
    expect(route).toContain("callStub.fetch(\"https://call-room/participants\"");
    expect(route).toContain("Q_PUSH");
    expect(route).toMatch(/messengerCallBillingEnabled[^\n]*(?:false|legacy|disabled)|if\s*\([^)]*messengerCallBillingEnabled/);
  });

  it("does not send a pre-playout Flutter media attestation", () => {
    // Flutter may display connecting/ringing and can start transport setup, but
    // it must not be the financial authority. If a client-side attestation is
    // retained as evidence, it is emitted only after first decoded playout and
    // remains bound to the server challenge/current attempt.
    expect(FLUTTER_SESSION).toContain("type': 'media_established'");
    expect(FLUTTER_SESSION).toContain("_billingPlayoutConfirmed");
    const start = FLUTTER_SESSION.indexOf("void _markAudibleReady({");
    const end = FLUTTER_SESSION.indexOf("    _audibleSafetyTimer?.cancel();", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const audibleGate = FLUTTER_SESSION.slice(start, end);
    expect(audibleGate).toMatch(
      /evidence == 'playout'[\s\S]*_billingPlayoutConfirmed = true[\s\S]*_emitBillingMediaEstablished/,
    );
    expect(audibleGate).not.toMatch(/evidence === 'rtk_track'|evidence === 'timeout'|evidence === 'flag_off'/);
    expect(audibleGate).toMatch(/nonce|attempt|authorization/i);
  });
});
