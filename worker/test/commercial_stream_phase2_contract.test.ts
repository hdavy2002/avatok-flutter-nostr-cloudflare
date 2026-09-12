import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  commercialJoinEnabled,
  commercialProviderIdentity,
} from "../src/lib/commercial_stream_sessions";

const root = resolve(import.meta.dirname, "..");
const migration = readFileSync(
  resolve(root, "migrations/2026-08-24-commercial-stream-sessions.sql"),
  "utf8",
);
const extensionMigration = readFileSync(
  resolve(root, "migrations/2026-08-25-commercial-consult-extensions.sql"),
  "utf8",
);
const config = readFileSync(resolve(root, "src/routes/config.ts"), "utf8");
const routes = readFileSync(
  resolve(root, "src/routes/commercial_stream_sessions.ts"),
  "utf8",
);
const router = readFileSync(resolve(root, "src/index.ts"), "utf8");
const streamWebhook = readFileSync(
  resolve(root, "src/routes/stream_video_calls.ts"),
  "utf8",
);
const settlement = readFileSync(
  resolve(root, "src/commercial_settlement.ts"),
  "utf8",
);
const listings = readFileSync(resolve(root, "src/routes/listings.ts"), "utf8");
const lifecycle = readFileSync(resolve(root, "src/routes/commercial_lifecycle.ts"), "utf8");
const reviews = readFileSync(resolve(root, "src/routes/reviews.ts"), "utf8");

