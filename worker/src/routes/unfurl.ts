// Link previews + inline YouTube (AI Messenger Batch — STREAM C, [PREVIEW-1]).
//
//   GET /api/unfurl?url=<encoded>   → auth required → {type,...} preview JSON
//
// The SENDER's client calls this at compose time and embeds the returned data
// inside the message envelope (preview:{...}); recipients render from the
// envelope and NEVER hit this endpoint (zero recipient fetch, no leak of who
// opened what). Results are cached in KV (env.TOKENS) under
// `unfurl:<sha256(url)>` — 7 days on success, 1 hour on failure.
//
// SSRF hardening: only http/https, only ports 80/443, reject literal IPs,
// localhost / *.local, and private/reserved IP ranges. Fetch is capped at a
// 5s timeout and a 512KB read so a hostile page can't hang or OOM the Worker.
//
// YouTube (watch / youtu.be / shorts) is special-cased to the keyless oEmbed
// endpoint and returns {type:"youtube", video_id, title, thumb} so the client
// can render an inline player. Instagram (and anything that blocks OG) falls
// back to {type:"link"} with whatever OG we could scrape.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { track, metric } from "../hooks";
import { readConfig } from "./config";

const APP = "avatalk";
const OK_TTL = 7 * 24 * 3600; // 7 days
const FAIL_TTL = 3600;        // 1 hour
const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 512 * 1024; // 512KB
// A normal-browser UA — many sites (incl. IG) return no OG to bot UAs.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface Preview {
  type: "link" | "youtube";
  url: string;
  title?: string;
  description?: string;
  image?: string;
  site_name?: string;
  domain?: string;
  // WhatsApp-parity: a link that points at a video renders a play badge (and a
  // duration pill when the page advertises one) over the thumbnail.
  is_video?: boolean;
  duration?: number; // seconds
  // youtube only
  video_id?: string;
  thumb?: string;
}

// Hosts that serve OpenGraph tags ONLY to the Facebook crawler UA (Instagram,
// Threads, Facebook itself). A browser UA gets a login wall with no og:image —
// which is exactly why an Instagram reel used to render as a bare
// "Instagram / INSTAGRAM.COM" card with no thumbnail.
const FB_CRAWLER_UA =
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
const FB_CRAWLER_HOSTS = [
  "instagram.com", "www.instagram.com",
  "facebook.com", "www.facebook.com", "m.facebook.com", "fb.watch",
  "threads.net", "www.threads.net", "threads.com", "www.threads.com",
];

function uaFor(host: string): string {
  return FB_CRAWLER_HOSTS.includes(host.toLowerCase()) ? FB_CRAWLER_UA : UA;
}

// --------------------------------------------------------------------------
// SSRF guard
// --------------------------------------------------------------------------
function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a > 255 || b > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) return true; // malformed → reject
  if (a === 10) return true;                       // 10.0.0.0/8
  if (a === 127) return true;                      // loopback
  if (a === 0) return true;                        // 0.0.0.0/8
  if (a === 169 && b === 254) return true;         // link-local 169.254/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;         // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true;                        // multicast / reserved
  return false;
}

/** Returns null if the URL is safe to fetch, else a reason string. */
function ssrfCheck(raw: string): { url: URL } | { reason: string } {
  let u: URL;
  try { u = new URL(raw); } catch { return { reason: "bad url" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { reason: "scheme" };
  // Non-80/443 ports are rejected (explicit ports only; default port is "").
  if (u.port && u.port !== "80" && u.port !== "443") return { reason: "port" };
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return { reason: "localhost" };
  if (host.endsWith(".local")) return { reason: "local" };
  if (host === "0.0.0.0" || host === "::" || host === "[::]" || host === "[::1]") return { reason: "loopback" };
  // Bracketed IPv6 literal → reject (can't cheaply verify it's public).
  if (host.startsWith("[")) return { reason: "ipv6-literal" };
  // Literal IPv4 → must not be private/reserved.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    if (isPrivateIPv4(host)) return { reason: "private-ip" };
    // A public literal IP is allowed but unusual; still fine to fetch.
  }
  return { url: u };
}

// --------------------------------------------------------------------------
// YouTube special-case
// --------------------------------------------------------------------------
function youtubeId(u: URL): string | null {
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "youtu.be") {
    const id = u.pathname.split("/").filter(Boolean)[0];
    return id ? id : null;
  }
  if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    if (u.pathname === "/watch") return u.searchParams.get("v");
    const shorts = u.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{6,})/);
    if (shorts) return shorts[1];
    const embed = u.pathname.match(/^\/embed\/([A-Za-z0-9_-]{6,})/);
    if (embed) return embed[1];
  }
  return null;
}

