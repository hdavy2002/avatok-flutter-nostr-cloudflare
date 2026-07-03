// Hardened API contract (Cloudflare-native; Nostr deprecated). Identity is the
// Clerk user id (uid), verified from the Clerk JWT at the edge via requireUser —
// the caller can only act as themselves. The directory lives in the `users`
// table (uid PK). Public reads (resolve / search / handle/check / communities)
// are unauthenticated and cached upstream.
//
// D1 reads use the Sessions API (one session per DB per request) → nearest
// replica with read-after-write consistency within the request.
import type { Env } from "../types";
import { json, sha256Hex, normalizePhone } from "../util";
import { metaSession } from "../db/shard";
import { requireUser, isFail } from "../authz";
import { verifyClerk } from "../auth";
import { nameFor } from "../lib/identity";
import { brainFact, track } from "../hooks";
import { guardWrite } from "./moderate"; // save-time content validation (Nemotron)
import { readConfig } from "./config"; // P11: profileCompletionGate
import { rateLimit } from "../money"; // abuse limits (Phase 3 hardening)
// R2-F2: avatar nudity moderation (AWS Rekognition DetectModerationLabels; SigV4
// signing reused from ../aws/sigv4 via ../aws/rekognition).
import { rekognitionConfigured, detectModerationLabels, avatarModerationRejected } from "../aws/rekognition";

// ---- push: /api/register /api/call /api/notify /api/call-status ----
export async function register(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as { token?: string; platform?: string };
  if (!b.token) return json({ error: "token required" }, 400);
  const platform = b.platform === "apns" ? "apns" : "fcm";
  const db = metaSession(env);
  await db.prepare(
    "INSERT OR REPLACE INTO push_tokens_v2 (uid, platform, token, updated_at) VALUES (?1,?2,?3,?4)",
  ).bind(ctx.uid, platform, b.token, Date.now()).run();
  const c = await db.prepare("SELECT count(*) AS n FROM push_tokens_v2 WHERE uid=?1").bind(ctx.uid).first<{ n: number }>();
  return json({ ok: true, devices: c?.n ?? 1 });
}

async function tokenCount(db: D1Database | D1DatabaseSession, uid: string): Promise<number> {
  const c = await db.prepare("SELECT count(*) AS n FROM push_tokens_v2 WHERE uid=?1").bind(uid).first<{ n: number }>();
  return c?.n ?? 0;
}

