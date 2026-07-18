// Google Cloud Text-to-Speech from the Worker (RECEPT-TTS-GOOGLE, owner decision
// 2026-07-18). Cloud TTS (texttospeech.googleapis.com) does NOT accept API keys —
// it needs an OAuth2 access token asserting a principal. So we mint one from a
// service-account JSON key (project avatok-avaglobal, SA ava-tts@…) using a
// self-signed RS256 JWT (RFC 7523) via Web Crypto, exchange it at Google's token
// endpoint, and cache it in-isolate until ~1 min before expiry.
//
// Used by the CF receptionist engine (do/reception_room_cf.ts) as the DEFAULT
// voice for EVERY language (owner 2026-07-18: "disable aura, wavenet default, any
// language"). googleSynthesizeForLang() resolves the session's BCP-47 language to
// a WaveNet voice for that language (querying Cloud TTS's voice list and caching),
// preferring WaveNet, then Neural2, then Chirp3-HD, then Standard. Returns raw
// PCM16 @24kHz mono (little-endian) — the shape cfSpeak() streams — or null on ANY
// failure so the caller transparently falls back to the legacy Deepgram path (an
// outage never silences Ava; unset GOOGLE_TTS_SA_JSON to disable, no redeploy).

interface ServiceAccount { client_email: string; private_key: string; token_uri?: string; }

// ── base64url / PEM helpers ──────────────────────────────────────────────────
function b64url(bytes: Uint8Array): string {
  let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(str: string): string { return b64url(new TextEncoder().encode(str)); }
function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const bin = atob(body); const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

// ── access-token cache (in-isolate) ──────────────────────────────────────────
const _tokenCache = new Map<string, { token: string; exp: number }>();
async function accessTokenFor(sa: ServiceAccount): Promise<string> {
  const cached = _tokenCache.get(sa.client_email);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now) return cached.token;
  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
  const header = { alg: "RS256", typ: "JWT" };
  const claim = { iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: tokenUri, iat: now, exp: now + 3600 };
  const signingInput = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(claim))}`;
  const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)));
  const jwt = `${signingInput}.${b64url(sig)}`;
  const resp = await fetch(tokenUri, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${encodeURIComponent(jwt)}` });
  if (!resp.ok) throw new Error(`google token ${resp.status}`);
  const j = await resp.json() as { access_token: string; expires_in: number };
  _tokenCache.set(sa.client_email, { token: j.access_token, exp: now + (j.expires_in || 3600) });
  return j.access_token;
}

// ── WAV → PCM16 ──────────────────────────────────────────────────────────────
function stripWav(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 44 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    for (let i = 12; i + 8 <= bytes.length; ) {
      const id = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
      const size = bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24);
      if (id === "data") return bytes.subarray(i + 8, Math.min(i + 8 + size, bytes.length));
      i += 8 + size + (size & 1);
    }
    return bytes.subarray(44);
  }
  return bytes;
}

// ── language → BCP-47 region defaults (app launch languages) ─────────────────
const REGION: Record<string, string> = {
  en: "en-IN", hi: "hi-IN", bn: "bn-IN", ta: "ta-IN", te: "te-IN", mr: "mr-IN",
  gu: "gu-IN", kn: "kn-IN", ml: "ml-IN", pa: "pa-IN", ur: "ur-IN", or: "or-IN",
  es: "es-ES", fr: "fr-FR", de: "de-DE", it: "it-IT", pt: "pt-BR", nl: "nl-NL",
  ru: "ru-RU", ar: "ar-XA", ja: "ja-JP", ko: "ko-KR", zh: "cmn-CN", cmn: "cmn-CN",
  vi: "vi-VN", id: "id-ID", th: "th-TH", tr: "tr-TR", uk: "uk-UA",
};
function resolveLangCode(langCode: string | null | undefined, def: string): string {
  const c = (langCode || "").trim();
  if (!c) return def;
  if (c.includes("-") || c.includes("_")) return c.replace("_", "-");
  const base = c.toLowerCase();
  return REGION[base] || def;
}