async function unfurlYouTube(u: URL, id: string): Promise<Preview> {
  const oembed =
    "https://www.youtube.com/oembed?format=json&url=" +
    encodeURIComponent(u.toString());
  const base: Preview = {
    type: "youtube",
    url: u.toString(),
    video_id: id,
    // hqdefault always exists even before oEmbed resolves.
    thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    domain: "youtube.com",
    site_name: "YouTube",
    is_video: true,
  };
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    const r = await fetch(oembed, { headers: { "user-agent": UA }, signal: ctl.signal });
    clearTimeout(t);
    if (r.ok) {
      const j = (await r.json().catch(() => ({}))) as any;
      if (j?.title) base.title = String(j.title);
      if (j?.thumbnail_url) base.thumb = String(j.thumbnail_url);
    }
  } catch { /* keep base */ }
  return base;
}

// --------------------------------------------------------------------------
// Generic OG scrape
// --------------------------------------------------------------------------
/** Read at most MAX_BYTES of the body as text (aborts the stream past the cap). */
async function readCapped(r: Response): Promise<string> {
  const reader = r.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) { chunks.push(value); total += value.byteLength; }
  }
  try { await reader.cancel(); } catch { /* ignore */ }
  const buf = new Uint8Array(Math.min(total, MAX_BYTES + 65536));
  let off = 0;
  for (const c of chunks) {
    const slice = c.subarray(0, buf.length - off);
    buf.set(slice, off);
    off += slice.length;
    if (off >= buf.length) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, off));
}

function metaContent(html: string, patterns: RegExp[]): string | undefined {
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return decodeEntities(m[1].trim());
  }
  return undefined;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// og:<prop> — attribute order varies, so match both content-after and content-before.
