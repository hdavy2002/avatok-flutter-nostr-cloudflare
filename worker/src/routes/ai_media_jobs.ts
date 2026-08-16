// [AVA-MEDIA-JOB-1] Authenticated HTTP surface for the durable AI media job
// state machine (worker/src/lib/ai_media_jobs.ts). See that file's header for
// the full design rationale, and worker/src/queues/ai_media.ts for the
// background consumer this create() enqueues onto.
//
//   POST /api/ai/jobs                  { conv, kind, source_media_id?, label?, target_language?, estimate?, job_id? } -> { ok, job }
//   GET  /api/ai/jobs/:job_id          -> { ok, job }
//   POST /api/ai/jobs/:job_id/cancel   -> { ok, job }
//   GET  /api/ai/jobs?conv=...&status=&limit= -> { ok, jobs: [...] }
//
// AuthZ: every read/write requires requireUser() AND an ownership/membership
// check inside ai_media_jobs.ts — this route file never trusts a client-
// supplied uid/conv/media_id/job_id without that check running first. Every
// response returns ONLY safe job metadata (id, kind, status, label, progress,
// artifact/source media ids, timestamps, error code) — never provider
// prompts, file contents, transcripts or captions (§41/§42).
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { readConfig } from "./config";
import { contactFor, emailFor } from "../lib/identity";
import { trackUserContact } from "../hooks";
import {
  createAiMediaJob, getAiMediaJob, cancelAiMediaJob, listAiMediaJobs, failAiMediaJob,
  type AiMediaJobKind, type AiMediaJobStatus,
} from "../lib/ai_media_jobs";
import {
  getVeniceMediaJob, listVeniceMediaJobs, failVeniceMediaJob,
  type VeniceMediaJobRecord,
} from "../lib/venice_media_jobs";
import { presignDigitalReadUrl } from "./media";
import { enqueueAiMediaJob, isAiMediaKindImplemented } from "../queues/ai_media";

const VALID_KINDS = new Set<AiMediaJobKind>([
  "image_generate", "doc_summarize", "doc_translate", "audio_transcribe", "audio_translate",
]);
const VALID_STATUSES = new Set<AiMediaJobStatus>(["queued", "running", "succeeded", "failed", "cancelled"]);

function veniceAsAiJob(
  job: Awaited<ReturnType<typeof getVeniceMediaJob>>,
  artifactUrl: string | null = null,
  coverUrl: string | null = null,
): any {
  if (!job) return null;
  return {
    job_id: job.job_id,
    owner_uid: job.owner_uid,
    conv_id: job.conv_id,
    kind: job.kind,
    status: job.status === "submitting" || job.status === "polling" || job.status === "delivering" ? "running" : job.status,
    source_media_id: null,
    label: job.label ?? (job.kind === "venice_video_generate" ? "Generating your video…" : "Generating your song…"),
    progress: null,
    artifact_media_id: job.artifact_media_id,
    artifact_url: artifactUrl,
    song_title: job.song_title,
    song_description: job.song_description,
    cover_media_id: job.cover_media_id,
    cover_url: coverUrl,
    cover_status: job.cover_status,
    // Video jobs reuse the same safe card metadata/artwork columns as music;
    // expose modality-specific names to clients and OG/share code.
    video_title: job.kind === "venice_video_generate" ? job.song_title : null,
    video_description: job.kind === "venice_video_generate" ? job.song_description : null,
    thumbnail_media_id: job.kind === "venice_video_generate" ? job.cover_media_id : null,
    thumbnail_url: job.kind === "venice_video_generate" ? coverUrl : null,
    thumbnail_status: job.kind === "venice_video_generate" ? job.cover_status : null,
    error_code: job.error_code,
    reservation_id: job.reservation_id,
    created_at: job.created_at,
    updated_at: job.updated_at,
    completed_at: job.completed_at,
  };
}

async function veniceArtifactUrl(env: Env, artifactMediaId: string | null): Promise<string | null> {
  if (!artifactMediaId) return null;
  try {
    const row = await env.DB_MEDIA.prepare("SELECT key, visibility, storage FROM user_media WHERE id=?1")
      .bind(artifactMediaId).first<{ key: string; visibility: string; storage: string }>();
    if (!row) return null;
    if (row.storage === "digital" || row.visibility === "private") return await presignDigitalReadUrl(env, row.key);
    return `${env.BLOSSOM_BASE_URL}/${row.key}`;
  } catch { return null; }
}

