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
    expect(reviews).toContain("state='consumed' LIMIT 1");
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
      'if (/^/api/commercial/consult/[A-Za-z0-9-]{1,64}/extend/quote$/.test(p) && req.method === "POST")',
    );
    expect(normalizedRouter).toContain(
      'if (/^/api/commercial/consult/[A-Za-z0-9-]{1,64}/extend/confirm$/.test(p) && req.method === "POST")',
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
