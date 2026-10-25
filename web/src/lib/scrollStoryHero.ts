// [HF-SCROLL-HERO-1 2026-10-25] Scroll-controlled video hero on the homepage.
// Scroll position -> target time -> smoothed time -> ONE controlled seek at a time. Overlays and the
// closing cover->contain zoom are derived from the time the video is actually SHOWING (set on `seeked`),
// so copy never runs ahead of a slow seek and everything reverses exactly when scrolling back.
// Normal page scrolling is never intercepted: we only listen (passive) and read the section's position.
import { capture, captureException } from './analytics';

interface Scene { id: string; inA: number; inB: number; outA: number; outB: number }
// Timings measured on the supplied film (cuts at 10.78s, 16.76s, 23.22s, 29.36s; 24 fps, 37.33s).
// Every overlay is gone before the next cut and before the camera reaches the phone (~3s).
const SCENES: Scene[] = [
  { id: 'opening', inA: -1, inB: 0, outA: 1.7, outB: 2.5 },
  { id: 'request', inA: 5.3, inB: 5.9, outA: 10.0, outB: 10.6 },
  { id: 'creator', inA: 11.3, inB: 11.9, outA: 16.0, outB: 16.6 },
  { id: 'callback', inA: 17.4, inB: 18.0, outA: 22.4, outB: 23.0 },
  { id: 'private', inA: 23.8, inB: 24.4, outA: 28.5, outB: 29.1 },
  { id: 'together', inA: 30.0, inB: 30.8, outA: 1e6, outB: 1e6 + 1 },
];
const COLLAGE_A = 29.4;          // collage cut -> start easing from cover to contain
const COLLAGE_B = 30.6;          // whole collage visible from here on
const FPS = 24;
const FALLBACK_DURATION = 37.333;
const END_GUARD = 0.06;          // never seek onto the empty frame past the last picture
const STORY_SHARE = 0.9;         // last 10% of the scroll run holds the closing collage
const TAU = 0.085;               // smoothing time constant (s): gentle, no long lag
const PHONE_ASPECT = 1.1;        // [HF-SCROLL-HERO-2] at or below this frame aspect the film fills a portrait screen

/** cover: desktop, film edge to edge with copy on it; phone: full-screen film that follows the person, short copy;
 *  split: short landscape windows, short copy beside the whole film.
 *  Mirrored by the inline script in ScrollStoryHero.astro so the first paint is right. */
export function pickLayout(w: number, h: number): 'cover' | 'phone' | 'split' {
  if (w / Math.max(1, h) < PHONE_ASPECT) return 'phone';
  if (h < 560 || w < 900) return 'split';
  return 'cover';
}

// [HF-SCROLL-HERO-2] Phone: centre of the visible slice (0..1 of the film's width) through the story, so the person
// stays in view. Jumps happen exactly at the cuts; the two-women shot pans from the fan to Arti; the collage pans
// across and settles on its cream middle, where the buttons sit.
const FOCUS: Array<[number, number]> = [[0, .44], [2.2, .44], [3.0, .36], [4.4, .55], [5.4, .73], [10.77, .73], [10.79, .7],
  [16.75, .68], [16.77, .73], [23.21, .73], [23.23, .19], [24.6, .19], [27.8, .79], [29.35, .79], [29.37, .16], [33.2, .84],
  [35.6, .5], [40, .5]];