// ── best voice per language (cached), WaveNet-first ──────────────────────────
const _voiceCache = new Map<string, string>();
// Voice-tier preference (RECEPT_CF_GOOGLE_TIER): which Google voice family to prefer
// per language. Lets us A/B tiers live (owner comparing quality 2026-07-18). The
// first family present for the language wins; the rest are ordered fallbacks.
const TIER_ORDER: Record<string, string[]> = {
  wavenet:  ["Wavenet", "Neural2", "Chirp3", "Standard"],
  neural2:  ["Neural2", "Wavenet", "Chirp3", "Standard"],
  chirp3:   ["Chirp3", "Wavenet", "Neural2", "Standard"],
  standard: ["Standard", "Neural2", "Wavenet", "Chirp3"],
};
function tierRank(name: string, tier: string): number {
  const seq = TIER_ORDER[tier] || TIER_ORDER.wavenet;
  for (let i = 0; i < seq.length; i++) if (name.includes(seq[i])) return i;
  return seq.length;
}
async function pickVoice(token: string, languageCode: string, prefer: string | undefined, tier: string): Promise<string> {
  // An exact configured voice wins ONLY on the default wavenet preference, so a tier
  // override (e.g. neural2) actually takes effect instead of being masked by prefer.
  if (prefer && tier === "wavenet" && prefer.toLowerCase().startsWith(languageCode.toLowerCase())) return prefer;
  const ck = `${languageCode.toLowerCase()}|${tier}`;
  const hit = _voiceCache.get(ck); if (hit != null) return hit;
  let chosen = "";
  try {
    const r = await fetch(`https://texttospeech.googleapis.com/v1/voices?languageCode=${encodeURIComponent(languageCode)}`,
      { headers: { "Authorization": `Bearer ${token}` } });
    if (r.ok) {
      const voices = ((await r.json()) as { voices?: { name: string; ssmlGender: string }[] }).voices || [];
      const females = voices.filter((v) => v.ssmlGender === "FEMALE");
      const pool = (females.length ? females : voices).slice().sort((a, b) => tierRank(a.name, tier) - tierRank(b.name, tier) || a.name.localeCompare(b.name));
      chosen = pool.length ? pool[0].name : "";
    }
  } catch { /* leave chosen "" → Google picks a default for the languageCode */ }
  _voiceCache.set(ck, chosen);
  return chosen;
}

// ── low-level synth → PCM16 ──────────────────────────────────────────────────
async function synthPcm(token: string, text: string, languageCode: string, voice: string, sampleRate: number): Promise<Uint8Array | null> {
  const r = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
    method: "POST", headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { text },
      voice: voice ? { languageCode, name: voice } : { languageCode },
      audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: sampleRate },
    }),
  });
  if (!r.ok) return null;
  const j = await r.json() as { audioContent?: string };
  if (!j.audioContent) return null;
  const bin = atob(j.audioContent); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const pcm = stripWav(bytes);
  return pcm.length ? pcm : null;
}

export interface GoogleTtsLangReq {
  text: string;
  langCode?: string | null;   // session BCP-47 (e.g. "hi-IN") or base ("hi") or ""
  preferVoice?: string;       // exact voice used when it matches the session language (wavenet tier only)
  defaultLang?: string;       // BCP-47 used when langCode is empty (default en-IN)
  tier?: string;              // voice family preference: wavenet|neural2|chirp3|standard
  sampleRate?: number;        // default 24000
}

/** Synthesize in the session's language with a WaveNet-first voice; PCM16 @24kHz
 *  mono, or null on any failure (caller falls back). Never throws. */
export async function googleSynthesizeForLang(env: unknown, opts: GoogleTtsLangReq): Promise<Uint8Array | null> {
  try {
    const raw = (env as { GOOGLE_TTS_SA_JSON?: string }).GOOGLE_TTS_SA_JSON;
    if (!raw || !opts.text) return null;
    const sa = JSON.parse(raw) as ServiceAccount;
    if (!sa.client_email || !sa.private_key) return null;
    const token = await accessTokenFor(sa);
    const languageCode = resolveLangCode(opts.langCode, opts.defaultLang || "en-IN");
    const voice = await pickVoice(token, languageCode, opts.preferVoice, (opts.tier || "wavenet").toLowerCase());
    return await synthPcm(token, opts.text, languageCode, voice, opts.sampleRate || 24000);
  } catch { return null; }
}
