// Ava tool layer (Phase 5 — Tool Layer: Strata + Broker + MCP connect).
//   GET/POST /api/ava/tools/<subpath>
//
// This route is the BROKER + PROXY in front of a self-hosted Klavis Strata MCP
// gateway. It exists to solve TOOL OVERLOAD: Ava only ever sees a small core
// toolset (registered client-side in ava_tools/core_tools.dart) plus *on-demand*
// discovery — never a full catalog. Strata's progressive-disclosure flow is:
//
//   discover_categories  → get_category_actions → get_action_details → execute_action
//
// plus handle_auth_failure for per-user OAuth (the user connects their OWN
// Gmail/Drive/etc.; tokens are user-scoped, encrypted, never shared).
//
// Contract (Phase 0 wired this exact name in index.ts):
//   if (p.startsWith("/api/ava/tools/"))
//     return await avaTools(req, env, p.slice("/api/ava/tools/".length));
//   → export `avaTools(req, env, subpath)`  (3rd arg = path AFTER the prefix).
//
// While STRATA_URL is empty (the placeholder shipped in wrangler.toml) every
// op 503s "tools unavailable" — the self-host origin must be configured first.
//
// Auth: dual-auth via requireUser (Clerk JWT). uid comes from the verified
// token, never the body — so a user can only discover/execute/connect as
// themselves.
//
// OAuth token storage: AES-GCM encrypted, per-uid, per-provider, in a D1 table
// (DB_META.ava_tool_tokens). Mirrors the gcal_accounts encryption pattern
// (cal/gcal.ts) — key material from STRATA_TOKEN_KEY (falls back to
// GCAL_TOKEN_KEY, then a dev constant) so we never persist a raw token.

import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb } from "../db/shard";

// ---------------------------------------------------------------------------
// The 5 Strata progressive-disclosure ops + the auth helper. Surfaced as the
// allow-listed subpaths under /api/ava/tools/. Anything else → 404.
// ---------------------------------------------------------------------------
const STRATA_OPS = new Set<string>([
  "discover_categories",     // discover_server_categories_or_actions
  "get_category_actions",
  "get_action_details",
  "execute_action",
  "handle_auth_failure",
]);

// ---------------------------------------------------------------------------
// Free-bundled vs subscription connectors. Free-bundled run without a wallet
// check; everything else requires an entitled (premium) account before
// execute_action. The CLIENT mirrors this list (core_tools.dart / mcp_connect)
// for the PaidBadge — this server copy is the authoritative backstop.
//
// Provider id = the Strata server/connector name (lowercased). Tune as the
// self-hosted Strata registry evolves; unknown providers default to PAID
// (fail-safe: never give away a metered connector by omission).
// ---------------------------------------------------------------------------
const FREE_BUNDLED = new Set<string>([
  // AvaVerse-native, no per-call SaaS cost → bundled free.
  "brain",       // brain.search (P4) — also a core tool
  "translate",   // core tool
  "schedule",    // AvaCalendar/AvaBooking — core tool
  "send_to",     // post into an AvaTOK conversation — core tool
]);

function isFreeBundled(provider: string | undefined | null): boolean {
  if (!provider) return false;
  return FREE_BUNDLED.has(String(provider).toLowerCase());
}

// ---------------------------------------------------------------------------
// Token crypto — AES-GCM, key SHA-256-derived from STRATA_TOKEN_KEY (mirrors
// cal/gcal.ts encToken/decToken so the codebase has ONE crypto shape).
// ---------------------------------------------------------------------------
function tokenKeyMaterial(env: Env): string {
  return (env as any).STRATA_TOKEN_KEY || env.GCAL_TOKEN_KEY || "dev-strata-key";
}
async function aesKey(env: Env): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tokenKeyMaterial(env)));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function enc(env: Env, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), new TextEncoder().encode(plain)));
  const all = new Uint8Array(iv.length + ct.length); all.set(iv); all.set(ct, 12);
  return btoa(String.fromCharCode(...all));
}
async function dec(env: Env, b64: string): Promise<string> {
  const all = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, await aesKey(env), all.slice(12));
  return new TextDecoder().decode(pt);
}