export async function call(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as { to?: string; callId?: string; kind?: string; fromName?: string };
  if (!b.to || !b.callId) return json({ error: "to and callId required" }, 400);
  // Read the callee's device count from the PRIMARY (plain prepare), not an
  // unconstrained replica — avoids a stale 0-token false-404 on a registered device.
  const n = await tokenCount(env.DB_META, b.to);
  if (n === 0) {
    // Visibility: the caller reached someone with 0 registered devices — the
    // exact "no device registered" failure. Emit telemetry (best-effort) keyed
    // on the callee uid so reachability gaps are queryable per-user, then return
    // 404 as before. This path was previously a silent 404 with no analytics.
    try {
      void env.Q_ANALYTICS.send({
        event: "call_no_device", uid: ctx.uid, ts: Date.now(),
        props: {
          to: b.to, call_id: b.callId, call_type: b.kind ?? "audio",
          app_name: "avatok", service_name: "avatok-api", worker: true, account_id: ctx.uid,
        },
      });
      // [MULTIACCT-1] Also emit push_no_device from the PRODUCER side so the
      // zero-token case is symmetrical with the consumer's all-tokens-pruned case
      // (both now surface push_no_device). Reachability queries catch either.
      void env.Q_ANALYTICS.send({
        event: "push_no_device", uid: ctx.uid, ts: Date.now(),
        props: {
          kind: "call", to: b.to, call_id: b.callId, reason: "zero_tokens",
          app_name: "avatok", service_name: "avatok-api", worker: true, account_id: ctx.uid,
        },
      });
    } catch { /* best-effort: telemetry must never block the response */ }
    // [MULTIACCT-1] Distinct machine-readable result so the caller client can show
    // "X is unreachable right now" and SUPPRESS fake ringback instead of ringing
    // into the void. 404 preserved for back-compat; `reachable:false`/`reason` are
    // the new signals the client keys on.
    return json({ error: "callee has no registered devices", reachable: false, reason: "no_device", sent: 0 }, 404);
  }
  // Resolve the caller's real name SERVER-SIDE (Clerk first name → app
  // display_name/handle) instead of trusting the client. The client was sending
  // the raw uid, so the callee's incoming-call screen showed "user_xxx…" / an
  // uid instead of the person's name. Fall back to the client value, then the
  // app name. nameFor is KV-cached, so this adds no per-call DB round-trip.
  const resolved = await nameFor(env, ctx.uid).catch(() => null);
  const clientName = (b.fromName ?? "").trim();
  const resolvedName = resolved || clientName || "AvaTOK";
  const nameSource = resolved ? "resolved" : (clientName ? "client" : "fallback");
  // ── LIVE TAKEOVER ──────────────────────────────────────────────────────────
  // If the caller (ctx.uid) is dialing the EXACT person (b.to) who is, RIGHT NOW,
  // leaving them a message via their AI Receptionist, this isn't a cold call — the
  // owner has reached the person being screened. Signal the active CF receptionist
  // session to bow out ("here's <owner> now, connecting you") and CANCEL the
  // voicemail; the call below then rings through so they connect live. Best-effort:
  // a takeover hiccup must never block placing the call.
  try {
    const sess = await env.DB_META.prepare(
      "SELECT id FROM receptionist_sessions WHERE owner_uid=?1 AND caller_uid=?2 AND status='active' ORDER BY created_at DESC LIMIT 1",
    ).bind(ctx.uid, b.to).first<{ id: string }>();
    if (sess?.id) {
      const stub = env.RECEPTION_ROOM_CF.get(env.RECEPTION_ROOM_CF.idFromName(sess.id));
      await stub.fetch("https://do/takeover", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner_name: resolvedName, call_id: b.callId }),
      }).catch(() => {});
    }
  } catch { /* best-effort — takeover is an enhancement, never block the call */ }
  await env.Q_PUSH.send({ kind: "call", to: b.to, from: ctx.uid, fromName: resolvedName, callId: b.callId, callType: b.kind ?? "audio", ts: Date.now() });
  // Observability: which path produced the caller name (resolved server-side vs
  // the legacy client value vs the generic fallback), plus the call attempt — so
  // the "incoming call shows uid/uid" fix is measurable and call volume/route is
  // visible. Best-effort; telemetry must never block placing a call.
  try {
    void env.Q_ANALYTICS.send({
      event: "call_push_sent", uid: ctx.uid, ts: Date.now(),
      props: {
        // stage:'enqueue' — the push was handed to Q_PUSH here; the true FCM
        // hand-off (fcm_message_id/ok/error) is emitted by the consumer with
        // stage:'fcm_send' (P1). Same event name, disambiguated by `stage`.
        stage: "enqueue",
        to: b.to, call_id: b.callId, call_type: b.kind ?? "audio",
        name_source: nameSource, devices: n,
        app_name: "avatok", service_name: "avatok-api", worker: true, account_id: ctx.uid,
      },
    });
  } catch { /* best-effort */ }
  // AI Ringback (Specs/proposals/PROPOSAL-AI-RINGBACK-TONES.md): hand the CALLER
  // the callee's CURRENT default ringtone so it plays locally during the ring
  // phase. Resolved at dial time so changing the default takes effect next call.
  // Best-effort — a lookup failure must never block placing the call.
  let ringbackUrl = "";
  try {
    const r = await env.DB_META
      .prepare("SELECT url FROM ringtones WHERE account_id=?1 AND is_default=1 LIMIT 1")
      .bind(b.to).first<{ url: string }>();
    ringbackUrl = r?.url ?? "";
  } catch { /* table missing / no default → caller uses the bundled fallback */ }
  // [MULTIACCT-1] `reachable:true` here means only "the callee had ≥1 registered
  // token at dial time" — the AUTHORITATIVE ring outcome is async and arrives via
  // the CallRoom ring-ack (the consumer emits ok=false + push_no_device when every
  // token turns out stale/pruned after a re-login). The client shows ringback on
  // this optimistic result but MUST fall back to "unreachable" when ring-ack ok=false.
  return json({ sent: n, reachable: true, ringbackUrl });
}

