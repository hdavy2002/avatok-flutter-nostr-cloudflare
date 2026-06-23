// Ava generative image route (Phase 9 — Generative · async present-in-thread).
//
//   POST /api/ava/image   { conv, prompt, edit?: { media_ref } }
//
// THE SIGNATURE MOVE — async, in-thread. On request we IMMEDIATELY drop the
// transient "Ava is generating an image…" working chip into the conversation
// (via the caller's AvaAgentDO, exactly like a normal Ava turn), return fast,
// and let the humans keep chatting. When the image is ready we post it as a
// normal `ava` message carrying a `media_ref` into the SAME conversation — the
// frozen chat_thread.dart already renders `ava` bubbles with media + the chip.
//
// Pipeline:
//   1. dual-auth (requireUser → Clerk JWT / NIP-98).
//   2. MANDATORY moderation on the prompt (P2 `guardInput`/`isSafe`, llama-guard).
//      A disallowed prompt (deepfake / abuse / minors) is refused — no generation.
//   3. post the working chip into `conv` (transient ava_status).
//   4. generate with Gemini "Nano Banana 2" (gemini-3.1-flash-image-preview),
//      same REST shape as routes/affiliate_assets.ts.
//   5. upload the PNG to the PUBLIC blob bucket (same layout as /upload/public:
//      content-addressed `u/<uid>/public/<sha256>`, served by blossom + the
//      /cdn-cgi/image CDN) and register a user_media row so the Avatar/image
//      widgets render it.
//   6. post the final `ava` image message into `conv` (postAvaMessage, P3).
//
// KEY SOURCE: the SERVER key `env.GEMINI_API_KEY` (already used by translate +
// affiliate_assets) is preferred. If unset, we fall back to the caller's BYO
// key on the `X-Ava-Gemini-Key` header (P2 convention). If neither exists we
// 503 (and never post a chip we can't fulfil).
//
// PREMIUM: generation is metered client-side via PaidFeature (image.generate is
// paid:true; the wallet hook is a Phase-0 stub that routes to the top-up sheet
// today). This route does not itself debit the wallet (no server wallet-spend
// authority is wired for Ava yet) — see INTEGRATION-NOTES Phase 9.

import type { Env } from "../types";
import { json, sha256Hex } from "../util";
import { requireUser, isFail } from "../authz";
import { guardInput } from "../lib/ai_gate";
import { track } from "../hooks";
import { readConfig } from "./config";
import { tierOf, PLANS, type TierId } from "./plans";
import { enforceAllowance } from "../lib/usage";
import { mediaSession } from "../db/shard";
import { postAvaMessage } from "./ava_thread";
import type { MessageScope } from "../lib/ava_kinds";

// Image generation is metered by the Phase-1 SUBSCRIPTION ALLOWANCE (plans.ts):
// every tier — including Free — gets a daily image grant (Free 3, Plus 30,
// Pro 100, Max unlimited), enforced server-side via enforceAllowance("image").
// It runs on OUR Google key via the AI Gateway; when the daily grant is spent the
// caller gets an upgrade prompt (no coins involved in Phase 1).
const IMAGE_MODEL = "gemini-3.1-flash-image-preview"; // Nano Banana 2

function inboxOf(env: Env, uid: string) {
  return env.INBOX.get(env.INBOX.idFromName(uid));
}

// Resolve conversation members — mirrors AvaAgentDO.members() (P3) so a DM with
// no conversation_members rows still fans out and a group reads DB_META.
async function membersOf(env: Env, conv: string, caller: string): Promise<string[]> {
  if (conv.startsWith("dm_")) {
    const parts = conv.slice(3).split("__");
    if (parts.length === 2) return Array.from(new Set([parts[0], parts[1], caller]));
  }
  try {
    const rows = await env.DB_META
      .prepare("SELECT uid FROM conversation_members WHERE conv_id = ?1").bind(conv).all<{ uid: string }>();
    const list = (rows.results || []).map((r) => r.uid);
    if (!list.includes(caller)) list.push(caller);
    return list;
  } catch {
    return [caller];
  }
}

// Append a payload to one member's InboxDO (mirrors AvaAgentDO.appendTo).
async function appendTo(env: Env, owner: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await inboxOf(env, owner).fetch("https://inbox/append", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, owner }),
    });
  } catch { /* best-effort; never throw out of a fan-out */ }
}

