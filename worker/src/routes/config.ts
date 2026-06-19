// Remote kill switches / server config (creator-marketplace Phase 1, audit A2).
// One JSON blob in KV (key `platform_config` — KV's sanctioned feature-flag
// use). Public read, 60 s edge cache; admin-only write. Flipping a flag
// reaches every client within ~15 min (RemoteConfig poll) with no APK release.
import type { Env } from "../types";
import { json } from "../util";
import { isFail, requireUser } from "../authz";

const KEY = "platform_config";

export interface PlatformConfig {
  walletRealMoney: boolean;
  donationsEnabled: boolean;
  liveEnabled: boolean;
  consultEnabled: boolean;
  conferenceEnabled: boolean;
  brainEnabled: boolean;
  verseEnabled: boolean;
  // Progressive Identity ladder (PROPOSAL-PROGRESSIVE-IDENTITY.md)
  identityLadderEnabled: boolean;    // master switch for requireLevel gating
  guestTierEnabled: boolean;         // L0 handle-only visitors
  workersAiLivenessEnabled: boolean; // L2 via Workers AI clip check (Rekognition fallback)
  simOnlyPhoneEnabled: boolean;      // block VoIP/temp numbers on phone verify
  // Live voice translation (Gemini 3.5 Live Translate, $3/h in AvaCoins).
  translationEnabled: boolean;       // master switch for /api/translate/*
  translationGroupEnabled: boolean;  // group conferences (multi-speaker caveat)
  // AvaVoice — creator-built AI voice agents (Specs/AVAVOICE-PROPOSAL.md).
  avavoiceEnabled: boolean;          // master switch for /api/avavoice/*
  avavisionEnabled: boolean;         // master switch for /api/avavision/* (vision coaching agents)
  // Ava Receptionist — premium "Ava answers after 5 rings" (Specs/PROPOSAL-AI-RECEPTIONIST.md).
  // First real AvaVoice deployment. Gemini Live via CF AI Gateway, 2-min cap.
  receptionistEnabled: boolean;      // master switch for /api/receptionist/* (default OFF until tested)
  // AvaAffiliate (Specs/proposals/PROPOSAL-AVA-AFFILIATE.md). OFF stops
  // registration, attribution + the settlement step (redirects keep working).
  avaAffiliateEnabled: boolean;      // master switch (default OFF until launch)
  affiliateAssetKitEnabled: boolean; // v2 Gemini promo-image kit (flag only; no code in v1)
  // Ava in-chat AI kill-switches (Phase 0 — Foundations). These gate the
  // SERVER-SIDE Ava surfaces/tiers; the client mirrors the defaults in
  // app/lib/core/feature_flags.dart. NOTE: runtime "is Ava on for THIS user" is
  // BYO/our-keys connection state, separate from `aiEnabled` (which is the
  // platform-wide master switch / panic button).
  aiEnabled: boolean;                // master switch for ALL Ava features (panic off)
  focusMode: boolean;                // hide non-AvaTOK apps in the drawer (reversible)
  webSearchEnabled: boolean;         // premium-only; our-keys free tier never gets it
  fileAnalysisEnabled: boolean;      // premium-only
  openChatUncapped: boolean;         // premium removes the daily cap
  dailyAvaTurnLimit: number;         // our-keys free-tier cap (turns/account/day)
  guardianEnabled: boolean;          // Guardian safety surfaces (basic free, deep premium)
  companionEnabled: boolean;         // blank "New chat with Ava" + personas
  generativeEnabled: boolean;        // in-thread image gen (each gen is a PaidFeature)
  minAppBuild: number;
}

const DEFAULTS: PlatformConfig = {
  walletRealMoney: false, // money-in stays OFF pending legal (§10.1)
  donationsEnabled: true,
  liveEnabled: true,
  consultEnabled: true,
  conferenceEnabled: true,
  brainEnabled: true,
  verseEnabled: true,
  identityLadderEnabled: true,
  guestTierEnabled: true,
  workersAiLivenessEnabled: false, // flip on after model tuning; Rekognition stays default
  simOnlyPhoneEnabled: true,
  translationEnabled: true,
  translationGroupEnabled: true,
  avavoiceEnabled: true,
  avavisionEnabled: true,
  receptionistEnabled: false,      // Ava Receptionist — OFF until dogfood passes
  avaAffiliateEnabled: false,      // launch gate — flip ON after A5 fraud checks
  affiliateAssetKitEnabled: false, // v2 asset kit (Gemini) — defined, not built
  // Ava in-chat AI defaults (proposal §7.1 anti-abuse tiering).
  aiEnabled: true,
  focusMode: true,
  webSearchEnabled: true,          // BYO (free) + premium; gated by webSearchAllowed
  fileAnalysisEnabled: false,      // premium unlocks
  openChatUncapped: false,         // premium removes the cap
  dailyAvaTurnLimit: 25,
  guardianEnabled: true,
  companionEnabled: true,
  generativeEnabled: true,
  minAppBuild: 0,
};

/** Merged config for server-side gates (same blob getConfig serves). */
export async function readConfig(env: Env): Promise<PlatformConfig> {
  let stored: Partial<PlatformConfig> = {};
  try { stored = ((await env.TOKENS.get(KEY, "json")) ?? {}) as Partial<PlatformConfig>; } catch { /* defaults */ }
  return { ...DEFAULTS, ...stored };
}

export async function getConfig(env: Env): Promise<Response> {
  let stored: Partial<PlatformConfig> = {};
  try {
    stored = (await env.TOKENS.get(KEY, "json")) ?? {};
  } catch { /* defaults */ }
  return json({ ...DEFAULTS, ...stored }, 200, {
    "cache-control": "public, max-age=60",
  });
}

export async function putConfig(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: u.error }, u.status);
  const admins = (env.ADMIN_UIDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!admins.includes(u.uid)) return json({ error: "admin only" }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  // Whitelist merge — unknown keys are rejected so a typo can't ship a dead flag.
  const current = ((await env.TOKENS.get(KEY, "json")) ?? {}) as Partial<PlatformConfig>;
  const next: Record<string, unknown> = { ...DEFAULTS, ...current };
  const numericKeys = new Set(["minAppBuild", "dailyAvaTurnLimit"]);
  for (const [k, v] of Object.entries(body)) {
    if (!(k in DEFAULTS)) return json({ error: `unknown key: ${k}` }, 400);
    if (numericKeys.has(k) ? typeof v !== "number" : typeof v !== "boolean") {
      return json({ error: `bad type for ${k}` }, 400);
    }
    next[k] = v;
  }
  await env.TOKENS.put(KEY, JSON.stringify(next));
  return json({ ok: true, config: next });
}
