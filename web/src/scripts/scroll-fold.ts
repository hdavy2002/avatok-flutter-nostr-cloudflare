/**
 * scroll-fold — the avatok.ai home page spreads fold away over the viewport edges
 * as you scroll, like pages turning over the lip of a cube.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS CSS 3D AND NOT CANVAS UI'S <Bend>
 *
 * Bend does exactly this, and does it better, but it is unusable here: its shader
 * ends on `outColor = vec4(mix(uBg, base.rgb, alpha * base.a), uCover)` where
 * `uCover = htmlInCanvas ? 1 : 0`. Without the EXPERIMENTAL html-in-canvas API
 * (`ctx.drawElementImage` + `canvas.requestPaint`) the output alpha is ZERO — the
 * canvas renders nothing at all. Unlike Liquid and Droplets, which at least
 * degraded to a flat tint, Bend has no fallback whatsoever.
 *
 * That API is not available in any shipping browser (probed 2026-08-07 on Chrome
 * 151: both `drawElementImage` and `requestPaint` are `undefined`). Bend also
 * requires the entire scrollable page to live inside its capture container, and it
 * then rewrites every `:hover` rule in the document, intercepts and re-dispatches
 * clicks at remapped coordinates, and reimplements text selection by hand — a lot
 * of risk on a page carrying a live waitlist form, for zero visible payoff.
 *
 * So: same gesture, plain CSS 3D transforms, works everywhere today.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * SAFETY NOTES for anyone extending this
 *
 * - `perspective` is applied PER ELEMENT (`transform: perspective(...)`) rather
 *   than on an ancestor. An ancestor `perspective` would become the containing
 *   block for descendant `position: fixed` elements — that would rip the fixed nav
 *   out of the viewport. Do not move it up the tree.
 * - Verified before shipping: `.nav` is a direct child of `<body>`, OUTSIDE
 *   `<main>`, and it is the only `position: fixed` element on the page. Nothing
 *   uses `position: sticky`. If either changes, re-check this file — a transformed
 *   ancestor breaks both.
 * - Transforms never affect layout, so the page's `scroll-snap-align` positions
 *   and section heights are untouched.
 * - The transform is REMOVED (not set to `none`) once a section is flat, so
 *   sections in the middle of the viewport carry no stacking context, no
 *   compositing layer and no risk of softened text.
 */

/** How deep into the viewport, in px, the fold zone reaches from each edge. */
const ZONE_MAX = 300;

/** Fraction of viewport height the fold zone may occupy on short screens. */
const ZONE_VH = 0.32;

/** Maximum fold angle in degrees. Bend uses 80 for a true cube edge; this page has
 *  to stay readable, so it folds far enough to feel like paper and no further. */
const ANGLE = 24;

/** How far the folded edge is pushed back at full fold, in px. */
const DEPTH = 70;

/** Perspective focal length in px. Smaller pinches the fold harder. */
const PERSPECTIVE = 1500;

/** Opacity removed at full fold, so folded spreads recede rather than just tilt. */
const FADE = 0.4;

/** Extra margin, in px, beyond which a spread is fully off-screen and reset. */
const OFFSCREEN_MARGIN = 48;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Smoothstep, so the fold starts and finishes gently instead of hinging linearly. */
const smooth = (x: number): number => x * x * (3 - 2 * x);

function clear(el: HTMLElement): void {
  if (!el.style.transform) return;
  el.style.transform = '';
  el.style.transformOrigin = '';
  el.style.opacity = '';
  el.style.willChange = '';
}

export function initScrollFold(): void {
  const spreads = Array.from(document.querySelectorAll<HTMLElement>('main .spread'));
  if (spreads.length === 0) return;

  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let ticking = false;

  const update = (): void => {
    ticking = false;

    if (motion.matches) {
      spreads.forEach(clear);
      return;
    }

    const vh = window.innerHeight;
    const zone = Math.max(1, Math.min(ZONE_MAX, vh * ZONE_VH));

    for (const el of spreads) {
      const rect = el.getBoundingClientRect();

      // Fully past either edge: nothing to draw, and leaving a stale transform on
      // it would keep a compositing layer alive for no reason.
      if (rect.bottom < -OFFSCREEN_MARGIN || rect.top > vh + OFFSCREEN_MARGIN) {
        clear(el);
        continue;
      }

      // `leaving` ramps 0 → 1 as the spread's BOTTOM edge crosses up through the
      // top fold zone; `entering` ramps 0 → 1 as its TOP edge sits below the
      // bottom fold zone. A spread in the middle of the viewport has both at 0.
      const leaving = smooth(clamp01((zone - rect.bottom) / zone));
      const entering = smooth(clamp01((rect.top - (vh - zone)) / zone));

      if (leaving < 0.001 && entering < 0.001) {
        clear(el);
        continue;
      }

      // A tall spread can technically be in both zones at once; the nearer edge wins.
      const foldingAtTop = leaving >= entering;
      const amount = foldingAtTop ? leaving : entering;

      // Hinge on the edge nearest the viewport boundary and rotate the far edge
      // away from the viewer: positive rotateX tips the top back, negative the bottom.
      el.style.transformOrigin = foldingAtTop ? 'center bottom' : 'center top';
      el.style.transform =
        `perspective(${PERSPECTIVE}px) translateZ(${(-DEPTH * amount).toFixed(2)}px) ` +
        `rotateX(${((foldingAtTop ? ANGLE : -ANGLE) * amount).toFixed(2)}deg)`;
      el.style.opacity = (1 - FADE * amount).toFixed(3);
      el.style.willChange = 'transform, opacity';
    }
  };

  const schedule = (): void => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(update);
  };

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('orientationchange', schedule, { passive: true });
  motion.addEventListener('change', schedule);

  update();
}

initScrollFold();
