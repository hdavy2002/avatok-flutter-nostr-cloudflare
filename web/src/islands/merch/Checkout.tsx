/* [HF-MERCH-FAN-WEB-1] Merch checkout sheet: sign-in + verified WhatsApp gate, delivery address, review with the terms and refund ticks,
 * then pay from the rupee wallet or by UPI / card (Cashfree, through the same hosted checkout page as wallet top-up).
 * Worker: POST /api/hf/merch/checkout (idempotent on requestKey). A Cashfree order returns checkoutUrl; the buyer comes back to
 * /dashboard/orders?order=<id>, which shows the payment-confirming state. A wallet order is paid at once.
 * Telemetry: merch_pay_method_chosen, merch_checkout_step, merch_checkout_failed (+ captureException for unexpected failures). */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hfCall, fetchWallet, signInUrl } from '../../lib/hfCallsApi';
import { spendablePaise } from '../dashboard-hf/v3/data';
import { openCheckout } from '../../lib/hfTopupApi';
import { capture, captureException } from '../../lib/analytics';
import {
  INDIAN_STATES, checkoutMerch, deleteAddress, listAddresses, rupees,
  type AddressInput, type CheckoutDone, type SavedAddress,
} from '../../lib/merchApi';

type Step = 'boot' | 'signin' | 'whatsapp' | 'address' | 'review' | 'pay' | 'done' | 'broken';
const LINE_MAX = 50;
const EMPTY: AddressInput = { name: '', phone: '', line1: '', line2: '', city: '', state: '', pincode: '' };
type Errs = Partial<Record<keyof AddressInput, string>>;

export function validateAddress(a: AddressInput): Errs {
  const e: Errs = {};
  if (a.name.trim().length < 2) e.name = 'Enter the name of the person receiving the parcel.';
  if (!/^[6-9]\d{9}$/.test(a.phone)) e.phone = 'Enter a 10-digit mobile number.';
  if (!a.line1.trim()) e.line1 = 'Enter house number, building and street.';
  else if (a.line1.length > LINE_MAX) e.line1 = `Keep this under ${LINE_MAX} characters.`;
  if (a.line2.length > LINE_MAX) e.line2 = `Keep this under ${LINE_MAX} characters.`;
  if (!a.city.trim()) e.city = 'Enter your city.';
  if (!a.state) e.state = 'Pick your state.';
  if (!/^[1-9]\d{5}$/.test(a.pincode)) e.pincode = 'Enter a 6-digit pincode.';
  return e;
}
const phone10 = (v: string) => v.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '').slice(0, 10);

interface Props {
  host: { slug: string; displayName: string };
  product: { id: string; slug: string; title: string; imageUrl: string | null };
  colour: string; size: string; qty: number; unitPaise: number; pincode: string; resumePath: string; onClose: () => void;
}

