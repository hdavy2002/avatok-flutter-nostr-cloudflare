/* [HF-CHANNEL-WEB-1] Bag drawer: slides in from the right when something is added ("Added to bag ✓"), shows the lines, the total, Checkout and View bag.
 * A native <dialog> (focus trap, Escape and backdrop close come with it). Mounted on the channel and product pages inside the .gp skin.
 * When merch checkout is off the Checkout button reads "Buying opens soon" and is disabled (the bag still fills). */
import { useEffect, useRef, useState } from 'react';
import { merchCheckoutEnabled } from '../../lib/merchApi';
import { bagCount, bagTotalPaise, onBagDrawerOpen, type BagLine } from '../../lib/merchBag';
import { publicImage } from '../../lib/config';
import { rupees } from '../../lib/merchPublic';
import { artUrl, ART_DIMS } from '../../lib/hfChannelArt';
import { capture } from '../../lib/analytics';
import { useBag } from './useBag';
import Sticker from './Sticker';

const emptyArt = artUrl('emptyBag');

export default function BagDrawer({ checkoutEnabled }: { checkoutEnabled?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const lines = useBag();
  const [added, setAdded] = useState<BagLine | null>(null);
  const [enabled, setEnabled] = useState<boolean>(checkoutEnabled === true);

  useEffect(() => {
    let live = true;
    if (checkoutEnabled === undefined) void merchCheckoutEnabled().then(v => { if (live) setEnabled(v); });
    return () => { live = false; };
  }, [checkoutEnabled]);

  useEffect(() => onBagDrawerOpen(line => {
    setAdded(line);
    const d = ref.current;
    if (d && !d.open) { try { d.showModal(); } catch { d.setAttribute('open', ''); } }
  }), []);

  const close = () => ref.current?.close();
  const total = bagTotalPaise(lines);
  const n = bagCount(lines);

  return <dialog ref={ref} className="drawer" aria-label="Your bag" onClick={e => { if (e.target === ref.current) close(); }} onClose={() => setAdded(null)}>
    <div className="dh">
      <h2>{added ? 'Added to bag ✓' : 'Your bag'}</h2>
      <button className="ibtn" type="button" aria-label="Close bag" onClick={close}>✕</button>
    </div>
    {lines.length === 0 ? <div className="empty empty-d">{emptyArt && <img className="empty-bag" src={emptyArt} width={ART_DIMS.emptyBag.w} height={ART_DIMS.emptyBag.h} alt="" decoding="async" />}<p>Your bag is empty.</p></div> : lines.map(l => (
      <div className="line" key={`${l.productId}|${l.colour}|${l.size}`}>
        <div className="im">{l.imageUrl && <img src={publicImage(l.imageUrl, { width: 200 })} alt="" width="90" height="90" />}</div>
        <div>
          <h3>{l.title}</h3>
          <p className="op">{[l.colour, l.size].filter(Boolean).join(' · ')}{l.colour || l.size ? ' · ' : ''}{rupees(l.unitPaise)}{l.qty > 1 ? ` × ${l.qty}` : ''}</p>
        </div>
      </div>
    ))}
    {lines.length > 0 && <>
      <div className="srow t"><span>Total ({n})</span><span>{rupees(total)}</span></div>
      {enabled
        ? <a className="btn btn-r" href="/checkout/merch" onClick={() => capture('bag_checkout_started', { source: 'drawer', lines: lines.length, items: n, total_paise: total })}>Checkout</a>
        : <button className="btn btn-r" type="button" disabled aria-disabled="true">Buying opens soon</button>}
      <a className="btn btn-o" href="/bag">View bag</a>
      <p className="tail"><Sticker k="bag" /></p>
    </>}
  </dialog>;
}
