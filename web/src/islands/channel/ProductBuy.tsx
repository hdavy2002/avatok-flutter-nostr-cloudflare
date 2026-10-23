/* [HF-CHANNEL-WEB-1] Buy panel of a merch product page (replaces MerchBuy): price, colour swatches, sizes (only when the product has sizes),
 * quantity, Add to bag (opens the bag drawer), Buy now (adds to the bag, then goes to checkout) and the pincode check.
 * The title, photos, trust trio, accordion and schema are server-rendered by the Astro page. On phones Add to bag / Buy now sit in a sticky bottom bar.
 * Telemetry: merch_product_viewed, bag_added (source product), merch_buy_clicked, merch_pincode_checked. */
import { useEffect, useState } from 'react';
import { capture, captureException } from '../../lib/analytics';
import { checkPincode } from '../../lib/merchApi';
import { addToBag, openBagDrawer } from '../../lib/merchBag';
import { gstText, rupees, type MerchColour, type MerchSize } from '../../lib/merchPublic';

export interface BuyProps {
  host: { slug: string; displayName: string };
  product: { id: string; slug: string; title: string; imageUrl: string | null; colours: MerchColour[]; sizes: MerchSize[]; maxQty: number; fromPricePaise: number; category: string; gstRateBps?: number };
  checkoutEnabled: boolean;
}

