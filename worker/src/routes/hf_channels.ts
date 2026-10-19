// [HF-WIRE-3] Influencer Channels for the Reels app (HF-REEL-23/25/26). Flag hfChannelsEnabled (off -> 404 not_enabled).
//   POST   /api/hf/channels            { platform:'instagram'|'youtube', handleOrUrl, consent:{version, embeds, counts, ownChannel} }
//                                      -> { ok, channel, verifyCode, instructions, minFollowers, hostStatus }
//   GET    /api/hf/channels            -> { ok, channels:[channel], minFollowers, hostStatus, qualified }       (the caller's own only)
//   POST   /api/hf/channels/:id/check  -> { ok, result, message, channel, minFollowers, hostStatus, qualified } re-reads the bio / description (no cache)
//   POST   /api/hf/channels/:id/resync -> same shape as check (followers refresh for a verified channel)
//   DELETE /api/hf/channels/:id        -> { ok, channel }  status 'disconnected' (idempotent)
//   POST   /api/hf/channels/youtube/connect { accessToken }   [HF-WIRE-14, HF-REEL-33] sign in with YouTube (Google, scope youtube.readonly): the app sends the
//                                      access token; channels.list?mine=true returns HER channel, which proves ownership (no bio code). Approves when subscribers
//                                      >= minimum, imports the DETAILS of her public videos (embeds only, visible=1). The token is never stored.
//                                      -> same shape as /check plus { imported:{fetched,inserted} }; errors: token_invalid 400 (not 401: the app would think the Hello Fraands session ended), no_youtube_channel 404, channel_claimed 409
// channel = { id, platform, handle, url, followers, state:'checking'|'approved'|'needs_followers'|'disconnected', verified, needsCode,
//             verifyCode (only while the code is still needed), lastSyncAt, createdAt }
// result = 'approved' | 'needs_followers' | 'code_missing' | 'not_found' | 'private' | 'hidden_count'
// Acceptance (owner 2026-10-19): the host is accepted when ANY connected channel is ownership-verified AND has followers >= hfInfluencerMinFollowers.
// Accepted means hf_hosts.status = 'approved' (created as 'pending_check' when the first channel is added; falls back to 'pending_check' when no
// approved channel is left). Statuses of an existing web-onboarding host (draft, pending_review, live...) are never overwritten.
// Signed in only. Every query is scoped to host_uid = caller. No uid, secret or provider payload is ever returned.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { trackUser, trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { emailFor } from "../lib/identity";
import { readConfig } from "./config";
import { ensureSlug } from "../lib/hf_host_store"; // [HF-WIRE-10]
import { importChannelReels, importCountOf, refreshDemoReels } from "../lib/hf_reels_import"; // [HF-WIRE-4]
import {
  lookupChannel, makeVerifyCode, bioHasCode, ProviderError, youtubeOwnChannel, type ChannelLookup, type ChannelPlatform,
} from "../lib/hf_channel_providers";

const APP = BRAND.slug;
export const MAX_CHANNELS = 5;
export const CONSENT_VERSION_MAX = 40;
const RESYNC_EVERY_MS = 20 * 3600 * 1000;
const NO_STORE = { "cache-control": "private, no-store" };
const err = (status: number, error: string, message?: string, extra: Record<string, unknown> = {}) =>
  json({ ok: false, error, message: message ?? error, ...extra }, status, NO_STORE);

interface ChRow {
  id: string; host_uid: string; platform: string; handle: string; url: string | null; platform_user_id: string | null;
  followers: number; verify_code: string | null; verified_at: number | null; status: string; consent_version: string | null;
  consent_at: number | null; provider_ref: string | null; last_sync_at: number | null; created_at: number;
}
const COLS = "id, host_uid, platform, handle, url, platform_user_id, followers, verify_code, verified_at, status, consent_version, consent_at, provider_ref, last_sync_at, created_at";

const PLATFORM_NAME: Record<string, string> = { instagram: "Instagram", youtube: "YouTube" };
const WHERE_TO_PUT: Record<string, string> = { instagram: "your Instagram bio", youtube: "your YouTube channel description (About)" };

export function minFollowersOf(cfg: Record<string, unknown>): number {
  const v = Number(cfg.hfInfluencerMinFollowers);
  return Number.isInteger(v) && v >= 0 ? v : 10;
}