async function videoThumbnailShareable(env: Env, job: VeniceMediaJobRecord): Promise<boolean> {
  if (!job.cover_media_id) return false;
  try {
    const row = await env.DB_MEDIA.prepare(
      "SELECT key, mime_type, storage FROM user_media WHERE id=?1 AND uid=?2 LIMIT 1",
    ).bind(job.cover_media_id, job.owner_uid).first<{ key: string; mime_type: string; storage: string }>();
    if (!row || row.storage !== "digital" || !String(row.mime_type || "").toLowerCase().startsWith("image/") || !row.key) return false;
    // A media row can become visible a fraction before its R2 upload. Do not
    // publish a crawler URL during that gap: WhatsApp may cache the first 404
    // long after the object arrives.
    return !!(await env.DIGITAL.head(row.key));
  } catch { return false; }
}

async function hydrateVenice(env: Env, job: Awaited<ReturnType<typeof getVeniceMediaJob>>): Promise<any> {
  return veniceAsAiJob(
    job,
    await veniceArtifactUrl(env, job?.artifact_media_id ?? null),
    await veniceArtifactUrl(env, job?.cover_media_id ?? null),
  );
}

// POST /api/ai/jobs
export async function aiMediaJobsCreate(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const cfg = await readConfig(env);
  if (cfg.aiEnabled === false) return json({ error: "ai disabled", flag: "aiEnabled" }, 503);
  if (!cfg.aiMediaJobsEnabled) {
    return json({ error: "AI media jobs are not live", code: "AI_MEDIA_NOT_LIVE", flag: "aiMediaJobsEnabled" }, 503);
  }

  const ctxUser = await requireUser(req, env);
  if (isFail(ctxUser)) return json({ error: ctxUser.error }, ctxUser.status);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const conv = String(b?.conv ?? "").trim();
  const kind = String(b?.kind ?? "").trim() as AiMediaJobKind;
  if (!conv) return json({ error: "conv required" }, 400);
  if (!VALID_KINDS.has(kind)) return json({ error: "invalid kind" }, 400);
  // [AVA-MEDIA-JOB-2] A kind not yet migrated onto this backbone is a client
  // request error (it asked for something that doesn't exist yet), not a
  // transient service outage — 400, not 503. Checked BEFORE createAiMediaJob()
  // (and therefore before any wallet reserve), so an unimplemented kind never
  // reserves money, fails, and releases it — it never reserves at all.
  if (!isAiMediaKindImplemented(kind)) {
    return json({ error: "This AI media action is not available yet", code: "AI_MEDIA_KIND_NOT_LIVE", kind }, 400);
  }

  const email = await emailFor(env, ctxUser.uid);
  const result = await createAiMediaJob(env, {
    ownerUid: ctxUser.uid,
    convId: conv,
    kind,
    sourceMediaId: b?.source_media_id ? String(b.source_media_id).trim() : null,
    label: b?.label != null ? String(b.label) : null,
    targetLanguage: b?.target_language != null ? String(b.target_language) : null,
    estimate: b?.estimate ? {
      maxInputTokens: Number.isFinite(Number(b.estimate.max_input_tokens)) ? Number(b.estimate.max_input_tokens) : undefined,
      maxOutputTokens: Number.isFinite(Number(b.estimate.max_output_tokens)) ? Number(b.estimate.max_output_tokens) : undefined,
      images: Number.isFinite(Number(b.estimate.images)) ? Number(b.estimate.images) : undefined,
      avSeconds: Number.isFinite(Number(b.estimate.av_seconds)) ? Number(b.estimate.av_seconds) : undefined,
    } : undefined,
    jobId: b?.job_id ? String(b.job_id).trim() : undefined,
    email,
  });

  if (!result.ok) {
    return json({ error: result.error, needed: result.needed, balance: result.balance }, result.status);
  }

  // Only enqueue a freshly-created job — a replayed idempotent create() that
  // returned an already-running/terminal job must never re-enqueue work.
  if (result.job.status === "queued") {
    try {
      await enqueueAiMediaJob(env, ctx, result.job.job_id, result.job.kind);
    } catch {
      await failAiMediaJob(env, {
        jobId: result.job.job_id,
        errorCode: "QUEUE_UNAVAILABLE",
        reason: "AI media queue unavailable",
      });
      return json({ error: "AI media queue unavailable", code: "AI_MEDIA_QUEUE_UNAVAILABLE" }, 503);
    }
  }
  return json({ ok: true, job: result.job });
}