export default function ProductBuy({ host, product, checkoutEnabled }: BuyProps) {
  const sizes = product.sizes;
  const hasSizes = sizes.length > 0;
  const base = hasSizes ? Math.min(...sizes.filter(s => s.inStock).map(s => s.pricePaise), ...(sizes.some(s => s.inStock) ? [] : [product.fromPricePaise])) : product.fromPricePaise;
  const firstSize = (sizes.find(s => s.inStock && s.size.toUpperCase() === 'M') ?? sizes.find(s => s.inStock))?.size ?? '';
  const [colour, setColour] = useState(product.colours[0]?.name ?? '');
  const [size, setSize] = useState(firstSize);
  const [qty, setQty] = useState(1);
  const [pin, setPin] = useState('');
  const [pinMsg, setPinMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const [note, setNote] = useState('');
  const maxQty = Math.max(1, Math.min(3, product.maxQty || 3));
  const unit = hasSizes ? (sizes.find(s => s.size === size)?.pricePaise ?? 0) : product.fromPricePaise;
  const soldOut = hasSizes && !sizes.some(s => s.inStock);
  const canBuy = !soldOut && (!hasSizes || !!size);

  useEffect(() => {
    capture('merch_product_viewed', { host_slug: host.slug, product_slug: product.slug, product_id: product.id, from_paise: base, checkout_enabled: checkoutEnabled, utm_medium: new URLSearchParams(location.search).get('utm_medium') ?? undefined });
    try { const p = sessionStorage.getItem('hfm_pin'); if (p && /^[1-9]\d{5}$/.test(p)) setPin(p); } catch { /* optional */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const add = (source: 'add' | 'buy'): boolean => {
    if (!canBuy) return false;
    const r = addToBag({ productId: product.id, hostSlug: host.slug, hostName: host.displayName, slug: product.slug, title: product.title, imageUrl: product.imageUrl, colour, size, qty, unitPaise: unit, category: product.category });
    if (!r.ok) { setNote('Your bag is full (10 items). Open it and check out first.'); return false; }
    setNote('');
    capture('bag_added', { source: 'product', host_slug: host.slug, product_id: product.id, category: product.category, qty, price_paise: unit * qty, via: source });
    if (source === 'add') openBagDrawer(r.line);
    return true;
  };
  const buyNow = () => {
    if (!checkoutEnabled) return;
    capture('merch_buy_clicked', { host_slug: host.slug, product_slug: product.slug, product_id: product.id, colour, size, qty, price_paise: unit * qty });
    if (add('buy')) location.assign('/checkout/merch');
  };

  const check = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^[1-9]\d{5}$/.test(pin)) { setPinMsg({ ok: false, text: 'Enter a 6-digit pincode.' }); return; }
    setPinBusy(true); setPinMsg(null);
    const r = await checkPincode(pin);
    setPinBusy(false);
    if (!r.ok) { setPinMsg({ ok: false, text: r.message || 'We could not check this pincode right now. Please try again.' }); if (r.status === 0 || r.status >= 500) captureException(new Error(`merch_pincode_${r.status}_${r.code}`), { area: 'hf_merch_fan', step: 'pincode' }); return; }
    try { sessionStorage.setItem('hfm_pin', pin); } catch { /* optional */ }
    setPinMsg(r.data.deliverable
      ? { ok: true, text: r.data.etaDays ? `✓ We deliver to ${pin}. Usually in about ${r.data.etaDays} days.` : `✓ We deliver to ${pin}.` }
      : { ok: false, text: `Sorry, we cannot deliver to ${pin} yet.` });
    capture('merch_pincode_checked', { host_slug: host.slug, deliverable: r.data.deliverable });
  };

  const openGuide = (e: React.MouseEvent) => {
    const el = document.getElementById('size-guide') as HTMLDetailsElement | null;
    if (el) { e.preventDefault(); el.open = true; el.scrollIntoView({ block: 'center' }); }
  };

  const buttons = <>
    <button type="button" className="btn btn-k" disabled={!canBuy} onClick={() => add('add')}>{soldOut ? 'Sold out' : 'Add to bag'}</button>
    <button type="button" className="btn btn-r" disabled={!canBuy || !checkoutEnabled} aria-disabled={!canBuy || !checkoutEnabled} onClick={buyNow}>{checkoutEnabled ? 'Buy now' : 'Buying opens soon'}</button>
  </>;

  return <div>
    <p className="pprice">{rupees(unit || base)} <small>· {gstText(product.gstRateBps)} + free delivery included</small></p>
    {product.colours.length > 0 && <>
      <p className="lbl" id="lbl-colour">Colour: {colour}</p>
      <div className="sw" role="group" aria-labelledby="lbl-colour">{product.colours.map(c => <button key={c.name} type="button" className={c.name === colour ? 'on' : ''} style={{ background: c.hex }} aria-label={c.name} aria-pressed={c.name === colour} onClick={() => setColour(c.name)} />)}</div>
    </>}
    {hasSizes && <>
      <p className="lbl" id="lbl-size">Size <a href="#size-guide" onClick={openGuide}>Size guide</a></p>
      <div className="sizes" role="group" aria-labelledby="lbl-size">{sizes.map(s => {
        const delta = s.pricePaise - base;
        return <button key={s.size} type="button" className={`size${s.size === size ? ' on' : ''}`} disabled={!s.inStock} aria-pressed={s.size === size} onClick={() => setSize(s.size)}>
          {s.size}{!s.inStock ? <small>Sold out</small> : delta > 0 ? <small>+{rupees(delta)}</small> : null}</button>;
      })}</div>
    </>}
    <div className="buy">
      <div className="qty" role="group" aria-label="Quantity"><button type="button" aria-label="One less" disabled={qty <= 1} onClick={() => setQty(q => Math.max(1, q - 1))}>−</button><output aria-live="polite">{qty}</output><button type="button" aria-label="One more" disabled={qty >= maxQty} onClick={() => setQty(q => Math.min(maxQty, q + 1))}>+</button></div>
      <span className="desk">{buttons}</span>
    </div>
    {note && <p className="errp" role="alert">{note}</p>}
    {!checkoutEnabled && <p className="optnote" role="status">Buying opens soon. You can fill your bag now and pay when it opens.</p>}
    <p className="lbl" style={{ marginTop: 26 }}>Delivery</p>
    <form onSubmit={check}>
      <div className="pinrow"><label htmlFor="hfm-pin" className="vh">Pincode</label>
        <input id="hfm-pin" className="inp" inputMode="numeric" autoComplete="postal-code" maxLength={6} value={pin} onChange={e => { setPin(e.target.value.replace(/\D/g, '').slice(0, 6)); setPinMsg(null); }} placeholder="Enter pincode" />
        <button type="submit" className="btn btn-o btn-sm" disabled={pinBusy}>{pinBusy ? 'Checking…' : 'Check'}</button></div>
      {pinMsg && <p className={`pinmsg${pinMsg.ok ? '' : ' bad'}`} role="status">{pinMsg.text}</p>}
    </form>
    <div className="pbar shop" role="group" aria-label="Buy">{buttons}</div>
  </div>;
}
