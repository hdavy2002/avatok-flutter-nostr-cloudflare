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
import { deleteAccount, cancelDeletion, deletionStatus } from "./routes/account";
// [AVADIAL-CALL-INTEL-1] Call-intelligence ingest. The ONLY place raw E.164 and the
// HMAC secret meet — the device never holds the key. See routes/telemetry_calls.ts.
import { ingestCallTelemetry } from "./routes/telemetry_calls";
// [AVA-IDGATE-1] idSession / idResult / idPhoneConfirm are NO LONGER ROUTED — they
// minted verification without a Didit check. See LEGACY_GONE in the router.
import { idStatus, idEmailStart, idEmailVerify, idPasswordStart, idPasswordSet } from "./routes/id";
import { walletTopup, walletTopupIntent, walletTopupPlayVerify, stripeWebhook, walletSpend, walletBalance, walletTransactions, walletEarnings, walletLive, walletLedger, walletLedgerDetail, walletReceiptResend } from "./routes/wallet";
import { adminLedger, adminRefund, adminAdjust, adminAccount, adminRecon, adminEscrowHold, adminEscrowRelease, adminTaxExport, adminFailedSettlements, adminRetrySettlement, requireAdmin } from "./routes/admin_money";
import { liveStart, liveStop, liveJoin, liveRoom, liveDonate, liveMod, liveState } from "./routes/live";
import { consultJoin, consultRoom, consultSfu, consultComplete, consultCancel, consultExtend, consultProbe, consultProbeBlob } from "./routes/consult";
import { runMoney, moneyDlq, type MoneyMsg } from "./money_engine";
import { setTestClock } from "./clock";
import { stripeIdentityWebhook, agreementStatus, agreementDoc, agreementAccept } from "./routes/kyc";
// [AVA-IDGATE-1] The V2/V3 HTTP entrypoints are no longer routed (LEGACY_GONE).
// The queue consumers stay imported: in-flight messages must still drain cleanly.
// Nothing enqueues new ones now that the routes are closed.
import { runLivenessChecks } from "./routes/liveness";
import { runLivenessV3Checks } from "./routes/liveness_v3";
import { diditSession, diditResult, diditDone, diditWebhook, connectorsDone, livenessConsent } from "./routes/liveness_didit";
import * as hooks from "./hooks"; // [AVA-IDGATE-1] legacy-route telemetry