// Fire the transient ava_status broadcast (mirrors AvaAgentDO.statusBroadcast).
async function statusBroadcast(env: Env, owner: string, conv: string, label: string, statusId: string, phase: "start" | "end"): Promise<void> {
  try {
    await inboxOf(env, owner).fetch("https://inbox/ava_status", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ conv, label, status_id: statusId, phase }),
    });
  } catch { /* best-effort */ }
}

// Post the "Ava is generating an image…" chip into the conversation. Same
// mechanism the spine uses (P3.postStatus, which is private to the DO): a
// transient broadcast PLUS a persisted {t:'ava_status'} envelope so the FROZEN
// chat_thread.dart renders the chip today. Returns the status_id to close later.
async function postChip(env: Env, uid: string, conv: string, label: string): Promise<string | undefined> {
  const statusId = crypto.randomUUID();
  try {
    const targets = await membersOf(env, conv, uid);
    const envelope = JSON.stringify({ t: "ava_status", label, status_id: statusId, phase: "start", source: "image" });
    const payload = { conv, sender: "ava", kind: "ava_status", body: envelope, created_at: Date.now(), scope: "thread" as MessageScope };
    await Promise.all(targets.map((m) => statusBroadcast(env, m, conv, label, statusId, "start")));
    await Promise.all(targets.map((m) => appendTo(env, m, payload)));
    return statusId;
  } catch {
    return undefined; // best-effort; the final image still lands either way
  }
}

// Close the working chip (phase:'end') once the image has been posted.
async function endChip(env: Env, uid: string, conv: string, statusId?: string): Promise<void> {
  if (!statusId) return;
  try {
    const targets = await membersOf(env, conv, uid);
    const envelope = JSON.stringify({ t: "ava_status", label: "Ava is generating an image…", status_id: statusId, phase: "end", source: "image" });
    const payload = { conv, sender: "ava", kind: "ava_status", body: envelope, created_at: Date.now(), scope: "thread" as MessageScope };
    await Promise.all(targets.map((m) => statusBroadcast(env, m, conv, "", statusId, "end")));
    await Promise.all(targets.map((m) => appendTo(env, m, payload)));
  } catch { /* best-effort */ }
}