export default function Checkout({ host, product, colour, size, qty, unitPaise, pincode, resumePath, onClose }: Props) {
  const dlg = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState<Step>('boot');
  const [saved, setSaved] = useState<SavedAddress[]>([]);
  const [pickId, setPickId] = useState<string>('new');
  const [addr, setAddr] = useState<AddressInput>({ ...EMPTY, pincode });
  const [errs, setErrs] = useState<Errs>({});
  const [save, setSave] = useState(true);
  const [terms, setTerms] = useState(false);
  const [refund, setRefund] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [busy, setBusy] = useState<'wallet' | 'cashfree' | null>(null);
  const [msg, setMsg] = useState<{ text: string; topup?: boolean } | null>(null);
  const [done, setDone] = useState<CheckoutDone | null>(null);
  const key = useRef<{ sig: string; key: string } | null>(null);
  const total = unitPaise * qty;

  const resume = `${resumePath}?buy=1&colour=${encodeURIComponent(colour)}&size=${encodeURIComponent(size)}&qty=${qty}`;
  const track = useCallback((s: Step) => capture('merch_checkout_step', { step: s, host_slug: host.slug, product_slug: product.slug }), [host.slug, product.slug]);
  const go = useCallback((s: Step) => { setStep(s); setMsg(null); track(s); }, [track]);

  // Native <dialog> in the top layer; Escape / backdrop close it.
  useEffect(() => {
    const d = dlg.current; if (!d) return;
    try { d.showModal(); } catch { d.setAttribute('open', ''); }
    document.documentElement.style.overflow = 'hidden';
    return () => { document.documentElement.style.overflow = ''; if (d.open) d.close(); };
  }, []);

  // Who is this, what is in the wallet, and which addresses are saved. Three independent reads.
  useEffect(() => {
    let live = true;
    (async () => {
      const me = await hfCall<{ uid: string; whatsappVerified?: boolean }>('GET', '/api/hf/me');
      if (!live) return;
      if (!me.ok) { if (me.status === 401) go('signin'); else { captureException(new Error(`merch_me_${me.status}_${me.code}`), { area: 'hf_merch_fan', step: 'boot' }); go('broken'); } return; }
      if (me.data.whatsappVerified === false) { go('whatsapp'); return; }
      const [w, a] = await Promise.all([fetchWallet(), listAddresses()]);
      if (!live) return;
      setBalance(w.ok ? spendablePaise(w.data) : null);
      const list = a.ok ? a.data.addresses : [];
      setSaved(list);
      if (list.length) { setPickId(list[0].id); setSave(false); }
      go('address');
    })().catch(e => { captureException(e, { area: 'hf_merch_fan', step: 'boot' }); if (live) go('broken'); });
    return () => { live = false; };
  }, [go]);

  const chosen: AddressInput | null = useMemo(() => {
    if (pickId === 'new') return { ...addr, phone: phone10(addr.phone), name: addr.name.trim(), line1: addr.line1.trim(), line2: addr.line2.trim(), city: addr.city.trim() };
    const s = saved.find(x => x.id === pickId);
    return s ? { name: s.name, phone: phone10(s.phone), line1: s.line1, line2: s.line2 ?? '', city: s.city, state: s.state, pincode: s.pincode } : null;
  }, [pickId, addr, saved]);

  const set = (k: keyof AddressInput, v: string) => { setAddr(a => ({ ...a, [k]: v })); if (errs[k]) setErrs(e => ({ ...e, [k]: undefined })); };

  const toReview = () => {
    if (!chosen) return;
    const e = validateAddress(chosen);
    setErrs(e);
    if (Object.keys(e).length) { setMsg({ text: 'Please fix the highlighted fields.' }); return; }
    go('review');
  };

  const removeSaved = async (id: string) => {
    const r = await deleteAddress(id);
    if (r.ok) { const rest = saved.filter(s => s.id !== id); setSaved(rest); if (pickId === id) setPickId(rest[0]?.id ?? 'new'); }
    else setMsg({ text: 'We could not remove that address. Please try again.' });
  };

  const fail = (status: number, code: string, message: string, body: Record<string, unknown>) => {
    capture('merch_checkout_failed', { code, status, host_slug: host.slug, product_slug: product.slug });
    if (status === 0 || status >= 500 || code === 'gateway_error') captureException(new Error(`merch_checkout_${status}_${code}`), { area: 'hf_merch_fan', step: 'pay', code });
    if (code === 'whatsapp_required') { go('whatsapp'); return; }
    if (code === 'insufficient_balance') {
      const short = Number(body.shortPaise) || 0; if (typeof body.balancePaise === 'number') setBalance(body.balancePaise);
      key.current = null;
      setMsg({ text: `Your wallet is short by ${rupees(short)}. Top up the wallet, or pay with UPI / card.`, topup: true }); return;
    }
    if (code === 'order_closed') key.current = null;
    if (status === 400 && typeof body.field === 'string' && /^(address|name|phone|line1|line2|city|state|pincode)/.test(body.field)) { go('address'); setMsg({ text: message || 'Please check your address.' }); return; }
    const friendly: Record<string, string> = {
      checkout_off: 'Buying opens soon.', own_product: 'You cannot buy your own product.', gone: 'This product is no longer available.',
      account_closing: message || 'Your account is being closed.', wallet_debt: message || 'Please clear the amount due on your wallet first.',
      gateway_error: 'The payment page did not open. Nothing was charged. Please try again.', payments_unavailable: 'Payments are not available right now. Please try again in a little while.',
    };
    setMsg({ text: friendly[code] ?? (message || 'Something went wrong. Nothing was charged. Please try again.') });
  };

  const pay = async (method: 'wallet' | 'cashfree') => {
    if (!chosen || busy) return;
    capture('merch_pay_method_chosen', { method, host_slug: host.slug, product_slug: product.slug, price_paise: total, wallet_paise: balance ?? undefined });
    setBusy(method); setMsg(null);
    const sig = JSON.stringify([product.id, colour, size, qty, chosen, method]);
    if (!key.current || key.current.sig !== sig) key.current = { sig, key: crypto.randomUUID() };
    const r = await checkoutMerch({ productId: product.id, colour, size, qty, address: chosen, saveAddress: pickId === 'new' && save, acceptTerms: true, acceptRefund: true, method, requestKey: key.current.key });
    if (!r.ok) { setBusy(null); if (r.status === 401) { go('signin'); return; } fail(r.status, r.code, r.message, r.body); return; }
    const d = r.data;
    if (d.status === 'paid') { setDone(d); setBusy(null); go('done'); return; }
    // Cashfree: hand the buyer to the hosted checkout page; he returns to /dashboard/orders?order=<id>.
    if (d.checkoutUrl && /^https:\/\//.test(d.checkoutUrl)) { location.assign(d.checkoutUrl); return; }
    if (d.paymentSessionId) {
      try { await openCheckout('cashfree', { payment_session_id: d.paymentSessionId }, false); } catch { /* the orders page decides */ }
      location.assign(`/dashboard/orders?order=${encodeURIComponent(d.orderId)}`); return;
    }
    setBusy(null); fail(502, 'gateway_error', '', {});
  };

  const walletOk = balance == null || balance >= total;
  const close = () => { if (!busy) onClose(); };

  return <dialog ref={dlg} className="hfm-dlg" aria-label="Checkout" onClose={onClose} onCancel={e => { if (busy) e.preventDefault(); }} onClick={e => { if (e.target === dlg.current) close(); }}>
    <div className="hfm-dlg-in">
      <div className="hfm-dlg-top">
        <h2>{step === 'done' ? 'Order placed' : 'Checkout'}</h2>
        <button type="button" className="hfm-x" aria-label="Close checkout" onClick={close}>×</button>
      </div>
      {step !== 'boot' && step !== 'done' && step !== 'signin' && step !== 'whatsapp' && step !== 'broken' && <ol className="hfm-steps" aria-label="Checkout steps">
        {(['address', 'review', 'pay'] as const).map((s, i) => <li key={s} className={step === s ? 'on' : (['address', 'review', 'pay'].indexOf(step) > i ? 'past' : '')} aria-current={step === s ? 'step' : undefined}><span>{i + 1}</span>{s === 'address' ? 'Address' : s === 'review' ? 'Review' : 'Pay'}</li>)}
      </ol>}

      <div className="hfm-sum">
        {product.imageUrl && <img src={product.imageUrl} alt="" width="64" height="64" />}
        <div><b>{product.title}</b><small>{colour} · {size} · Qty {qty}</small></div>
        <strong>{rupees(total)}<small style={{ display: 'block', fontWeight: 400 }}>incl. GST &amp; delivery</small></strong>
      </div>

      {step === 'boot' && <p role="status" className="hfm-note">Getting things ready…</p>}

      {step === 'signin' && <div className="hfm-gate">
        <h3>Sign in to buy</h3>
        <p>Sign in with your WhatsApp number. You will come straight back here.</p>
        <a className="hfm-cta" href={signInUrl(resume)}>Sign in</a>
      </div>}

      {step === 'whatsapp' && <div className="hfm-gate">
        <h3>Verify your WhatsApp number</h3>
        <p>We send your order updates on WhatsApp, so a verified number is needed to buy.</p>
        <a className="hfm-cta" href="/dashboard/profile">Verify WhatsApp</a>
      </div>}

      {step === 'broken' && <div className="hfm-gate">
        <h3>We could not start checkout</h3>
        <p>Please check your internet and try again.</p>
        <button type="button" className="hfm-cta" onClick={() => location.reload()}>Try again</button>
      </div>}

      {step === 'address' && <form className="hfm-form" noValidate onSubmit={e => { e.preventDefault(); toReview(); }}>
        <h3>Where should we send it?</h3>
        {saved.length > 0 && <div className="hfm-saved" role="radiogroup" aria-label="Saved addresses">
          {saved.map(s => <label key={s.id} className={`hfm-addr${pickId === s.id ? ' on' : ''}`}>
            <input type="radio" name="addr" checked={pickId === s.id} onChange={() => setPickId(s.id)} />
            <span><b>{s.name}</b> · {s.phone}<br />{s.line1}{s.line2 ? `, ${s.line2}` : ''}<br />{s.city}, {s.state} {s.pincode}</span>
            <button type="button" className="hfm-link" onClick={() => void removeSaved(s.id)} aria-label={`Remove address for ${s.name}`}>Remove</button>
          </label>)}
          <label className={`hfm-addr${pickId === 'new' ? ' on' : ''}`}><input type="radio" name="addr" checked={pickId === 'new'} onChange={() => setPickId('new')} /><span><b>Use a new address</b></span></label>
        </div>}
        {pickId === 'new' && <div className="hfm-grid">
          <Field id="a-name" label="Full name" err={errs.name}><input id="a-name" autoComplete="name" value={addr.name} onChange={e => set('name', e.target.value)} aria-invalid={!!errs.name} /></Field>
          <Field id="a-phone" label="Mobile number (10 digits)" err={errs.phone}><input id="a-phone" type="tel" inputMode="numeric" autoComplete="tel-national" maxLength={14} value={addr.phone} onChange={e => set('phone', phone10(e.target.value))} aria-invalid={!!errs.phone} /></Field>
          <Field id="a-l1" label="House no., building, street" err={errs.line1} count={[addr.line1.length, LINE_MAX]}><input id="a-l1" autoComplete="address-line1" maxLength={LINE_MAX} value={addr.line1} onChange={e => set('line1', e.target.value)} aria-invalid={!!errs.line1} /></Field>
          <Field id="a-l2" label="Area, landmark (optional)" err={errs.line2} count={[addr.line2.length, LINE_MAX]}><input id="a-l2" autoComplete="address-line2" maxLength={LINE_MAX} value={addr.line2} onChange={e => set('line2', e.target.value)} aria-invalid={!!errs.line2} /></Field>
          <Field id="a-pin" label="Pincode" err={errs.pincode}><input id="a-pin" inputMode="numeric" autoComplete="postal-code" maxLength={6} value={addr.pincode} onChange={e => set('pincode', e.target.value.replace(/\D/g, '').slice(0, 6))} aria-invalid={!!errs.pincode} /></Field>
          <Field id="a-city" label="City" err={errs.city}><input id="a-city" autoComplete="address-level2" maxLength={40} value={addr.city} onChange={e => set('city', e.target.value)} aria-invalid={!!errs.city} /></Field>
          <Field id="a-state" label="State" err={errs.state}><select id="a-state" autoComplete="address-level1" value={addr.state} onChange={e => set('state', e.target.value)} aria-invalid={!!errs.state}><option value="">Select state</option>{INDIAN_STATES.map(s => <option key={s}>{s}</option>)}</select></Field>
          <label className="hfm-tick"><input type="checkbox" checked={save} onChange={e => setSave(e.target.checked)} /><span>Save this address for next time</span></label>
        </div>}
        {msg && <p className="hfm-err" role="alert">{msg.text}</p>}
        <button type="submit" className="hfm-cta">Continue</button>
      </form>}

      {step === 'review' && chosen && <div className="hfm-form">
        <h3>Check your order</h3>
        <dl className="hfm-facts">
          <div><dt>Deliver to</dt><dd>{chosen.name} · {chosen.phone}<br />{chosen.line1}{chosen.line2 ? `, ${chosen.line2}` : ''}<br />{chosen.city}, {chosen.state} {chosen.pincode}<br /><button type="button" className="hfm-link" onClick={() => go('address')}>Change address</button></dd></div>
          <div><dt>Delivery</dt><dd>Free across India. Printed to order, so it ships in a few days.</dd></div>
          <div><dt>Total (incl. GST &amp; delivery)</dt><dd><b>{rupees(total)}</b><br />No extra charges at checkout.</dd></div>
        </dl>
        <label className="hfm-tick"><input type="checkbox" checked={terms} onChange={e => setTerms(e.target.checked)} /><span>I agree to the <a href="/terms" target="_blank" rel="noopener">terms of use</a>.</span></label>
        <label className="hfm-tick"><input type="checkbox" checked={refund} onChange={e => setRefund(e.target.checked)} /><span>I understand there are <b>no returns</b>. If the item is wrong or damaged, I can report it within <b>48 hours</b> of delivery. See the <a href="/refunds" target="_blank" rel="noopener">refund policy</a>.</span></label>
        <button type="button" className="hfm-cta" disabled={!terms || !refund} onClick={() => go('pay')}>Continue to pay</button>
      </div>}

      {step === 'pay' && <div className="hfm-form">
        <h3>How would you like to pay?</h3>
        <button type="button" className="hfm-pay" disabled={!!busy || !walletOk} onClick={() => void pay('wallet')}>
          <b>{busy === 'wallet' ? 'Paying…' : `Pay from wallet${balance != null ? ` (balance ${rupees(balance)})` : ''}`}</b>
          <span>{walletOk ? `${rupees(total)} is taken from your wallet. Instant.` : `Short by ${rupees(total - (balance ?? 0))}.`}</span>
        </button>
        {!walletOk && <a className="hfm-link" href="/dashboard/wallet" onClick={() => capture('merch_topup_clicked', { host_slug: host.slug })}>Top up your wallet →</a>}
        <button type="button" className="hfm-pay alt" disabled={!!busy} onClick={() => void pay('cashfree')}>
          <b>{busy === 'cashfree' ? 'Opening payment page…' : 'Pay with UPI / card'}</b>
          <span>Secure payment page. UPI, cards and netbanking.</span>
        </button>
        {msg && <p className="hfm-err" role="alert">{msg.text}{msg.topup && <> <a href="/dashboard/wallet">Top up wallet</a></>}</p>}
        <p className="hfm-note">Your order is checked by our team before it is printed. If we cannot make it, you are refunded in full.</p>
      </div>}

      {step === 'done' && done && <div className="hfm-gate">
        <h3>Thank you! Order {done.orderNo} is placed.</h3>
        <p>We will confirm it on WhatsApp and email. You can follow it from My orders.</p>
        <a className="hfm-cta" href={`/dashboard/orders?order=${encodeURIComponent(done.orderId)}`}>Track my order</a>
        <a className="hfm-link" href={`/h/${host.slug}`}>Back to {host.displayName}</a>
      </div>}
    </div>
  </dialog>;
}

function Field({ id, label, err, count, children }: { id: string; label: string; err?: string; count?: [number, number]; children: React.ReactNode }) {
  return <div className={`hfm-fld${err ? ' bad' : ''}`}>
    <label htmlFor={id}>{label}</label>{children}
    <div className="hfm-fld-foot">{err ? <span role="alert">{err}</span> : <span />}{count && <small aria-live="off">{count[0]}/{count[1]}</small>}</div>
  </div>;
}
