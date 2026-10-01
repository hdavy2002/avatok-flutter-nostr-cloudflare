// [SAATHUM-SHOP-WEB-STORE-1 2026-10-01] The product page body — gallery + buy box — an exact port of renderPdp()
// in Specs/shop-mockup/shop.js. It renders BOTH grid children of `.sh-pdp` (`.sh-gal` and `.sh-pdp-info`) so the
// thumbnails and the colour buttons share state; the Astro island wrapper is display:contents.
//
// NOTE FOR AI:
//  - Server-rendered (SEO) and hydrated `client:idle`.
//  - Photos: product.images (first = card image). With none, the mockup's four striped placeholder thumbnails
//    (Front / Back / Print close-up / On model) and main placeholder show, and picking a colour re-tints the
//    placeholder — that is the mockup behaviour. With real photos the colour buttons only change the selection.
//  - "About this design": the admin-entered description (when present) comes first, then the mockup's sentence.
//  - Delivery text ("5–8 days") and the 48-hour window are the mockup's copy: they are not in the public API yet.
//  - Buy now = add to cart + go to /shop/checkout (no drawer). Add to cart = add + open drawer + toast.
import { useEffect, useState } from 'react';
import type { ShopProduct } from '../../lib/shopApi';
import { addToCart, openCart, showToast } from '../../lib/shopCart';
import { inr, photo, shade } from '../../lib/shopUi';
import { capture } from '../../lib/analytics';
import { BRAND } from '../../lib/brand';
import '../../styles/shop.css';

const PLACEHOLDER_THUMBS = ['Front', 'Back', 'Print close-up', 'On model'];
const SIZE_GUIDE: [string, number, number][] = [['S', 38, 27], ['M', 40, 28], ['L', 42, 29], ['XL', 44, 30], ['XXL', 46, 31], ['3XL', 48, 32]];

