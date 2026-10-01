// [AUMFE-POD-CORE-1 2026-10-01] Admin "Print partner" API: which partner prints and ships, connection test, catalogue sync,
// automation settings. Contract: Specs/SPEC-2026-10-01-AUMFE-POD-STUDIO.md section 3 (Partner admin API). Registered by
// routes/admin2.ts (ADMIN2_POD_PARTNER_ROUTES). Pattern: routes/admin2_shop_catalog.ts (guard, audit to DB_WALLET admin_audit,
// safeTrack). Every route is under /api/admin/v2/shop/partner/ (+ catalog) and behind the admin guard; writes are audited + tracked.
// Secrets are never returned: `configured` is a boolean only.
import type { Env } from "../types";
import { json } from "../util";
import type { Admin2RouteDef } from "./admin2"; // type only: admin2.ts imports this file, a value import would be circular
import { requireAdmin } from "./admin_money";
import { track, trackException } from "../hooks";
import { readConfig, writeConfigOverrides } from "./config";
import {
  POD_PROVIDER_IDS, getPodProvider, podConnectionPeek, podProviderConfigured, PodError,
  type CatalogProduct, type CatalogVariant, type PodProviderId,
} from "../lib/pod";
import { builtInCatalog } from "../lib/pod/manual";

const APP = "saathum";
const BASE = "/api/admin/v2/shop";
const noStore = { "cache-control": "private, no-store" };

const err = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
  json({ error, message, ...extra }, status, noStore);

async function adminGuard(req: Request, env: Env): Promise<{ uid: string } | Response> {
  const a = await requireAdmin(req, env);
  if (a instanceof Response) {
    return a.status === 403 ? err(403, "admin_only", "You don't have admin access.") : err(a.status, "unauthorized", "Please sign in again.");
  }
  return a;
}

function safeTrack(env: Env, uid: string, event: string, props: Record<string, unknown>): void {
  try { void track(env, uid, event, APP, props); } catch { /* telemetry is best-effort */ }
}

async function audit(env: Env, adminId: string, action: string, target: string, meta: Record<string, unknown>): Promise<void> {
  try {
    await env.DB_WALLET.prepare(
      "INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
    ).bind(crypto.randomUUID(), adminId, action, target, JSON.stringify(meta), Date.now()).run();
  } catch (e) {
    await trackException(env, e, { uid: adminId, route: "pod_partner/audit", handled: true, app_name: APP });
  }
}

async function readBody(req: Request, max = 16_384): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > max) return null;
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

function guarded(route: string, fn: (req: Request, env: Env, a: { uid: string }) => Promise<Response>) {
  return async (req: Request, env: Env): Promise<Response> => {
    const a = await adminGuard(req, env);
    if (a instanceof Response) return a;
    try {
      return await fn(req, env, a);
    } catch (e) {
      if (e instanceof PodError) {
        const status = e.code === "not_configured" ? 409 : e.code === "auth_failed" ? 502 : e.code === "rejected" ? 502 : 503;
        return err(status, e.code, e.message);
      }
      if (/no such table/i.test(String((e as { message?: string })?.message ?? e))) {
        return err(503, "pod_unavailable", "The print-partner tables are not set up yet.");
      }
      await trackException(env, e, { uid: a.uid, route, method: req.method, handled: true, app_name: APP });
      return err(500, "internal", "Something went wrong.");
    }
  };
}

const isProviderId = (v: unknown): v is PodProviderId => typeof v === "string" && (POD_PROVIDER_IDS as string[]).includes(v);
const PROVIDER_LABELS: Record<PodProviderId, { label: string; supportsApi: boolean }> = {
  manual: { label: "By hand", supportsApi: false },
  printrove: { label: "Printrove", supportsApi: true },
};

type CatalogRow = {
  provider: string; provider_product_id: string; kind: string; name: string; category: string | null;
  variants_json: string; size_chart_json: string | null; synced_at: number;
};

