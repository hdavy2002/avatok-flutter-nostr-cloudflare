// [HF-IG-LOGIN-1] Instagram API with Instagram Login for influencer channels (HF-REEL-58/59/61, Specs/HF-CHANNEL-LOGIN-1.md Phase 2).
// Scopes: instagram_business_basic + instagram_business_manage_comments. We only READ (profile, media, comments); nothing is ever posted back.
//   state            HMAC-signed { uid, client, nonce, exp 10 min } + one-time nonce in KV (replay-proof).
//   token at rest    AES-GCM (WebCrypto) with the base64 32-byte key HF_TOKEN_ENC_KEY, bound to the channel id. Never returned to a client, never logged.
//   refresh          long-lived tokens (60 d) are refreshed after 50 d by the daily channel sync; a dead token (code 190 / expired) marks the token row
//                    'needs_reconnect' (the channel and the influencer's approval stay; the app shows a banner).
//   deletion         Remove channel, Meta's deauthorize and data-deletion callbacks all run wipeInstagramChannel().
// Secrets (INSTAGRAM_APP_SECRET, HF_TOKEN_ENC_KEY) live in KV (lib/kv_secrets.ts). A URL carrying a token is never put into an error or a log.
import type { Env } from "../types";
import type { ImportedReel, ExtComment } from "./hf_reels_import";
import { BRAND } from "./brand";
import { ProviderError, PROVIDER_TIMEOUT_MS, type ChannelLookup } from "./hf_channel_providers";
import { trackUser, trackException } from "../hooks";
import { emailFor } from "./identity";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const IG_PROVIDER_REF = "instagram-oauth";
export const IG_SCOPES = "instagram_business_basic,instagram_business_manage_comments";
export const IG_DEFAULT_APP_ID = "1116106647810644";
export const IG_STATE_TTL_S = 600;
export const IG_REFRESH_AFTER_MS = 50 * 24 * 3600 * 1000;
const IG_LONG_LIVED_S = 60 * 24 * 3600;
const MEDIA_FIELDS = "id,shortcode,media_type,media_product_type,permalink,thumbnail_url,caption,like_count,comments_count,timestamp";
const PROFILE_FIELDS = "id,user_id,username,account_type,followers_count,media_count,profile_picture_url";
const COMMENT_FIELDS = "id,text,username,like_count,timestamp";
const APP = BRAND.slug;

export const isIgOauth = (ch: { platform: string; provider_ref?: string | null }): boolean => ch.platform === "instagram" && ch.provider_ref === IG_PROVIDER_REF;
export const igRedirectUri = (): string => `${BRAND.apiOrigin}/api/hf/channels/instagram/callback`;
export const igAppIdOf = (cfg: Record<string, unknown>): string => {
  const v = String(cfg.hfInstagramAppId ?? "").trim();
  return /^\d{6,25}$/.test(v) ? v : IG_DEFAULT_APP_ID;
};
/** App deep-link scheme = first label of the brand domain (same rule as the Android manifest). */
export const appScheme = (): string => BRAND.domain.split(".")[0];

