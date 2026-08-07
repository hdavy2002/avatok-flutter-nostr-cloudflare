/**
 * LiquidOverlay — a full-page, pointer-driven fluid trail for avatok.ai.
 *
 * Built on the Canvas UI "Liquid" component (`@canvas-ui/liquid-react`, vendored
 * at src/components/canvasui/Liquid.tsx — DO NOT edit that file, it is the
 * upstream registry source and is refreshed by `npx shadcn add @canvas-ui/...`).
 *
 * Why this wrapper exists instead of using <Liquid> directly:
 *
 * 1. The home page ships as ONE opaque static document (src/landing/avatok-landing.html,
 *    injected via `set:html` in pages/index.astro). There is no React tree to wrap,
 *    so the <Liquid> component's `children` API cannot be used at all. We drive the
 *    lower-level `createLiquid()` engine directly and render only its output canvas.
 *
 * 2. `createLiquid` auto-detects the EXPERIMENTAL html-in-canvas APIs
 *    (`ctx.drawElementImage` + `canvas.requestPaint`). When it finds them it switches
 *    to "capture the DOM and warp it" mode and reads its content from the source
 *    canvas. Our source canvas is deliberately empty, so on a browser that HAS those
 *    APIs (Chrome behind chrome://flags#enable-html-in-canvas) the shader would
 *    resolve to a fully transparent frame and the effect would silently vanish.
 *    We therefore shadow `requestPaint` to `undefined` so detection is deterministic:
 *    the overlay always runs in colour-trail mode, identically on every browser.
 *
 * 3. The engine binds its own pointer listeners to `output.parentElement`. Our
 *    overlay is `pointer-events: none` (it must never eat a click on the nav or the
 *    waitlist form), so those listeners would never fire. We listen on `window`
 *    instead and feed the engine through its public `splat()` API.
 *
 * Degrades safely: no WebGL2 → `createLiquid` returns null → nothing renders.
 * `prefers-reduced-motion: reduce` is honoured inside the engine (`splat` no-ops).
 */
import { useEffect, useRef } from 'react';
import { createLiquid, type LiquidInstance } from '../../components/canvasui/Liquid';

/**
 * Trail colour — AvaTOK brand turquoise, in linear-friendly 0..1 sRGB triplets.
 *
 * The zine palette carries two turquoise tokens (web/src/styles/tokens.css):
 *   --zine-blue    #A0F7F1  (light turquoise — surfaces, marks)
 *   --zine-blueInk #007D7F  (deep teal — focus rings, ink)
 *
 * #A0F7F1 alone is too pale to read as a trail over the cream --zine-paper
 * background, and #007D7F reads as navy-teal rather than turquoise. This sits
 * between them (#3EDDD4) so the trail is legible on both the paper sections and
 * the photographic ones. Change this single triplet to retune the colour.
 */
const TURQUOISE: [number, number, number] = [0x3e / 255, 0xdd / 255, 0xd4 / 255];

export default function LiquidOverlay() {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const output = canvasRef.current;
    if (!output) return;

    // Detached, never-painted source canvas. See note 2 in the file header:
    // shadowing `requestPaint` forces the engine's html-in-canvas probe to fail,
    // which is what we want — we only ever use the colour-trail path.
    const source = document.createElement('canvas');
    Object.defineProperty(source, 'requestPaint', { value: undefined });
    const content = document.createElement('div');

    const instance: LiquidInstance | null = createLiquid(
      { source, content, output },
      {
        color: TURQUOISE,
        rainbow: false,
        // Slightly longer-lived, softer trail than the component defaults, so it
        // reads as a wash following the cursor rather than a hard paint stroke.
        densityDissipation: 0.94,
        curl: 2.2,
        radius: 0.22,
        force: 1.0,
        intensity: 2.4,
      },
    );
    // No WebGL2 (or a lost context): leave the page exactly as it was.
    if (!instance) return;

    // The engine's own listeners sit on output.parentElement, which is
    // pointer-events:none here, so drive splats from window instead.
    let previous: { x: number; y: number } | null = null;

    const onPointerMove = (event: PointerEvent) => {
      const rect = output.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const last = previous;
      previous = { x, y };
      if (!last) return;
      instance.splat(x / rect.width, 1 - y / rect.height, x - last.x, -(y - last.y));
    };

    const onPointerOut = () => {
      previous = null;
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerleave', onPointerOut, { passive: true });
    window.addEventListener('pointercancel', onPointerOut, { passive: true });

    // The overlay is position:fixed at 100vw/100vh, so a viewport resize changes
    // its backing-store size; the engine's internal ResizeObserver watches the
    // canvas element, but an explicit resize() keeps orientation changes crisp.
    const onResize = () => instance.resize();
    window.addEventListener('resize', onResize, { passive: true });

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onPointerOut);
      window.removeEventListener('pointercancel', onPointerOut);
      window.removeEventListener('resize', onResize);
      instance.destroy();
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
        // src/landing/avatok-landing.html) so the nav stays crisp and clickable.
        zIndex: 90,
        // Never intercept a click: the waitlist form and every nav link sit under this.
        pointerEvents: 'none',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      />
    </div>
  );
}
