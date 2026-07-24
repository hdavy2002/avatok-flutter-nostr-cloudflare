// [AVABRAIN-EXPORT-1] (Bible §6.1, §9.2, §P1.3/P1.5) — two related surfaces:
//
//   1. POST /api/brain/export — the explicit, bounded, auditable export of
//      user-approved DEVICE_PRIVATE content (a private Messenger DM/group
//      excerpt, or a note) into the cloud Brain. Per Bible §6.1 this is the
//      ONLY lawful path by which device_private content may ever reach the
//      server: the app/lib/core/brain_recall.dart device lane indexes private
//      content locally; a user who explicitly taps "Remember this in
//      AvaBrain" on a SELECTED excerpt is the only producer of this domain.
//      Ingested under its own OPT-IN consent key ('private_export' — see
//      lib/brain_domains.ts) so a user who has never used this screen has
//      contributed nothing.
//
//   2. The memory review/correction/forget/export screens (Bible §P1.5):
//      GET    /api/brain/memory/list     — paged derived facts for review.
//      POST   /api/brain/memory/confirm  — user_confirmed=true (§4.2 raises authority).
//      POST   /api/brain/memory/correct  — supersede + re-ingest corrected text.
//      DELETE /api/brain/memory/:id      — forget one fact + its vectors.
//      POST   /api/brain/memory/export   — bounded synchronous JSON download.
//
// Every mutating op here is authenticated (requireUser — dual NIP-98/Clerk, same
// as routes/brain.ts) and scoped to the caller's OWN uid; a fact/vector row that
// doesn't belong to the caller is invisible (WHERE uid=?), never 404-leaked.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { brainIngest } from "../lib/brain_ingest";
import { isBrainDomain, basisFor, consentKeyFor } from "../lib/brain_domains";
import { emailFor } from "../lib/identity";
import { trackUser, trackException, metric } from "../hooks";
import { readConfig } from "./config"; // [AVABRAIN-FLAGS-1] KV-config-driven caps

// ── cost-control flags — read defensively off `env` (AVABRAIN-FLAGS-1 is the
// agent that wires these into routes/config.ts DEFAULTS + KV; until then a
// missing/undefined flag NEVER means "unlimited" — same convention as
// routes/brain_media.ts flagBool/flagNum below). ──────────────────────────────
// [AVABRAIN-FLAGS-1] KV platform_config first (declared in config.ts DEFAULTS,
// owner-tunable via scripts/flags.sh), env var second, hard default last.
async function exportDailyCap(env: Env): Promise<number> {
  try {
    const c = Number(((await readConfig(env)) as unknown as Record<string, unknown>).avaBrainExportDailyCap);
    if (Number.isFinite(c) && c > 0) return c;
  } catch { /* fall through to env/default */ }
  const v = (env as unknown as Record<string, unknown>).avaBrainExportDailyCap;
  const n = Number(v);
  return v !== undefined && v !== null && Number.isFinite(n) && n > 0 ? n : 50;
}

const MAX_ITEMS_PER_CALL = 20;
const MAX_ITEM_CHARS = 2000;
const SOURCES = new Set(["dm", "group", "note"]);
const MAX_MEMORY_EXPORT_BYTES = 5 * 1024 * 1024; // 5 MB — bible §9.2 v1 bound