// ── base64url + HMAC + AES-GCM ───────────────────────────────────────────────────────────────────────────────────
const te = new TextEncoder();
export function b64uEncode(buf: ArrayBuffer | Uint8Array): string {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64uDecode(s: string): Uint8Array {
  const t = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const appSecret = (env: Env): string => {
  const s = (env.INSTAGRAM_APP_SECRET ?? "").trim();
  if (!s) throw new ProviderError("provider_not_configured");
  return s;
};
const hmacKey = (secret: string, usage: ("sign" | "verify")[]) => crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);

// [HF-VERIFY-WEB-FLOW] Where a WEB login (Instagram / Facebook) comes back to. Allow-list only: the start route reads ?return=, anything
// else (or nothing) is "become" so old links keep landing on /dashboard/become. The value rides INSIDE the signed state, so it cannot be changed.
export type WebReturn = "verifications" | "become";
const WEB_RETURN_PATHS: Record<WebReturn, string> = { verifications: "/dashboard/verifications", become: "/dashboard/become" };
export const webReturnOf = (v: unknown): WebReturn => (v === "verifications" ? "verifications" : "become");
export const webReturnPath = (r: unknown): string => WEB_RETURN_PATHS[webReturnOf(r)];

export interface IgState { uid: string; client: "app" | "web"; nonce: string; exp: number; ret?: WebReturn }

export async function signState(env: Env, s: IgState): Promise<string> {
  const body = b64uEncode(te.encode(JSON.stringify({ t: "hfig", uid: s.uid, client: s.client, nonce: s.nonce, exp: s.exp, ret: webReturnOf(s.ret) })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(appSecret(env), ["sign"]), te.encode(body));
  return `${body}.${b64uEncode(sig)}`;
}

/** The state payload when the signature is ours and it has not expired; null otherwise. Never throws. */
export async function verifyState(env: Env, state: string, now = Date.now()): Promise<IgState | null> {
  try {
    const [body, sig, extra] = String(state ?? "").split(".");
    if (!body || !sig || extra !== undefined) return null;
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(appSecret(env), ["verify"]), b64uDecode(sig), te.encode(body));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(b64uDecode(body)));
    if (p?.t !== "hfig" || typeof p.uid !== "string" || !p.uid || typeof p.nonce !== "string" || !p.nonce || (p.client !== "app" && p.client !== "web")) return null;
    if (!Number.isFinite(p.exp) || p.exp <= now) return null;
    return { uid: p.uid, client: p.client, nonce: p.nonce, exp: p.exp, ret: webReturnOf(p.ret) };
  } catch { return null; }
}

/** Meta's signed_request (deauthorize / data deletion): `<sig>.<payload>`, sig = HMAC-SHA256(payload string, app secret). Returns the payload or null. */
export async function parseSignedRequest(env: Env, sr: string): Promise<{ user_id: string } & Record<string, unknown> | null> {
  try {
    const [sig, payload, extra] = String(sr ?? "").split(".");
    if (!sig || !payload || extra !== undefined) return null;
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(appSecret(env), ["verify"]), b64uDecode(sig), te.encode(payload));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(b64uDecode(payload)));
    if (String(p?.algorithm ?? "").toUpperCase() !== "HMAC-SHA256" || !p?.user_id) return null;
    return { ...p, user_id: String(p.user_id) };
  } catch { return null; }
}

async function aesKey(env: Env): Promise<CryptoKey> {
  let raw: Uint8Array;
  try { raw = b64uDecode((env.HF_TOKEN_ENC_KEY ?? "").trim()); } catch { throw new ProviderError("provider_not_configured"); }
  if (raw.length !== 32) throw new ProviderError("provider_not_configured");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
/** `v1.<iv>.<ciphertext>` (base64url). [aad] binds the ciphertext to its channel id. */
export async function encryptToken(env: Env, plain: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, await aesKey(env), te.encode(plain));
  return `v1.${b64uEncode(iv)}.${b64uEncode(ct)}`;
}
export async function decryptToken(env: Env, enc: string, aad: string): Promise<string> {
  const [v, iv, ct] = String(enc).split(".");
  if (v !== "v1" || !iv || !ct) throw new ProviderError("token_invalid");
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64uDecode(iv), additionalData: te.encode(aad) }, await aesKey(env), b64uDecode(ct));
    return new TextDecoder().decode(pt);
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError("token_invalid");
  }
}

// ── Graph calls ──────────────────────────────────────────────────────────────────────────────────────────────────
const num = (v: unknown): number => Math.max(0, Math.trunc(Number(v ?? 0)) || 0);

async function igCall(f: FetchLike, url: string, init: RequestInit = {}): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROVIDER_TIMEOUT_MS);
  let res: Response;
  try { res = await f(url, { ...init, signal: ctl.signal }); }
  catch { throw new ProviderError("provider_unavailable"); } // never include the URL (it carries the token)
  finally { clearTimeout(timer); }
  const body: any = await res.json().catch(() => null);
  if (!res.ok || body?.error) {
    const code = Number(body?.error?.code ?? 0);
    if (res.status === 401 || code === 190) throw new ProviderError("token_invalid");
    throw new ProviderError("provider_unavailable");
  }
  return body;
}

