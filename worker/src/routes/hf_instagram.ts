// [HF-IG-LOGIN-1] "Log in with Instagram" for influencer channels (HF-REEL-58). Spec: Specs/HF-CHANNEL-LOGIN-1.md Phase 2. Flags hfChannelsEnabled + hfInstagramLoginEnabled.
//   GET  /api/hf/channels/instagram/start?client=app|web[&return=verifications|become]   [HF-VERIFY-WEB-FLOW] return: allow-list, default become, carried in the signed state
//                                                          signed in -> { ok, url }  the Instagram authorize URL (state = HMAC-signed { uid, client, nonce, exp 10 min } + one-time nonce in KV)
//   GET  /api/hf/channels/instagram/callback?code&state    NO sign-in header (a browser redirect from Instagram). Verifies the state, exchanges the code (short -> long-lived token),
//                                                          reads /me, saves the channel (provider_ref 'instagram-oauth', the same approval rule as every other channel) and the
//                                                          AES-GCM encrypted token, imports her reels, then 302s to:
//                                                            app: <scheme>://channels?ig=connected&result=<approved|needs_followers>      (scheme = first label of the brand domain: hellofraands)
//                                                                 <scheme>://channels?ig=error&reason=<reason>
//                                                            web: <web origin>/dashboard/become?ig=...   (same query; /dashboard/verifications when return=verifications)
//                                                          reason = cancelled | not_professional | claimed | limit_reached | bad_state | not_enabled | not_configured | provider_error
//   POST /api/hf/channels/instagram/deauthorize            Meta callback (signed_request, form encoded): deletes the token + imported data of that Instagram account's channels
//   POST /api/hf/channels/instagram/data-deletion          Meta callback (signed_request): same, answers { url, confirmation_code } per Meta's spec
//   GET  /api/hf/channels/instagram/data-deletion-status?code=   public -> { ok, status:'complete' } (the page behind the url above)
// Tokens, codes and the app secret are never logged or returned.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { trackUser, trackException, track } from "../hooks";
import { BRAND } from "../lib/brand";
import { emailFor } from "../lib/identity";
import { readConfig } from "./config";
import { ProviderError } from "../lib/hf_channel_providers";
import { importChannelReels, importCountOf } from "../lib/hf_reels_import";
import {
  IG_PROVIDER_REF, IG_SCOPES, IG_STATE_TTL_S, appScheme, channelsForIgUser, exchangeCode, fetchProfile, igAppIdOf, igRedirectUri, isProfessional,
  parseSignedRequest, saveToken, signState, verifyState, webReturnOf, webReturnPath, wipeInstagramChannel, type IgProfile, type WebReturn,
} from "../lib/hf_instagram";
import { COLS, MAX_CHANNELS, ensureHostRow, minFollowersOf, minViewsOf, syncHostState, thresholdResult, type ChRow } from "./hf_channels";

const APP = BRAND.slug;
const NO_STORE = { "cache-control": "private, no-store" };
const err = (status: number, error: string, message?: string) => json({ ok: false, error, message: message ?? error }, status, NO_STORE);
const nonceKey = (n: string) => `hfig:n:${n}`;
const randHex = (bytes: number): string => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

export type IgFailReason = "cancelled" | "not_professional" | "claimed" | "limit_reached" | "bad_state" | "not_enabled" | "not_configured" | "provider_error";

/** [HF-VERIFY-WEB-FLOW] ret (from the signed state) picks the web page: /dashboard/verifications or /dashboard/become (default). */
function backTo(client: "app" | "web", params: Record<string, string>, ret?: WebReturn): Response {
  const qs = new URLSearchParams(params).toString();
  const loc = client === "web" ? `${BRAND.webOrigin}${webReturnPath(ret)}?${qs}` : `${appScheme()}://channels?${qs}`;
  return new Response(null, { status: 302, headers: { location: loc, "cache-control": "no-store" } });
}

function emitFor(env: Env, ctx: ExecutionContext | undefined, uid: string) {
  return (event: string, props: Record<string, unknown> = {}): void => {
    const p = (async () => {
      const email = await emailFor(env, uid).catch(() => null);
      await trackUser(env, uid, email, event, APP, { area: "hf_channels", platform: "instagram", ...props });
    })().catch(() => { /* best-effort */ });
    if (ctx) ctx.waitUntil(p);
  };
}

