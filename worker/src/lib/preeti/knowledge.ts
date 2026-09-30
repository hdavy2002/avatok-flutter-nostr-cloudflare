// [SAATHUM-PREETI-1 2026-09-30] Knowledge / RAG layer for Preeti (Agent B).
// One Gemini File Search store (displayName "preeti-kb") under env.GEMINI_API_KEY.
// Google docs (verified 2026-09-30): https://ai.google.dev/gemini-api/docs/file-search
//   - create store        POST   /v1beta/fileSearchStores                       {displayName, embedding_model}
//   - upload + metadata   POST   /upload/v1beta/{store}:uploadToFileSearchStore  (resumable: start, then "upload, finalize")
//                                start body {displayName, customMetadata:[{key,stringValue|numericValue}], chunkingConfig}
//   - operation polling   GET    /v1beta/{operation.name}  until done:true; response.documentName = the document
//   - list documents      GET    /v1beta/{store}/documents?pageSize=&pageToken=
//   - delete document     DELETE /v1beta/{document}?force=true
// Request shapes for store creation + resumable upload mirror lib/ava_rag.ts.
// Brand literals never appear here: the site origin + former names come from
// currentBrand(env) (brand_runtime.ts, Agent A).

import type { Env } from "../../types";
import { geminiFetch } from "../gemini_egress"; // [SAATHUM-PREETI-EGRESS-1]
import { sha256Hex } from "../../util";
import * as hooks from "../../hooks";
import { currentBrand, scrubFormerNames } from "./brand_runtime";
import type { BrandRuntime, KnowledgeSyncResult } from "./contracts";

const GLA = "https://generativelanguage.googleapis.com";
const EMBED_MODEL = "models/gemini-embedding-2";
const STORE_DISPLAY_NAME = "preeti-kb";

const KV_STORE = "preeti:kb:store";        // fallback if ai_agent_config row is missing
const KV_CURSOR = "preeti:kb:cursor";      // resumable sync cursor
const KV_MAINT_DAY = "preeti:maint:day";   // IST day of last completed daily maintenance

const PAGES_PER_INVOCATION = 60;           // <=~6 subrequests each -> well under the 1000 cap
const MAX_TEXT_CHARS = 150_000;
const MIN_TEXT_CHARS = 200;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const RETENTION_MS = 365 * 24 * 3600 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

const SKIP_PREFIXES = [
  "/admin", "/dashboard", "/api", "/sign-in", "/sign-up", "/signin", "/signup", "/login",
  "/checkout", "/account", "/profile", "/live", "/watch", "/j/", "/book", "/wallet", "/s/", "/sitemap",
];

function apiKey(env: Env): string {
  const k = env.GEMINI_API_KEY;
  if (!k) throw new Error("GEMINI_API_KEY not set");
  return k;
}

async function errText(res: Response): Promise<string> {
  return (await res.text().catch(() => "")).slice(0, 200);
}

async function d1Run(env: Env, sql: string, ...binds: unknown[]) {
  return env.DB_META.prepare(sql).bind(...binds).run();
}

// ---------------------------------------------------------------- store

export async function ensurePreetiStore(env: Env): Promise<string> {
  const row = await env.DB_META.prepare("SELECT store_name FROM ai_agent_config WHERE id=1").first<{ store_name: string | null }>().catch(() => null);
  if (row?.store_name) return row.store_name;
  const kv = await env.TOKENS.get(KV_STORE).catch(() => null);
  if (kv) {
    await d1Run(env, "UPDATE ai_agent_config SET store_name=? WHERE id=1 AND store_name IS NULL", kv).catch(() => null);
    return kv;
  }
  const res = await geminiFetch(env, `${GLA}/v1beta/fileSearchStores`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey(env) },
    body: JSON.stringify({ displayName: STORE_DISPLAY_NAME, embedding_model: EMBED_MODEL }),
  });
  if (!res.ok) throw new Error(`preeti store create ${res.status}: ${await errText(res)}`);
  const j: any = await res.json().catch(() => ({}));
  const name = String(j?.name || "");
  if (!name) throw new Error("preeti store create: no name returned");
  await env.TOKENS.put(KV_STORE, name);
  await d1Run(env, "UPDATE ai_agent_config SET store_name=? WHERE id=1", name);
  return name;
}