export interface IgProfile { igUserId: string; scopedId: string; username: string; accountType: string; followers: number; mediaCount: number; avatar: string | null }

export async function fetchProfile(token: string, f: FetchLike = fetch): Promise<IgProfile> {
  const q = new URLSearchParams({ fields: PROFILE_FIELDS, access_token: token });
  const j = await igCall(f, `https://graph.instagram.com/me?${q}`);
  const d = Array.isArray(j?.data) ? j.data[0] : j;
  const igUserId = String(d?.user_id ?? d?.id ?? "");
  if (!/^\d{3,25}$/.test(igUserId)) throw new ProviderError("provider_unavailable");
  const av = typeof d?.profile_picture_url === "string" && d.profile_picture_url.startsWith("https://") ? d.profile_picture_url : null;
  return {
    igUserId, scopedId: String(d?.id ?? ""), username: String(d?.username ?? "").replace(/^@/, "").slice(0, 60),
    accountType: String(d?.account_type ?? "").toUpperCase(), followers: num(d?.followers_count), mediaCount: num(d?.media_count), avatar: av,
  };
}

/** Professional accounts only: Instagram Login itself refuses personal accounts, but if one gets through we say so. */
export const isProfessional = (accountType: string): boolean => accountType === "BUSINESS" || accountType === "MEDIA_CREATOR" || accountType === "CREATOR";

export interface IgLongToken { token: string; expiresAt: number; scopes: string; scopedId: string }