/** What Instagram says when the person cancelled or her account type is refused. */
function reasonFromError(q: URLSearchParams): IgFailReason {
  const text = `${q.get("error") ?? ""} ${q.get("error_reason") ?? ""} ${q.get("error_description") ?? ""}`.toLowerCase();
  if (/professional|business|creator|personal|account type/.test(text)) return "not_professional";
  if (/denied|cancel/.test(text)) return "cancelled";
  return "provider_error";
}

async function readSignedRequest(req: Request): Promise<string> {
  const t = (await req.text().catch(() => "")).slice(0, 8000);
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("json")) { try { return String(JSON.parse(t)?.signed_request ?? ""); } catch { return ""; } }
  return new URLSearchParams(t).get("signed_request") ?? "";
}

/** Disconnect + wipe every channel of this Instagram account (deauthorize and data deletion). Returns how many channels were touched. */
async function disconnectIgUser(env: Env, igUserId: string): Promise<number> {
  const chans = await channelsForIgUser(env, igUserId);
  const hosts = new Set<string>();
  for (const c of chans) {
    await env.DB_META.prepare("UPDATE hf_channels SET status='disconnected' WHERE id=?1 AND status!='disconnected'").bind(c.channel_id).run();
    await wipeInstagramChannel(env, c.channel_id);
    hosts.add(c.host_uid);
  }
  for (const uid of hosts) { try { await syncHostState(env, uid); } catch { /* next tick retries */ } }
  return chans.length;
}