// GET /api/ai/jobs/:job_id
export async function aiMediaJobsGet(req: Request, env: Env, jobId: string): Promise<Response> {
  const ctxUser = await requireUser(req, env);
  if (isFail(ctxUser)) return json({ error: ctxUser.error }, ctxUser.status);
  const id = String(jobId || "").trim();
  if (!id) return json({ error: "job_id required" }, 400);
  const r = await getAiMediaJob(env, id, ctxUser.uid);
  if (r.ok) return json({ ok: true, job: r.job });
  const v = await getVeniceMediaJob(env, id);
  if (!v || v.owner_uid !== ctxUser.uid) return json({ error: r.error }, r.error === "forbidden" ? 403 : 404);
  return json({ ok: true, job: await hydrateVenice(env, v) });
}

// POST /api/ai/jobs/:job_id/share — explicit publication of a succeeded song.
export async function aiMediaJobSongShare(req: Request, env: Env, jobId: string): Promise<Response> {
  const ctxUser = await requireUser(req, env);
  if (isFail(ctxUser)) return json({ error: ctxUser.error }, ctxUser.status);
  let job = await getVeniceMediaJob(env, String(jobId || "").trim());
  if (!job || job.owner_uid !== ctxUser.uid) return json({ error: "not_found" }, 404);
  if (job.kind !== "venice_music_generate" || job.status !== "succeeded" || !job.artifact_media_id) {
    return json({ error: "song_not_ready" }, 409);
  }
  if (!job.share_token) {
    const token = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    await env.DB_MEDIA.prepare(
      "UPDATE venice_media_jobs SET share_token=?2, shared_at=?3, updated_at=?3 WHERE job_id=?1 AND share_token IS NULL",
    ).bind(job.job_id, token, Date.now()).run();
    job = await getVeniceMediaJob(env, job.job_id);
  }
  if (!job?.share_token) return json({ error: "share_unavailable" }, 503);
  const origin = new URL(req.url).origin;
  return json({ ok: true, url: `${origin}/s/song/${job.share_token}` });
}

/** Explicitly publish a completed video and its generated thumbnail. */
export async function aiMediaJobVideoShare(req: Request, env: Env, jobId: string): Promise<Response> {
  const ctxUser = await requireUser(req, env);
  if (isFail(ctxUser)) return json({ error: ctxUser.error }, ctxUser.status);
  let job = await getVeniceMediaJob(env, String(jobId || "").trim());
  if (!job || job.owner_uid !== ctxUser.uid) return json({ error: "not_found" }, 404);
  if (job.kind !== "venice_video_generate" || job.status !== "succeeded" || !job.artifact_media_id || !(await videoThumbnailShareable(env, job))) return json({ error: "video_not_ready" }, 409);
  if (!job.share_token) {
    const token = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    await env.DB_MEDIA.prepare("UPDATE venice_media_jobs SET share_token=?2, shared_at=?3, updated_at=?3 WHERE job_id=?1 AND share_token IS NULL").bind(job.job_id, token, Date.now()).run();
    job = await getVeniceMediaJob(env, job.job_id);
  }
  if (!job?.share_token) return json({ error: "share_unavailable" }, 503);
  // WhatsApp holds link-preview failures far longer than our HTML cache. Give
  // every published revision a stable URL of its own so a thumbnail that was
  // not ready during an earlier crawl can be fetched again without minting a
  // second public token or exposing private identifiers.
  const version = Math.max(1, Math.trunc(Number(job.updated_at || job.completed_at || Date.now())));
  const contact = await contactFor(env, ctxUser.uid);
  await trackUserContact(env, ctxUser.uid, contact.email, contact.phone, "ai_video_share_link_created", "avaai", {
    media_kind: "video",
    share_version: version,
    thumbnail_ready: true,
  });
  return json({ ok: true, url: `${new URL(req.url).origin}/s/video/${job.share_token}?v=${version}` });
}

function songHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch] || ch));
}

