// [HF-HOST-PLATFORM-1] Host profile media generation — Cloudflare Workflows.
//   HostMediaWorkflow  (binding HOST_MEDIA)   text -> images -> safety -> pending_host   [HF-VOICE-INTRO-1: voice clone + sample conversation removed]
//   AvatarBatchWorkflow (binding AVATAR_BATCH) admin "generate N synthetic avatars"
// Step results stay small (keys/ids only); bytes go straight to R2 inside the step. Every step is idempotent on retry
// (deterministic ids/keys derived from jobId). Stage/state is mirrored in hf_media_jobs.stages_json for the status API.
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Env } from "../types";
import { BRAND, brandUrl } from "../lib/brand";
import { track, trackUser, trackException } from "../hooks";
import { emailFor } from "../lib/identity";
import { generateImage } from "../routes/ava_image";
import { generateHostCopy, textSafety, type HostCopy } from "../lib/hf_media_text";
import { sendWhatsAppText } from "../lib/whatsapp_send";
import { sanitizeAvatarPlan, type AvatarPlanEntry } from "../lib/hf_avatar_plan";

const APP = BRAND.slug;
type Stage = "text" | "images" | "safety";
type StageState = "waiting" | "working" | "done" | "failed";
const RETRY = { retries: { limit: 1, delay: "5 seconds" as const, backoff: "exponential" as const }, timeout: "4 minutes" as const };
const NO_RETRY = { retries: { limit: 0, delay: "1 second" as const }, timeout: "4 minutes" as const };

export interface HostMediaParams { uid: string; jobId: string }
export interface AvatarBatchParams { count: number; gender: "woman" | "man"; age: string; look: string; jobId: string; plan?: AvatarPlanEntry[] }