// ---------------------------------------------------------------- File Search REST helpers

type Meta = Record<string, string>;

async function pollOperation(env: Env, opName: string, tries = 4): Promise<string> {
  // Returns the document resource name, or "" if indexing has not finished yet.
  if (!opName) return "";
  for (let i = 0; i < tries; i++) {
    const res = await geminiFetch(env, `${GLA}/v1beta/${opName}`, { headers: { "x-goog-api-key": apiKey(env) } });
    if (!res.ok) throw new Error(`operation poll ${res.status}: ${await errText(res)}`);
    const op: any = await res.json().catch(() => ({}));
    if (op?.error) throw new Error(`indexing failed: ${String(op.error.message || "").slice(0, 200)}`);
    if (op?.done) return docNameFromOp(op);
    await new Promise((r) => setTimeout(r, 1200));
  }
  return "";
}

function docNameFromOp(op: any): string {
  return String(op?.response?.documentName || op?.response?.document?.name || op?.metadata?.documentName || "");
}

/** Upload bytes into the store with custom metadata. Returns the document name ("" if still indexing). */
async function uploadDoc(
  env: Env, store: string, displayName: string, mime: string, bytes: Uint8Array, meta: Meta,
): Promise<string> {
  const key = apiKey(env);
  const customMetadata = Object.entries(meta)
    .filter(([, v]) => v)
    .map(([k, v]) => ({ key: k, stringValue: v.slice(0, 250) }));
  const start = await geminiFetch(env, `${GLA}/upload/v1beta/${store}:uploadToFileSearchStore`, {
    method: "POST",
    headers: {
      "x-goog-api-key": key,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length),
      "X-Goog-Upload-Header-Content-Type": mime,
      "content-type": "application/json",
    },
    body: JSON.stringify({ displayName: displayName.slice(0, 120), customMetadata }),
  });
  if (!start.ok) throw new Error(`upload start ${start.status}: ${await errText(start)}`);
  const up = start.headers.get("x-goog-upload-url");
  if (!up) throw new Error("upload start: no upload url");
  const fin = await geminiFetch(env, up, {
    method: "POST",
    headers: {
      "x-goog-api-key": key,
      "Content-Length": String(bytes.length),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: bytes,
  });
  if (!fin.ok) throw new Error(`upload finalize ${fin.status}: ${await errText(fin)}`);
  const op: any = await fin.json().catch(() => ({}));
  if (op?.done) return docNameFromOp(op);
  return pollOperation(env, String(op?.name || ""));
}

async function deleteDocByName(env: Env, docName: string): Promise<void> {
  if (!docName) return;
  const res = await geminiFetch(env, `${GLA}/v1beta/${docName}?force=true`, {
    method: "DELETE", headers: { "x-goog-api-key": apiKey(env) },
  });
  if (!res.ok && res.status !== 404) throw new Error(`doc delete ${res.status}: ${await errText(res)}`);
}

/** Delete every store document whose displayName starts with `prefix` except one ending with `keepSuffix`. */
async function deleteDocsByDisplayPrefix(env: Env, store: string, prefix: string, keepSuffix?: string): Promise<number> {
  let n = 0;
  let token = "";
  for (let page = 0; page < 10; page++) {
    const url = `${GLA}/v1beta/${store}/documents?pageSize=20${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`;
    const res = await geminiFetch(env, url, { headers: { "x-goog-api-key": apiKey(env) } });
    if (!res.ok) throw new Error(`doc list ${res.status}: ${await errText(res)}`);
    const j: any = await res.json().catch(() => ({}));
    for (const d of j?.documents || []) {
      const dn = String(d?.displayName || "");
      if (dn.startsWith(prefix) && !(keepSuffix && dn.endsWith(keepSuffix))) {
        await deleteDocByName(env, String(d.name));
        n++;
      }
    }
    token = String(j?.nextPageToken || "");
    if (!token) break;
  }
  return n;
}

