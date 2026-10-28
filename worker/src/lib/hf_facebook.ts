// [HF-FB-LOGIN-1] Facebook Login for "Social media verification" (HF-INTRO-3, Specs/HF-FACEBOOK-LOGIN-1.md). Same shape as lib/hf_instagram.ts.
// Least-permission route that yields a PUBLIC link: the influencer's Facebook PAGE (a personal profile link would need the `user_link` permission).
//   scopes   public_profile (default, no review) + pages_show_list + pages_read_engagement (Page name, link, followers). We only READ; nothing is ever posted.
//   state    HMAC-signed { uid, client, nonce, exp 10 min } with FACEBOOK_APP_SECRET + a one-time nonce in KV (replay-proof).
//   token    NOT stored. It is used once inside the callback to read the Page and then dropped, so there is no token table and nothing to refresh.
//   map      hf_fb_logins (channel_id -> Facebook app-scoped user id) exists only so Meta's deauthorize / data-deletion callbacks can find the channel.
// FACEBOOK_APP_SECRET lives in KV (lib/kv_secrets.ts, the Worker is at the 128-binding limit). The app id is the string config hfFacebookAppId (not a secret).
import type { Env } from "../types";
import { BRAND } from "./brand";
import { ProviderError, PROVIDER_TIMEOUT_MS } from "./hf_channel_providers";
import { b64uEncode, b64uDecode } from "./hf_instagram";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const FB_PROVIDER_REF = "facebook-oauth";
export const FB_SCOPES = "public_profile,pages_show_list,pages_read_engagement";
export const FB_GRAPH_VERSION = "v21.0";
export const FB_STATE_TTL_S = 600;
const GRAPH = `https://graph.facebook.com/${FB_GRAPH_VERSION}`;
const PAGE_FIELDS = "id,name,link,username,followers_count,fan_count";

export const isFbOauth = (ch: { platform: string; provider_ref?: string | null }): boolean => ch.platform === "facebook" && ch.provider_ref === FB_PROVIDER_REF;
export const fbRedirectUri = (): string => `${BRAND.apiOrigin}/api/hf/channels/facebook/callback`;
export const fbAppIdOf = (cfg: Record<string, unknown>): string => {
  const v = String(cfg.hfFacebookAppId ?? "").trim();
  return /^\d{6,25}$/.test(v) ? v : "";
};
// [HF-FB-CONFIG-ID] The Meta app is a Business app, so the dialog uses a Facebook Login for Business configuration
// (config_id; user access token; pages_show_list + pages_read_engagement) instead of scope. Empty = old scope dialog.
export const fbConfigIdOf = (cfg: Record<string, unknown>): string => {
  const v = String(cfg.hfFacebookConfigId ?? "").trim();
  return /^\d{6,25}$/.test(v) ? v : "";
};

const te = new TextEncoder();
const appSecret = (env: Env): string => {
  const s = (env.FACEBOOK_APP_SECRET ?? "").trim();
  if (!s) throw new ProviderError("provider_not_configured");
  return s;
};
const hmacKey = (secret: string, usage: ("sign" | "verify")[]) => crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);

export interface FbState { uid: string; client: "app" | "web"; nonce: string; exp: number }

export async function signFbState(env: Env, s: FbState): Promise<string> {
  const body = b64uEncode(te.encode(JSON.stringify({ t: "hffb", uid: s.uid, client: s.client, nonce: s.nonce, exp: s.exp })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(appSecret(env), ["sign"]), te.encode(body));
  return `${body}.${b64uEncode(sig)}`;
}

/** The state payload when the signature is ours and it has not expired; null otherwise. Never throws. */
export async function verifyFbState(env: Env, state: string, now = Date.now()): Promise<FbState | null> {
  try {
    const [body, sig, extra] = String(state ?? "").split(".");
    if (!body || !sig || extra !== undefined) return null;
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(appSecret(env), ["verify"]), b64uDecode(sig), te.encode(body));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(b64uDecode(body)));
    if (p?.t !== "hffb" || typeof p.uid !== "string" || !p.uid || typeof p.nonce !== "string" || !p.nonce || (p.client !== "app" && p.client !== "web")) return null;
    if (!Number.isFinite(p.exp) || p.exp <= now) return null;
    return { uid: p.uid, client: p.client, nonce: p.nonce, exp: p.exp };
  } catch { return null; }
}

