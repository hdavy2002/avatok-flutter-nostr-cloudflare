// AVACALLS-003/007/009 — Virtual Numbers domain API.
// Every line lookup is scoped by the authenticated owner. Provider metadata and
// credentials never cross this domain boundary.
import type { Env } from "../types";
import { json } from "../util";
import { isFail, requireUser } from "../authz";
import { metaDb, sha256hex } from "../db/shard";
import { chargeAmount } from "../feature_pricing";
import { walletOp } from "./wallet";
import { readConfig } from "./config";
import { getTelephonyProvider, type TelephonyProviderName } from "../lib/telephony_provider";
import { canonical, display, generate, planFor, validNsn } from "../lib/numbering";
import { normalizeDestination } from "../lib/telephony_numbers";

type LineRow = {
  id: string; owner_uid: string; kind: "did" | "avatok"; canonical_number: string;
  display_number: string; country_iso2: string | null; region: string | null;
  label: string; color_key: string; capabilities_json: string; status: string;
  provider: string | null; is_default_outgoing: number; monthly_tokens_subunits: number;
  current_period_start: number | null; next_renewal_at: number | null;
  created_at: number; updated_at: number; released_at: number | null;
};

const ACTIVE = "status IN ('provisioning','active','past_due','suspended')";
const cleanLabel = (v: unknown, fallback: string) => String(v ?? fallback).trim().slice(0, 80) || fallback;
const cleanColor = (v: unknown) => /^[a-z0-9_-]{1,32}$/i.test(String(v ?? "")) ? String(v) : "blue";
function capabilities(raw: string): Record<string, boolean> { try { return JSON.parse(raw) as Record<string, boolean>; } catch { return {}; } }
function lineJson(row: LineRow, unread = 0) {
  return {
    id: row.id, kind: row.kind, canonicalNumber: row.canonical_number, displayNumber: row.display_number,
    countryIso2: row.country_iso2, region: row.region, label: row.label, colorKey: row.color_key,
    capabilities: capabilities(row.capabilities_json), status: row.status,
    isDefaultOutgoing: row.is_default_outgoing === 1, monthlyTokensSubunits: row.monthly_tokens_subunits,
    provider: row.provider, currentPeriodStart: row.current_period_start, nextRenewalAt: row.next_renewal_at,
    createdAt: row.created_at, updatedAt: row.updated_at, releasedAt: row.released_at, unreadCount: unread,
  };
}

async function gate(env: Env, key: "virtualNumbersEnabled" | "virtualNumberFreeEnabled" | "virtualNumberDidPurchaseEnabled"): Promise<Response | null> {
  const cfg = await readConfig(env);
  if (cfg.virtualNumbersEnabled !== true || cfg[key] !== true) return json({ error: "virtual_numbers_disabled" }, 503);
  return null;
}

async function auth(req: Request, env: Env) { const ctx = await requireUser(req, env); return isFail(ctx) ? null : ctx; }

export async function virtualLinesList(req: Request, env: Env): Promise<Response> {
  const denied = await gate(env, "virtualNumbersEnabled"); if (denied) return denied;
  const ctx = await auth(req, env); if (!ctx) return json({ error: "unauthorized" }, 401);
  const rows = await metaDb(env).prepare(`SELECT * FROM virtual_lines WHERE owner_uid=?1 ORDER BY created_at DESC`).bind(ctx.uid).all<LineRow>();
  const result = [];
  for (const row of rows.results ?? []) {
    const unread = await metaDb(env).prepare(`SELECT COUNT(*) AS n FROM virtual_line_activity WHERE owner_uid=?1 AND line_id=?2 AND is_read=0`).bind(ctx.uid, row.id).first<{ n: number }>();
    result.push(lineJson(row, Number(unread?.n ?? 0)));
  }
  return json({ ok: true, lines: result });
}

export async function virtualLineGet(req: Request, env: Env, lineId: string): Promise<Response> {
  const denied = await gate(env, "virtualNumbersEnabled"); if (denied) return denied;
  const ctx = await auth(req, env); if (!ctx) return json({ error: "unauthorized" }, 401);
  const row = await metaDb(env).prepare(`SELECT * FROM virtual_lines WHERE id=?1 AND owner_uid=?2`).bind(lineId, ctx.uid).first<LineRow>();
  if (!row) return json({ error: "line_not_found" }, 404);
  return json({ ok: true, line: lineJson(row) });
}