async function sharedSong(env: Env, token: string): Promise<VeniceMediaJobRecord | null> {
  const row = await env.DB_MEDIA.prepare(
    "SELECT * FROM venice_media_jobs WHERE share_token=?1 AND kind='venice_music_generate' AND status='succeeded' LIMIT 1",
  ).bind(token).first<any>();
  if (!row?.job_id) return null;
  return await getVeniceMediaJob(env, String(row.job_id));
}

/** Public OG/landing page. The opaque token is created only by the owner share action. */
export async function aiMediaSongSharePage(req: Request, env: Env, token: string): Promise<Response> {
  const job = await sharedSong(env, token);
  if (!job?.artifact_media_id) return new Response("Song not found", { status: 404 });
  const origin = new URL(req.url).origin;
  const title = songHtml(job.song_title || "Untitled track");
  const description = songHtml(job.song_description || "A focused original track shaped by the requested sound and mood.");
  const canonical = `${origin}/s/song/${token}`;
  // Social crawlers do not consistently execute Image Transform URLs wrapped
  // around a Worker route. The direct, cacheable asset is reliably fetchable
  // by WhatsApp, Facebook, Telegram, and X.
  const cover = job.cover_media_id ? `${canonical}/cover` : "";
  const audio = `${canonical}/audio`;
  const coverMeta = cover
    ? `<meta property="og:image" content="${cover}"><meta property="og:image:secure_url" content="${cover}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${cover}">`
    : `<meta name="twitter:card" content="summary">`;
  const coverBody = cover
    ? `<img class="cover" src="${cover}" alt="${title} cover art" width="1200" height="1200">`
    : `<div class="cover fallback" aria-label="Song cover">♪</div>`;
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · AvaTOK</title><meta name="description" content="${description}">
<link rel="canonical" href="${canonical}"><meta property="og:type" content="music.song"><meta property="og:site_name" content="AvaTOK"><meta property="og:url" content="${canonical}"><meta property="og:title" content="${title}"><meta property="og:description" content="${description}">${coverMeta}<meta property="og:image:width" content="1200"><meta property="og:image:height" content="1200"><meta property="og:image:type" content="image/png"><meta property="og:audio" content="${audio}"><meta property="og:audio:type" content="audio/mpeg">
<style>body{margin:0;padding:16px;background:#090b0d;color:#f5f7f8;font-family:system-ui,sans-serif;min-height:100vh;box-sizing:border-box;display:grid;place-items:center}.card{width:min(92vw,560px);max-height:calc(100vh - 32px);overflow:auto;background:#18242b;border:1px solid #34434b;border-radius:24px;box-shadow:0 24px 70px #0008}.cover{display:block;width:100%;max-height:52vh;aspect-ratio:1;object-fit:contain;background:#10181d}.fallback{display:grid;place-items:center;font-size:120px;background:linear-gradient(135deg,#193b4c,#19a974)}.copy{padding:22px}.eyebrow{display:inline-block;color:#55d696;font-size:12px;letter-spacing:.08em;font-weight:700;text-decoration:none;margin-bottom:7px}.title{font-size:28px;line-height:1.15;margin:0 0 8px}.desc{color:#bdc9ce;line-height:1.45;margin:0 0 18px}audio{display:block;width:100%;accent-color:#35ce35}.shares{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}.shares a{display:grid;place-items:center;width:38px;height:38px;border-radius:50%;font-weight:800;text-decoration:none;background:#25363d;color:#fff}</style></head><body><main class="card">${coverBody}<section class="copy"><a class="eyebrow" href="https://avatok.ai">Made with AvaTOK app</a><h1 class="title">${title}</h1><p class="desc">${description}</p><audio controls preload="metadata" src="${audio}">Your browser cannot play this song.</audio><div class="shares" aria-label="Share this song"><a href="https://wa.me/?text=${encodeURIComponent(`${title} — ${canonical}`)}" aria-label="WhatsApp">WA</a><a href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(canonical)}" aria-label="LinkedIn">in</a><a href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(canonical)}" aria-label="Facebook">f</a><a href="https://twitter.com/intent/tweet?text=${encodeURIComponent(title)}&url=${encodeURIComponent(canonical)}" aria-label="X">𝕏</a><a href="mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(`${description}\n${canonical}`)}" aria-label="Email">✉</a></div></section></main></body></html>`;
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Keep the first cover-less response from being cached for a day while
      // the asynchronous artwork sidecar finishes.
      "cache-control": "public, max-age=300, s-maxage=300",
      "content-security-policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Token-gated media endpoints used by OG crawlers and the landing player. */
export async function aiMediaSongShareAsset(
  req: Request, env: Env, token: string, asset: "cover" | "audio",
): Promise<Response> {
  const job = await sharedSong(env, token);
  const mediaId = asset === "cover" ? job?.cover_media_id : job?.artifact_media_id;
  if (!mediaId) return new Response("Not found", { status: 404 });
  const row = await env.DB_MEDIA.prepare(
    "SELECT key, mime_type, storage FROM user_media WHERE id=?1 AND uid=?2 LIMIT 1",
  ).bind(mediaId, job!.owner_uid).first<{ key: string; mime_type: string; storage: string }>();
  if (!row || row.storage !== "digital") return new Response("Not found", { status: 404 });
  // Forward Range so the browser player can seek without downloading the
  // entire song first. R2 returns the selected range as a stream.
  const object = await env.DIGITAL.get(row.key, { range: req.headers });
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers({
    "content-type": row.mime_type || (asset === "cover" ? "image/png" : "audio/mpeg"),
    "cache-control": asset === "cover" ? "public, max-age=31536000, immutable" : "public, max-age=300",
    "content-disposition": "inline",
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
    "etag": object.httpEtag,
  });
  let status = 200;
  // `in` checks don't narrow R2Range's optional numbers — read then test.
  const rangeStart = object.range && "offset" in object.range ? object.range.offset : undefined;
  const rangeLength = object.range && "length" in object.range ? object.range.length : undefined;
  if (rangeStart !== undefined && rangeLength !== undefined) {
    status = 206;
    headers.set("content-length", String(rangeLength));
    headers.set("content-range", `bytes ${rangeStart}-${rangeStart + rangeLength - 1}/${object.size}`);
  } else {
    headers.set("content-length", String(object.size));
  }
  return new Response(object.body, {
    status,
    headers,
  });
}

async function sharedVideo(env: Env, token: string): Promise<VeniceMediaJobRecord | null> {
  const row = await env.DB_MEDIA.prepare("SELECT * FROM venice_media_jobs WHERE share_token=?1 AND kind='venice_video_generate' AND status='succeeded' LIMIT 1").bind(token).first<any>();
  return row?.job_id ? await getVeniceMediaJob(env, String(row.job_id)) : null;
}

export async function aiMediaVideoSharePage(req: Request, env: Env, token: string): Promise<Response> {
  const job = await sharedVideo(env, token);
  if (!job?.artifact_media_id || !job.cover_media_id) return new Response("Video not found", { status: 404 });
  const requestUrl = new URL(req.url);
  const origin = requestUrl.origin;
  const baseUrl = `${origin}/s/video/${token}`;
  const requestedVersion = String(requestUrl.searchParams.get("v") || "").trim();
  const version = /^\d{1,20}$/.test(requestedVersion) ? requestedVersion : "";
  const canonical = version ? `${baseUrl}?v=${version}` : baseUrl;
  const rawTitle = String(job.song_title || "").trim();
  const rawDescription = String(job.song_description || "").trim();
  const title = songHtml(!rawTitle || rawTitle === "AvaTOK video" ? "Cinematic moment" : rawTitle);
  const description = songHtml(!rawDescription || rawDescription === "A short video created with AvaTOK AI."
    ? "A cinematic scene with its own setting, movement, and atmosphere."
    : rawDescription);
  const thumbnail = `${baseUrl}/thumbnail`;
  // Social previews need a small landscape card. The original AI cover is a
  // 1024px PNG (often >2 MB); WhatsApp fetched the tag but omitted that image.
  // Cloudflare's same-zone transform keeps this immutable, public and ~50 KB.
  const socialThumbnailBase = `${origin}/cdn-cgi/image/format=jpeg,quality=78,width=1200,height=630,fit=cover/${thumbnail}`;
  const socialThumbnail = version ? `${socialThumbnailBase}?v=${version}` : socialThumbnailBase;
  const video = `${baseUrl}/video`;
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · AvaTOK</title><meta name="description" content="${description}"><link rel="canonical" href="${canonical}">
<meta property="og:type" content="video.other"><meta property="og:site_name" content="AvaTOK"><meta property="og:url" content="${canonical}"><meta property="og:title" content="${title}"><meta property="og:description" content="${description}"><meta property="og:image" content="${socialThumbnail}"><meta property="og:image:secure_url" content="${socialThumbnail}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:type" content="image/jpeg"><meta property="og:image:alt" content="${title}"><meta property="og:video" content="${video}"><meta property="og:video:secure_url" content="${video}"><meta property="og:video:type" content="video/mp4"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${socialThumbnail}"><meta name="twitter:image:alt" content="${title}">
<style>body{margin:0;padding:16px;background:#090b0d;color:#f5f7f8;font-family:system-ui,sans-serif;min-height:100vh;box-sizing:border-box;display:grid;place-items:center}.card{width:min(92vw,560px);max-height:calc(100vh - 32px);overflow:auto;background:#18242b;border:1px solid #34434b;border-radius:24px;box-shadow:0 24px 70px #0008}.video{display:block;width:100%;max-height:58vh;aspect-ratio:16/9;object-fit:contain;background:#000}.close-video{display:none;border:1px solid #ffffff80;background:#000b;color:#fff;width:44px;height:44px;border-radius:50%;font:700 30px/1 system-ui;align-items:center;justify-content:center;cursor:pointer}.copy{padding:22px}.eyebrow{display:inline-block;color:#55d696;font-size:12px;letter-spacing:.08em;font-weight:700;text-decoration:none;margin-bottom:7px}.title{font-size:28px;line-height:1.15;margin:0 0 8px}.desc{color:#bdc9ce;line-height:1.45;margin:0}.shares{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}.shares a{display:grid;place-items:center;width:38px;height:38px;border-radius:50%;font-weight:800;text-decoration:none;background:#25363d;color:#fff}@media(max-width:700px){body{padding:0;display:block;min-height:100dvh;background:#000}.card{width:100%;height:100dvh;max-height:none;border:0;border-radius:0;box-shadow:none;overflow:hidden;display:flex;flex-direction:column}.video{flex:1 1 auto;min-height:0;max-height:none;aspect-ratio:auto;object-fit:contain}.copy{flex:0 0 auto;padding:14px 18px 16px;max-height:36dvh;overflow:auto}.eyebrow{margin-bottom:4px}.title{font-size:22px;margin-bottom:5px}.desc{font-size:14px;line-height:1.35}.shares{margin-top:11px}.shares a{width:36px;height:36px}html.video-open,html.video-open body{width:100%;height:100%;overflow:hidden}html.video-open .card{position:fixed;inset:0;z-index:20;width:100%;height:100dvh;background:#000}html.video-open .video{position:absolute;inset:0;z-index:21;width:100%;height:100%;max-height:none;object-fit:contain}html.video-open .copy{display:none}html.video-open .close-video{display:flex;position:fixed;z-index:22;top:max(12px,env(safe-area-inset-top));right:max(12px,env(safe-area-inset-right))}}</style></head><body><main class="card"><video id="shared-video" class="video" controls playsinline preload="metadata" poster="${thumbnail}" src="${video}">Your browser cannot play this video.</video><button id="close-video" class="close-video" type="button" aria-label="Close full-screen video">&times;</button><section class="copy"><a class="eyebrow" href="https://avatok.ai">Made with AvaTOK app</a><h1 class="title">${title}</h1><p class="desc">${description}</p><div class="shares" aria-label="Share this video"><a href="https://wa.me/?text=${encodeURIComponent(`${title} — ${canonical}`)}" aria-label="WhatsApp">WA</a><a href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(canonical)}" aria-label="LinkedIn">in</a><a href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(canonical)}" aria-label="Facebook">f</a><a href="https://twitter.com/intent/tweet?text=${encodeURIComponent(title)}&url=${encodeURIComponent(canonical)}" aria-label="X">𝕏</a><a href="mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(`${description}\n${canonical}`)}" aria-label="Email">✉</a></div></section></main><script nonce="${nonce}">(()=>{const v=document.getElementById("shared-video"),x=document.getElementById("close-video"),root=document.documentElement;let portrait=false;const sync=()=>{portrait=v.videoHeight>v.videoWidth};const mobile=()=>matchMedia("(max-width:700px)").matches;const open=()=>{sync();if(mobile()&&portrait)root.classList.add("video-open")};const close=()=>{v.pause();root.classList.remove("video-open")};v.addEventListener("loadedmetadata",sync);v.addEventListener("play",open);v.addEventListener("click",open);x.addEventListener("click",close);document.addEventListener("keydown",e=>{if(e.key==="Escape")close()})})();</script></body></html>`;
  const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300, s-maxage=300", "content-security-policy": `default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`, "x-content-type-options": "nosniff" };
  return new Response(req.method === "HEAD" ? null : html, { headers });
}

export async function aiMediaVideoShareAsset(req: Request, env: Env, token: string, asset: "thumbnail" | "video"): Promise<Response> {
  const job = await sharedVideo(env, token), mediaId = asset === "thumbnail" ? job?.cover_media_id : job?.artifact_media_id;
  if (!job || !mediaId) return new Response("Not found", { status: 404 });
  const row = await env.DB_MEDIA.prepare("SELECT key, mime_type, storage FROM user_media WHERE id=?1 AND uid=?2 LIMIT 1").bind(mediaId, job.owner_uid).first<{ key:string; mime_type:string; storage:string }>();
  if (!row || row.storage !== "digital") return new Response("Not found", { status: 404 });
  const object = await env.DIGITAL.get(row.key, asset === "video" ? { range: req.headers } : undefined);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers({ "content-type": row.mime_type || (asset === "thumbnail" ? "image/png" : "video/mp4"), "cache-control": asset === "thumbnail" ? "public, max-age=31536000, immutable" : "public, max-age=300", "content-disposition": "inline", "x-content-type-options": "nosniff", "etag": object.httpEtag });
  if (asset === "video") headers.set("accept-ranges", "bytes");
  // `in` checks don't narrow R2Range's optional numbers — read then test.
  const vStart = object.range && "offset" in object.range ? object.range.offset : undefined;
  const vLength = object.range && "length" in object.range ? object.range.length : undefined;
  if (asset === "video" && vStart !== undefined && vLength !== undefined) { headers.set("content-length", String(vLength)); headers.set("content-range", `bytes ${vStart}-${vStart + vLength - 1}/${object.size}`); return new Response(req.method === "HEAD" ? null : object.body, { status: 206, headers }); }
  headers.set("content-length", String(object.size));
  return new Response(req.method === "HEAD" ? null : object.body, { headers });
}

// POST /api/ai/jobs/:job_id/cancel
export async function aiMediaJobsCancel(req: Request, env: Env, jobId: string): Promise<Response> {
  const ctxUser = await requireUser(req, env);
  if (isFail(ctxUser)) return json({ error: ctxUser.error }, ctxUser.status);
  const id = String(jobId || "").trim();
  if (!id) return json({ error: "job_id required" }, 400);
  const r = await cancelAiMediaJob(env, id, ctxUser.uid);
  if (r.ok) return json({ ok: true, job: r.job });
  const v = await getVeniceMediaJob(env, id);
  if (!v || v.owner_uid !== ctxUser.uid) return json({ error: r.error }, r.error === "forbidden" ? 403 : 404);
  const cancelled = await failVeniceMediaJob(env, { jobId: id, errorCode: "cancelled_by_user", reason: "user_cancelled" });
  return cancelled.ok
    ? json({ ok: true, job: await hydrateVenice(env, cancelled.job) })
    : json({ error: cancelled.error }, 409);
}

// GET /api/ai/jobs?conv=...&status=queued,running&limit=50
export async function aiMediaJobsList(req: Request, env: Env): Promise<Response> {
  const ctxUser = await requireUser(req, env);
  if (isFail(ctxUser)) return json({ error: ctxUser.error }, ctxUser.status);
  const url = new URL(req.url);
  const conv = String(url.searchParams.get("conv") ?? "").trim();
  if (!conv) return json({ error: "conv required" }, 400);
  const statusParam = String(url.searchParams.get("status") ?? "").trim();
  const statuses = statusParam
    ? statusParam.split(",").map((s) => s.trim()).filter((s): s is AiMediaJobStatus => VALID_STATUSES.has(s as AiMediaJobStatus))
    : undefined;
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
  const jobs = await listAiMediaJobs(env, { ownerUid: ctxUser.uid, convId: conv, statuses, limit });
  const venice = await listVeniceMediaJobs(env, ctxUser.uid, conv, limit ?? 50);
  const veniceJobs = await Promise.all(venice.map((j) => hydrateVenice(env, j)));
  return json({ ok: true, jobs: [...jobs, ...veniceJobs].sort((a, b) => Number(a.created_at) - Number(b.created_at)) });
}
