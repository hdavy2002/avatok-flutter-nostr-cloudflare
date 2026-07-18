// Google Cloud Text-to-Speech from the Worker (RECEPT-TTS-GOOGLE, owner decision
// 2026-07-18). Cloud TTS (texttospeech.googleapis.com) does NOT accept API keys —
// it needs an OAuth2 access token asserting a principal. So we mint one from a
// service-account JSON key (project avatok-avaglobal, SA ava-tts@…) using a
// self-signed RS256 JWT (RFC 7523) via Web Crypto, exchange it at Google's token
// endpoint, and cache it in-isolate until ~1 min before expiry.
//
// Used by the CF receptionist engine (do/reception_room_cf.ts) to voice Ava in
// Hindi with the natural WaveNet voice (hi-IN-Wavenet-E) instead of the robotic
// Deepgram/melotts path. Returns raw PCM16 @24kHz mono (little-endian) — the exact
// shape cfSpeak() already streams to the caller — or null on ANY failure so the
// caller transparently falls back to the existing TTS path (an outage never
// silences Ava, and no secret change is needed to disable it: unset the secret).

interface ServiceAccount {
  client_email: string;
  private_key: string;      // PEM PKCS#8 ("-----BEGIN PRIVATE KEY-----…")
  token_uri?: string;
}

// ── base64url / PEM helpers ──────────────────────────────────────────────────
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(str: string): string { return b64url(new TextEncoder().encode(str)); }

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, "")
                  .replace(/-----END PRIVATE KEY-----/, "")
                  .replace(/\s+/g, "");
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
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
  const scope = "https://www.googleapis.com/auth/cloud-platform";
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email, scope, aud: tokenUri,
    iat: now, exp: now + 3600,
  };
  const signingInput = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(claim))}`;

  const key = await crypto.subtle.importKey(
    "pkcs8", pemToPkcs8(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)));
  const jwt = `${signingInput}.${b64url(sig)}`;

  const resp = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${encodeURIComponent(jwt)}`,
  });
  if (!resp.ok) throw new Error(`google token ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const j = await resp.json() as { access_token: string; expires_in: number };
  _tokenCache.set(sa.client_email, { token: j.access_token, exp: now + (j.expires_in || 3600) });
  return j.access_token;
}

// ── WAV → PCM16 ──────────────────────────────────────────────────────────────
// LINEAR16 responses are a WAV container (44-byte header for PCM). Strip it to
// leave raw PCM16 little-endian, matching what cfSpeak() streams.
function stripWav(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 44 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    // find the "data" chunk rather than assuming exactly 44 bytes
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

export interface GoogleTtsReq {
  text: string;
  voice: string;         // e.g. "hi-IN-Wavenet-E"
  languageCode: string;  // e.g. "hi-IN"
  sampleRate?: number;   // default 24000
  speakingRate?: number;
  pitch?: number;
}

/** Synthesize with Cloud TTS and return raw PCM16 @sampleRate mono, or null on any
 *  failure (caller falls back). Never throws. */
export async function googleSynthesizePcm(env: unknown, req: GoogleTtsReq): Promise<Uint8Array | null> {
  try {
    const raw = (env as { GOOGLE_TTS_SA_JSON?: string }).GOOGLE_TTS_SA_JSON;
    if (!raw) return null;
    const sa = JSON.parse(raw) as ServiceAccount;
    if (!sa.client_email || !sa.private_key) return null;
    const token = await accessTokenFor(sa);
    const sr = req.sampleRate || 24000;
    const resp = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text: req.text },
        voice: { languageCode: req.languageCode, name: req.voice },
        audioConfig: {
          audioEncoding: "LINEAR16", sampleRateHertz: sr,
          ...(req.speakingRate != null ? { speakingRate: req.speakingRate } : {}),
          ...(req.pitch != null ? { pitch: req.pitch } : {}),
        },
      }),
    });
    if (!resp.ok) return null;
    const j = await resp.json() as { audioContent?: string };
    if (!j.audioContent) return null;
    const bin = atob(j.audioContent);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const pcm = stripWav(bytes);
    return pcm.length ? pcm : null;
  } catch {
    return null;
  }
}
