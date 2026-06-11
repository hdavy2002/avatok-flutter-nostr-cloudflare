// AvaAffiliate v2 — Marketing-asset kit (PROPOSAL-AVA-AFFILIATE.md §Resolved #4).
// Gemini "Nano Banana 2" (gemini-3.1-flash-image-preview) generates 3 branded
// promo images per run (story 9:16 · post 1:1 · banner 16:9) from the listing's
// title/app/price + creator name. The prompt RESERVES a clean solid-colored
// lower third — the app composites a REAL scannable QR there client-side (a
// generated QR would be decorative garbage). Images land in the PUBLIC blob
// bucket (same pipeline as /upload/public) so the existing blossom.avatok.ai +
// /cdn-cgi/image/… CDN path serves them with zero new infrastructure.
//
//   POST /api/affiliate/links/:id/assets {style?}  generate 3 images (flag-gated)
//   GET  /api/affiliate/links/:id/assets           list (newest first, CDN URLs)
//
// Gates: affiliateAssetKitEnabled flag, link ownership, GEMINI_API_KEY (503),
// max 3 generations (9 images) per link per day (KV sliding window). Raw Gemini
// errors are NEVER forwarded to the client.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb } from "../db/shard";
import { rateLimit } from "../money";
import { track, metric } from "../hooks";
import { readConfig } from "./config";

const APP = "avaaffiliate";
export const ASSET_MODEL = "gemini-3.1-flash-image-preview"; // Nano Banana 2

const APP_LABEL: Record<string, string> = { avalive: "AvaLive", avaconsult: "AvaConsult", avavoice: "AvaVoice" };

// The three deliverables — one generateContent call per format.
const FORMATS: { format: "story" | "post" | "banner"; aspect: "9:16" | "1:1" | "16:9" }[] = [
  { format: "story", aspect: "9:16" },
  { format: "post", aspect: "1:1" },
  { format: "banner", aspect: "16:9" },
];

interface AssetLinkRow { id: string; affiliate_uid: string; listing_id: string; app: string; status: string; }

async function ownedLink(env: Env, uid: string, linkId: string): Promise<AssetLinkRow | null> {
  const r = await metaDb(env).prepare("SELECT * FROM affiliate_links WHERE id=?1").bind(linkId).first<any>();
  if (!r || String(r.affiliate_uid) !== uid) return null;
  return r as AssetLinkRow;
}

/** Listing title/price + creator display name for the prompt (best-effort). */
async function promptFacts(env: Env, link: AssetLinkRow):
    Promise<{ title: string; price: number; creator: string }> {
  const db = metaDb(env);
  let title = "a creator listing";
  let price = 0;
  let creatorId = "";
  if (link.app === "avavoice") {
    const a = await db.prepare("SELECT name, rate_per_hour, creator_id FROM avavoice_agents WHERE id=?1")
      .bind(link.listing_id).first<any>().catch(() => null);
    if (a) { title = String(a.name); price = Number(a.rate_per_hour); creatorId = String(a.creator_id); }
  } else {
    const l = await db.prepare("SELECT title, price, creator_id FROM listings WHERE id=?1")
      .bind(link.listing_id).first<any>().catch(() => null);
    if (l) { title = String(l.title); price = Number(l.price); creatorId = String(l.creator_id); }
  }
  let creator = "an AvaTok creator";
  if (creatorId) {
    const u = await db.prepare("SELECT handle, display_name FROM users WHERE uid=?1")
      .bind(creatorId).first<any>().catch(() => null);
    if (u) creator = String(u.display_name || u.handle || creator);
  }
  return { title, price, creator };
}

/** Art direction. The hard constraints (clean lower third, minimal text) exist
 *  so the app can overlay a real QR and the image can't ship a misspelling. */
function buildPrompt(p: { title: string; price: number; creator: string; app: string; format: string; style?: string }): string {
  const appLabel = APP_LABEL[p.app] ?? "AvaTok";
  const priceLabel = p.price > 0
    ? `$${(p.price / 100).toFixed(p.price % 100 === 0 ? 0 : 2)}${p.app === "avavoice" ? "/hour" : ""}` : "";
  const style = (p.style || "").trim().slice(0, 200);
  return [
    `Design a vibrant, modern social-media promo graphic (${p.format} format) for "${p.title}" — `,
    `a ${appLabel} experience by ${p.creator} on the AvaTok app${priceLabel ? `, priced at ${priceLabel}` : ""}.`,
    ` Art direction: bold energetic gradients, dynamic shapes, premium social-promo aesthetic`,
    style ? `, in this requested style: ${style}.` : ".",
    ` HARD CONSTRAINTS:`,
    ` (1) Leave the entire lower third of the image as a clean, flat, solid-colored area with NO artwork,`,
    ` patterns, gradients or text — a QR code will be overlaid there later. Do NOT draw a QR code yourself.`,
    ` (2) Keep text minimal to avoid misspellings: ONLY the product title "${p.title}" and the words "Scan to join". No other words.`,
    ` (3) No real-person likenesses, no platform logos other than stylized "AvaTok" lettering.`,
  ].join("");
}