export async function notify(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as { to?: string[]; fromName?: string; preview?: string };
  if (!Array.isArray(b.to) || !b.to.length) return json({ error: "to[] required" }, 400);
  // Optional short message PREVIEW so the recipient's banner is readable straight
  // from the shade (WhatsApp-style). The sender's client holds the plaintext and
  // chooses what to reveal; we collapse whitespace and cap length. Omitted → the
  // privacy-safe content-less banner (just the sender name).
  const preview = String(b.preview ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
  let queued = 0;
  for (const uid of b.to.slice(0, 64)) {
    await env.Q_PUSH.send({ kind: "notify", to: uid, fromName: (b.fromName || "AvaTOK").slice(0, 60), preview: preview || undefined, ts: Date.now() });
    queued++;
  }
  return json({ sent: queued });
}

export async function callStatus(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as { to?: string; callId?: string; status?: string };
  if (!b.to || !b.callId || !b.status) return json({ error: "to, callId, status required" }, 400);
  await env.Q_PUSH.send({ kind: "call-status", to: b.to, callId: b.callId, status: b.status, ts: Date.now() });
  return json({ sent: 1 });
}

// ---- directory: /api/profile (auth) /api/resolve /api/search /api/handle/check (public) ----

// Handle = 3–20 chars, lowercase letters/digits/underscore, starts with a letter.
const HANDLE_RE = /^[a-z][a-z0-9_]{2,19}$/;
export function normalizeHandle(h: string): string {
  return (h || "").trim().toLowerCase().replace(/^@/, "");
}

// GET /api/handle/check — DEPRECATED. Handles are retired site-wide
// (Specs/AVATOK-NUMBER-FEATURE-SPEC.md). The network identity is the AvaTOK number;
// search is by number / phone (if public) / email. Kept so old clients get a clear
// signal instead of a 404.
export async function handleCheck(_req: Request, _env: Env): Promise<Response> {
  return json({ deprecated: true, valid: false, available: false, reason: "Handles are retired. Use your AvaTOK number, phone, or email." }, 410);
}

// P11: real-name plausibility via gemini-2.5-flash-lite. Returns {plausible,reason}.
// `ok:false` = the model call itself failed → the caller FAILS CLOSED (a bad public
// profile must not pass just because a model was down). Encodes the policy with
// few-shot examples: fragments/invented/object-innuendo names are implausible;
// legitimately short real names (Al, Bo, Li, Ng, Wu) pass. min length 2.
// Parse the model's JSON verdict → {plausible, reason}; null if unparseable.
function parseNameVerdict(txt: string): { plausible: boolean; reason: string } | null {
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as { plausible?: boolean; reason?: string };
    const plausible = parsed.plausible === true;
    return { plausible, reason: plausible ? "" : (parsed.reason || "Please use your real name — it helps people trust who they're talking to.") };
  } catch { return null; }
}

// Google Generative Language direct (x-goog-api-key). null on ANY failure.
async function geminiDirectVet(key: string, prompt: string): Promise<{ plausible: boolean; reason: string } | null> {
  try {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent",
      { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, maxOutputTokens: 80 } }) },
    );
    if (!r.ok) return null;
    const j = (await r.json()) as any;
    return parseNameVerdict(String(j?.candidates?.[0]?.content?.parts?.[0]?.text ?? ""));
  } catch { return null; }
}

// OpenRouter (Gemini model) fallback — same key/endpoint the guardian + CF
// receptionist use. null on ANY failure.
async function openrouterVet(env: Env, prompt: string): Promise<{ plausible: boolean; reason: string } | null> {
  const key = (env as any).OPENROUTER_API_KEY as string | undefined;
  if (!key) return null;
  const model = (env as any).OPENROUTER_NAME_MODEL || "google/gemini-2.0-flash-001";
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "HTTP-Referer": "https://avatok.ai", "X-Title": "AvaTok Name Check" },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 80, messages: [{ role: "user", content: prompt }] }),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as any;
    return parseNameVerdict(String(j?.choices?.[0]?.message?.content ?? ""));
  } catch { return null; }
}

async function vetRealName(env: Env, first: string, last: string): Promise<{ ok: boolean; plausible: boolean; reason: string; unavailable?: boolean }> {
  const full = `${first} ${last}`.trim();
  if (!full) return { ok: true, plausible: false, reason: "Please enter your first and last name." };
  const prompt =
    "You judge whether a submitted first+last name is a plausible REAL human name for a social app. " +
    "Real names from many cultures can be 2 letters (Al, Bo, Li, Ng, Wu) — judge INTENT, not raw length; min length 2. " +
    "Examples: \"Sat\" -> implausible (fragment). \"Satish\" -> plausible. \"Satisy\" -> implausible (misspelled/invented). " +
    "\"Midnight Rod\", \"Black Stick\" -> implausible (object/innuendo, not a human name). \"Al Wu\" -> plausible. " +
    `Name: "${full}". Respond with ONLY JSON: {"plausible": <true|false>, "reason": "<short kind sentence, only when implausible>"}.`;
  // Provider chain: primary Gemini key → the RECEPTIONIST's Gemini key (the one
  // Gemini Live uses) → OpenRouter (Gemini). First provider that answers wins.
  // FAIL OPEN only if EVERY provider is unreachable — never block a real user on an
  // AI outage / depleted key; `unavailable:true` still logs profile_vet_error.
  const keys = [(env as any).GEMINI_API_KEY, (env as any).RECEPTIONIST_GEMINI_API_KEY]
    .filter((k, i, a): k is string => !!k && a.indexOf(k) === i);
  for (const key of keys) {
    const out = await geminiDirectVet(key, prompt);
    if (out) return { ok: true, plausible: out.plausible, reason: out.reason };
  }
  const orOut = await openrouterVet(env, prompt);
  if (orOut) return { ok: true, plausible: orOut.plausible, reason: orOut.reason };
  return { ok: true, plausible: true, reason: "", unavailable: true }; // all providers down → fail open
}