// One Gemini generateContent call → PNG bytes. `editRef` (optional) supplies an
// existing public image URL to edit ("make it blue") — fetched + sent inline.
async function generateImage(env: Env, key: string, prompt: string, uid: string, editRef?: string): Promise<Uint8Array> {
  const parts: any[] = [{ text: prompt }];
  // Edit support: pull the source image bytes and pass them inline so the model
  // edits rather than generates from scratch. Cheap + reuses the public bucket.
  if (editRef) {
    try {
      const src = await fetch(editRef);
      if (src.ok) {
        const buf = new Uint8Array(await src.arrayBuffer());
        const mime = src.headers.get("content-type") || "image/png";
        let bin = "";
        for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        parts.push({ inlineData: { mimeType: mime, data: btoa(bin) } });
      }
    } catch { /* fall back to text-only generation */ }
  }
  // Call Google DIRECTLY (the same proven path as affiliate_assets.ts). Image gen
  // previously routed through the Cloudflare AI Gateway, which failed in prod while
  // the direct-calling affiliate generator worked — turns errored with "I couldn't
  // create that image". Direct is reliable; we drop per-user gateway metering (not
  // needed under the Phase-1 subscription allowance). Errors emit `ava_image_error`
  // telemetry so the real Gemini message is visible in PostHog, not just logs.
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseModalities: ["IMAGE"] },
      }),
    },
  );
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) {
    const msg = String(j?.error?.message ?? "unknown").slice(0, 300);
    track(env, uid, "ava_image_error", "avaai", { stage: "generate", status: r.status, model: IMAGE_MODEL, error: msg });
    throw new Error(`gemini ${r.status}: ${msg}`);
  }
  const ps = j?.candidates?.[0]?.content?.parts ?? [];
  const inline = ps.find((p: any) => p?.inlineData?.data)?.inlineData;
  if (!inline?.data) {
    track(env, uid, "ava_image_error", "avaai", { stage: "no_image", model: IMAGE_MODEL });
    throw new Error("gemini returned no image");
  }
  const bin = atob(String(inline.data));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Store the generated PNG in the PUBLIC blob bucket (same layout + CDN path as
// /upload/public) and register a user_media row so it counts toward the pool and
// the library/Avatar widgets see it. Returns the public blossom URL (media_ref).
async function storePublicImage(env: Env, uid: string, bytes: Uint8Array): Promise<string> {
  const hash = await sha256Hex(bytes);
  const r2Key = `u/${uid}/public/${hash}`;
  const url = `${env.BLOSSOM_BASE_URL}/${r2Key}`;
  const mdb = mediaSession(env);
  const existing = await mdb.prepare("SELECT id FROM user_media WHERE key=?1").bind(r2Key).first<any>();
  if (!existing) {
    await env.BLOBS.put(r2Key, bytes, { httpMetadata: { contentType: "image/png" } });
    await mdb.prepare(
      `INSERT INTO user_media (id, uid, media_type, storage, visibility, encrypted, key, display_url, mime_type, size_bytes, original_app, created_at, moderation_status, category, file_name, source_kind)
       VALUES (?1,?2,'image','blossom','public',0,?3,?4,'image/png',?5,'avatok',?6,'live','image',?7,'sent')`,
    ).bind(crypto.randomUUID(), uid, r2Key, url, bytes.byteLength, Date.now(), `ava-image-${hash.slice(0, 8)}.png`).run();
  }
  return url;
}

// Do the heavy work: generate → upload → post the ava image message → end chip.
// Runs after the HTTP response has been sent (detached) so the request returns
// fast and the humans keep chatting; the image arrives in-thread when ready.
async function fulfil(
  env: Env, uid: string, conv: string, prompt: string, key: string,
  tier: TierId, statusId: string | undefined, editRef?: string,
): Promise<void> {
  try {
    const bytes = await generateImage(env, key, prompt, uid, editRef);
    // OUTPUT-INTENT moderation: the prompt is llama-guarded BEFORE generation
    // (the gate in avaImage). Pixel-level scanning of the produced image is not
    // run inline here (we write the user_media row directly rather than through
    // /upload/public's async Workers-AI scan); the prompt guard is the
    // enforced gate. A follow-up could enqueue Q_MODERATION on the new r2_key.
    const mediaRef = await storePublicImage(env, uid, bytes);
    // Consume ONE image from today's per-tier allowance only AFTER a successful
    // delivery, so a failed generation never burns the user's daily grant.
    await enforceAllowance(env, uid, tier, "image", 1, { commit: true }).catch(() => {});
    const caption = editRef ? "Here's the edited image ✨" : "Here's your image ✨";
    await postAvaMessage(env, { ownerUid: uid, conv, text: caption, media_ref: mediaRef, source: "image" });
  } catch (e: any) {
    // Never leak raw Gemini errors. Post a friendly failure into the thread.
    console.error("ava image generation failed:", String(e?.message ?? e));
    await postAvaMessage(env, {
      ownerUid: uid, conv,
      text: "I couldn't create that image just now — please try again in a moment.",
      source: "image",
    }).catch(() => { /* best-effort */ });
  } finally {
    await endChip(env, uid, conv, statusId);
  }
}

// Structured result so BOTH callers (the HTTP route and the @ava agent tool)
// share ONE gate + pipeline. `httpStatus` is what the HTTP route returns;
// `message` is the user-facing line the agent relays into chat on a block.
export type AvaImageResult = {
  ok: boolean;
  blocked?: boolean;
  reason?: string;
  message?: string;
  conv?: string;
  status_id?: string | null;
  async?: boolean;
  tier?: string;
  httpStatus: number;
};

// THE shared gate + async pipeline for in-thread image generation. Per-CALLER:
// every check and the coin spend key on [uid] (never the conversation), so in a
// group each member's own package/wallet is what's gated — one member exhausting
// their quota can't draw on another's, and the "unlimited" member only ever
// spends their own allowance. The image still posts into the shared `conv` for
// everyone to see; the cost/quota always lands on whoever invoked it.
export async function runAvaImage(
  env: Env,
  a: { uid: string; conv: string; prompt: string; editRef?: string; req?: Request; body?: any },
): Promise<AvaImageResult> {
  const { uid, conv } = a;
  const prompt = String(a.prompt ?? "").trim();

  // Master kill-switches.
  const cfg = await readConfig(env);
  if (cfg.generativeEnabled === false) {
    return { ok: false, reason: "generative_disabled", message: "Image generation is currently turned off.", httpStatus: 503 };
  }
  if (cfg.aiEnabled === false) {
    return { ok: false, reason: "ai_disabled", message: "Ava is currently turned off.", httpStatus: 503 };
  }
  if (!conv) return { ok: false, reason: "conv_required", message: "Missing conversation.", httpStatus: 400 };
  if (!prompt) return { ok: false, reason: "prompt_required", message: "Tell me what to draw.", httpStatus: 400 };
  if (prompt.length > 2000) return { ok: false, reason: "prompt_too_long", message: "That prompt is too long.", httpStatus: 400 };

  // (2) MANDATORY moderation on the prompt — refuse disallowed (deepfake/abuse,
  // incl. minors) BEFORE we generate or even post a chip. llama-guard via P2.
  const gin = await guardInput(env, prompt);
  if (!gin.ok) {
    return { ok: false, blocked: true, reason: gin.reason ?? "input_unsafe",
      message: "I can't create that image. Let's keep things safe — try a different idea.", httpStatus: 200 };
  }

  // SUBSCRIPTION ALLOWANCE GATE (Phase 1, per-caller): image generation is metered
  // per tier per UTC day. EVERY tier — including Free — gets a daily grant
  // (PLANS[tier].caps.image); image gen is NOT premium-only. When the grant is
  // spent we return an upgrade prompt (not a hard wall). We PEEK here (commit:false)
  // and only consume the unit after a successful delivery (in fulfil).
  const tier = await tierOf(env, uid);
  const allow = await enforceAllowance(env, uid, tier, "image", 1, { commit: false });
  if (!allow.allowed) {
    track(env, uid, "ava_image_capped", "avaai", { used: allow.used, cap: allow.cap, tier });
    const up = allow.upsell;
    const upCap = up ? PLANS[up.tier].caps.image : null;
    const upText = up
      ? ` Upgrade to ${PLANS[up.tier].name} ($${up.price_usd}/mo) for ${upCap === null ? "unlimited" : upCap} images a day.`
      : "";
    return {
      ok: false, blocked: true, reason: "plan_limit", tier: PLANS[tier].key,
      message: `You've used all ${allow.cap} of today's AI images on your ${PLANS[tier].name} plan — it resets tomorrow.${upText}`,
      httpStatus: 200,
    };
  }

  // Image gen runs on OUR Google key (the one place we touch Google), via the AI Gateway.
  const key = env.GEMINI_API_KEY;
  if (!key) return { ok: false, reason: "no_gemini_key", message: "Image generation is unavailable right now.", httpStatus: 503 };

  // (3) drop the working chip immediately so the thread shows "Ava is generating…".
  const statusId = await postChip(env, uid, conv, "Ava is generating an image…");
  track(env, uid, "ava_image_request", "avaai", { edit: !!a.editRef, tier });

  // (4–6) heavy work runs detached — return now while the image is produced and
  // posted into the SAME conversation when ready.
  void fulfil(env, uid, conv, prompt, key, tier, statusId, a.editRef);

  return { ok: true, conv, status_id: statusId ?? null, async: true, tier: PLANS[tier].key, httpStatus: 200 };
}

// ---- POST /api/ava/image ----------------------------------------------------
export async function avaImage(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const conv = String(b.conv ?? "").trim();
  const prompt = String(b.prompt ?? "").trim();
  const editRef = b.edit && b.edit.media_ref ? String(b.edit.media_ref) : undefined;

  const r = await runAvaImage(env, { uid: ctx.uid, conv, prompt, editRef, req, body: b });
  // Preserve the route's historical response shapes: hard errors → {error};
  // soft blocks / upsell / success → the structured body at 200.
  if (!r.ok && (r.httpStatus === 400 || r.httpStatus === 503)) {
    return json({ error: r.message, reason: r.reason }, r.httpStatus);
  }
  if (!r.ok) {
    return json({ ok: false, blocked: !!r.blocked, reason: r.reason, message: r.message, answer: r.message }, r.httpStatus);
  }
  return json({ ok: true, conv: r.conv, status_id: r.status_id ?? null, async: true, tier: r.tier }, r.httpStatus);
}