async function catalogStats(env: Env, provider: PodProviderId): Promise<{ count: number; synced_at: number | null }> {
  try {
    const r = await env.DB_META.prepare("SELECT COUNT(*) AS n, MAX(synced_at) AS at FROM pod_catalog WHERE provider=?1")
      .bind(provider).first<{ n: number; at: number | null }>();
    return { count: r?.n ?? 0, synced_at: r?.at ?? null };
  } catch (e) {
    if (/no such table/i.test(String((e as { message?: string })?.message ?? e))) return { count: 0, synced_at: null };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// GET partner
// ---------------------------------------------------------------------------
async function getPartner(_req: Request, env: Env): Promise<Response> {
  const cfg = await readConfig(env);
  const provider: PodProviderId = isProviderId(cfg.shopPodProvider) ? cfg.shopPodProvider : "manual";
  const [connection, catalog] = await Promise.all([podConnectionPeek(env, provider), catalogStats(env, provider)]);
  return json({
    provider,
    providers: POD_PROVIDER_IDS.map((id) => ({ id, ...PROVIDER_LABELS[id], configured: podProviderConfigured(env, id) })),
    connection,
    auto_send: cfg.shopPodAutoSend === true,
    poll_minutes: cfg.shopPodPollMinutes,
    catalog,
    notify_buyer: true,
    alert_owner: true,
  }, 200, noStore);
}

/** Body provider (to test/sync a partner before switching to it) or the one currently selected. */
async function targetProvider(req: Request, env: Env): Promise<PodProviderId | Response> {
  const body = await readBody(req);
  if (body === null) return err(400, "invalid_input", "Send a small JSON body.");
  if (body.provider !== undefined) {
    if (!isProviderId(body.provider)) return err(400, "invalid_input", "provider must be manual or printrove.", { field: "provider" });
    return body.provider;
  }
  const cfg = await readConfig(env);
  return isProviderId(cfg.shopPodProvider) ? cfg.shopPodProvider : "manual";
}

// ---------------------------------------------------------------------------
// POST partner/test
// ---------------------------------------------------------------------------
async function testPartner(req: Request, env: Env, a: { uid: string }): Promise<Response> {
  const id = await targetProvider(req, env);
  if (id instanceof Response) return id;
  const result = await (await getPodProvider(env, id)).testConnection();
  safeTrack(env, a.uid, "pod_partner_tested", { provider: id, ok: result.ok });
  await audit(env, a.uid, "pod_partner_test", id, { ok: result.ok });
  return json(result, 200, noStore);
}

// ---------------------------------------------------------------------------
// POST partner/sync
// ---------------------------------------------------------------------------
const BATCH = 50;

async function syncPartner(req: Request, env: Env, a: { uid: string }): Promise<Response> {
  const id = await targetProvider(req, env);
  if (id instanceof Response) return id;
  const started = Date.now();
  const items = await (await getPodProvider(env, id)).syncCatalog();
  const now = Date.now();
  const stmt = env.DB_META.prepare(
    `INSERT INTO pod_catalog (provider, provider_product_id, kind, name, category, variants_json, size_chart_json, raw_json, synced_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,NULL,?8)
     ON CONFLICT(provider, provider_product_id) DO UPDATE SET kind=excluded.kind, name=excluded.name, category=excluded.category,
       variants_json=excluded.variants_json, size_chart_json=excluded.size_chart_json, synced_at=excluded.synced_at`,
  );
  const writes = items.map((p) => stmt.bind(
    p.provider, p.provider_product_id, p.kind, p.name, p.category, JSON.stringify(p.variants),
    p.size_chart ? JSON.stringify(p.size_chart) : null, now,
  ));
  for (let i = 0; i < writes.length; i += BATCH) await env.DB_META.batch(writes.slice(i, i + BATCH));
  // Products the partner no longer lists drop out of the catalogue (this sync is the whole truth for the provider).
  await env.DB_META.prepare("DELETE FROM pod_catalog WHERE provider=?1 AND synced_at < ?2").bind(id, now).run();
  safeTrack(env, a.uid, "pod_partner_synced", { provider: id, count: items.length, ms: Date.now() - started });
  await audit(env, a.uid, "pod_partner_sync", id, { count: items.length });
  return json({ count: items.length, synced_at: now }, 200, noStore);
}

// ---------------------------------------------------------------------------
// PUT partner/settings
// ---------------------------------------------------------------------------
async function putSettings(req: Request, env: Env, a: { uid: string }): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return err(400, "invalid_input", "Send a small JSON body.");
  const patch: Record<string, string | number | boolean> = {};
  if (body.provider !== undefined) {
    if (!isProviderId(body.provider)) return err(400, "invalid_input", "provider must be manual or printrove.", { field: "provider" });
    if (!podProviderConfigured(env, body.provider)) {
      return err(409, "not_configured", "The Printrove login is not set on the server yet, so it cannot be selected.");
    }
    patch.shopPodProvider = body.provider;
  }
  if (body.auto_send !== undefined) {
    if (typeof body.auto_send !== "boolean") return err(400, "invalid_input", "auto_send must be true or false.", { field: "auto_send" });
    patch.shopPodAutoSend = body.auto_send;
  }
  if (body.poll_minutes !== undefined) {
    const n = body.poll_minutes;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 5 || n > 1440) {
      return err(400, "invalid_input", "poll_minutes must be a whole number from 5 to 1440.", { field: "poll_minutes" });
    }
    patch.shopPodPollMinutes = n;
  }
  if (!Object.keys(patch).length) return err(400, "invalid_input", "Nothing to change.");
  await writeConfigOverrides(env, patch); // ONE read + ONE write of the KV overrides, same blob putConfig writes
  safeTrack(env, a.uid, "pod_partner_settings_changed", { fields: Object.keys(patch).join(","), ...patch });
  await audit(env, a.uid, "pod_partner_settings", "shop", patch);
  // Echo the applied values (a re-read could hit a stale KV edge for a moment).
  const cfg = await readConfig(env);
  return json({
    ok: true,
    provider: patch.shopPodProvider ?? cfg.shopPodProvider,
    auto_send: patch.shopPodAutoSend ?? cfg.shopPodAutoSend,
    poll_minutes: patch.shopPodPollMinutes ?? cfg.shopPodPollMinutes,
  }, 200, noStore);
}