function ogPatterns(prop: string): RegExp[] {
  const p = prop.replace(/[:]/g, "\\:");
  return [
    new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${p}["']`, "i"),
  ];
}

/** Fetch + read the HTML with a given UA. Returns "" on any failure. */
async function fetchHtml(u: URL, ua: string): Promise<{ html: string; finalUrl: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  let r: Response;
  try {
    r = await fetch(u.toString(), {
      headers: { "user-agent": ua, accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: ctl.signal,
    });
  } catch { clearTimeout(t); return { html: "", finalUrl: u.toString() }; }
  clearTimeout(t);
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  if (!r.ok || !ct.includes("html")) return { html: "", finalUrl: r.url || u.toString() };
  const html = await readCapped(r).catch(() => "");
  return { html, finalUrl: r.url || u.toString() };
}

/** Fill a Preview from OG/Twitter-card meta. Returns true if anything landed. */
function applyMeta(out: Preview, html: string, finalUrl: string): boolean {
  out.title =
    metaContent(html, ogPatterns("og:title")) ??
    metaContent(html, ogPatterns("twitter:title")) ??
    metaContent(html, [/<title[^>]*>([^<]*)<\/title>/i]);
  out.description =
    metaContent(html, ogPatterns("og:description")) ??
    metaContent(html, ogPatterns("twitter:description")) ??
    metaContent(html, ogPatterns("description"));
  out.image =
    metaContent(html, ogPatterns("og:image")) ??
    metaContent(html, ogPatterns("og:image:secure_url")) ??
    metaContent(html, ogPatterns("twitter:image"));
  out.site_name = metaContent(html, ogPatterns("og:site_name"));

  // Video detection → the client paints a play badge over the thumbnail and a
  // duration pill (WhatsApp/Instagram parity).
  const ogType = metaContent(html, ogPatterns("og:type")) ?? "";
  const ogVideo =
    metaContent(html, ogPatterns("og:video")) ??
    metaContent(html, ogPatterns("og:video:url")) ??
    metaContent(html, ogPatterns("og:video:secure_url")) ??
    metaContent(html, ogPatterns("twitter:player"));
  if (/^video/i.test(ogType) || !!ogVideo) out.is_video = true;

  const dur =
    metaContent(html, ogPatterns("og:video:duration")) ??
    metaContent(html, ogPatterns("video:duration"));
  if (dur) {
    const n = Math.round(Number(dur));
    if (Number.isFinite(n) && n > 0 && n < 24 * 3600) out.duration = n;
  }

  // Resolve a relative og:image against the final URL.
  if (out.image) {
    try { out.image = new URL(out.image, finalUrl).toString(); } catch { /* leave */ }
  }
  return !!(out.title || out.image);
}

async function unfurlGeneric(u: URL): Promise<Preview> {
  const host = u.hostname.toLowerCase();
  const out: Preview = { type: "link", url: u.toString(), domain: host.replace(/^www\./, "") };

  const first = await fetchHtml(u, uaFor(host));
  const got = first.html ? applyMeta(out, first.html, first.finalUrl) : false;

  // A browser UA that came back with nothing (login wall, JS-only shell, bot
  // block) gets ONE retry as the Facebook crawler — the UA nearly every social
  // site special-cases to serve full OG tags. This is what turns an Instagram
  // reel from a bare domain chip into a real thumbnail + title card.
  if (!got || !out.image) {
    const ua = uaFor(host);
    if (ua !== FB_CRAWLER_UA) {
      const retry = await fetchHtml(u, FB_CRAWLER_UA);
      if (retry.html) {
        const alt: Preview = { type: "link", url: out.url, domain: out.domain };
        if (applyMeta(alt, retry.html, retry.finalUrl) && (alt.image || !out.title)) {
          // Prefer the richer of the two responses.
          alt.title ??= out.title;
          alt.description ??= out.description;
          alt.image ??= out.image;
          alt.site_name ??= out.site_name;
          return alt;
        }
      }
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// KV cache key
// --------------------------------------------------------------------------
async function cacheKey(url: string): Promise<string> {
  const data = new TextEncoder().encode(url);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `unfurl:${hex}`;
}

// --------------------------------------------------------------------------
// Route: GET /api/unfurl?url=...
// --------------------------------------------------------------------------
export async function unfurl(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: u.error }, u.status);

  // Kill switch (STREAM C). linkPreviewsEnabled defaults ON; the field is read
  // loosely so this route works whether or not the config.ts type has been
  // extended yet (owner of config.ts adds the flag — see engineering report).
  const cfg = (await readConfig(env)) as Record<string, unknown>;
  if (cfg.linkPreviewsEnabled === false) {
    const off: Preview = { type: "link", url: new URL(req.url).searchParams.get("url") ?? "" };
    return json(off, 200, { "cache-control": "private, max-age=60" });
  }

  const raw = new URL(req.url).searchParams.get("url");
  if (!raw) return json({ error: "url required" }, 400);
  if (raw.length > 2048) return json({ error: "url too long" }, 400);

  const key = await cacheKey(raw);

  // KV cache hit — serve without any outbound fetch.
  try {
    const cached = await env.TOKENS.get(key, "json");
    if (cached) {
      track(env, u.uid, "unfurl_requested", APP, {
        type: (cached as Preview).type, cached: true,
      });
      return json(cached, 200, { "cache-control": "private, max-age=300" });
    }
  } catch { /* miss */ }

  const safe = ssrfCheck(raw);
  if ("reason" in safe) {
    metric(env, "unfurl_blocked", [1], [safe.reason]);
    // Blocked URLs render as a plain link on the client (no fetch, no card).
    const blocked: Preview = { type: "link", url: raw };
    return json(blocked, 200, { "cache-control": "private, max-age=300" });
  }

  const yt = youtubeId(safe.url);
  let preview: Preview;
  let failed = false;
  try {
    preview = yt ? await unfurlYouTube(safe.url, yt) : await unfurlGeneric(safe.url);
  } catch {
    preview = { type: "link", url: safe.url.toString(), domain: safe.url.hostname };
    failed = true;
  }
  // A generic link with nothing scraped counts as a "failure" for caching TTL
  // (so a transiently-blocked page is retried within the hour).
  if (preview.type === "link" && !preview.title && !preview.image) failed = true;

  try {
    await env.TOKENS.put(key, JSON.stringify(preview), {
      expirationTtl: failed ? FAIL_TTL : OK_TTL,
    });
  } catch { /* best-effort */ }

  track(env, u.uid, "unfurl_requested", APP, { type: preview.type, cached: false });
  metric(env, "unfurl", [1], [preview.type, failed ? "fail" : "ok"]);
  return json(preview, 200, { "cache-control": "private, max-age=300" });
}