export async function profileUpsert(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as {
    name?: string; first_name?: string; last_name?: string; email?: string; phone?: string;
    account_kind?: string; avatar_url?: string; birth_year?: number; bio?: string; gender?: string;
  };
  // Optional self-description — AvaBrain learns from it. Capped + trimmed; an
  // explicit empty string clears it, undefined leaves it unchanged.
  const bio = b.bio === undefined ? null : String(b.bio).trim().slice(0, 600);
  // Gender (profile) — drives the receptionist's pronouns ("a message for him/her/
  // them"). Allow-list only; undefined leaves it unchanged.
  const gender = b.gender === undefined ? null
    : (["male", "female", "other"].includes(String(b.gender)) ? String(b.gender) : null);
  // Optional birth year — powers coarse age-group analytics only (13+); never shown publicly.
  let birthYear: number | null = null;
  if (b.birth_year !== undefined && b.birth_year !== null && b.birth_year !== 0) {
    const y = Math.trunc(Number(b.birth_year));
    if (!(y >= 1900 && y <= new Date().getFullYear() - 13)) return json({ error: "invalid_birth_year" }, 400);
    birthYear = y;
  }
  // Handles are retired site-wide — names power the directory + contact card.
  const firstName = b.first_name === undefined ? null : (String(b.first_name).trim().slice(0, 60) || null);
  const lastName = b.last_name === undefined ? null : (String(b.last_name).trim().slice(0, 60) || null);
  const assembled = [firstName, lastName].filter(Boolean).join(" ").trim();
  const name = ((b.name || "").trim() || assembled) || null;
  const avatarUrl = typeof b.avatar_url === "string" ? b.avatar_url.trim() : null;
  const email = (b.email || "").trim().toLowerCase();
  const emailHash = email ? await sha256Hex(email) : null;
  const phoneHash = b.phone ? await sha256Hex(normalizePhone(b.phone)) : null;
  const now = Date.now();
  const db = metaSession(env);
  // Save-time content validation (Nemotron): block an abusive name/bio before it's
  // persisted and shown in the directory.
  const blocked = await guardWrite(req, env, ctx.uid, "profile", [
    { text: name, field: "name" },
    { text: firstName, field: "first_name" },
    { text: lastName, field: "last_name" },
    { text: bio, field: "bio" },
  ]);
  if (blocked) return blocked;

  // P11: mandatory + AI-vetted profile (behind profileCompletionGate; dark until
  // launch). Runs while the client shows a hold state. Completeness THEN real-name
  // plausibility. Phone is the ONLY optional field. FAIL CLOSED on model outage.
  let gateOn = false;
  try { gateOn = (await readConfig(env)).profileCompletionGate === true; } catch { gateOn = false; }
  if (gateOn) {
    track(env, ctx.uid, "profile_vet_started", "profile", {});
    // Completeness: photo, first, last, birth year, gender, About all required.
    const missing: string[] = [];
    if (!avatarUrl) missing.push("photo");
    if (!firstName) missing.push("first_name");
    if (!lastName) missing.push("last_name");
    if (!birthYear) missing.push("birth_year");
    if (!gender) missing.push("gender");
    if (!bio) missing.push("about");
    if (missing.length) {
      track(env, ctx.uid, "profile_vet_rejected", "profile", { reason_class: "incomplete", field: missing[0] });
      return json({ error: "profile_incomplete", missing, message: "Please complete every field (only your phone number is optional)." }, 400);
    }
    // Real-name plausibility (gemini-2.5-flash-lite). FAIL OPEN: if the model is
    // unavailable we log it but let the save through (never block a real user on an
    // AI outage / depleted key); we only reject when the model actively says the
    // name is implausible.
    const nm = await vetRealName(env, firstName!, lastName!);
    if (nm.unavailable) {
      track(env, ctx.uid, "profile_vet_error", "profile", { stage: "realname_model" });
    }
    if (!nm.plausible) {
      track(env, ctx.uid, "profile_vet_rejected", "profile", { reason_class: "realname", field: "first_name" });
      return json({ error: "implausible_name", field: "first_name", message: nm.reason }, 400);
    }
    // Avatar nudity moderation (Rekognition DetectModerationLabels). Only run on a
    // NEW/changed photo (skip re-moderating an unchanged avatar on later saves) and
    // only when creds are configured. INTENT: reject on a positive sexual-nudity
    // detection; FAIL OPEN on a transient Rekognition/infra error so a flaky API
    // never bricks signup (mirrors the deepfake-check best-effort fetch pattern).
    if (avatarUrl && rekognitionConfigured(env)) {
      let changed = true;
      try {
        const prev = await db.prepare("SELECT avatar_url FROM users WHERE uid=?1").bind(ctx.uid).first<{ avatar_url: string | null }>();
        changed = (prev?.avatar_url ?? "") !== avatarUrl;
      } catch { changed = true; }
      if (changed) {
        try {
          const res = await fetch(avatarUrl);
          if (res.ok) {
            const bytes = new Uint8Array(await res.arrayBuffer());
            const mod = await detectModerationLabels(env, bytes);
            const verdict = avatarModerationRejected(mod.ModerationLabels);
            if (verdict.rejected) {
              track(env, ctx.uid, "profile_vet_rejected", "profile", { reason_class: "photo", field: "photo", label: verdict.label });
              return json({ error: "profile_vet_rejected", field: "photo", message: "That photo didn't pass our check — please choose another." }, 400);
            }
          }
          // A non-OK fetch or empty labels → allow (fail open on infra issues).
        } catch {
          // Transient Rekognition/network error → allow the save (fail open).
          track(env, ctx.uid, "profile_vet_error", "profile", { stage: "photo_moderation" });
        }
      }
    }
    track(env, ctx.uid, "profile_vet_passed", "profile", {});
  }

  await db.prepare(
    `INSERT INTO users (uid, display_name, first_name, last_name, avatar_url, email_hash, phone_hash, birth_year, bio, gender, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?10,?11,?9,?9)
     ON CONFLICT(uid) DO UPDATE SET
       display_name=COALESCE(?2,display_name), first_name=COALESCE(?3,first_name), last_name=COALESCE(?4,last_name),
       avatar_url=COALESCE(?5,avatar_url), email_hash=COALESCE(?6,email_hash),
       phone_hash=COALESCE(?7,phone_hash), birth_year=COALESCE(?8,birth_year),
       bio=COALESCE(?10,bio), gender=COALESCE(?11,gender), updated_at=?9`,
  ).bind(ctx.uid, name, firstName, lastName, avatarUrl, emailHash, phoneHash, birthYear, now, bio, gender).run();
  // Feed a non-empty self-description to AvaBrain so Ava can personalise. Scoped
  // 'private'; the brain consumer still honours the user's AvaBrain consent toggle.
  if (bio) brainFact(env, ctx.uid, "profile_bio", "profile", { bio }, "private");
  // P11: feed the profile summary so the receptionist + AvaBrain know their owner
  // (name, gender→pronouns, About). Scoped private; the brain consumer still honours
  // the AvaBrain consent toggle.
  brainFact(env, ctx.uid, "profile_updated", "profile", {
    name, first_name: firstName, last_name: lastName, gender, birth_year: birthYear,
    ...(bio ? { about: bio } : {}),
  }, "private");
  return json({ ok: true, profile: { uid: ctx.uid, name, first_name: firstName, last_name: lastName, email: b.email || "", phone: b.phone || "" } });
}

