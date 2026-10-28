// [HF-FB-LOGIN-1] "Log in with Facebook" for Social media verification (HF-INTRO-3). Spec: Specs/HF-FACEBOOK-LOGIN-1.md. Flags hfChannelsEnabled + hfFacebookLoginEnabled.
//   GET  /api/hf/channels/facebook/start?client=app|web   signed in -> { ok, url }  the Facebook dialog URL (state = HMAC-signed { uid, client, nonce, exp 10 min } + one-time nonce in KV)
//   GET  /api/hf/channels/facebook/callback?code&state    NO sign-in header (a browser redirect from Facebook). Verifies the state, exchanges the code, reads the Page she manages
//                                                         (name, public link, followers), saves the channel (platform 'facebook', provider_ref 'facebook-oauth', verified) and 302s to:
//                                                           app: <scheme>://channels?fb=connected&result=<approved|needs_followers>   |  <scheme>://channels?fb=error&reason=<reason>
//                                                           web: <web origin>/dashboard/become?fb=...   (same query)
//                                                         reason = cancelled | no_page | claimed | limit_reached | bad_state | not_enabled | not_configured | provider_error
//   POST /api/hf/channels/facebook/deauthorize            Meta callback (signed_request, form encoded): disconnects that Facebook user's channels
//   POST /api/hf/channels/facebook/data-deletion          Meta callback: same, answers { url, confirmation_code } per Meta's spec
//   GET  /api/hf/channels/facebook/data-deletion-status?code=   public -> { ok, status:'complete' }
// No token is stored. Tokens, codes and the app secret are never logged or returned.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { trackUser, trackException, track } from "../hooks";
import { BRAND } from "../lib/brand";
import { emailFor } from "../lib/identity";
import { readConfig } from "./config";
import { ProviderError } from "../lib/hf_channel_providers";
import { appScheme } from "../lib/hf_instagram";
import {
  FB_GRAPH_VERSION, FB_PROVIDER_REF, FB_SCOPES, FB_STATE_TTL_S, channelsForFbUser, fbAppIdOf, fbExchangeCode, fbFetchProfile, fbRedirectUri, parseFbSignedRequest, saveFbLogin,
  signFbState, verifyFbState, wipeFbChannel, type FbProfile,
} from "../lib/hf_facebook";
import { COLS, MAX_CHANNELS, ensureHostRow, minFollowersOf, minViewsOf, syncHostState, thresholdResult, type ChRow } from "./hf_channels";

const APP = BRAND.slug;
const NO_STORE = { "cache-control": "private, no-store" };
const err = (status: number, error: string, message?: string) => json({ ok: false, error, message: message ?? error }, status, NO_STORE);
const nonceKey = (n: string) => `hffb:n:${n}`;
const randHex = (bytes: number): string => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

export type FbFailReason = "cancelled" | "no_page" | "claimed" | "limit_reached" | "bad_state" | "not_enabled" | "not_configured" | "provider_error";

function backTo(client: "app" | "web", params: Record<string, string>): Response {
  const qs = new URLSearchParams(params).toString();
  const loc = client === "web" ? `${BRAND.webOrigin}/dashboard/become?${qs}` : `${appScheme()}://channels?${qs}`;
  return new Response(null, { status: 302, headers: { location: loc, "cache-control": "no-store" } });
}

function emitFor(env: Env, ctx: ExecutionContext | undefined, uid: string) {
  return (event: string, props: Record<string, unknown> = {}): void => {
    const p = (async () => {
      const email = await emailFor(env, uid).catch(() => null);
      await trackUser(env, uid, email, event, APP, { area: "hf_channels", platform: "facebook", ...props });
    })().catch(() => { /* best-effort */ });
    if (ctx) ctx.waitUntil(p);
  };
}

async function readSignedRequest(req: Request): Promise<string> {
  const t = (await req.text().catch(() => "")).slice(0, 8000);
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("json")) { try { return String(JSON.parse(t)?.signed_request ?? ""); } catch { return ""; } }
  return new URLSearchParams(t).get("signed_request") ?? "";
}

/** Disconnect every channel of this Facebook user (deauthorize and data deletion). Returns how many were touched. */
async function disconnectFbUser(env: Env, fbUserId: string): Promise<number> {
  const chans = await channelsForFbUser(env, fbUserId);
  const hosts = new Set<string>();
  for (const c of chans) {
    await env.DB_META.prepare("UPDATE hf_channels SET status='disconnected' WHERE id=?1 AND status!='disconnected'").bind(c.channel_id).run();
    await wipeFbChannel(env, c.channel_id);
    hosts.add(c.host_uid);
  }
  for (const uid of hosts) { try { await syncHostState(env, uid); } catch { /* next tick retries */ } }
  return chans.length;
}