/** Meta's signed_request (deauthorize / data deletion): `<sig>.<payload>`, sig = HMAC-SHA256(payload string, app secret). Returns the payload or null. */
export async function parseFbSignedRequest(env: Env, sr: string): Promise<({ user_id: string } & Record<string, unknown>) | null> {
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

// ── Graph calls ──────────────────────────────────────────────────────────────────────────────────────────────────
const num = (v: unknown): number => Math.max(0, Math.trunc(Number(v ?? 0)) || 0);

async function fbCall(f: FetchLike, url: string): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROVIDER_TIMEOUT_MS);
  let res: Response;
  try { res = await f(url, { signal: ctl.signal }); }
  catch { throw new ProviderError("provider_unavailable"); } // never include the URL (it carries the token / secret)
  finally { clearTimeout(timer); }
  const body: any = await res.json().catch(() => null);
  if (!res.ok || body?.error) {
    const code = Number(body?.error?.code ?? 0);
    if (res.status === 401 || code === 190) throw new ProviderError("token_invalid");
    throw new ProviderError("provider_unavailable");
  }
  return body;
}

/** code -> user access token (used once, never stored). */
export async function fbExchangeCode(env: Env, appId: string, code: string, f: FetchLike = fetch): Promise<string> {
  const q = new URLSearchParams({ client_id: appId, client_secret: appSecret(env), redirect_uri: fbRedirectUri(), code });
  const j = await fbCall(f, `${GRAPH}/oauth/access_token?${q}`);
  const t = String(j?.access_token ?? "");
  if (!t) throw new ProviderError("provider_unavailable");
  return t;
}

export interface FbPage { id: string; name: string; handle: string; url: string; followers: number }
export interface FbProfile { fbUserId: string; name: string; page: FbPage | null }

/** Who she is + the Facebook Page she manages with the most followers (a public link needs a Page). page=null when she manages none. */
export async function fbFetchProfile(token: string, f: FetchLike = fetch): Promise<FbProfile> {
  const me = await fbCall(f, `${GRAPH}/me?${new URLSearchParams({ fields: "id,name", access_token: token })}`);
  const fbUserId = String(me?.id ?? "");
  if (!/^\d{3,30}$/.test(fbUserId)) throw new ProviderError("provider_unavailable");
  const acc = await fbCall(f, `${GRAPH}/me/accounts?${new URLSearchParams({ fields: PAGE_FIELDS, limit: "25", access_token: token })}`);
  let best: FbPage | null = null;
  for (const p of Array.isArray(acc?.data) ? acc.data : []) {
    const id = String(p?.id ?? "");
    if (!/^\d{3,30}$/.test(id)) continue;
    const link = typeof p?.link === "string" && p.link.startsWith("https://") ? p.link : `https://www.facebook.com/${id}`;
    const followers = num(p?.followers_count ?? p?.fan_count);
    const cand: FbPage = { id, name: String(p?.name ?? "").slice(0, 80), handle: String(p?.username ?? "").replace(/^@/, "").slice(0, 60) || id, url: link, followers };
    if (!best || cand.followers > best.followers) best = cand;
  }
  return { fbUserId, name: String(me?.name ?? "").slice(0, 80), page: best };
}

// ── Mapping login -> channel (deauthorize / data deletion) ───────────────────────────────────────────────────────
export async function saveFbLogin(env: Env, channelId: string, hostUid: string, fbUserId: string, now = Date.now()): Promise<void> {
  await env.DB_META.prepare(
    `INSERT INTO hf_fb_logins (channel_id, host_uid, fb_user_id, created_at) VALUES (?1,?2,?3,?4)
     ON CONFLICT(channel_id) DO UPDATE SET host_uid=excluded.host_uid, fb_user_id=excluded.fb_user_id, created_at=excluded.created_at`,
  ).bind(channelId, hostUid, fbUserId, now).run();
}

export async function channelsForFbUser(env: Env, fbUserId: string): Promise<{ channel_id: string; host_uid: string }[]> {
  try {
    return (await env.DB_META.prepare("SELECT channel_id, host_uid FROM hf_fb_logins WHERE fb_user_id=?1").bind(fbUserId).all<{ channel_id: string; host_uid: string }>()).results ?? [];
  } catch { return []; }
}

/** Forget the login mapping of one channel (Remove channel, deauthorize, data deletion). Never throws. */
export async function wipeFbChannel(env: Env, channelId: string): Promise<void> {
  try { await env.DB_META.prepare("DELETE FROM hf_fb_logins WHERE channel_id=?1").bind(channelId).run(); } catch { /* table not applied yet: nothing was stored */ }
}