export async function virtualLineCreateAvaTOK(req: Request, env: Env): Promise<Response> {
  const denied = await gate(env, "virtualNumberFreeEnabled"); if (denied) return denied;
  const ctx = await auth(req, env); if (!ctx) return json({ error: "unauthorized" }, 401);
  const cfg = await readConfig(env);
  const count = await metaDb(env).prepare(`SELECT COUNT(*) AS n FROM virtual_lines WHERE owner_uid=?1 AND kind='avatok' AND ${ACTIVE}`).bind(ctx.uid).first<{ n: number }>();
  if (Number(count?.n ?? 0) >= cfg.virtualNumberFreeMaxPerAccount) return json({ error: "free_number_limit", limit: cfg.virtualNumberFreeMaxPerAccount }, 409);
  const body = (await req.json().catch(() => ({}))) as { country?: string; number?: string; label?: string; colorKey?: string };
  const plan = planFor(String(body.country ?? "IN")); if (!plan) return json({ error: "unsupported_country" }, 400);
  const requested = String(body.number ?? "").replace(/\D/g, "");
  const candidates = requested ? [requested.slice(0, plan.nsnLen)] : generate(plan, 24);
  const db = metaDb(env); let selected: { canonical: string; display: string } | null = null;
  for (const nsn of candidates) {
    if (!validNsn(plan, nsn)) continue;
    const number = canonical(plan, nsn);
    const taken = await db.prepare(`SELECT 1 FROM virtual_lines WHERE canonical_number=?1 AND ${ACTIVE} LIMIT 1`).bind(number).first();
    const legacyTaken = await db.prepare(`SELECT 1 FROM avatok_numbers WHERE number=?1 AND status='active' LIMIT 1`).bind(number).first();
    if (!taken && !legacyTaken) { selected = { canonical: number, display: display(plan, nsn) }; break; }
  }
  if (!selected) return json({ error: "number_unavailable" }, 409);
  const now = Date.now(); const id = crypto.randomUUID(); const hash = await sha256hex(selected.canonical);
  try {
    await db.prepare(`INSERT INTO virtual_lines (id,owner_uid,kind,canonical_number,display_number,number_hash,country_iso2,label,color_key,capabilities_json,status,created_at,updated_at) VALUES (?1,?2,'avatok',?3,?4,?5,?6,?7,?8,?9,'active',?10,?10)`)
      .bind(id, ctx.uid, selected.canonical, selected.display, hash, plan.iso2, cleanLabel(body.label, "AvaTOK number"), cleanColor(body.colorKey), JSON.stringify({ audio: true, video: true, messaging: true, pstn: false, sms: false }), now).run();
    await db.prepare(`INSERT INTO virtual_line_settings (line_id,policy_json,created_at,updated_at) VALUES (?1,'{}',?2,?2)`).bind(id, now).run();
  } catch (e) { return json({ error: "number_unavailable", detail: String(e).slice(0, 100) }, 409); }
  const row = await db.prepare(`SELECT * FROM virtual_lines WHERE id=?1 AND owner_uid=?2`).bind(id, ctx.uid).first<LineRow>();
  return json({ ok: true, line: row ? lineJson(row) : { id, kind: "avatok", displayNumber: selected.display } }, 201);
}

export async function virtualDidSearch(req: Request, env: Env): Promise<Response> {
  const denied = await gate(env, "virtualNumbersEnabled"); if (denied) return denied;
  const ctx = await auth(req, env); if (!ctx) return json({ error: "unauthorized" }, 401);
  const cfg = await readConfig(env); if (cfg.virtualNumberDidPurchaseEnabled !== true) return json({ error: "did_purchase_disabled" }, 503);
  const url = new URL(req.url); const country = String(url.searchParams.get("country") ?? "IN").toUpperCase();
  const providerName = cfg.virtualNumberPrimaryProvider as TelephonyProviderName;
  if ((providerName === "frejun" && !cfg.virtualNumberFrejunEnabled) || (providerName === "vobiz" && !cfg.virtualNumberVobizEnabled)) return json({ error: "provider_disabled" }, 503);
  try {
    const result = await getTelephonyProvider(env, providerName).searchNumbers({ country, contains: url.searchParams.get("contains") ?? undefined, page: Math.max(1, Number(url.searchParams.get("page") ?? 1)) });
    return json({ ok: true, provider: "available", items: result.items.map((item) => ({ id: item.id, e164: item.e164, country: item.country, region: item.region, monthlyFee: item.monthlyFee, currency: item.currency, capabilities: item.capabilities })), total: result.total, page: result.page });
  } catch (e) { return json({ error: "inventory_unavailable", retryable: true, detail: String(e).slice(0, 120) }, 502); }
}