// GET /api/me — restore endpoint. Authenticated by the Clerk JWT. Looks the
// account up by uid and returns the public profile so a fresh install rehydrates.
export async function me(req: Request, env: Env): Promise<Response> {
  const clerk = await verifyClerk(env, req.headers.get("authorization"));
  if ("skipped" in clerk) return json({ found: false, clerk_enabled: false });
  if ("error" in clerk) return json({ error: "clerk: " + clerk.error }, 401);
  const uid = clerk.clerkUserId;
  const prof = await metaSession(env).prepare(
    "SELECT display_name, first_name, last_name, avatar_url, birth_year, bio, gender, avatok_number, avatok_number_display, phone_discoverable, email_discoverable, who_can_add, share_token FROM users WHERE uid=?1",
  ).bind(uid).first<any>();
  if (!prof) return json({ found: false, clerk_enabled: true, uid });
  // P11: completeness = photo + first + last + birth year + gender + About (phone
  // is the only optional field). The client routes an incomplete profile to the
  // Profile screen before the app when profileCompletionGate is ON.
  const profileComplete = !!(prof.avatar_url && prof.first_name && prof.last_name
    && prof.birth_year && prof.gender && prof.bio);
  return json({
    found: true, clerk_enabled: true, uid,
    display_name: prof.display_name ?? null, first_name: prof.first_name ?? null, last_name: prof.last_name ?? null,
    avatar_url: prof.avatar_url ?? null, birth_year: prof.birth_year ?? null, bio: prof.bio ?? null,
    gender: prof.gender ?? null, profile_complete: profileComplete,
    avatok_number: prof.avatok_number ?? null, avatok_number_display: prof.avatok_number_display ?? null,
    phone_discoverable: !!prof.phone_discoverable, email_discoverable: prof.email_discoverable !== 0,
    who_can_add: prof.who_can_add ?? "everyone", share_token: prof.share_token ?? null,
  });
}