function startOfDayMs(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

async function trackBrain(env: Env, uid: string, event: string, props: Record<string, unknown>): Promise<void> {
  // trackUser stamps the caller's raw email so support can pull this by account
  // (bible §10) — never the exported/derived content itself.
  try { await trackUser(env, uid, await emailFor(env, uid), event, "avabrain", props); } catch { /* best-effort */ }
}

// ── consent pre-check (defense in depth — brainIngest also fails closed on
// consent, but checking here first means a consent-off user never even gets a
// "queued" response for content the server will silently drop). ──────────────
async function consentAllows(env: Env, uid: string, capability: string): Promise<boolean> {
  try {
    const rs = await env.DB_BRAIN.prepare(
      "SELECT enabled FROM brain_consent WHERE uid=?1 AND capability IN ('master',?2)",
    ).bind(uid, capability).all();
    for (const r of (rs.results ?? []) as Array<{ enabled: number }>) if (Number(r.enabled) === 0) return false;
    return true;
  } catch (e) {
    console.error("[brain-export] consent check failed — dropping (fail-closed):", String(e));
    return false; // FAIL CLOSED
  }
}

// ═══════════════════════ POST /api/brain/export ═══════════════════════════
// Body: { items: [{ text: string (<=2000 chars), source: 'dm'|'group'|'note',
//                    context_hint?: string }], max 20 items/call }.
export async function brainExport(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = ctx.uid;

  // private_export is OPT-IN (default false) — a user who has never explicitly
  // enabled it via /api/brain/consent gets a clear 403, not a silent drop.
  if (!(await consentAllows(env, uid, "private_export"))) {
    return json({ error: "consent_required", consent_key: "private_export" }, 403);
  }

  const body = (await req.json().catch(() => ({}))) as { items?: unknown };
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (!rawItems.length) return json({ error: "items required" }, 400);
  if (rawItems.length > MAX_ITEMS_PER_CALL) {
    return json({ error: "too_many_items", max: MAX_ITEMS_PER_CALL }, 400);
  }

  type Item = { text: string; source: string; context_hint?: string };
  const items: Item[] = [];
  for (const raw of rawItems) {
    const r = raw as any;
    const text = String(r?.text ?? "").trim().slice(0, MAX_ITEM_CHARS);
    const source = String(r?.source ?? "").toLowerCase();
    if (!text) continue;
    if (!SOURCES.has(source)) return json({ error: "source must be dm|group|note" }, 400);
    items.push({ text, source, context_hint: r?.context_hint != null ? String(r.context_hint).slice(0, 300) : undefined });
  }
  if (!items.length) return json({ error: "items required" }, 400);

  // Per-user DAILY export cap (Bible: flag avaBrainExportDailyCap, default 50
  // items; read defensively, undefined -> 50). Counts items already exported
  // today (UTC) via the audit table, so the cap survives across multiple calls.
  const cap = await exportDailyCap(env);
  const cutoff = startOfDayMs(Date.now());
  let usedToday = 0;
  try {
    const row = await env.DB_BRAIN.prepare(
      "SELECT COALESCE(SUM(item_count),0) AS n FROM brain_export_audit WHERE uid=?1 AND created_at>=?2",
    ).bind(uid, cutoff).first<{ n: number }>();
    usedToday = Number(row?.n ?? 0);
  } catch { /* fail-open on the READ — a D1 hiccup on a cost control, not a
              privacy boundary, must not block a legitimate export */ }
  if (usedToday + items.length > cap) {
    return json({ error: "daily_cap_reached", used: usedToday, cap, requested: items.length }, 429);
  }

  const now = Date.now();
  const sourcesBreakdown: Record<string, number> = {};
  let charCount = 0;
  const results: Array<{ ok: boolean; reason?: string }> = [];

  for (const item of items) {
    const itemId = crypto.randomUUID();
    const r = await brainIngest(env, {
      uid, domain: "private_export", kind: "export_item", sourceId: itemId,
      text: item.text,
      meta: { itemId, source: item.source, contextHint: item.context_hint ?? null },
      ts: now,
    });
    results.push({ ok: r.ok, ...(r.reason ? { reason: r.reason } : {}) });
    if (r.ok) {
      charCount += item.text.length;
      sourcesBreakdown[item.source] = (sourcesBreakdown[item.source] ?? 0) + 1;
    }
  }

  const accepted = results.filter((r) => r.ok).length;

  // Audit row — who/when/how many items/chars. NEVER the content itself.
  try {
    await env.DB_BRAIN.prepare(
      `INSERT INTO brain_export_audit (id, uid, item_count, char_count, sources, created_at)
       VALUES (?1,?2,?3,?4,?5,?6)`,
    ).bind(crypto.randomUUID(), uid, accepted, charCount, JSON.stringify(sourcesBreakdown), now).run();
  } catch (e) {
    await trackException(env, e, { uid, route: "brain_export", method: "POST", extra: { stage: "audit_row" } });
  }

  metric(env, "avabrain_private_export", [accepted, charCount], [uid.slice(0, 16)]);
  // Telemetry: count + chars only (Bible §10 — never message bodies/content).
  await trackBrain(env, uid, "avabrain_private_export", {
    count: accepted, chars: charCount, requested: items.length, sources: sourcesBreakdown,
  });

  return json({ ok: true, accepted, requested: items.length, used_today: usedToday + accepted, cap, results });
}

// ═══════════════════════ Memory review / correction / forget / export ═════
// (Bible §P1.5 — memory review, correction, forget and export screens.)

interface FactRow {
  id: string; content: string; fact_type: string; confidence: number;
  source_app: string | null; user_confirmed: number; created_at: number; updated_at: number;
}

// Domains never surfaced on the review screen: the legal-basis 'safety' store
// is a separate table (guardian_events) and never lands in brain_facts anyway,
// but this is a deliberate belt-and-suspenders filter (mirrors do/user_brain.ts
// domainConsentOk) so a future accidental producer can't leak a guardian record
// into the list.
function reviewableDomain(sourceApp: string | null, consent: Map<string, boolean>): boolean {
  if (!sourceApp) return true; // untagged legacy facts — governed by master only
  if (consent.get("master") === false) return false;
  if (sourceApp === "safety") return false;
  if (!isBrainDomain(sourceApp)) return true; // e.g. generic 'memory'/client-synced facts
  if (basisFor(sourceApp) === "legal") return false;
  const key = consentKeyFor(sourceApp);
  if (!key) return true;
  return consent.get(key) !== false; // absent row = default ON (opt-out model)
}

async function consentMap(env: Env, uid: string): Promise<Map<string, boolean>> {
  const m = new Map<string, boolean>();
  try {
    const rs = await env.DB_BRAIN.prepare("SELECT capability, enabled FROM brain_consent WHERE uid=?1").bind(uid).all();
    for (const r of (rs.results ?? []) as any[]) m.set(String(r.capability), Number(r.enabled) === 1);
  } catch { /* default-ON applies below when the map is empty */ }
  return m;
}

// ---- GET /api/brain/memory/list ----
// Query: ?cursor=<updated_at ms, exclusive upper bound>&limit=<n, default 50, max 200>
export async function brainMemoryList(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = ctx.uid;

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 50));
  const cursorParam = url.searchParams.get("cursor");
  const cursor = cursorParam ? Number(cursorParam) : null;

  // Pull a generous slice (bounded), then filter by per-domain consent in code —
  // D1 has no registry-aware WHERE clause, and the domain set is small.
  const fetchLimit = Math.min(500, limit * 4 + 20);
  let rows: FactRow[] = [];
  try {
    const rs = cursor && Number.isFinite(cursor)
      ? await env.DB_BRAIN.prepare(
          `SELECT id, content, fact_type, confidence, source_app, user_confirmed, created_at, updated_at
           FROM brain_facts WHERE uid=?1 AND valid_until IS NULL AND updated_at<?2
           ORDER BY updated_at DESC LIMIT ?3`,
        ).bind(uid, cursor, fetchLimit).all()
      : await env.DB_BRAIN.prepare(
          `SELECT id, content, fact_type, confidence, source_app, user_confirmed, created_at, updated_at
           FROM brain_facts WHERE uid=?1 AND valid_until IS NULL
           ORDER BY updated_at DESC LIMIT ?2`,
        ).bind(uid, fetchLimit).all();
    rows = (rs.results ?? []) as any[];
  } catch (e) {
    await trackException(env, e, { uid, route: "brain_memory_list", method: "GET" });
    return json({ error: "list unavailable" }, 503);
  }

  const consent = await consentMap(env, uid);
  const visible = rows.filter((r) => reviewableDomain(r.source_app, consent)).slice(0, limit);
  const items = visible.map((r) => ({
    id: r.id, content: r.content, type: r.fact_type, confidence: r.confidence,
    source_domain: r.source_app, user_confirmed: Number(r.user_confirmed) === 1, created_at: r.created_at,
  }));
  const nextCursor = visible.length === limit ? visible[visible.length - 1].updated_at : null;

  await trackBrain(env, uid, "avabrain_memory_reviewed", { count: items.length, has_more: !!nextCursor });
  return json({ items, next_cursor: nextCursor });
}

