/**
 * GlassWake — a colourless, refractive slug of glass that lags behind the cursor
 * on the avatok.ai home page, stretching into a smear when you move fast and
 * pooling back into a lens when you slow down. It melts away when the pointer rests.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS CSS AND NOT A CANVAS UI COMPONENT
 *
 * This replaced a Canvas UI <Liquid> canvas (removed 2026-08-07 along with its
 * Droplets rain layer). Those components render into WebGL, and WebGL cannot see
 * the page behind the canvas — the only way they refract anything is the
 * EXPERIMENTAL html-in-canvas API (`ctx.drawElementImage`, Chrome-only behind
 * chrome://flags#enable-html-in-canvas), which no shipping browser exposes. Their
 * fallback branch can only paint a flat tint, which is exactly why the old overlay
 * had to be coloured and never looked like glass.
 *
 * `backdrop-filter` samples the real, live backdrop, so it refracts the actual page
 * today, in every current browser, with no tint at all.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY ONE ELEMENT AND NOT A CHAIN
 *
 * The first cut of this file was a nine-blob follow-the-leader chain, each blob its
 * own `backdrop-filter` layer. It FROZE THE RENDERER under a fast pointer during
 * testing — every layer re-filters the region of the page behind it, and the hero
 * has full-bleed photography under it. `backdrop-filter` is one of the most
 * expensive things you can composite; treat each one as a real cost.
 *
 * So the wake is a SINGLE layer that deforms: it is scaled along its direction of
 * travel by the pointer's speed and squashed across it (constant-ish area, the way
 * a liquid drop behaves), and eased toward the cursor so it always trails. One
 * compositor layer, transform-only animation, no per-frame filter changes.
 */
import { useEffect, useRef } from 'react';

/** Resting diameter of the lens, in px. */
const SIZE = 190;

/** Backdrop blur in px. This is the "thickness" dial. */
const BLUR = 22;

/** How hard the glass chases the cursor per frame. Lower = more lag, longer smear. */
const EASE = 0.16;

/** Pointer speed (px/frame) that produces maximum stretch. */
const SPEED_FOR_MAX_STRETCH = 55;

/** Max elongation along the direction of travel, and the matching cross-axis squash. */
const MAX_STRETCH = 1.15;
const MAX_SQUASH = 0.4;

/** Milliseconds of stillness before the glass fades out, and the fade duration. */
const IDLE_MS = 700;
const FADE_MS = 450;

const SKIP_COARSE = '(pointer: coarse)';

function supportsBackdropFilter(): boolean {
  if (typeof CSS === 'undefined' || !CSS.supports) return false;
  return (
    CSS.supports('backdrop-filter', 'blur(2px)') ||
    CSS.supports('-webkit-backdrop-filter', 'blur(2px)')
  );
}