export async function hfFacebookRoute(req: Request, env: Env, p: string, ctx?: ExecutionContext, f: typeof fetch = fetch): Promise<Response | null> {
  const m = p.match(/^\/api\/hf\/channels\/facebook\/(start|callback|deauthorize|data-deletion|data-deletion-status)$/);
  if (!m) return null;
  const which = m[1];
  const method = req.method;
  const wantsPost = which === "deauthorize" || which === "data-deletion";
  if (method !== (wantsPost ? "POST" : "GET")) return err(405, "method_not_allowed");
  const url = new URL(req.url);
  let uid = "";
  try {
    const cfg = await readConfig(env);
    const cfgAny = cfg as unknown as Record<string, unknown>;

    // ── Meta callbacks: always answered, even with the flag off (a person must be able to withdraw) ───────────────
    if (which === "deauthorize" || which === "data-deletion") {
      const sr = await parseFbSignedRequest(env, await readSignedRequest(req)).catch(() => null);
      if (!sr) return err(400, "invalid_signed_request");
      const n = await disconnectFbUser(env, sr.user_id);
      if (which === "deauthorize") {
        await track(env, "server", "hf_fb_deauthorize", APP, { channels: n });
        return json({ ok: true }, 200, NO_STORE);
      }
      const code = "hffbdel_" + randHex(12);
      try { await env.DB_META.prepare("INSERT INTO hf_ig_deletion_requests (code, status, created_at) VALUES (?1,'complete',?2)").bind(code, Date.now()).run(); } catch { /* table not applied: the status page then says complete for any code */ }
      await track(env, "server", "hf_fb_data_deletion", APP, { channels: n });
      return json({ url: `${BRAND.webOrigin}/data-deletion?code=${code}`, confirmation_code: code }, 200, NO_STORE);
    }
    if (which === "data-deletion-status") {
      const code = url.searchParams.get("code") ?? "";
      if (!/^hffbdel_[a-f0-9]{24}$/.test(code)) return err(404, "not_found");
      let found = true;
      try { found = !!(await env.DB_META.prepare("SELECT 1 AS x FROM hf_ig_deletion_requests WHERE code=?1").bind(code).first()); } catch { /* table not applied */ }
      return found ? json({ ok: true, status: "complete" }, 200, NO_STORE) : err(404, "not_found");
    }

    const on = cfg.hfChannelsEnabled === true && cfg.hfFacebookLoginEnabled === true;

    // ── GET /start ──────────────────────────────────────────────────────────────────────────────────────────────
    if (which === "start") {
      if (!on) return err(404, "not_enabled");
      const u = await requireUser(req, env);
      if (isFail(u)) return err(u.status, u.error);
      uid = u.uid;
      const emit = emitFor(env, ctx, uid);
      const lim = await rateLimit(env, `hffbs:${uid}`, 20, 3600);
      if (lim) return lim;
      const client = url.searchParams.get("client") === "web" ? "web" : "app";
      if (!(env.FACEBOOK_APP_SECRET ?? "").trim() || !fbAppIdOf(cfgAny)) {
        emit("hf_channel_oauth_fail", { reason: "not_configured", client });
        return err(503, "provider_not_configured", "Facebook login is coming soon.");
      }
      const nonce = randHex(16);
      const exp = Date.now() + FB_STATE_TTL_S * 1000;
      await env.TOKENS.put(nonceKey(nonce), uid, { expirationTtl: FB_STATE_TTL_S });
      const state = await signFbState(env, { uid, client, nonce, exp });
      const q = new URLSearchParams({ client_id: fbAppIdOf(cfgAny), redirect_uri: fbRedirectUri(), response_type: "code", scope: FB_SCOPES, state });
      emit("hf_channel_oauth_start", { client });
      return json({ ok: true, url: `https://www.facebook.com/${FB_GRAPH_VERSION}/dialog/oauth?${q}` }, 200, NO_STORE);
    }

    // ── GET /callback (a browser redirect: no Authorization header; the signed state says who started it) ──────
    const state = await verifyFbState(env, url.searchParams.get("state") ?? "").catch(() => null);
    if (!state) return backTo("web", { fb: "error", reason: "bad_state" });
    uid = state.uid;
    const client = state.client;
    const emit = emitFor(env, ctx, uid);
    const fail = (reason: FbFailReason, extra: Record<string, unknown> = {}): Response => {
      emit("hf_channel_oauth_fail", { reason, client, ...extra });
      return backTo(client, { fb: "error", reason });
    };
    const owner = await env.TOKENS.get(nonceKey(state.nonce)); // one use only
    if (owner !== uid) return fail("bad_state");
    await env.TOKENS.delete(nonceKey(state.nonce));
    if (!on) return fail("not_enabled");
    if (url.searchParams.get("error")) return fail(/denied|cancel/i.test(`${url.searchParams.get("error")} ${url.searchParams.get("error_reason")}`) ? "cancelled" : "provider_error");
    const code = url.searchParams.get("code") ?? "";
    if (!code || code.length > 1000) return fail("provider_error");

    let prof: FbProfile;
    try {
      const token = await fbExchangeCode(env, fbAppIdOf(cfgAny), code, f);
      prof = await fbFetchProfile(token, f); // the token ends here: it is never stored
    } catch (e) {
      return fail(e instanceof ProviderError && e.code === "provider_not_configured" ? "not_configured" : "provider_error");
    }
    const page = prof.page;
    if (!page) return fail("no_page");

    const claimed = await env.DB_META.prepare("SELECT id FROM hf_channels WHERE platform='facebook' AND platform_user_id=?1 AND verified_at IS NOT NULL AND status!='disconnected' AND host_uid!=?2 LIMIT 1").bind(page.id, uid).first();
    if (claimed) return fail("claimed");
    const mine = await env.DB_META.prepare(`SELECT ${COLS} FROM hf_channels WHERE host_uid=?1 AND platform='facebook' AND status!='disconnected' AND platform_user_id=?2 LIMIT 1`).bind(uid, page.id).first<ChRow>();
    if (!mine) {
      const active = Number((await env.DB_META.prepare("SELECT COUNT(*) AS c FROM hf_channels WHERE host_uid=?1 AND status!='disconnected'").bind(uid).first<{ c: number }>())?.c ?? 0);
      if (active >= MAX_CHANNELS) return fail("limit_reached");
    }

    const now = Date.now();
    const min = minFollowersOf(cfgAny);
    const minViews = minViewsOf(cfgAny);
    const th = thresholdResult("facebook", page.followers, 0, false, min, minViews);
    const id = mine?.id ?? "hfch_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    let row: ChRow;
    try {
      if (mine) {
        row = { ...mine, handle: page.handle, url: page.url, platform_user_id: page.id, followers: page.followers, verified_at: mine.verified_at ?? now, status: th.status, provider_ref: FB_PROVIDER_REF, last_sync_at: now, verify_code: null };
        await env.DB_META.prepare("UPDATE hf_channels SET handle=?2, url=?3, platform_user_id=?4, followers=?5, verified_at=?6, status=?7, provider_ref=?8, last_sync_at=?9, verify_code=NULL WHERE id=?1")
          .bind(row.id, row.handle, row.url, row.platform_user_id, row.followers, row.verified_at, row.status, row.provider_ref, row.last_sync_at).run();
      } else {
        row = {
          id, host_uid: uid, platform: "facebook", handle: page.handle, url: page.url, platform_user_id: page.id, followers: page.followers, views: 0, verify_code: null,
          verified_at: now, status: th.status, consent_version: "facebook-login-1", consent_at: now, provider_ref: FB_PROVIDER_REF, last_sync_at: now, created_at: now,
        };
        await env.DB_META.prepare(`INSERT INTO hf_channels (${COLS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)`)
          .bind(row.id, row.host_uid, row.platform, row.handle, row.url, row.platform_user_id, row.followers, row.views, row.verify_code, row.verified_at, row.status,
            row.consent_version, row.consent_at, row.provider_ref, row.last_sync_at, row.created_at).run();
      }
      await saveFbLogin(env, id, uid, prof.fbUserId, now);
    } catch (e) {
      if (/UNIQUE|constraint/i.test(String((e as Error)?.message ?? e))) return fail("claimed");
      await trackException(env, e, { uid, route: p, method, handled: true, app_name: APP, extra: { area: "hf_channels", step: "fb_save" } });
      return fail("provider_error");
    }

    await ensureHostRow(env, uid, now);
    const st = await syncHostState(env, uid);
    emit("hf_channel_added", { ok: true, via: "facebook_login", result: th.result, followers: row.followers, qualified: st.qualified });
    emit("hf_channel_threshold", { result: th.result, followers: row.followers, views: 0 });
    emit("hf_channel_oauth_done", { client, result: th.result, followers: row.followers, qualified: st.qualified });
    if (th.result === "approved" && mine?.status !== "approved") emit("hf_verify_badge_added", { badge: "channel" });
    return backTo(client, { fb: "connected", result: th.result });
  } catch (e) {
    await trackException(env, e, { route: p, method, handled: true, app_name: APP, extra: { area: "hf_channels", uid_set: !!uid } });
    if (which === "callback") return backTo("web", { fb: "error", reason: "provider_error" });
    return err(500, "internal_error", "Something went wrong. Please try again.");
  }
}
