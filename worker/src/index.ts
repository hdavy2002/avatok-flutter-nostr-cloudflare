// AvaTok API Worker — route-based dispatch (one Worker, not one-per-app).
//
// Single HARDENED contract: every mutation requires a NIP-98 signature (+ Clerk
// JWT when CLERK_JWKS_URL is set). The caller's identity comes from the
// signature, never the body. Public reads (resolve/search/communities/ice) are
// unauthenticated and cached. The old compat layer (identity-in-body, no auth)
// has been removed — the Flutter app signs NIP-98 and calls /api/*.
import type { Env } from "./types";
import { json, preflight } from "./util";
import * as api from "./routes/api";
import { uploadPublic, uploadPrivate, mediaRedirect, getLibrary, getLibraryTree, libraryFolders, libraryMove, libraryCopy, libraryDelete, libraryRecord, libraryFolderMove, libraryFolderCopy, getStorage, getIce } from "./routes/media";
import { getStorageSummary } from "./storage";
import { streamWebhook } from "./routes/stream";
import { brain } from "./routes/brain";
import { deleteAccount, cancelDeletion } from "./routes/account";
import { idSession, idResult, idStatus, idEmailStart, idEmailVerify, idPhoneConfirm } from "./routes/id";
import { walletTopup, stripeWebhook, walletSpend, walletBalance, walletTransactions, walletEarnings, walletLive, walletLedger, walletLedgerDetail, walletReceiptResend } from "./routes/wallet";
import { adminLedger, adminRefund, adminAdjust, adminAccount, adminRecon, adminEscrowHold, adminEscrowRelease, adminTaxExport, adminFailedSettlements, adminRetrySettlement, requireAdmin } from "./routes/admin_money";
import { liveStart, liveStop, liveJoin, liveRoom, liveDonate, liveMod, liveState } from "./routes/live";
import { consultJoin, consultRoom, consultSfu, consultComplete, consultCancel, consultExtend, consultProbe, consultProbeBlob } from "./routes/consult";
import { runMoney, moneyDlq, type MoneyMsg } from "./money_engine";
import { setTestClock } from "./clock";
import { stripeIdentityWebhook, agreementStatus, agreementDoc, agreementAccept } from "./routes/kyc";
import { livenessStart, livenessUpload, livenessVerify } from "./routes/liveness";
import { guestCreate, guestHandleCheck, guestUpgrade, getIdentityLevel } from "./routes/ladder";
import { createSlot, listSlots, cancelSlot, bookSlot, cancelBooking, listEvents, listBlocks, getRules, putRules, getTime } from "./routes/calendar";
import { listBookings, getPolicies, putPolicies, proposeReschedule, respondReschedule, listReschedules, joinInfo } from "./routes/booking";
import { gcalConnect, gcalCallback, gcalStatus, gcalDisconnect, gcalWebhook } from "./cal/gcal";
import { payoutSetup, payoutAccounts, payoutRequest, payoutStatus, wiseWebhook } from "./routes/payout";
import { olxCreate, olxBrowse, olxGet, olxUpdate, olxDelete, olxUploadFile, olxBuy, olxRefund, olxDownloads, olxDownloadFile } from "./routes/olx";
import { listPersonas, upsertPersona, converse, getInbox, getInboxItem, approveInbox, agentTask } from "./routes/agent";
import { agentTts, agentAudio } from "./routes/agent_tts";
import { listNotifications, unreadCount, markRead } from "./routes/notifications";
import { wsInbox, sendMsg, syncMsg, receiptMsg, convList, convCreate } from "./routes/messaging";
import { getConfig, putConfig } from "./routes/config";
import { conferenceStart, conferenceJoin, conferenceStatus, conferenceEnd, conferenceWebhook } from "./routes/conference";
import { marketplaceStub } from "./routes/stubs";
import { verseSummary, verseAnnounce, verseStatement, reviewReply } from "./routes/verse";
import {
  createListing, updateListing, publishListing, setListingStatus, duplicateListing, cancelListing,
  myListings, listingPromotions, deletePromotion, exploreBrowse, exploreLiveNow, exploreSearch,
  exploreCategories, getListing, getCreator, updateMyChannel, followCreator, unfollowCreator,
  blockCreator, report, bookListing, createReview,
} from "./routes/listings";