/** code -> short-lived token -> long-lived (60 d) token. */
export async function exchangeCode(env: Env, appId: string, code: string, f: FetchLike = fetch, now = Date.now()): Promise<IgLongToken> {
  const secret = appSecret(env);
  const form = new URLSearchParams({ client_id: appId, client_secret: secret, grant_type: "authorization_code", redirect_uri: igRedirectUri(), code: code.replace(/#_$/, "") });
  const sj = await igCall(f, "https://api.instagram.com/oauth/access_token", { method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded" } });
  const sd = Array.isArray(sj?.data) ? sj.data[0] : sj;
  const short = String(sd?.access_token ?? "");
  if (!short) throw new ProviderError("provider_unavailable");
  const perms = Array.isArray(sd?.permissions) ? sd.permissions.join(",") : String(sd?.permissions ?? "");
  const q = new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: secret, access_token: short });
  const lj = await igCall(f, `https://graph.instagram.com/access_token?${q}`);
  const long = String(lj?.access_token ?? "");
  if (!long) throw new ProviderError("provider_unavailable");
  const ttl = num(lj?.expires_in) || IG_LONG_LIVED_S;
  return { token: long, expiresAt: now + ttl * 1000, scopes: perms || IG_SCOPES, scopedId: String(sd?.user_id ?? "") };
}

// ── Token store (hf_channel_tokens) ──────────────────────────────────────────────────────────────────────────────
export interface TokenRow { channel_id: string; host_uid: string; ig_user_id: string | null; ig_scoped_id: string | null; enc_token: string; expires_at: number; scopes: string | null; status: string; updated_at: number }

export async function saveToken(env: Env, p: { channelId: string; hostUid: string; igUserId: string; scopedId: string; token: string; expiresAt: number; scopes: string }, now = Date.now()): Promise<void> {
  const enc = await encryptToken(env, p.token, p.channelId);
  await env.DB_META.prepare(
    `INSERT INTO hf_channel_tokens (channel_id, host_uid, ig_user_id, ig_scoped_id, enc_token, expires_at, scopes, status, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'active',?8)
     ON CONFLICT(channel_id) DO UPDATE SET host_uid=excluded.host_uid, ig_user_id=excluded.ig_user_id, ig_scoped_id=excluded.ig_scoped_id, enc_token=excluded.enc_token,
       expires_at=excluded.expires_at, scopes=excluded.scopes, status='active', updated_at=excluded.updated_at`,
  ).bind(p.channelId, p.hostUid, p.igUserId, p.scopedId || null, enc, p.expiresAt, p.scopes, now).run();
}

export async function loadTokenRow(env: Env, channelId: string): Promise<TokenRow | null> {
  try { return (await env.DB_META.prepare("SELECT channel_id, host_uid, ig_user_id, ig_scoped_id, enc_token, expires_at, scopes, status, updated_at FROM hf_channel_tokens WHERE channel_id=?1").bind(channelId).first<TokenRow>()) ?? null; }
  catch { return null; }
}

/** Mark the token dead (the channel row, its approval and its reels stay) and let the daily sync wait 20 h before looking again. */
export async function markNeedsReconnect(env: Env, channelId: string, now = Date.now()): Promise<void> {
  try {
    await env.DB_META.prepare("UPDATE hf_channel_tokens SET status='needs_reconnect' WHERE channel_id=?1").bind(channelId).run();
    await env.DB_META.prepare("UPDATE hf_channels SET last_sync_at=?2 WHERE id=?1").bind(channelId, now).run();
  } catch { /* best effort */ }
}

/** Run [fn] with the channel's decrypted token. A missing / dead token throws token_invalid; a 190 from Instagram marks the row needs_reconnect. */
export async function withToken<T>(env: Env, channelId: string, fn: (token: string, row: TokenRow) => Promise<T>, now = Date.now()): Promise<T> {
  const row = await loadTokenRow(env, channelId);
  if (!row) throw new ProviderError("token_invalid");
  if (row.status !== "active") { await markNeedsReconnect(env, channelId, now); throw new ProviderError("token_invalid"); } // also keeps the daily sync from retrying every tick
  if (row.expires_at <= now) { await markNeedsReconnect(env, channelId, now); throw new ProviderError("token_invalid"); }
  const token = await decryptToken(env, row.enc_token, channelId);
  try { return await fn(token, row); }
  catch (e) {
    if (e instanceof ProviderError && e.code === "token_invalid") await markNeedsReconnect(env, channelId, now);
    throw e;
  }
}

// ── Reads with her token ─────────────────────────────────────────────────────────────────────────────────────────
/** Followers etc. through /me, shaped like the other channel look-ups so runCheck() needs no special case. */
export async function instagramOauthLookup(env: Env, ch: { id: string }, f: FetchLike = fetch): Promise<ChannelLookup> {
  const p = await withToken(env, ch.id, (t) => fetchProfile(t, f));
  return {
    exists: true, platformUserId: p.igUserId, handle: p.username, followers: p.followers, bio: "", isPrivate: false, countHidden: false,
    url: `https://www.instagram.com/${p.username}/`, displayName: p.username, avatarUrl: p.avatar,
  };
}

/** Her newest reels / videos (media_product_type REELS or media_type VIDEO), paged 50 at a time. Each carries igMediaId for the comments pull. */
export async function instagramOauthRecent(env: Env, ch: { id: string; platform_user_id: string | null }, n: number, f: FetchLike = fetch): Promise<ImportedReel[]> {
  const igId = String(ch.platform_user_id ?? "");
  if (!/^\d{3,25}$/.test(igId)) return [];
  return withToken(env, ch.id, async (token) => {
    const out: ImportedReel[] = [];
    let url: string | null = `https://graph.instagram.com/${igId}/media?${new URLSearchParams({ fields: MEDIA_FIELDS, limit: "50", access_token: token })}`;
    for (let page = 0; page < 8 && url && out.length < n; page++) {
      const j: any = await igCall(f, url);
      for (const m of Array.isArray(j?.data) ? j.data : []) {
        const reel = String(m?.media_product_type ?? "").toUpperCase() === "REELS" || String(m?.media_type ?? "").toUpperCase() === "VIDEO";
        if (!reel || !m?.id) continue;
        const code = /^[A-Za-z0-9_-]{5,20}$/.test(String(m?.shortcode ?? "")) ? String(m.shortcode) : String(m?.permalink ?? "").match(/\/(?:reel|p|tv)\/([A-Za-z0-9_-]{5,20})/)?.[1];
        if (!code) continue;
        const pub = Date.parse(String(m?.timestamp ?? ""));
        const thumb = typeof m?.thumbnail_url === "string" && m.thumbnail_url.startsWith("https://") ? m.thumbnail_url : null;
        out.push({
          platformVideoId: code, url: `https://www.instagram.com/reel/${code}/`, embedUrl: `https://www.instagram.com/reel/${code}/embed`, thumbUrl: thumb,
          caption: String(m?.caption ?? "").slice(0, 300), likes: num(m?.like_count), comments: num(m?.comments_count), views: 0,
          publishedAt: Number.isFinite(pub) ? pub : null, igMediaId: String(m.id),
        });
        if (out.length >= n) break;
      }
      const next = j?.paging?.next;
      url = typeof next === "string" && next.startsWith("https://graph.instagram.com/") ? next : null;
    }
    return out;
  });
}

/** Remember which Instagram media id a reel is (needed to read its comments). Best effort: the table may not be applied yet. */
export async function saveIgMedia(env: Env, reelId: string, igMediaId: string, channelId: string, hostUid: string): Promise<void> {
  try {
    await env.DB_META.prepare("INSERT INTO hf_reel_ig_media (reel_id, ig_media_id, channel_id, host_uid) VALUES (?1,?2,?3,?4) ON CONFLICT(reel_id) DO UPDATE SET ig_media_id=excluded.ig_media_id")
      .bind(reelId, igMediaId, channelId, hostUid).run();
  } catch { /* hf_reel_ig_media not applied yet */ }
}

/** Top-level comments of one imported reel, read with its owner's token. Ids `instagram:<id>`, author `@username`. Throws ProviderError (the caller retries in 10 min). */
export async function instagramCommentsForReel(env: Env, reelId: string, want: number, f: FetchLike = fetch): Promise<ExtComment[]> {
  const m = await env.DB_META.prepare("SELECT ig_media_id, channel_id FROM hf_reel_ig_media WHERE reel_id=?1").bind(reelId).first<{ ig_media_id: string; channel_id: string }>();
  if (!m || !/^\d{3,30}$/.test(m.ig_media_id)) throw new ProviderError("provider_unavailable");
  return withToken(env, m.channel_id, async (token) => {
    const q = new URLSearchParams({ fields: COMMENT_FIELDS, limit: String(Math.max(1, Math.min(50, Math.trunc(want) || 25))), access_token: token });
    const j = await igCall(f, `https://graph.instagram.com/${m.ig_media_id}/comments?${q}`);
    const out: ExtComment[] = [];
    for (const c of Array.isArray(j?.data) ? j.data : []) {
      const id = String(c?.id ?? "");
      const text = typeof c?.text === "string" ? c.text.trim() : "";
      if (!/^[A-Za-z0-9_.-]{5,80}$/.test(id) || !text) continue;
      const user = String(c?.username ?? "").replace(/^@/, "").slice(0, 60);
      const pub = Date.parse(String(c?.timestamp ?? ""));
      out.push({ id: `instagram:${id}`, authorName: user ? `@${user}` : "Someone", authorAvatar: null, authorUrl: null, body: text.slice(0, 1000), likeCount: num(c?.like_count), publishedAt: Number.isFinite(pub) ? pub : null });
    }
    return out;
  });
}

// ── Refresh (daily sync) ─────────────────────────────────────────────────────────────────────────────────────────
async function emitRefresh(env: Env, uid: string, ok: boolean, reason = ""): Promise<void> {
  try {
    const email = await emailFor(env, uid).catch(() => null);
    await trackUser(env, uid, email, "hf_ig_token_refresh", APP, { area: "hf_channels", ok, ...(reason ? { reason } : {}) });
  } catch { /* telemetry is best effort */ }
}

/** Refresh the long-lived token when it is older than 50 days. 'skipped' = not due / no token, 'refreshed', or 'failed' (a dead token is marked needs_reconnect). Never throws. */
export async function refreshTokenIfDue(env: Env, ch: { id: string; host_uid: string }, f: FetchLike = fetch, now = Date.now()): Promise<"skipped" | "refreshed" | "failed"> {
  try {
    const row = await loadTokenRow(env, ch.id);
    if (!row || row.status !== "active") return "skipped";
    if (row.expires_at <= now) { await markNeedsReconnect(env, ch.id, now); await emitRefresh(env, ch.host_uid, false, "expired"); return "failed"; }
    if (now - row.updated_at < IG_REFRESH_AFTER_MS) return "skipped";
    const token = await decryptToken(env, row.enc_token, ch.id);
    const q = new URLSearchParams({ grant_type: "ig_refresh_token", access_token: token });
    const j = await igCall(f, `https://graph.instagram.com/refresh_access_token?${q}`);
    const fresh = String(j?.access_token ?? "");
    if (!fresh) throw new ProviderError("provider_unavailable");
    await saveToken(env, { channelId: ch.id, hostUid: row.host_uid, igUserId: row.ig_user_id ?? "", scopedId: row.ig_scoped_id ?? "", token: fresh, expiresAt: now + (num(j?.expires_in) || IG_LONG_LIVED_S) * 1000, scopes: row.scopes ?? IG_SCOPES }, now);
    await emitRefresh(env, ch.host_uid, true);
    return "refreshed";
  } catch (e) {
    if (e instanceof ProviderError && e.code === "token_invalid") await markNeedsReconnect(env, ch.id, now);
    else await trackException(env, e, { route: "hf_ig_token_refresh", handled: true, app_name: APP, extra: { area: "hf_channels" } }).catch(() => {});
    await emitRefresh(env, ch.host_uid, false, e instanceof ProviderError ? e.code : "error");
    return "failed";
  }
}

// ── Deletion ─────────────────────────────────────────────────────────────────────────────────────────────────────
/** Remove everything we hold from Instagram for one channel: the token, the media-id map, the imported comments (the ones our users replied to stay, with their text
 *  blanked to "Comment removed"), and hide its reels. The hf_channels row itself is left to the caller. Never throws. */
export async function wipeInstagramChannel(env: Env, channelId: string): Promise<void> {
  try {
    await env.DB_META.batch([
      env.DB_META.prepare("DELETE FROM hf_channel_tokens WHERE channel_id=?1").bind(channelId),
      env.DB_META.prepare("DELETE FROM hf_reel_ig_media WHERE channel_id=?1").bind(channelId),
      env.DB_META.prepare("UPDATE hf_reels SET visible=0 WHERE channel_id=?1").bind(channelId),
    ]);
  } catch (e) { await trackException(env, e, { route: "hf_ig_wipe", handled: true, app_name: APP, extra: { area: "hf_channels", step: "core" } }).catch(() => {}); }
  try {
    const mine = "SELECT id FROM hf_reels WHERE channel_id=?1";
    await env.DB_META.batch([
      env.DB_META.prepare(`DELETE FROM hf_reel_ext_comments WHERE platform='instagram' AND reel_id IN (${mine}) AND NOT EXISTS (SELECT 1 FROM hf_reel_comments oc WHERE oc.parent_id=hf_reel_ext_comments.id AND oc.status='visible')`).bind(channelId),
      env.DB_META.prepare(`UPDATE hf_reel_ext_comments SET body='Comment removed', author_name='Someone', author_avatar=NULL, author_url=NULL, like_count=0 WHERE platform='instagram' AND reel_id IN (${mine})`).bind(channelId),
    ]);
  } catch { /* comment tables not applied yet: nothing was imported */ }
}

/** Channels owned through the Instagram account that Meta names in a signed_request (app-scoped id or professional account id). */
export async function channelsForIgUser(env: Env, igUserId: string): Promise<{ channel_id: string; host_uid: string }[]> {
  try {
    return (await env.DB_META.prepare("SELECT channel_id, host_uid FROM hf_channel_tokens WHERE ig_scoped_id=?1 OR ig_user_id=?1").bind(igUserId).all<{ channel_id: string; host_uid: string }>()).results ?? [];
  } catch { return []; }
}
