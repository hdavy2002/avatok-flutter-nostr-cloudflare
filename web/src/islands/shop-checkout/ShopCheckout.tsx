/* [SAATHUM-SHOP-WEB-CHECKOUT-1] /shop/checkout — You -> Delivery address -> Review -> Pay with UPI -> Done.
 * Visuals are the owner-approved mockup (Specs/shop-mockup, "Checkout (UPI)"); logic is the event checkout's
 * (islands/saathum-checkout): ClerkIsland + IslandBoundary, the WhatsApp-first sign-in + verify step (YouStep,
 * reused), profile prefill, request-key idempotency, resume by ?order=<id>, 40 s token refresh and the PayStep
 * state machine (PayPanel). Contract: Specs/SPEC-2026-10-01-SAATHUM-SHOP.md §4.2 / §5.4. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useUser } from '@clerk/clerk-react';
import { ClerkIsland, getActiveToken, getActiveTokenWaited } from '../../lib/clerk';
import { IslandBoundary } from '../../components/IslandBoundary';
import { getPhoneStatus } from '../auth/passwordless';
import { hasClerkSessionHint } from '../../lib/sessionHint';
import { capture, captureException } from '../../lib/analytics';
import { ApiError } from '../../lib/apiClient';
import { clearCart, getCart, onCartChange, setQty } from '../../lib/shopCart';
import type { CartLine } from '../../lib/shopCart';
import { copyFor } from '../../lib/eventTypes';
import { YouStep } from '../saathum-checkout/YouStep';
import { getProfile, addressFromProfile } from '../saathum-checkout/profile';
import type { CheckoutProfile } from '../saathum-checkout/profile';
import { createOrder, getOrder, quoteCart } from './api';
import { AddressPanel, ReviewPanel, YouPanel, useToast, validateAddress } from './Steps';
import type { AddrErrors } from './Steps';
import { PayPanel } from './PayPanel';
import { DonePanel } from './DonePanel';
import { StepsBar, SumItems, SumNote, SumRows, SUM_NOTE, Thumb, inr, inrPaise } from './parts';
import type { Address, ShopOrder, ShopQuote, ShopStep } from './types';
import '../saathum-checkout/checkout.css';
import './shopCheckout.css';

const KEY_REQUEST = 'sshop:request_key';
const KEY_ORDER = 'sshop:order_id';
const EMPTY_ADDR: Address = { name: '', phone: '', line1: '', line2: '', city: '', state: '', pincode: '' };
const YOU_COPY = copyFor({ event_type: 'havan' }); // YouStep wants an event copy object; shop mode never reads it

function ss(op: 'get' | 'set' | 'del', key: string, value?: string): string | null {
  try {
    if (op === 'get') return window.sessionStorage.getItem(key);
    if (op === 'set') window.sessionStorage.setItem(key, value ?? '');
    else window.sessionStorage.removeItem(key);
  } catch { /* private mode — the in-memory state still works for this page */ }
  return null;
}
function requestKey(): string {
  const existing = ss('get', KEY_REQUEST);
  if (existing) return existing;
  const fresh = crypto.randomUUID();
  ss('set', KEY_REQUEST, fresh);
  return fresh;
}
function apiMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.body && typeof e.body === 'object') {
    const m = (e.body as { message?: string }).message;
    if (m) return m;
  }
  return fallback;
}
function setUrlOrder(id: string | null) {
  try {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('order', id); else url.searchParams.delete('order');
    window.history.replaceState(null, '', url.pathname + url.search);
  } catch { /* cosmetic only */ }
}

type Gate = 'checking' | 'out' | 'unverified' | 'ok';

