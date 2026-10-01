/* [SAATHUM-SHOP-WEB-CHECKOUT-1] Presentational pieces of the checkout, markup copied from
 * Specs/shop-mockup/shop.js (renderSum / stepsBar / ph). */
import type { CSSProperties, ReactNode } from 'react';
import type { ShopQuote, ShopQuoteLine } from './types';

export const GST_FALLBACK_PCT = 18;

/** ₹1,847 — whole rupees, thousands grouped the Indian way (mockup `inr`). */
export function inr(n: number): string {
  return '₹' + Number(n).toLocaleString('en-IN');
}
/** Exact payable from paise: no decimals when it is whole rupees, else two (a UPI rounding discount leaves paise). */
export function inrPaise(paise: number): string {
  const whole = paise % 100 === 0;
  return '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
}

/** Mockup `shade()`: the placeholder tint for a colour (only shown when a product has no photo). */
export function shade(hex: string | undefined): string {
  const h = /^#[0-9a-f]{6}$/i.test(hex ?? '') ? (hex as string) : '#efdcbf';
  const n = parseInt(h.slice(1), 16);
  let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  r = Math.round(r * 0.45 + 239 * 0.55);
  g = Math.round(g * 0.45 + 220 * 0.55);
  b = Math.round(b * 0.45 + 191 * 0.55);
  return `rgb(${r},${g},${b})`;
}

/** The product photo; the striped `.sh-ph` placeholder is only the empty state (spec §0.2). */
export function Thumb({ url, hex }: { url: string | null | undefined; hex?: string }) {
  if (url) return <img src={url} alt="" loading="lazy" />;
  return (
    <div className="sh-ph" style={{ '--ph': shade(hex) } as CSSProperties}>
      <span>T-shirt photo</span>
    </div>
  );
}

const STEP_LABELS = ['1 · You', '2 · Delivery address', '3 · Review', '4 · Pay with UPI'];

/** `step` 1-4 as in the mockup; 45 = the waiting screen, where every pill shows as done. */
export function StepsBar({ step }: { step: number }) {
  return (
    <div className="sh-steps">
      {STEP_LABELS.map((t, i) => (
        <span key={t} className={i + 1 === step ? 'is-on' : i + 1 < step ? 'is-done' : ''}>
          {i + 1 < step ? '✓ ' : ''}{t}
        </span>
      ))}
    </div>
  );
}

export function SumItems({ lines, hexOf }: { lines: ShopQuoteLine[]; hexOf: (l: ShopQuoteLine) => string | undefined }) {
  return (
    <>
      {lines.map((l) => (
        <div className="sh-sum-item" key={`${l.product_id}|${l.colour}|${l.size}`}>
          <Thumb url={l.image_url} hex={hexOf(l)} />
          <div><b>{l.name}</b><small>{l.colour} · {l.size} · Qty {l.qty}</small></div>
          <strong>{inr(l.amount_rupees)}</strong>
        </div>
      ))}
    </>
  );
}

export function SumRows({ quote }: { quote: ShopQuote }) {
  return (
    <>
      <div className="sh-row"><span>Subtotal</span><span>{inr(quote.subtotal_rupees)}</span></div>
      {quote.discount_rupees > 0 && (
        <div className="sh-row" style={{ color: '#1e8a4c' }}><span>Coupon {quote.coupon_code}</span><span>−{inr(quote.discount_rupees)}</span></div>
      )}
      <div className="sh-row"><span>Shipping</span><span>Free</span></div>
      <div className="sh-row"><span>GST ({quote.gst_rate_pct}%)</span><span>{inr(quote.gst_rupees)}</span></div>
      <div className="sh-row sh-row--tot"><span>Total</span><span>{inr(quote.total_rupees)}</span></div>
    </>
  );
}

export const SUM_NOTE = 'Free shipping, pan India. No returns — wrong item? We replace it or refund you.';

export function SumNote() {
  return <p style={{ font: '700 13px Nunito', color: '#7a6a55', margin: 0 }}>{SUM_NOTE}</p>;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="sh-eyebrow">{children}</p>;
}
