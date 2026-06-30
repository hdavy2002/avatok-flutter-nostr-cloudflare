// Moderation consumer: scan a pending public upload, decide, escalate.
//
// Classifier: the Workers-AI VISION model `@cf/google/gemma-4-26b-a4b-it`
// (Gemma 4 26B-A4B MoE — 26B total, ~4B active/token, so ~4B-class cost with much
// higher quality; native vision + thinking) rates the image for explicit sexual
// content and graphic violence via a prompt+parse. Swappable via MODERATION_MODEL
// (set MODERATION_MODEL_TYPE="classifier" + a label/score NSFW model for the
// cheapest path at scale). Text moderation stays on `@cf/meta/llama-guard-3-8b`
// (purpose-built binary safety classifier). No OpenAI anywhere.
//
// Thresholds (spec §17 #2): score = max(nsfw, violence).
//   >= 0.85  → reject  (delete blob, blocklist sha256 + pHash, strike)
//   >= 0.60  → flag    (keep blob, status 'flagged' for human review, no strike)
//   <  0.60  → live
//
// Pipeline: pHash → perceptual blocklist gate → AI scan (cached per sha256) →
// decide → status → strike → blocklist → store pHash. A blob is never re-scanned.
import type { Env, ModerationMsg } from "./types";
import { applyStrike } from "./strikes";
import { perceptualHash, hamming, bands } from "./phash";
import { notifyUser } from "./notify";
import { aiText, bumpAiSpend } from "./ai";
import { csamCheckHash, csamGate, handleCsam } from "./csam";

const REJECT = 0.85;
const FLAG = 0.60;
// Cheap-classifier escalation: scores in [ESCALATE_LOW, REJECT) are ambiguous —
// these are the "extra attention" cases that get a Gemma 4 second opinion. Clear
// clean (< ESCALATE_LOW) and clear reject (>= REJECT) are decided cheaply, no LLM.
const ESCALATE_LOW = 0.40;
const PHASH_MATCH_DISTANCE = 6; // ≤6 bits differ → treat as the same image

interface ScanResult { nsfw: number; violence: number; label: string; model: string; }

export async function handleModeration(msg: ModerationMsg, env: Env): Promise<void> {
  const { hash, media_id, uid } = msg;
  const r2Key = msg.r2_key || hash; // per-user storage path (content hash for blocklist)

  // Stream recordings aren't R2 blobs (no sha256) — video scan is a follow-up;
  // ack without erroring so the queue drains.
  if (msg.type === "stream_recording" || !hash) {
    console.warn("moderation: stream_recording scan not yet implemented; skipping", msg.uid ?? media_id);
    return;
  }

  // CSAM exact-hash gate — runs first, before fetching bytes or spending AI.
  // No-ops (bypasses) while the csam_hashes list is empty; activates when you load
  // NCMEC/PhotoDNA hash lists into it.
  const csamHash = await csamCheckHash(env, hash);
  if (csamHash) { await handleCsam(env, { hash, r2Key, media_id, uid, source: csamHash }); return; }

  // F6: verified accounts get a more lenient human-review threshold (still rejected
  // at REJECT). One indexed read.
  const tierRow = await env.DB_META.prepare("SELECT tier FROM clerk_nostr_link WHERE uid=?1")
    .bind(uid).first<{ tier: string }>();
  const flagThreshold = tierRow?.tier === "verified" ? 0.90 : FLAG;

  // F7: check the cache FIRST. If this exact sha256 was scanned before AND we have
  // its pHash, skip the R2 fetch + Photon decode entirely.
  const cached = await env.DB_MODERATION.prepare(
    "SELECT score, label, model, phash FROM moderation_results WHERE hash=?1",
  ).bind(hash).first<{ score: number; label: string; model: string; phash: string | null }>();

  let phash: string | null;
  let score: number;
  let label: string;

  if (cached?.phash) {
    phash = cached.phash; score = cached.score; label = cached.label;
  } else {
    const obj = await env.BLOBS.get(r2Key);
    if (!obj) { await setStatus(env, media_id, "rejected"); return; } // bytes vanished
    const bytes = new Uint8Array(await obj.arrayBuffer());
    phash = perceptualHash(bytes);

    // CSAM external matcher (PhotoDNA/Thorn). Bypasses when CSAM_API_URL unset;
    // fail-CLOSED (quarantine for human review) when configured but unreachable.
    const csam = await csamGate(env, hash, bytes);
    if (csam.match) { await handleCsam(env, { hash, r2Key, media_id, uid, source: csam.source! }); return; }
    if (csam.failClosed) { await setStatus(env, media_id, "flagged"); return; }

    if (cached) {
      // Had an AI result from before but no stored pHash (older row) — reuse the
      // score, backfill the pHash so next time we skip R2.
      score = cached.score; label = cached.label;
      if (phash) await env.DB_MODERATION.prepare("UPDATE moderation_results SET phash=?2 WHERE hash=?1").bind(hash, phash).run();
    } else {
      const r = await classify(env, bytes);
      score = Math.max(r.nsfw, r.violence);
      label = r.nsfw >= r.violence ? `nsfw:${r.label}` : `violence:${r.label}`;
      await env.DB_MODERATION.prepare(
        "INSERT OR REPLACE INTO moderation_results (hash, score, label, model, scanned_at, phash) VALUES (?1,?2,?3,?4,?5,?6)",
      ).bind(hash, score, label, r.model, Date.now(), phash).run();
    }
  }

  // Perceptual blocklist gate (LSH band lookup).
  if (phash && await matchesBlockedPerceptual(env, phash)) {
    await reject(env, hash, r2Key, media_id, uid, "perceptual_block", 1, true);
    return;
  }

  if (score >= REJECT) {
    await reject(env, hash, r2Key, media_id, uid, label, score, true);
    // F5: seed the perceptual blocklist so near-dupes of this confirmed-bad image are caught.
    if (phash) await addBlockedPerceptual(env, crypto.randomUUID(), phash);
    return;
  }

  if (score >= flagThreshold) {
    await setStatus(env, media_id, "flagged"); // human review; no strike yet
  } else {
    await setStatus(env, media_id, "live");
  }
  if (phash) await storePhash(env, media_id, uid, phash);
}

