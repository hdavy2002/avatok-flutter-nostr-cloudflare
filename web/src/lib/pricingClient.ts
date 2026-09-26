// [PRICING-1 2026-09-26] Browser half of lib/pricing.ts. Prerendered pages bake
// in the price that was live at build time; this re-reads /api/pricing and
// rewrites every [data-saathum-price] element so a change made at /admin/pricing
// shows on every article within a minute — no rebuild, no deploy.
//
//   <span data-saathum-price="havan" data-saathum-type="havan">₹111</span>   floor
//   <span data-saathum-price="<slug>" data-saathum-type="havan|puja">…</span> one ritual
import { API_BASE } from './config';
import { captureException } from './analytics';

type Pricing = { havan_from: number | null; puja_from: number | null; rituals: Record<string, number> };

function rupees(n: number): string { return `₹${n.toLocaleString('en-IN')}`; }

async function refreshPrices(): Promise<void> {
  const nodes = document.querySelectorAll<HTMLElement>('[data-saathum-price]');
  if (!nodes.length) return;
  try {
    const res = await fetch(`${API_BASE}/api/pricing`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return; // keep the build-time price
    const p = (await res.json()) as Pricing;
    nodes.forEach((el) => {
      const key = el.dataset.saathumPrice ?? '';
      const type = el.dataset.saathumType === 'puja' ? 'puja' : 'havan';
      const floor = type === 'puja' ? p.puja_from : p.havan_from;
      const price = key === 'havan' || key === 'puja' ? floor : (p.rituals?.[key] ?? floor);
      if (typeof price === 'number' && price > 0) el.textContent = rupees(price);
    });
  } catch (e) {
    try { captureException(e, { surface: 'pricing_refresh' }); } catch { /* best-effort */ }
  }
}

void refreshPrices();
