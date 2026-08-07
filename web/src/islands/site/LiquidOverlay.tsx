/**
 * LiquidOverlay — the avatok.ai ambient water layer.
 *
 * Two stacked Canvas UI effects, both full-viewport, both decorative:
 *
 *   1. Liquid  (bottom) — a pointer-driven fluid trail in brand turquoise.
 *   2. Droplets (top)   — rain running down the glass, lit with specular
 *                         highlights and rim light so the sheet reads as GLASS
 *                         rather than flat colour. The cursor wipes it clear.
 *
 * Upstream sources are vendored unmodified at src/components/canvasui/*.tsx and
 * are refreshed by `npx shadcn add @canvas-ui/<name>` — DO NOT edit them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS, AND WHY IT LOOKS LIKE THIS
 *
 * The home page ships as ONE opaque static document (src/landing/avatok-landing.html,
 * injected via `set:html` in pages/index.astro). There is no React tree to wrap, so
 * the `<Liquid>` / `<Droplets>` children APIs are unusable. We drive the lower-level
 * `createLiquid()` / `createDroplets()` engines directly and render only their
 * output canvases.
 *
 * Both engines auto-detect the EXPERIMENTAL html-in-canvas APIs
 * (`ctx.drawElementImage` + `canvas.requestPaint`, currently Chrome-only behind
 * chrome://flags#enable-html-in-canvas). When found they switch to "capture the DOM
 * and refract it" mode and read their content from the source canvas. Ours is
 * deliberately empty, so on such a browser Liquid would resolve to a fully
 * transparent frame and Droplets would refract nothing — the effect would silently
 * vanish. We therefore shadow `requestPaint` to `undefined` on both source canvases,
 * so detection is deterministic and every browser gets the same self-lit path.
 *
 * That self-lit path is also the answer to "the liquid looks flat": Liquid's
 * non-capture branch can only tint (`tint * overlay`), because real refraction needs
 * the page pixels it cannot have. The glass — normals, specular, rim light — comes
 * from Droplets, whose fallback branch shades each drop as a lit surface.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Degrades safely: no WebGL2 → the engines return null → nothing renders.
 * `prefers-reduced-motion: reduce` is honoured inside both engines.
 * Coarse pointers (phones/tablets) are skipped entirely — see SKIP_COARSE below.
 */
import { useEffect, useRef } from 'react';
import { createLiquid, type LiquidInstance } from '../../components/canvasui/Liquid';
import { createDroplets, type DropletsInstance } from '../../components/canvasui/Droplets';

/**
 * Brand turquoise, as 0..1 sRGB triplets. The zine palette carries two turquoise
 * tokens (web/src/styles/tokens.css): --zine-blue #A0F7F1 (light) and
 * --zine-blueInk #007D7F (deep teal). #8FF2EC sits just below the light one —
 * enough to register over the cream --zine-paper without reading as paint.
 */
const TURQUOISE: [number, number, number] = [0x8f / 255, 0xf2 / 255, 0xec / 255];

/**
 * Two full-viewport fragment shaders running at 60fps is a real battery cost on a
 * phone, and Droplets never idles (rain always animates). The liquid trail also
 * needs a hovering pointer to mean anything, which a touch screen does not have.
 * So on coarse pointers we render nothing and leave the landing page untouched.
 */
const SKIP_COARSE = '(pointer: coarse)';

/**
 * THE opacity dials. Both shaders drive their own alpha toward saturation (see the
 * `intensity` note on the Liquid config below), so their numeric options cannot make
 * either layer subtle — compositing the whole canvas at reduced opacity can, and it
 * is exact. Raise these to make the water more present; lower to fade it back.
 */
const LIQUID_OPACITY = 0.34;
const RAIN_OPACITY = 0.4;

