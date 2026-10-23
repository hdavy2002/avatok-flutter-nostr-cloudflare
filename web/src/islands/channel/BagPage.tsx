/* [HF-CHANNEL-WEB-1] /bag: every line the fan collected (from any influencers), quantity and remove, one summary, one Checkout.
 * Prices shown here are what each product cost when it was added; the server prices every line again at checkout.
 * Telemetry: bag_viewed, bag_checkout_started. */
import { useEffect, useState } from 'react';
import { artUrl, ART_DIMS } from '../../lib/hfChannelArt';
import { capture } from '../../lib/analytics';
import { publicImage } from '../../lib/config';
import { merchCheckoutEnabled } from '../../lib/merchApi';
import { bagByHost, bagCount, bagLineKey, bagTotalPaise, removeFromBag, setBagQty, BAG_MAX_QTY } from '../../lib/merchBag';
import { rupees } from '../../lib/merchPublic';
import { useBag } from './useBag';
import Sticker from './Sticker';

const emptyArt = artUrl('emptyBag');

export default function BagPage() {
  const lines = useBag();
  const [enabled, setEnabled] = useState(false);
  const [ready] = useState(true);
  useEffect(() => { let live = true; void merchCheckoutEnabled().then(v => { if (live) setEnabled(v); }); return () => { live = false; }; }, []);
  useEffect(() => { capture('bag_viewed', { lines: lines.length, items: bagCount(lines) }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const n = bagCount(lines);
  const total = bagTotalPaise(lines);
  const groups = bagByHost(lines);
  const keep = lines.length ? `/h/${lines[lines.length - 1].hostSlug}` : '/marketplace';

  if (ready && lines.length === 0) return <main className="sec" style={{ paddingTop: 44 }}><div className="wrap gone">
    {emptyArt && <img className="empty-bag" src={emptyArt} width={ART_DIMS.emptyBag.w} height={ART_DIMS.emptyBag.h} alt="" decoding="async" />}
    <p className="eyebrow">Your bag</p>
    <h1 className="h2" style={{ margin: '8px 0 14px' }}>Nothing in here yet.</h1>
    <p className="sub" style={{ marginBottom: 22 }}>Find an influencer you like and add something from their merch.</p>
    <a className="btn btn-r" href="/marketplace">Find influencers</a>
  </div></main>;

  return <main className="sec" style={{ paddingTop: 44 }} id="bag-main"><div className="wrap">
    <p className="eyebrow">Your bag</p>
    <h1 className="h2" style={{ marginBottom: 24 }}>{ready ? `${n} ${n === 1 ? 'item. Good choice.' : 'items. Good choices.'}` : 'Your bag'}</h1>
    <div className="two">
      <div>
        {groups.map(g => <section key={g.hostSlug} aria-label={`From ${g.hostName}`}>
          <p className="from">From {g.hostName}</p>
          {g.lines.map(l => {
            const key = bagLineKey(l);
            return <div className="line" key={key}>
              <div className="im">{l.imageUrl && <img src={publicImage(l.imageUrl, { width: 240 })} alt="" width="120" height="120" />}</div>
              <div>
                <h3><a href={`/h/${l.hostSlug}/merch/${l.slug}`}>{l.title}</a></h3>
                <p className="op">{[l.colour, l.size].filter(Boolean).join(' · ') || 'One size'}</p>
                <div className="ctl">
                  <div className="qty" role="group" aria-label={`Quantity of ${l.title}`}>
                    <button type="button" aria-label="One less" disabled={l.qty <= 1} onClick={() => setBagQty(key, l.qty - 1)}>−</button>
                    <output aria-live="polite">{l.qty}</output>
                    <button type="button" aria-label="One more" disabled={l.qty >= BAG_MAX_QTY} onClick={() => setBagQty(key, l.qty + 1)}>+</button>
                  </div>
                  <button className="lnk" type="button" onClick={() => removeFromBag(key)}>Remove</button>
                </div>
              </div>
              <div className="amt">{rupees(l.unitPaise * l.qty)}</div>
            </div>;
          })}
        </section>)}
        <p style={{ marginTop: 22 }}><a className="nun" href={keep}>← Keep shopping</a></p>
        <p style={{ marginTop: 22 }}><Sticker k="bag" /></p>
      </div>
      <aside className="sumcard" aria-label="Summary">
        <h2>Summary</h2>
        <div className="srow"><span>Items ({n})</span><span>{rupees(total)}</span></div>
        <div className="srow"><span>Delivery</span><span className="nun">Free</span></div>
        <div className="srow"><span>GST</span><span>Included</span></div>
        <div className="srow t"><span>Total</span><span>{rupees(total)}</span></div>
        {enabled
          ? <a className="btn btn-r" href="/checkout/merch" onClick={() => capture('bag_checkout_started', { source: 'bag', lines: lines.length, items: n, total_paise: total })}>Checkout</a>
          : <button className="btn btn-r" type="button" disabled aria-disabled="true">Buying opens soon</button>}
        <p className="fine">One payment for everything in your bag.</p>
      </aside>
    </div>
  </div></main>;
}