export function channelJson(r: ChRow) {
  const verified = r.verified_at != null;
  const state = r.status === "disconnected" ? "disconnected" : r.status === "approved" ? "approved" : r.status === "rejected" ? "needs_followers" : "checking";
  const needsCode = r.status === "pending" && !verified;
  return {
    id: r.id, platform: r.platform, handle: r.handle, url: r.url, followers: Number(r.followers ?? 0), state, verified, needsCode,
    ...(needsCode && r.verify_code ? { verifyCode: r.verify_code } : {}),
    lastSyncAt: r.last_sync_at ?? null, createdAt: r.created_at,
  };
}

function instructionsFor(platform: string, code: string): string {
  return `Add ${code} to ${WHERE_TO_PUT[platform] ?? "your profile"}, save it, then tap "I've added it, check now". You can remove it after we confirm.`;
}

function providerFailure(e: ProviderError, platform: string): Response {
  const name = PLATFORM_NAME[platform] ?? "that site";
  if (e.code === "bad_handle") return err(400, "invalid_field", `That does not look like a ${name} ${platform === "youtube" ? "channel" : "username"}. Check the spelling.`, { field: "handleOrUrl" });
  if (e.code === "provider_not_configured") return err(503, "provider_not_configured", platform === "instagram" ? "Instagram is coming soon." : "Channel checks are not switched on yet. Please try again later.");
  if (e.code === "token_invalid") return err(400, "token_invalid", "Google sign-in expired. Please sign in with YouTube again.");
  return err(503, "provider_unavailable", `We could not reach ${name} just now. Please try again in a minute.`);
}

function makeEmit(env: Env, ctx: ExecutionContext | undefined, uid: string) {
  return (event: string, props: Record<string, unknown> = {}): void => {
    const p = (async () => {
      const email = await emailFor(env, uid).catch(() => null);
      await trackUser(env, uid, email, event, APP, { area: "hf_channels", ...props });
    })().catch(() => { /* best-effort */ });
    if (ctx) ctx.waitUntil(p);
  };
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const t = await req.text().catch(() => "");
  if (!t || t.length > 10_000) return null;
  try { const v = JSON.parse(t); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null; } catch { return null; }
}

/** [HF-WIRE-10] Approved influencers need hf_hosts.slug or the feed and profile skip them. Same generator as web hosts
 * (`<first-name>-<4 random>`, unique, never changes an existing slug). Name hint: display_name, else the approved channel's handle. Never throws. */
async function ensureInfluencerSlug(env: Env, uid: string): Promise<void> {
  try {
    const h = await env.DB_META.prepare("SELECT slug, display_name FROM hf_hosts WHERE uid=?1").bind(uid).first<{ slug: string | null; display_name: string | null }>();
    if (!h || h.slug) return;
    let name = h.display_name;
    if (!name?.trim()) {
      name = (await env.DB_META.prepare("SELECT handle FROM hf_channels WHERE host_uid=?1 AND status='approved' ORDER BY created_at ASC LIMIT 1").bind(uid).first<{ handle: string | null }>())?.handle ?? null;
    }
    await ensureSlug(env, uid, name ?? "");
  } catch (e) {
    await trackException(env, e, { uid, route: "hf_channels.ensureInfluencerSlug", handled: true, app_name: APP, extra: { area: "hf_channels" } });
  }
}