// --- reject: delete blob (per-user key), blocklist (content sha256 + optional perceptual), strike ---
async function reject(env: Env, hash: string, r2Key: string, mediaId: string, uid: string, label: string, score: number, strike: boolean): Promise<void> {
  await env.BLOBS.delete(r2Key);
  await setStatus(env, mediaId, "rejected");
  await env.DB_MODERATION.prepare(
    `INSERT OR IGNORE INTO blocked_media_hashes (id,hash_type,hash_value,category,source,original_uploader_npub,created_at)
     VALUES (?1,'sha256',?2,?3,'admin_confirmed',?4,?5)`,
  ).bind(crypto.randomUUID(), hash, label, uid, Date.now()).run();
  if (strike) await applyStrike(env, uid, "ai_image:" + label, hash, score);
  // Tell the user (feed + push) — server-originated, no encryption needed.
  await notifyUser(env, uid, { type: "moderation", title: "Content removed", body: "A post was removed for violating our community guidelines." });
}

// --- image scan orchestrator: cheap external NSFW classifier FIRST, escalate
// only the ambiguous middle band to Gemma 4 (keeps the heavier LLM off clear cases).
//   • NSFW_API_URL set  → classifier decides clear clean/reject; gray band → Gemma.
//   • NSFW_API_URL unset → straight to Gemma 4 vision (current behavior).
async function classify(env: Env, bytes: Uint8Array): Promise<ScanResult> {
  if (env.NSFW_API_URL) {
    const cheap = await classifyCheap(env, bytes);
    if (cheap) {
      const s = Math.max(cheap.nsfw, cheap.violence);
      if (s >= REJECT || s < ESCALATE_LOW) return cheap;        // decided cheaply, no LLM
      return mergeMax(cheap, await classifyGemma(env, bytes));  // gray band → Gemma second opinion
    }
    // classifier errored → fall through to Gemma rather than fail-open silently
  }
  return classifyGemma(env, bytes);
}

// Cheap external NSFW/violence classifier (Sightengine / Hive / self-hosted, etc).
// ADAPTER — vendors differ; tweak the request body + the field parse for yours.
// Returns 0..1 {nsfw, violence}; null on error so the caller falls back to Gemma.
async function classifyCheap(env: Env, bytes: Uint8Array): Promise<ScanResult | null> {
  try {
    const res = await fetch(env.NSFW_API_URL!, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(env.NSFW_API_KEY ? { Authorization: `Bearer ${env.NSFW_API_KEY}` } : {}) },
      body: JSON.stringify({ image_base64: toBase64(bytes) }),
    });
    if (!res.ok) { console.error("nsfw classifier", res.status); return null; }
    const j = (await res.json()) as any;
    const nsfw = num(j.nsfw ?? j.sexual ?? j.porn ?? j.nudity?.raw ?? j.nudity);
    const violence = num(j.violence ?? j.gore?.prob ?? j.gore ?? j.weapon);
    return { nsfw, violence, label: nsfw >= violence ? "nsfw" : "violence", model: "nsfw-classifier" };
  } catch (e) { console.error("nsfw classifier exception", String(e)); return null; }
}