// [AVA-IDGATE-1] Routes closed 2026-07-10. Each previously called setVerifiedCache(),
// so each could mark a user "verified" without a Didit liveness check ever running —
// the flag the entire deterrence model rests on. 410 + telemetry, never silently 404.
const LEGACY_GONE = new Set<string>([
  "/api/id/session",            // id.ts — Rekognition Face Liveness session
  "/api/id/result",             // id.ts — auto-verified at >=90% confidence
  "/api/id/phone/confirm",      // id.ts — phone OTP; all phone verification removed
  "/api/id/liveness/start",     // liveness.ts — Workers AI provider
  "/api/id/liveness/upload",
  "/api/id/liveness/verify",
  "/api/id/liveness/result",
  "/api/liveness/v3/session",   // liveness_v3.ts — policy engine
  "/api/liveness/v3/upload",
  "/api/liveness/v3/verify",
  "/api/liveness/v3/result",
]);
import { guestCreate, guestHandleCheck, guestUpgrade, getIdentityLevel } from "./routes/ladder";
import { createSlot, listSlots, cancelSlot, bookSlot, cancelBooking, listEvents, listBlocks, getRules, putRules, getTime } from "./routes/calendar";
import { listBookings, getPolicies, putPolicies, proposeReschedule, respondReschedule, listReschedules, joinInfo } from "./routes/booking";
import { gcalConnect, gcalCallback, gcalStatus, gcalDisconnect, gcalWebhook } from "./cal/gcal";
import { payoutSetup, payoutAccounts, payoutRequest, payoutStatus, wiseWebhook } from "./routes/payout";
import { olxCreate, olxBrowse, olxGet, olxUpdate, olxDelete, olxUploadFile, olxBuy, olxRefund, olxDownloads, olxDownloadFile } from "./routes/olx";
import { listPersonas, upsertPersona, converse, getInbox, getInboxItem, approveInbox, agentTask } from "./routes/agent";
import { agentTts, agentAudio } from "./routes/agent_tts";
import { listNotifications, unreadCount, markRead, clearNotifications } from "./routes/notifications";
import { wsInbox, wsParty, sendMsg, syncMsg, receiptMsg, readMsg, hideMsg, reactMsg, stateMsg, pollVote, pollState, convList, convCreate, convAdopt, convMembers, convAddMembers, convRemoveMember, convSetRole, convSetAvatar, convLeave, convDelete, convInvites, convInviteRespond, callLogAppend, callLogDelete, callLogClear } from "./routes/messaging";
import { archiveList, archivePage } from "./routes/archive";
import { getAutoResponder, putAutoResponder } from "./routes/auto_responder"; // STREAM F — away auto-responder settings
import { getConfig, putConfig, readConfig } from "./routes/config";
import { createConversation, listConversations, getParticipants } from "./routes/conversations2";
import { getPlans } from "./routes/plans";
import * as num from "./routes/number";
import * as keybk from "./routes/keybackup";
import * as cbook from "./routes/contacts_backup";
import * as team from "./routes/team";
import { subscribeCheckout, subscribeAndroidVerify, subscribeCancel } from "./routes/subscribe";
import { referralClaim, referralSummary } from "./routes/referral";
import { inviteEmail } from "./routes/invite";
// [WP2] Paid-call escrow/settlement routes (plan §3B/§11/§15.3)
import { getPaidCallOfferRoute, getPaidCallSettingsRoute, putPaidCallSettingsRoute, preparePaidCallRoute, confirmPaidCallRoute, cancelPaidCallRoute } from "./routes/call_billing_routes";
// [WP3] Agent Profiles + service numbers (plan §4/§7/§8b/§12.5/§12.8/§12.10).
import { getAgentSettings, putAgentSettings, listAgentServices, createAgentService, updateAgentService, deleteAgentService, listAgentCalls, getAgentCallTranscript } from "./routes/agent_profiles";
// [WP3] Voicemail bot session start (plan §3 step 4 / §7 item 5 / §15.5).
import { voicemailStart, voicemailRecording } from "./routes/voicemail_routes";
import { pstnRoute } from "./routes/pstn";
// [WP4] Ava AI Voice Agent — Grok realtime session start (plan §4/§8/§15.1/§15.3).
import { agentCallStart } from "./routes/agent_voice_routes";
// [WP4] RAG document pipeline — Grok Collections (plan §5/§9).
import { uploadAgentDoc, listAgentDocs, deleteAgentDoc } from "./routes/agent_docs";
import { featureCostsRoute } from "./feature_pricing";
import { googleAuth } from "./routes/google_auth";
import { conferenceStart, conferenceJoin, conferenceStatus, conferenceEnd, conferenceWebhook, conferenceBeat } from "./routes/conference";
import { groupCallJoin, groupCallPublish, groupCallPull, groupCallRenegotiate, groupCallClose, groupCallStatus } from "./routes/groupcall";
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
  marketplaceAiAssist, marketplaceNegotiate, marketplaceNegotiateState,
  marketplaceSearch, marketplacePrecheck, marketplaceAudio,
} from "./routes/marketplace";
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
import { avaRagIngest, avaRagStore, avaRagSearch, avaRagBackfill, avaThreadSearch } from "./routes/ava_rag"; // RAG (Cloudflare AI Search)
import { avaAppsCatalog, avaAppsConnect, avaAppsDisconnect, avaAppsStatus, avaAppsRun, avaGenuiAction } from "./routes/ava_apps"; // AvaApps (Composio)
import { avaGenuiThumb } from "./routes/genui_thumb"; // GenUI preview-thumbnail proxy
import { avaEmailList, avaEmailGet, avaEmailSpam, avaEmailTrash, avaEmailReply } from "./routes/ava_email"; // in-chat email (Composio Gmail)
import { driveStatus, driveListRoute, driveUploadRoute, driveBackupEnsureRoute, driveBackupUploadRoute, driveBackupDownloadRoute, driveBackupListRoute } from "./routes/ava_drive"; // AvaTOK Drive storage
import { avaChatHistorySave, avaChatHistoryGet, avaChatHistoryMeta } from "./routes/ava_chat_history"; // AvaChat history (D1)
import { avaThreadTurn } from "./routes/ava_thread";    // P3
import { avaGuardianScan } from "./routes/ava_guardian"; // P8
import { moderateText } from "./routes/moderate";        // save-time content validation (Nemotron)
import { avaImage } from "./routes/ava_image";          // P9
import { avaDocSummarize, avaDocTranslate, avaDocTranslateFile, avaChatToggle } from "./routes/ava_copilot"; // Copilot A+B (doc actions + per-chat toggle)
import { avaTriggersGet, avaLedgerGet, avaMomentOutcome } from "./routes/ava_odl_routes"; // Copilot C+D (ODL trigger sync D31 + cost ledger D25 + learning loop)
import { backupGet, backupPut, backupStatus } from "./routes/backup"; // P10
import { ringtone } from "./routes/ringtone"; // AI ringback tones + busy tone
import { spamReport, spamLookup, spamBloom, spamRescore } from "./routes/spam"; // AvaDial spam shield (Phase 2a, dark behind spamShield)
import { missedCallToken, missedCallLookup } from "./routes/missedcall"; // [AVA-MISSEDCALL-1] device-token lane (dark behind missedCallOverlay)
import { homeCards } from "./routes/homecards"; // Home dashboard card aggregates (Phase 3, dark behind shellV2)
import { delegateHandler } from "./routes/ava_delegate"; // P7 (Phase 11 route wiring)
// --- AI Messenger Batch 2026-07-03 (Streams A/B/C/E/F/G/I) ---
import { marketplaceAgentSettingsGet, marketplaceAgentSettingsPut } from "./routes/agent_settings"; // STREAM A
import { convAccept, convBlock, safetyReport, convAcceptState } from "./routes/safety";              // STREAM B
import { unfurl } from "./routes/unfurl";                                                            // STREAM C
import { gifSearch, gifTrending } from "./routes/gif";                                               // STREAM E
import { getAutoResponder, putAutoResponder } from "./routes/auto_responder";                        // STREAM F
import { aiCatchup, aiSmartReplies, aiTranslate, aiGroupTranslate, safetyScore, aiBio, aiGender } from "./routes/ai_chat"; // STREAM G + bio writer + gender infer
import { forwardMsg } from "./routes/messaging";                                                     // STREAM I
import { addFavorite, removeFavorite, listFavorites } from "./routes/listings";                       // STREAM K