// ---- encrypted per-user vault: /api/vault (auth) — uid-keyed opaque blobs ----
const VAULT_KINDS = new Set(["contacts", "settings", "apps"]);
const VAULT_MAX = 600_000;

export async function vaultPut(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  // Abuse limit (Phase 3): cap vault writes per account + per source IP. Generous
  // for legit sync (contacts/settings/apps blobs), tight enough to stop scripted abuse.
  const ip = req.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const rlU = await rateLimit(env, `vault_put:${ctx.uid}`, 120, 3600);
  if (rlU) return rlU;
  const rlI = await rateLimit(env, `vault_put_ip:${ip}`, 600, 3600);
  if (rlI) return rlI;
  const b = (await req.json().catch(() => ({}))) as { kind?: string; blob?: string };
  const kind = (b.kind || "").trim().toLowerCase();
  const blob = typeof b.blob === "string" ? b.blob : "";
  if (!VAULT_KINDS.has(kind)) return json({ error: "bad kind" }, 400);
  if (!blob || blob.length > VAULT_MAX) return json({ error: "blob missing or too large" }, 400);
  await metaSession(env).prepare(
    `INSERT INTO user_vault (uid, kind, blob, updated_at) VALUES (?1,?2,?3,?4)
     ON CONFLICT(uid, kind) DO UPDATE SET blob=?3, updated_at=?4`,
  ).bind(ctx.uid, kind, blob, Date.now()).run();
  return json({ ok: true });
}

export async function vaultGet(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const rlU = await rateLimit(env, `vault_get:${ctx.uid}`, 600, 3600);
  if (rlU) return rlU;
  const kind = (new URL(req.url).searchParams.get("kind") || "").trim().toLowerCase();
  if (!VAULT_KINDS.has(kind)) return json({ error: "bad kind" }, 400);
  const r = await metaSession(env).prepare(
    "SELECT blob, updated_at FROM user_vault WHERE uid=?1 AND kind=?2",
  ).bind(ctx.uid, kind).first<{ blob: string; updated_at: number }>();
  return json({ blob: r?.blob ?? null, updated_at: r?.updated_at ?? 0 });
}

function profOut(r: any) {
  return r ? { uid: r.uid, name: r.display_name, first_name: r.first_name ?? null, last_name: r.last_name ?? null, avatar_url: r.avatar_url, number: r.avatok_number_display ?? null } : null;
}

// Resolve a query → uid + profile. Handles are retired; the network keys are the
// AvaTOK number (exact), the real phone (exact, only if the owner made it public),
// and email (exact, only if the owner allows email discovery).
// Read-through KV cache for the people-directory (resolve + search). Popular
// queries (an influencer/business searched thousands of times) return from edge
// KV instead of hitting D1. Keyed by a hash of the endpoint+query so raw emails/
// numbers never sit in KV as plaintext keys. TTL is MODERATE (30 min) so results
// stay fresh and a discoverability change self-heals fast; empty/not-found are
// cached only briefly so a just-joined user appears quickly and number probes are
// cheap. Reuses the TOKENS namespace under a `srch:` prefix (TTL auto-evicts).
export async function withSearchCache(req: Request, env: Env, handler: () => Promise<Response>): Promise<Response> {
  const q = (new URL(req.url).searchParams.get("q") || "").trim();
  if (q.length < 2) return handler();
  const kv = (env as any).TOKENS;
  const path = new URL(req.url).pathname;
  let ck = "";
  try { ck = "srch:" + (await sha256Hex(path + "|" + q.toLowerCase())); } catch { return handler(); }
  try {
    const hit = await kv?.get(ck);
    if (hit != null) return new Response(hit, { status: 200, headers: { "content-type": "application/json", "x-cache": "HIT" } });
  } catch { /* cache read best-effort */ }
  const res = await handler();
  try {
    if (res.status === 200) {
      const body = await res.clone().text();
      // Empty/not-found → short TTL so new users show up fast + probes stay cheap.
      const empty = body.includes('"results":[]') || body.includes('"uid":null');
      await kv?.put(ck, body, { expirationTtl: empty ? 60 : 1800 });
    }
  } catch { /* cache write best-effort */ }
  return res;
}

