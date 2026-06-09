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
import { streamWebhook } from "./routes/stream";
import { brain } from "./routes/brain";
import { deleteAccount, cancelDeletion } from "./routes/account";
import { idSession, idResult, idStatus, idEmailStart, idEmailVerify, idPhoneConfirm } from "./routes/id";
import { walletTopup, stripeWebhook, walletSpend, walletBalance, walletTransactions, walletEarnings, walletLive } from "./routes/wallet";
import { createSlot, listSlots, cancelSlot, bookSlot, cancelBooking, listEvents } from "./routes/calendar";
import { payoutSetup, payoutAccounts, payoutRequest, payoutStatus, wiseWebhook } from "./routes/payout";
import { olxCreate, olxBrowse, olxGet, olxUpdate, olxDelete, olxUploadFile, olxBuy, olxRefund, olxDownloads, olxDownloadFile } from "./routes/olx";
import { listPersonas, upsertPersona, converse, getInbox, getInboxItem, approveInbox, agentTask } from "./routes/agent";
import { agentTts, agentAudio } from "./routes/agent_tts";
import { listNotifications, unreadCount, markRead } from "./routes/notifications";
import { wsInbox, sendMsg, syncMsg, receiptMsg, convList, convCreate } from "./routes/messaging";

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
};

async function dispatch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === "OPTIONS") return preflight();
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/health") return json({ ok: true, service: "avatok-api", ts: Date.now() });

    // Group-call signaling → CallRoom DO (thin router, no logic).
    const room = p.match(/^\/(?:api\/)?room\/([A-Za-z0-9_-]{1,64})$/);
    if (room) return env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(room[1])).fetch(req);

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
      if (p === "/upload/private" && req.method === "POST") return await uploadPrivate(req, env);
      if (p === "/api/library" && req.method === "GET") return await getLibrary(req, env);
      if (p === "/api/library/tree" && req.method === "GET") return await getLibraryTree(req, env);
      if (p === "/api/library/folders/move" && req.method === "POST") return await libraryFolderMove(req, env);
      if (p === "/api/library/folders/copy" && req.method === "POST") return await libraryFolderCopy(req, env);
      if (p === "/api/library/folders") return await libraryFolders(req, env);
      if (p === "/api/library/move" && req.method === "POST") return await libraryMove(req, env);
      if (p === "/api/library/copy" && req.method === "POST") return await libraryCopy(req, env);
      if (p === "/api/library/delete" && req.method === "POST") return await libraryDelete(req, env);
      if (p === "/api/library/record" && req.method === "POST") return await libraryRecord(req, env, ctx);
      if (p === "/api/storage" && req.method === "GET") return await getStorage(req, env);

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

      // --- AvaWallet (Phase 2; balance authority = WalletDO) ---
      if (p === "/api/wallet/topup" && req.method === "POST") return await walletTopup(req, env);
      if (p === "/webhooks/stripe" && req.method === "POST") return await stripeWebhook(req, env);
      if (p === "/api/wallet/spend" && req.method === "POST") return await walletSpend(req, env);
      if (p === "/api/wallet/balance" && req.method === "GET") return await walletBalance(req, env);
      if (p === "/api/wallet/transactions" && req.method === "GET") return await walletTransactions(req, env);
      if (p === "/api/wallet/earnings" && req.method === "GET") return await walletEarnings(req, env);
      if (p === "/api/wallet/live" && req.headers.get("Upgrade") === "websocket") return await walletLive(req, env);

      // --- AvaCalendar (Phase 3) ---
      if (p === "/api/calendar/slots" && req.method === "POST") return await createSlot(req, env);
      if (p === "/api/calendar/slots" && req.method === "GET") return await listSlots(req, env);
      const cs = p.match(/^\/api\/calendar\/slots\/([A-Za-z0-9-]{1,64})$/);
      if (cs && req.method === "DELETE") return await cancelSlot(req, env, cs[1]);
      if (p === "/api/calendar/book" && req.method === "POST") return await bookSlot(req, env);
      if (p === "/api/calendar/cancel" && req.method === "POST") return await cancelBooking(req, env);
      if (p === "/api/calendar/events" && req.method === "GET") return await listEvents(req, env);

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

      // --- in-app notifications feed ---
      if (p === "/api/notifications" && req.method === "GET") return await listNotifications(req, env);
      if (p === "/api/notifications/unread" && req.method === "GET") return await unreadCount(req, env);
      if (p === "/api/notifications/read" && req.method === "POST") return await markRead(req, env);

      // --- AvaBrain (dual auth; routes to the caller's UserBrain DO) ---
      const bm = p.match(/^\/api\/brain\/([a-z]+)$/);
      if (bm) {
        const op = bm[1];
        const readOp = op === "entities" || op === "timeline";
        if (op === "consent" && (req.method === "GET" || req.method === "POST")) return await brain(req, env, op);
        if ((readOp && req.method === "GET") || (!readOp && req.method === "POST") || (op === "forget" && req.method === "DELETE")) {
          return await brain(req, env, op);
        }
      }

      // --- ICE (public read) ---
      if (p === "/api/ice" || p === "/ice") return await getIce(env);

      // --- Stream webhook (Cloudflare Stream Live events) ---
      if (p === "/webhooks/stream" && req.method === "POST") return await streamWebhook(req, env, ctx);

      // --- permanent redirect for any cached/shared legacy media URLs ---
      if (/^\/media\/[a-f0-9]{64}$/.test(p) && req.method === "GET") return mediaRedirect(p, env);
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