// ---------------------------------------------------------------------------
// GET catalog?kind=
// ---------------------------------------------------------------------------
function parseJsonColumn<T>(env: Env, raw: string | null, fallback: T, what: string): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch (e) {
    void trackException(env, e, { route: "pod_partner/catalog", handled: true, app_name: APP, extra: { column: what } });
    return fallback;
  }
}

async function getCatalog(req: Request, env: Env): Promise<Response> {
  const kind = new URL(req.url).searchParams.get("kind")?.trim() || "";
  if (kind && !/^[a-z_]{1,32}$/.test(kind)) return err(400, "invalid_input", "Unknown kind.", { field: "kind" });
  const cfg = await readConfig(env);
  const provider: PodProviderId = isProviderId(cfg.shopPodProvider) ? cfg.shopPodProvider : "manual";
  let rows: CatalogRow[] = [];
  try {
    const r = kind
      ? await env.DB_META.prepare("SELECT * FROM pod_catalog WHERE provider=?1 AND kind=?2 ORDER BY name").bind(provider, kind).all<CatalogRow>()
      : await env.DB_META.prepare("SELECT * FROM pod_catalog WHERE provider=?1 ORDER BY kind, name").bind(provider).all<CatalogRow>();
    rows = r.results ?? [];
  } catch (e) {
    if (!/no such table/i.test(String((e as { message?: string })?.message ?? e))) throw e;
  }
  const items: CatalogProduct[] = rows.length
    ? rows.map((r) => ({
      provider, provider_product_id: r.provider_product_id, kind: r.kind, name: r.name, category: r.category,
      variants: parseJsonColumn<CatalogVariant[]>(env, r.variants_json, [], "variants_json"),
      size_chart: parseJsonColumn<CatalogProduct["size_chart"]>(env, r.size_chart_json, null, "size_chart_json"),
    }))
    : builtInCatalog().filter((p) => !kind || p.kind === kind); // nothing synced yet: the built-in manual catalogue
  return json({ items }, 200, noStore);
}

export const ADMIN2_POD_PARTNER_ROUTES: Admin2RouteDef[] = [
  { method: "GET", path: `${BASE}/partner`, handler: guarded("pod_partner/get", (r, e) => getPartner(r, e)) },
  { method: "POST", path: `${BASE}/partner/test`, handler: guarded("pod_partner/test", testPartner) },
  { method: "POST", path: `${BASE}/partner/sync`, handler: guarded("pod_partner/sync", syncPartner) },
  { method: "PUT", path: `${BASE}/partner/settings`, handler: guarded("pod_partner/settings", putSettings) },
  { method: "GET", path: `${BASE}/catalog`, handler: guarded("pod_partner/catalog", (r, e) => getCatalog(r, e)) },
];