export async function virtualDidPurchase(req: Request, env: Env): Promise<Response> {
  const denied = await gate(env, "virtualNumberDidPurchaseEnabled"); if (denied) return denied;
  const ctx = await auth(req, env); if (!ctx) return json({ error: "unauthorized" }, 401);
  const cfg = await readConfig(env); const body = (await req.json().catch(() => ({}))) as { e164?: string; label?: string; colorKey?: string };
  const normalized = normalizeDestination(String(body.e164 ?? ""), "IN"); if (!normalized) return json({ error: "invalid_destination" }, 400);
  const db = metaDb(env); const existing = await db.prepare(`SELECT id,status FROM virtual_lines WHERE owner_uid=?1 AND canonical_number=?2 AND ${ACTIVE}`).bind(ctx.uid, normalized.canonical).first<{ id: string; status: string }>();
  if (existing) return json({ error: "already_owned", lineId: existing.id }, 409);
  const providerName = cfg.virtualNumberPrimaryProvider as TelephonyProviderName;
  if ((providerName === "frejun" && !cfg.virtualNumberFrejunEnabled) || (providerName === "vobiz" && !cfg.virtualNumberVobizEnabled)) return json({ error: "provider_disabled" }, 503);
  const opId = `virtual_did:${ctx.uid}:${normalized.canonical}`;
  const charge = await chargeAmount(env, ctx.uid, "virtual_number_did_month", cfg.virtualNumberDidMonthlyTokens, opId);
  if (!charge.ok) return json({ error: charge.reason === "insufficient" ? "insufficient_balance" : "charge_failed", balance: charge.balance }, 402);
  let purchased;
  try { purchased = await getTelephonyProvider(env, providerName).purchaseNumber(`+${normalized.canonical}`); }
  catch (e) {
    try { await walletOp(env, ctx.uid, { op: "credit", uid: ctx.uid, amount: cfg.virtualNumberDidMonthlyTokens, type: "refund", app_name: "virtual_number_did_month", ref: opId, op_id: `${opId}:refund`, ledger: { debit: "platform:fees", credit: `user:${ctx.uid}`, type: "virtual_did_refund", ref: opId } }); } catch { console.error("[virtual-lines] refund reconciliation required", ctx.uid, normalized.canonical); }
    return json({ error: "provision_failed", retryable: true, detail: String(e).slice(0, 120) }, 502);
  }
  const now = Date.now(); const id = crypto.randomUUID(); const renewal = now + 30 * 24 * 3600 * 1000;
  try {
    await db.prepare(`INSERT INTO virtual_lines (id,owner_uid,kind,canonical_number,display_number,number_hash,provider,provider_number_id,country_iso2,region,label,color_key,capabilities_json,status,is_default_outgoing,monthly_tokens_subunits,current_period_start,next_renewal_at,created_at,updated_at) VALUES (?1,?2,'did',?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'active',CASE WHEN NOT EXISTS (SELECT 1 FROM virtual_lines WHERE owner_uid=?2 AND kind='did' AND status='active' AND is_default_outgoing=1) THEN 1 ELSE 0 END,?13,?14,?15,?14,?14)`)
      .bind(id, ctx.uid, normalized.canonical, normalized.display, await sha256hex(normalized.canonical), providerName, null, normalized.countryIso2, null, cleanLabel(body.label, "Virtual number"), cleanColor(body.colorKey), JSON.stringify({ voice: true, outboundCallerId: true, sms: false, otp: false, voicemail: true, receptionist: true, recordings: true }), cfg.virtualNumberDidMonthlyTokens * 1000, now, renewal).run();
    await db.prepare(`INSERT INTO virtual_line_settings (line_id,policy_json,created_at,updated_at) VALUES (?1,'{}',?2,?2)`).bind(id, now).run();
  } catch (e) {
    console.error("[virtual-lines] provider purchase succeeded; reconciliation required", ctx.uid, normalized.canonical, String(e));
    return json({ error: "ownership_record_failed", reconciliationRequired: true }, 502);
  }
  const row = await db.prepare(`SELECT * FROM virtual_lines WHERE id=?1 AND owner_uid=?2`).bind(id, ctx.uid).first<LineRow>();
  return json({ ok: true, line: row ? lineJson(row) : { id, kind: "did", displayNumber: purchased.e164 } }, 201);
}