/** One Gemini generateContent call → PNG bytes (inlineData base64). */
async function generateImage(env: Env, prompt: string, aspect: string): Promise<Uint8Array> {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${ASSET_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY! },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: { aspectRatio: aspect },
        },
      }),
    },
  );
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw new Error(`gemini ${r.status}: ${String(j?.error?.message ?? "unknown").slice(0, 200)}`);
  const parts = j?.candidates?.[0]?.content?.parts ?? [];
  const inline = parts.find((p: any) => p?.inlineData?.data)?.inlineData;
  if (!inline?.data) throw new Error("gemini returned no image");
  const bin = atob(String(inline.data));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const assetUrl = (env: Env, key: string) => `${env.BLOSSOM_BASE_URL}/${key}`;

// ---------------------------------------------------------------------------
// POST /api/affiliate/links/:id/assets {style?} — generate the 3-image kit
// ---------------------------------------------------------------------------
export async function affiliateAssetsGenerate(req: Request, env: Env, linkId: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const cfg = await readConfig(env);
  if (cfg.affiliateAssetKitEnabled !== true) {
    return json({ error: "marketing-asset kit disabled", flag: "affiliateAssetKitEnabled" }, 503);
  }
  if (!env.GEMINI_API_KEY) return json({ error: "asset kit unavailable", reason: "GEMINI_API_KEY unset" }, 503);
  const link = await ownedLink(env, ctx.uid, linkId);
  if (!link) return json({ error: "not found" }, 404);

  // Max 3 generations (9 images) per link per day — same KV limiter as the rest.
  const limited = await rateLimit(env, `aff:assets:${linkId}`, 3, 86_400);
  if (limited) return limited;

  const b = (await req.json().catch(() => ({}))) as any;
  const style = typeof b.style === "string" ? b.style : undefined;
  const facts = await promptFacts(env, link);
  const ts = Date.now();
  const db = metaDb(env);
  const out: { id: string; format: string; r2_key: string; url: string; created_at: number }[] = [];

  try {
    for (const f of FORMATS) {
      const prompt = buildPrompt({ ...facts, app: link.app, format: f.format, style });
      const bytes = await generateImage(env, prompt, f.aspect);
      // PUBLIC blob pipeline layout: same bucket blossom.avatok.ai serves, so the
      // CDN transform path /cdn-cgi/image/…/<key> works for these out of the box.
      const r2Key = `affiliate-assets/${linkId}/${f.format}-${ts}.png`;
      await env.BLOBS.put(r2Key, bytes, { httpMetadata: { contentType: "image/png" } });
      const id = crypto.randomUUID();
      await db.prepare(
        "INSERT INTO affiliate_assets (id, link_id, format, r2_key, created_at) VALUES (?1,?2,?3,?4,?5)",
      ).bind(id, linkId, f.format, r2Key, ts).run();
      out.push({ id, format: f.format, r2_key: r2Key, url: assetUrl(env, r2Key), created_at: ts });
    }
  } catch (e) {
    // Never leak raw Gemini errors to the client; full detail goes to logs/telemetry.
    console.error("affiliate asset generation failed:", String(e));
    track(env, ctx.uid, "affiliate_assets_failed", APP,
        { link_id: linkId, reason: String(e).slice(0, 200), generated: out.length });
    metric(env, "affiliate_assets_failed", [1], [link.app]);
    if (out.length === 0) return json({ error: "asset generation failed — try again later" }, 502);
    // Partial success: return what landed (already stored + persisted).
    return json({ ok: true, partial: true, assets: out, model: ASSET_MODEL });
  }

  track(env, ctx.uid, "affiliate_assets_generated", APP,
      { link_id: linkId, formats: 3, model: ASSET_MODEL });
  metric(env, "affiliate_assets_generated", [3], [link.app]);
  return json({ ok: true, assets: out, model: ASSET_MODEL });
}

// ---------------------------------------------------------------------------
// GET /api/affiliate/links/:id/assets — newest first, public CDN URLs
// ---------------------------------------------------------------------------
export async function affiliateAssetsList(req: Request, env: Env, linkId: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const link = await ownedLink(env, ctx.uid, linkId);
  if (!link) return json({ error: "not found" }, 404);
  const rs = await metaDb(env).prepare(
    "SELECT id, format, r2_key, created_at FROM affiliate_assets WHERE link_id=?1 ORDER BY created_at DESC, format ASC LIMIT 60",
  ).bind(linkId).all().catch(() => ({ results: [] as any[] }));
  return json({
    assets: ((rs.results ?? []) as any[]).map((a) => ({
      id: String(a.id), format: String(a.format), r2_key: String(a.r2_key),
      url: assetUrl(env, String(a.r2_key)), created_at: Number(a.created_at),
    })),
  });
}
