/* [HF-MERCH-FAN-WEB-1] Buy panel of a merch product page: colour, size (price per size), quantity, pincode check and "Buy now".
 * The product text, photos, size chart and schema are server-rendered by the Astro page; this island only adds the interaction.
 * Checkout (address, review, pay) is a separate chunk loaded on the first tap. A signed-out buyer is sent to sign in and lands back
 * here with ?buy=1&colour=&size=&qty= so the checkout reopens where he left off.
 * Telemetry: merch_product_viewed, merch_buy_clicked. */
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import SessionBridge from '../calls/SessionBridge';
import { capture, captureException } from '../../lib/analytics';
import { checkPincode } from '../../lib/merchApi';
import type { MerchColour, MerchSize } from '../../lib/merchPublic';
import { rupees } from '../../lib/merchPublic';

const Checkout = lazy(() => import('./Checkout'));

export interface BuyProps {
  host: { slug: string; displayName: string };
  product: { id: string; slug: string; title: string; imageUrl: string | null; colours: MerchColour[]; sizes: MerchSize[]; maxQty: number };
  checkoutEnabled: boolean;
}

export default function MerchBuy({ host, product, checkoutEnabled }: BuyProps) {
  const sizes = product.sizes;
  const firstSize = sizes.find(s => s.inStock)?.size ?? sizes[0]?.size ?? '';
  const [colour, setColour] = useState(product.colours[0]?.name ?? '');
  const [size, setSize] = useState(firstSize);
  const [qty, setQty] = useState(1);
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [pinMsg, setPinMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const maxQty = Math.max(1, Math.min(3, product.maxQty || 3));
  const unit = sizes.find(s => s.size === size)?.pricePaise ?? 0;
  const resumed = useRef(false);

  useEffect(() => {
    capture('merch_product_viewed', { host_slug: host.slug, product_slug: product.slug, product_id: product.id, from_paise: Math.min(...sizes.map(s => s.pricePaise)), checkout_enabled: checkoutEnabled, utm_medium: new URLSearchParams(location.search).get('utm_medium') ?? undefined });
    try { const p = sessionStorage.getItem('hfm_pin'); if (p && /^[1-9]\d{5}$/.test(p)) setPin(p); } catch { /* optional */ }
    // Back from sign-in: restore the choice and reopen the checkout.
    const q = new URLSearchParams(location.search);
    if (q.get('buy') === '1' && !resumed.current) {
      resumed.current = true;
      const c = q.get('colour'), s = q.get('size'), n = Number(q.get('qty'));
      if (c && product.colours.some(x => x.name === c)) setColour(c);
      if (s && sizes.some(x => x.size === s && x.inStock)) setSize(s);
      if (n >= 1 && n <= maxQty) setQty(Math.trunc(n));
      if (checkoutEnabled) setOpen(true);
      history.replaceState(null, '', location.pathname);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const total = unit * qty;
  const buy = () => {
    if (!checkoutEnabled || !size) return;
    capture('merch_buy_clicked', { host_slug: host.slug, product_slug: product.slug, product_id: product.id, colour, size, qty, price_paise: total });
    setOpen(true);
  };
  const resumePath = `/h/${host.slug}/merch/${product.slug}`;

  const check = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^[1-9]\d{5}$/.test(pin)) { setPinMsg({ ok: false, text: 'Enter a 6-digit pincode.' }); return; }
    setPinBusy(true); setPinMsg(null);
    const r = await checkPincode(pin);
    setPinBusy(false);
    if (!r.ok) { setPinMsg({ ok: false, text: r.message || 'We could not check this pincode right now. Please try again.' }); if (r.status === 0 || r.status >= 500) captureException(new Error(`merch_pincode_${r.status}_${r.code}`), { area: 'hf_merch_fan', step: 'pincode' }); return; }
    try { sessionStorage.setItem('hfm_pin', pin); } catch { /* optional */ }
    setPinMsg(r.data.deliverable
      ? { ok: true, text: r.data.etaDays ? `Yes, we deliver to ${pin}. Usually in about ${r.data.etaDays} days. Delivery is free.` : `Yes, we deliver to ${pin}. Delivery is free.` }
      : { ok: false, text: `Sorry, we cannot deliver to ${pin} yet.` });
    capture('merch_pincode_checked', { host_slug: host.slug, deliverable: r.data.deliverable });
  };

  return <div className="hfm-buy">
    {product.colours.length > 0 && <fieldset className="hfm-field">
      <legend>Colour: <b>{colour}</b></legend>
      <div className="hfm-swatches">{product.colours.map(c => <button key={c.name} type="button" className={`hfm-swatch${c.name === colour ? ' on' : ''}`} style={{ background: c.hex }} aria-label={c.name} aria-pressed={c.name === colour} onClick={() => setColour(c.name)} />)}</div>
    </fieldset>}
    <fieldset className="hfm-field">
      <legend>Size</legend>
      <div className="hfm-sizes">{sizes.map(s => <button key={s.size} type="button" className={`hfm-size${s.size === size ? ' on' : ''}`} disabled={!s.inStock} aria-pressed={s.size === size} onClick={() => setSize(s.size)}>
        <b>{s.size}</b><span>{s.inStock ? rupees(s.pricePaise) : 'Sold out'}</span></button>)}</div>
      <a className="hfm-link" href="#size-chart">Size chart</a>
    </fieldset>
    <div className="hfm-field">
      <label htmlFor="hfm-qty">Quantity</label>
      <div className="hfm-qty"><button type="button" aria-label="One less" disabled={qty <= 1} onClick={() => setQty(q => Math.max(1, q - 1))}>−</button><output id="hfm-qty" aria-live="polite">{qty}</output><button type="button" aria-label="One more" disabled={qty >= maxQty} onClick={() => setQty(q => Math.min(maxQty, q + 1))}>+</button></div>
    </div>
    <div className="hfm-total"><span>Total</span><b>{rupees(total)}</b><small>incl. GST &amp; free delivery across India</small></div>
    <button type="button" className="hfm-cta" disabled={!checkoutEnabled || !size} onClick={buy}>{checkoutEnabled ? `Buy now · ${rupees(total)}` : 'Coming soon'}</button>
    {!checkoutEnabled && <p className="hfm-note" role="status">Buying opens soon. Save this page and check back.</p>}
    <form className="hfm-pin" onSubmit={check}>
      <label htmlFor="hfm-pin">Check delivery to your pincode</label>
      <div><input id="hfm-pin" inputMode="numeric" autoComplete="postal-code" maxLength={6} value={pin} onChange={e => { setPin(e.target.value.replace(/\D/g, '').slice(0, 6)); setPinMsg(null); }} placeholder="6-digit pincode" />
        <button type="submit" disabled={pinBusy}>{pinBusy ? 'Checking…' : 'Check'}</button></div>
      {pinMsg && <p className={pinMsg.ok ? 'hfm-ok' : 'hfm-err'} role="status">{pinMsg.text}</p>}
    </form>
    <SessionBridge on={open} />
    {open && <Suspense fallback={null}>
      <Checkout host={host} product={product} colour={colour} size={size} qty={qty} unitPaise={unit} pincode={/^[1-9]\d{5}$/.test(pin) ? pin : ''} resumePath={resumePath} onClose={() => setOpen(false)} />
    </Suspense>}
  </div>;
}