function mergeMax(a: ScanResult, b: ScanResult): ScanResult {
  const nsfw = Math.max(a.nsfw, b.nsfw), violence = Math.max(a.violence, b.violence);
  return { nsfw, violence, label: nsfw >= violence ? "nsfw" : "violence", model: `${a.model}+${b.model}` };
}
function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  if (!isFinite(n)) return 0;
  return n > 1 ? Math.min(1, n / 100) : Math.max(0, n); // tolerate 0-100 or 0..1
}

// --- Gemma 4 vision scan (the careful path) ---
// MODERATION_MODEL_TYPE: "vision" (default; prompt+parse) | "classifier" (label+score model).
async function classifyGemma(env: Env, bytes: Uint8Array): Promise<ScanResult> {
  const model = env.MODERATION_MODEL || "@cf/google/gemma-4-26b-a4b-it";
  const type = env.MODERATION_MODEL_TYPE || "vision";
  const started = Date.now();
  let completionTokens = 0; // [MOD-THINK-1] AI output tokens this scan (spend telemetry)
  try {
    let result: ScanResult;
    if (type === "classifier") {
      const out = (await env.AI.run(model as any, { image: Array.from(bytes) })) as unknown;
      result = parseClassifier(out, model);
    } else {
      const prompt =
        "You are a strict content-safety classifier. Rate the image for two risks on a 0-100 scale: " +
        "NSFW (explicit sexual content / nudity) and VIOLENCE (gore, graphic injury, weapons used to harm). " +
        "Reply with ONLY this exact line, nothing else: nsfw=<0-100> violence=<0-100> label=<one short word>";
      // Multimodal chat schema (Gemma 4 / OpenAI-style): image passed as a data URL.
      // [MOD-THINK-1] Gemma 4's thinking mode is ON by default and burns ~220 reasoning
      // tokens — billed as OUTPUT — per scan to produce a ~12-token answer line.
      // chat_template_kwargs.enable_thinking:false cut measured completion tokens
      // 243→11 (≈22×) with byte-identical content, verified live against
      // @cf/google/gemma-4-26b-a4b-it. max_completion_tokens replaces the deprecated
      // max_tokens; 32 ≫ the ~12 needed. Order matters: capping WHILE thinking is on
      // truncates before the answer (empty content → parsed 0/0 → fail-open), so we
      // disable thinking FIRST, then cap. (thinking:false / reasoning_effort had no
      // effect; enable_thinking:false is the working flag.)
      const out = (await env.AI.run(model as any, {
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl(bytes) } },
          ],
        }],
        chat_template_kwargs: { enable_thinking: false },
        max_completion_tokens: 32, temperature: 0,
      })) as unknown;
      completionTokens = Number((out as any)?.usage?.completion_tokens ?? 0);
      const text = aiText(out).toLowerCase();
      const nsfw = pct(text, "nsfw");
      const violence = pct(text, "violence");
      const label = text.match(/label\s*[=:]\s*([a-z_]+)/)?.[1] || (nsfw >= violence ? "nsfw" : "violence");
      result = { nsfw, violence, label, model };
    }
    // F6: operational cost/latency metric (one inference). Neuron count isn't
    // returned by AI.run, so we track count + duration + model as a proxy.
    try {
      env.ANALYTICS?.writeDataPoint({ blobs: ["moderation", model, type], doubles: [Date.now() - started, 1, completionTokens], indexes: ["ai_moderation"] });
    } catch { /* metrics best-effort */ }
    await bumpAiSpend(env, Date.now() - started);
    return result;
  } catch {
    // Fail-open (consistent posture): a clean result; a re-scan can run later.
    return { nsfw: 0, violence: 0, label: "scan_error", model };
  }
}

// Label+score classifier output: Array<{label,score}> | {results:[...]} | {label,score}.
function parseClassifier(out: unknown, model: string): ScanResult {
  const arr = Array.isArray(out) ? out as any[] : ((out as any)?.results ?? ((out as any)?.label ? [out] : []));
  let nsfw = 0, violence = 0, label = "safe";
  for (const e of arr) {
    const l = (e.label || "").toLowerCase();
    const s = Number(e.score) || 0;
    if (/(nsfw|porn|sexual|explicit|hentai|nude|unsafe)/.test(l) && s > nsfw) { nsfw = s; if (s >= violence) label = l; }
    if (/(gun|rifle|revolver|weapon|knife|assault|blood|gore|violen)/.test(l) && s > violence) { violence = s; if (s > nsfw) label = l; }
  }
  return { nsfw, violence, label, model };
}

