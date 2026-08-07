/**
 * LiquidOverlay — a full-page, pointer-driven fluid trail for avatok.ai.
 *
 * Built on the Canvas UI "Liquid" component (`@canvas-ui/liquid-react`, vendored
 * at src/components/canvasui/Liquid.tsx — DO NOT edit that file, it is the
 * upstream registry source and is refreshed by `npx shadcn add @canvas-ui/...`).
 *
 * HISTORY: a Droplets rain layer was stacked on top of this between 2026-08-07's
 * second and fourth deploys and was REMOVED at the owner's call — over the cream
 * --zine-paper the drops read as dirty grey specks rather than water, because the
 * self-lit branch bases each drop on mid-grey (`mix(vec3(0.72), tint, tintStrength)`)
 * and only a captured page behind it would have made them read as glass. Do not
 * re-add it without a way to test that. If it is ever wanted back:
 * `npx shadcn@latest add @canvas-ui/droplets-react` from web/, and note that
 * Droplets discards every fragment past `content.clientWidth / output.clientWidth`,
 * so its content element must be real and laid out at viewport size.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS, AND WHY IT LOOKS LIKE THIS
 *
 * The home page ships as ONE opaque static document (src/landing/avatok-landing.html,
 * injected via `set:html` in pages/index.astro). There is no React tree to wrap, so
 * the `<Liquid>` children API is unusable — we drive the lower-level `createLiquid()`
 * engine directly and render only its output canvas.
 *
 * `createLiquid` auto-detects the EXPERIMENTAL html-in-canvas APIs
 * (`ctx.drawElementImage` + `canvas.requestPaint`, currently Chrome-only behind
 * chrome://flags#enable-html-in-canvas). When it finds them it switches to "capture
 * the DOM and warp it" mode and reads its content from the source canvas. Ours is
 * deliberately empty, so on such a browser the shader would resolve to a fully
 * transparent frame and the effect would silently vanish. We therefore shadow
 * `requestPaint` to `undefined`, making detection deterministic: every browser gets
 * the same colour-trail path.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Degrades safely: no WebGL2 → `createLiquid` returns null → nothing renders.
 * `prefers-reduced-motion: reduce` is honoured inside the engine (`splat` no-ops).
 * Coarse pointers (phones/tablets) are skipped entirely — see SKIP_COARSE below.
 */
import { useEffect, useRef } from 'react';
import { createLiquid, type LiquidInstance } from '../../components/canvasui/Liquid';

/**
 * Brand turquoise, as 0..1 sRGB triplets. The zine palette carries two turquoise
 * tokens (web/src/styles/tokens.css): --zine-blue #A0F7F1 (light) and
 * --zine-blueInk #007D7F (deep teal). #8FF2EC sits just below the light one —
 * enough to register over the cream --zine-paper without reading as paint.
 */
const TURQUOISE: [number, number, number] = [0x8f / 255, 0xf2 / 255, 0xec / 255];

/**
 * A full-viewport fragment shader at 60fps is a real battery cost on a phone, and
 * the trail needs a hovering pointer to mean anything, which a touch screen does
 * not have. On coarse pointers we render nothing and leave the landing page alone.
 */
const SKIP_COARSE = '(pointer: coarse)';

/**
 * THE opacity dial. The shader drives its own alpha toward saturation (see the
 * `intensity` note below), so no engine option can make the trail subtle —
 * compositing the whole canvas at reduced opacity can, and it is exact. Raise to
 * make the water more present; lower to fade it back.
 */
const LIQUID_OPACITY = 0.34;

export default function LiquidOverlay() {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (window.matchMedia(SKIP_COARSE).matches) return;

    const output = canvasRef.current;
    if (!output) return;

    // Detached, never-painted source canvas. See the file header: shadowing
    // `requestPaint` forces the engine's html-in-canvas probe to fail, which is
    // what we want — we only ever use the colour-trail path.
    const source = document.createElement('canvas');
    Object.defineProperty(source, 'requestPaint', { value: undefined });
    const content = document.createElement('div');

    const liquid: LiquidInstance | null = createLiquid(
      { source, content, output },
      {
        color: TURQUOISE,
        rainbow: false,
        // NOTE: `intensity` is NOT a usable opacity dial here, despite reading like
        // one. The shader computes alpha as (1 - exp(-|flow| * intensity * 0.5)) * 0.82,
        // but the splat pass writes the dye colour as vec3(dx, dy, 10) — that
        // hardcoded 10 in the blue channel makes |flow| ~10 at every splat centre, so
        // the exponential saturates and alpha pins near the 0.82 ceiling no matter
        // what intensity is set to. That is why lowering it from 2.4 to 0.9 barely
        // changed anything on screen. Translucency is done in CSS instead
        // (LIQUID_OPACITY above), which is the only reliable dial.
        densityDissipation: 0.88,
        curl: 2.2,
        // Splat gaussian is exp(-d²/(radius/100)), so 0.08 → a ~30px core that the
        // advection then smears into a trail, rather than the ~250px blobs 0.16 gave.
        radius: 0.08,
        force: 1.0,
        intensity: 0.9,
      },
    );
    // No WebGL2 (or a lost context): leave the page exactly as it was.
    if (!liquid) return;

    // The engine binds its pointer listeners to `output.parentElement`, which here
    // is pointer-events:none (the overlay must never eat a click on the nav or the
    // waitlist form). Those listeners can therefore never fire on their own, so we
    // listen on window and drive the splats ourselves.
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
        // src/landing/avatok-landing.html) so the nav stays crisp and clickable.
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
          opacity: LIQUID_OPACITY,
        }}
      />
    </div>
  );
}
