// [HF-MERCH-QA-1 2026-10-24] The automatic image check for merch art that was too big to scan when it was uploaded.
// Root cause: saveMerchArt only scans files up to 4 MB (the model reads the image inline). Studio exports and AI pictures are 2048 px PNGs of 5-7 MB,
// so they were always stored as moderation='unscanned' and the admin saw "The automatic image check did not run". At product creation we now ask
// Cloudflare Images for a small JPEG copy of the print preview (or the art) and scan that. Bounded; never throws; a failure keeps 'unscanned'.
import type { Env } from "../types";
import { moderateGeneratedImage } from "./moderation";
import { parseImageInfo } from "./studio_logic";

/** Moderation reads the image inline; bigger files are admin-reviewed instead of scanned. */
export const SCAN_MAX_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12_000;
const SCAN_TIMEOUT_MS = 20_000;

export type ScanOutcome = { moderation: "ok"; blocked: false; source: string } | { moderation: "blocked"; blocked: true; label: string; source: string } | { moderation: "unscanned"; blocked: false; reason: string };
export type ScanDeps = {
  fetcher: typeof fetch;
  scan: (env: Env, uid: string, bytes: Uint8Array) => Promise<{ ok: boolean; blocked: boolean; label: string }>;
};
const defaultDeps: ScanDeps = { fetcher: (...a) => fetch(...a), scan: moderateGeneratedImage };

/** Fetch a small JPEG copy of `url` through Cloudflare Images. Null when the copy cannot be made or is still too big. */
async function smallCopy(url: string, fetcher: typeof fetch): Promise<Uint8Array | null> {
  try {
    const r = await fetcher(url, { cf: { image: { width: 1024, height: 1024, fit: "scale-down", format: "jpeg", quality: 85, background: "#FFFFFF" } }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) } as RequestInit);
    if (!r.ok) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > SCAN_MAX_BYTES || !parseImageInfo(bytes)) return null;
    return bytes;
  } catch { return null; }
}

/** Scan the first picture that can be read (print preview first: it is what gets printed). Never throws. */
export async function scanDesignImage(env: Env, uid: string, urls: Array<string | null | undefined>, deps: ScanDeps = defaultDeps): Promise<ScanOutcome> {
  const list = [...new Set(urls.filter((u): u is string => typeof u === "string" && /^https:\/\//.test(u)))];
  if (!list.length) return { moderation: "unscanned", blocked: false, reason: "no_image" };
  for (const url of list) {
    const bytes = await smallCopy(url, deps.fetcher);
    if (!bytes) continue;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        deps.scan(env, uid, bytes),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), SCAN_TIMEOUT_MS); }),
      ]);
      if (!res || !res.ok) return { moderation: "unscanned", blocked: false, reason: res ? "scan_error" : "scan_timeout" };
      return res.blocked ? { moderation: "blocked", blocked: true, label: res.label, source: url } : { moderation: "ok", blocked: false, source: url };
    } catch {
      return { moderation: "unscanned", blocked: false, reason: "scan_error" };
    } finally { if (timer) clearTimeout(timer); }
  }
  return { moderation: "unscanned", blocked: false, reason: "no_copy" };
}
