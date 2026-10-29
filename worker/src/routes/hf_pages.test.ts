// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-PAGES-1] policy pages from D1: real migrations (table + seed), real SQL.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

vi.mock("../hooks", () => ({ track: async () => undefined, trackException: async () => undefined }));
vi.mock("../authz", () => ({
  requireUser: async (req: Request) => {
    const uid = req.headers.get("x-test-uid");
    return uid ? { uid } : { error: "unauthorized", status: 401 };
  },
  isFail: (v: any) => !!v?.error,
}));

import { hfPagesRoute } from "./hf_pages";
import { validateBlocks, resolvePlaceholders } from "../lib/hf_pages";
import { BRAND } from "../lib/brand";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
let db: any;
let env: any;

function setup() {
  db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../../migrations/2026-10-29-hf-site-pages.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../../migrations/2026-10-29-hf-site-pages-seed.sql", import.meta.url), "utf8"));
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => db.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...values) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...values).changes) } }),
  });
  env = { DB_META: { prepare: (sql: string) => statement(sql) }, ADMIN_UIDS: "admin1" };
}

const call = (path: string, method = "GET", body?: unknown, uid?: string, headers: Record<string, string> = {}) =>
  hfPagesRoute(new Request(`https://x${path}`, {
    method,
    headers: { "content-type": "application/json", ...(uid ? { "x-test-uid": uid } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, path);

const goodBody = [{ t: "h2", text: "Hello {brand.name}" }, { t: "p", spans: [{ text: "Mail " }, { text: "{brand.emails.support}", href: "mailto:{brand.emails.support}" }, { text: " now", em: true }] }];

beforeEach(setup);

describe("placeholders", () => {
  it("resolves brand and business values, leaves unknown ones", () => {
    expect(resolvePlaceholders("{brand.name} / {brand.emails.support} / {business.name}")).toBe(`${BRAND.name} / ${BRAND.emails.support} / Davy Labs`);
    expect(resolvePlaceholders("{brand.nope}")).toBe("{brand.nope}");
  });
  it("GET resolves placeholders in text and hrefs, and no braces survive in any seeded page", async () => {
    const list = await (await call("/api/hf/pages")).json();
    expect(list.pages).toHaveLength(14);
    for (const p of list.pages) {
      const res = await call(`/api/hf/pages/${p.slug}`);
      expect(res.status).toBe(200);
      expect(JSON.stringify(await res.json())).not.toMatch(/\{(brand|business)\./);
    }
    const terms = await (await call("/api/hf/pages/terms")).json();
    expect(JSON.stringify(terms.blocks)).toContain(`mailto:${BRAND.emails.grievance}`);
    expect(JSON.stringify(terms.blocks)).toContain("Dehra Dun");
  });
});

describe("public read", () => {
  it("returns the page shape with cache headers and an ETag on the version", async () => {
    const res = await call("/api/hf/pages/refunds");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60, stale-while-revalidate=86400");
    const etag = res.headers.get("etag");
    expect(etag).toContain("-1");
    const j = await res.json();
    expect(j).toMatchObject({ ok: true, slug: "refunds", version: 1 });
    expect(Array.isArray(j.blocks) && Array.isArray(j.related)).toBe(true);
    const again = await call("/api/hf/pages/refunds", "GET", undefined, undefined, { "if-none-match": etag });
    expect(again.status).toBe(304);
  });
  it("404 for unknown, unpublished and malformed slugs", async () => {
    expect((await call("/api/hf/pages/nope")).status).toBe(404);
    expect((await call("/api/hf/pages/Bad_Slug")).status).toBe(404);
    db.exec("UPDATE site_pages SET published=0 WHERE slug='cookies'");
    expect((await call("/api/hf/pages/cookies")).status).toBe(404);
    expect((await (await call("/api/hf/pages")).json()).pages).toHaveLength(13);
  });
});

describe("block validation", () => {
  it("accepts every seeded page body", () => {
    for (const r of db.prepare("SELECT slug, body FROM site_pages").all()) expect(validateBlocks(JSON.parse(r.body)), r.slug).toBeNull();
  });
  it("rejects bad shapes", () => {
    expect(validateBlocks("x")).toBe("body_must_be_array");
    expect(validateBlocks([])).toBe("body_empty");
    expect(validateBlocks([{ t: "h3", text: "x" }])).toBe("bad_block_0");
    expect(validateBlocks([{ t: "h2", text: "" }])).toBe("bad_block_0");
    expect(validateBlocks([{ t: "p", spans: [] }])).toBe("bad_block_0");
    expect(validateBlocks([{ t: "p", spans: [{ text: "x", bold: true }] }])).toBe("bad_block_0");
    expect(validateBlocks([{ t: "p", spans: [{ text: "x", em: false }] }])).toBe("bad_block_0");
    expect(validateBlocks([{ t: "p", spans: [{ text: "x", href: "javascript:alert(1)" }] }])).toBe("bad_block_0");
    expect(validateBlocks([{ t: "p", spans: [{ text: "x" }], extra: 1 }])).toBe("bad_block_0");
    expect(validateBlocks([{ t: "ul", items: [[]] }])).toBe("bad_block_0");
    expect(validateBlocks([{ t: "p", spans: [{ text: "{brand.unknown}" }] }])).toBe("bad_block_0");
    expect(validateBlocks([{ t: "h2", text: "ok" }, { t: "note", spans: "x" }])).toBe("bad_block_1");
  });
});

describe("admin PUT", () => {
  it("needs sign-in and admin rights", async () => {
    expect((await call("/api/admin/hf/pages/terms", "PUT", { body: goodBody })).status).toBe(401);
    expect((await call("/api/admin/hf/pages/terms", "PUT", { body: goodBody }, "someone")).status).toBe(403);
    expect((await call("/api/admin/hf/pages/terms", "GET", undefined, "someone")).status).toBe(403);
  });
  it("rejects invalid blocks and leaves the page untouched", async () => {
    const res = await call("/api/admin/hf/pages/terms", "PUT", { body: [{ t: "zzz" }] }, "admin1");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_body");
    expect(db.prepare("SELECT version FROM site_pages WHERE slug='terms'").get().version).toBe(1);
  });
  it("bumps the version, stamps updated_at/updated_by, and the public page changes", async () => {
    const res = await call("/api/admin/hf/pages/terms", "PUT", { body: goodBody, summary: "New summary" }, "admin1");
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe(2);
    const r = db.prepare("SELECT * FROM site_pages WHERE slug='terms'").get();
    expect(r.version).toBe(2);
    expect(r.updated_by).toBe("admin1");
    expect(r.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.title).toBe("Terms of use"); // untouched when omitted
    const pub = await (await call("/api/hf/pages/terms")).json();
    expect(pub.version).toBe(2);
    expect(pub.summary).toBe("New summary");
    expect(pub.blocks[0].text).toBe(`Hello ${BRAND.name}`);
    expect((await call("/api/admin/hf/pages/terms", "PUT", { body: goodBody }, "admin1").then((x) => x.json())).version).toBe(3);
    const raw = await (await call("/api/admin/hf/pages/terms", "GET", undefined, "admin1")).json();
    expect(raw.body[0].text).toBe("Hello {brand.name}"); // admin sees the unresolved placeholders
  });
  it("creates a new page when the slug is new and a title is given", async () => {
    expect((await call("/api/admin/hf/pages/brand-new", "PUT", { body: goodBody }, "admin1")).status).toBe(400);
    const res = await call("/api/admin/hf/pages/brand-new", "PUT", { title: "Brand new", body: goodBody }, "admin1");
    expect(res.status).toBe(201);
    expect((await call("/api/hf/pages/brand-new")).status).toBe(200);
  });
});
