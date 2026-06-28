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
import { idSession, idResult, idStatus, idEmailStart, idEmailVerify, idPhoneConfirm, idPasswordStart, idPasswordSet } from "./routes/id";
import { walletTopup, walletTopupIntent, stripeWebhook, walletSpend, walletBalance, walletTransactions, walletEarnings, walletLive, walletLedger, walletLedgerDetail, walletReceiptResend } from "./routes/wallet";
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
import { wsInbox, sendMsg, syncMsg, receiptMsg, readMsg, hideMsg, reactMsg, stateMsg, convList, convCreate, callLogAppend, callLogDelete, callLogClear } from "./routes/messaging";
import { archiveList } from "./routes/archive";
import { ablyToken } from "./routes/ably";
import { getConfig, putConfig } from "./routes/config";
import { getPlans } from "./routes/plans";
import * as num from "./routes/number";
import { subscribeCheckout, subscribeAndroidVerify, subscribeCancel } from "./routes/subscribe";
import { referralClaim, referralSummary } from "./routes/referral";
import { inviteEmail } from "./routes/invite";
import { featureCostsRoute } from "./feature_pricing";
import { googleAuth } from "./routes/google_auth";
import { conferenceStart, conferenceJoin, conferenceStatus, conferenceEnd, conferenceWebhook, conferenceBeat } from "./routes/conference";
import { translateStart, translateBeat, translateStop, translateToken, translateQuote } from "./routes/translate";
import { sttTranscribe } from "./routes/stt";
import {
  avavoiceVoices, avavoiceMarketplace, avavoiceMine, avavoiceCreateAgent, avavoiceGetAgent,
  avavoiceUpdateAgent, avavoicePublish, avavoiceDeleteAgent, avavoiceUploadFile, avavoiceDeleteFile,
  avavoiceAvailability, avavoiceStats, avavoiceBook, avavoiceMyBookings, avavoiceCancelBooking,
  avavoiceCallNow, avavoiceSessionStart, avavoiceHeartbeat, avavoiceSessionStop,
} from "./routes/avavoice";
import {
  receptionistGetSettings, receptionistPutSettings, receptionistConfigFor,
  receptionistStart, receptionistFinish, receptionistKbUpload, receptionistKbClear,
  receptionistRecording,
} from "./routes/receptionist";
import {
  avavisionTemplates, avavisionVoices, avavisionMarketplace, avavisionMine, avavisionCreateAgent,
  avavisionGetAgent, avavisionUpdateAgent, avavisionPublish, avavisionDeleteAgent, avavisionUploadFile,
  avavisionDeleteFile, avavisionAvailability, avavisionStats, avavisionBook, avavisionMyBookings,
  avavisionCancelBooking, avavisionCallNow, avavisionSessionStart, avavisionSessionToken,
  avavisionHeartbeat, avavisionSessionStop, avavisionSnapshot,
} from "./routes/avavision";
import {
  adminOverview, adminLive, adminAgents, adminHealth, adminAnalytics, adminAuditLog,
  adminUserSearch, adminAlerts, adminAlertAck, adminAlertResolve, adminAlertEvaluate,
  adminAlertRules, adminAlertRuleMutate, adminRoles, adminRoleSet,
} from "./routes/admin_dashboard";
import { marketplaceStub } from "./routes/stubs";
import { verseSummary, verseAnnounce, verseStatement, reviewReply } from "./routes/verse";
import {
  createListing, updateListing, publishListing, setListingStatus, duplicateListing, cancelListing,
  myListings, listingPromotions, deletePromotion, exploreBrowse, exploreLiveNow, exploreSearch,
  exploreCategories, getListing, getCreator, updateMyChannel, followCreator, unfollowCreator,
  blockCreator, report, bookListing, createReview,
} from "./routes/listings";
import { listingStats, creatorStats } from "./routes/insights";
import {
  affiliateRegister, affiliateMe, affiliateListings, affiliateLinkCreate, affiliateLinks,
  affiliateLinkStats, affiliateLinkSubscribers, affiliateLinkPause, affiliateClick,
  affiliateBind, adminAffiliates, adminAffiliateSuspend,
} from "./routes/affiliate";
import { affiliateAssetsGenerate, affiliateAssetsList } from "./routes/affiliate_assets";
// --- Ava in-chat AI (Phase 0 — Foundations) ---
// These handler modules + DO classes are created by LATER phases (see master-plan
// §4: P2 gemini, P3 thread, P5 tools, P8 guardian, P9 image, P10 backup). The
// routes are registered now so feature phases just drop in the named handler.
// CONSEQUENCE: the worker will NOT typecheck/build until those files exist — this
// is expected and accepted for Phase 0 (Phase 11 reconciles). See
// Specs/ava-build/INTEGRATION-NOTES.md.
import { avaGemini, avaGeminiStream } from "./routes/ava_gemini";        // P2
import { avaLiveToken } from "./routes/ava_live";                        // fast online voice
import { avaRagIngest, avaRagStore, avaRagSearch, avaRagBackfill } from "./routes/ava_rag"; // RAG (Cloudflare AI Search)
import { avaAppsCatalog, avaAppsConnect, avaAppsDisconnect, avaAppsStatus, avaAppsRun, avaGenuiAction } from "./routes/ava_apps"; // AvaApps (Composio)
import { avaGenuiThumb } from "./routes/genui_thumb"; // GenUI preview-thumbnail proxy
import { avaEmailList, avaEmailGet, avaEmailSpam, avaEmailTrash, avaEmailReply } from "./routes/ava_email"; // in-chat email (Composio Gmail)
import { driveStatus, driveListRoute, driveUploadRoute, driveBackupEnsureRoute, driveBackupUploadRoute, driveBackupDownloadRoute } from "./routes/ava_drive"; // AvaTOK Drive storage
import { avaChatHistorySave, avaChatHistoryGet, avaChatHistoryMeta } from "./routes/ava_chat_history"; // AvaChat history (D1)
import { avaThreadTurn } from "./routes/ava_thread";    // P3
import { avaGuardianScan } from "./routes/ava_guardian"; // P8
import { moderateText } from "./routes/moderate";        // save-time content validation (Nemotron)
import { avaImage } from "./routes/ava_image";          // P9
import { backupGet, backupPut, backupStatus } from "./routes/backup"; // P10
import { ringtone } from "./routes/ringtone"; // AI ringback tones + busy tone
import { delegateHandler } from "./routes/ava_delegate"; // P7 (Phase 11 route wiring)