/** Keep hf_hosts.status in step with the channels. Returns the host status afterwards (null = no row) and whether she qualifies. */
export async function syncHostState(env: Env, uid: string, now = Date.now()): Promise<{ hostStatus: string | null; qualified: boolean }> {
  const ok = Number((await env.DB_META.prepare("SELECT COUNT(*) AS c FROM hf_channels WHERE host_uid=?1 AND status='approved'").bind(uid).first<{ c: number }>())?.c ?? 0);
  const host = await env.DB_META.prepare("SELECT status FROM hf_hosts WHERE uid=?1").bind(uid).first<{ status: string }>();
  const cur = host?.status ?? null;
  if (ok > 0) {
    if (cur === null) {
      await env.DB_META.prepare("INSERT OR IGNORE INTO hf_hosts (uid, status, created_at, updated_at) VALUES (?1, 'approved', ?2, ?2)").bind(uid, now).run();
      await ensureInfluencerSlug(env, uid);
      return { hostStatus: "approved", qualified: true };
    }
    if (cur === "pending_check") {
      await env.DB_META.prepare("UPDATE hf_hosts SET status='approved', updated_at=?2 WHERE uid=?1 AND status='pending_check'").bind(uid, now).run();
      await ensureInfluencerSlug(env, uid);
      return { hostStatus: "approved", qualified: true };
    }
    await ensureInfluencerSlug(env, uid); // [HF-WIRE-10] heals hosts approved before this fix
    return { hostStatus: cur, qualified: true };
  }
  if (cur === "approved") {
    await env.DB_META.prepare("UPDATE hf_hosts SET status='pending_check', updated_at=?2 WHERE uid=?1 AND status='approved'").bind(uid, now).run();
    return { hostStatus: "pending_check", qualified: false };
  }
  return { hostStatus: cur, qualified: false };
}

async function ensureHostRow(env: Env, uid: string, now: number): Promise<void> {
  await env.DB_META.prepare("INSERT OR IGNORE INTO hf_hosts (uid, status, created_at, updated_at) VALUES (?1, 'pending_check', ?2, ?2)").bind(uid, now).run();
}

export type CheckResult = "approved" | "needs_followers" | "code_missing" | "not_found" | "private" | "hidden_count" | "claimed";

const RESULT_TEXT = (min: number): Record<CheckResult, string> => ({
  approved: "You're in! Your channel is confirmed.",
  needs_followers: `We need at least ${min} followers or subscribers on YouTube or Instagram.`,
  code_missing: "We could not see the code yet. It can take a minute to show. Check it is saved, then try again.",
  not_found: "We could not find that channel any more. Check the name and try again.",
  private: "This Instagram account is private. Make it public for now so we can check it.",
  hidden_count: "Your subscriber count is hidden. Show it in your YouTube settings, then check again.",
  claimed: "That channel is already connected to another person.",
});

/** Re-read the channel, check the code (until verified once), refresh followers and set the status. Never called for a disconnected channel. */
async function runCheck(env: Env, ch: ChRow, min: number, lookup?: ChannelLookup): Promise<{ result: CheckResult; row: ChRow }> {
  const now = Date.now();
  const lk = lookup ?? await lookupChannel(env, ch.platform as ChannelPlatform, ch.platform === "youtube" && ch.platform_user_id ? ch.platform_user_id : ch.handle);
  const save = async (patch: Partial<ChRow>): Promise<ChRow> => {
    const next = { ...ch, ...patch } as ChRow;
    await env.DB_META.prepare("UPDATE hf_channels SET followers=?2, verified_at=?3, status=?4, platform_user_id=?5, handle=?6, url=?7, last_sync_at=?8 WHERE id=?1")
      .bind(next.id, next.followers, next.verified_at, next.status, next.platform_user_id, next.handle, next.url, next.last_sync_at).run();
    return next;
  };
  if (!lk.exists || (ch.platform_user_id && lk.platformUserId && lk.platformUserId !== ch.platform_user_id)) {
    return { result: "not_found", row: await save({ last_sync_at: now }) };
  }
  if (lk.isPrivate) return { result: "private", row: await save({ last_sync_at: now }) };
  const wasVerified = ch.verified_at != null;
  if (!wasVerified && !(ch.verify_code && bioHasCode(lk.bio, ch.verify_code))) {
    return { result: "code_missing", row: await save({ followers: lk.followers, last_sync_at: now }) };
  }
  const hidden = lk.countHidden;
  const status = !hidden && lk.followers >= min ? "approved" : "rejected";
  try {
    const row = await save({
      followers: lk.followers, verified_at: ch.verified_at ?? now, status, platform_user_id: lk.platformUserId ?? ch.platform_user_id,
      handle: lk.handle || ch.handle, url: lk.url || ch.url, last_sync_at: now,
    });
    return { result: hidden ? "hidden_count" : status === "approved" ? "approved" : "needs_followers", row };
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String((e as Error)?.message ?? e))) return { result: "claimed", row: ch };
    throw e;
  }
}