export async function resolve(req: Request, env: Env): Promise<Response> {
  const q = (new URL(req.url).searchParams.get("q") || "").trim();
  if (!q) return json({ error: "q required" }, 400);
  const db = metaSession(env);
  const fetchProf = (uid: string) => db.prepare("SELECT uid,display_name,first_name,last_name,avatar_url,avatok_number_display FROM users WHERE uid=?1").bind(uid).first();

  if (q.startsWith("user_")) return json({ uid: q, profile: profOut(await fetchProf(q)) });
  if (q.includes("@") && q.includes(".")) {
    const r = await db.prepare("SELECT uid FROM users WHERE email_hash=?1 AND email_discoverable<>0 ORDER BY updated_at DESC LIMIT 1").bind(await sha256Hex(q.toLowerCase())).first<{ uid: string }>();
    if (!r) return json({ uid: null }, 404);
    return json({ uid: r.uid, profile: profOut(await fetchProf(r.uid)) });
  }
  const digits = q.replace(/[^0-9]/g, "");
  if (digits.length >= 6) {
    // 1) exact AvaTOK number (canonical E.164 digits). ALSO match a user's
    // EXPLICITLY-exposed private number (show_private_number=1) so dialing it on
    // the AvaTOK dialpad rings their app (owner request 2026-06-29). This is
    // OPT-IN only — a private phone never resolves by default (the 2026-06-27
    // privacy rule still holds for everyone who hasn't turned it on). Guarded:
    // falls back to the AvaTOK-only query if the columns aren't migrated yet, so
    // a deploy-before-migration can NEVER break dialing.
    // Format-tolerant + INDEXED. People type numbers with/without '+', country
    // code and separators. avatok_number (canonical digits) and number_norm (last
    // 10 digits) are BOTH indexed, so "+13022202211", "13022202211" and
    // "3022202211" all resolve via an index lookup — no table scan.
    const suffix = digits.slice(-10);
    let byNum = await db.prepare(
      "SELECT uid FROM users WHERE avatok_number=?1 OR number_norm=?2 ORDER BY (avatok_number=?1) DESC LIMIT 1",
    ).bind(digits, suffix).first<{ uid: string }>();
    if (!byNum) {
      // Opt-in private number (rare) — guarded in case the columns predate migration.
      try {
        byNum = await db.prepare("SELECT uid FROM users WHERE show_private_number=1 AND private_number=?1 LIMIT 1").bind(digits).first<{ uid: string }>();
      } catch { /* columns may not exist */ }
    }
    if (byNum) return json({ uid: byNum.uid, profile: profOut(await fetchProf(byNum.uid)) });
  }
  return json({ uid: null }, 404);
}

// People discovery by name / bio (prefix + substring LIKE). No handle. Users who
// set "who can add me = nobody" are excluded from discovery.
//
// DISCOVERY IS EXACT-KEY ONLY (owner decision 2026-07-01): email (via /api/resolve)
// and AvaTOK number. NAME SEARCH IS INTENTIONALLY REMOVED — at millions of users a
// name matches thousands of people (useless), and name matching is a scan/cost with
// no product value. So this endpoint only resolves an AvaTOK NUMBER; a non-numeric
// query returns nothing.
export async function search(req: Request, env: Env): Promise<Response> {
  const raw = (new URL(req.url).searchParams.get("q") || "").trim();
  if (raw.length < 2) return json({ results: [] });
  const db = metaSession(env);
  const shape = (r: any) => ({ uid: r.uid, name: r.display_name, first_name: r.first_name ?? null, last_name: r.last_name ?? null, avatar_url: r.avatar_url, number: r.avatok_number_display ?? null, bio: r.bio ?? null });

  // AvaTOK-number lookup — format-tolerant + INDEXED (avatok_number exact OR
  // number_norm last-10). "+13022202211", "13022202211", "3022202211" all resolve.
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length >= 6 && /^[+0-9\s()\-]+$/.test(raw)) {
    const suffix = digits.slice(-10);
    const nr = await db.prepare(
      `SELECT uid, display_name, first_name, last_name, avatar_url, bio, avatok_number_display FROM users
         WHERE (who_can_add IS NULL OR who_can_add<>'nobody')
           AND (avatok_number=?1 OR number_norm=?2)
         ORDER BY (avatok_number=?1) DESC LIMIT 10`,
    ).bind(digits, suffix).all();
    return json({ results: (nr.results ?? []).map(shape) });
  }

  // Not a number → no directory results (name search removed by design).
  return json({ results: [] });
}