export async function virtualLinePatch(req: Request, env: Env, lineId: string): Promise<Response> {
  const denied = await gate(env, "virtualNumbersEnabled"); if (denied) return denied;
  const ctx = await auth(req, env); if (!ctx) return json({ error: "unauthorized" }, 401);
  const body = (await req.json().catch(() => ({}))) as { label?: string; colorKey?: string };
  const row = await metaDb(env).prepare(`SELECT * FROM virtual_lines WHERE id=?1 AND owner_uid=?2`).bind(lineId, ctx.uid).first<LineRow>(); if (!row) return json({ error: "line_not_found" }, 404);
  const now = Date.now(); await metaDb(env).prepare(`UPDATE virtual_lines SET label=COALESCE(?3,label),color_key=COALESCE(?4,color_key),updated_at=?5 WHERE id=?1 AND owner_uid=?2`).bind(lineId, ctx.uid, body.label === undefined ? null : cleanLabel(body.label, row.label), body.colorKey === undefined ? null : cleanColor(body.colorKey), now).run();
  return virtualLineGet(req, env, lineId);
}

export async function virtualLineDefault(req: Request, env: Env, lineId: string): Promise<Response> {
  const denied = await gate(env, "virtualNumbersEnabled"); if (denied) return denied;
  const ctx = await auth(req, env); if (!ctx) return json({ error: "unauthorized" }, 401); const db = metaDb(env);
  const row = await db.prepare(`SELECT * FROM virtual_lines WHERE id=?1 AND owner_uid=?2 AND kind='did' AND status='active'`).bind(lineId, ctx.uid).first<LineRow>(); if (!row) return json({ error: "did_not_found" }, 404);
  await db.prepare(`UPDATE virtual_lines SET is_default_outgoing=0,updated_at=?2 WHERE owner_uid=?1 AND kind='did' AND status='active'`).bind(ctx.uid, Date.now()).run();
  await db.prepare(`UPDATE virtual_lines SET is_default_outgoing=1,updated_at=?2 WHERE id=?1 AND owner_uid=?3`).bind(lineId, Date.now(), ctx.uid).run();
  return json({ ok: true, lineId });
}

export async function virtualLineSettings(req: Request, env: Env, lineId: string): Promise<Response> {
  const denied = await gate(env, "virtualNumbersEnabled"); if (denied) return denied;
  const ctx = await auth(req, env); if (!ctx) return json({ error: "unauthorized" }, 401); const db = metaDb(env);
  const line = await db.prepare(`SELECT id FROM virtual_lines WHERE id=?1 AND owner_uid=?2`).bind(lineId, ctx.uid).first(); if (!line) return json({ error: "line_not_found" }, 404);
  if (req.method === "GET") { const settings = await db.prepare(`SELECT policy_json,version,created_at,updated_at FROM virtual_line_settings WHERE line_id=?1`).bind(lineId).first<{ policy_json: string; version: number; created_at: number; updated_at: number }>(); return json({ ok: true, settings: settings ? { ...settings, policy: JSON.parse(settings.policy_json) } : { policy: {}, version: 1 } }); }
  const body = await req.json().catch(() => null); if (!body || typeof body !== "object") return json({ error: "bad_json" }, 400); const policy = JSON.stringify(body); if (policy.length > 16_000) return json({ error: "settings_too_large" }, 413); const now = Date.now();
  await db.prepare(`INSERT INTO virtual_line_settings(line_id,policy_json,version,created_at,updated_at) VALUES (?1,?2,1,?3,?3) ON CONFLICT(line_id) DO UPDATE SET policy_json=excluded.policy_json,version=virtual_line_settings.version+1,updated_at=excluded.updated_at`).bind(lineId, policy, now).run();
  return json({ ok: true });
}

