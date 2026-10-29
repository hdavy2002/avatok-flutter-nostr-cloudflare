// [HF-PAGES-1] Policy pages from D1 `site_pages`. One source for the website and the app.
//   GET /api/hf/pages                 -> { ok, pages:[{slug,title,version,updatedAt}] }               public, published only
//   GET /api/hf/pages/:slug           -> { ok, slug,title,summary,related,version,updatedAt,blocks }  public; placeholders resolved; ETag = version
//   GET /api/admin/hf/pages/:slug     -> raw row (placeholders NOT resolved, even if unpublished)     admin (ADMIN_UIDS)
//   PUT /api/admin/hf/pages/:slug     { title?, summary?, related?, body, published? } -> { ok, version } admin; bumps version
// A page's `version` is what the re-accept flow can pin instead of a file hash (see HF-PAGES-1 notes).
import type { Env } from "../types";
import { CORS, json } from "../util";
import { requireUser, isFail } from "../authz";
import { trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { isAdminUid } from "../lib/preview";
import { SLUG_RE, resolveBlocks, resolvePlaceholders, validateBlocks, validateRelated, type Block, type Related } from "../lib/hf_pages";

const PUBLIC_CACHE = "public, max-age=60, stale-while-revalidate=86400";
const NO_STORE = { "cache-control": "private, no-store" };
const err = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ ok: false, error, message: error, ...extra }, status, NO_STORE);

type Row = { slug: string; title: string; summary: string; related: string; body: string; version: number; updated_at: string; published: number; updated_by: string };
const parse = <T,>(s: string, fallback: T): T => { try { return JSON.parse(s) as T; } catch { return fallback; } };
const etagFor = (r: Row) => `"hfpage-${r.slug}-${r.version}"`;

async function row(env: Env, slug: string): Promise<Row | null> {
  return await env.DB_META.prepare("SELECT slug,title,summary,related,body,version,updated_at,published,updated_by FROM site_pages WHERE slug=?1").bind(slug).first<Row>();
}

async function listPages(env: Env): Promise<Response> {
  const rs = await env.DB_META.prepare("SELECT slug,title,version,updated_at FROM site_pages WHERE published=1 ORDER BY slug").all<Pick<Row, "slug" | "title" | "version" | "updated_at">>();
  return json({ ok: true, pages: (rs.results ?? []).map((r) => ({ slug: r.slug, title: r.title, version: r.version, updatedAt: r.updated_at })) }, 200, { "cache-control": PUBLIC_CACHE });
}

async function getPage(req: Request, env: Env, slug: string): Promise<Response> {
  const r = await row(env, slug);
  if (!r || r.published !== 1) return err(404, "not_found");
  const etag = etagFor(r);
  const headers = { "cache-control": PUBLIC_CACHE, etag };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ...CORS, ...headers } });
  const related = parse<Related[]>(r.related, []).map((x) => ({ href: x.href, label: resolvePlaceholders(x.label) }));
  return json({
    ok: true, slug: r.slug, title: resolvePlaceholders(r.title), summary: resolvePlaceholders(r.summary), related,
    version: r.version, updatedAt: r.updated_at, blocks: resolveBlocks(parse<Block[]>(r.body, [])),
  }, 200, headers);
}

async function adminGet(env: Env, slug: string): Promise<Response> {
  const r = await row(env, slug);
  if (!r) return err(404, "not_found");
  return json({ ok: true, slug: r.slug, title: r.title, summary: r.summary, related: parse(r.related, []), body: parse(r.body, []), version: r.version, updatedAt: r.updated_at, published: r.published === 1, updatedBy: r.updated_by }, 200, NO_STORE);
}

async function adminPut(req: Request, env: Env, slug: string, uid: string): Promise<Response> {
  let b: Record<string, unknown>;
  try { const v = await req.json(); if (!v || typeof v !== "object" || Array.isArray(v)) return err(400, "bad_json"); b = v as Record<string, unknown>; } catch { return err(400, "bad_json"); }
  const bad = validateBlocks(b.body);
  if (bad) return err(400, "invalid_body", { detail: bad });
  const existing = await row(env, slug);
  const title = b.title === undefined ? existing?.title : b.title;
  if (typeof title !== "string" || !title.trim() || title.length > 200) return err(400, "invalid_title");
  const summary = b.summary === undefined ? (existing?.summary ?? "") : b.summary;
  if (typeof summary !== "string" || summary.length > 600) return err(400, "invalid_summary");
  const related = b.related === undefined ? parse<Related[]>(existing?.related ?? "[]", []) : b.related;
  const relBad = validateRelated(related);
  if (relBad) return err(400, relBad);
  const published = b.published === undefined ? (existing ? existing.published : 1) : b.published === true || b.published === 1 ? 1 : b.published === false || b.published === 0 ? 0 : -1;
  if (published === -1) return err(400, "invalid_published");
  const today = new Date().toISOString().slice(0, 10);
  const bodyJson = JSON.stringify(b.body);
  if (!existing) {
    await env.DB_META.prepare("INSERT INTO site_pages (slug,title,summary,related,body,version,updated_at,published,updated_by) VALUES (?1,?2,?3,?4,?5,1,?6,?7,?8)")
      .bind(slug, title.trim(), summary, JSON.stringify(related), bodyJson, today, published, uid).run();
    return json({ ok: true, slug, version: 1, created: true }, 201, NO_STORE);
  }
  await env.DB_META.prepare("UPDATE site_pages SET title=?2,summary=?3,related=?4,body=?5,version=version+1,updated_at=?6,published=?7,updated_by=?8 WHERE slug=?1")
    .bind(slug, title.trim(), summary, JSON.stringify(related), bodyJson, today, published, uid).run();
  const after = await row(env, slug);
  return json({ ok: true, slug, version: after?.version ?? existing.version + 1 }, 200, NO_STORE);
}

export async function hfPagesRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  const pub = p === "/api/hf/pages" ? [""] : /^\/api\/hf\/pages\/([^/]+)$/.exec(p);
  const adm = /^\/api\/admin\/hf\/pages\/([^/]+)$/.exec(p);
  if (!pub && !adm) return null;
  const m = req.method;
  try {
    if (pub) {
      if (m !== "GET") return null;
      if (p === "/api/hf/pages") return await listPages(env);
      const slug = (pub as RegExpExecArray)[1];
      if (!SLUG_RE.test(slug)) return err(404, "not_found");
      return await getPage(req, env, slug);
    }
    const slug = adm![1];
    if (m !== "GET" && m !== "PUT") return null;
    const u = await requireUser(req, env);
    if (isFail(u)) return err(u.status, u.error);
    if (!isAdminUid(env, u.uid)) return err(403, "forbidden");
    if (!SLUG_RE.test(slug)) return err(400, "bad_slug");
    return m === "GET" ? await adminGet(env, slug) : await adminPut(req, env, slug, u.uid);
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, app_name: BRAND.slug, extra: { area: "hf_pages" } });
    return err(500, "internal");
  }
}