// [HF-AVATAR-FILL-1] One image = one durable step with real Workflow retries (rate limits are transient).
// fn throws on failure; content_blocked is fatal (no point retrying). Exhaustion reports once and returns false.
const IMAGE_STEP = { retries: { limit: 4, delay: "20 seconds" as const, backoff: "exponential" as const }, timeout: "4 minutes" as const };
async function imageStep(
  env: Env, step: WorkflowStep, name: string, area: "hf_host_media" | "hf_avatar_batch", fn: () => Promise<void>,
): Promise<boolean> {
  try {
    await step.do(name, IMAGE_STEP, async () => {
      try { await fn(); } catch (e) {
        if (String((e as any)?.message ?? e).includes("content_blocked")) throw new NonRetryableError(String((e as any)?.message ?? e).slice(0, 200), "content_blocked");
        throw e;
      }
    });
    return true;
  } catch (e) {
    await trackException(env, e, { route: `/workflow/${area}`, handled: true, app_name: APP, extra: { area, step: name } }).catch(() => {});
    return false;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
async function setStage(env: Env, uid: string, jobId: string, stage: Stage, state: StageState, cost?: Record<string, number>, error?: string): Promise<void> {
  const row = await env.DB_META.prepare("SELECT stages_json, cost_json FROM hf_media_jobs WHERE id=?1").bind(jobId)
    .first<{ stages_json: string | null; cost_json: string | null }>().catch(() => null);
  let stages: Record<string, string> = {}; let costs: Record<string, number> = {};
  try { stages = JSON.parse(row?.stages_json || "{}"); } catch { /* reset */ }
  try { costs = JSON.parse(row?.cost_json || "{}"); } catch { /* reset */ }
  stages[stage] = state;
  if (cost) costs = { ...costs, ...cost };
  await env.DB_META.prepare("UPDATE hf_media_jobs SET stage=?2, stages_json=?3, cost_json=?4, error=COALESCE(?5,error), status=CASE WHEN status='queued' THEN 'running' ELSE status END, updated_at=?6 WHERE id=?1")
    .bind(jobId, stage, JSON.stringify(stages), JSON.stringify(costs), error ?? null, Date.now()).run();
  const email = await emailFor(env, uid).catch(() => null);
  await trackUser(env, uid, email, "hf_host_media_stage", APP, { area: "hf_host_media", job_id: jobId, stage, state, ...(error ? { error } : {}) }).catch(() => {});
}

function toDataUrl(bytes: Uint8Array, mime: string): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(s)}`;
}

interface HostRow {
  display_name: string | null; about: string | null; languages_json: string; style: string | null; topics_json: string;
  conversation_lang: string | null; avatar_id: string | null; status: string;
}
const parseArr = (s: string | null | undefined): string[] => { try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };

const SCENES = [
  "sitting on a balcony in the evening holding a cup of chai, warm dusk light, city rooftops softly blurred behind",
  "reading a book in a cosy room, sitting in an armchair by a lamp, relaxed expression",
  "walking along a path in a green park in the morning, casual everyday clothes, gentle smile, trees behind",
  "sitting at a tidy work desk with a laptop, focused but friendly, plain background, daylight",
  "at home in a living room decorated with warm Diwali lights and diyas, festive but simple, smiling",
];
const GALLERY_RULES = (who: string, scene: string) =>
  `Use the attached reference photo. Keep the EXACT same ${who}: identical face and facial features, same hairstyle, same skin tone and same apparent age. ` +
  `Create a NEW photorealistic photograph of them: ${scene}. 4:5 portrait. Everyday, respectful, fully clothed, natural candid look. ` +
  `No other identifiable people, no text, no logos, no watermarks, no celebrity likeness.`;

async function verifiedE164(env: Env, uid: string): Promise<string | null> {
  const cv = await env.DB_META.prepare("SELECT phone_verified, phone_hash FROM contact_verification WHERE uid=?1").bind(uid)
    .first<{ phone_verified: number; phone_hash: string | null }>().catch(() => null);
  if (!cv || Number(cv.phone_verified) !== 1 || !cv.phone_hash) return null;
  const row = await env.DB_META.prepare("SELECT e164 FROM phone_otp WHERE uid=?1 AND phone_hash=?2 AND status='verified' ORDER BY verified_at DESC LIMIT 1")
    .bind(uid, cv.phone_hash).first<{ e164: string }>().catch(() => null);
  return row?.e164 ?? null;
}

// ── HostMediaWorkflow ────────────────────────────────────────────────────────
export class HostMediaWorkflow extends WorkflowEntrypoint<Env, HostMediaParams> {
  async run(event: WorkflowEvent<HostMediaParams>, step: WorkflowStep): Promise<void> {
    const env = this.env;
    const { uid, jobId } = event.payload;
    let current: Stage = "text";

    try {
      const ctx = await step.do("load", RETRY, async () => {
        const h = await env.DB_META.prepare(
          "SELECT display_name, about, languages_json, style, topics_json, conversation_lang, avatar_id, status FROM hf_hosts WHERE uid=?1",
        ).bind(uid).first<HostRow>();
        if (!h || !h.avatar_id || !h.display_name) throw new Error("host_incomplete");
        const av = await env.DB_META.prepare("SELECT image_key, gender FROM hf_avatars WHERE id=?1").bind(h.avatar_id).first<{ image_key: string; gender: string }>();
        if (!av) throw new Error("avatar_missing");
        await env.DB_META.prepare("UPDATE hf_media_jobs SET status='running', stages_json=?2, updated_at=?3 WHERE id=?1")
          .bind(jobId, JSON.stringify({ text: "waiting", images: "waiting", safety: "waiting" }), Date.now()).run();
        return {
          ts: Date.now(), displayName: h.display_name, about: h.about ?? "", languages: parseArr(h.languages_json), style: h.style,
          topics: parseArr(h.topics_json), lang: (h.conversation_lang || "hi").toLowerCase(), avatarKey: av.image_key, gender: av.gender,
        };
      });
      const who = ctx.gender === "woman" ? "woman" : "man";

      // 1) TEXT
      current = "text";
      const copy: HostCopy = await step.do("text", RETRY, async () => {
        await setStage(env, uid, jobId, "text", "working");
        const r = await generateHostCopy(env, {
          uid, jobId, displayName: ctx.displayName, about: ctx.about, languages: ctx.languages, style: ctx.style, topics: ctx.topics,
          conversationLang: ctx.lang, gender: who,
        });
        if (!r.ok) throw new Error(`text_${r.error}`);
        await setStage(env, uid, jobId, "text", "done", { gemini_text_calls: 1 });
        return r.copy;
      });

      // 2) IMAGES — avatar is the profile image; 5 gallery scenes with the avatar as the face reference
      current = "images";
      await step.do("images-start", RETRY, async () => {
        await setStage(env, uid, jobId, "images", "working");
        await env.DB_META.prepare("INSERT OR REPLACE INTO hf_host_media (id, uid, kind, r2_key, caption, sort, status, job_id, created_at) VALUES (?1,?2,'profile',?3,NULL,0,'active',?4,?5)")
          .bind(`${jobId}-p`, uid, ctx.avatarKey, jobId, ctx.ts).run();
      });
      let made = 0;
      for (let n = 1; n <= SCENES.length; n++) {
        const ok = await imageStep(env, step, `image-${n}`, "hf_host_media", async () => {
          const ref = await env.BLOBS.get(ctx.avatarKey);
          if (!ref) throw new Error("avatar_image_missing");
          const dataUrl = toDataUrl(new Uint8Array(await ref.arrayBuffer()), "image/png");
          const img = await generateImage(env, jobId, GALLERY_RULES(who, SCENES[n - 1]), uid, dataUrl, { aspectRatio: "4:5" });
          const key = `hf/hosts/${uid}/gallery-${n}-${ctx.ts}.png`;
          await env.BLOBS.put(key, img.bytes, { httpMetadata: { contentType: "image/png" } });
          await env.DB_META.prepare("INSERT OR REPLACE INTO hf_host_media (id, uid, kind, r2_key, caption, sort, status, job_id, created_at) VALUES (?1,?2,'gallery',?3,NULL,?4,'active',?5,?6)")
            .bind(`${jobId}-g${n}`, uid, key, n, jobId, ctx.ts).run();
        });
        if (ok) made++;
      }
      if (made < 3) throw new Error("images_failed");
      await step.do("images-done", RETRY, () => setStage(env, uid, jobId, "images", "done", { images: made }));

      // 3) SAFETY
      current = "safety";
      const verdict = await step.do("safety", RETRY, async () => {
        await setStage(env, uid, jobId, "safety", "working");
        const v = await textSafety(env, uid, jobId, copy);
        if (!v.ok) return { ok: false, reason: v.reason ?? "unsafe" };
        await setStage(env, uid, jobId, "safety", "done", { gemini_safety_calls: 1 });
        return { ok: true, reason: "" };
      });
      if (!verdict.ok) throw new Error(`safety_${verdict.reason}`);

      // FINALIZE
      await step.do("finalize", RETRY, async () => {
        const now = Date.now();
        await env.DB_META.batch([
          env.DB_META.prepare("UPDATE hf_host_media SET status='superseded' WHERE uid=?1 AND status='active' AND kind<>'intro_audio' AND COALESCE(job_id,'')<>?2").bind(uid, jobId),
          env.DB_META.prepare("UPDATE hf_hosts SET status='pending_host', tagline=?2, quote=?3, about_polished=?4, updated_at=?5 WHERE uid=?1").bind(uid, copy.tagline, copy.quote, copy.aboutPolished, now),
          env.DB_META.prepare("UPDATE hf_media_jobs SET status='done', error=NULL, updated_at=?2 WHERE id=?1").bind(jobId, now),
        ]);
      });

      // NOTIFY (best-effort, never fails the job)
      await step.do("notify", NO_RETRY, async () => {
        try {
          const e164 = await verifiedE164(env, uid);
          if (e164) {
            await sendWhatsAppText(env, e164, `Your ${BRAND.name} profile is ready to check: ${brandUrl("/hosts/onboarding?step=preview")}`);
          }
        } catch { /* best-effort */ }
        void track(env, uid, "hf_host_media_stage", APP, { area: "hf_host_media", job_id: jobId, stage: "notify", state: "done" });
      });
    } catch (e) {
      const msg = String((e as any)?.message ?? e).replace(/[^a-zA-Z0-9_ :.-]/g, "").slice(0, 80) || "failed";
      await step.do("fail", NO_RETRY, async () => {
        const now = Date.now();
        await setStage(env, uid, jobId, current, "failed", undefined, msg).catch(() => {});
        await env.DB_META.batch([
          env.DB_META.prepare("UPDATE hf_media_jobs SET status='failed', error=?2, updated_at=?3 WHERE id=?1").bind(jobId, msg, now),
          env.DB_META.prepare("UPDATE hf_host_media SET status='superseded' WHERE job_id=?1").bind(jobId),
          env.DB_META.prepare("UPDATE hf_hosts SET status='draft', updated_at=?2 WHERE uid=?1 AND status='generating'").bind(uid, now),
        ]);
      }).catch(() => {});
      throw e;
    }
  }
}

// ── AvatarBatchWorkflow ──────────────────────────────────────────────────────
const SKIN = ["fair wheatish", "wheatish", "light brown", "medium brown", "warm brown", "deep brown", "dusky"];
const FACE = ["oval", "round", "square-jawed", "heart-shaped", "long", "soft angular"];
const REGION = ["North Indian", "Punjabi", "Rajasthani", "Gujarati", "Maharashtrian", "Bengali", "Odia", "Telugu", "Tamil", "Kannada", "Malayali", "Himachali", "Kashmiri", "Assamese"];
const HAIR_W = ["long black hair in a loose braid", "shoulder-length wavy black hair", "neat bob cut", "hair tied in a low bun", "long straight dark-brown hair", "short layered hair", "grey-streaked hair in a bun"];
const HAIR_M = ["short neatly styled black hair", "short hair with light stubble", "medium-length wavy hair", "close-cropped hair and short beard", "side-parted hair and trimmed moustache", "salt-and-pepper short hair", "clean-shaven with neat short hair"];
const AGE_TXT: Record<string, string> = { "20s": "in their mid 20s", "30s": "in their mid 30s", "40s": "in their mid 40s", "50s+": "in their mid 50s" };
const LOOK_TXT = (look: string, woman: boolean): string =>
  look === "traditional" ? (woman ? "wearing a simple everyday cotton salwar kameez or saree, soft blurred cosy home interior" : "wearing a plain everyday cotton kurta, soft blurred cosy home interior")
  : look === "office" ? "wearing smart-casual office clothes, soft blurred bright office background"
  : "wearing a casual everyday shirt or top, soft blurred cafe or home background";
const pick = <T>(a: T[], i: number, salt: number): T => a[(i * 3 + salt) % a.length];

export class AvatarBatchWorkflow extends WorkflowEntrypoint<Env, AvatarBatchParams> {
  async run(event: WorkflowEvent<AvatarBatchParams>, step: WorkflowStep): Promise<void> {
    const env = this.env;
    const { jobId } = event.payload;
    const plan = event.payload.plan !== undefined ? sanitizeAvatarPlan(event.payload.plan) : null;
    if (event.payload.plan !== undefined && !plan) {
      await env.DB_META.prepare("UPDATE hf_media_jobs SET status='failed', error='bad_plan', updated_at=?2 WHERE id=?1").bind(jobId, Date.now()).run();
      throw new NonRetryableError("bad_plan", "bad_plan");
    }
    // Single-batch params become a one-entry list; with a plan we run entries strictly one after another.
    const entries: Array<{ gender: "woman" | "man"; age: string; look: string; count: number }> = plan ?? [{
      gender: event.payload.gender === "woman" ? "woman" : "man",
      age: AGE_TXT[event.payload.age] ? event.payload.age : "30s",
      look: ["traditional", "casual", "office"].includes(event.payload.look) ? event.payload.look : "casual",
      count: Math.max(1, Math.min(12, Math.trunc(Number(event.payload.count) || 1))),
    }];
    const total = entries.reduce((n, e) => n + e.count, 0);
    const salt = Math.floor(Math.random() * 97);
    let done = 0, failed = 0;
    const setJob = async (status: string, error?: string): Promise<void> => {
      await env.DB_META.prepare("UPDATE hf_media_jobs SET status=?2, stages_json=?3, cost_json=?4, error=?5, updated_at=?6 WHERE id=?1")
        .bind(jobId, status, JSON.stringify({ done, total, failed }), JSON.stringify({ images: done }), error ?? null, Date.now()).run();
    };
    try {
      await step.do("start", RETRY, () => setJob("running"));
      let idx = 0;
      for (let e = 0; e < entries.length; e++) {
        const { gender, age, look, count } = entries[e];
        const woman = gender === "woman";
        for (let i = 0; i < count; i++, idx++) {
          // Deterministic names; without a plan keep the legacy `avatar-${i}` names.
          const name = plan ? `avatar-${e}-${i}` : `avatar-${i}`;
          const id = plan ? `${jobId}-${e}-${i}` : `${jobId}-${i}`;
          if (plan && idx > 0) await step.sleep(`pause-${idx}`, "10 seconds");
          const ok = await imageStep(env, step, name, "hf_avatar_batch", async () => {
            const prompt =
              `Photorealistic head-and-shoulders portrait photograph of a fully synthetic ${pick(REGION, i + e, salt)} Indian ${woman ? "woman" : "man"} ${AGE_TXT[age]}, ` +
              `${pick(SKIN, i + e, salt + 2)} skin tone, ${pick(FACE, i + e, salt + 1)} face, ${pick(woman ? HAIR_W : HAIR_M, i + e, salt + 4)}, warm natural gentle smile, ` +
              `${LOOK_TXT(look, woman)}, fully clothed, natural window light, 85mm lens, 4:5 portrait framing. ` +
              `Must not resemble any real person or celebrity. No text, logos or watermarks.`;
            const img = await generateImage(env, jobId, prompt, "system:hf-avatar", undefined, { aspectRatio: "4:5" });
            const key = `hf/avatars/${id}.png`;
            await env.BLOBS.put(key, img.bytes, { httpMetadata: { contentType: "image/png" } });
            await env.DB_META.prepare("INSERT OR IGNORE INTO hf_avatars (id, image_key, gender, age_band, look, status, prompt, created_at) VALUES (?1,?2,?3,?4,?5,'active',?6,?7)")
              .bind(id, key, gender, age, look, prompt.slice(0, 600), Date.now()).run();
          });
          if (ok) {
            done++;
            await step.do(`ok-${name}`, NO_RETRY, async () => { void track(env, "server", "hf_avatar_generated", APP, { ok: true, area: "hf_avatar_batch", job_id: jobId }); }).catch(() => {});
          } else failed++;
          await step.do(`progress-${name}`, RETRY, () => setJob("running"));
        }
      }
      await step.do("finish", RETRY, () => setJob(done > 0 ? "done" : "failed", done > 0 ? undefined : "no_avatars_generated"));
    } catch (e) {
      const msg = String((e as any)?.message ?? e).replace(/[^a-zA-Z0-9_ :.-]/g, "").slice(0, 80) || "failed";
      await step.do("fail", NO_RETRY, () => setJob("failed", msg)).catch(() => {});
      throw e;
    }
  }
}
