/* [HF-INTRO-P] Pre-download the first ~1.5 MB (about 5 s) of the next intro videos while the current one plays, so the next
 * reel starts from the browser's HTTP cache (the public media host sends public, max-age=31536000, immutable and the MP4s are
 * faststart, so a partial range is playable). Low priority, at most 5 requests at once, skipped on Data Saver / 2G,
 * once per URL per page session. */
import { isIntro, type ReelItem } from './hfExplore';

const RANGE_BYTES = 1_500_000;
const MAX_REELS = 5;
const MAX_ACTIVE = 5;

const seen = new Set<string>();
const queue: Array<{ url: string; video: boolean }> = [];
let active = 0;

/** Was this URL already queued for pre-download (telemetry `prefetched` on hf_reel_start)? */
export function wasPrefetched(url: string | null | undefined): boolean { return !!url && seen.has(url); }

function slowNetwork(): boolean {
  const c = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return !!c && (c.saveData === true || c.effectiveType === 'slow-2g' || c.effectiveType === '2g');
}

async function one(url: string, video: boolean): Promise<void> {
  const init: RequestInit & { priority?: string } = { priority: 'low', credentials: 'omit' };
  if (video) init.headers = { Range: `bytes=0-${RANGE_BYTES - 1}` };
  let res: Response;
  try { res = await fetch(url, init); }
  catch { await fetch(url, { ...init, mode: 'no-cors' }); return; } // no CORS on the media host: an opaque fetch still fills the cache
  if (!res.body) { await res.arrayBuffer(); return; }
  const rd = res.body.getReader();
  let n = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) return;
    n += value.length;
    if (video && n >= RANGE_BYTES) { void rd.cancel(); return; } // a server that ignores Range: stop at the budget
  }
}

function pump(): void {
  while (active < MAX_ACTIVE && queue.length) {
    const job = queue.shift()!;
    active++;
    void one(job.url, job.video).catch(() => undefined).finally(() => { active--; pump(); });
  }
}

/** Queue the videos + posters of the next intro reels in [next] (nearest first). */
export function prefetchIntros(next: ReelItem[]): void {
  try {
    if (typeof navigator === 'undefined' || typeof fetch !== 'function' || slowNetwork()) return;
    let reels = 0;
    for (const it of next) {
      if (reels >= MAX_REELS) break;
      if (!isIntro(it)) continue;
      reels++;
      if (it.videoUrl && !seen.has(it.videoUrl)) { seen.add(it.videoUrl); queue.push({ url: it.videoUrl, video: true }); }
      if (it.posterUrl && !seen.has(it.posterUrl)) { seen.add(it.posterUrl); queue.push({ url: it.posterUrl, video: false }); }
    }
    pump();
  } catch { /* a pre-download must never break playback */ }
}