describe("Phase 2 commercial lane contracts", () => {
  it("is account-entitled and GetStream-only", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS commercial_entitlements");
    expect(migration).toContain("account_id     TEXT NOT NULL");
    expect(migration).toContain("CHECK (provider = 'getstream')");
    expect(migration).toContain("avatok_livestream");
    expect(migration).toContain("avatok_consult_1to1");
    expect(migration).not.toContain("cloudflare'");
  });

  it("stores immutable commercial policy and provider evidence", () => {
    expect(migration).toContain("commercial_policy_snapshots");
    expect(migration).toContain("creator_fee_pct");
    expect(migration).toContain("platform_fee_amount");
    expect(migration).toContain("commercial_provider_events");
    expect(migration).toContain("payload_sha256");
    expect(migration).toContain("commercial_participant_intervals");
  });

  it("bounds creator policy fields before listing storage", () => {
    expect(listings).toContain("function commercialPolicyError");
    expect(listings).toContain("COMMERCIAL_REFUND_WINDOWS");
    expect(listings).toContain("COMMERCIAL_BOOKING_NOTICE_HOURS");
    expect(listings).toContain("unsupported commercial policy field");
    expect(listings).toContain('attrs.commercial_no_show_policy !== "session_charged"');
    expect(listings).toContain("commercialPolicyError(kind, b.attrs)");
    expect(listings).toContain("commercialPolicyError(String(row.kind), b.attrs)");
  });

  it("ships all commercial activation controls dark", () => {
    for (const key of [
      "commercialLiveListingsEnabled",
      "commercialLiveCheckoutEnabled",
      "commercialLiveJoinEnabled",
      "commercialConsultListingsEnabled",
      "commercialConsultCheckoutEnabled",
      "commercialConsultJoinEnabled",
    ]) {
      expect(config).toContain(`${key}: false`);
    }
  });

  it("keeps commercial controls independent from Messenger pricing", () => {
    const commercialBlock = config.slice(
      config.indexOf("commercialLiveListingsEnabled: false"),
      config.indexOf("commercialRecordingEnabled: false") + 40,
    );
    expect(commercialBlock).not.toContain("messenger");
    expect(commercialBlock).not.toContain("qualitySku");
  });

  it("derives provider identity only from server authority IDs", () => {
    expect(commercialProviderIdentity({
      kind: "live_event",
      listingId: "listing-1",
      sessionVersion: 2,
    })).toEqual({
      provider: "getstream",
      callType: "avatok_livestream",
      callId: "live_listing-1_2",
    });
    expect(commercialProviderIdentity({
      kind: "consult_1to1",
      listingId: "listing-1",
      bookingId: "booking-9",
    })).toEqual({
      provider: "getstream",
      callType: "avatok_consult_1to1",
      callId: "consult_booking-9",
    });
    expect(() => commercialProviderIdentity({
      kind: "live_event",
      listingId: "client:chosen/cid",
    })).toThrow();
  });

  it("has lane-specific fail-closed join gates", () => {
    expect(commercialJoinEnabled("live_event", {})).toBe(false);
    expect(commercialJoinEnabled("consult_1to1", {})).toBe(false);
    expect(commercialJoinEnabled("live_event", {
      commercialLiveJoinEnabled: true,
    })).toBe(true);
    expect(commercialJoinEnabled("consult_1to1", {
      commercialLiveJoinEnabled: true,
    })).toBe(false);
  });

  it("mounts authenticated commercial joins without using public links as tickets", () => {
    expect(router).toContain("commercialLiveJoin");
    expect(router).toContain('req.method === "POST"');
    expect(router).not.toContain('commercial/live/[A-Za-z0-9-]{1,64}\\/join$/.test(p) && req.method === "GET"');
    expect(router).toContain("commercialConsultPrejoin");
    expect(router).toContain("commercialConsultJoin");
    expect(routes).toContain("requireUser(req, env)");
    expect(routes).toContain("commercial_entitlements");
    expect(routes).toContain('return json({ error: "ticket required" }, 403)');
    expect(routes).not.toContain("share_token");
    expect(routes).not.toContain("url.searchParams.get(\"token\")");
    expect(routes).toContain("Cache-Control");
    expect(routes).toContain("noStoreJoinResponse");
    expect(routes).toContain("Pragma");
  });

  it("adds only the entitled account as a server-owned GetStream member", () => {
    expect(routes).toContain('providerUrl(args.env, args.callType, args.callId, "/members")');
    expect(routes).toContain("update_members: [{ user_id: args.uid }]");
    expect(routes).toContain("commercial membership authority mismatch");
    expect(routes).toContain("persistedSession");
    expect(routes).toContain("commercial session authority mismatch");
    expect(routes).toContain("hostGrant");
    expect(routes).toContain("commercial entitlement authority mismatch");
    expect(routes).toContain("entitlement_role_mismatch");
    expect(routes).toContain("commercialChatChannel");
    expect(routes).toContain("channel_type: \"livestream\"");
    expect(routes).toContain("delete_any");
    expect(routes).toContain("commercial-live:");
    expect(routes).toContain("commercial-consult:");
    expect(routes).toContain("streamChatBindings");
    expect(routes).toContain("STREAM_CHAT_API_KEY");
    expect(routes).toContain("commercial_channel_id");
    expect(routes).toContain("token_expires_at");
    expect(routes).not.toContain("clientCallId");
    expect(routes).not.toContain("clientRole");
  });

  it("routes signed commercial events before Messenger billing", () => {
    const commercialAt = streamWebhook.indexOf("recordCommercialStreamEvent(env");
    const messengerAt = streamWebhook.indexOf("forwardMessengerStreamEventByCall(env");
    expect(commercialAt).toBeGreaterThan(0);
    expect(messengerAt).toBeGreaterThan(commercialAt);
    expect(routes).toContain("payload_sha256");
    expect(routes).toContain("commercial_participant_intervals");
    expect(routes).toContain("commercial provider event replay mismatch");
    expect(routes).toContain("commercial provider event authority mismatch");
    expect(routes).toContain("persistedInterval");
    expect(routes).toContain("interval authority mismatch");
    expect(routes).toContain("settlement job authority mismatch");
  });

  it("consumes paid entitlements only from authoritative session end and requires that state for reviews", () => {
    expect(routes).toContain("consumeCommercialEntitlementsOnSessionEnd");
    expect(routes).toContain("state='consumed'");
    expect(routes).toContain("session_ended");
    expect(routes).toContain("min_connected_ms");
    expect(routes).toContain("connected_ms");
    expect(reviews).toContain("state IN (");
    expect(reviews).toContain("ORDER BY CASE state WHEN 'consumed' THEN 0 ELSE 1 END LIMIT 1");
    expect(reviews).not.toContain("SELECT 1 FROM commercial_entitlements WHERE kind=?1 AND listing_id=?2 AND account_id=?3 LIMIT 1");
  });

  it("keeps creator controls server-authorized and idempotent", () => {
    for (const handler of [
      "commercialLivePrepareHost",
      "commercialLiveGoLive",
      "commercialLiveEnd",
      "commercialConsultEnd",
      "commercialLiveState",
      "commercialReceipt",
      "commercialRefundReceipt",
    ]) {
      expect(router).toContain(handler);
    }
    expect(routes).toContain('req.headers.get("idempotency-key")');
    expect(routes).toContain("commercial_control_operations");
    expect(routes).toContain("idempotency authority mismatch");
    expect(routes).toContain('action: args.action === "go_live" ? "go_live" : "mark_ended"');
    expect(routes).toContain("commercial reconciliation pending");
  });

  it("keeps consultation extensions server-priced, mutually confirmed and dark", () => {
    expect(extensionMigration).toContain("CREATE TABLE IF NOT EXISTS commercial_consult_extensions");
    expect(extensionMigration).toContain("extension_order_id       TEXT NOT NULL UNIQUE");
    expect(extensionMigration).toContain("base_ends_at");
    expect(extensionMigration).toContain("policy_version");
    expect(config).toContain("commercialConsultExtensionEnabled: false");
    expect(config).toContain("commercialConsultExtensionMinutes: 0");
    expect(config).toContain("commercialConsultExtensionRate: 0");
    expect(routes).toContain("commercialConsultExtensionQuote");
    expect(routes).toContain("commercialConsultExtensionConfirm");
    expect(routes).toContain("commercial:extension:hold:");
    expect(routes).toContain("extension_ends_at");
    expect(routes).toContain("rate_per_minute");
    expect(settlement).toContain("extension delivery boundary");
    expect(settlement).toContain("policy_version.endsWith(\":extension\")");
    expect(routes).toContain("creator_consented_at");
    expect(routes).toContain("buyer_consented_at");
    expect(routes).toContain("commercial_consult_extensions");
    expect(routes).toContain("extension authority changed");
    expect(routes).toContain("commercial:extension:refund:");
    expect(routes).toContain("platformAmount = Number(row.amount) - creatorAmount");
    expect(routes).toContain("extensionScheduleConflict");
    expect(routes).toContain("calendarConflict");
    expect(routes).toContain("bookingConflict");
    // The source regex escapes slashes (`\\/`); normalize that syntax before
    // asserting the actual POST-only route contract.
    const normalizedRouter = router.replaceAll("\\/", "/");
    expect(normalizedRouter).toContain(
      'commercialRoutePattern("consult", "extend/quote").test(p) && req.method === "POST"',
    );
    expect(normalizedRouter).toContain(
      'commercialRoutePattern("consult", "extend/confirm").test(p) && req.method === "POST"',
    );
  });

  it("routes no-show reports through server policy and signed evidence", () => {
    expect(lifecycle).not.toContain('body.reason === "creator_no_show"');
    expect(lifecycle).toContain("Public callers may only cancel as themselves");
    expect(lifecycle).toContain('"creator_no_show"');
    expect(lifecycle).toContain("cancellationDecision");
    expect(lifecycle).toContain("signed");
  });

  it("settles only after terminal signed-provider evidence", () => {
    expect(migration).toContain("commercial_settlement_jobs");
    expect(migration).toContain("commercial_receipts");
    expect(routes).toContain("INSERT OR IGNORE INTO commercial_settlement_jobs");
    expect(routes).toContain("terminal_event_id");
    expect(routes).not.toContain("Q_MONEY.send");
    expect(migration).toContain("UNIQUE(commercial_session_id, order_id)");
    expect(settlement).toContain("runCommercialSettlements");
    expect(settlement).toContain("commercial:release:");
    expect(settlement).toContain("funds_verified_at");
    expect(settlement).toContain("commercial receipt immutable replay mismatch");
    expect(settlement).toContain("receipt.listing_id !== authority.listing_id");
    expect(settlement).toContain("receipt.buyer_id !== authority.buyer_id");
    expect(settlement).toContain('receipt.settlement_state !== "settled"');
    expect(routes).toContain("commercial_refund_receipts");
    expect(routes).toContain("refund_receipt");
    expect(routes).toContain("SELECT 1 ok FROM commercial_refund_receipts");
  });

  it("never exposes provider credentials through state or receipts", () => {
    const safeState = routes.slice(
      routes.indexOf("function safeSessionState"),
      routes.indexOf("export async function commercialLiveState"),
    );
    expect(safeState).not.toContain("provider_call_id");
    expect(safeState).not.toContain("token");
    expect(safeState).not.toContain("STREAM_VIDEO_API_SECRET");
  });

  it("fails settlement closed without explicit policy and delivery evidence", () => {
    expect(settlement).toContain("auto_release_on_provider_end !== true");
    expect(settlement).toContain("insufficient signed host delivery evidence");
    expect(settlement).toContain("insufficient signed two-party delivery evidence");
    expect(settlement).toContain("escrow balance below immutable gross");
    expect(settlement).toContain("creator amount does not match percentage");
  });

  it("reconciliation never auto-releases money from unsigned call-state reads", () => {
    expect(routes).toContain("authenticated_reconciliation");
    expect(routes).toContain("'review_pending'");
    expect(routes).toContain("terminal state recovered without signed attendance evidence");
    expect(routes).not.toContain("releaseSnapshot");
  });
});