export async function hfInstagramRoute(req: Request, env: Env, p: string, ctx?: ExecutionContext, f: typeof fetch = fetch): Promise<Response | null> {
  const m = p.match(/^\/api\/hf\/channels\/instagram\/(start|callback|deauthorize|data-deletion|data-deletion-status)$/);
  if (!m) return null;
  const which = m[1];
  const method = req.method;
  const wantsPost = which === "deauthorize" || which === "data-deletion";
  if (method !== (wantsPost ? "POST" : "GET")) return err(405, "method_not_allowed");
  const url = new URL(req.url);
  let uid = "";
  try {
    const cfg = await readConfig(env);

    // ── Meta callbacks: always answered, even with the flag off (a person must be able to withdraw) ───────────────
    if (which === "deauthorize" || which === "data-deletion") {
      const sr = await parseSignedRequest(env, await readSignedRequest(req)).catch(() => null);
      if (!sr) return err(400, "invalid_signed_request");
      const n = await disconnectIgUser(env, sr.user_id);
      if (which === "deauthorize") {
        await track(env, "server", "hf_ig_deauthorize", APP, { channels: n });
        return json({ ok: true }, 200, NO_STORE);
      }
      const code = "hfigdel_" + randHex(12);
      try { await env.DB_META.prepare("INSERT INTO hf_ig_deletion_requests (code, status, created_at) VALUES (?1,'complete',?2)").bind(code, Date.now()).run(); } catch { /* table not applied: the status page then says complete for any code */ }
      await track(env, "server", "hf_ig_data_deletion", APP, { channels: n });
      return json({ url: `${BRAND.webOrigin}/data-deletion?code=${code}`, confirmation_code: code }, 200, NO_STORE);
    }
    if (which === "data-deletion-status") {
      const code = url.searchParams.get("code") ?? "";
      if (!/^hfigdel_[a-f0-9]{24}$/.test(code)) return err(404, "not_found");
      let found = true;
      try { found = !!(await env.DB_META.prepare("SELECT 1 AS x FROM hf_ig_deletion_requests WHERE code=?1").bind(code).first()); } catch { /* table not applied */ }
      return found ? json({ ok: true, status: "complete" }, 200, NO_STORE) : err(404, "not_found");
    }

    const on = cfg.hfChannelsEnabled === true && cfg.hfInstagramLoginEnabled === true;

    // ── GET /start ──────────────────────────────────────────────────────────────────────────────────────────────
    if (which === "start") {
      if (!on) return err(404, "not_enabled");
      const u = await requireUser(req, env);
      if (isFail(u)) return err(u.status, u.error);
      uid = u.uid;
      const emit = emitFor(env, ctx, uid);
      const lim = await rateLimit(env, `hfigs:${uid}`, 20, 3600);
      if (lim) return lim;
      const client = url.searchParams.get("client") === "web" ? "web" : "app";
      if (!(env.INSTAGRAM_APP_SECRET ?? "").trim() || !(env.HF_TOKEN_ENC_KEY ?? "").trim()) {
        emit("hf_channel_oauth_fail", { reason: "not_configured", client });
        return err(503, "provider_not_configured", "Instagram login is coming soon.");
      }
      const nonce = randHex(16);
      const exp = Date.now() + IG_STATE_TTL_S * 1000;
      await env.TOKENS.put(nonceKey(nonce), uid, { expirationTtl: IG_STATE_TTL_S });
      const ret = webReturnOf(url.searchParams.get("return")); // [HF-VERIFY-WEB-FLOW] allow-list; default "become"
      const state = await signState(env, { uid, client, nonce, exp, ret });
      const q = new URLSearchParams({ client_id: igAppIdOf(cfg as unknown as Record<string, unknown>), redirect_uri: igRedirectUri(), response_type: "code", scope: IG_SCOPES, state });
      emit("hf_channel_oauth_start", { client });
      return json({ ok: true, url: `https://www.instagram.com/oauth/authorize?${q}` }, 200, NO_STORE);
    }

    // ── GET /callback (a browser redirect: no Authorization header; the signed state says who started it) ──────
    const state = await verifyState(env, url.searchParams.get("state") ?? "").catch(() => null);
    if (!state) return backTo("web", { ig: "error", reason: "bad_state" });
    uid = state.uid;
    const client = state.client;
    const ret = state.ret;
    const emit = emitFor(env, ctx, uid);
    const fail = (reason: IgFailReason, extra: Record<string, unknown> = {}): Response => {
      emit("hf_channel_oauth_fail", { reason, client, ...extra });
      return backTo(client, { ig: "error", reason }, ret);
    };
    const owner = await env.TOKENS.get(nonceKey(state.nonce)); // one use only
    if (owner !== uid) return fail("bad_state");
    await env.TOKENS.delete(nonceKey(state.nonce));
    if (!on) return fail("not_enabled");
    if (url.searchParams.get("error")) return fail(reasonFromError(url.searchParams));
    const code = url.searchParams.get("code") ?? "";
    if (!code || code.length > 1000) return fail("provider_error");

    let tok: Awaited<ReturnType<typeof exchangeCode>>;
    let prof: IgProfile;
    try {
      tok = await exchangeCode(env, igAppIdOf(cfg as unknown as Record<string, unknown>), code, f);
      prof = await fetchProfile(tok.token, f);
    } catch (e) {
      return fail(e instanceof ProviderError && e.code === "provider_not_configured" ? "not_configured" : "provider_error");
    }
    if (!isProfessional(prof.accountType)) return fail("not_professional", { account_type: prof.accountType.toLowerCase() || "unknown" });

    const claimed = await env.DB_META.prepare("SELECT id FROM hf_channels WHERE platform='instagram' AND platform_user_id=?1 AND verified_at IS NOT NULL AND status!='disconnected' AND host_uid!=?2 LIMIT 1").bind(prof.igUserId, uid).first();
    if (claimed) return fail("claimed", { account_type: prof.accountType.toLowerCase() });
    const mine = await env.DB_META.prepare(`SELECT ${COLS} FROM hf_channels WHERE host_uid=?1 AND platform='instagram' AND status!='disconnected' AND (platform_user_id=?2 OR lower(handle)=?3) LIMIT 1`)
      .bind(uid, prof.igUserId, prof.username.toLowerCase()).first<ChRow>();
    if (!mine) {
      const active = Number((await env.DB_META.prepare("SELECT COUNT(*) AS c FROM hf_channels WHERE host_uid=?1 AND status!='disconnected'").bind(uid).first<{ c: number }>())?.c ?? 0);
      if (active >= MAX_CHANNELS) return fail("limit_reached");
    }

    const now = Date.now();
    const min = minFollowersOf(cfg as unknown as Record<string, unknown>);
    const minViews = minViewsOf(cfg as unknown as Record<string, unknown>);
    const th = thresholdResult("instagram", prof.followers, 0, false, min, minViews);
    const igUrl = `https://www.instagram.com/${prof.username}/`;
    const id = mine?.id ?? "hfch_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    let row: ChRow;
    try {
      await saveToken(env, { channelId: id, hostUid: uid, igUserId: prof.igUserId, scopedId: prof.scopedId || tok.scopedId, token: tok.token, expiresAt: tok.expiresAt, scopes: tok.scopes }, now);
      if (mine) {
        row = { ...mine, handle: prof.username, url: igUrl, platform_user_id: prof.igUserId, followers: prof.followers, verified_at: mine.verified_at ?? now, status: th.status, provider_ref: IG_PROVIDER_REF, last_sync_at: now, verify_code: null };
        await env.DB_META.prepare("UPDATE hf_channels SET handle=?2, url=?3, platform_user_id=?4, followers=?5, verified_at=?6, status=?7, provider_ref=?8, last_sync_at=?9, verify_code=NULL WHERE id=?1")
          .bind(row.id, row.handle, row.url, row.platform_user_id, row.followers, row.verified_at, row.status, row.provider_ref, row.last_sync_at).run();
      } else {
        row = {
          id, host_uid: uid, platform: "instagram", handle: prof.username, url: igUrl, platform_user_id: prof.igUserId, followers: prof.followers, views: 0, verify_code: null,
          verified_at: now, status: th.status, consent_version: "instagram-login-1", consent_at: now, provider_ref: IG_PROVIDER_REF, last_sync_at: now, created_at: now,
        };
        await env.DB_META.prepare(`INSERT INTO hf_channels (${COLS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)`)
          .bind(row.id, row.host_uid, row.platform, row.handle, row.url, row.platform_user_id, row.followers, row.views, row.verify_code, row.verified_at, row.status,
            row.consent_version, row.consent_at, row.provider_ref, row.last_sync_at, row.created_at).run();
      }
    } catch (e) {
      await env.DB_META.prepare("DELETE FROM hf_channel_tokens WHERE channel_id=?1").bind(id).run().catch(() => {});
      if (/UNIQUE|constraint/i.test(String((e as Error)?.message ?? e))) return fail("claimed", { account_type: prof.accountType.toLowerCase() });
      await trackException(env, e, { uid, route: p, method, handled: true, app_name: APP, extra: { area: "hf_channels", step: "ig_save" } });
      return fail("provider_error");
    }

    await ensureHostRow(env, uid, now);
    const st = await syncHostState(env, uid);
    if (th.status === "approved" && cfg.hfReelsEnabled === true) {
      const job = importChannelReels(env, row, importCountOf(cfg as unknown as Record<string, unknown>)).catch(async (e) => {
        if (!(e instanceof ProviderError)) await trackException(env, e, { route: "hf_reels_import", method: "JOB", handled: true, app_name: APP, extra: { area: "hf_reels", platform: "instagram" } }).catch(() => {});
      });
      if (ctx) ctx.waitUntil(job); else await job;
    }
    emit("hf_channel_added", { ok: true, via: "instagram_login", result: th.result, followers: row.followers, qualified: st.qualified });
    emit("hf_channel_threshold", { result: th.result, followers: row.followers, views: 0 });
    emit("hf_channel_oauth_done", { client, account_type: prof.accountType.toLowerCase(), result: th.result, followers: row.followers, qualified: st.qualified });
    if (th.result === "approved" && mine?.status !== "approved") emit("hf_verify_badge_added", { badge: "channel" });
    return backTo(client, { ig: "connected", result: th.result }, ret);
  } catch (e) {
    await trackException(env, e, { route: p, method, handled: true, app_name: APP, extra: { area: "hf_channels", uid_set: !!uid } });
    if (which === "callback") return backTo("web", { ig: "error", reason: "provider_error" });
    return err(500, "internal_error", "Something went wrong. Please try again.");
  }
}
