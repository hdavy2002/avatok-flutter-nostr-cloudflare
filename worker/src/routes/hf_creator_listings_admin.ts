// [HF-CREATOR-PRICE-1] Private creator draft CRUD. Publication never fabricates verification, presence or review counts.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { isAdminUid } from "../lib/preview";
import { trackException, trackUser } from "../hooks";
import { emailFor } from "../lib/identity";
import { BRAND } from "../lib/brand";
import { encryptPii, tryDecryptPii } from "../lib/pii_crypto";
import { getHost, hostToJson, upsertHost, listMedia, mediaToJson, avatarUrlFor, HostWriteConflict, type HostPatch, type HostRow } from "../lib/hf_host_store";
import { creatorPublicationBlockers } from "../lib/hf_creator_publication";
import { isHostCategory, isCreatorCategory, validCreatorRate, CREATOR_MIN_RUPEES, CREATOR_MAX_RUPEES } from "../lib/hf_creator_pricing";
import { LANGUAGES, TOPIC_SLUGS, contactLeak } from "../lib/hf_options";
import { normalizeIntroMime, validateIntro, INTRO_ACCEPTED_TYPES, INTRO_MIN_SECONDS, INTRO_MAX_BYTES, INTRO_MAX_SECONDS } from "../lib/hf_intro";
import { transcribeAndFlag } from "../lib/hf_intro_check";
import { CREATOR_FIXTURES, isCreatorFixture } from "../lib/hf_creator_fixtures";
import { card, SEL, type LiveRow } from "./hf_hosts_public";

const headers = { "cache-control": "private, no-store" };
const reply = (body: unknown, status = 200) => json(body, status, headers);
const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => reply({ error, ...extra }, status);
const EDITABLE = new Set(["draft", "pending_host", "paused", "rejected"]);

async function body(req: Request): Promise<Record<string, unknown> | null> {
  if (Number(req.headers.get("content-length") ?? 0) > 16000) return null;
  const bytes = await boundedBytes(req, 16000);
  if (!bytes) return null;
  try { const value: unknown = JSON.parse(new TextDecoder().decode(bytes)); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
}
/** Bound streamed uploads even when Content-Length is missing or false. */
async function boundedBytes(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body || Number(req.headers.get("content-length") ?? 0) > max) return null;
  const reader = req.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > max) { await reader.cancel(); return null; }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function detail(env: Env, uid: string) {
  const h = await getHost(env, uid);
  if (!h) return null;
  return { ...hostToJson(env, h, await avatarUrlFor(env, h.avatar_id)),
    sampleData: isCreatorFixture(uid),
    privatePhone: await tryDecryptPii(env, h.private_phone_enc),
    media: (await listMedia(env, uid)).map(m => mediaToJson(env, m)),
    publicationBlockers: await creatorPublicationBlockers(env, uid),
    uploads: { voice: { method: "PUT", path: `/api/admin/hf/listings/${encodeURIComponent(uid)}/voice`, minSeconds: INTRO_MIN_SECONDS, maxSeconds: INTRO_MAX_SECONDS, maxBytes: INTRO_MAX_BYTES, acceptedTypes: INTRO_ACCEPTED_TYPES },
      image: { method: "PUT", path: `/api/admin/hf/listings/${encodeURIComponent(uid)}/media`, kinds: ["profile", "gallery"], maxBytes: 10 * 1024 * 1024, acceptedTypes: ["image/jpeg", "image/png", "image/webp"] } },
  };
}
async function emit(env: Env, actor: string, uid: string, action: string, props: Record<string, unknown> = {}) {
  await env.DB_WALLET.prepare("INSERT INTO admin_audit (id,admin_id,action,target,meta,created_at) VALUES (?1,?2,?3,?4,?5,?6)")
    .bind(crypto.randomUUID(), actor, `hf_creator_${action}`, uid, JSON.stringify(props), Date.now()).run();
  await trackUser(env, uid, await emailFor(env, uid).catch(() => null), `hf_creator_listing_${action}`, BRAND.slug, { admin_uid: actor, ...props });
}