describe("WAITROOM-2 reviewer fixes", () => {
  const consult = readFileSync(resolve(root, "src/routes/consult.ts"), "utf8");
  const waitingRoom = readFileSync(resolve(root, "src/lib/commercial_waiting_room.ts"), "utf8");

  it("W4: only the `room` action accepts the wide commercial-booking id length", () => {
    const normalizedRouter = router.replaceAll("\\/", "/");
    expect(normalizedRouter).toContain('/^\\/api\\/consult\\/[A-Za-z0-9-]{1,96}\\/room$/'.replaceAll("\\/", "/"));
    expect(normalizedRouter).toContain("/^/api/consult/[A-Za-z0-9-]{1,64}/(join|complete|cancel|extend)$/");
    expect(consult).toContain("maxLen: 64 | 96 = 64");
    expect(consult).toContain("bid(req, 96)");
  });

  it("W4: consultJoin/Complete/Cancel/Extend refuse a commercial booking (see WAITROOM-4 / R1 for the exact detection rule)", () => {
    expect(consult).toContain("async function refuseCommercialBooking(env: Env, bk: Bk): Promise<Response | null>");
    for (const name of ["consultJoin", "consultComplete", "consultCancel", "consultExtend"]) {
      const start = consult.indexOf(`export async function ${name}(`);
      const body = consult.slice(start, start + 700);
      expect(body).toMatch(/await refuseCommercialBooking\(env, bk\)/);
    }
  });

  it("W8: rejoin recreates the provider call only on a 404 (not on an 'ending' row — see R14), and refuses 410 on a terminal ended call", () => {
    expect(routes).toContain("let providerNotFound = false;");
    expect(routes).toContain("let providerEndedAt: string | null = null;");
    expect(routes).toContain('if (providerNotFound && existing.state !== "ending") {');
    expect(routes).toContain('(providerEndedAt && ["ending", "ended"].includes(existing.state))');
    expect(routes).toContain('return refused("session_terminal", { error: "session unavailable" }, 410);');
  });

  it("W8: commercialConsultEnd never sends mark_ended before ends_at", () => {
    const start = routes.indexOf("export async function commercialConsultEnd");
    const end = routes.indexOf("export async function commercialConsultState");
    const body = routes.slice(start, end);
    expect(body).toContain("RULEBOOK-PAID-SESSIONS.md v2 §3");
    expect(body).toContain("Date.now() < Number(row.ends_at)");
    expect(body).toContain("recorded_intent");
    // The provider `mark_ended` path (runControl) is only reached below the
    // early-return, never before it.
    const guardIdx = body.indexOf("Date.now() < Number(row.ends_at)");
    const runControlIdx = body.indexOf("await runControl(");
    expect(runControlIdx).toBeGreaterThan(guardIdx);
  });

  it("W10: buildWaitingRoomGrant accepts a shared config so prejoin calls readConfig once", () => {
    expect(waitingRoom).toContain("config?: PlatformConfig");
    expect(waitingRoom).toContain("p.config ?? await readConfig(env)");
    const prejoinStart = routes.indexOf("export async function commercialConsultPrejoin");
    const prejoinEnd = routes.indexOf("async function commercialConsultJoinUnsafe");
    const prejoin = routes.slice(prejoinStart, prejoinEnd);
    expect((prejoin.match(/await readConfig\(env\)/g) ?? []).length).toBe(1);
    expect(prejoin).toContain("config,\n    });");
  });

  it("W10: a failed waiting-room grant logs and degrades instead of 500ing", () => {
    const prejoinStart = routes.indexOf("export async function commercialConsultPrejoin");
    const prejoinEnd = routes.indexOf("async function commercialConsultJoinUnsafe");
    const prejoin = routes.slice(prejoinStart, prejoinEnd);
    expect(prejoin).toContain("try {");
    expect(prejoin).toContain("waiting_room_grant_failed");
    expect(prejoin).toContain("commercialEvent(env, \"prejoin\"");
    expect(prejoin).toContain("...(grant ? { room_ws: grant.room_ws, room_token: grant.room_token, check_in_by: grant.check_in_by } : {})");
  });

  it("WP8 follow-up: go-live accepts a reconnecting host and exposes starts_at in live state", () => {
    const goLiveStart = routes.indexOf("export async function commercialLiveGoLive");
    const goLiveEnd = routes.indexOf("export async function commercialLiveEnd");
    const goLive = routes.slice(goLiveStart, goLiveEnd);
    expect(goLive).toContain('session.state === "live"');
    expect(goLive).toContain("session.reconnect_deadline_ms != null");
    expect(goLive).toContain("reconnecting");
    expect(routes).toContain("starts_at: Number(session.scheduled_at)");
  });

  it("C11: DO chat carries uid, and welcome/roster carry host_checked_in_at", () => {
    const doSource = readFileSync(resolve(root, "src/do/stream_session.ts"), "utf8");
    // [APP-ONLY-TX-FIX-1] The chat relay became a two-branch queue() when
    // attachments landed ([APP-ONLY-TX-WORKER-1]); assert the invariant this
    // test exists for — `uid: meta.uid` on the relayed chat event — on BOTH
    // branches, instead of pinning one exact source line that no longer exists.
    expect(doSource).toContain('{ type: "chat", from: meta.name, text, at: now, uid: meta.uid }');
    expect(doSource).toContain('{ type: "chat", from: meta.name, text, at: now, uid: meta.uid, attachment }');
    expect(doSource).toContain("host_checked_in_at: s.host_checked_in_at != null ? Number(s.host_checked_in_at) : null,");
    expect(doSource).toContain("ALTER TABLE session ADD COLUMN host_checked_in_at INTEGER");
  });
});