export default function GlassWake() {
  const hostRef = useRef<HTMLDivElement>(null);
  const lensRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const lens = lensRef.current;
    if (!host || !lens) return;
    if (window.matchMedia(SKIP_COARSE).matches) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // No backdrop-filter means no refraction, and a plain blurred disc would just
    // look like a smudge. Render nothing rather than something worse.
    if (!supportsBackdropFilter()) return;

    // Seeded off-screen so the lens never flashes at 0,0 before the first move.
    const pos = { x: -9999, y: -9999 };
    const target = { x: -9999, y: -9999 };
    let angle = 0;
    let stretch = 0;
    let seeded = false;

    let raf = 0;
    let running = false;
    let visible = false;
    let idleTimer = 0;
    let hideTimer = 0;

    const show = () => {
      if (visible) return;
      visible = true;
      window.clearTimeout(hideTimer);
      host.style.visibility = 'visible';
      host.style.opacity = '1';
    };

    const hide = () => {
      if (!visible) return;
      visible = false;
      host.style.opacity = '0';
      // Drop the layer entirely once faded, so an idle page pays nothing for
      // backdrop-filter compositing.
      hideTimer = window.setTimeout(() => {
        if (!visible) host.style.visibility = 'hidden';
      }, FADE_MS);
    };

    const frame = () => {
      const dx = target.x - pos.x;
      const dy = target.y - pos.y;
      const stepX = dx * EASE;
      const stepY = dy * EASE;
      pos.x += stepX;
      pos.y += stepY;

      const speed = Math.hypot(stepX, stepY);
      // Only re-aim while actually moving; below this the angle is noise and the
      // lens would spin on the spot as it settles.
      if (speed > 0.6) angle = Math.atan2(stepY, stepX);

      // Ease the deformation itself so the glass looks viscous rather than snapping
      // between shapes.
      const wanted = Math.min(speed / SPEED_FOR_MAX_STRETCH, 1);
      stretch += (wanted - stretch) * 0.2;

      const along = 1 + stretch * MAX_STRETCH;
      const across = 1 - stretch * MAX_SQUASH;
      lens.style.transform =
        `translate3d(${pos.x}px, ${pos.y}px, 0) rotate(${angle}rad) scale(${along}, ${across})`;

      // Settled: nothing left to animate until the next pointer move.
      if (Math.abs(dx) < 0.2 && Math.abs(dy) < 0.2 && stretch < 0.01) {
        running = false;
        return;
      }
      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(frame);
    };

    const onPointerMove = (event: PointerEvent) => {
      target.x = event.clientX;
      target.y = event.clientY;

      // First sighting: drop the lens onto the cursor so it grows out of the
      // pointer instead of whipping across the page from off-screen.
      if (!seeded) {
        seeded = true;
        pos.x = target.x;
        pos.y = target.y;
      }

      show();
      start();
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(hide, IDLE_MS);
    };

    const onPointerOut = () => {
      window.clearTimeout(idleTimer);
      hide();
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerleave', onPointerOut, { passive: true });
    window.addEventListener('pointercancel', onPointerOut, { passive: true });
    window.addEventListener('blur', onPointerOut);

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onPointerOut);
      window.removeEventListener('pointercancel', onPointerOut);
      window.removeEventListener('blur', onPointerOut);
      window.clearTimeout(idleTimer);
      window.clearTimeout(hideTimer);
      cancelAnimationFrame(raf);
    };
  }, []);

  const glass = `blur(${BLUR}px) saturate(1.45) brightness(1.07) contrast(1.04)`;

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        // Above the page content but below the sticky nav (z-index:100 in
        // src/landing/avatok-landing.html) so the nav stays crisp and legible.
        zIndex: 90,
        // Never intercept a click: the waitlist form and every nav link sit under this.
        pointerEvents: 'none',
        visibility: 'hidden',
        opacity: 0,
        transition: `opacity ${FADE_MS}ms ease-out`,
      }}
    >
      <div
        ref={lensRef}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: SIZE,
          height: SIZE,
          // Positioned by transform at the raw pointer coordinate, so pull back by
          // half the size to centre it on the cursor.
          margin: `${-SIZE / 2}px 0 0 ${-SIZE / 2}px`,
          borderRadius: '50%',
          // No colour anywhere: only blur, a little saturation and a lift in
          // brightness — what clear glass actually does to what is behind it.
          backdropFilter: glass,
          WebkitBackdropFilter: glass,
          // Specular rim. A bright top-left edge against a soft bottom-right shadow
          // is what makes a blurred disc read as a THICK lens instead of a smudge.
          boxShadow:
            'inset 3px 4px 10px rgba(255,255,255,0.7), inset -4px -6px 14px rgba(0,0,0,0.12)',
          // Feather the edge so the glass melts into the page rather than ending on
          // a hard circle.
          maskImage:
            'radial-gradient(circle, rgba(0,0,0,1) 40%, rgba(0,0,0,0.62) 72%, rgba(0,0,0,0) 100%)',
          WebkitMaskImage:
            'radial-gradient(circle, rgba(0,0,0,1) 40%, rgba(0,0,0,0.62) 72%, rgba(0,0,0,0) 100%)',
          willChange: 'transform',
        }}
      />
    </div>
  );
}