// ---------------------------------------------------------------- HTML -> text

const DROP_SELECTORS = "script,style,noscript,svg,nav,header,footer,aside,form,iframe,template,button,select,dialog";
const HEADING_SELECTORS = "h1,h2,h3,h4,h5,h6";
const BLOCK_SELECTORS = "p,li,tr,blockquote,section,article,div,br,dt,dd,figcaption";

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'").replace(/&rsquo;|&#8217;/gi, "’")
    .replace(/&#(\d+);/g, (_, d) => { const c = Number(d); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : " "; })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { const c = parseInt(h, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : " "; });
}

function extractTitle(html: string): string {
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  const raw = (h1 && h1.replace(/<[^>]+>/g, "").trim()) || (t || "");
  return decodeEntities(raw.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Readable main text (headings kept as markdown) via HTMLRewriter. */
export async function htmlToReadableText(html: string): Promise<string> {
  // Prefer <main> when present.
  const mainM = /<main[\s>][\s\S]*<\/main>/i.exec(html);
  const src = mainM ? mainM[0] : (/<body[\s>][\s\S]*<\/body>/i.exec(html)?.[0] ?? html);
  const rewritten = await new HTMLRewriter()
    .on(DROP_SELECTORS, { element(el) { el.remove(); } })
    .on(HEADING_SELECTORS, {
      element(el) {
        const lvl = Math.min(4, Number(el.tagName.slice(1)) || 2);
        el.before("\n\n" + "#".repeat(lvl) + " ");
        el.after("\n\n");
      },
    })
    .on(BLOCK_SELECTORS, { element(el) { el.after("\n"); } })
    .transform(new Response(src))
    .text();
  const stripped = decodeEntities(rewritten.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " "));
  return stripped
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------- site URL discovery

function isPublicPath(path: string): boolean {
  if (/\.[a-z0-9]{2,5}$/i.test(path)) return false;
  const p = path.toLowerCase();
  return !SKIP_PREFIXES.some((s) => p === s.replace(/\/$/, "") || p.startsWith(s));
}

function hostSet(brand: BrandRuntime): Set<string> {
  const hosts = new Set<string>();
  const add = (h: string | null | undefined) => {
    if (!h) return;
    const bare = h.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
    hosts.add(bare); hosts.add(bare.replace(/^www\./, "")); hosts.add("www." + bare.replace(/^www\./, ""));
  };
  add(brand.domain); add(brand.site);
  for (const f of brand.former || []) add(f.domain);
  return hosts;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": "PreetiKnowledgeSync/1.0", accept: "text/html,text/plain" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  return res.text();
}

async function discoverUrls(brand: BrandRuntime): Promise<string[]> {
  const site = brand.site.replace(/\/+$/, "");
  const hosts = hostSet(brand);
  const found = new Set<string>([site + "/"]);
  let okAny = false;
  for (const f of ["/llms.txt", "/llms-rituals.txt"]) {
    let body = "";
    try { body = await fetchText(site + f); okAny = true; } catch { continue; } // per-file miss tolerated; total miss handled below
    for (const m of body.matchAll(/https?:\/\/[^\s)>\]"']+/g)) {
      let u: URL;
      try { u = new URL(m[0].replace(/[.,;]+$/, "")); } catch { continue; }
      if (!hosts.has(u.hostname.toLowerCase())) continue;
      if (!isPublicPath(u.pathname)) continue;
      const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") || "/" : "/";
      found.add(site + path);
    }
  }
  if (!okAny) throw new Error("llms.txt and llms-rituals.txt both unreachable");
  return [...found];
}

function classify(url: string): { kind: "article" | "page"; slug: string; path: string } {
  const path = new URL(url).pathname.replace(/\/+$/, "") || "/";
  const m = /^\/rituals\/([^/]+)$/.exec(path);
  if (m) return { kind: "article", slug: decodeURIComponent(m[1]), path };
  return { kind: "page", slug: path === "/" ? "home" : path.replace(/^\//, "").replace(/\//g, "-"), path };
}

// ---------------------------------------------------------------- site sync

interface SyncCursor {
  urls: string[]; idx: number; full: boolean; startedAt: number;
  scanned: number; uploaded: number; unchanged: number; removed: number; failed: number;
}

function emptyResult(c?: SyncCursor): KnowledgeSyncResult {
  return c
    ? { scanned: c.scanned, uploaded: c.uploaded, unchanged: c.unchanged, removed: c.removed, failed: c.failed }
    : { scanned: 0, uploaded: 0, unchanged: 0, removed: 0, failed: 0 };
}

/** True while a resumable sync run still has pages left (a cron tick / next call continues it). */
export async function knowledgeSyncPending(env: Env): Promise<boolean> {
  return !!(await env.TOKENS.get(KV_CURSOR).catch(() => null));
}

/**
 * Bounded + resumable: each call handles up to PAGES_PER_INVOCATION pages, saving a KV cursor.
 * Returned counts are cumulative for the current run. Call again (or wait for the next cron tick)
 * while knowledgeSyncPending(env) is true. full=true restarts the run and re-uploads everything.
 */
export async function syncSiteKnowledge(env: Env, opts: { full?: boolean } = {}): Promise<KnowledgeSyncResult> {
  let cursor: SyncCursor | null = null;
  try {
    const brand = await currentBrand(env);
    const raw = opts.full ? null : await env.TOKENS.get(KV_CURSOR).catch(() => null);
    if (raw) { try { cursor = JSON.parse(raw) as SyncCursor; } catch { cursor = null; } }
    if (!cursor) {
      cursor = {
        urls: await discoverUrls(brand), idx: 0, full: !!opts.full, startedAt: Date.now(),
        scanned: 0, uploaded: 0, unchanged: 0, removed: 0, failed: 0,
      };
    }
    const store = await ensurePreetiStore(env);
    const end = Math.min(cursor.urls.length, cursor.idx + PAGES_PER_INVOCATION);
    for (; cursor.idx < end; cursor.idx++) {
      const url = cursor.urls[cursor.idx];
      cursor.scanned++;
      try {
        const r = await syncOnePage(env, store, brand, url, cursor.full);
        if (r === "uploaded") cursor.uploaded++; else cursor.unchanged++;
      } catch (e) {
        cursor.failed++;
        await d1Run(env,
          `INSERT INTO ai_knowledge_docs (url, kind, slug, title, content_hash, doc_name, status, error, synced_at)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT(url) DO UPDATE SET status='failed', error=excluded.error, synced_at=excluded.synced_at`,
          url, classify(url).kind, classify(url).slug, null, "", "", "failed", String((e as Error)?.message || e).slice(0, 300), Date.now(),
        ).catch(() => null);
        await hooks.trackException(env, e, { handled: true, route: "preeti.knowledge.sync_page", extra: { url } });
      }
    }
    if (cursor.idx >= cursor.urls.length) {
      cursor.removed += await removeVanished(env, store, new Set(cursor.urls));
      await env.TOKENS.delete(KV_CURSOR).catch(() => null);
      await hooks.track(env, "server", "preeti_knowledge_sync", "worker", { ...emptyResult(cursor), full: cursor.full, complete: true });
    } else {
      await env.TOKENS.put(KV_CURSOR, JSON.stringify(cursor), { expirationTtl: 3 * 24 * 3600 });
      await hooks.track(env, "server", "preeti_knowledge_sync", "worker", { ...emptyResult(cursor), full: cursor.full, complete: false, remaining: cursor.urls.length - cursor.idx });
    }
    return emptyResult(cursor);
  } catch (e) {
    await hooks.trackException(env, e, { handled: true, route: "preeti.knowledge.sync" });
    if (cursor) await env.TOKENS.put(KV_CURSOR, JSON.stringify(cursor), { expirationTtl: 3 * 24 * 3600 }).catch(() => null);
    const r = emptyResult(cursor || undefined);
    r.failed += 1;
    return r;
  }
}

async function syncOnePage(env: Env, store: string, brand: BrandRuntime, url: string, full: boolean): Promise<"uploaded" | "unchanged"> {
  const { kind, slug, path } = classify(url);
  const html = await fetchText(url);
  const title = extractTitle(html) || slug;
  const text = scrubFormerNames(await htmlToReadableText(html), brand).slice(0, MAX_TEXT_CHARS);
  if (text.length < MIN_TEXT_CHARS) throw new Error("page has too little readable text");
  const body = `# ${scrubFormerNames(title, brand)}\nSource: ${url}\n\n${text}`;
  const hash = await sha256Hex(body);

  const prev = await env.DB_META.prepare("SELECT content_hash, doc_name, status FROM ai_knowledge_docs WHERE url=?")
    .bind(url).first<{ content_hash: string; doc_name: string | null; status: string }>();
  if (!full && prev && prev.content_hash === hash && prev.status === "ready") {
    await d1Run(env, "UPDATE ai_knowledge_docs SET synced_at=? WHERE url=?", Date.now(), url);
    return "unchanged";
  }

  const prefix = `${path} #`;
  const display = `${prefix}${hash.slice(0, 8)}`;
  const docName = await uploadDoc(env, store, display, "text/plain", new TextEncoder().encode(body),
    { kind, slug, url, title: scrubFormerNames(title, brand) });
  // Delete the superseded document(s) after the new one is in.
  if (prev?.doc_name && prev.doc_name !== docName) await deleteDocByName(env, prev.doc_name);
  if (!docName || !prev?.doc_name) await deleteDocsByDisplayPrefix(env, store, prefix, `#${hash.slice(0, 8)}`);
  await d1Run(env,
    `INSERT INTO ai_knowledge_docs (url, kind, slug, title, content_hash, doc_name, status, error, synced_at)
     VALUES (?,?,?,?,?,?,?,NULL,?)
     ON CONFLICT(url) DO UPDATE SET kind=excluded.kind, slug=excluded.slug, title=excluded.title,
       content_hash=excluded.content_hash, doc_name=excluded.doc_name, status=excluded.status, error=NULL, synced_at=excluded.synced_at`,
    url, kind, slug, scrubFormerNames(title, brand), hash, docName, docName ? "ready" : "indexing", Date.now());
  return "uploaded";
}

async function removeVanished(env: Env, store: string, live: Set<string>): Promise<number> {
  if (live.size < 2) return 0; // never purge on a suspiciously tiny list
  const rows = await env.DB_META.prepare("SELECT url, doc_name FROM ai_knowledge_docs").all<{ url: string; doc_name: string | null }>();
  let n = 0;
  for (const r of rows.results || []) {
    if (live.has(r.url)) continue;
    try {
      if (r.doc_name) await deleteDocByName(env, r.doc_name);
      else await deleteDocsByDisplayPrefix(env, store, `${classify(r.url).path} #`);
      await d1Run(env, "DELETE FROM ai_knowledge_docs WHERE url=?", r.url);
      n++;
    } catch (e) {
      await hooks.trackException(env, e, { handled: true, route: "preeti.knowledge.remove_vanished", extra: { url: r.url } });
    }
  }
  return n;
}

// ---------------------------------------------------------------- uploaded agent files

interface AgentFileRow {
  id: string; r2_key: string | null; file_name: string; mime: string | null; doc_name: string | null; status: string;
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function fileFlavor(row: { file_name: string; mime: string | null }): "text" | "html" | "pdf" | "docx" | "other" {
  const ext = (row.file_name.split(".").pop() || "").toLowerCase();
  const mime = (row.mime || "").toLowerCase();
  if (ext === "pdf" || mime === "application/pdf") return "pdf";
  if (ext === "docx" || mime === DOCX_MIME) return "docx";
  if (ext === "html" || ext === "htm" || mime === "text/html") return "html";
  if (["txt", "md", "csv"].includes(ext) || mime.startsWith("text/")) return "text";
  return "other";
}

async function setFileStatus(env: Env, id: string, status: string, error: string | null, docName?: string | null) {
  if (docName === undefined) {
    await d1Run(env, "UPDATE ai_agent_files SET status=?, error=?, updated_at=? WHERE id=?", status, error, Date.now(), id);
  } else {
    await d1Run(env, "UPDATE ai_agent_files SET status=?, error=?, doc_name=?, updated_at=? WHERE id=?", status, error, docName, Date.now(), id);
  }
}

export async function indexAgentFile(env: Env, fileId: string): Promise<void> {
  try {
    const row = await env.DB_META.prepare("SELECT id, r2_key, file_name, mime, doc_name, status FROM ai_agent_files WHERE id=?")
      .bind(fileId).first<AgentFileRow>();
    if (!row) return;
    await setFileStatus(env, fileId, "indexing", null);
    const obj = await env.DIGITAL.get(row.r2_key || `preeti/files/${fileId}`);
    if (!obj) throw new Error("file object missing in storage");
    const size = obj.size;
    if (size > MAX_FILE_BYTES) throw new Error(`file too large (${size} bytes, max ${MAX_FILE_BYTES})`);
    const flavor = fileFlavor(row);
    if (flavor === "other") throw new Error("unsupported file type (use txt, md, csv, html, pdf or docx)");
    const brand = await currentBrand(env);
    let bytes: Uint8Array; let mime: string;
    if (flavor === "pdf") { bytes = new Uint8Array(await obj.arrayBuffer()); mime = "application/pdf"; }
    else if (flavor === "docx") { bytes = new Uint8Array(await obj.arrayBuffer()); mime = DOCX_MIME; }
    else {
      let text = await obj.text();
      if (flavor === "html") text = await htmlToReadableText(text);
      text = scrubFormerNames(text, brand).slice(0, MAX_TEXT_CHARS * 4);
      if (!text.trim()) throw new Error("file has no readable text");
      bytes = new TextEncoder().encode(text); mime = "text/plain";
    }
    const store = await ensurePreetiStore(env);
    const display = `file:${row.file_name.slice(0, 60)} #${fileId.slice(0, 8)}`;
    const docName = await uploadDoc(env, store, display, mime, bytes,
      { kind: "file", slug: fileId, title: scrubFormerNames(row.file_name, brand) });
    if (row.doc_name && row.doc_name !== docName) await deleteDocByName(env, row.doc_name).catch((e) =>
      hooks.trackException(env, e, { handled: true, route: "preeti.knowledge.file_replace_delete", extra: { fileId } }));
    await setFileStatus(env, fileId, "ready", null, docName);
    await hooks.track(env, "server", "preeti_knowledge_sync", "worker", { source: "agent_file", uploaded: 1, flavor });
  } catch (e) {
    await hooks.trackException(env, e, { handled: true, route: "preeti.knowledge.index_file", extra: { fileId } });
    await setFileStatus(env, fileId, "failed", String((e as Error)?.message || e).slice(0, 300)).catch(() => null);
  }
}

export async function removeAgentFile(env: Env, fileId: string): Promise<void> {
  const row = await env.DB_META.prepare("SELECT id, r2_key, file_name, doc_name FROM ai_agent_files WHERE id=?")
    .bind(fileId).first<{ id: string; r2_key: string | null; file_name: string; doc_name: string | null }>();
  if (!row) return;
  try {
    if (row.doc_name) await deleteDocByName(env, row.doc_name);
    else {
      const store = await ensurePreetiStore(env);
      await deleteDocsByDisplayPrefix(env, store, `file:${row.file_name.slice(0, 60)} #${fileId.slice(0, 8)}`);
    }
  } catch (e) {
    await hooks.trackException(env, e, { handled: true, route: "preeti.knowledge.remove_file_doc", extra: { fileId } });
  }
  try { await env.DIGITAL.delete(row.r2_key || `preeti/files/${fileId}`); }
  catch (e) { await hooks.trackException(env, e, { handled: true, route: "preeti.knowledge.remove_file_r2", extra: { fileId } }); }
  await d1Run(env, "DELETE FROM ai_agent_files WHERE id=?", fileId);
}

/** Called by Agent C after a brand change. Returns how many files were flagged / re-indexed. */
export async function markFilesForBrandReview(env: Env): Promise<{ flagged: number; reindexed: number }> {
  const rows = await env.DB_META.prepare("SELECT id, file_name, mime, status FROM ai_agent_files WHERE status IN ('ready','failed','needs_review')")
    .all<{ id: string; file_name: string; mime: string | null; status: string }>();
  let flagged = 0; let reindexed = 0;
  for (const r of rows.results || []) {
    const f = fileFlavor(r);
    if (f === "pdf" || f === "docx") {
      await setFileStatus(env, r.id, "needs_review", "Brand changed: check this file for the old name, then re-upload if needed.");
      flagged++;
    } else if (f === "text" || f === "html") {
      if (reindexed >= 20) continue; // bounded per call; the rest stay as-is
      await indexAgentFile(env, r.id);
      reindexed++;
    }
  }
  return { flagged, reindexed };
}

// ---------------------------------------------------------------- daily maintenance

function istDay(ms = Date.now()): string {
  return new Date(ms + 330 * 60 * 1000).toISOString().slice(0, 10);
}

export async function runPreetiDailyMaintenance(env: Env): Promise<void> {
  try {
    const today = istDay();
    const last = await env.TOKENS.get(KV_MAINT_DAY).catch(() => null);
    const pending = await knowledgeSyncPending(env);
    if (last === today && !pending) return;

    let syncDone = true;
    try {
      const r = await syncSiteKnowledge(env, {});
      syncDone = !(await knowledgeSyncPending(env)) && r.failed === 0;
    } catch (e) {
      syncDone = false;
      await hooks.trackException(env, e, { handled: true, route: "preeti.maintenance.sync" });
    }

    if (last !== today) {
      try {
        const cutoff = Date.now() - RETENTION_MS;
        const m = await d1Run(env, "DELETE FROM ai_messages WHERE created_at < ?", cutoff);
        const c = await d1Run(env,
          `DELETE FROM ai_conversations WHERE created_at < ?
             AND NOT EXISTS (SELECT 1 FROM ai_messages m WHERE m.conversation_id = ai_conversations.id)`, cutoff);
        await hooks.track(env, "server", "preeti_knowledge_sync", "worker", {
          source: "retention", messages_deleted: m.meta?.changes ?? 0, conversations_deleted: c.meta?.changes ?? 0,
        });
      } catch (e) {
        await hooks.trackException(env, e, { handled: true, route: "preeti.maintenance.retention" });
      }
    }
    // Mark the day done only when the sync finished cleanly; otherwise the next cron tick retries/continues.
    if (syncDone) await env.TOKENS.put(KV_MAINT_DAY, today, { expirationTtl: 3 * 24 * 3600 });
  } catch (e) {
    await hooks.trackException(env, e, { handled: true, route: "preeti.maintenance" });
  }
}