describe("WAITROOM-4 second-pass fixes", () => {
  const consult = readFileSync(resolve(root, "src/routes/consult.ts"), "utf8");

  it("R1 BLOCKER: a commercial booking is identified by id prefix or a policy-snapshot row, NOT bare kind==='consult_1to1'", () => {
    expect(consult).toContain("async function isCommercialBooking(env: Env, bk: Bk): Promise<boolean>");
    expect(consult).toContain('bk.id.startsWith("commercial-booking-")');
    expect(consult).toContain("SELECT 1 ok FROM commercial_policy_snapshots WHERE booking_id=?1");
    // The bare-kind check that 409'd every legacy consult must be gone.
    expect(consult).not.toMatch(/return bk\.kind === "consult_1to1" \? json/);
    // Every legacy handler awaits the async guard now.
    for (const name of ["consultJoin", "consultComplete", "consultCancel", "consultExtend"]) {
      const start = consult.indexOf(`export async function ${name}(`);
      const body = consult.slice(start, start + 700);
      expect(body).toMatch(/await refuseCommercialBooking\(env, bk\)/);
    }
  });

  it("R4 BLOCKER: a host `left` webhook is matched to its own provider_session_id, and only arms grace with no other open interval", () => {
    const start = routes.indexOf("} else if (left && member && input.actorId) {");
    const end = routes.indexOf("const providerStarted = isCommercialLifecycleStart");
    const leftBranch = routes.slice(start, end);
    expect(leftBranch).toContain("const providerSessionId = input.providerSessionId ?? \"default\";");
    expect(leftBranch).toContain("AND provider_session_id=?3");
    expect(leftBranch).toContain("const stillConnected = await metaDb(env).prepare(");
    expect(leftBranch).toContain("if (!stillConnected) {");
    expect(leftBranch).toContain("await armLiveGrace(env, {");
  });

  it("[WAITROOM-6] a `left` with no provider session id falls back to the newest open interval and logs it", () => {
    const start = routes.indexOf("} else if (left && member && input.actorId) {");
    const end = routes.indexOf("const providerStarted = isCommercialLifecycleStart");
    const leftBranch = routes.slice(start, end);
    // The strict, id-bearing match stays first (R4's reconnect-race guard).
    expect(leftBranch).toContain("let open = await metaDb(env).prepare(");
    expect(leftBranch).toContain("AND provider_session_id=?3");
    // ...and only a `left` that carries NO session id may widen the match.
    expect(leftBranch).toContain("if (!open && !input.providerSessionId) {");
    const fallback = leftBranch.slice(leftBranch.indexOf("if (!open && !input.providerSessionId) {"));
    expect(fallback).not.toContain("AND provider_session_id=");
    expect(fallback).toContain("ORDER BY joined_at DESC LIMIT 1");
    expect(fallback).toContain("left_without_session_id");
  });

  it("R4: endLiveOnHostNoReturn re-checks for an open host interval before ending", () => {
    const liveGrace = readFileSync(resolve(root, "src/lib/live_grace.ts"), "utf8");
    expect(liveGrace).toContain("hostStillConnected");
    expect(liveGrace).toContain("m.role='host'");
    expect(liveGrace).toContain("host_already_reconnected");
  });

  it("R6 SHOULD: endLiveOnHostNoReturn requires an armed-and-expired deadline in both the SELECT and the UPDATE, and gates the rest on the UPDATE's changes", () => {
    const liveGrace = readFileSync(resolve(root, "src/lib/live_grace.ts"), "utf8");
    const start = liveGrace.indexOf("export async function endLiveOnHostNoReturn");
    const fn = liveGrace.slice(start);
    const occurrences = (fn.match(/reconnect_deadline_ms IS NOT NULL AND reconnect_deadline_ms<=\?/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2); // SELECT + UPDATE
    expect(fn).toContain("const results = await metaDb(env).batch([");
    expect(fn).toContain("if ((results[0]?.meta?.changes ?? 0) === 0) return;");
  });

  it("R7 SHOULD: armLiveGrace arms the DO before writing reconnect_deadline_ms to D1", () => {
    const liveGrace = readFileSync(resolve(root, "src/lib/live_grace.ts"), "utf8");
    const start = liveGrace.indexOf("export async function armLiveGrace");
    const end = liveGrace.indexOf("export async function clearLiveGrace");
    const fn = liveGrace.slice(start, end);
    const doArmIdx = fn.indexOf("await sessionOp(env, `live:${s.listingId}`");
    const dbWriteIdx = fn.indexOf("UPDATE commercial_sessions SET reconnect_deadline_ms");
    expect(doArmIdx).toBeGreaterThan(-1);
    expect(dbWriteIdx).toBeGreaterThan(doArmIdx);
  });

  it("R3 BLOCKER: a cron safety net (sweepExpiredLiveGrace) is exported from live_grace.ts and wired into the scheduled handler", () => {
    const liveGrace = readFileSync(resolve(root, "src/lib/live_grace.ts"), "utf8");
    expect(liveGrace).toContain("export async function sweepExpiredLiveGrace(env: Env, limit = 25)");
    expect(liveGrace).toContain("kind='live_event' AND state='live'");
    expect(liveGrace).toContain("reconnect_deadline_ms IS NOT NULL AND reconnect_deadline_ms<=?1");
    expect(router).toContain("sweepExpiredLiveGrace(env)");
  });

  it("R14 NIT: a 404 rejoin does not recreate the call when the row is already 'ending'", () => {
    expect(routes).toContain('if (providerNotFound && existing.state !== "ending") {');
    expect(routes).toContain('(providerNotFound && existing.state === "ending")');
  });

  it("C8 SHOULD: commercialLiveState answers a missing session row per-caller instead of a blanket 404", () => {
    const start = routes.indexOf("export async function commercialLiveState");
    const end = routes.indexOf("export async function commercialReceipt");
    const fn = routes.slice(start, end);
    expect(fn).toContain('if (!row || row.kind !== "live_event") return json({ error: "listing unavailable" }, 404);');
    expect(fn).toContain("if (auth.uid === row.creator_id) {");
    expect(fn).toContain('state: "scheduled"');
    expect(fn).toContain('kind: "live_event", listingId, uid: auth.uid, role: "viewer"');
    expect(fn).toContain('if (!ticket) return json({ error: "not entitled" }, 403);');
  });
});