/** [HF-WIRE-4] Import the latest reels of an approved channel; never throws (a provider outage must not break the channel check). */
async function importForChannel(env: Env, ch: ChRow, n: number, auth?: { bearer?: string }): Promise<{ fetched: number; inserted: number; updated: number } | null> {
  try { return await importChannelReels(env, ch, n, auth ? { auth } : {}); } catch (e) {
    if (!(e instanceof ProviderError)) await trackException(env, e, { route: "hf_reels_import", method: "JOB", handled: true, app_name: APP, extra: { area: "hf_reels", platform: ch.platform } }).catch(() => {});
    return null;
  }
}

async function loadOwn(env: Env, uid: string, id: string): Promise<ChRow | null> {
  return (await env.DB_META.prepare(`SELECT ${COLS} FROM hf_channels WHERE id=?1 AND host_uid=?2`).bind(id, uid).first<ChRow>()) ?? null;
}

export async function hfChannelsRoute(req: Request, env: Env, p: string, ctx?: ExecutionContext, ytFetch?: typeof fetch): Promise<Response | null> {
  const m = p.match(/^\/api\/hf\/channels(?:\/(hfch_[a-z0-9]{8,40}))?(?:\/(check|resync))?$/);
  const isConnect = p === "/api/hf/channels/youtube/connect";
  if (!m && !isConnect) return null;
  const id = m?.[1] ?? null;
  const action = m?.[2] ?? null;
  const method = req.method;
  const allowed = isConnect ? method === "POST" : !id ? (method === "GET" || method === "POST") : action ? method === "POST" : method === "DELETE";
  if (!allowed) return err(405, "method_not_allowed");
  let uid = "";
  try {
    const cfg = await readConfig(env);
    if (cfg.hfChannelsEnabled !== true) return err(404, "not_enabled");
    const u = await requireUser(req, env);
    if (isFail(u)) return err(u.status, u.error);
    uid = u.uid;
    const min = minFollowersOf(cfg as unknown as Record<string, unknown>);
    const emit = makeEmit(env, ctx, uid);

    // ── POST /api/hf/channels/youtube/connect  [HF-WIRE-14] ─────────────────────────────────────────────────────
    if (isConnect) {
      const lim = await rateLimit(env, `hfyt:${uid}`, 10, 3600);
      if (lim) return lim;
      const b = await readBody(req);
      const token = typeof b?.accessToken === "string" ? b.accessToken : "";
      if (!token) return err(400, "invalid_field", "Please sign in with YouTube.", { field: "accessToken" });
      let lk: ChannelLookup;
      try { lk = await youtubeOwnChannel(token, ytFetch ?? fetch); } catch (e) {
        if (e instanceof ProviderError) { emit("hf_channel_added", { platform: "youtube", ok: false, code: e.code, via: "signin" }); return providerFailure(e, "youtube"); }
        throw e;
      }
      if (!lk.exists || !lk.platformUserId) return err(404, "no_youtube_channel", "This Google account has no YouTube channel. Create one on YouTube, then try again.");
      const active = Number((await env.DB_META.prepare("SELECT COUNT(*) AS c FROM hf_channels WHERE host_uid=?1 AND status!='disconnected'").bind(uid).first<{ c: number }>())?.c ?? 0);
      const mine0 = await env.DB_META.prepare(`SELECT ${COLS} FROM hf_channels WHERE host_uid=?1 AND platform='youtube' AND platform_user_id=?2 AND status!='disconnected' LIMIT 1`).bind(uid, lk.platformUserId).first<ChRow>();
      if (!mine0 && active >= MAX_CHANNELS) return err(409, "limit_reached", `You can connect up to ${MAX_CHANNELS} channels. Remove one first.`);
      const claimed = await env.DB_META.prepare("SELECT id FROM hf_channels WHERE platform='youtube' AND platform_user_id=?1 AND verified_at IS NOT NULL AND status!='disconnected' AND host_uid!=?2 LIMIT 1").bind(lk.platformUserId, uid).first();
      if (claimed) { emit("hf_channel_added", { platform: "youtube", ok: false, code: "channel_claimed", via: "signin" }); return err(409, "channel_claimed", RESULT_TEXT(min).claimed); }
      const now = Date.now();
      const status = !lk.countHidden && lk.followers >= min ? "approved" : "rejected";
      let row: ChRow;
      try {
        if (mine0) {
          row = { ...mine0, followers: lk.followers, verified_at: mine0.verified_at ?? now, status, handle: lk.handle || mine0.handle, url: lk.url || mine0.url, last_sync_at: now, verify_code: null };
          await env.DB_META.prepare("UPDATE hf_channels SET followers=?2, verified_at=?3, status=?4, handle=?5, url=?6, last_sync_at=?7, verify_code=NULL WHERE id=?1")
            .bind(row.id, row.followers, row.verified_at, row.status, row.handle, row.url, row.last_sync_at).run();
        } else {
          row = {
            id: "hfch_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20), host_uid: uid, platform: "youtube", handle: lk.handle, url: lk.url || null, platform_user_id: lk.platformUserId,
            followers: lk.followers, verify_code: null, verified_at: now, status, consent_version: "google-signin-1", consent_at: now, provider_ref: "youtube-oauth", last_sync_at: now, created_at: now,
          };
          await env.DB_META.prepare(`INSERT INTO hf_channels (${COLS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`)
            .bind(row.id, row.host_uid, row.platform, row.handle, row.url, row.platform_user_id, row.followers, row.verify_code, row.verified_at, row.status,
              row.consent_version, row.consent_at, row.provider_ref, row.last_sync_at, row.created_at).run();
        }
      } catch (e) {
        if (/UNIQUE|constraint/i.test(String((e as Error)?.message ?? e))) return err(409, "channel_claimed", RESULT_TEXT(min).claimed);
        throw e;
      }
      await ensureHostRow(env, uid, now);
      const st = await syncHostState(env, uid);
      let imported: { fetched: number; inserted: number } | null = null;
      if (status === "approved" && cfg.hfReelsEnabled === true) {
        const r = await importForChannel(env, row, importCountOf(cfg as unknown as Record<string, unknown>), { bearer: token.trim() });
        imported = r ? { fetched: r.fetched, inserted: r.inserted } : null;
      }
      const result: CheckResult = lk.countHidden ? "hidden_count" : status === "approved" ? "approved" : "needs_followers";
      emit("hf_channel_added", { platform: "youtube", ok: true, via: "signin", result, followers: row.followers, qualified: st.qualified });
      return json({ ok: true, result, message: RESULT_TEXT(min)[result], channel: channelJson(row), minFollowers: min, hostStatus: st.hostStatus, qualified: st.qualified, imported }, 200, NO_STORE);
    }

    // ── GET /api/hf/channels ────────────────────────────────────────────────────────────────────────────────────
    if (!id && method === "GET") {
      const rows = (await env.DB_META.prepare(`SELECT ${COLS} FROM hf_channels WHERE host_uid=?1 ORDER BY created_at DESC LIMIT 50`).bind(uid).all<ChRow>()).results ?? [];
      const host = await env.DB_META.prepare("SELECT status FROM hf_hosts WHERE uid=?1").bind(uid).first<{ status: string }>();
      return json({ ok: true, channels: rows.map(channelJson), minFollowers: min, hostStatus: host?.status ?? null, qualified: rows.some((r) => r.status === "approved") }, 200, NO_STORE);
    }

    // ── POST /api/hf/channels ───────────────────────────────────────────────────────────────────────────────────
    if (!id) {
      const lim = await rateLimit(env, `hfch:${uid}`, 20, 3600);
      if (lim) return lim;
      const b = await readBody(req);
      if (!b) return err(400, "invalid_body", "Please send your channel details.");
      const platform = String(b.platform ?? "").toLowerCase();
      if (platform === "facebook") return err(400, "platform_unsupported", "Facebook is coming soon. Please use Instagram or YouTube for now.", { field: "platform" });
      if (platform !== "instagram" && platform !== "youtube") return err(400, "invalid_field", "Pick Instagram or YouTube.", { field: "platform" });
      const handleOrUrl = typeof b.handleOrUrl === "string" ? b.handleOrUrl : "";
      const consent = (b.consent && typeof b.consent === "object" ? b.consent : {}) as Record<string, unknown>;
      const version = typeof consent.version === "string" ? consent.version.trim() : "";
      if (!version || version.length > CONSENT_VERSION_MAX || consent.embeds !== true || consent.counts !== true || consent.ownChannel !== true) {
        return err(400, "consent_required", "Please tick every box so we can show your reels.", { field: "consent" });
      }
      const active = Number((await env.DB_META.prepare("SELECT COUNT(*) AS c FROM hf_channels WHERE host_uid=?1 AND status!='disconnected'").bind(uid).first<{ c: number }>())?.c ?? 0);
      if (active >= MAX_CHANNELS) return err(409, "limit_reached", `You can connect up to ${MAX_CHANNELS} channels. Remove one first.`);

      let lk: ChannelLookup;
      try { lk = await lookupChannel(env, platform, handleOrUrl); } catch (e) {
        if (e instanceof ProviderError) { emit("hf_channel_added", { platform, ok: false, code: e.code }); return providerFailure(e, platform); }
        throw e;
      }
      if (!lk.exists || !lk.platformUserId) return err(404, "channel_not_found", `We could not find that ${PLATFORM_NAME[platform]} ${platform === "youtube" ? "channel" : "account"}. Check the name and try again.`, { field: "handleOrUrl" });
      if (lk.isPrivate) return err(400, "channel_private", RESULT_TEXT(min).private, { field: "handleOrUrl" });

      const claimed = await env.DB_META.prepare("SELECT id FROM hf_channels WHERE platform=?1 AND platform_user_id=?2 AND verified_at IS NOT NULL AND status!='disconnected' AND host_uid!=?3 LIMIT 1")
        .bind(platform, lk.platformUserId, uid).first();
      if (claimed) { emit("hf_channel_added", { platform, ok: false, code: "channel_claimed" }); return err(409, "channel_claimed", RESULT_TEXT(min).claimed); }

      const mine = await env.DB_META.prepare(`SELECT ${COLS} FROM hf_channels WHERE host_uid=?1 AND platform=?2 AND platform_user_id=?3 AND status!='disconnected' LIMIT 1`)
        .bind(uid, platform, lk.platformUserId).first<ChRow>();
      if (mine && mine.verified_at != null) return err(409, "already_connected", "You already connected this channel.");
      const now = Date.now();
      let row: ChRow;
      if (mine) {
        row = mine; // a pending attempt: show the same code again
      } else {
        const newId = "hfch_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
        row = {
          id: newId, host_uid: uid, platform, handle: lk.handle, url: lk.url || null, platform_user_id: lk.platformUserId, followers: lk.followers,
          verify_code: makeVerifyCode(), verified_at: null, status: "pending", consent_version: version, consent_at: now,
          provider_ref: platform === "youtube" ? "youtube-data-api-v3" : "treg", last_sync_at: now, created_at: now,
        };
        await env.DB_META.prepare(`INSERT INTO hf_channels (${COLS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`)
          .bind(row.id, row.host_uid, row.platform, row.handle, row.url, row.platform_user_id, row.followers, row.verify_code, row.verified_at, row.status,
            row.consent_version, row.consent_at, row.provider_ref, row.last_sync_at, row.created_at).run();
      }
      await ensureHostRow(env, uid, now);
      const host = await env.DB_META.prepare("SELECT status FROM hf_hosts WHERE uid=?1").bind(uid).first<{ status: string }>();
      emit("hf_channel_added", { platform, ok: true, followers: row.followers, consent_version: version });
      return json({ ok: true, channel: { ...channelJson(row), verifyCode: row.verify_code }, verifyCode: row.verify_code, instructions: instructionsFor(platform, row.verify_code ?? ""), minFollowers: min, hostStatus: host?.status ?? null }, 200, NO_STORE);
    }

    // ── routes on one channel: always the caller's own ──────────────────────────────────────────────────────────
    const ch = await loadOwn(env, uid, id);
    if (!ch) return err(404, "not_found", "We could not find that channel.");

    if (method === "DELETE") {
      if (ch.status !== "disconnected") {
        await env.DB_META.prepare("UPDATE hf_channels SET status='disconnected' WHERE id=?1 AND host_uid=?2").bind(id, uid).run();
        await syncHostState(env, uid);
        emit("hf_channel_removed", { platform: ch.platform });
      }
      return json({ ok: true, channel: channelJson({ ...ch, status: "disconnected" }) }, 200, NO_STORE);
    }

    // check / resync
    if (ch.status === "disconnected") return err(409, "disconnected", "This channel was removed. Add it again to check it.");
    const lim = await rateLimit(env, `hfchk:${uid}`, 30, 3600);
    if (lim) return lim;
    const limCh = await rateLimit(env, `hfchk:${id}`, 6, 600);
    if (limCh) return limCh;
    let out: { result: CheckResult; row: ChRow };
    try { out = await runCheck(env, ch, min); } catch (e) {
      if (e instanceof ProviderError) { emit("hf_channel_check", { platform: ch.platform, action, ok: false, code: e.code }); return providerFailure(e, ch.platform); }
      throw e;
    }
    if (out.result === "claimed") return err(409, "channel_claimed", RESULT_TEXT(min).claimed);
    const st = await syncHostState(env, uid);
    if (out.result === "approved" && cfg.hfReelsEnabled === true) { // [HF-WIRE-4] first import on approval (and on every manual re-check)
      const job = importForChannel(env, out.row, importCountOf(cfg as unknown as Record<string, unknown>));
      if (ctx) ctx.waitUntil(job); else await job;
    }
    emit("hf_channel_check", { platform: ch.platform, action, ok: true, result: out.result, followers: out.row.followers, qualified: st.qualified });
    return json({ ok: true, result: out.result, message: RESULT_TEXT(min)[out.result], channel: channelJson(out.row), minFollowers: min, hostStatus: st.hostStatus, qualified: st.qualified }, 200, NO_STORE);
  } catch (e) {
    await trackException(env, e, { route: p, method, handled: true, app_name: APP, extra: { area: "hf_channels", uid_set: !!uid } });
    return err(500, "internal_error", "Something went wrong. Please try again.");
  }
}