export async function virtualLineActivity(req: Request, env: Env, lineId: string): Promise<Response> {
  const denied = await gate(env, "virtualNumbersEnabled"); if (denied) return denied;
  const ctx = await auth(req, env); if (!ctx) return json({ error: "unauthorized" }, 401); const db = metaDb(env);
  const line = await db.prepare(`SELECT id FROM virtual_lines WHERE id=?1 AND owner_uid=?2`).bind(lineId, ctx.uid).first(); if (!line) return json({ error: "line_not_found" }, 404);
  const url = new URL(req.url); const type = url.searchParams.get("type"); const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50))); const q = type ? ` AND type=?3` : "";
  const rows = type ? await db.prepare(`SELECT * FROM virtual_line_activity WHERE owner_uid=?1 AND line_id=?2${q} ORDER BY created_at DESC LIMIT ?4`).bind(ctx.uid, lineId, type, limit).all() : await db.prepare(`SELECT * FROM virtual_line_activity WHERE owner_uid=?1 AND line_id=?2 ORDER BY created_at DESC LIMIT ?3`).bind(ctx.uid, lineId, limit).all();
  return json({ ok: true, activity: rows.results ?? [] });
}

export async function virtualLineStatus(req: Request, env: Env, lineId: string, action: "suspend" | "resume"): Promise<Response> {
  const denied = await gate(env, "virtualNumbersEnabled"); if (denied) return denied;
  const ctx = await auth(req, env); if (!ctx) return json({ error: "unauthorized" }, 401); const status = action === "suspend" ? "suspended" : "active"; const now = Date.now();
  const result = await metaDb(env).prepare(`UPDATE virtual_lines SET status=?3,updated_at=?4 WHERE id=?1 AND owner_uid=?2 AND status IN ('active','suspended')`).bind(lineId, ctx.uid, status, now).run(); if (!result.meta.changes) return json({ error: "line_not_found_or_invalid_state" }, 409); return json({ ok: true, status });
}

export async function virtualLineRelease(req: Request, env: Env, lineId: string): Promise<Response> {
  const denied = await gate(env, "virtualNumbersEnabled"); if (denied) return denied;
  const ctx = await auth(req, env); if (!ctx) return json({ error: "unauthorized" }, 401); const db = metaDb(env);
  const row = await db.prepare(`SELECT * FROM virtual_lines WHERE id=?1 AND owner_uid=?2 AND status NOT IN ('released','releasing')`).bind(lineId, ctx.uid).first<LineRow>(); if (!row) return json({ error: "line_not_found" }, 404);
  if (row.kind === "did" && row.provider) { try { await getTelephonyProvider(env, row.provider as TelephonyProviderName).releaseNumber(`+${row.canonical_number}`); } catch (e) { return json({ error: "release_failed", retryable: true, detail: String(e).slice(0, 120) }, 502); } }
  const now = Date.now(); await db.prepare(`UPDATE virtual_lines SET status='released',released_at=?3,updated_at=?3,is_default_outgoing=0 WHERE id=?1 AND owner_uid=?2`).bind(lineId, ctx.uid, now).run(); return json({ ok: true, status: "released" });
}

export async function virtualLinesRoute(req: Request, env: Env, path: string): Promise<Response> {
  const rest = path.slice("/api/virtual-lines".length).replace(/^\/+/, ""); const parts = rest.split("/").filter(Boolean);
  if (!parts.length) return req.method === "GET" ? virtualLinesList(req, env) : json({ error: "method_not_allowed" }, 405);
  if (parts[0] === "avatok" && req.method === "POST") return virtualLineCreateAvaTOK(req, env);
  if (parts[0] === "dids" && parts[1] === "search" && req.method === "GET") return virtualDidSearch(req, env);
  if (parts[0] === "dids" && parts[1] === "purchase" && req.method === "POST") return virtualDidPurchase(req, env);
  const lineId = decodeURIComponent(parts[0]);
  if (parts.length === 1) return req.method === "GET" ? virtualLineGet(req, env, lineId) : req.method === "PATCH" ? virtualLinePatch(req, env, lineId) : req.method === "DELETE" ? virtualLineRelease(req, env, lineId) : json({ error: "method_not_allowed" }, 405);
  if (parts[1] === "default-outgoing" && req.method === "PUT") return virtualLineDefault(req, env, lineId);
  if (parts[1] === "activity" && req.method === "GET") return virtualLineActivity(req, env, lineId);
  if (parts[1] === "settings" && (req.method === "GET" || req.method === "PUT")) return virtualLineSettings(req, env, lineId);
  if (parts[1] === "suspend" && req.method === "POST") return virtualLineStatus(req, env, lineId, "suspend");
  if (parts[1] === "resume" && req.method === "POST") return virtualLineStatus(req, env, lineId, "resume");
  return json({ error: "not_found" }, 404);
}
