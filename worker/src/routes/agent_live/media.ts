// [AGENT-LIVE-1] Photo side-channel upload + Forget-me.
// Specs/SPEC-2026-09-12-AGENT-LIVE-1-BUILD.md §3, §9; §11 M8 (binding);
// Specs/codex-rounds/round2-astra.md ("R2") §6. WS-E2 owned.
import type { Env } from "../../types";
import { json, sha256Hex } from "../../util";
import { requireUser, isFail } from "../../authz";
import { readConfig } from "../../routes/config";
import { track } from "../../hooks";
import { talkGate } from "../../lib/agent_live/gate";
import { MAX_IMAGE_BYTES } from "../../lib/agent_live/types";
import type { AgentLiveHandler, AgentLiveBookingRow, AgentLiveAgentRow } from "../../lib/agent_live/types";
import { analyseImage } from "../../lib/agent_live/vision";
import { forgetMe } from "../../lib/agent_live/memory";

// ---------------------------------------------------------------------------
// Image sniffing (R2 §6.1: "Accept JPEG, PNG and static WebP by signature").
// A minimal, dependency-free magic-byte check plus (PNG only) a cheap
// fixed-offset dimension read from the IHDR chunk — JPEG/WebP dimension
// decoding needs a real decoder to do properly (progressive/segmented JPEG
// markers, VP8/VP8L/VP8X sub-formats for WebP) and this worker has no image
// library available, so those two fall back to size-only limits per the task
// spec's explicit "decode-dims cap if feasible without a library — otherwise
// size-only" allowance. No re-encode/EXIF-strip is performed here (R2 §6.2's
// "strip EXIF/GPS and re-encode" is a further hardening step not required by
// the BUILD SPEC task text for this workstream).
// ---------------------------------------------------------------------------

const MAX_DIM_PX = 8192;

interface Sniffed {
  mime: string;
  ext: string;
  width: number | null;
  height: number | null;
}

function sniffImage(bytes: Uint8Array): Sniffed | null {
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg", width: null, height: null };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A, IHDR chunk at byte 16 (width) / 20 (height), big-endian.
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 24 && PNG_SIG.every((b, i) => bytes[i] === b)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const isIHDR = bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52;
    const width = isIHDR ? view.getUint32(16, false) : null;
    const height = isIHDR ? view.getUint32(20, false) : null;
    return { mime: "image/png", ext: "png", width, height };
  }
  // WebP: "RIFF"<4-byte size>"WEBP" — reject animated (ANIM chunk) later formats
  // are out of scope here; static VP8/VP8L/VP8X all share this outer header.
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { mime: "image/webp", ext: "webp", width: null, height: null };
  }
  return null; // includes SVG, GIF and anything else — rejected per R2 §6.1
}

function safeFileExt(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
}

// ---------------------------------------------------------------------------
// POST /api/agents/talk/:bookingId/image
// ---------------------------------------------------------------------------