/**
 * Daily re-check of every verified channel (HF-WIRE-3, handover §6.3). Safe to call on every cron tick: it only touches channels not synced in the last 20 hours
 * and at most BATCH per call. Followers are refreshed WITHOUT the code check (ownership was proven once). A host with no approved channel left drops back to
 * 'pending_check' (hidden from the feed, not deleted). The WhatsApp alert to that influencer is not sent yet (needs the WhatsApp template; see the progress log).
 */
export async function recheckAllChannels(env: Env, batch = 25): Promise<{ scanned: number; updated: number; failed: number; demoted: number }> {
  const out = { scanned: 0, updated: 0, failed: 0, demoted: 0 };
  const cfg = await readConfig(env).catch(() => null);
  if (!cfg || cfg.hfChannelsEnabled !== true) return out;
  const min = minFollowersOf(cfg as unknown as Record<string, unknown>);
  const cutoff = Date.now() - RESYNC_EVERY_MS;
  const rows = (await env.DB_META.prepare(
    `SELECT ${COLS} FROM hf_channels WHERE verified_at IS NOT NULL AND status IN ('approved','rejected') AND (last_sync_at IS NULL OR last_sync_at < ?1) ORDER BY last_sync_at ASC LIMIT ?2`,
  ).bind(cutoff, batch).all<ChRow>()).results ?? [];
  const hosts = new Set<string>();
  for (const ch of rows) {
    out.scanned++;
    try {
      const r = await runCheck(env, ch, min);
      if (r.result !== "claimed") out.updated++;
      if (r.result === "approved" && cfg.hfReelsEnabled === true) await importForChannel(env, r.row, importCountOf(cfg as unknown as Record<string, unknown>)); // [HF-WIRE-4] daily refresh
      hosts.add(ch.host_uid);
    } catch (e) {
      out.failed++;
      if (e instanceof ProviderError && e.code === "provider_not_configured") break;
    }
  }
  try { await refreshDemoReels(env); } catch { /* demo details refresh is best effort */ } // [HF-WIRE-14]
  for (const uid of hosts) {
    try {
      const before = await env.DB_META.prepare("SELECT status FROM hf_hosts WHERE uid=?1").bind(uid).first<{ status: string }>();
      const after = await syncHostState(env, uid);
      if (before?.status === "approved" && after.hostStatus === "pending_check") out.demoted++;
    } catch { /* next tick retries */ }
  }
  return out;
}