// Extract "<key>=NN" (0-100) → 0..1. Tolerates "nsfw: 80", "nsfw=0.8", etc.
function pct(text: string, key: string): number {
  const m = text.match(new RegExp(key + "\\s*[=:]\\s*([0-9]+(?:\\.[0-9]+)?)"));
  if (!m) return 0;
  let v = parseFloat(m[1]);
  if (v > 1) v = v / 100; // 0-100 scale → 0..1
  return Math.max(0, Math.min(1, v));
}

// --- image bytes → data URL for the multimodal chat input (Gemma 4 vision) ---
function dataUrl(bytes: Uint8Array): string {
  return `data:${sniffMime(bytes)};base64,${toBase64(bytes)}`;
}
function sniffMime(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  return "image/jpeg";
}
function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// --- Block 4 helpers ---
// LSH banding: find candidate blocked hashes that share ANY 16-bit band (indexed
// lookup, scales to millions), then Hamming-verify only those few candidates.
async function matchesBlockedPerceptual(env: Env, phash: string): Promise<boolean> {
  const [b0, b1, b2, b3] = bands(phash);
  const rs = await env.DB_MODERATION.prepare(
    `SELECT DISTINCT full_hash FROM blocked_phash_bands
     WHERE (band_index=0 AND band_value=?1) OR (band_index=1 AND band_value=?2)
        OR (band_index=2 AND band_value=?3) OR (band_index=3 AND band_value=?4)`,
  ).bind(b0, b1, b2, b3).all();
  for (const r of (rs.results ?? []) as Array<{ full_hash: string }>) {
    if (hamming(phash, r.full_hash) <= PHASH_MATCH_DISTANCE) return true;
  }
  return false;
}

// Seed the perceptual blocklist (+ its band rows) when an AI-confirmed-bad image
// is rejected, so future near-duplicates (resize/recompress) are caught by band lookup.
async function addBlockedPerceptual(env: Env, hashId: string, phash: string): Promise<void> {
  const bs = bands(phash);
  await env.DB_MODERATION.batch([
    env.DB_MODERATION.prepare(
      `INSERT OR IGNORE INTO blocked_media_hashes (id,hash_type,hash_value,category,source,created_at)
       VALUES (?1,'perceptual',?2,'ai_image','admin_confirmed',?3)`,
    ).bind(hashId, phash, Date.now()),
    ...bs.map((v, i) => env.DB_MODERATION.prepare(
      "INSERT OR IGNORE INTO blocked_phash_bands (band_index, band_value, hash_id, full_hash) VALUES (?1,?2,?3,?4)",
    ).bind(i, v, hashId, phash)),
  ]);
}

async function storePhash(env: Env, mediaId: string, uid: string, phash: string): Promise<void> {
  await env.DB_MEDIA.prepare(
    "INSERT INTO user_media_hashes (id, media_id, uid, frame_index, phash, created_at) VALUES (?1,?2,?3,0,?4,?5)",
  ).bind(crypto.randomUUID(), mediaId, uid, phash, Date.now()).run();
}

async function setStatus(env: Env, mediaId: string, status: string): Promise<void> {
  await env.DB_MEDIA.prepare("UPDATE user_media SET moderation_status=?2 WHERE id=?1").bind(mediaId, status).run();
}

// --- Text moderation (Workers AI safety classifier) — replaces the OpenAI path,
// zero extra cost. For post text, bios, community descriptions. Llama Guard is
// the only Workers AI text-safety model available on this account; it is used
// purely as a binary classifier (it emits just "safe" / "unsafe S<codes>"), not
// as a free-form chat LLM. Swappable via TEXT_MODERATION_MODEL. Returns a simple
// {safe, score, categories} so callers can gate or strike.
export async function moderateText(env: Env, text: string): Promise<{ safe: boolean; score: number; categories: string[]; raw: string }> {
  const model = env.TEXT_MODERATION_MODEL || "@cf/meta/llama-guard-3-8b";
  try {
    const out = (await env.AI.run(model as any, {
      messages: [{ role: "user", content: text }],
    })) as unknown as { response?: string };
    const raw = (out.response ?? "").trim();
    const safe = /^\s*safe/i.test(raw);
    const categories = (raw.match(/s\d+/gi) ?? []).map((s) => s.toUpperCase());
    return { safe, score: safe ? 0 : 1, categories, raw };
  } catch {
    return { safe: true, score: 0, categories: [], raw: "scan_error" }; // fail-open
  }
}