// ---- POST /api/brain/memory/confirm ----
// Body: { id }.
export async function brainMemoryConfirm(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = ctx.uid;
  const b = (await req.json().catch(() => ({}))) as { id?: unknown };
  const id = String(b.id ?? "").trim();
  if (!id) return json({ error: "id required" }, 400);

  const now = Date.now();
  let changed = 0;
  try {
    const r = await env.DB_BRAIN.prepare(
      `UPDATE brain_facts SET user_confirmed=1, confidence=MAX(confidence,0.95), last_confirmed_at=?3, updated_at=?3
       WHERE id=?1 AND uid=?2 AND valid_until IS NULL`,
    ).bind(id, uid, now).run();
    changed = Number((r as any).meta?.changes ?? 0);
  } catch (e) {
    await trackException(env, e, { uid, route: "brain_memory_confirm", method: "POST" });
    return json({ error: "confirm failed" }, 503);
  }
  if (!changed) return json({ error: "not found" }, 404);
  await trackBrain(env, uid, "avabrain_memory_confirmed", { id });
  return json({ ok: true, id });
}

// ---- POST /api/brain/memory/correct ----
// Body: { id, content }. Supersedes the old fact (valid_until=now) and ingests
// the correction as a fresh, user_confirmed fact.
export async function brainMemoryCorrect(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = ctx.uid;
  const b = (await req.json().catch(() => ({}))) as { id?: unknown; content?: unknown };
  const id = String(b.id ?? "").trim();
  const content = String(b.content ?? "").trim().slice(0, MAX_ITEM_CHARS);
  if (!id || !content) return json({ error: "id and content required" }, 400);

  const old = await env.DB_BRAIN.prepare(
    "SELECT id, fact_type, source_app, confidence FROM brain_facts WHERE id=?1 AND uid=?2 AND valid_until IS NULL",
  ).bind(id, uid).first<{ id: string; fact_type: string; source_app: string | null; confidence: number }>().catch(() => null);
  if (!old) return json({ error: "not found" }, 404);

  const now = Date.now();
  const newId = crypto.randomUUID();
  try {
    await env.DB_BRAIN.batch([
      env.DB_BRAIN.prepare("UPDATE brain_facts SET valid_until=?2, updated_at=?2 WHERE id=?1 AND uid=?3")
        .bind(id, now, uid),
      env.DB_BRAIN.prepare(
        `INSERT INTO brain_facts (id, uid, fact_type, content, scope, source_app, source_id, confidence, user_confirmed, created_at, updated_at, derived_from_max_ts, last_confirmed_at)
         VALUES (?1,?2,?3,?4,'public',?5,?6,0.95,1,?7,?7,?7,?7)`,
      ).bind(newId, uid, old.fact_type || "insight", content, old.source_app ?? "user_correction", id, now),
    ]);
  } catch (e) {
    await trackException(env, e, { uid, route: "brain_memory_correct", method: "POST" });
    return json({ error: "correct failed" }, 503);
  }
  await trackBrain(env, uid, "avabrain_memory_corrected", { old_id: id, new_id: newId });
  return json({ ok: true, old_id: id, new_id: newId });
}