// ---------------------------------------------------------------------------
// Per-user OAuth token store (D1). Lazily creates the table so no migration is
// required (mirrors how the on-device index self-creates its tables). Tokens
// are encrypted at rest and scoped (user_id, provider) — never shared across
// accounts.
// ---------------------------------------------------------------------------
let _ensured = false;
async function ensureTable(env: Env): Promise<void> {
  if (_ensured) return;
  await metaDb(env).prepare(
    `CREATE TABLE IF NOT EXISTS ava_tool_tokens (
       user_id     TEXT NOT NULL,
       provider    TEXT NOT NULL,
       token_enc   TEXT NOT NULL,
       connected_at INTEGER NOT NULL,
       PRIMARY KEY (user_id, provider)
     )`,
  ).run();
  _ensured = true;
}

async function saveToken(env: Env, uid: string, provider: string, token: string): Promise<void> {
  await ensureTable(env);
  await metaDb(env).prepare(
    `INSERT INTO ava_tool_tokens (user_id, provider, token_enc, connected_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(user_id, provider) DO UPDATE SET token_enc=?3, connected_at=?4`,
  ).bind(uid, provider, await enc(env, token), Date.now()).run();
}

async function loadToken(env: Env, uid: string, provider: string): Promise<string | null> {
  await ensureTable(env);
  const row = await metaDb(env).prepare(
    "SELECT token_enc FROM ava_tool_tokens WHERE user_id=?1 AND provider=?2",
  ).bind(uid, provider).first<{ token_enc: string }>();
  if (!row) return null;
  try { return await dec(env, row.token_enc); } catch { return null; }
}

/** Providers (connectors) the user has connected — names only, never tokens. */
async function listConnected(env: Env, uid: string): Promise<string[]> {
  await ensureTable(env);
  const rs = await metaDb(env).prepare(
    "SELECT provider FROM ava_tool_tokens WHERE user_id=?1 ORDER BY connected_at DESC",
  ).bind(uid).all<{ provider: string }>();
  return (rs.results ?? []).map((r) => r.provider);
}

async function deleteToken(env: Env, uid: string, provider: string): Promise<void> {
  await ensureTable(env);
  await metaDb(env).prepare("DELETE FROM ava_tool_tokens WHERE user_id=?1 AND provider=?2").bind(uid, provider).run();
}