export { CallRoom } from "./do/call_room";
export { MeshRoom } from "./do/mesh_room";
export { GroupCallRoom } from "./do/group_call_room"; // CF Realtime SFU group AUDIO (≤32)
export { InboxDO } from "./do/inbox";
// Dormant call-state control-plane authority (Phase A plumbing only — no
// route reads/writes it yet). Specs/CALL-CONTROL-PLANE-UNIFIED-PLAN.md.
export { CallStateAuthorityDO } from "./do/call_state_authority";
export { SentinelDO } from "./sentinel/do"; // Guardian Sentinel S1 hot-cache DO (DARK behind sentinelEnabled)
export { PartyDO } from "./do/party"; // PartyKit realtime layer (ephemeral; replaces Ably)
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
export { ReceptionRoom } from "./do/reception_room"; // Ava Receptionist call bridge (Gemini engine)
export { ReceptionRoomCf } from "./do/reception_room_cf"; // Ava Receptionist — Cloudflare-native engine (separate)
export { VoicemailRoom } from "./do/voicemail_room"; // [WP3] carrier-style voicemail bot (dark behind voicemailBot)
export { AgentVoiceRoom } from "./do/agent_voice_room"; // [WP4] Ava AI Voice Agent — Grok realtime bridge (dark behind voiceAgent)

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
  //
  // [LIVE-QUEUE-1] this worker ALSO self-consumes liveness-verify (see
  // wrangler.toml [[queues.consumers]]) — same self-consuming pattern as
  // money-settlements, for the same reason: runLivenessChecks can't be imported
  // into consumers/ (worker↔consumers package split). Each message is
  // {uid, sid}; req is undefined (no live HTTP request in a queue consumer) —
  // runLivenessChecks already treats a missing req as "no edge geo" (see the
  // device ctx comment inside it), so this is a safe, already-handled case.
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        if (batch.queue.startsWith("money-dlq")) {
          await moneyDlq(env, msg.body);
        } else if (batch.queue.startsWith("contacts-chunk")) {
          // Contact-book chunking (dormant until a CONTACTS queue is bound; today
          // the chunk job runs inline via ctx.waitUntil in contacts_backup.ts).
          await cbook.contactsChunkConsume(env, msg.body);
        } else if (batch.queue.startsWith("liveness-verify")) {
          // [LIVENESS-V3] the shared liveness-verify queue now carries BOTH V2
          // ({uid,sid}) and V3 ({v3:true,uid,sid}) messages. Discriminate on the
          // `v3` flag so V3 dispatches to runLivenessV3Checks (its own deterministic
          // Rekognition pipeline) while V2 stays on runLivenessChecks unchanged.
          const m = msg.body as { v3?: boolean; uid: string; sid: string };
          if (m.v3) await runLivenessV3Checks(env, m.uid, m.sid, undefined);
          else await runLivenessChecks(env, m.uid, m.sid, undefined);
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

    // CF Realtime SFU group AUDIO (≤32, audio-only, active-speaker). WS →
    // GroupCallRoom DO (roster + active-speaker fan-out); HTTP → SFU session/
    // track proxy (routes/groupcall.ts, app token stays server-side). Gated by
    // groupAudioSfuEnabled (dormant; LiveKit /api/conference/* stays live until
    // flipped). Keyed by group id so all members meet on one room instance.
    const gc = p.match(/^\/api\/groupcall\/([A-Za-z0-9_:.-]{1,64})\/(join|publish|pull|renegotiate|close|status|ws)$/);
    if (gc) {
      const groupId = gc[1];
      if (gc[2] === "ws") {
        const hint = continentHint(req);
        return env.GROUP_CALL_ROOMS.get(env.GROUP_CALL_ROOMS.idFromName(groupId), hint ? { locationHint: hint } : undefined).fetch(req);
      }
      if (gc[2] === "join" && req.method === "POST") return await groupCallJoin(req, env, groupId);
      if (gc[2] === "publish" && req.method === "POST") return await groupCallPublish(req, env, groupId);
      if (gc[2] === "pull" && req.method === "POST") return await groupCallPull(req, env, groupId);
      if (gc[2] === "renegotiate" && req.method === "PUT") return await groupCallRenegotiate(req, env, groupId);
      if (gc[2] === "close" && req.method === "POST") return await groupCallClose(req, env, groupId);
      if (gc[2] === "status" && req.method === "GET") return await groupCallStatus(req, env, groupId);
    }

    // Cloudflare-native messaging — live socket → caller's InboxDO (Nostr deprecated).
    if (p === "/api/inbox" && req.headers.get("Upgrade") === "websocket") return await wsInbox(req, env);

    // PartyKit realtime layer (ephemeral; replaces Ably) — one hibernatable
    // WebSocket per room → PartyDO. Room passed as ?room=<type:id>.
    if (p === "/api/party" && req.headers.get("Upgrade") === "websocket") return await wsParty(req, env);

    // Ava Receptionist call bridge → ReceptionRoom DO (thin router; the DO
    // validates the one-time rtc token from KV). Keyed by session id so caller +
    // DO meet on the same instance. See Specs/PROPOSAL-AI-RECEPTIONIST.md.
    if (p === "/api/receptionist/rtc" && req.headers.get("Upgrade") === "websocket") {
      const sid = url.searchParams.get("session") || "";
      if (!sid) return new Response("session required", { status: 400 });
      const hint = continentHint(req);
      // Engine routing: /start stamps `&engine=cf` on the WS URL when the
      // receptionistUseCf flag is on, so the SAME client connects to the
      // Cloudflare-native DO; otherwise the Gemini ReceptionRoom (unchanged).
      if (url.searchParams.get("engine") === "cf") {
        return env.RECEPTION_ROOM_CF.get(env.RECEPTION_ROOM_CF.idFromName(sid), hint ? { locationHint: hint } : undefined).fetch(req);
      }
      return env.RECEPTION_ROOM.get(env.RECEPTION_ROOM.idFromName(sid), hint ? { locationHint: hint } : undefined).fetch(req);
    }

    // Voicemail bot bridge → VoicemailRoom DO (WP3, plan §3 step 4 / §7 item 5).
    // Same thin-router pattern as the receptionist WS above; the DO validates
    // the one-time rtc token from KV. Dark unless a session was actually
    // started via POST /api/voicemail/start (which itself 503s when
    // voicemailBot is off), so this route is inert while the flag is off.
    if (p === "/api/voicemail/rtc" && req.headers.get("Upgrade") === "websocket") {
      const sid = url.searchParams.get("session") || "";
      if (!sid) return new Response("session required", { status: 400 });
      const hint = continentHint(req);
      return env.VOICEMAIL_ROOM.get(env.VOICEMAIL_ROOM.idFromName(sid), hint ? { locationHint: hint } : undefined).fetch(req);
    }

    // Ava AI Voice Agent bridge → AgentVoiceRoom DO (WP4, plan §4/§7 item 7).
    // Same thin-router pattern as voicemail/receptionist above. Dark unless a
    // session was started via POST /api/agent/call/start (which itself 503s
    // when voiceAgent is off).
    if (p === "/api/agent/call/rtc" && req.headers.get("Upgrade") === "websocket") {
      const sid = url.searchParams.get("session") || "";
      if (!sid) return new Response("session required", { status: 400 });
      const hint = continentHint(req);
      return env.AGENT_VOICE_ROOMS.get(env.AGENT_VOICE_ROOMS.idFromName(sid), hint ? { locationHint: hint } : undefined).fetch(req);
    }

    try {
      // --- messaging (Cloudflare-native; Clerk-JWT auth, server-readable) ---
      if (p === "/api/msg/send" && req.method === "POST") return await sendMsg(req, env);
      if (p === "/api/msg/sync" && req.method === "GET") return await syncMsg(req, env);
      // Phase 3 (ABLY-R2-3): deep history from R2/D1 (older than Ably's window).
      if (p === "/api/msg/archive" && req.method === "GET") return await archiveList(req, env);
      if (p === "/api/archive/page" && req.method === "GET") return await archivePage(req, env); // P8 Stage 2: batched-jsonl pager
      if (p === "/api/msg/receipt" && req.method === "POST") return await receiptMsg(req, env);
      if (p === "/api/msg/read" && req.method === "POST") return await readMsg(req, env);
      if (p === "/api/msg/hide" && req.method === "POST") return await hideMsg(req, env);
      // Phase 4 (ABLY-R2-4): persist a per-message reaction (live ride is Ably).
      if (p === "/api/msg/react" && req.method === "POST") return await reactMsg(req, env);
      // Phase 5 (ABLY-R2-5): owner-private state from D1 (read/hidden/call-log).
      if (p === "/api/msg/state" && req.method === "GET") return await stateMsg(req, env);
      // 2026-07-04: server-persisted poll votes (survive reinstall/backup).
      if (p === "/api/poll/vote" && req.method === "POST") return await pollVote(req, env);
      if (p === "/api/poll/state" && req.method === "GET") return await pollState(req, env);
      // Call-log multi-device sync (owner's own InboxDO; delete/clear wake asleep devices).
      if (p === "/api/call-log/append" && req.method === "POST") return await callLogAppend(req, env);
      if (p === "/api/call-log/delete" && req.method === "POST") return await callLogDelete(req, env);
      if (p === "/api/call-log/clear" && req.method === "POST") return await callLogClear(req, env);
      if (p === "/api/conversations" && req.method === "GET") return await convList(req, env);
      if (p === "/api/conversations" && req.method === "POST") return await convCreate(req, env);
      if (p === "/api/conversations/adopt" && req.method === "POST") return await convAdopt(req, env);
      // --- v4 server-authoritative routing path (ARCH-ROUTING-V2) — ADDITIVE and
      //     DORMANT behind the routingV2Enabled kill switch. Strangler pattern: this
      //     coexists with the legacy /api/conversations + /api/msg/send path above
      //     and NOTHING here executes until the flag is flipped ON in KV per-cohort.
      //     Frozen architecture: Specs/ROUTING-IDENTITY-PRESENCE-ARCH.md.
      if (p.startsWith("/api/v2/")) {
        const cfg = await readConfig(env);
        if (!cfg.routingV2Enabled) return json({ error: "v2_disabled" }, 404);
        if (p === "/api/v2/conversations" && req.method === "POST") return await createConversation(req, env);
        if (p === "/api/v2/conversations" && req.method === "GET") return await listConversations(req, env);
        if (p === "/api/v2/conversations/participants" && req.method === "GET") return await getParticipants(req, env);
        return json({ error: "not found" }, 404);
      }
      // Group membership management (Group Info screen).
      if (p === "/api/conversations/members" && req.method === "GET") return await convMembers(req, env);
      if (p === "/api/conversations/members/add" && req.method === "POST") return await convAddMembers(req, env);
      if (p === "/api/conversations/invites" && req.method === "GET") return await convInvites(req, env);
      if (p === "/api/conversations/invite/respond" && req.method === "POST") return await convInviteRespond(req, env);
      if (p === "/api/conversations/members/remove" && req.method === "POST") return await convRemoveMember(req, env);
      if (p === "/api/conversations/members/role" && req.method === "POST") return await convSetRole(req, env);
      // [GROUP-AVATAR-1] Set/clear a group photo (admins only; '' clears).
      if (p === "/api/conversations/avatar" && req.method === "POST") return await convSetAvatar(req, env);
      if (p === "/api/conversations/leave" && req.method === "POST") return await convLeave(req, env);
      if (p === "/api/conversations/delete" && req.method === "POST") return await convDelete(req, env);
      // --- AI Messenger Batch 2026-07-03 route mounts ---
      // STREAM I: unlimited forwarding (no-copy fan-out; requires liveness when gate ON)
      if (p === "/api/msg/forward" && req.method === "POST") return await forwardMsg(req, env);
      // STREAM B: stranger safety gate (accept/block/report + accept-state)
      if (p === "/api/conversations/accept" && req.method === "POST") return await convAccept(req, env);
      if (p === "/api/conversations/block" && req.method === "POST") return await convBlock(req, env);
      if (p === "/api/conversations/accept-state" && (req.method === "GET" || req.method === "POST")) return await convAcceptState(req, env);
      if (p === "/api/safety/report" && req.method === "POST") return await safetyReport(req, env);
      // STREAM A: marketplace agent settings
      if (p === "/api/marketplace/agent-settings" && req.method === "GET") return await marketplaceAgentSettingsGet(req, env);
      if (p === "/api/marketplace/agent-settings" && req.method === "PUT") return await marketplaceAgentSettingsPut(req, env);
      // STREAM K: marketplace favorites
      if (p === "/api/marketplace/favorites" && req.method === "POST") return await addFavorite(req, env);
      if (p === "/api/marketplace/favorites" && req.method === "DELETE") return await removeFavorite(req, env);
      if (p === "/api/marketplace/favorites" && req.method === "GET") return await listFavorites(req, env);
      // STREAM C: server-side link unfurl (zero recipient-side fetch)
      if (p === "/api/unfurl" && req.method === "GET") return await unfurl(req, env);
      // STREAM E: Tenor GIF proxy (key stays server-side)
      if (p === "/api/gif/search" && req.method === "GET") return await gifSearch(req, env);
      if (p === "/api/gif/trending" && req.method === "GET") return await gifTrending(req, env);
      // STREAM F: auto-responder settings
      if (p === "/api/auto-responder" && req.method === "GET") return await getAutoResponder(req, env);
      if (p === "/api/auto-responder" && req.method === "PUT") return await putAutoResponder(req, env);
      // STREAM G: AI-in-chats (catchup / smart-replies / translate / group-translate / safety score)
      if (p === "/api/ai/catchup" && req.method === "POST") return await aiCatchup(req, env);
      if (p === "/api/ai/smart-replies" && req.method === "POST") return await aiSmartReplies(req, env);
      if (p === "/api/ai/translate" && req.method === "POST") return await aiTranslate(req, env);
      if (p === "/api/ai/group-translate" && req.method === "POST") return await aiGroupTranslate(req, env);
      if (p === "/api/safety/score" && req.method === "POST") return await safetyScore(req, env);
      // Profile: AI "write my bio" (moderated in + out)
      if (p === "/api/ai/bio" && req.method === "POST") return await aiBio(req, env);
      // Profile: AI gender-from-name (prefill + lock the pronoun field)
      if (p === "/api/ai/gender" && req.method === "POST") return await aiGender(req, env);

      // STREAM F — auto-responder ("Ava replies while you're away") per-user settings.
      if (p === "/api/auto-responder" && req.method === "GET") return await getAutoResponder(req, env);
      if (p === "/api/auto-responder" && req.method === "PUT") return await putAutoResponder(req, env);

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
      if (p === "/api/brain/thread-search" && req.method === "POST") return await avaThreadSearch(req, env); // in-thread smart (semantic) search
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
      if (p === "/api/ava/drive/backup/list" && req.method === "GET") return await driveBackupListRoute(req, env);
      if (p === "/api/ava/chat/history/meta" && req.method === "POST") return await avaChatHistoryMeta(req, env);
      if (p === "/api/ava/chat/history" && req.method === "POST") return await avaChatHistorySave(req, env);
      if (p === "/api/ava/chat/history" && req.method === "GET") return await avaChatHistoryGet(req, env);
      if (p === "/api/ava/guardian/scan" && req.method === "POST") return await avaGuardianScan(req, env); // P8
      if (p === "/api/moderate" && req.method === "POST") return await moderateText(req, env);         // save-time content validation (Nemotron)
      if (p === "/api/ava/image" && req.method === "POST") return await avaImage(req, env);            // P9
      if (p === "/api/ava/delegate") return await delegateHandler(req, env); // P7 (GET reads prefs, POST writes)
      if (p === "/api/ava/doc/summarize" && req.method === "POST") return await avaDocSummarize(req, env);        // Copilot A+B
      if (p === "/api/ava/doc/translate" && req.method === "POST") return await avaDocTranslate(req, env);        // Copilot A+B
      if (p === "/api/ava/doc/translate-file" && req.method === "POST") return await avaDocTranslateFile(req, env); // Copilot A+B
      if (p === "/api/ava/chat-toggle" && (req.method === "GET" || req.method === "POST")) return await avaChatToggle(req, env); // D29 per-chat Ava toggle
      if (p === "/api/ava/triggers" && req.method === "GET") return await avaTriggersGet(req, env);        // ODL: on-device trigger bank sync (D31)
      if (p === "/api/ava/ledger" && req.method === "GET") return await avaLedgerGet(req, env);            // ODL: capability cost ledger snapshot (D25)
      if (p === "/api/ava/moment-outcome" && req.method === "POST") return await avaMomentOutcome(req, env); // ODL: learning loop outcome (Constitution 11)
      // Backup & sync (P10): GET pull, PUT push, GET status.
      if (p === "/api/backup/status" && req.method === "GET") return await backupStatus(req, env);
      if (p === "/api/backup" && req.method === "GET") return await backupGet(req, env);
      if (p === "/api/backup" && req.method === "PUT") return await backupPut(req, env);

      // AI Ringback Tones + Busy Tone — generation + 5-item library.
      // /api/ringtone/{generate|list|user/<uid>/default|<id>/default|<id>}
      if (p.startsWith("/api/ringtone/")) return await ringtone(req, env, p.slice("/api/ringtone/".length));

      // --- AvaDial community spam shield (Phase 2a; DARK behind spamShield) ---
      if (p === "/api/spam/report" && req.method === "POST") return await spamReport(req, env);
      if (p.startsWith("/api/spam/lookup/") && req.method === "GET") return await spamLookup(req, env, ctx, p.slice("/api/spam/lookup/".length));
      if (p === "/api/spam/bloom" && req.method === "GET") return await spamBloom(req, env);
      if (p === "/api/spam/rescore" && req.method === "POST") return await spamRescore(req, env);

      // --- Home dashboard card aggregates (Phase 3; DARK behind shellV2) ---
      if (p === "/api/home/cards" && req.method === "GET") return await homeCards(req, env, ctx);

      // --- directory ---
      if (p === "/api/profile" && req.method === "POST") return await api.profileUpsert(req, env);
      if (p === "/api/me" && req.method === "GET") return await api.me(req, env);
      if (p === "/api/vault" && req.method === "POST") return await api.vaultPut(req, env);
      if (p === "/api/vault" && req.method === "GET") return await api.vaultGet(req, env);
      // Account key escrow — makes the aek (and thus every uid-keyed vault blob)
      // recoverable on reinstall / new phone. See routes/keybackup.ts.
      if (p === "/api/keybackup" && req.method === "POST") return await keybk.keyBackupPut(req, env);
      if (p === "/api/keybackup" && req.method === "GET") return await keybk.keyBackupGet(req, env);
      // Two-tier cache: L1 = 60s per-colo edge response cache; L2 = 30-min KV
      // read-through (survives across requests/colos, keyed by hashed query). The
      // DB query behind a miss is now index-only. Hot entities → instant.
      if (p === "/api/resolve" && req.method === "GET") return await cached(req, ctx, () => api.withSearchCache(req, env, () => api.resolve(req, env)), 60);
      if (p === "/api/search" && req.method === "GET") return await cached(req, ctx, () => api.withSearchCache(req, env, () => api.search(req, env)), 60);
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
      if (p === "/api/number/private" && req.method === "POST") return await num.privateNumberSet(req, env);
      if (p === "/api/add" && req.method === "GET") return await cached(req, ctx, () => num.addResolve(req, env), 30);

      // --- Team Receptionist (IVR / auto-attendant; Specs/TEAM-RECEPTIONIST-IVR-SPEC.md) ---
      if (p === "/api/team" && req.method === "POST") return await team.teamCreate(req, env);
      if (p === "/api/team" && req.method === "GET") return await team.teamGet(req, env);
      if (p === "/api/team" && req.method === "PUT") return await team.teamUpdate(req, env);
      if (p === "/api/team/members" && req.method === "POST") return await team.teamMemberAdd(req, env);
      if (p.startsWith("/api/team/members/") && req.method === "PUT") return await team.teamMemberUpdate(req, env, p.slice("/api/team/members/".length));
      if (p.startsWith("/api/team/members/") && req.method === "DELETE") return await team.teamMemberRemove(req, env, p.slice("/api/team/members/".length));
      if (p === "/api/team/invite/accept" && req.method === "POST") return await team.teamInviteAccept(req, env);
      if (p === "/api/team/invite/decline" && req.method === "POST") return await team.teamInviteDecline(req, env);
      if (p === "/api/team/messages" && req.method === "GET") return await team.teamMessages(req, env);
      if (p === "/api/team/ivr" && req.method === "GET") return await team.teamIvrMenu(req, env);
      if (p === "/api/team/ivr/audio" && req.method === "GET") return await team.teamIvrAudio(req, env);
      if (p === "/api/team/ivr/route" && req.method === "POST") return await team.teamIvrRoute(req, env);

      // --- push / calls ---
      if (p === "/api/register" && req.method === "POST") return await api.register(req, env);
      // [MULTIACCT-2] flip an account's device mapping on switch/logout (device token stays)
      if (p === "/api/account/device" && req.method === "POST") return await api.accountDevice(req, env);
      if (p === "/api/call" && req.method === "POST") return await api.call(req, env);
      if (p === "/api/notify" && req.method === "POST") return await api.notify(req, env);
      if (p === "/api/call-status" && req.method === "POST") return await api.callStatus(req, env);
      if (p === "/api/call/ringing" && req.method === "POST") return await api.callRinging(req, env);
      if (p === "/api/call/notify-register" && req.method === "POST") return await api.callNotifyRegister(req, env);
      // [WP3-ACT-1] After-ring routing decision (plan §3 step 4) — 503 unless businessCallUx is on.
      if (p === "/api/call/no-answer" && req.method === "POST") return await api.callNoAnswer(req, env);
      // [WP2] Paid calls (plan §3B/§11/§15.3) — all 403 unless paidCalls flag is on.
      if (p === "/api/call/paid/offer" && req.method === "GET") return await getPaidCallOfferRoute(req, env);
      if (p === "/api/call/paid/settings" && req.method === "GET") return await getPaidCallSettingsRoute(req, env);
      if (p === "/api/call/paid/settings" && req.method === "PUT") return await putPaidCallSettingsRoute(req, env);
      if (p === "/api/call/paid/prepare" && req.method === "POST") return await preparePaidCallRoute(req, env);
      if (p === "/api/call/paid/confirm" && req.method === "POST") return await confirmPaidCallRoute(req, env);
      if (p === "/api/call/paid/cancel" && req.method === "POST") return await cancelPaidCallRoute(req, env);
      // [WP3] Voicemail bot session start — 503 unless voicemailBot flag is on.
      if (p === "/api/voicemail/start" && req.method === "POST") return await voicemailStart(req, env);
      // GAP-3: owner-authed voicemail recording playback (mirrors /api/receptionist/recording).
      if (p === "/api/voicemail/recording" && req.method === "GET") return await voicemailRecording(req, env);
      // PSTN gateway + voicemail execution mode (Canonical Architecture v1.0,
      // Specs/PLAN-2026-07-16-ava-receptionist-guardian-FINAL.md). Single
      // startsWith dispatcher — routes/pstn.ts parses the sub-path itself.
      if (p.startsWith("/api/pstn/")) return await pstnRoute(req, env, p);
      // [WP3] Agent Profiles + service numbers (plan §4/§7/§8b/§12.5/§12.8/§12.10).
      // Mode A (primary number) settings — 403 unless voiceAgent flag is on.
      if (p === "/api/agent/settings" && req.method === "GET") return await getAgentSettings(req, env);
      if (p === "/api/agent/settings" && req.method === "PUT") return await putAgentSettings(req, env);
      // Mode B (service numbers) — 403 unless serviceNumbers flag is on.
      if (p === "/api/agent/services" && req.method === "GET") return await listAgentServices(req, env);
      if (p === "/api/agent/services" && req.method === "POST") return await createAgentService(req, env);
      if (p === "/api/agent/services" && req.method === "PUT") return await updateAgentService(req, env);
      if (p === "/api/agent/services" && req.method === "DELETE") return await deleteAgentService(req, env);
      // Caller-side "My AI calls" style read for the OWNER (plan §12.11 covers
      // the caller's own view; this is the owner's call log).
      if (p === "/api/agent/my-calls" && req.method === "GET") return await listAgentCalls(req, env);
      // GAP-2: caller-side full transcript for one of MY calls (§12.11 detail
      // view). Path-segment route — mirrors the /api/team/members/<id> pattern
      // above (startsWith + slice), since call_id is a UUID, not a query param.
      if (p.startsWith("/api/agent/my-calls/") && req.method === "GET") {
        return await getAgentCallTranscript(req, env, decodeURIComponent(p.slice("/api/agent/my-calls/".length)));
      }

      // [WP4] Ava AI Voice Agent — call start + RAG document pipeline (plan §4/§5/§8/§9).
      if (p === "/api/agent/call/start" && req.method === "POST") return await agentCallStart(req, env);
      if (p === "/api/agent/docs" && req.method === "POST") return await uploadAgentDoc(req, env);
      if (p === "/api/agent/docs" && req.method === "GET") return await listAgentDocs(req, env);
      if (p === "/api/agent/docs" && req.method === "DELETE") return await deleteAgentDoc(req, env);
      // [DIALPAD-BIZ-CALLS] Account-level silent block (plan §15.2). The
      // Flutter BlockingApi posts {uid} here; reuse the SAME `blocks` table
      // messaging already writes (routes/safety.ts convBlock) — one blocklist
      // for messaging AND business calls (voicemail/agent/ring all read it).
      if (p === "/api/block" && req.method === "POST") return await convBlock(req, env);
      // [LASTSEEN-SERVER-1] WhatsApp-style last seen (InboxDO socket truth).
      if (p === "/api/user/last-seen" && req.method === "GET") return await api.userLastSeen(req, env);

      // --- contacts ---
      if (p === "/api/contacts/sync" && req.method === "POST") return await api.contactsSync(req, env);
      if (p === "/api/contacts/match" && req.method === "POST") return await api.contactsMatch(req, env);
      // [AVA-MISSEDCALL-1] device-token lane so the overlay can confirm AvaTOK membership
      // while the app is dead (no Clerk JWT). Dark behind missedCallOverlay.
      if (p === "/api/missedcall/token" && req.method === "POST") return await missedCallToken(req, env);
      if (p === "/api/missedcall/lookup" && req.method === "POST") return await missedCallLookup(req, env);
      if (p === "/api/contacts/list" && req.method === "GET") return api.contactsList();
      // Contact-book backup/restore — AvaTOK's own encrypted backup lane (no Gmail
      // needed, server-side encrypted, free). See routes/contacts_backup.ts.
      if (p === "/api/contacts/book/status" && req.method === "GET") return await cbook.contactBookStatus(req, env);
      if (p === "/api/contacts/book" && req.method === "GET") return await cbook.contactBookGet(req, env);
      if (p === "/api/contacts/book" && req.method === "POST") return await cbook.contactBookPut(req, env, ctx);

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

      // --- AvaID ---
      if (p === "/api/id/status" && req.method === "GET") return await idStatus(req, env);
      // Onboarding contact verification — email (server OTP) + password.
      // PHONE OTP REMOVED 2026-07-10 (/api/id/phone/confirm) — see LEGACY_GONE below.
      if (p === "/api/id/email/start" && req.method === "POST") return await idEmailStart(req, env);
      if (p === "/api/id/email/verify" && req.method === "POST") return await idEmailVerify(req, env);
      if (p === "/api/id/password/start" && req.method === "POST") return await idPasswordStart(req, env);
      if (p === "/api/id/password/set" && req.method === "POST") return await idPasswordSet(req, env);

      // [AVA-IDGATE-1] LEGACY TRUST-MINTING ROUTES — CLOSED 2026-07-10.
      //
      // Each of these called setVerifiedCache(uid, true), i.e. each was a door onto
      // the SAME "this user is verified" switch that the whole deterrence model rests
      // on. Didit replaced them as the liveness provider, but they stayed registered:
      // an old client, a bug, or a direct request could mark a user verified WITHOUT
      // any liveness check ever running. That is a bypass, not dead code.
      //
      //   /api/id/session,  /api/id/result          → id.ts        (Rekognition)
      //   /api/id/liveness/{start,upload,verify,result} → liveness.ts   (Workers AI)
      //   /api/liveness/v3/{session,upload,verify,result} → liveness_v3.ts
      //   /api/id/phone/confirm                     → id.ts        (phone OTP, removed)
      //
      // 410 Gone, not 404 — an old client deserves a distinguishable answer, and the
      // telemetry tells us whether anyone is still calling. `legacy_liveness_route_called`
      // MUST be zero in PostHog. Non-zero ⇒ an old client in the wild, or someone
      // probing. Alert on it; do not batch.
      if (LEGACY_GONE.has(p)) {
        void hooks.track(env, "anon", "legacy_liveness_route_called", "avatok", { path: p, method: req.method });
        return new Response(JSON.stringify({ error: "gone", reason: "liveness_provider_migrated" }), {
          status: 410, headers: { "content-type": "application/json" },
        });
      }

      // [LIVE-DIDIT-1] didit.me-powered liveness (owner decision 2026-07-09) —
      // the ONLY liveness path. v2/v3/Rekognition are closed above.
      // [AVA-IDGATE-1] BIPA consent — MUST precede a capture session (spec §10.4).
      if (p === "/api/liveness/consent" && req.method === "POST") return await livenessConsent(req, env);
      if (p === "/api/liveness/didit/session" && req.method === "POST") return await diditSession(req, env);
      if (p === "/api/liveness/didit/result" && req.method === "GET") return await diditResult(req, env);
      if (p === "/api/liveness/didit/done" && req.method === "GET") return diditDone();
      if (p === "/api/liveness/didit/webhook" && req.method === "POST") return await diditWebhook(req, env);
      // [CONNECT-RETURN-1] Composio OAuth return → deep-links back into the app.
      if (p === "/api/connectors/done" && req.method === "GET") return connectorsDone(req);
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
      if (p === "/api/wallet/topup/play/verify" && req.method === "POST") return await walletTopupPlayVerify(req, env);
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
      // [AVADIAL-CALL-INTEL-1] Batched call records from the native dialer, uploaded
      // after each call ends (or on next app boot when the user never opened it).
      if (p === "/api/telemetry/calls" && req.method === "POST") return await ingestCallTelemetry(req, env);
      if (p === "/api/account/deletion-status" && (req.method === "POST" || req.method === "GET")) return await deletionStatus(req, env);

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
      // [NOTIF-CLEAR-1] "Clear all" — destructive, so DELETE (never GET).
      if (p === "/api/notifications" && req.method === "DELETE") return await clearNotifications(req, env);

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
      // --- AvaMarketplace (buy/sell/social + agent negotiation) ---
      if (p === "/api/marketplace/ai-assist" && req.method === "POST") return await marketplaceAiAssist(req, env);
      if (p === "/api/marketplace/negotiate" && req.method === "POST") return await marketplaceNegotiate(req, env, ctx);
      if (p === "/api/marketplace/negotiate/state" && req.method === "GET") return await marketplaceNegotiateState(req, env);
      if (p === "/api/marketplace/search" && req.method === "GET") return await marketplaceSearch(req, env);
      if (p === "/api/marketplace/precheck" && req.method === "POST") return await marketplacePrecheck(req, env);
      if (p === "/api/marketplace/audio" && req.method === "GET") return await marketplaceAudio(req, env);
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