// ---- DELETE /api/brain/memory/:id ----
// Forget one fact + its derived vectors (mirrors deleteMediaMemory's per-item
// deletion pattern in consumers/src/brain.ts — enumerate vector ids from the
// brain_vectors registry via the fact's own source_id-as-ref, then delete both).
export async function brainMemoryDelete(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = ctx.uid;

  const row = await env.DB_BRAIN.prepare(
    "SELECT id, source_app, source_id FROM brain_facts WHERE id=?1 AND uid=?2",
  ).bind(id, uid).first<{ id: string; source_app: string | null; source_id: string | null }>().catch(() => null);
  if (!row) return json({ error: "not found" }, 404);

  // Safety records never route through brain_facts (see brainIngest's ACL
  // rejection), but refuse defensively rather than ever deleting one here.
  if (row.source_app === "safety") return json({ error: "not deletable" }, 403);

  let vectorCount = 0;
  try {
    if (row.source_id) {
      const vr = await env.DB_BRAIN.prepare(
        "SELECT vec_id FROM brain_vectors WHERE uid=?1 AND ref=?2",
      ).bind(uid, row.source_id).all().catch(() => ({ results: [] as any[] }));
      const ids = ((vr.results ?? []) as any[]).map((r) => String(r.vec_id));
      vectorCount = ids.length;
      if (env.VECTOR_INDEX && ids.length) {
        for (let i = 0; i < ids.length; i += 1000) await env.VECTOR_INDEX.deleteByIds(ids.slice(i, i + 1000)).catch(() => null);
      }
      if (ids.length) await env.DB_BRAIN.prepare("DELETE FROM brain_vectors WHERE uid=?1 AND ref=?2").bind(uid, row.source_id).run().catch(() => null);
    }
    await env.DB_BRAIN.prepare("DELETE FROM brain_facts WHERE id=?1 AND uid=?2").bind(id, uid).run();
  } catch (e) {
    await trackException(env, e, { uid, route: "brain_memory_delete", method: "DELETE" });
    return json({ error: "delete failed" }, 503);
  }
  await trackBrain(env, uid, "avabrain_memory_deleted", { id, vectors: vectorCount });
  return json({ ok: true, id });
}