export default function BuyBox({ product: p, gst }: { product: ShopProduct; gst: { rate: number; enabled: boolean } }) {
  const [colour, setColour] = useState(0);
  const [size, setSize] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [thumb, setThumb] = useState(0);
  const [err, setErr] = useState('');
  const [pin, setPin] = useState('');
  const [pinOut, setPinOut] = useState<{ ok: boolean; text: string } | null>(null);
  const [guide, setGuide] = useState(false);

  useEffect(() => {
    if (!guide) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setGuide(false); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [guide]);

  const images = p.images ?? [];
  const hasPhotos = images.length > 0;
  const thumbLabels = hasPhotos ? images.map((i) => i.label || 'Photo') : PLACEHOLDER_THUMBS;
  const tint = shade(p.colours[colour]?.hex ?? p.colours[0]?.hex);
  const off = p.mrp_rupees && p.mrp_rupees > p.price_rupees ? (p.off_pct ?? Math.round((1 - p.price_rupees / p.mrp_rupees) * 100)) : 0;
  const mainSrc = hasPhotos ? photo(images[thumb]?.url, 1280) : null;

  const submit = (buyNow: boolean) => {
    if (!size) { setErr('Please pick a size first.'); return; }
    const c = p.colours[colour];
    if (!c) return;
    setErr('');
    addToCart({ product_id: p.id, slug: p.slug, name: p.name, colour: c.name, colour_hex: c.hex, size, qty, unit_rupees: p.price_rupees, image_url: images[0]?.url ?? p.image_url });
    capture('shop_add_to_cart', { product_id: p.id, size, colour: c.name, qty, source: buyNow ? 'buy_now' : 'pdp' });
    if (buyNow) { window.location.href = '/shop/checkout'; return; }
    openCart();
    showToast(`Added: ${p.name} (${size})`);
  };

  const checkPin = () => {
    if (!/^\d{6}$/.test(pin)) setPinOut({ ok: false, text: 'Enter a valid 6-digit pincode.' });
    else setPinOut({ ok: true, text: `✓ Delivers to ${pin} in 5–8 days · free shipping` });
  };

  const kids = p.audience === 'Kids';
  return (
    <>
      <div className="sh-gal">
        <div className="sh-thumbs">
          {thumbLabels.map((t, i) => (
            <button key={t + i} type="button" className={i === thumb ? 'is-on' : ''} aria-label={t} onClick={() => setThumb(i)}>
              {hasPhotos
                ? <img src={photo(images[i].url, 160) ?? ''} alt={t} loading="lazy" decoding="async" />
                : <div className="sh-ph" style={{ ['--ph' as string]: tint }}><span>{t}</span></div>}
            </button>
          ))}
        </div>
        <div className="sh-main-img" id="pMain">
          {mainSrc
            ? <img src={mainSrc} alt={`${p.name} — ${thumbLabels[thumb]}`} width="1280" height="1707" fetchPriority="high" decoding="async" />
            : <div className="sh-ph" style={{ ['--ph' as string]: tint }}><span>{thumbLabels[thumb]} photo</span></div>}
        </div>
      </div>

      <div className="sh-pdp-info">
        {(p.collection || p.badge === 'best') && (
          <p className="sh-eyebrow">{p.collection ? `${p.collection.name} collection` : ''}{p.badge === 'best' ? `${p.collection ? ' · ' : ''}Bestseller` : ''}</p>
        )}
        <h1>{p.name}</h1>
        <div className="sh-price">{inr(p.price_rupees)}{off > 0 && p.mrp_rupees ? <>{' '}<s>{inr(p.mrp_rupees)}</s>{' '}<span className="sh-off">−{off}%</span></> : null}</div>
        <p className="sh-tax">{gst.enabled ? `+ ${gst.rate}% GST at checkout · ` : ''}Free shipping, pan India</p>

        <div className="sh-lbl">Colour <span id="pCol">{p.colours[colour]?.name}</span></div>
        <div className="sh-colours">
          {p.colours.map((c, i) => (
            <button key={c.name} type="button" className={i === colour ? 'is-on' : ''} style={{ background: c.hex }} aria-label={c.name} aria-pressed={i === colour} onClick={() => setColour(i)} />
          ))}
        </div>

        <div className="sh-lbl">Size <button className="sh-link" id="pGuide" type="button" onClick={() => setGuide(true)}>Size guide</button></div>
        <div className="sh-sizes" id="pSizes" role="radiogroup" aria-label="Size">
          {p.sizes.map((s) => (
            <label key={s}><input type="radio" name="psz" value={s} checked={size === s} onChange={() => { setSize(s); setErr(''); }} /><span>{s}</span></label>
          ))}
        </div>
        <div className="sh-err" id="pErr" role="alert">{err}</div>

        <div className="sh-buy">
          <div className="sh-qty"><button type="button" aria-label="Decrease quantity" onClick={() => setQty((q) => Math.max(1, q - 1))}>−</button><span id="pQty">{qty}</span><button type="button" aria-label="Increase quantity" onClick={() => setQty((q) => Math.min(10, q + 1))}>+</button></div>
          <button className="sh-btn sh-btn--ghost" id="pAdd" type="button" onClick={() => submit(false)}>Add to cart</button>
          <button className="sh-btn sh-btn--red" id="pBuy" type="button" onClick={() => submit(true)}>Buy now</button>
        </div>

        <div className="sh-perks"><div><i>🖨️</i>Printed to order for you</div><div><i>🚚</i>Free shipping, pan India</div><div><i>📲</i>Pay by any UPI app</div></div>

        <div className="sh-pin">
          <b style={{ font: '900 15px Nunito', width: '100%' }}>Check delivery</b>
          <input id="pPin" placeholder="Enter 6-digit pincode" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value)} aria-label="Pincode" />
          <button className="sh-btn sh-btn--teal" id="pPinBtn" type="button" style={{ minHeight: 46 }} onClick={checkPin}>Check</button>
          {pinOut && <p id="pPinOut" style={pinOut.ok ? undefined : { color: '#b3261e' }}>{pinOut.text}</p>}
        </div>

        <div className="sh-acc">
          <details open><summary>About this design</summary>
            {p.description ? <p>{p.description}</p> : null}
            <p>Original {BRAND.name} artwork. {p.print_type} on {p.fit.toLowerCase()} fit {kids ? 'kids ' : ''}T-shirt. Designed to be worn with respect — to the temple, to work, everyday.</p>
          </details>
          <details><summary>Fabric &amp; care</summary><ul><li>100% combed cotton, 180 GSM, bio-washed</li><li>Wash inside out in cold water</li><li>Do not iron directly on the print</li></ul></details>
          <details><summary>Shipping &amp; returns</summary><ul><li>Printed to order, delivered in 5–8 days — free shipping anywhere in India</li><li>We ship within India only</li><li>No returns or exchanges for size or change of mind — please check the size guide</li><li>Wrong or damaged item? Tell us within 48 hours with a photo and we replace it or refund you</li></ul></details>
        </div>
      </div>

      {/* position:fixed, so it takes no grid track in .sh-pdp */}
        <div className={'sh-modal' + (guide ? ' is-on' : '')} onClick={(e) => { if (e.target === e.currentTarget) setGuide(false); }}>
          <div className="sh-modal-box" role="dialog" aria-modal="true" aria-label="Size guide">
            <h2>Size guide</h2>
            <p>Chest and length in inches, measured flat. Oversized fits are 2" wider.</p>
            <table className="sh-sizeguide"><tbody>
              <tr><th>Size</th><th>Chest</th><th>Length</th></tr>
              {SIZE_GUIDE.map((r) => <tr key={r[0]}><td>{r[0]}</td><td>{r[1]}</td><td>{r[2]}</td></tr>)}
            </tbody></table>
            <div style={{ marginTop: 16 }}><button className="sh-btn sh-btn--teal sh-btn--wide" type="button" onClick={() => setGuide(false)}>Got it</button></div>
          </div>
        </div>
    </>
  );
}
