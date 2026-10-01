// [SAATHUM-SHOP-WEB-STORE-1 2026-10-01] Cart drawer + toast — markup and behaviour from the approved mockup
// (Specs/shop-mockup/shop.js renderCart/openCart/toast). Mounted ONCE per page by SiteHeader.astro (`client:idle`).
//
// NOTE FOR AI:
//  - Opens on window event 'shop:cart-open' (shopCart.openCart()); toasts on 'shop:toast' (shopCart.showToast()).
//  - Lines come from shopCart (a display cache). GST / total come from POST /api/shop/quote (getQuote) — the page never
//    does tax maths. While the quote is loading the GST/Total cells show "…"; if it fails the error is shown and the
//    customer can still continue (checkout re-validates server side).
//  - "Checkout · Pay by UPI →" goes to /shop/checkout (owned by the WEB-CHECKOUT issue).
import { useEffect, useRef, useState } from 'react';
import { getCart, onCartChange, removeLine, setQty, SHOP_EVENTS, type CartLine } from '../../lib/shopCart';
import { ApiError } from '../../lib/apiClient';
import { getQuote, type ShopQuote } from '../../lib/shopApi';
import { inr, photo, shade } from '../../lib/shopUi';
import { capture, captureException } from '../../lib/analytics';

export default function CartDrawer() {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<CartLine[]>([]);
  const [quote, setQuote] = useState<ShopQuote | null>(null);
  const [quoteErr, setQuoteErr] = useState('');
  const [toast, setToast] = useState('');
  const [toastOn, setToastOn] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setLines(getCart());
    const off = onCartChange(setLines);
    const onOpen = () => { setLines(getCart()); setOpen(true); };
    const onToast = (e: Event) => {
      setToast(String((e as CustomEvent<string>).detail ?? ''));
      setToastOn(true);
      clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToastOn(false), 2200);
    };
    window.addEventListener(SHOP_EVENTS.open, onOpen);
    window.addEventListener(SHOP_EVENTS.toast, onToast);
    return () => { off(); window.removeEventListener(SHOP_EVENTS.open, onOpen); window.removeEventListener(SHOP_EVENTS.toast, onToast); clearTimeout(toastTimer.current); };
  }, []);

  // telemetry: shop_cart_opened {count}
  useEffect(() => {
    if (open) {
      capture('shop_cart_opened', { count: lines.reduce((n, l) => n + l.qty, 0) });
      closeBtn.current?.focus({ preventScroll: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Server quote for GST / total — only while the drawer is open and there is something to price.
  const sig = lines.map((l) => `${l.product_id}|${l.colour}|${l.size}|${l.qty}`).join(',');
  useEffect(() => {
    if (!open || !lines.length) { setQuote(null); setQuoteErr(''); return; }
    const ctrl = new AbortController();
    setQuote(null); setQuoteErr('');
    const t = setTimeout(() => {
      getQuote(lines.map((l) => ({ product_id: l.product_id, colour: l.colour, size: l.size, qty: l.qty })), undefined, ctrl.signal)
        .then((r) => { if (!ctrl.signal.aborted) setQuote(r.quote); })
        .catch((err) => {
          if (ctrl.signal.aborted) return;
          const body = err instanceof ApiError ? (err.body as { message?: string } | null) : null;
          setQuoteErr(body?.message || 'We could not refresh prices just now. You can still continue to checkout.');
          if (!(err instanceof ApiError && err.status === 400)) captureException(err, { surface: 'shop_cart_quote' });
        });
    }, 250);
    return () => { clearTimeout(t); ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sig]);

  const close = () => setOpen(false);
  const subtotal = lines.reduce((s, l) => s + l.unit_rupees * l.qty, 0);
  const showGst = !quote || quote.gst_rupees > 0 || quote.gst_rate_pct > 0;

  return (
    <div className="sh-cart-root">
      <div className={'sh-scrim' + (open ? ' is-on' : '')} id="shScrim" onClick={close} />
      <aside className={'sh-drawer' + (open ? ' is-on' : '')} id="shCart" aria-label="Your cart" role="dialog" aria-modal={open ? 'true' : undefined} inert={!open}>
        <div className="sh-dh"><h2>Your cart</h2><button className="sh-x" id="shCartClose" type="button" aria-label="Close cart" onClick={close} ref={closeBtn}>×</button></div>
        <div className="sh-free" id="shFree" style={{ display: lines.length ? '' : 'none' }}>🚚 <b>Free shipping</b> on every order, pan India</div>
        <div className="sh-items" id="shItems">
          {lines.length ? lines.map((l, k) => {
            const src = photo(l.image_url, 160);
            return (
              <div className="sh-item" key={`${l.product_id}|${l.colour}|${l.size}`}>
                {src ? <img src={src} alt="" loading="lazy" decoding="async" /> : <div className="sh-ph" style={{ ['--ph' as string]: shade(l.colour_hex) }}><span>T-shirt photo</span></div>}
                <div>
                  <b>{l.name}</b>
                  <small>{l.colour} · Size {l.size}</small>
                  <div className="sh-qty"><button type="button" aria-label="Decrease quantity" onClick={() => setQty(k, l.qty - 1)}>−</button><span>{l.qty}</span><button type="button" aria-label="Increase quantity" onClick={() => setQty(k, l.qty + 1)}>+</button></div>
                </div>
                <div className="sh-item-r"><strong>{inr(l.unit_rupees * l.qty)}</strong><button type="button" onClick={() => removeLine(k)}>Remove</button></div>
              </div>
            );
          }) : (
            <div className="sh-cart-empty"><b>Your cart is empty</b><p>Find a T-shirt that carries your faith.</p><a className="sh-btn sh-btn--red" href="/shop/all" onClick={close}>Browse T-shirts</a></div>
          )}
        </div>
        <div className="sh-df" id="shCartFoot">
          {lines.length ? (
            <>
              <div className="sh-row"><span>Subtotal</span><span>{inr(quote ? quote.subtotal_rupees : subtotal)}</span></div>
              {quote && quote.discount_rupees > 0 && <div className="sh-row" style={{ color: '#1e8a4c' }}><span>Coupon {quote.coupon_code}</span><span>−{inr(quote.discount_rupees)}</span></div>}
              <div className="sh-row"><span>Shipping</span><span>Free</span></div>
              {showGst && <div className="sh-row"><span>GST ({quote ? quote.gst_rate_pct : '…'}%)</span><span>{quote ? inr(quote.gst_rupees) : '…'}</span></div>}
              <div className="sh-row sh-row--tot"><span>Total</span><span>{quote ? inr(quote.total_rupees) : '…'}</span></div>
              {quoteErr && <p className="sh-err" role="alert">{quoteErr}</p>}
              <a className="sh-btn sh-btn--red sh-btn--wide" id="cGo" href="/shop/checkout">Checkout · Pay by UPI →</a>
              <button className="sh-btn sh-btn--ghost sh-btn--wide" id="cKeep" type="button" style={{ marginTop: 8 }} onClick={close}>Keep shopping</button>
            </>
          ) : null}
        </div>
      </aside>
      <div className={'sh-toast' + (toastOn ? ' is-on' : '')} id="shToast" role="status" aria-live="polite">{toast}</div>
    </div>
  );
}