export const agentTalkImageUpload: AgentLiveHandler = async (req, env, ctx, params) => {
  const started = Date.now();
  const bookingId = params.bookingId;
  if (!bookingId) return json({ error: "booking_id_required" }, 400);

  const authCtx = await requireUser(req, env);
  if (isFail(authCtx)) return json({ error: authCtx.error }, authCtx.status);
  const uid = authCtx.uid;

  const emit = (outcome: string, extra: Record<string, unknown> = {}) =>
    void track(env, uid, "agent_talk_image_shared", "agent_live", { outcome, ms: Date.now() - started, booking_id: bookingId, ...extra });

  const cfg = await readConfig(env);
  const gate = talkGate(env, cfg);
  if (!gate.ok) {
    emit("lane_unavailable", { reason: gate.reason });
    return json({ error: gate.reason }, 503);
  }

  const booking = await env.DB_META.prepare(`SELECT * FROM agent_live_bookings WHERE id=?1`)
    .bind(bookingId)
    .first<AgentLiveBookingRow>();
  if (!booking) {
    emit("booking_not_found");
    return json({ error: "booking_not_found" }, 404);
  }
  if (booking.buyer_uid !== uid) {
    emit("forbidden");
    return json({ error: "forbidden" }, 403);
  }

  const agent = await env.DB_META.prepare(`SELECT * FROM agent_live_agents WHERE listing_id=?1`)
    .bind(booking.agent_id)
    .first<AgentLiveAgentRow>();
  if (!agent) {
    emit("agent_not_found");
    return json({ error: "agent_not_found" }, 404);
  }
  if (!cfg.agentImageReadingEnabled || !agent.image_reading) {
    emit("image_reading_disabled");
    return json({ error: "image_reading_disabled" }, 403);
  }

  const contentType = req.headers.get("content-type") || "";
  if (!/^multipart\/form-data/i.test(contentType)) {
    emit("bad_request", { reason: "multipart_required" });
    return json({ error: "multipart_required" }, 400);
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    emit("bad_request", { reason: "bad_multipart_body" });
    return json({ error: "bad multipart body" }, 400);
  }
  const part = form.get("file");
  if (!part || typeof part === "string" || typeof (part as Blob).arrayBuffer !== "function") {
    emit("bad_request", { reason: "file_part_required" });
    return json({ error: "multipart 'file' part required" }, 400);
  }
  const filePart = part as File;

  const clientUploadId = String(
    form.get("client_upload_id") || req.headers.get("idempotency-key") || req.headers.get("x-client-upload-id") || "",
  ).trim();
  if (!clientUploadId) {
    emit("bad_request", { reason: "client_upload_id_required" });
    return json({ error: "client_upload_id required" }, 400);
  }

  const bytes = await filePart.arrayBuffer();
  if (bytes.byteLength === 0) {
    emit("bad_request", { reason: "empty_body" });
    return json({ error: "empty body" }, 400);
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    emit("too_large");
    return json({ error: "file too large", max: MAX_IMAGE_BYTES }, 413);
  }

  const sniffed = sniffImage(new Uint8Array(bytes));
  if (!sniffed) {
    emit("unsupported_type");
    return json({ error: "unsupported image type" }, 415);
  }
  if ((sniffed.width && sniffed.width > MAX_DIM_PX) || (sniffed.height && sniffed.height > MAX_DIM_PX)) {
    emit("dimensions_too_large");
    return json({ error: "image dimensions too large", max_px: MAX_DIM_PX }, 413);
  }

  // F17: content hash of the upload, so a replay of the same client_upload_id
  // with DIFFERENT bytes is rejected instead of silently served the first
  // upload's result.
  const contentSha = await sha256Hex(bytes);

  // §11 M8: reserve the image slot in the room BEFORE storing/analysing —
  // the room is the single source of truth for the 6-per-session cap, the
  // current session/erasure generation, and idempotent replay of a repeated
  // clientUploadId.
  const stub = env.AGENT_LIVE_ROOMS.get(env.AGENT_LIVE_ROOMS.idFromName(bookingId));
  let reserve: { ok: boolean; imageId?: string; sessionGeneration?: number; erasureGeneration?: number; reason?: string } | null = null;
  try {
    const reserveResp = await stub.fetch("https://room/image-reserve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookingId, clientUploadId }),
    });
    reserve = await reserveResp.json();
  } catch (e) {
    emit("room_unreachable", { error: String(e).slice(0, 200) });
    return json({ error: "room_unreachable" }, 503);
  }
  if (!reserve || reserve.ok !== true || !reserve.imageId) {
    const reason = reserve?.reason || "reserve_failed";
    emit(reason);
    return json({ error: reason }, 409);
  }
  const { imageId } = reserve as { imageId: string };
  const sessionGeneration = reserve.sessionGeneration ?? 1;
  const erasureGeneration = reserve.erasureGeneration ?? 0;

  const session = await env.DB_META.prepare(`SELECT id FROM agent_live_sessions WHERE booking_id=?1`)
    .bind(bookingId)
    .first<{ id: string }>();
  if (!session) {
    // The room only reserves once a session exists, so this should be
    // unreachable in practice — fail closed rather than write an orphan row.
    emit("session_not_found");
    return json({ error: "session_not_found" }, 409);
  }

  const now = Date.now();
  const ext = safeFileExt(sniffed.mime);
  const r2Key = `agent-live/${agent.listing_id}/${bookingId}/g${sessionGeneration}/img/${imageId}.${ext}`;

  // F17: the room's reservation is idempotent on clientUploadId — a replay
  // gets back the SAME imageId, so the old `existing.id !== imageId` dupe
  // check was always false and every replay re-ran the vision call. The real
  // signal is whether THIS request's INSERT is the one that actually created
  // the row: `ON CONFLICT DO NOTHING` makes a duplicate a no-op write, and
  // `meta.changes` tells us which request won that race. Only the winner
  // stores bytes to R2 and analyses; every other request (this process retry,
  // a genuine replay, or a concurrent duplicate) returns the winner's stored
  // result without touching R2 or vision again.
  let won = false;
  try {
    const insertResult = await env.DB_META.prepare(
      `INSERT INTO agent_live_session_images
         (id, session_id, booking_id, r2_key, status, analysis, error,
          client_upload_id, session_generation, erasure_generation, analysis_revision, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'analyzing', NULL, NULL, ?5, ?6, ?7, 1, ?8, ?8)
       ON CONFLICT(session_id, client_upload_id) DO NOTHING`,
    )
      .bind(imageId, session.id, bookingId, r2Key, clientUploadId, sessionGeneration, erasureGeneration, now)
      .run();
    won = Number((insertResult.meta as { changes?: number } | undefined)?.changes ?? 0) > 0;
  } catch (e) {
    emit("db_write_failed", { error: String(e).slice(0, 200) });
    return json({ error: "write_failed" }, 500);
  }

  if (!won) {
    // Lost the insert race — a prior request (or this same client retrying)
    // already owns this (session_id, client_upload_id). Never re-store or
    // re-analyse; just report the winner's outcome, after checking this
    // upload is genuinely the SAME file (R2 §6.1's "repeated upload
    // idempotency key returns its prior result" assumes the same content).
    const existing = await env.DB_META.prepare(
      `SELECT id, status, analysis, error, r2_key, erasure_generation FROM agent_live_session_images
        WHERE session_id=?1 AND client_upload_id=?2`,
    )
      .bind(session.id, clientUploadId)
      .first<{ id: string; status: string; analysis: string | null; error: string | null; r2_key: string; erasure_generation: number }>();
    if (!existing) {
      // Vanishingly rare (row deleted between the failed insert and this
      // read, e.g. a Forget-me erase job) — treat as a fresh failure.
      emit("duplicate_row_missing");
      return json({ error: "write_failed" }, 500);
    }
    if (existing.erasure_generation !== erasureGeneration) {
      emit("stale_generation");
      return json({ error: "stale_generation" }, 410);
    }
    // Best-effort content check: compare against the bytes actually stored
    // for the winning request. If the object hasn't landed yet (winner still
    // mid-upload), we can't verify — fall through and return the winner's
    // current (still-analyzing) status rather than block on it.
    try {
      const stored = await env.DIGITAL.get(existing.r2_key);
      if (stored) {
        const storedSha = await sha256Hex(await stored.arrayBuffer());
        if (storedSha !== contentSha) {
          emit("upload_id_reused");
          return json({ error: "upload_id_reused" }, 409);
        }
      }
    } catch (e) {
      // Hash verification failing is not itself a reason to reject the
      // duplicate — log and fall through to returning the stored result.
      emit("duplicate_hash_check_failed", { error: String(e).slice(0, 200) });
    }
    emit("duplicate");
    return json(
      { imageId: existing.id, status: existing.status, ...(existing.status === "ready" ? { analysis: existing.analysis } : {}), ...(existing.status === "failed" ? { error: existing.error } : {}) },
      existing.status === "ready" ? 200 : 202,
    );
  }

  try {
    await env.DIGITAL.put(r2Key, bytes, { httpMetadata: { contentType: sniffed.mime } });
  } catch (e) {
    // F13: guard every image-row UPDATE with the generation this upload was
    // reserved under, so a write that lands after a Forget-me bumped the
    // generation is a no-op instead of touching a row that has since been
    // logically erased.
    await env.DB_META.prepare(`UPDATE agent_live_session_images SET status='failed', error=?1, updated_at=?2 WHERE id=?3 AND erasure_generation=?4`)
      .bind("r2_put_failed", Date.now(), imageId, erasureGeneration)
      .run();
    emit("r2_put_failed", { error: String(e).slice(0, 200) });
    return json({ error: "storage_failed" }, 500);
  }

  emit("accepted");

  ctx.waitUntil(
    (async () => {
      const result = await analyseImage(env, { agent, bytes, mime: sniffed.mime, sessionId: session.id, imageId });
      const finishedAt = Date.now();
      try {
        if (result.ok) {
          await env.DB_META.prepare(`UPDATE agent_live_session_images SET status='ready', analysis=?1, error=NULL, updated_at=?2 WHERE id=?3 AND erasure_generation=?4`)
            .bind(result.analysis, finishedAt, imageId, erasureGeneration)
            .run();
        } else {
          await env.DB_META.prepare(`UPDATE agent_live_session_images SET status='failed', error=?1, updated_at=?2 WHERE id=?3 AND erasure_generation=?4`)
            .bind(result.error, finishedAt, imageId, erasureGeneration)
            .run();
        }
      } catch (e) {
        void track(env, uid, "agent_talk_image_shared", "agent_live", {
          outcome: "db_update_failed",
          ms: finishedAt - started,
          booking_id: bookingId,
          error: String(e).slice(0, 200),
        });
      }

      try {
        await stub.fetch("https://room/image-analysis", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            bookingId,
            imageId,
            sessionGeneration,
            erasureGeneration,
            analysisRevision: 1,
            ...(result.ok ? { analysis: result.analysis } : { error: result.error }),
          }),
        });
      } catch (e) {
        void track(env, uid, "agent_talk_image_shared", "agent_live", {
          outcome: "room_callback_failed",
          ms: Date.now() - started,
          booking_id: bookingId,
          error: String(e).slice(0, 200),
        });
      }
    })(),
  );

  return json({ imageId, status: "analyzing" }, 202);
};

// ---------------------------------------------------------------------------
// DELETE /api/agents/:id/memory/me
// ---------------------------------------------------------------------------

export const agentMemoryForget: AgentLiveHandler = async (req, env, _ctx, params) => {
  const agentId = params.id;
  if (!agentId) return json({ error: "agent_id_required" }, 400);

  const authCtx = await requireUser(req, env);
  if (isFail(authCtx)) return json({ error: authCtx.error }, authCtx.status);

  // Forget-me is never gated by the talk/checkout lane flags (BUILD SPEC §11
  // M12: "Receipts, refunds, Forget-me never gated") — a customer's ability
  // to erase their memory must survive `agentEmergencyStop` or the lane
  // being turned off for new sessions.
  const { erasureGeneration } = await forgetMe(env, agentId, authCtx.uid);
  return json({ ok: true, erasureGeneration });
};
