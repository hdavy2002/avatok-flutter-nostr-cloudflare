/**
 * GlassWake — a colourless, refractive glass smear that lags behind the cursor
 * on the avatok.ai home page, then melts away when the pointer stops.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS CSS AND NOT A CANVAS UI COMPONENT
 *
 * This replaced a Canvas UI <Liquid> canvas (removed 2026-08-07 along with its
 * Droplets rain layer). Those components render into WebGL, and WebGL cannot see
 * the page behind the canvas — the only way they refract anything is the
 * EXPERIMENTAL html-in-canvas API (`ctx.drawElementImage`, Chrome-only behind
 * chrome://flags#enable-html-in-canvas), which no shipping browser exposes. Their
 * fallback branch can therefore only paint a flat tint, which is exactly why the
 * old overlay had to be coloured and never looked like glass.
 *
 * `backdrop-filter` samples the real, live backdrop, so it gives genuine
 * refraction of the actual page today, in every current browser, with no tint at
 * all. That is the whole reason for the technique switch.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Motion: a classic follow-the-leader chain. Blob 0 eases toward the live pointer
 * and blob N eases toward blob N-1, so the wake stretches when the cursor moves
 * fast and pools when it slows. Blobs shrink and thin along the chain.
 *
 * Cost control — `backdrop-filter` is expensive (each blob re-filters the region
 * of the page behind it), so:
 *   - the chain is short (BLOB_COUNT),
 *   - blobs move by `transform` only, which stays on the compositor,
 *   - the rAF loop stops and the layer is hidden entirely once the pointer rests,
 *   - coarse pointers and `prefers-reduced-motion` opt out completely.
 */
import { useEffect, useRef } from 'react';

/** Length of the wake. Each blob is its own backdrop-filter layer — keep this small. */
const BLOB_COUNT = 9;

/** Head diameter in px; each subsequent blob shrinks by SIZE_STEP. */
const HEAD_SIZE = 156;
const SIZE_STEP = 13;

/** Backdrop blur in px at the head, thinning along the tail. "Thick glass" lives here. */
const HEAD_BLUR = 20;
const BLUR_STEP = 1.4;

/** How hard each blob chases its target, per frame. Lower = more lag, longer smear. */
const HEAD_EASE = 0.34;
const TAIL_EASE = 0.28;

/** Milliseconds of stillness before the glass fades out, and the fade duration. */
const IDLE_MS = 650;
const FADE_MS = 420;

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
  const blobRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (window.matchMedia(SKIP_COARSE).matches) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // No backdrop-filter means no refraction, and a plain blurred disc would just
    // look like a smudge. Render nothing rather than something worse.
    if (!supportsBackdropFilter()) return;

    const blobs = blobRefs.current.filter((b): b is HTMLDivElement => b !== null);
    if (blobs.length === 0) return;

    // Chain state. Seeded off-screen so the wake never flashes at 0,0 on first move.
    const points = Array.from({ length: blobs.length }, () => ({ x: -9999, y: -9999 }));
    const target = { x: -9999, y: -9999 };
    let seeded = false;

    let raf = 0;
    let running = false;
    let visible = false;
    let idleTimer = 0;

    const show = () => {
      if (visible) return;
      visible = true;
      host.style.visibility = 'visible';
      host.style.opacity = '1';
    };

    const hide = () => {
      if (!visible) return;
      visible = false;
      host.style.opacity = '0';
      // Drop the layers entirely once faded, so idle pages pay nothing for the
      // backdrop-filter compositing.
      window.setTimeout(() => {
        if (!visible) host.style.visibility = 'hidden';
      }, FADE_MS);
    };

    const frame = () => {
      let moved = false;

      for (let i = 0; i < points.length; i++) {
        const point = points[i];
        const goal = i === 0 ? target : points[i - 1];
        const ease = i === 0 ? HEAD_EASE : TAIL_EASE;
        const dx = goal.x - point.x;
        const dy = goal.y - point.y;
        if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) moved = true;
        point.x += dx * ease;
        point.y += dy * ease;
        blobs[i].style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`;
      }

      // Once the whole chain has caught up there is nothing left to animate.
      if (!moved) {
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

      // First sighting: drop the entire chain onto the cursor so the wake grows
      // out of the pointer instead of whipping across the page from off-screen.
      if (!seeded) {
        seeded = true;
        for (const point of points) {
          point.x = target.x;
          point.y = target.y;
        }
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
      cancelAnimationFrame(raf);
    };
  }, []);

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
      {Array.from({ length: BLOB_COUNT }).map((_, i) => {
        const size = HEAD_SIZE - i * SIZE_STEP;
        const blur = Math.max(HEAD_BLUR - i * BLUR_STEP, 4);
        // Head sits on top so the thickest part of the glass reads as the front of
        // the smear rather than being buried under the tail.
        const depth = BLOB_COUNT - i;
        return (
          <div
            key={i}
            ref={(el) => {
              blobRefs.current[i] = el;
            }}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: size,
              height: size,
              // The blob is positioned by transform at the raw pointer coordinate,
              // so pull it back by half its size to centre it on the cursor.
              margin: `${-size / 2}px 0 0 ${-size / 2}px`,
              borderRadius: '50%',
              zIndex: depth,
              // No colour anywhere in here — only blur, a touch of saturation and a
              // lift in brightness, which is what clear glass does to what's behind it.
              backdropFilter: `blur(${blur}px) saturate(1.4) brightness(1.06) contrast(1.04)`,
              WebkitBackdropFilter: `blur(${blur}px) saturate(1.4) brightness(1.06) contrast(1.04)`,
              // Specular rim: a bright top-left edge and a soft bottom-right shadow
              // is what makes a blurred disc read as a THICK lens rather than a smudge.
              boxShadow:
                'inset 2px 3px 7px rgba(255,255,255,0.62), inset -3px -4px 11px rgba(0,0,0,0.10)',
              // Feather the edge so neighbouring blobs melt into one smear instead of
              // reading as a string of hard circles.
              maskImage:
                'radial-gradient(circle, rgba(0,0,0,1) 38%, rgba(0,0,0,0.6) 70%, rgba(0,0,0,0) 100%)',
              WebkitMaskImage:
                'radial-gradient(circle, rgba(0,0,0,1) 38%, rgba(0,0,0,0.6) 70%, rgba(0,0,0,0) 100%)',
              willChange: 'transform',
            }}
          />
        );
      })}
    </div>
  );
}