// ---- contacts: /api/contacts/sync /api/contacts/match (auth) /list ----
// PRIVACY (owner decision 2026-06-27): contact "presence" matching is DISABLED.
// These endpoints previously took a batch of the user's phone-book numbers/emails
// and returned which ones map to AvaTOK accounts (uid) — a presence oracle that
// let anyone confirm a private phone belongs to an AvaTOK user and correlate it
// to their identity (the phone branch wasn't even gated by phone_discoverable).
// They now intentionally return NOTHING regardless of the request body, so even a
// modified client cannot probe. Discovery is allowed ONLY via the exact,
// owner-controlled keys in `resolve` (AvaTOK number, or email when the owner
// enabled email discovery). The phone book stays on-device, used solely for the
// user's own invites.
export async function contactsSync(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  return json({ stored: 0, matched: [] });
}

export async function contactsMatch(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  return json({ matched: [] });
}

export function contactsList(): Response {
  return json({ updated: 0, contacts: [] });
}

// ---- communities: /api/community /api/community/join (auth) /communities (public) ----
export async function communityUpsert(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.name) return json({ error: "name required" }, 400);
  const owner = ctx.uid;
  const id = String(b.id || crypto.randomUUID());
  const now = Date.now();
  const db = metaSession(env);
  await db.prepare(
    `INSERT INTO communities (id, name, description, avatar_url, owner_uid, created_at)
     VALUES (?1,?2,?3,NULL,?4,?5) ON CONFLICT(id) DO UPDATE SET name=?2, description=?3`,
  ).bind(id, String(b.name).trim(), String(b.about || "").trim(), owner, now).run();
  const members: string[] = Array.from(new Set([owner, ...((b.members) || [])]));
  for (const m of members) {
    await db.prepare("INSERT OR IGNORE INTO community_members (community_id, uid, role, joined_at) VALUES (?1,?2,?3,?4)")
      .bind(id, m, m === owner ? "owner" : "member", now).run();
  }
  return json({ ok: true, community: await communityObj(db, id) });
}

export async function communityJoin(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as { id?: string };
  if (!b.id) return json({ error: "id required" }, 400);
  const db = metaSession(env);
  const exists = await db.prepare("SELECT 1 FROM communities WHERE id=?1").bind(b.id).first();
  if (!exists) return json({ error: "not found" }, 404);
  await db.prepare("INSERT OR IGNORE INTO community_members (community_id, uid, role, joined_at) VALUES (?1,?2,'member',?3)")
    .bind(b.id, ctx.uid, Date.now()).run();
  return json({ ok: true, community: await communityObj(db, b.id) });
}

async function communityObj(db: D1DatabaseSession, id: string): Promise<any> {
  const c = await db.prepare("SELECT id,name,description,owner_uid,created_at FROM communities WHERE id=?1").bind(id).first<any>();
  if (!c) return null;
  const m = await db.prepare("SELECT uid FROM community_members WHERE community_id=?1").bind(id).all();
  return { id: c.id, name: c.name, about: c.description, owner: c.owner_uid, created: c.created_at, members: (m.results ?? []).map((x: any) => x.uid), groups: [] };
}

export async function communities(req: Request, env: Env): Promise<Response> {
  const sp = new URL(req.url).searchParams;
  const db = metaSession(env);
  const id = sp.get("id");
  if (id) { const c = await communityObj(db, id); return c ? json({ community: c }) : json({ error: "not found" }, 404); }
  const member = (sp.get("member") || "").trim();
  if (!member) return json({ communities: [] });
  const ids = await db.prepare("SELECT community_id FROM community_members WHERE uid=?1 LIMIT 100").bind(member).all();
  const out: any[] = [];
  for (const r of (ids.results ?? []) as any[]) { const c = await communityObj(db, r.community_id); if (c) out.push(c); }
  return json({ communities: out });
}

// ---- backup: deprecated with the relay. Message history now lives in InboxDO;
// a uid-scoped export will be re-added off the InboxDO sync log if needed. ----
export async function backup(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  return json({ error: "backup deprecated — relay removed; history lives in your InboxDO" }, 501);
}