export default function LiquidOverlay() {
  const hostRef = useRef<HTMLDivElement>(null);
  const liquidCanvasRef = useRef<HTMLCanvasElement>(null);
  const rainWrapRef = useRef<HTMLDivElement>(null);
  const rainContentRef = useRef<HTMLDivElement>(null);
  const rainCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (window.matchMedia(SKIP_COARSE).matches) return;

    const liquidOutput = liquidCanvasRef.current;
    const rainWrap = rainWrapRef.current;
    const rainContent = rainContentRef.current;
    const rainOutput = rainCanvasRef.current;
    if (!liquidOutput || !rainWrap || !rainContent || !rainOutput) return;

    // Detached, never-painted source canvases. Shadowing `requestPaint` forces
    // each engine's html-in-canvas probe to fail — see the file header.
    const makeSource = () => {
      const canvas = document.createElement('canvas');
      Object.defineProperty(canvas, 'requestPaint', { value: undefined });
      return canvas;
    };

    const liquid: LiquidInstance | null = createLiquid(
      { source: makeSource(), content: document.createElement('div'), output: liquidOutput },
      {
        color: TURQUOISE,
        rainbow: false,
        // NOTE: `intensity` is NOT a usable opacity dial here, despite reading like
        // one. The shader computes alpha as (1 - exp(-|flow| * intensity * 0.5)) * 0.82,
        // but the splat pass writes the dye colour as vec3(dx, dy, 10) — that
        // hardcoded 10 in the blue channel makes |flow| ~10 at every splat centre, so
        // the exponential saturates and alpha pins near the 0.82 ceiling no matter
        // what intensity is set to. That is why lowering it from 2.4 to 0.9 barely
        // changed anything on screen. Translucency is therefore done in CSS instead
        // (LIQUID_OPACITY below), which is the only reliable dial.
        densityDissipation: 0.88,
        curl: 2.2,
        // Splat gaussian is exp(-d²/(radius/100)), so 0.08 → a ~30px core that the
        // advection then smears into a trail, rather than the ~250px blobs 0.16 gave.
        radius: 0.08,
        force: 1.0,
        intensity: 0.9,
      },
    );

    // NOTE: Droplets sizes its render window from `content.clientWidth /
    // output.clientWidth` and DISCARDS every fragment beyond it. A detached
    // content div has clientWidth 0, which clamps to 0.05 and leaves rain in a
    // 5%-wide strip down the left edge. `rainContent` is therefore a real,
    // laid-out element sized to the viewport alongside the canvas.
    const rain: DropletsInstance | null = createDroplets(
      { source: makeSource(), content: rainContent, output: rainOutput },
      {
        // A drizzle, not a downpour — this sits over marketing copy that has to
        // stay readable. 0.34 already covered the viewport in drops.
        intensity: 0.16,
        speed: 0.75,
        // `scale` is inverted: HIGHER means SMALLER drops. Small beads of water
        // read as glass; large ones read as grey blobs over the copy.
        scale: 1.1,
        dropWidth: 0.62,
        dropLength: 0.9,
        staticDrops: 0.12,
        fallSpeed: 0.85,
        wiggle: 1.1,
        // `refraction` and `blur` only do anything on the html-in-canvas path
        // (they warp captured page pixels), so they are left at defaults; the
        // glassiness we actually see comes from the drop normals' specular and
        // rim lighting in the self-lit branch.
        //
        // The self-lit branch bases each drop on `mix(vec3(0.72), tint, tintStrength)`,
        // i.e. mid-grey unless the tint is pushed hard. At 0.4 the rain read as dirty
        // grey teardrops on the cream paper; near 1 it becomes brand-tinted water.
        tint: TURQUOISE,
        tintStrength: 0.92,
        interactive: true,
        interactionRadius: 0.26,
        interactionStrength: 0.75,
      },
    );

    if (!liquid && !rain) return;

    // Both engines bind their pointer listeners to `output.parentElement`, which
    // here is pointer-events:none (the overlay must never eat a click on the nav
    // or the waitlist form). Those listeners can therefore never fire on their
    // own, so we listen on window and drive both layers ourselves.
    let previous: { x: number; y: number } | null = null;

    const onPointerMove = (event: PointerEvent) => {
      const rect = liquidOutput.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const last = previous;
      previous = { x, y };

      if (liquid && last) {
        liquid.splat(x / rect.width, 1 - y / rect.height, x - last.x, -(y - last.y));
      }

      // Droplets exposes no splat-style API — its wipe is driven entirely by its
      // internal pointer handler. Re-dispatching the event onto its listen target
      // is the supported way in; `bubbles: false` is essential, or the synthetic
      // event climbs back to window and re-enters this handler forever.
      if (rain) {
        rainWrap.dispatchEvent(
          new PointerEvent('pointermove', {
            clientX: event.clientX,
            clientY: event.clientY,
            bubbles: false,
          }),
        );
      }
    };

    const onPointerOut = () => {
      previous = null;
      if (rain) rainWrap.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }));
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerleave', onPointerOut, { passive: true });
    window.addEventListener('pointercancel', onPointerOut, { passive: true });

    // The overlay is position:fixed at 100vw/100vh, so a viewport resize changes
    // the backing-store size. Both engines watch their own canvas with a
    // ResizeObserver, but an explicit resize keeps orientation changes crisp.
    const onResize = () => {
      liquid?.resize();
      rain?.resize();
    };
    window.addEventListener('resize', onResize, { passive: true });

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onPointerOut);
      window.removeEventListener('pointercancel', onPointerOut);
      window.removeEventListener('resize', onResize);
      liquid?.destroy();
      rain?.destroy();
    };
  }, []);

  const fill: React.CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%' };

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
      <canvas ref={liquidCanvasRef} style={{ ...fill, opacity: LIQUID_OPACITY }} />
      <div ref={rainWrapRef} style={fill}>
        {/* Sizing reference for the Droplets render window — see the note above. */}
        <div ref={rainContentRef} style={fill} />
        <canvas ref={rainCanvasRef} style={{ ...fill, opacity: RAIN_OPACITY }} />
      </div>
    </div>
  );
}
