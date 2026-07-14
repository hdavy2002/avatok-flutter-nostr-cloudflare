// [AVA-MISSEDCALL-1] Device-token lane for the Truecaller-style missed-call overlay.
//
// The overlay's native PHONE_STATE receiver runs with the Flutter engine DEAD (the app
// may be swiped off), so it has no Clerk JWT to authenticate a live membership lookup.
// Instead the app mints a long-lived, HMAC-signed DEVICE TOKEN (Clerk-authed, below) and
// stores it where native can read it; the receiver then calls /api/missedcall/lookup with
// that token on a background thread to light the AvaTOK icon even cold-start.
//
// The token is stateless (payload {u:uid, exp} + HMAC) — mirrors the join-link token in
// cal/ics.ts. Revoke everything by rotating MISSEDCALL_TOKEN_SECRET. Both routes are gated
// by the `missedCallOverlay` flag, so the whole lane is DARK until the feature is on.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { readConfig } from "./config";
import { matchAvatokPhones } from "./api";

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const b64u = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s: string): Uint8Array => {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
};

function secret(env: Env): string {
  return env.MISSEDCALL_TOKEN_SECRET || env.JOIN_LINK_SECRET || "dev-missedcall-secret";
}

async function hmac(key: string, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
}

async function signToken(env: Env, uid: string, expMs: number): Promise<string> {
  const payload = b64u(new TextEncoder().encode(JSON.stringify({ u: uid, exp: expMs })));
  return `${payload}.${b64u(await hmac(secret(env), payload))}`;
}

async function verifyToken(env: Env, token: string): Promise<string | null> {
  const [payload, sig] = (token || "").split(".");
  if (!payload || !sig) return null;
  const expect = b64u(await hmac(secret(env), payload));
  // Constant-time-ish: lengths equal + string compare (tokens are short, low risk).
  if (expect.length !== sig.length || expect !== sig) return null;
  try {
    const j = JSON.parse(new TextDecoder().decode(fromB64u(payload))) as { u: string; exp: number };
    if (!j.u || !j.exp || Date.now() > j.exp) return null;
    return j.u;
  } catch {
    return null;
  }
}

/** POST /api/missedcall/token — Clerk-auth. Mints a 30-day device token for this user. */
export async function missedCallToken(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const cfg = await readConfig(env);
  if (!cfg.missedCallOverlay) return json({ error: "disabled" }, 403);
  const exp = Date.now() + TOKEN_TTL_MS;
  const token = await signToken(env, ctx.uid, exp);
  return json({ token, exp });
}

/**
 * POST /api/missedcall/lookup — DEVICE-TOKEN auth (no Clerk). Body:
 * { token, numbers?[], hashes?[] } → { matched:[{hash,uid,name,avatar_url,avatok_number}] }.
 * This is the endpoint the native receiver calls while the app is dead.
 */
export async function missedCallLookup(req: Request, env: Env): Promise<Response> {
  const cfg = await readConfig(env);
  if (!cfg.missedCallOverlay) return json({ matched: [] });
  const b = (await req.json().catch(() => ({}))) as {
    token?: string;
    hashes?: unknown;
    numbers?: unknown;
  };
  const uid = await verifyToken(env, b.token || "");
  if (!uid) return json({ error: "bad token" }, 401);
  return json({ matched: await matchAvatokPhones(env, b) });
}