export async function hfCreatorListingsAdminRoute(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/api\/admin\/hf\/listings(?:\/([A-Za-z0-9._:-]{1,128})(?:\/(publish|voice|media|preview))?)?$/);
  if (!match) return null;
  const user = await requireUser(req, env); if (isFail(user)) return fail(user.status, user.error);
  if (!isAdminUid(env, user.uid)) return fail(403, "forbidden");
  const uid = match[1], action = match[2];
  try {
    if (uid === "seed" && !action && req.method === "POST") {
      const input = await body(req);
      if (input?.mode !== "private_drafts") return fail(400, "private_drafts_required");
      const now = Date.now();
      // Idempotent, explicit admin action. Existing fixture edits are never overwritten.
      await env.DB_META.batch(CREATOR_FIXTURES.map(f => env.DB_META.prepare(
        "INSERT OR IGNORE INTO hf_hosts (uid,slug,status,presence,category,display_name,tagline,about,price_per_min,languages_json,topics_json,created_at,updated_at) VALUES (?1,?2,'draft','offline',?3,?4,?5,'A fictional profile for private layout review.',?6,?7,?8,?9,?9)"
      ).bind(f.uid, f.slug, f.category, f.name, f.tagline, f.price, JSON.stringify(f.languages), JSON.stringify(f.topics), now)));
      await emit(env, user.uid, user.uid, "fixtures_seeded", { count: CREATOR_FIXTURES.length, sample_data: true });
      return reply({ items: await Promise.all(CREATOR_FIXTURES.map(f => detail(env, f.uid))) });
    }
    if (!uid && req.method === "GET") {
      const rows = (await env.DB_META.prepare("SELECT * FROM hf_hosts WHERE category IN ('influencer','celebrity') AND status<>'archived' ORDER BY updated_at DESC LIMIT 100").all<HostRow>()).results ?? [];
      return reply({ items: rows.map(h => hostToJson(env, h)) });
    }
    if (!uid && req.method === "POST") {
      const input = await body(req);
      if (!input || typeof input.uid !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.uid) || !isCreatorCategory(input.category)) return fail(400, "invalid_field", { field: "uid_or_category" });
      const account = await env.DB_META.prepare("SELECT uid FROM users WHERE uid=?1").bind(input.uid).first<{ uid: string }>();
      if (!account) return fail(404, "account_not_found", { field: "uid" });
      if (await getHost(env, input.uid)) return fail(409, "listing_exists");
      // Draft creation does not fabricate an identity, verified phone, KYC, media or public availability.
      if (isCreatorFixture(input.uid)) return fail(400, "reserved_uid");
      await upsertHost(env, input.uid, { category: input.category, status: "draft" }, { revision: 0, statuses: ["draft"] });
      await emit(env, user.uid, input.uid, "created", { category: input.category });
      return reply({ listing: await detail(env, input.uid) }, 201);
    }
    if (!uid) return fail(405, "method_not_allowed");
    const h = await getHost(env, uid); if (!h) return fail(404, "not_found");
    if (action === "preview" && req.method === "GET") {
      const row = await env.DB_META.prepare(`${SEL} WHERE h.uid=?1`).bind(uid).first<LiveRow>();
      if (!row) return fail(404, "not_found");
      // Private preview uses the real public card mapping, always offline and with no invented aggregates.
      return reply({ item: card(env, { ...row, presence: "offline" }), sampleData: isCreatorFixture(uid), publicationStatus: h.status });
    }
    if (!action && req.method === "GET") {
      await emit(env, user.uid, uid, "viewed");
      return reply({ listing: await detail(env, uid) });
    }
    if (!action && req.method === "DELETE") {
      if (!EDITABLE.has(h.status)) return fail(409, "pause_before_archiving");
      await upsertHost(env, uid, { status: "archived" }, { revision: h.listing_revision ?? 1, statuses: [...EDITABLE] });
      await emit(env, user.uid, uid, "archived");
      return reply({ ok: true, status: "archived" });
    }
    if (!action && req.method === "PUT") {
      if (!EDITABLE.has(h.status)) return fail(409, "listing_locked");
      const input = await body(req); if (!input) return fail(400, "invalid_json");
      const patch: HostPatch = {};
      const allowed = new Set(["category", "pricePerMin", "displayName", "tagline", "about", "languages", "topics", "privatePhone", "avatarId"]);
      for (const key of Object.keys(input)) if (!allowed.has(key)) return fail(400, "invalid_field", { field: key });
      if ("category" in input) {
        if (!isHostCategory(input.category)) return fail(400, "invalid_field", { field: "category" });
        patch.category = input.category;
      }
      if ("pricePerMin" in input) {
        if (!isCreatorCategory(patch.category ?? h.category) || !validCreatorRate(input.pricePerMin)) return fail(400, "invalid_field", { field: "pricePerMin", min: CREATOR_MIN_RUPEES, max: CREATOR_MAX_RUPEES });
        patch.price_per_min = input.pricePerMin;
      }
      for (const [key, col, max] of [["displayName", "display_name", 40], ["tagline", "tagline", 120], ["about", "about", 600]] as const) {
        if (!(key in input)) continue;
        const value = input[key];
        if (typeof value !== "string" || value.trim().length > max || contactLeak(value)) return fail(400, "invalid_field", { field: key });
        patch[col] = value.trim();
      }
      for (const key of ["languages", "topics"] as const) {
        if (!(key in input)) continue;
        const values = input[key];
        if (!Array.isArray(values) || values.length > 6 || values.some(v => typeof v !== "string" || (key === "languages" ? !(LANGUAGES as readonly string[]).includes(v) : !TOPIC_SLUGS.has(v)))) return fail(400, "invalid_field", { field: key });
        patch[key === "languages" ? "languages_json" : "topics_json"] = JSON.stringify([...new Set(values)]);
      }
      if ("privatePhone" in input) {
        if (input.privatePhone !== null && (typeof input.privatePhone !== "string" || !/^\+[1-9]\d{7,14}$/.test(input.privatePhone))) return fail(400, "invalid_field", { field: "privatePhone" });
        patch.private_phone_enc = input.privatePhone ? await encryptPii(env, input.privatePhone as string) : null;
      }
      if ("avatarId" in input) {
        if (typeof input.avatarId !== "string" || !(await env.DB_META.prepare("SELECT id FROM hf_avatars WHERE id=?1 AND status='active' AND (taken_by_uid IS NULL OR taken_by_uid=?2)").bind(input.avatarId, uid).first())) return fail(400, "invalid_field", { field: "avatarId" });
        patch.avatar_id = input.avatarId;
      }
      await upsertHost(env, uid, patch, { revision: h.listing_revision ?? 1, statuses: [...EDITABLE] });
      await emit(env, user.uid, uid, "saved", { fields: Object.keys(input) });
      return reply({ listing: await detail(env, uid) });
    }
    if (action === "publish" && req.method === "POST") {
      if (!isCreatorCategory(h.category)) return fail(409, "use_standard_host_review");
      if (!EDITABLE.has(h.status) && h.status !== "pending_review") return fail(409, "listing_locked");
      const missing = await creatorPublicationBlockers(env, uid);
      if (missing.length) return fail(422, "publication_blocked", { missing });
      const r = await env.DB_META.prepare("UPDATE hf_hosts SET status='live', live_at=COALESCE(live_at,?2), reviewed_at=?2, reviewed_by=?3, updated_at=?2, listing_revision=listing_revision+1 WHERE uid=?1 AND listing_revision=?4 AND status IN ('draft','pending_host','paused','rejected','pending_review')")
        .bind(uid, Date.now(), user.uid, h.listing_revision ?? 1).run();
      if (!r.meta?.changes) return fail(409, "listing_changed");
      await emit(env, user.uid, uid, "published", { category: h.category, price_per_min: h.price_per_min });
      return reply({ listing: await detail(env, uid) });
    }
    if (action === "voice" && req.method === "PUT") {
      if (!EDITABLE.has(h.status)) return fail(409, "listing_locked");
      if (!["1", "v1"].includes(req.headers.get("x-voice-consent") ?? "")) return fail(400, "consent_required");
      const mime = normalizeIntroMime(req.headers.get("content-type"));
      if (!mime) return fail(415, "unsupported_type");
      const bytes = await boundedBytes(req, INTRO_MAX_BYTES); if (!bytes) return fail(413, "too_large");
      if (mime.ext === "mp3" && !(new TextDecoder().decode(bytes.slice(0, 3)) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) return fail(415, "invalid_mp3");
      const check = validateIntro(req.headers.get("x-duration-seconds"), bytes.byteLength);
      if (!check.ok) return fail(check.status, check.error, { message: check.message });
      const now = Date.now(), key = `hf/intro/${uid}/${now}-${crypto.randomUUID()}.${mime.ext}`;
      await env.VERIFICATION.put(key, bytes, { httpMetadata: { contentType: mime.mime } });
      try { await upsertHost(env, uid, { voice_sample_r2: key, voice_seconds: check.seconds, voice_consent_at: now, intro_mime: mime.mime, intro_status: "pending", intro_uploaded_at: now, intro_transcript: null, intro_flags_json: null }, { revision: h.listing_revision ?? 1, statuses: [...EDITABLE] }); }
      catch (e) { await env.VERIFICATION.delete(key); throw e; }
      if (h.voice_sample_r2) await env.VERIFICATION.delete(h.voice_sample_r2).catch(() => {});
      const job = transcribeAndFlag(env, uid, key, mime.mime, now);
      if (ctx) ctx.waitUntil(job); else await job;
      await emit(env, user.uid, uid, "voice_uploaded", { seconds: check.seconds, mime: mime.mime });
      return reply({ listing: await detail(env, uid) });
    }
    if (action === "voice" && req.method === "DELETE") {
      if (!EDITABLE.has(h.status)) return fail(409, "listing_locked");
      const now = Date.now(), revision = h.listing_revision ?? 1;
      const previous = (await listMedia(env, uid)).filter(m => m.kind === "intro_audio");
      const result = await env.DB_META.batch([
        env.DB_META.prepare("UPDATE hf_hosts SET voice_sample_r2=NULL, voice_seconds=NULL, voice_consent_at=NULL, intro_mime=NULL, intro_status=NULL, intro_transcript=NULL, intro_flags_json=NULL, intro_uploaded_at=NULL, listing_revision=listing_revision+1, updated_at=?2 WHERE uid=?1 AND listing_revision=?3 AND status IN ('draft','pending_host','paused','rejected')").bind(uid, now, revision),
        env.DB_META.prepare("UPDATE hf_host_media SET status='superseded' WHERE uid=?1 AND kind='intro_audio' AND status='active' AND changes()=1").bind(uid),
      ]);
      if (!result[0]?.meta?.changes) throw new HostWriteConflict("Listing changed; reload before saving.");
      if (h.voice_sample_r2) await env.VERIFICATION.delete(h.voice_sample_r2).catch(() => {});
      await Promise.all(previous.map(m => env.BLOBS.delete(m.r2_key).catch(() => {})));
      await emit(env, user.uid, uid, "voice_removed");
      return reply({ listing: await detail(env, uid) });
    }
    if (action === "media" && req.method === "PUT") {
      if (!EDITABLE.has(h.status)) return fail(409, "listing_locked");
      const kind = url.searchParams.get("kind");
      if (kind !== "profile" && kind !== "gallery") return fail(400, "invalid_kind");
      const mime = req.headers.get("content-type")?.split(";")[0].trim();
      const ext = mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : null;
      if (!ext) return fail(415, "unsupported_type");
      const bytes = await boundedBytes(req, 10 * 1024 * 1024); if (!bytes || bytes.length < 12) return fail(413, "invalid_size");
      const valid = ext === "jpg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : ext === "png" ? bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 : new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
      if (!valid) return fail(415, "invalid_image");
      const id = crypto.randomUUID(), key = `hf/hosts/${uid}/${id}.${ext}`, now = Date.now();
      await env.BLOBS.put(key, bytes, { httpMetadata: { contentType: mime! } });
      const revision = h.listing_revision ?? 1;
      try {
        await env.DB_META.batch([
          env.DB_META.prepare("UPDATE hf_hosts SET listing_revision=listing_revision+1,updated_at=?2 WHERE uid=?1 AND listing_revision=?3 AND status IN ('draft','pending_host','paused','rejected')").bind(uid, now, revision),
          env.DB_META.prepare("UPDATE hf_host_media SET status='superseded' WHERE uid=?1 AND kind='profile' AND ?2='profile' AND EXISTS (SELECT 1 FROM hf_hosts WHERE uid=?1 AND listing_revision=?3 AND updated_at=?4)").bind(uid, kind, revision + 1, now),
          env.DB_META.prepare("INSERT INTO hf_host_media (id,uid,kind,r2_key,status,created_at) SELECT ?1,?2,?3,?4,'active',?5 WHERE EXISTS (SELECT 1 FROM hf_hosts WHERE uid=?2 AND listing_revision=?6 AND updated_at=?5)").bind(id, uid, kind, key, now, revision + 1),
        ]);
        if (!(await env.DB_META.prepare("SELECT id FROM hf_host_media WHERE id=?1").bind(id).first())) throw new HostWriteConflict("Listing changed; reload before saving.");
      } catch (e) { await env.BLOBS.delete(key); throw e; }
      await emit(env, user.uid, uid, "media_uploaded", { kind });
      return reply({ listing: await detail(env, uid) });
    }
    return fail(405, "method_not_allowed");
  } catch (e) {
    if (e instanceof HostWriteConflict) return fail(409, "listing_changed", { message: e.message });
    await trackException(env, e, { uid: user.uid, route: url.pathname, handled: true, app_name: BRAND.slug, extra: { area: "hf_creator_listing" } });
    return fail(500, "save_failed");
  }
}