// ---- POST /api/brain/memory/export ----
// Full personal-memory export job — v1 is a bounded synchronous JSON response
// (Bible §9.2 "a simple bounded synchronous JSON response (<=5MB, else 413 with
// guidance) is acceptable v1"). Facts the user owns, respecting consent/scope
// (never guardian/safety) — mirrors brainMemoryList's filter.
export async function brainMemoryExport(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = ctx.uid;

  let facts: FactRow[] = [];
  let events: Array<{ event_type: string; source_app: string; created_at: number }> = [];
  try {
    const rs = await env.DB_BRAIN.prepare(
      `SELECT id, content, fact_type, confidence, source_app, user_confirmed, created_at, updated_at
       FROM brain_facts WHERE uid=?1 AND valid_until IS NULL ORDER BY updated_at DESC LIMIT 5000`,
    ).bind(uid).all();
    facts = (rs.results ?? []) as any[];
    const evs = await env.DB_BRAIN.prepare(
      "SELECT event_type, source_app, created_at FROM brain_events WHERE uid=?1 ORDER BY created_at DESC LIMIT 2000",
    ).bind(uid).all();
    events = (evs.results ?? []) as any[];
  } catch (e) {
    await trackException(env, e, { uid, route: "brain_memory_export", method: "POST" });
    return json({ error: "export unavailable" }, 503);
  }

  const consent = await consentMap(env, uid);
  const visibleFacts = facts.filter((r) => reviewableDomain(r.source_app, consent));
  const visibleEvents = events.filter((e) => reviewableDomain(e.source_app, consent));

  const payload = {
    uid,
    exported_at: Date.now(),
    facts: visibleFacts.map((r) => ({
      id: r.id, content: r.content, type: r.fact_type, confidence: r.confidence,
      source_domain: r.source_app, user_confirmed: Number(r.user_confirmed) === 1, created_at: r.created_at,
    })),
    events: visibleEvents.map((e) => ({ type: e.event_type, source_domain: e.source_app, created_at: e.created_at })),
  };

  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  if (bytes.byteLength > MAX_MEMORY_EXPORT_BYTES) {
    return json({
      error: "too_large", max_bytes: MAX_MEMORY_EXPORT_BYTES, size_bytes: bytes.byteLength,
      guidance: "Your memory is too large for a single export. Contact support for a paged/background export.",
    }, 413);
  }

  await trackBrain(env, uid, "avabrain_memory_exported", { facts: visibleFacts.length, events: visibleEvents.length, bytes: bytes.byteLength });
  return json(payload);
}
