/**
 * SmokeTrail — soft blue clouds that billow and dissipate behind the cursor on the
 * avatok.ai home page.
 *
 * Built on the Canvas UI "Liquid" component (`@canvas-ui/liquid-react`, vendored at
 * src/components/canvasui/Liquid.tsx — DO NOT edit that file, it is the upstream
 * registry source and is refreshed by `npx shadcn add @canvas-ui/liquid-react`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS DRIVES THE ENGINE DIRECTLY INSTEAD OF USING <Liquid>
 *
 * The home page ships as ONE opaque static document (src/landing/avatok-landing.html,
 * injected via `set:html` in pages/index.astro). There is no React tree to wrap, so
 * the `<Liquid>` children API is unusable — we call `createLiquid()` and render only
 * its output canvas.
 *
 * `createLiquid` auto-detects the html-in-canvas APIs (`ctx.drawElementImage` +
 * `canvas.requestPaint`) and, when it finds them, switches to "capture the DOM and
 * warp it" mode, reading its content from the source canvas. Ours is deliberately
 * empty, so on such a browser the shader would resolve to a fully transparent frame
 * and the smoke would silently vanish. We shadow `requestPaint` to `undefined` so
 * detection is deterministic: every browser gets the same colour-trail path.
 *
 * That matters more than it used to. html-in-canvas is NOT permanently unavailable —
 * it is a Chrome ORIGIN TRIAL (feature `HTMLInCanvas`), which canvasui.dev is enrolled
 * in and avatok.ai is not. If avatok.ai ever registers for that trial, the API would
 * appear at runtime and, without this line, this effect would break on the day the
 * token was added. Verified 2026-08-07: undefined on avatok.ai, a function on
 * canvasui.dev, whose token expires 2026-10-20.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useRef } from 'react';
import { createLiquid, type LiquidInstance } from '../../components/canvasui/Liquid';

/**
 * Liquid's own default trail colour, #253DDD, as the 0..1 sRGB triplet the component
 * ships with. Deliberately NOT a zine token: the palette's `--zine-blue` (#A0F7F1) is
 * the turquoise that was rejected, and `--zine-blueInk` (#007D7F) reads as teal.
 */
const BLUE: [number, number, number] = [0.145, 0.239, 0.867];

/**
 * A full-viewport fragment shader at 60fps is a real battery cost on a phone, and the
 * trail needs a hovering pointer to mean anything, which a touch screen does not have.
 * On coarse pointers we render nothing and leave the landing page alone.
 */
const SKIP_COARSE = '(pointer: coarse)';

/**
 * THE opacity dial.
 *
 * `intensity` below LOOKS like one but is not: the shader computes alpha as
 * (1 - exp(-|flow| * intensity * 0.5)) * 0.82, while the splat pass writes the dye
 * colour as vec3(dx, dy, 10) — that hardcoded 10 in the blue channel pins |flow| high
 * at every splat centre, so the exponential saturates and alpha sits near the 0.82
 * ceiling whatever intensity says. Changing it from 2.4 to 0.9 once produced no
 * visible difference at all. Compositing the whole canvas at reduced opacity is the
 * only exact control. This blue is much darker than the turquoise it replaced, so it
 * needs to sit lower than that version's 0.34.
 */
const TRAIL_OPACITY = 0.26;

export default function SmokeTrail() {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (window.matchMedia(SKIP_COARSE).matches) return;

    const output = canvasRef.current;
    if (!output) return;

    // Detached, never-painted source canvas. See the file header: shadowing
    // `requestPaint` forces the html-in-canvas probe to fail, deterministically.
    const source = document.createElement('canvas');
    Object.defineProperty(source, 'requestPaint', { value: undefined });
    const content = document.createElement('div');

    const liquid: LiquidInstance | null = createLiquid(
      { source, content, output },
      {
        color: BLUE,
        rainbow: false,
        // Tuned for smoke rather than a paint stroke: a wide splat so each puff is
        // soft-edged, a long dissipation so it lingers and billows instead of
        // snapping away, and extra curl so the cloud curls back into itself.
        radius: 0.15,
        densityDissipation: 0.96,
        velocityDissipation: 1,
        curl: 2.8,
        force: 1.0,
        intensity: 0.9,
      },
    );
    // No WebGL2 (or a lost context): leave the page exactly as it was.
    if (!liquid) return;

    // The engine binds its pointer listeners to `output.parentElement`, which here is
    // pointer-events:none (the overlay must never eat a click on the nav or the
    // waitlist form). Those listeners can never fire on their own, so we listen on
    // window and drive the splats ourselves.
    let previous: { x: number; y: number } | null = null;

    const onPointerMove = (event: PointerEvent) => {
      const rect = output.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const last = previous;
      previous = { x, y };
      if (!last) return;
      liquid.splat(x / rect.width, 1 - y / rect.height, x - last.x, -(y - last.y));
    };

    const onPointerOut = () => {
      previous = null;
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerleave', onPointerOut, { passive: true });
    window.addEventListener('pointercancel', onPointerOut, { passive: true });

    // The overlay is position:fixed at 100vw/100vh, so a viewport resize changes the
    // backing-store size. The engine watches its canvas with a ResizeObserver, but an
    // explicit resize keeps orientation changes crisp.
    const onResize = () => liquid.resize();
    window.addEventListener('resize', onResize, { passive: true });

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onPointerOut);
      window.removeEventListener('pointercancel', onPointerOut);
      window.removeEventListener('resize', onResize);
      liquid.destroy();
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
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          opacity: TRAIL_OPACITY,
        }}
      />
    </div>
  );
}