export { CallRoom } from "./do/call_room";
export { InboxDO } from "./do/inbox";
export { UserBrain } from "./do/user_brain";
export { WalletDO } from "./do/wallet";
export { StreamSessionDO } from "./do/stream_session";
export { AgentDO } from "./do/agent";
export { ConversationDO } from "./do/conversation";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const t0 = Date.now();
    const traceId = req.headers.get("x-trace-id") || crypto.randomUUID();
    const res = await dispatch(req, env, ctx);
    // Operational metric: route, method, trace, latency, status (Analytics Engine).
    try { env.ANALYTICS?.writeDataPoint({ blobs: [new URL(req.url).pathname.slice(0, 64), req.method, traceId], doubles: [Date.now() - t0, res.status], indexes: ["api"] }); } catch { /* best-effort */ }
    return res;
  },

  // Phase 7 — this worker consumes its own money queue (max_retries=5 →
  // money-dlq). The engine is idempotent: a retry or cron re-run can never
  // double-refund (WalletDO op_id dedupe + settlement_log).
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        if (batch.queue.startsWith("money-dlq")) {
          await moneyDlq(env, msg.body);
        } else {
          await runMoney(env, msg.body as MoneyMsg);
        }
        msg.ack();
      } catch (e) {
        console.error(`[${batch.queue}] settlement retry:`, String(e));
        msg.retry();
      }
    }
  },
};

// req.cf.continent → DO location hint (no "me" mapping derivable from continent).
const CONTINENT_HINT: Record<string, DurableObjectLocationHint> = {
  AF: "afr", AS: "apac", EU: "weur", NA: "enam", OC: "oc", SA: "sam",
};
function continentHint(req: Request): DurableObjectLocationHint | undefined {
  const c = (req as { cf?: { continent?: string } }).cf?.continent;
  return c ? CONTINENT_HINT[c] : undefined;
}