export { CallRoom } from "./do/call_room";
export { MeshRoom } from "./do/mesh_room";
export { InboxDO } from "./do/inbox";
export { UserBrain } from "./do/user_brain";
export { WalletDO } from "./do/wallet";
export { StreamSessionDO } from "./do/stream_session";
export { AgentDO } from "./do/agent";
export { ConversationDO } from "./do/conversation";
// Ava in-chat AI DOs (Phase 0 binding contract; classes implemented later —
// AvaAgentDO by P3, BackupDO by P10). These exports are required by the
// wrangler.toml DO bindings + v6 migration; the files arrive with their phases.
export { AvaAgentDO } from "./do/ava_agent"; // P3
export { BackupDO } from "./do/backup";      // P10
export { ReceptionRoom } from "./do/reception_room"; // Ava Receptionist call bridge

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

    // Store-review login bypass REMOVED (2026-06-18). Login is moving to
    // Google-only OAuth (no OTP), so reviewers sign in with a Gmail test
    // account and no bypass is needed. The /api/review/login route is gone.

    // Group-call signaling → CallRoom DO (thin router, no logic). The location
    // hint places the room near the FIRST opener (the caller) — hints only apply
    // on first access, so the callee reaches the same instance. Cuts call-setup
    // signaling RTT for far-from-APAC users (Scale proposal Phase 1).
    const room = p.match(/^\/(?:api\/)?room\/([A-Za-z0-9_-]{1,64})$/);
    if (room) {
      const hint = continentHint(req);
      return env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(room[1]), hint ? { locationHint: hint } : undefined).fetch(req);
    }

    // FREE-tier P2P mesh group-call signaling → MeshRoom DO (≤5). Keyed by group
    // id so all members of one group meet on the same mesh instance. WS = join
    // the mesh; plain GET = presence probe for the "ongoing call" banner. Paid
    // tiers use the LiveKit SFU (/api/conference/*) instead.
    const mesh = p.match(/^\/(?:api\/)?mesh\/([A-Za-z0-9_:.-]{1,64})$/);
    if (mesh) {
      const hint = continentHint(req);
      return env.MESH_ROOMS.get(env.MESH_ROOMS.idFromName(mesh[1]), hint ? { locationHint: hint } : undefined).fetch(req);
    }

    // AvaTalk group conferencing (Phase 10 — LiveKit, ≤25; RULE CHANGE 2026-06-10).
    // 1:1 calls stay on the CallRoom DO above — these routes never touch it.
    if (p === "/api/conference/webhook" && req.method === "POST") return await conferenceWebhook(req, env);
    const conf = p.match(/^\/api\/conference\/([A-Za-z0-9_:.-]{1,64})\/(start|join|status|end|beat)$/);
    if (conf) {
      if (conf[2] === "start" && req.method === "POST") return await conferenceStart(req, env, conf[1]);
      if (conf[2] === "join" && req.method === "POST") return await conferenceJoin(req, env, conf[1]);
      if (conf[2] === "status" && req.method === "GET") return await conferenceStatus(req, env, conf[1]);
      if (conf[2] === "end" && req.method === "POST") return await conferenceEnd(req, env, conf[1]);
      if (conf[2] === "beat" && req.method === "POST") return await conferenceBeat(req, env, conf[1]);
    }

    // Cloudflare-native messaging — live socket → caller's InboxDO (Nostr deprecated).
    if (p === "/api/inbox" && req.headers.get("Upgrade") === "websocket") return await wsInbox(req, env);

    // Ava Receptionist call bridge → ReceptionRoom DO (thin router; the DO
    // validates the one-time rtc token from KV). Keyed by session id so caller +
    // DO meet on the same instance. See Specs/PROPOSAL-AI-RECEPTIONIST.md.
    if (p === "/api/receptionist/rtc" && req.headers.get("Upgrade") === "websocket") {
      const sid = url.searchParams.get("session") || "";
      if (!sid) return new Response("session required", { status: 400 });
      const hint = continentHint(req);
      return env.RECEPTION_ROOM.get(env.RECEPTION_ROOM.idFromName(sid), hint ? { locationHint: hint } : undefined).fetch(req);
    }

    try {
      // --- messaging (Cloudflare-native; Clerk-JWT auth, server-readable) ---
      if (p === "/api/msg/send" && req.method === "POST") return await sendMsg(req, env);
      if (p === "/api/msg/sync" && req.method === "GET") return await syncMsg(req, env);
      // Phase 3 (ABLY-R2-3): deep history from R2/D1 (older than Ably's window).
      if (p === "/api/msg/archive" && req.method === "GET") return await archiveList(req, env);
      if (p === "/api/msg/receipt" && req.method === "POST") return await receiptMsg(req, env);
      if (p === "/api/msg/read" && req.method === "POST") return await readMsg(req, env);
      if (p === "/api/msg/hide" && req.method === "POST") return await hideMsg(req, env);
      // Phase 4 (ABLY-R2-4): persist a per-message reaction (live ride is Ably).
      if (p === "/api/msg/react" && req.method === "POST") return await reactMsg(req, env);
      // Phase 5 (ABLY-R2-5): owner-private state from D1 (read/hidden/call-log).
      if (p === "/api/msg/state" && req.method === "GET") return await stateMsg(req, env);
      // Ably realtime: mint a short-lived, clientId-pinned, room-scoped Ably JWT
      // (iOS/Android transport — Ably migration). Clerk-JWT auth, no API key on device.
      if (p === "/api/ably/token" && req.method === "POST") return await ablyToken(req, env);
      // Call-log multi-device sync (owner's own InboxDO; delete/clear wake asleep devices).
      if (p === "/api/call-log/append" && req.method === "POST") return await callLogAppend(req, env);
      if (p === "/api/call-log/delete" && req.method === "POST") return await callLogDelete(req, env);
      if (p === "/api/call-log/clear" && req.method === "POST") return await callLogClear(req, env);
      if (p === "/api/conversations" && req.method === "GET") return await convList(req, env);
      if (p === "/api/conversations" && req.method === "POST") return await convCreate(req, env);

      // --- Ava in-chat AI (Phase 0 registered routes; handlers filled by the
      // owner phases — master-plan §4). Order: most-specific first. ---
      if (p === "/api/ava/gemini" && req.method === "POST") return await avaGemini(req, env);          // P2
      if (p === "/api/ava/gemini/stream" && req.method === "POST") return await avaGeminiStream(req, env); // P2 streaming
      if (p === "/api/ava/live/token" && req.method === "POST") return await avaLiveToken(req, env);   // fast online voice call
      if (p === "/api/ava/thread/turn" && req.method === "POST") return await avaThreadTurn(req, env); // P3
      if (p === "/api/ava/rag/ingest" && req.method === "POST") return await avaRagIngest(req, env);   // RAG
      if (p === "/api/ava/rag/store" && req.method === "GET") return await avaRagStore(req, env);      // RAG
      if (p === "/api/ava/rag/search" && req.method === "POST") return await avaRagSearch(req, env);   // RAG
      if (p === "/api/ava/rag/backfill" && req.method === "POST") return await avaRagBackfill(req, env); // RAG backfill (history → AI Search)
      if (p === "/api/ava/apps/catalog" && req.method === "GET") return await avaAppsCatalog(req, env);  // AvaApps
      if (p === "/api/ava/apps/connect" && req.method === "POST") return await avaAppsConnect(req, env); // AvaApps
      if (p === "/api/ava/apps/disconnect" && req.method === "POST") return await avaAppsDisconnect(req, env); // AvaApps
      if (p === "/api/ava/apps/status" && req.method === "GET") return await avaAppsStatus(req, env);    // AvaApps
      if (p === "/api/ava/apps/run" && req.method === "POST") return await avaAppsRun(req, env);         // AvaApps
      if (p === "/api/ava/genui/action" && req.method === "POST") return await avaGenuiAction(req, env); // GenUI card action (Composio)
      if (p === "/api/ava/genui/thumb" && req.method === "GET") return await avaGenuiThumb(req, env);   // GenUI preview thumbnail (signed-URL proxy)
      if (p === "/api/ava/email/list" && req.method === "POST") return await avaEmailList(req, env);    // in-chat email
      if (p === "/api/ava/email/get" && req.method === "POST") return await avaEmailGet(req, env);      // in-chat email
      if (p === "/api/ava/email/spam" && req.method === "POST") return await avaEmailSpam(req, env);    // in-chat email
      if (p === "/api/ava/email/trash" && req.method === "POST") return await avaEmailTrash(req, env);  // in-chat email
      if (p === "/api/ava/email/reply" && req.method === "POST") return await avaEmailReply(req, env);  // in-chat email
      // AvaTOK own-file storage in the user's Google Drive (connect reuses the
      // Google OAuth — same consent grants calendar.events + drive.file).
      if (p === "/api/ava/drive/connect" && req.method === "POST") return await gcalConnect(req, env);
      if (p === "/api/ava/drive/status" && req.method === "GET") return await driveStatus(req, env);
      if (p === "/api/ava/drive/list" && req.method === "GET") return await driveListRoute(req, env);
      if (p === "/api/ava/drive/upload" && req.method === "POST") return await driveUploadRoute(req, env);
      if (p === "/api/ava/drive/backup/ensure" && req.method === "POST") return await driveBackupEnsureRoute(req, env);
      if (p === "/api/ava/drive/backup/upload" && req.method === "POST") return await driveBackupUploadRoute(req, env);
      if (p === "/api/ava/drive/backup/download" && req.method === "GET") return await driveBackupDownloadRoute(req, env);
      if (p === "/api/ava/chat/history/meta" && req.method === "POST") return await avaChatHistoryMeta(req, env);
      if (p === "/api/ava/chat/history" && req.method === "POST") return await avaChatHistorySave(req, env);
      if (p === "/api/ava/chat/history" && req.method === "GET") return await avaChatHistoryGet(req, env);
      if (p === "/api/ava/guardian/scan" && req.method === "POST") return await avaGuardianScan(req, env); // P8
      if (p === "/api/moderate" && req.method === "POST") return await moderateText(req, env);         // save-time content validation (Nemotron)
      if (p === "/api/ava/image" && req.method === "POST") return await avaImage(req, env);            // P9
      if (p === "/api/ava/delegate") return await delegateHandler(req, env); // P7 (GET reads prefs, POST writes)
      // Backup & sync (P10): GET pull, PUT push, GET status.
      if (p === "/api/backup/status" && req.method === "GET") return await backupStatus(req, env);
      if (p === "/api/backup" && req.method === "GET") return await backupGet(req, env);
      if (p === "/api/backup" && req.method === "PUT") return await backupPut(req, env);

      // AI Ringback Tones + Busy Tone — generation + 5-item library.
      // /api/ringtone/{generate|list|user/<uid>/default|<id>/default|<id>}
      if (p.startsWith("/api/ringtone/")) return await ringtone(req, env, p.slice("/api/ringtone/".length));

      // --- directory ---
      if (p === "/api/profile" && req.method === "POST") return await api.profileUpsert(req, env);
      if (p === "/api/me" && req.method === "GET") return await api.me(req, env);
      if (p === "/api/vault" && req.method === "POST") return await api.vaultPut(req, env);
      if (p === "/api/vault" && req.method === "GET") return await api.vaultGet(req, env);
      if (p === "/api/resolve" && req.method === "GET") return await cached(req, ctx, () => api.resolve(req, env), 60);
      if (p === "/api/search" && req.method === "GET") return await cached(req, ctx, () => api.search(req, env), 60);
      if (p === "/api/handle/check" && req.method === "GET") return await cached(req, ctx, () => api.handleCheck(req, env), 10);

      // --- AvaTOK Number (virtual in-network number; Specs/AVATOK-NUMBER-FEATURE-SPEC.md) ---
      if (p === "/api/number/countries" && req.method === "GET") return num.countries();
      if (p === "/api/number/available" && req.method === "GET") return await num.available(req, env);
      if (p === "/api/number/reserve" && req.method === "POST") return await num.reserve(req, env);
      if (p === "/api/number/assign" && req.method === "POST") return await num.assign(req, env);
      if (p === "/api/number/assign-own" && req.method === "POST") return await num.assignOwn(req, env);
      if (p === "/api/number/me" && req.method === "GET") return await num.me(req, env);
      if (p === "/api/number/release" && req.method === "POST") return await num.release(req, env);
      if (p === "/api/number/share-card" && req.method === "POST") return await num.shareCardPut(req, env);
      if (p === "/api/number/privacy" && req.method === "GET") return await num.privacyGet(req, env);
      if (p === "/api/number/privacy" && req.method === "POST") return await num.privacySet(req, env);
      if (p === "/api/add" && req.method === "GET") return await cached(req, ctx, () => num.addResolve(req, env), 30);

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
      if (p === "/api/id/password/start" && req.method === "POST") return await idPasswordStart(req, env);
      if (p === "/api/id/password/set" && req.method === "POST") return await idPasswordSet(req, env);
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
      // --- Subscribe (Phase 1 tiers: Free/Plus/Pro/Max) — gated by billingEnabled.
      // Stripe subscription events land on the shared /webhooks/stripe endpoint.
      if (p === "/api/subscribe/plans" && req.method === "GET") return await getPlans(req, env);
      if (p === "/api/subscribe/checkout" && req.method === "POST") return await subscribeCheckout(req, env);
      if (p === "/api/subscribe/android/verify" && req.method === "POST") return await subscribeAndroidVerify(req, env);
      if (p === "/api/subscribe/cancel" && req.method === "POST") return await subscribeCancel(req, env);
      if (p === "/api/wallet/topup/intent" && req.method === "POST") return await walletTopupIntent(req, env);
      if (p === "/api/wallet/topup" && req.method === "POST") return await walletTopup(req, env);
      if ((p === "/webhooks/stripe" || p === "/api/wallet/stripe-webhook") && req.method === "POST") return await stripeWebhook(req, env);
      if (p === "/api/wallet/spend" && req.method === "POST") return await walletSpend(req, env);
      // --- AvaReferral (invite → coins; inviter-only, server-priced reward) ---
      if (p === "/api/referral/claim" && req.method === "POST") return await referralClaim(req, env);
      if (p === "/api/referral/summary" && req.method === "GET") return await referralSummary(req, env);
      if (p === "/api/invite/email" && req.method === "POST") return await inviteEmail(req, env);
      if (p === "/api/feature/costs" && req.method === "GET") return await featureCostsRoute(req, env);
      if (p === "/api/auth/google" && req.method === "POST") return await googleAuth(req, env, ctx);
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

      // --- AvaAdmin dashboard (Phase 6) — read-mostly aggregation + alerts/roles. requireAdmin enforced inside. ---
      if (p === "/api/admin/overview" && req.method === "GET") return await adminOverview(req, env);
      if (p === "/api/admin/live" && req.method === "GET") return await adminLive(req, env);
      if (p === "/api/admin/agents" && req.method === "GET") return await adminAgents(req, env);
      if (p === "/api/admin/health" && req.method === "GET") return await adminHealth(req, env);
      if (p === "/api/admin/analytics" && req.method === "GET") return await adminAnalytics(req, env);
      if (p === "/api/admin/audit" && req.method === "GET") return await adminAuditLog(req, env);
      if (p === "/api/admin/users/search" && req.method === "GET") return await adminUserSearch(req, env);
      if (p === "/api/admin/alerts" && req.method === "GET") return await adminAlerts(req, env);
      if (p === "/api/admin/alerts/evaluate" && req.method === "POST") return await adminAlertEvaluate(req, env);
      { const m = p.match(/^\/api\/admin\/alerts\/([A-Za-z0-9-]{1,64})\/ack$/); if (m && req.method === "POST") return await adminAlertAck(req, env, m[1]); }
      { const m = p.match(/^\/api\/admin\/alerts\/([A-Za-z0-9-]{1,64})\/resolve$/); if (m && req.method === "POST") return await adminAlertResolve(req, env, m[1]); }
      if (p === "/api/admin/alert-rules" && (req.method === "GET" || req.method === "POST")) return await adminAlertRules(req, env);
      { const m = p.match(/^\/api\/admin\/alert-rules\/([A-Za-z0-9-]{1,64})$/); if (m && (req.method === "PUT" || req.method === "DELETE")) return await adminAlertRuleMutate(req, env, m[1]); }
      if (p === "/api/admin/roles" && req.method === "GET") return await adminRoles(req, env);
      { const m = p.match(/^\/api\/admin\/roles\/([A-Za-z0-9_-]{1,64})$/); if (m && req.method === "PUT") return await adminRoleSet(req, env, m[1]); }
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

      // --- AvaVoice: creator-built AI voice agents (Specs/AVAVOICE-PROPOSAL.md) ---
      if (p === "/api/avavoice/voices" && req.method === "GET") return avavoiceVoices();
      if (p === "/api/avavoice/marketplace" && req.method === "GET") return await avavoiceMarketplace(req, env);
      if (p === "/api/avavoice/agents/mine" && req.method === "GET") return await avavoiceMine(req, env);
      if (p === "/api/avavoice/agents" && req.method === "POST") return await avavoiceCreateAgent(req, env);
      if (p === "/api/avavoice/bookings" && req.method === "POST") return await avavoiceBook(req, env);
      if (p === "/api/avavoice/bookings/mine" && req.method === "GET") return await avavoiceMyBookings(req, env);
      if (p === "/api/avavoice/calls/now" && req.method === "POST") return await avavoiceCallNow(req, env);
      if (p === "/api/avavoice/sessions/start" && req.method === "POST") return await avavoiceSessionStart(req, env);
      if (p === "/api/avavoice/sessions/heartbeat" && req.method === "POST") return await avavoiceHeartbeat(req, env);
      if (p === "/api/avavoice/sessions/stop" && req.method === "POST") return await avavoiceSessionStop(req, env);

      // --- Ava Receptionist: premium "Ava answers after 5 rings" (Specs/PROPOSAL-AI-RECEPTIONIST.md) ---
      if (p === "/api/receptionist/settings" && req.method === "GET") return await receptionistGetSettings(req, env);
      if (p === "/api/receptionist/settings" && req.method === "PUT") return await receptionistPutSettings(req, env);
      if (p === "/api/receptionist/config" && req.method === "GET") return await receptionistConfigFor(req, env);
      if (p === "/api/receptionist/start" && req.method === "POST") return await receptionistStart(req, env);
      if (p === "/api/receptionist/finish" && req.method === "POST") return await receptionistFinish(req, env);
      if (p === "/api/receptionist/recording" && req.method === "GET") return await receptionistRecording(req, env);
      if (p === "/api/receptionist/kb" && req.method === "POST") return await receptionistKbUpload(req, env);
      if (p === "/api/receptionist/kb" && req.method === "DELETE") return await receptionistKbClear(req, env);
      {
        const bk = p.match(/^\/api\/avavoice\/bookings\/([A-Za-z0-9-]{1,64})\/cancel$/);
        if (bk && req.method === "POST") return await avavoiceCancelBooking(req, env, bk[1]);
        const af = p.match(/^\/api\/avavoice\/agents\/([A-Za-z0-9-]{1,64})\/files\/([A-Za-z0-9-]{1,64})$/);
        if (af && req.method === "DELETE") return await avavoiceDeleteFile(req, env, af[1], af[2]);
        const aa = p.match(/^\/api\/avavoice\/agents\/([A-Za-z0-9-]{1,64})\/(publish|unpublish|files|availability|stats)$/);
        if (aa) {
          if (aa[2] === "publish" && req.method === "POST") return await avavoicePublish(req, env, aa[1], true);
          if (aa[2] === "unpublish" && req.method === "POST") return await avavoicePublish(req, env, aa[1], false);
          if (aa[2] === "files" && req.method === "POST") return await avavoiceUploadFile(req, env, aa[1]);
          if (aa[2] === "availability" && req.method === "GET") return await avavoiceAvailability(req, env, aa[1]);
          if (aa[2] === "stats" && req.method === "GET") return await avavoiceStats(req, env, aa[1]);
        }
        const ag = p.match(/^\/api\/avavoice\/agents\/([A-Za-z0-9-]{1,64})$/);
        if (ag) {
          if (req.method === "GET") return await avavoiceGetAgent(req, env, ag[1]);
          if (req.method === "PUT") return await avavoiceUpdateAgent(req, env, ag[1]);
          if (req.method === "DELETE") return await avavoiceDeleteAgent(req, env, ag[1]);
        }
      }

      // --- AvaVision: creator-built AI VISION coaching agents (Specs/AVAVISION-PROPOSAL.md) ---
      if (p === "/api/avavision/templates" && req.method === "GET") return avavisionTemplates(req, env);
      if (p === "/api/avavision/voices" && req.method === "GET") return avavisionVoices();
      if (p === "/api/avavision/marketplace" && req.method === "GET") return await avavisionMarketplace(req, env);
      if (p === "/api/avavision/agents/mine" && req.method === "GET") return await avavisionMine(req, env);
      if (p === "/api/avavision/agents" && req.method === "POST") return await avavisionCreateAgent(req, env);
      if (p === "/api/avavision/bookings" && req.method === "POST") return await avavisionBook(req, env);
      if (p === "/api/avavision/bookings/mine" && req.method === "GET") return await avavisionMyBookings(req, env);
      if (p === "/api/avavision/calls/now" && req.method === "POST") return await avavisionCallNow(req, env);
      if (p === "/api/avavision/sessions/start" && req.method === "POST") return await avavisionSessionStart(req, env);
      if (p === "/api/avavision/sessions/token" && req.method === "POST") return await avavisionSessionToken(req, env);
      if (p === "/api/avavision/sessions/heartbeat" && req.method === "POST") return await avavisionHeartbeat(req, env);
      if (p === "/api/avavision/sessions/stop" && req.method === "POST") return await avavisionSessionStop(req, env);
      if (p === "/api/avavision/snapshot" && req.method === "POST") return await avavisionSnapshot(req, env);
      {
        const bk = p.match(/^\/api\/avavision\/bookings\/([A-Za-z0-9-]{1,64})\/cancel$/);
        if (bk && req.method === "POST") return await avavisionCancelBooking(req, env, bk[1]);
        const af = p.match(/^\/api\/avavision\/agents\/([A-Za-z0-9-]{1,64})\/files\/([A-Za-z0-9-]{1,64})$/);
        if (af && req.method === "DELETE") return await avavisionDeleteFile(req, env, af[1], af[2]);
        const aa = p.match(/^\/api\/avavision\/agents\/([A-Za-z0-9-]{1,64})\/(publish|unpublish|files|availability|stats)$/);
        if (aa) {
          if (aa[2] === "publish" && req.method === "POST") return await avavisionPublish(req, env, aa[1], true);
          if (aa[2] === "unpublish" && req.method === "POST") return await avavisionPublish(req, env, aa[1], false);
          if (aa[2] === "files" && req.method === "POST") return await avavisionUploadFile(req, env, aa[1]);
          if (aa[2] === "availability" && req.method === "GET") return await avavisionAvailability(req, env, aa[1]);
          if (aa[2] === "stats" && req.method === "GET") return await avavisionStats(req, env, aa[1]);
        }
        const ag = p.match(/^\/api\/avavision\/agents\/([A-Za-z0-9-]{1,64})$/);
        if (ag) {
          if (req.method === "GET") return await avavisionGetAgent(req, env, ag[1]);
          if (req.method === "PUT") return await avavisionUpdateAgent(req, env, ag[1]);
          if (req.method === "DELETE") return await avavisionDeleteAgent(req, env, ag[1]);
        }
      }

      // --- Speech-to-text (OpenAI Whisper via OpenRouter; replaced on-device sherpa) ---
      if (p === "/api/stt/transcribe" && req.method === "POST") return await sttTranscribe(req, env);

      // --- Live voice translation (Gemini 3.5 Live Translate; $3/h AvaCoins) ---
      if (p === "/api/translate/quote" && req.method === "GET") return translateQuote(req);
      if (p === "/api/translate/start" && req.method === "POST") return await translateStart(req, env);
      {
        const tr = p.match(/^\/api\/translate\/([A-Za-z0-9-]{1,64})\/(beat|stop|token)$/);
        if (tr && req.method === "POST") {
          if (tr[2] === "beat") return await translateBeat(req, env, tr[1]);
          if (tr[2] === "stop") return await translateStop(req, env, tr[1]);
          if (tr[2] === "token") return await translateToken(req, env, tr[1]);
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
      // Creator insights dashboards (owner-gated).
      if (p === "/api/creators/me/stats" && req.method === "GET") return await creatorStats(req, env);
      {
        const ls = p.match(/^\/api\/listings\/([A-Za-z0-9-]{1,64})\/stats$/);
        if (ls && req.method === "GET") return await listingStats(req, env, ls[1]);
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

      // --- AvaAffiliate (Specs/proposals/PROPOSAL-AVA-AFFILIATE.md) ---
      // Public click route: telemetry → pending-attribution KV → preview/deep link.
      {
        const ac = p.match(/^\/a\/([A-Za-z0-9_-]{4,32})$/);
        if (ac && req.method === "GET") return await affiliateClick(req, env, ac[1]);
      }
      if (p === "/api/affiliate/register" && req.method === "POST") return await affiliateRegister(req, env);
      if (p === "/api/affiliate/me" && req.method === "GET") return await affiliateMe(req, env);
      if (p === "/api/affiliate/listings" && req.method === "GET") return await affiliateListings(req, env);
      if (p === "/api/affiliate/links" && req.method === "POST") return await affiliateLinkCreate(req, env);
      if (p === "/api/affiliate/links" && req.method === "GET") return await affiliateLinks(req, env);
      if (p === "/api/affiliate/bind" && req.method === "POST") return await affiliateBind(req, env);
      {
        const al = p.match(/^\/api\/affiliate\/links\/([A-Za-z0-9_-]{4,32})\/(stats|subscribers|pause|assets)$/);
        if (al) {
          if (al[2] === "stats" && req.method === "GET") return await affiliateLinkStats(req, env, al[1]);
          if (al[2] === "subscribers" && req.method === "GET") return await affiliateLinkSubscribers(req, env, al[1]);
          if (al[2] === "pause" && req.method === "POST") return await affiliateLinkPause(req, env, al[1]);
          // v2 marketing-asset kit (Nano Banana 2; flag affiliateAssetKitEnabled)
          if (al[2] === "assets" && req.method === "POST") return await affiliateAssetsGenerate(req, env, al[1]);
          if (al[2] === "assets" && req.method === "GET") return await affiliateAssetsList(req, env, al[1]);
        }
        if (p === "/api/admin/affiliates" && req.method === "GET") return await adminAffiliates(req, env);
        const as = p.match(/^\/api\/admin\/affiliates\/([A-Za-z0-9_:-]{1,64})\/suspend$/);
        if (as && req.method === "POST") return await adminAffiliateSuspend(req, env, as[1]);
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