// ---------------------------------------------------------------------------
// Strata proxy. Forwards a progressive-disclosure op to the self-hosted Strata
// gateway, injecting the per-user OAuth token (if any) for the target provider.
// Strata is a standard MCP gateway; we POST {op, args} to STRATA_URL and attach
// the user's connection map so Strata can act on the user's behalf. The exact
// Strata request shape is encapsulated here so the rest of the codebase (and
// the client) never depends on it.
// ---------------------------------------------------------------------------
async function callStrata(
  env: Env,
  uid: string,
  op: string,
  args: Record<string, unknown>,
  userToken: string | null,
): Promise<Response> {
  const base = (env.STRATA_URL || "").replace(/\/+$/, "");
  const url = `${base}/mcp/${op}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    // Tenant isolation: Strata scopes its per-user connection store by this id.
    "x-strata-user": uid,
  };
  // The provider OAuth token, if we hold one, is passed for Strata to use when
  // the op executes against that provider (kept out of any body-logging path).
  if (userToken) headers["x-strata-provider-token"] = userToken;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ op, args, user: uid }),
  });
  // Pass Strata's JSON through verbatim (status + body) so progressive-
  // disclosure responses (categories / actions / schemas / results) reach the
  // client untouched. Wrap non-JSON in a generic envelope.
  const text = await res.text();
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { payload = { ok: res.ok, raw: text }; }
  return json(payload, res.ok ? 200 : res.status);
}

// ---------------------------------------------------------------------------
// avaTools — the registered entry point. `subpath` is the path AFTER
// /api/ava/tools/ (Phase-0 contract). Recognised subpaths:
//
//   POST discover_categories        (Strata)
//   POST get_category_actions       (Strata)
//   POST get_action_details         (Strata)
//   POST execute_action             (Strata; free/sub gate enforced first)
//   POST handle_auth_failure        (Strata → returns an OAuth connect URL)
//   GET  connections                (list this user's connected providers)
//   POST connections/save           (store a per-user OAuth token, encrypted)
//   DELETE connections/<provider>   (disconnect a provider)
// ---------------------------------------------------------------------------
export async function avaTools(req: Request, env: Env, subpath: string): Promise<Response> {
  // Auth first — uid is the verified Clerk sub (never the body).
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = ctx.uid;

  // 503 while the self-host origin is unset (Phase-0 placeholder). EVERY op is
  // gated by this — the tool layer is structurally unavailable until configured.
  if (!env.STRATA_URL) return json({ error: "tools unavailable", reason: "strata_unconfigured" }, 503);

  const path = subpath.replace(/^\/+/, "");

  // ---- Connection management (our own store; not proxied to Strata) --------
  if (path === "connections") {
    if (req.method === "GET") {
      return json({ connected: await listConnected(env, uid) });
    }
    return json({ error: "method not allowed" }, 405);
  }
  if (path === "connections/save" && req.method === "POST") {
    let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const provider = String(b.provider ?? "").trim().toLowerCase();
    const token = String(b.token ?? "");
    if (!provider || !token) return json({ error: "provider and token required" }, 400);
    await saveToken(env, uid, provider, token);
    return json({ ok: true, provider });
  }
  if (path.startsWith("connections/") && req.method === "DELETE") {
    const provider = path.slice("connections/".length).toLowerCase();
    if (!provider) return json({ error: "provider required" }, 400);
    await deleteToken(env, uid, provider);
    return json({ ok: true, provider });
  }

  // ---- Strata progressive-disclosure ops -----------------------------------
  if (!STRATA_OPS.has(path)) return json({ error: "unknown tool op" }, 404);
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: any; try { body = await req.json(); } catch { body = {}; }
  const args: Record<string, unknown> = (body && typeof body === "object" ? body : {}) as any;
  // Provider/connector the op targets (used for token lookup + the free/sub gate).
  const provider = (args.provider ?? args.server ?? args.connector ?? null) as string | null;

  // Free-bundled vs subscription enforcement — ONLY before execute_action.
  // Discovery ops are always free (so Ava can browse what's possible); only the
  // actual side-effecting call is gated.
  if (path === "execute_action" && !isFreeBundled(provider)) {
    const entitled = await isEntitled(env, uid);
    if (!entitled) {
      return json({
        error: "subscription required",
        reason: "paid_tool",
        provider: provider ?? undefined,
        // The client opens the PaidFeature top-up sheet on this reason.
      }, 402);
    }
  }

  // For handle_auth_failure we do NOT have a token yet (that's the point — it
  // returns a connect URL). For other ops, inject the user's stored token.
  const userToken = (provider && path !== "handle_auth_failure")
    ? await loadToken(env, uid, provider)
    : null;

  try {
    return await callStrata(env, uid, path, args, userToken);
  } catch (e: any) {
    return json({ error: "strata unavailable", detail: String(e?.message ?? e) }, 502);
  }
}

// ---------------------------------------------------------------------------
// Entitlement check for subscription tools. The real wallet/subscription
// authority lands with the wallet phase; today we treat "has a non-empty
// wallet / premium flag" as entitled. To avoid a hard dependency on an unbuilt
// surface, this returns false by default (fail-safe: paid connectors require an
// explicit premium signal). The wallet phase replaces the body with a real
// balance/subscription check; the signature stays stable.
// ---------------------------------------------------------------------------
async function isEntitled(_env: Env, _uid: string): Promise<boolean> {
  // TODO(wallet phase): check WalletDO balance / subscription entitlement for
  // _uid. Until then, paid MCP connectors are gated OFF server-side (the client
  // also gates with PaidFeature, so the UX is the top-up sheet, not a dead end).
  return false;
}