async function dispatch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === "OPTIONS") return preflight();
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/health") return json({ ok: true, service: "avatok-api", ts: Date.now() });

    // Remote kill switches (Phase 1, A2) — public read, admin write.
    if (p === "/api/config" && req.method === "GET") return await getConfig(env);
    if (p === "/api/admin/config" && req.method === "PUT") return await putConfig(req, env);

    // Group-call signaling → CallRoom DO (thin router, no logic). The location
    // hint places the room near the FIRST opener (the caller) — hints only apply
    // on first access, so the callee reaches the same instance. Cuts call-setup
    // signaling RTT for far-from-APAC users (Scale proposal Phase 1).
    const room = p.match(/^\/(?:api\/)?room\/([A-Za-z0-9_-]{1,64})$/);
    if (room) {
      const hint = continentHint(req);
      return env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(room[1]), hint ? { locationHint: hint } : undefined).fetch(req);
    }

    // AvaTalk group conferencing (Phase 10 — LiveKit, ≤25; RULE CHANGE 2026-06-10).
    // 1:1 calls stay on the CallRoom DO above — these routes never touch it.
    if (p === "/api/conference/webhook" && req.method === "POST") return await conferenceWebhook(req, env);
    const conf = p.match(/^\/api\/conference\/([A-Za-z0-9_:.-]{1,64})\/(start|join|status|end)$/);
    if (conf) {
      if (conf[2] === "start" && req.method === "POST") return await conferenceStart(req, env, conf[1]);
      if (conf[2] === "join" && req.method === "POST") return await conferenceJoin(req, env, conf[1]);
      if (conf[2] === "status" && req.method === "GET") return await conferenceStatus(req, env, conf[1]);
      if (conf[2] === "end" && req.method === "POST") return await conferenceEnd(req, env, conf[1]);
    }

    // Cloudflare-native messaging — live socket → caller's InboxDO (Nostr deprecated).
    if (p === "/api/inbox" && req.headers.get("Upgrade") === "websocket") return await wsInbox(req, env);

    try {
      // --- messaging (Cloudflare-native; Clerk-JWT auth, server-readable) ---
      if (p === "/api/msg/send" && req.method === "POST") return await sendMsg(req, env);
      if (p === "/api/msg/sync" && req.method === "GET") return await syncMsg(req, env);
      if (p === "/api/msg/receipt" && req.method === "POST") return await receiptMsg(req, env);
      if (p === "/api/conversations" && req.method === "GET") return await convList(req, env);
      if (p === "/api/conversations" && req.method === "POST") return await convCreate(req, env);

      // --- directory ---
      if (p === "/api/profile" && req.method === "POST") return await api.profileUpsert(req, env);
      if (p === "/api/me" && req.method === "GET") return await api.me(req, env);
      if (p === "/api/vault" && req.method === "POST") return await api.vaultPut(req, env);
      if (p === "/api/vault" && req.method === "GET") return await api.vaultGet(req, env);
      if (p === "/api/resolve" && req.method === "GET") return await cached(req, ctx, () => api.resolve(req, env), 60);
      if (p === "/api/search" && req.method === "GET") return await cached(req, ctx, () => api.search(req, env), 60);
      if (p === "/api/handle/check" && req.method === "GET") return await cached(req, ctx, () => api.handleCheck(req, env), 10);

      // --- push / calls ---
      if (p === "/api/register" && req.method === "POST") return await api.register(req, env);
      if (p === "/api/call" && req.method === "POST") return await api.call(req, env);
      if (p === "/api/notify" && req.method === "POST") return await api.notify(req, env);
      if (p === "/api/call-status" && req.method === "POST") return await api.callStatus(req, env);

      // --- contacts ---
      if (p === "/api/contacts/sync" && req.method === "POST") return await api.contactsSync(req, env);
      if (p === "/api/contacts/match" && req.method === "POST") return await api.contactsMatch(req, env);
      if (p === "/api/contacts/list" && req.method === "GET") return api.contactsList();

      // --- communities ---
      if (p === "/api/community" && req.method === "POST") return await api.communityUpsert(req, env);
      if (p === "/api/community/join" && req.method === "POST") return await api.communityJoin(req, env);
      if (p === "/api/communities" && req.method === "GET") return await api.communities(req, env);

      // --- media (NIP-98) ---
      if (p === "/upload/public" && req.method === "POST") return await uploadPublic(req, env, ctx);
      if (p === "/upload/private" && req.method === "POST") return await uploadPrivate(req, env, ctx);
      if (p === "/api/library" && req.method === "GET") return await getLibrary(req, env);
      if (p === "/api/library/tree" && req.method === "GET") return await getLibraryTree(req, env);
      if (p === "/api/library/folders/move" && req.method === "POST") return await libraryFolderMove(req, env);
      if (p === "/api/library/folders/copy" && req.method === "POST") return await libraryFolderCopy(req, env);
      if (p === "/api/library/folders") return await libraryFolders(req, env);
      if (p === "/api/library/move" && req.method === "POST") return await libraryMove(req, env);
      if (p === "/api/library/copy" && req.method === "POST") return await libraryCopy(req, env);
      if (p === "/api/library/delete" && req.method === "POST") return await libraryDelete(req, env, ctx);
      if (p === "/api/library/record" && req.method === "POST") return await libraryRecord(req, env, ctx);
      if (p === "/api/storage" && req.method === "GET") return await getStorage(req, env);
      if (p === "/api/storage/summary" && req.method === "GET") return await getStorageSummary(req, env);

      // --- backup ---
      if (p === "/api/backup" && req.method === "POST") return await api.backup(req, env);

      // --- AvaID (Tier-2 verification, dual auth) ---
      if (p === "/api/id/session" && req.method === "POST") return await idSession(req, env);
      if (p === "/api/id/result" && req.method === "POST") return await idResult(req, env);
      if (p === "/api/id/status" && req.method === "GET") return await idStatus(req, env);
      // Onboarding contact verification — phone (Firebase OTP) + email (server OTP).
      if (p === "/api/id/email/start" && req.method === "POST") return await idEmailStart(req, env);
      if (p === "/api/id/email/verify" && req.method === "POST") return await idEmailVerify(req, env);
      if (p === "/api/id/phone/confirm" && req.method === "POST") return await idPhoneConfirm(req, env);
      // L2 liveness — Workers AI provider (flag-gated; Rekognition stays default).
      if (p === "/api/id/liveness/start" && req.method === "POST") return await livenessStart(req, env);
      if (p === "/api/id/liveness/upload" && req.method === "POST") return await livenessUpload(req, env);
      if (p === "/api/id/liveness/verify" && req.method === "POST") return await livenessVerify(req, env);
      // Progressive Identity ladder — guest tier (no auth) + level (Clerk auth).
      if (p === "/api/identity/guest" && req.method === "POST") return await guestCreate(req, env);
      if (p === "/api/identity/guest/check" && req.method === "GET") return await guestHandleCheck(req, env);
      if (p === "/api/identity/upgrade" && req.method === "POST") return await guestUpgrade(req, env);
      if (p === "/api/identity/level" && req.method === "GET") return await getIdentityLevel(req, env);
      // Phase 3 — Stripe Identity webhook (second KYC provider, same gateway)
      // + A1 agreement acceptance (creator agreement before first withdrawal).
      if ((p === "/webhooks/stripe-identity" || p === "/api/identity/stripe-webhook") && req.method === "POST") return await stripeIdentityWebhook(req, env);
      if (p === "/api/agreements/status" && req.method === "GET") return await agreementStatus(req, env);
      if (p === "/api/agreements/doc" && req.method === "GET") return await agreementDoc(req, env);
      if (p === "/api/agreements/accept" && req.method === "POST") return await agreementAccept(req, env);

      // --- AvaWallet (Phase 2; balance authority = WalletDO) ---
      if (p === "/api/wallet/topup" && req.method === "POST") return await walletTopup(req, env);
      if ((p === "/webhooks/stripe" || p === "/api/wallet/stripe-webhook") && req.method === "POST") return await stripeWebhook(req, env);
      if (p === "/api/wallet/spend" && req.method === "POST") return await walletSpend(req, env);
      if (p === "/api/wallet/balance" && req.method === "GET") return await walletBalance(req, env);
      if (p === "/api/wallet/transactions" && req.method === "GET") return await walletTransactions(req, env);
      if (p === "/api/wallet/earnings" && req.method === "GET") return await walletEarnings(req, env);
      if (p === "/api/wallet/live" && req.headers.get("Upgrade") === "websocket") return await walletLive(req, env);
      // Double-entry ledger reads + receipts (Phase 2 marketplace plan).
      if (p === "/api/wallet/ledger" && req.method === "GET") return await walletLedger(req, env);
      {
        const lr = p.match(/^\/api\/wallet\/ledger\/([A-Za-z0-9:._-]{1,80})\/receipt$/);
        if (lr && req.method === "POST") return await walletReceiptResend(req, env, lr[1]);
        const ld = p.match(/^\/api\/wallet\/ledger\/([A-Za-z0-9:._-]{1,80})$/);
        if (ld && req.method === "GET") return await walletLedgerDetail(req, env, ld[1]);
      }
      // Money ops console (Phase 2 A2; admin-only, audit-logged).
      if (p === "/api/admin/ledger" && req.method === "GET") return await adminLedger(req, env);
      if (p === "/api/admin/refund" && req.method === "POST") return await adminRefund(req, env);
      if (p === "/api/admin/adjust" && req.method === "POST") return await adminAdjust(req, env);
      if (p === "/api/admin/recon" && req.method === "GET") return await adminRecon(req, env);
      if (p === "/api/admin/tax-export" && req.method === "GET") return await adminTaxExport(req, env);
      if (p === "/api/admin/escrow/hold" && req.method === "POST") return await adminEscrowHold(req, env);
      if (p === "/api/admin/escrow/release" && req.method === "POST") return await adminEscrowRelease(req, env);
      {
        const aa = p.match(/^\/api\/admin\/account\/([A-Za-z0-9_-]{1,64})$/);
        if (aa && req.method === "GET") return await adminAccount(req, env, aa[1]);
      }

      // --- AvaCalendar + AvaBooking (Phase 5: conflict engine, gcal sync,
      // policies, reschedule flow, public join links) ---
      if (p === "/api/time" && req.method === "GET") return getTime();
      if (p === "/api/calendar/slots" && req.method === "POST") return await createSlot(req, env);
      if (p === "/api/calendar/slots" && req.method === "GET") return await listSlots(req, env);
      const cs = p.match(/^\/api\/calendar\/slots\/([A-Za-z0-9-]{1,64})$/);
      if (cs && req.method === "DELETE") return await cancelSlot(req, env, cs[1]);
      if (p === "/api/calendar/book" && req.method === "POST") return await bookSlot(req, env);
      if (p === "/api/calendar/cancel" && req.method === "POST") return await cancelBooking(req, env);
      if (p === "/api/calendar/events" && req.method === "GET") return await listEvents(req, env);
      if (p === "/api/calendar/blocks" && req.method === "GET") return await listBlocks(req, env);
      if (p === "/api/calendar/rules" && req.method === "GET") return await getRules(req, env);
      if (p === "/api/calendar/rules" && req.method === "PUT") return await putRules(req, env);
      if (p === "/api/calendar/gcal/connect" && req.method === "GET") return await gcalConnect(req, env);
      if (p === "/api/calendar/gcal/callback" && req.method === "GET") return await gcalCallback(req, env);
      if (p === "/api/calendar/gcal/status" && req.method === "GET") return await gcalStatus(req, env);
      if (p === "/api/calendar/gcal" && req.method === "DELETE") return await gcalDisconnect(req, env);
      if (p === "/webhooks/gcal" && req.method === "POST") return await gcalWebhook(req, env);
      if (p === "/api/booking/list" && req.method === "GET") return await listBookings(req, env);
      if (p === "/api/booking/policies" && req.method === "GET") return await getPolicies(req, env);
      if (p === "/api/booking/policies" && req.method === "PUT") return await putPolicies(req, env);
      if (p === "/api/booking/reschedules" && req.method === "GET") return await listReschedules(req, env);
      {
        const rr = p.match(/^\/api\/booking\/reschedule\/([A-Za-z0-9-]{1,64})\/respond$/);
        if (rr && req.method === "POST") return await respondReschedule(req, env, rr[1]);
        const pr = p.match(/^\/api\/booking\/([A-Za-z0-9-]{1,64})\/reschedule$/);
        if (pr && req.method === "POST") return await proposeReschedule(req, env, pr[1]);
        const ji = p.match(/^\/api\/join-info\/([A-Za-z0-9._-]{1,512})$/);
        if (ji && req.method === "GET") return await joinInfo(req, env, ji[1]);
      }

      // --- AvaPayout (Phase 4; production transfers flag-gated pending legal) ---
      if (p === "/api/payout/setup" && req.method === "POST") return await payoutSetup(req, env);
      if (p === "/api/payout/accounts" && req.method === "GET") return await payoutAccounts(req, env);
      if (p === "/api/payout/request" && req.method === "POST") return await payoutRequest(req, env);
      if (p === "/api/payout/status" && req.method === "GET") return await payoutStatus(req, env);
      if (p === "/webhooks/wise" && req.method === "POST") return await wiseWebhook(req, env);

      // --- AvaOLX (Phase 5; browse open, list/sell Tier-2) ---
      if (p === "/api/olx/listings" && req.method === "POST") return await olxCreate(req, env);
      if (p === "/api/olx/listings" && req.method === "GET") return await olxBrowse(req, env);
      if (p === "/api/olx/buy" && req.method === "POST") return await olxBuy(req, env);
      if (p === "/api/olx/refund" && req.method === "POST") return await olxRefund(req, env);
      if (p === "/api/olx/downloads" && req.method === "GET") return await olxDownloads(req, env);
      const odl = p.match(/^\/api\/olx\/downloads\/([A-Za-z0-9-]{1,64})\/file$/);
      if (odl && req.method === "GET") return await olxDownloadFile(req, env, odl[1]);
      const olf = p.match(/^\/api\/olx\/listings\/([A-Za-z0-9-]{1,64})\/file$/);
      if (olf && req.method === "POST") return await olxUploadFile(req, env, olf[1]);
      const olm = p.match(/^\/api\/olx\/listings\/([A-Za-z0-9-]{1,64})$/);
      if (olm && req.method === "GET") return await olxGet(req, env, olm[1]);
      if (olm && req.method === "PUT") return await olxUpdate(req, env, olm[1]);
      if (olm && req.method === "DELETE") return await olxDelete(req, env, olm[1]);

      // --- AvaBrain Agentic layer (Phase 7) ---
      if (p === "/api/agent/personas" && req.method === "GET") return await listPersonas(req, env);
      const ap = p.match(/^\/api\/agent\/personas\/([a-z0-9]{1,32})$/);
      if (ap && req.method === "PUT") return await upsertPersona(req, env, ap[1]);
      if (p === "/api/agent/converse" && req.method === "POST") return await converse(req, env);
      if (p === "/api/agent/inbox" && req.method === "GET") return await getInbox(req, env);
      const ai = p.match(/^\/api\/agent\/inbox\/([A-Za-z0-9-]{1,64})$/);
      if (ai && req.method === "GET") return await getInboxItem(req, env, ai[1]);
      if (p === "/api/agent/approve" && req.method === "POST") return await approveInbox(req, env);
      if (p === "/api/agent/task" && req.method === "POST") return await agentTask(req, env);
      if (p === "/api/agent/tts" && req.method === "POST") return await agentTts(req, env);
      const aa = p.match(/^\/api\/agent\/audio\/([A-Za-z0-9-]{1,64})$/);
      if (aa && req.method === "GET") return await agentAudio(req, env, aa[1]);

      // --- account deletion (right-to-erasure; 30-day grace → queue cascade) ---
      if (p === "/api/account/delete" && (req.method === "POST" || req.method === "DELETE")) return await deleteAccount(req, env);
      if (p === "/api/account/delete/cancel" && req.method === "POST") return await cancelDeletion(req, env);

      // --- Phase 8: AvaVerse dashboard (aggregation only, no new stores) ---
      if (p === "/api/verse/summary" && req.method === "GET") return await verseSummary(req, env);
      if (p === "/api/verse/announce" && req.method === "POST") return await verseAnnounce(req, env);
      if (p === "/api/verse/statement" && req.method === "GET") return await verseStatement(req, env);
      {
        const rr = p.match(/^\/api\/reviews\/([A-Za-z0-9-]{1,64})\/reply$/);
        if (rr && req.method === "POST") return await reviewReply(req, env, rr[1]);
      }

      // --- in-app notifications feed ---
      if (p === "/api/notifications" && req.method === "GET") return await listNotifications(req, env);
      if (p === "/api/notifications/unread" && req.method === "GET") return await unreadCount(req, env);
      if (p === "/api/notifications/read" && req.method === "POST") return await markRead(req, env);

      // --- AvaBrain (dual auth; routes to the caller's UserBrain DO) ---
      const bm = p.match(/^\/api\/brain\/([a-z]+)$/);
      if (bm) {
        const op = bm[1];
        const readOp = op === "entities" || op === "timeline" || op === "history";
        if ((op === "consent" || op === "settings") && (req.method === "GET" || req.method === "POST" || req.method === "PUT")) return await brain(req, env, op);
        if ((readOp && req.method === "GET") || (!readOp && req.method === "POST") || (op === "forget" && req.method === "DELETE")) {
          return await brain(req, env, op);
        }
      }

      // --- ICE (public read) ---
      if (p === "/api/ice" || p === "/ice") return await getIce(env);

      // --- Stream webhook (Cloudflare Stream Live events) ---
      if (p === "/webhooks/stream" && req.method === "POST") return await streamWebhook(req, env, ctx);

      // --- Phase 7: AvaLive delivery (Stream Live + interaction room) ---
      {
        const lv = p.match(/^\/api\/live\/[A-Za-z0-9-]{1,64}\/(start|stop|join|room|donate|mod|state)$/);
        if (lv) {
          const act = lv[1];
          if (act === "start" && req.method === "POST") return await liveStart(req, env);
          if (act === "stop" && req.method === "POST") return await liveStop(req, env);
          if (act === "join" && req.method === "GET") return await liveJoin(req, env);
          if (act === "room") return await liveRoom(req, env);
          if (act === "donate" && req.method === "POST") return await liveDonate(req, env);
          if (act === "mod" && req.method === "POST") return await liveMod(req, env);
          if (act === "state" && req.method === "GET") return await liveState(req, env);
        }
      }

      // --- Phase 7: AvaConsult delivery (P2P + Realtime SFU + refund engine) ---
      if (p === "/api/consult/probe" && req.method === "GET") return consultProbe();
      if (p === "/api/consult/probe/blob" && req.method === "GET") return consultProbeBlob();
      {
        if (/^\/api\/consult\/[A-Za-z0-9-]{1,64}\/sfu(\/|$)/.test(p)) return await consultSfu(req, env);
        const cn = p.match(/^\/api\/consult\/[A-Za-z0-9-]{1,64}\/(join|room|complete|cancel|extend)$/);
        if (cn) {
          const act = cn[1];
          if (act === "join" && req.method === "GET") return await consultJoin(req, env);
          if (act === "room") return await consultRoom(req, env);
          if (act === "complete" && req.method === "POST") return await consultComplete(req, env);
          if (act === "cancel" && req.method === "POST") return await consultCancel(req, env);
          if (act === "extend" && req.method === "POST") return await consultExtend(req, env);
        }
      }

      // --- Phase 7 admin: test clock (staging only) + DLQ console ---
      if (p === "/api/admin/test-clock" && req.method === "POST") {
        // Admin gate first (same ADMIN_UIDS list), then the staging-only check.
        const a = await requireAdmin(req, env);
        if (a instanceof Response) return a;
        return await setTestClock(req, env);
      }
      if (p === "/api/admin/settlements" && req.method === "GET") return await adminFailedSettlements(req, env);
      // Manual engine pass (acceptance tests with the test clock): runs inline
      // and returns the exact actions that fired. Idempotent like every pass.
      if (p === "/api/admin/money/evaluate" && req.method === "POST") {
        const a = await requireAdmin(req, env);
        if (a instanceof Response) return a;
        const b = (await req.json().catch(() => ({}))) as any;
        const r = await runMoney(env, { type: b.type === "cancel" ? "cancel" : "evaluate", sid: String(b.sid || ""), kind: b.kind === "consult" ? "consult" : "live_event", phase: b.phase, orderId: b.orderId });
        return json(r);
      }
      {
        const sr = p.match(/^\/api\/admin\/settlements\/([A-Za-z0-9-]{1,64})\/retry$/);
        if (sr && req.method === "POST") return await adminRetrySettlement(req, env, sr[1]);
      }

      // --- permanent redirect for any cached/shared legacy media URLs ---
      if (/^\/media\/[a-f0-9]{64}$/.test(p) && req.method === "GET") return mediaRedirect(p, env);

      // --- Phase 6: listings pipeline + AvaExplore + creator channels ---
      // Marketplace reads are PUBLIC (A3 guest browsing — no auth required).
      if (p === "/api/explore" && req.method === "GET") return await exploreBrowse(req, env);
      if (p === "/api/explore/live-now" && req.method === "GET") return await exploreLiveNow(req, env);
      if (p === "/api/explore/search" && req.method === "GET") return await exploreSearch(req, env);
      if (p === "/api/explore/categories" && req.method === "GET") return await cached(req, ctx, () => exploreCategories(env), 300);
      if (p === "/api/listings" && req.method === "POST") return await createListing(req, env);
      if (p === "/api/listings/mine" && req.method === "GET") return await myListings(req, env);
      if (p === "/api/report" && req.method === "POST") return await report(req, env);
      if (p === "/api/creators/me" && req.method === "PUT") return await updateMyChannel(req, env);
      {
        const la = p.match(/^\/api\/listings\/([A-Za-z0-9-]{1,64})\/(publish|status|duplicate|book|reviews|promotions)$/);
        if (la) {
          const lid = la[1], act = la[2];
          if (act === "publish" && req.method === "POST") return await publishListing(req, env, lid);
          if (act === "status" && req.method === "POST") return await setListingStatus(req, env, lid);
          if (act === "duplicate" && req.method === "POST") return await duplicateListing(req, env, lid);
          if (act === "book" && req.method === "POST") return await bookListing(req, env, lid);
          if (act === "reviews" && req.method === "POST") return await createReview(req, env, lid);
          if (act === "promotions" && (req.method === "GET" || req.method === "POST")) return await listingPromotions(req, env, lid);
        }
        const lpd = p.match(/^\/api\/listings\/([A-Za-z0-9-]{1,64})\/promotions\/([A-Za-z0-9-]{1,64})$/);
        if (lpd && req.method === "DELETE") return await deletePromotion(req, env, lpd[1], lpd[2]);
        const lm = p.match(/^\/api\/listings\/([A-Za-z0-9-]{1,64})$/);
        if (lm && req.method === "GET") return await getListing(req, env, lm[1]);
        if (lm && req.method === "PUT") return await updateListing(req, env, lm[1]);
        if (lm && req.method === "DELETE") return await cancelListing(req, env, lm[1]);
        const cf = p.match(/^\/api\/creators\/([A-Za-z0-9_-]{1,64})\/(follow|block)$/);
        if (cf) {
          const cid = cf[1], act = cf[2];
          if (act === "follow" && req.method === "POST") return await followCreator(req, env, cid);
          if (act === "follow" && req.method === "DELETE") return await unfollowCreator(req, env, cid);
          if (act === "block" && (req.method === "POST" || req.method === "DELETE")) return await blockCreator(req, env, cid);
        }
        const cm = p.match(/^\/api\/creators\/([A-Za-z0-9_-]{1,64})$/);
        if (cm && req.method === "GET") return await getCreator(req, env, cm[1]);
      }

      // --- creator-marketplace URL-space reservation (Phase 1) — 501 stubs ---
      const stub = marketplaceStub(p);
      if (stub) return stub;
    } catch (e: any) {
      return json({ error: "internal", detail: String(e?.message ?? e) }, 500);
    }
    return json({ error: "not found", path: p }, 404);
}

// Cache API wrapper for public GET reads (Rulebook: Cache API before KV/D1).
async function cached(req: Request, ctx: ExecutionContext, build: () => Promise<Response>, ttl: number): Promise<Response> {
  const cache = caches.default;
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await build();
  if (res.status === 200) {
    const toCache = new Response(res.clone().body, res);
    toCache.headers.set("cache-control", `public, max-age=${ttl}`);
    ctx.waitUntil(cache.put(req, toCache));
  }
  return res;
}