function focusAt(t: number): number {
  for (let i = 1; i < FOCUS.length; i++) {
    const [t1, x1] = FOCUS[i], [t0, x0] = FOCUS[i - 1];
    if (t <= t1) return x0 + (x1 - x0) * ease((t - t0) / Math.max(1e-3, t1 - t0));
  }
  return .5;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const ease = (v: number) => { const x = clamp(v, 0, 1); return x * x * (3 - 2 * x); };

function sceneOpacity(s: Scene, t: number): number {
  if (t <= s.inA || t >= s.outB) return 0;
  if (t < s.inB) return ease((t - s.inA) / (s.inB - s.inA));
  if (t > s.outA) return 1 - ease((t - s.outA) / (s.outB - s.outA));
  return 1;
}

function once(el: EventTarget, ...names: string[]): Promise<string> {
  return new Promise(resolve => {
    const done = (e: Event) => { names.forEach(n => el.removeEventListener(n, done)); resolve(e.type); };
    names.forEach(n => el.addEventListener(n, done, { once: true }));
  });
}

export function initScrollStoryHero(root: HTMLElement | null = document.querySelector<HTMLElement>('[data-story-hero]')): void {
  if (!root || root.dataset.hfshInit) return;
  root.dataset.hfshInit = '1';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const toStatic = (reason: string, error?: unknown) => {
    if (root.dataset.mode === 'static') return;
    root.dataset.mode = 'static';
    teardown();
    capture('home_scroll_hero_fallback', { reason });
    if (error) captureException(error, { surface: 'home-scroll-hero', reason });
  };
  reduce.addEventListener?.('change', () => { if (reduce.matches) toStatic('reduced_motion_changed'); });
  if (reduce.matches || root.dataset.mode !== 'live') { root.dataset.mode = 'static'; capture('home_scroll_hero_impression', { mode: 'static', reason: 'reduced_motion' }); return; }

  const live = root.querySelector<HTMLElement>('[data-hfsh-live]')!;
  const pin = root.querySelector<HTMLElement>('[data-hfsh-pin]')!;
  const stage = root.querySelector<HTMLElement>('[data-hfsh-stage]')!;
  let video = root.querySelector<HTMLVideoElement>('[data-hfsh-video]')!;
  const scenes = SCENES.map(s => ({ s, el: root.querySelector<HTMLElement>(`[data-scene="${s.id}"]`), o: -1, y: NaN }))
    .filter((x): x is { s: Scene; el: HTMLElement; o: number; y: number } => !!x.el);
  const header = document.querySelector<HTMLElement>('.cv-header');
  const tab = root.querySelector<HTMLElement>('[data-hfsh-tab] span');
  const started = performance.now();

  // ---- geometry (measured on resize only, never inside the scroll handler) ----
  let W = 0, H = 0, run = 1, head = 0, ratio = 16 / 9, layout = root.dataset.layout || 'cover';
  const measure = () => {
    head = header ? Math.round(header.getBoundingClientRect().height) : 0;
    root.style.setProperty('--hfsh-head', head + 'px');
    W = pin.clientWidth; H = pin.clientHeight;
    const next = pickLayout(W, H);
    if (next !== layout) { layout = next; root.dataset.layout = next; H = pin.clientHeight; }
    run = Math.max(1, live.offsetHeight - pin.offsetHeight);
    geo = '';
    wake();
  };

  // ---- time state ----
  let duration = FALLBACK_DURATION;
  let maxT = duration - END_GUARD;
  let target = 0, smooth = 0, shown = 0, requested = -1;
  let ready = false, raf = 0, last = 0, geo = '';
  const reached = new Set<string>();

  const readTarget = () => {
    const top = live.getBoundingClientRect().top;
    const p = clamp((head - top) / run, 0, 1);
    target = Math.min(1, p / STORY_SHARE) * maxT;
  };

  const seek = () => {
    if (!ready || video.seeking) return;
    const want = clamp(Math.round(smooth * FPS) / FPS, 0, maxT);
    if (Math.abs(want - requested) < 0.5 / FPS) return;
    requested = want;
    try { video.currentTime = want; } catch { /* a seek before data is ignored; retried next frame */ requested = -1; }
  };

  const render = () => {
    // Closing collage: ease from edge-to-edge cover to the whole frame (cream letterbox matches the film).
    let sw = W, sh = H, sx = 0, sy = 0;
    if (layout === 'cover' || layout === 'phone') {
      const cover = Math.max(W, H * ratio), contain = Math.min(W, H * ratio);
      if (layout === 'cover') {
        const e = ease((shown - COLLAGE_A) / (COLLAGE_B - COLLAGE_A));
        sw = cover + (contain - cover) * e; sh = sw / ratio; sx = (W - sw) / 2; sy = (H - sh) / 2;
      } else {
        sw = cover; sh = sw / ratio; sy = (H - sh) / 2;
        sx = clamp(W / 2 - focusAt(shown) * sw, W - sw, 0);
      }
      const key = `${sx.toFixed(1)}|${sw.toFixed(1)}|${sh.toFixed(1)}`;
      if (key !== geo) {
        geo = key;
        const st = pin.style;
        st.setProperty('--sx', sx.toFixed(1) + 'px'); st.setProperty('--sy', sy.toFixed(1) + 'px');
        st.setProperty('--sw', sw.toFixed(1) + 'px'); st.setProperty('--sh', sh.toFixed(1) + 'px');
        st.setProperty('--cl', Math.max(0, -sx).toFixed(1) + 'px'); st.setProperty('--ct', Math.max(0, -sy).toFixed(1) + 'px');
      }
    }
    for (const x of scenes) {
      const o = sceneOpacity(x.s, shown);
      const mid = (x.s.inB + x.s.outA) / 2;
      const y = o >= 1 ? 0 : (shown < mid ? (1 - o) * 18 : -(1 - o) * 14);
      if (Math.abs(o - x.o) < 0.004 && Math.abs(y - x.y) < 0.2) continue;
      const wasHidden = x.o <= 0.02;
      x.o = o; x.y = y;
      x.el.style.opacity = o.toFixed(3);
      x.el.style.translate = `0 ${y.toFixed(1)}px`;
      const hidden = o <= 0.02;
      if (hidden !== wasHidden || x.el.dataset.hidden === undefined) {
        x.el.dataset.hidden = hidden ? '1' : '0';
        x.el.querySelectorAll<HTMLAnchorElement>('a').forEach(a => { if (hidden) a.setAttribute('tabindex', '-1'); else a.removeAttribute('tabindex'); });
      }
      if (o > 0.5 && tab && x.el.dataset.tab && tab.textContent !== x.el.dataset.tab) tab.textContent = x.el.dataset.tab;
      if (o > 0.9 && !reached.has(x.s.id)) { reached.add(x.s.id); capture('home_scroll_hero_scene', { scene: x.s.id, index: SCENES.indexOf(x.s) + 1, layout }); }
    }
  };

  // ---- the ONE animation loop: sleeps when settled, woken by scroll / resize / seeked ----
  const frame = (now: number) => {
    raf = 0;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    readTarget();
    const gap = target - smooth;
    smooth = Math.abs(gap) < 0.004 ? target : smooth + gap * (1 - Math.exp(-dt / TAU));
    seek();
    if (!ready) shown = 0;
    render();
    const settled = smooth === target && (!ready || (!video.seeking && Math.abs(requested - clamp(Math.round(smooth * FPS) / FPS, 0, maxT)) < 0.5 / FPS));
    if (!settled) raf = requestAnimationFrame(frame); else last = 0;
  };
  function wake() { if (!raf && root!.dataset.mode === 'live') raf = requestAnimationFrame(frame); }

  // Chain the next seek straight from `seeked` (not a frame later) so the decoder is never idle mid-scrub.
  const onSeeked = () => { shown = video.currentTime; seek(); wake(); };
  const onMeta = () => {
    if (Number.isFinite(video.duration) && video.duration > 1) duration = video.duration;
    if (video.videoWidth && video.videoHeight) ratio = video.videoWidth / video.videoHeight;
    maxT = Math.max(0, duration - END_GUARD);
    ready = true; requested = -1; geo = '';
    wake();
  };
  const onData = () => {
    root.dataset.loading = '0';
    if (!root.dataset.readyLogged) { root.dataset.readyLogged = '1'; uiReady(); }
  };
  const onError = () => { if (!ready) toStatic('video_error', video.error ? new Error(`video error ${video.error.code}`) : undefined); };
  const attach = (v: HTMLVideoElement) => {
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('loadeddata', onData);
    v.addEventListener('error', onError);
    if (v.readyState >= 1) onMeta();
    if (v.readyState >= 2) onData();
  };
  const detach = (v: HTMLVideoElement) => {
    v.removeEventListener('seeked', onSeeked);
    v.removeEventListener('loadedmetadata', onMeta);
    v.removeEventListener('loadeddata', onData);
    v.removeEventListener('error', onError);
  };
  const uiReady = () => capture('home_scroll_hero_ready', { ms: Math.round(performance.now() - started), layout, variant });

  // ---- source: phone-size film for narrow screens, chosen once (no swapping on resize) ----
  // Phones zoom into the film to fill a portrait screen, so they need the sharper file; only split uses the small one.
  const small = layout === 'split' || (layout === 'cover' && innerWidth < 1100);
  const variant = small ? 'small' : 'large';
  const src = (small ? video.dataset.srcSmall : video.dataset.srcLarge) || video.dataset.srcLarge || '';
  // Start with metadata only; ranges stream from the Cloudflare edge if the visitor scrolls early.
  video.preload = 'metadata';
  video.src = src;
  attach(video);

  // Then pull the whole (small) file once and swap to an in-memory copy: every later seek is local,
  // which is what keeps fast and reverse scrubbing smooth on Safari as well as Chrome.
  let upgraded = false;
  const upgrade = async () => {
    if (upgraded) return; upgraded = true;
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (conn?.saveData) { video.preload = 'auto'; return; }
    try {
      const res = await fetch(src, { mode: 'cors', credentials: 'omit' });
      if (!res.ok) throw new Error('video fetch ' + res.status);
      const url = URL.createObjectURL(await res.blob());
      if (root.dataset.mode !== 'live') return;
      const next = video.cloneNode(false) as HTMLVideoElement;
      next.removeAttribute('src');
      next.classList.add('is-incoming');
      next.preload = 'auto'; next.muted = true;
      next.src = url;
      stage.appendChild(next);
      await once(next, 'loadeddata', 'error');
      if (next.error) throw new Error('blob video error');
      next.currentTime = clamp(Math.round(smooth * FPS) / FPS, 0, maxT);
      await once(next, 'seeked');
      const old = video;
      detach(old);
      video = next; requested = next.currentTime; shown = next.currentTime;
      attach(next);
      next.classList.remove('is-incoming');
      old.removeAttribute('src'); old.load(); old.remove();
      capture('home_scroll_hero_buffered', { ms: Math.round(performance.now() - started), variant });
      wake();
    } catch (error) {
      // Streaming keeps working; just make sure the browser buffers it.
      video.preload = 'auto';
      captureException(error, { surface: 'home-scroll-hero', step: 'blob_upgrade' });
    }
  };
  const idle = (cb: () => void) => ('requestIdleCallback' in window) ? (window as Window & { requestIdleCallback: (f: () => void, o?: { timeout: number }) => number }).requestIdleCallback(cb, { timeout: 1200 }) : setTimeout(cb, 400);
  if (document.readyState === 'complete') idle(upgrade); else addEventListener('load', () => idle(upgrade), { once: true });

  // Visitor scrolls before anything is buffered: ask for the data now (some mobile browsers wait otherwise).
  const onScroll = () => {
    if (video.preload !== 'auto' && target > 0.05) video.preload = 'auto';
    wake();
  };
  // Loading state: only if the film is still not ready after a short beat (no flash on fast loads).
  const loadingTimer = setTimeout(() => { if (video.readyState < 2) root.dataset.loading = '1'; }, 700);
  const failTimer = setTimeout(() => { if (!ready) toStatic('metadata_timeout'); }, 15000);

  const ro = new ResizeObserver(() => measure());
  ro.observe(pin); if (header) ro.observe(header);
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', measure, { passive: true });

  function teardown() {
    removeEventListener('scroll', onScroll);
    removeEventListener('resize', measure);
    ro.disconnect();
    clearTimeout(loadingTimer); clearTimeout(failTimer);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    try { detach(video); video.pause(); } catch { /* ignore */ }
  }

  measure();
  capture('home_scroll_hero_impression', { mode: 'live', layout, variant });
}