function Inner() {
  const { user, isLoaded: userLoaded } = useUser();
  const [step, setStep] = useState<ShopStep>('you');
  const [gate, setGate] = useState<Gate>('checking');
  const [token, setToken] = useState<string | null>(null);
  const [sessionHint, setSessionHint] = useState(false);
  const [ready, setReady] = useState(false); // cart read from localStorage (after hydration)
  const [cart, setCart] = useState<CartLine[]>([]);
  const [profile, setProfile] = useState<CheckoutProfile | null>(null);
  const [waMasked, setWaMasked] = useState<string | null>(null);
  const [name, setName] = useState('');

  const [mode, setMode] = useState<'saved' | 'new'>('new');
  const [draft, setDraft] = useState<Address>(EMPTY_ADDR);
  const [addrErr, setAddrErr] = useState<AddrErrors>({});

  const [coupon, setCoupon] = useState<string | null>(null);
  const [couponInput, setCouponInput] = useState('');
  const [quote, setQuote] = useState<ShopQuote | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);

  const [agree, setAgree] = useState<[boolean, boolean]>([false, false]);
  const [agreeErr, setAgreeErr] = useState('');
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  const [order, setOrder] = useState<ShopOrder | null>(null);
  const [toastMsg, toastOn, toast] = useToast();

  const [resuming, setResuming] = useState(false); // an order id is waiting to be resumed (URL or this tab's storage)
  const gateStarted = useRef(false);
  const gateBusy = useRef(false);
  const hexMap = useRef(new Map<string, string>()); // product|colour -> hex, kept after the cart is cleared

  // ── cart (localStorage, after hydration) ──────────────────────────────
  useEffect(() => {
    const sync = (c: CartLine[]) => {
      c.forEach((l) => hexMap.current.set(`${l.product_id}|${l.colour}`, l.colour_hex));
      setCart(c);
    };
    sync(getCart());
    setReady(true);
    setSessionHint(hasClerkSessionHint());
    setResuming(Boolean(new URL(window.location.href).searchParams.get('order') || ss('get', KEY_ORDER)));
    return onCartChange(sync);
  }, []);
  const hexOf = useCallback((l: { product_id: string; colour: string }) => hexMap.current.get(`${l.product_id}|${l.colour}`) ?? '', []);

  // ── auth + WhatsApp gate, profile prefill, resume ─────────────────────
  const checkGate = useCallback(async () => {
    if (!user || gateBusy.current) return;
    gateBusy.current = true;
    try { await runGate(user.fullName); } finally { gateBusy.current = false; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function runGate(fullName: string | null) {
    const t = await getActiveTokenWaited().catch(() => null);
    if (!t) { setGate('unverified'); return; }
    setToken(t);
    const profileP = getProfile(t).then(
      (p) => {
        setProfile(p);
        setName((n) => n || p.name || fullName || '');
        const saved = addressFromProfile(p);
        if (saved) { setMode('saved'); setDraft((d) => (d.line1 ? d : { ...EMPTY_ADDR, ...saved })); }
      },
      (e) => captureException(e, { where: 'shop_checkout_profile_prefill' }),
    );
    try {
      const status = await getPhoneStatus();
      if (status.verified) {
        setWaMasked(status.phone);
        setGate('ok');
        void resume(t);
      } else {
        setGate('unverified');
      }
    } catch (e) {
      captureException(e, { where: 'shop_checkout_phone_status' });
      setGate('unverified');
    }
    await profileP;
  }

  useEffect(() => {
    if (!userLoaded) return;
    if (!user) { setGate('out'); return; }
    if (gateStarted.current) return;
    gateStarted.current = true;
    void checkGate();
  }, [userLoaded, user, checkGate]);

  /** ?order=<id> (kept in the URL once an order exists) or the id stored for this tab. */
  async function resume(t: string) {
    const fromQuery = new URL(window.location.href).searchParams.get('order');
    const id = fromQuery || ss('get', KEY_ORDER);
    if (!id) { setResuming(false); return; }
    try {
      const o = await getOrder(id, t);
      if (o.status === 'confirmed' && !fromQuery) { ss('del', KEY_ORDER); ss('del', KEY_REQUEST); return; } // stale: a new visit starts fresh
      if (o.status === 'confirmed') clearCart();
      setOrder(o);
      setStep(o.status === 'confirmed' ? 'done' : 'pay');
    } catch {
      ss('del', KEY_ORDER); // gone, or not this account's — start fresh
    } finally {
      setResuming(false);
    }
  }

  // Clerk JWTs live ~60 s: keep the token fresh while the page is open, and mint a new one right before money calls.
  const hasToken = !!token;
  useEffect(() => {
    if (!hasToken) return;
    const id = window.setInterval(() => {
      getActiveToken().then((t) => { if (t) setToken(t); }).catch(() => { /* next tick retries */ });
    }, 40_000);
    return () => clearInterval(id);
  }, [hasToken]);

  // ── live quote (debounced) from the cart + applied coupon ─────────────
  const cartKey = cart.map((l) => `${l.product_id}|${l.colour}|${l.size}|${l.qty}`).join(',');
  useEffect(() => {
    if (!ready || order || cart.length === 0) { setQuote(null); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const items = cart.map((l) => ({ product_id: l.product_id, colour: l.colour, size: l.size, qty: l.qty }));
      quoteCart(items, coupon, controller.signal)
        .then((q) => { setQuote(q); setQuoteErr(null); })
        .catch(async (e) => {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          if (coupon) {
            // the coupon stopped applying (minimum order, expiry…) — drop it and price the cart without it
            toast(apiMessage(e, 'That coupon no longer applies.'));
            setCoupon(null);
            return;
          }
          captureException(e, { where: 'shop_checkout_quote' });
          setQuote(null);
          setQuoteErr(apiMessage(e, 'Couldn’t calculate the total. Please try again.'));
        });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, order, cartKey, coupon]);

  // ── telemetry: one event per step entered ─────────────────────────────
  useEffect(() => {
    if (ready) capture('shop_checkout_step', { step });
  }, [step, ready]);

  async function applyCoupon() {
    const v = couponInput.trim().toUpperCase();
    if (!v) return;
    try {
      const items = cart.map((l) => ({ product_id: l.product_id, colour: l.colour, size: l.size, qty: l.qty }));
      const q = await quoteCart(items, v);
      setCoupon(v);
      setQuote(q);
      setQuoteErr(null);
      toast(`Coupon applied: ${inr(q.discount_rupees)} off`);
      capture('shop_coupon_applied', { code: v });
    } catch (e) {
      toast(apiMessage(e, 'That coupon code didn’t work.'));
      capture('shop_coupon_rejected', { code: v });
    }
  }

  // ── steps ─────────────────────────────────────────────────────────────
  const savedAddr = useMemo(() => addressFromProfile(profile), [profile]);
  function activeAddress(): Address {
    const a = mode === 'saved' && savedAddr ? savedAddr : draft;
    return { ...a, name: (a.name || name).trim(), phone: a.phone.trim() };
  }
  function goStep(s: ShopStep) { setStep(s); window.scrollTo(0, 0); }

  function continueFromAddress() {
    const a = activeAddress();
    const errs = validateAddress(a);
    setAddrErr(errs);
    if (Object.keys(errs).length) {
      // an incomplete saved address can't be fixed in place — open the form, seeded from it
      if (mode === 'saved') { setDraft({ ...EMPTY_ADDR, ...a }); setMode('new'); }
      return;
    }
    goStep('review');
  }

  async function toPay() {
    if (!(agree[0] && agree[1])) {
      setAgreeErr('Please agree to the Terms & Conditions and the Refund policy to continue.');
      capture('shop_checkout_terms_blocked');
      return;
    }
    setAgreeErr('');
    setCreateErr(null);
    const fresh = await getActiveToken().catch(() => null);
    const auth = fresh ?? token;
    if (!auth) { goStep('you'); return; }
    if (fresh) setToken(fresh);
    setCreating(true);
    try {
      const o = await createOrder(
        {
          request_key: requestKey(),
          items: cart.map((l) => ({ product_id: l.product_id, colour: l.colour, size: l.size, qty: l.qty })),
          ...(coupon ? { coupon } : {}),
          address: activeAddress(),
          accept_terms: true,
          refund_policy_accepted: true,
        },
        auth,
      );
      ss('set', KEY_ORDER, o.order_id);
      setUrlOrder(o.order_id);
      capture('shop_order_created', { order_id: o.order_id, total: o.quote.total_rupees });
      setOrder(o);
      goStep('pay');
    } catch (e) {
      captureException(e, { where: 'shop_checkout_create' });
      setCreateErr(apiMessage(e, 'Couldn’t start your payment. Please try again.'));
    } finally {
      setCreating(false);
    }
  }

  function onOrderUpdate(o: ShopOrder) {
    setOrder(o);
    if (o.status === 'confirmed') finish();
  }
  function finish() {
    ss('del', KEY_REQUEST);
    ss('del', KEY_ORDER);
    clearCart();
    setStep('done');
  }
  function startAgain() {
    ss('del', KEY_REQUEST);
    ss('del', KEY_ORDER);
    setUrlOrder(null);
    setOrder(null);
    setAgree([false, false]);
    goStep('review');
  }

  // ── render ────────────────────────────────────────────────────────────
  if (!ready) {
    return <div className="sh-co"><div className="sh-panel"><p role="status" style={{ margin: 0 }}>Loading checkout…</p></div><aside className="sh-panel sh-sum" /></div>;
  }

  // Empty cart (not while an order is in play) — mockup empty state, empty summary box and all.
  if (cart.length === 0 && !order && !resuming) {
    return (
      <div className="sh-co">
        <div>
          <div className="sh-panel sh-done"><h2>Your cart is empty</h2><p>Add a T-shirt to check out.</p><a className="sh-btn sh-btn--red" href="/shop/all">Browse T-shirts</a></div>
        </div>
        <aside className="sh-panel sh-sum" />
      </div>
    );
  }

  const checking = gate === 'checking' && (Boolean(user) || (!userLoaded && sessionHint));
  const firstName = (name || profile?.name || user?.firstName || '').trim().split(/\s+/)[0] ?? '';

  let main: ReactNode;
  if (step === 'you') {
    if (checking) {
      main = <><StepsBar step={1} /><div className="sh-panel"><p role="status" style={{ margin: 0 }}>Checking your account…</p></div></>;
    } else if (gate !== 'ok') {
      main = (
        <>
          <StepsBar step={1} />
          <div className="sthc">
            <YouStep
              shop
              signedIn={Boolean(user)}
              listingId="shop"
              eventType="havan"
              copy={YOU_COPY}
              stepIndex={1}
              totalSteps={4}
              onSignedIn={() => { gateStarted.current = true; void checkGate(); }}
              onVerified={() => { gateStarted.current = true; void checkGate(); }}
            />
          </div>
        </>
      );
    } else {
      main = (
        <YouPanel
          waMasked={waMasked}
          name={name}
          onName={setName}
          email={user?.primaryEmailAddress?.emailAddress ?? ''}
          onContinue={() => goStep('address')}
        />
      );
    }
  } else if (step === 'address') {
    main = (
      <AddressPanel
        saved={savedAddr}
        mode={savedAddr ? mode : 'new'}
        onMode={setMode}
        draft={draft}
        onDraft={(a) => { setDraft(a); if (Object.keys(addrErr).length) setAddrErr({}); }}
        errors={addrErr}
        onBack={() => goStep('you')}
        onContinue={continueFromAddress}
      />
    );
  } else if (step === 'review') {
    const a = activeAddress();
    main = (
      <ReviewPanel
        cart={cart}
        hexOf={hexOf}
        onQty={(i, q) => setQty(i, q)}
        shipTo={`${a.line1}, ${a.city} ${a.pincode}`}
        agree={agree}
        onAgree={(i, v) => { setAgree((p) => (i === 0 ? [v, p[1]] : [p[0], v])); setAgreeErr(''); }}
        agreeErr={agreeErr}
        busy={creating}
        createErr={createErr}
        onBack={() => goStep('address')}
        onPay={() => void toPay()}
      />
    );
  } else if (step === 'pay' && order && token) {
    main = <PayPanel order={order} auth={token} onUpdate={onOrderUpdate} onDone={finish} onStartAgain={startAgain} />;
  } else if (step === 'done' && order && token) {
    main = <DonePanel order={order} auth={token} firstName={firstName} />;
  } else {
    main = <div className="sh-panel"><p role="status" style={{ margin: 0 }}>Loading your order…</p></div>;
  }

  // ── Order summary (the mockup's renderSum) ────────────────────────────
  let sum: ReactNode;
  if (step === 'done' && order) {
    sum = (
      <>
        <h2>Paid</h2>
        <SumItems lines={order.items} hexOf={hexOf} />
        <div className="sh-row sh-row--tot"><span>Total paid</span><span>{inrPaise(order.pay_amount_paise ?? order.payment.amount_paise)}</span></div>
        <p style={{ font: '700 14px Nunito', color: '#1e8a4c', margin: 0 }}>✓ Shows in Dashboard → Billing</p>
      </>
    );
  } else if (order) {
    sum = (
      <>
        <h2>Order summary</h2>
        <SumItems lines={order.quote.lines} hexOf={hexOf} />
        <SumRows quote={order.quote} />
        <SumNote />
      </>
    );
  } else {
    sum = (
      <>
        <h2>Order summary</h2>
        {quote ? <SumItems lines={quote.lines} hexOf={hexOf} /> : cart.map((l) => (
          <div className="sh-sum-item" key={`${l.product_id}|${l.colour}|${l.size}`}>
            <Thumb url={l.image_url} hex={l.colour_hex} />
            <div><b>{l.name}</b><small>{l.colour} · {l.size} · Qty {l.qty}</small></div>
            <strong>{inr(l.unit_rupees * l.qty)}</strong>
          </div>
        ))}
        <div className="sh-coupon">
          <input placeholder="Coupon code" aria-label="Coupon code" value={couponInput} onChange={(e) => setCouponInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void applyCoupon(); }} />
          <button type="button" className="sh-btn sh-btn--ghost" style={{ minHeight: 46 }} onClick={() => void applyCoupon()}>Apply</button>
        </div>
        {quote ? <SumRows quote={quote} /> : <p style={{ font: '700 14px Nunito', color: '#6b4a2b' }}>{quoteErr ?? 'Calculating your total…'}</p>}
        <p style={{ font: '700 13px Nunito', color: '#7a6a55', margin: 0 }}>{SUM_NOTE}</p>
      </>
    );
  }

  return (
    <>
      <div className="sh-co">
        <div>{main}</div>
        <aside className="sh-panel sh-sum">{sum}</aside>
      </div>
      <div className={`sh-toast${toastOn ? ' is-on' : ''}`} role="status" aria-live="polite">{toastMsg}</div>
    </>
  );
}

export function ShopCheckout() {
  return (
    <IslandBoundary island="shop-checkout">
      <ClerkIsland>
        <Inner />
      </ClerkIsland>
    </IslandBoundary>
  );
}

export default ShopCheckout;
