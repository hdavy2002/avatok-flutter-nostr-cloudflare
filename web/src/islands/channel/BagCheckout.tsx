/* [HF-CHANNEL-WEB-1] Merch checkout for the whole Bag: steps Bag ✓ · Address · Payment · Done, on one page (the page is /checkout/merch).
 * Signed out -> sign in and back here. A verified WhatsApp number is required (as for single-item checkout). Address: saved addresses
 * (GET /api/hf/merch/addresses) or a new one. Payment: rupee wallet (instant) or pay online (UPI, cards, netbanking). One tick: terms +
 * "no returns / report within 48 hours". POST /api/hf/merch/checkout { items:[...] } (contract C3) makes one order per line, paid once.
 * Online payment: the buyer goes to the hosted payment page and comes back to /dashboard/orders?group=<groupId>.
 * Telemetry: bag_checkout_started, bag_paid, merch_pay_method_chosen, merch_checkout_step, merch_checkout_failed. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hfCall, fetchWallet, signInUrl } from '../../lib/hfCallsApi';
import { spendablePaise } from '../dashboard-hf/v3/data';
import { openCheckout } from '../../lib/hfTopupApi';
import { capture, captureException } from '../../lib/analytics';
import { publicImage } from '../../lib/config';
import { INDIAN_STATES, checkoutBag, deleteAddress, listAddresses, merchCheckoutEnabled, validateAddress, type AddressInput, type BagCheckoutDone, type SavedAddress } from '../../lib/merchApi';
import { bagCount, bagTotalPaise, clearBag, removeFromBag, bagLineKey } from '../../lib/merchBag';
import { rupees } from '../../lib/merchPublic';
import { artUrl } from '../../lib/hfChannelArt';
import SessionBridge from '../calls/SessionBridge';
import { useBag } from './useBag';

type Step = 'boot' | 'signin' | 'whatsapp' | 'address' | 'payment' | 'done' | 'broken';
const LINE_MAX = 50;
const EMPTY: AddressInput = { name: '', phone: '', line1: '', line2: '', city: '', state: '', pincode: '' };
type Errs = Partial<Record<keyof AddressInput, string>>;
const phone10 = (v: string) => v.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '').slice(0, 10);
const maskPhone = (p: string) => (p.length >= 10 ? `${p.slice(0, 2)}•••••${p.slice(-3)}` : p);

export default function BagCheckout() {
  const lines = useBag();
  const [step, setStep] = useState<Step>('boot');
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saved, setSaved] = useState<SavedAddress[]>([]);
  const [pickId, setPickId] = useState('new');
  const [addr, setAddr] = useState<AddressInput>(EMPTY);
  const [errs, setErrs] = useState<Errs>({});
  const [save, setSave] = useState(true);
  const [agree, setAgree] = useState(false);
  const [method, setMethod] = useState<'wallet' | 'cashfree'>('cashfree');
  const [balance, setBalance] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [badId, setBadId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; productId?: string; topup?: boolean } | null>(null);
  const [done, setDone] = useState<{ d: BagCheckoutDone; hostSlug: string; hostName: string; total: number } | null>(null);
  const key = useRef<{ sig: string; key: string } | null>(null);
  const total = bagTotalPaise(lines);
  const n = bagCount(lines);

  const go = useCallback((s: Step) => { setStep(s); setMsg(null); capture('merch_checkout_step', { step: s, surface: 'bag' }); }, []);

  useEffect(() => { let live = true; void merchCheckoutEnabled().then(v => { if (live) setEnabled(v); }); return () => { live = false; }; }, []);

  // who is this, what is in the wallet, which addresses are saved
  useEffect(() => {
    let live = true;
    (async () => {
      const me = await hfCall<{ uid: string; whatsappVerified?: boolean }>('GET', '/api/hf/me');
      if (!live) return;
      if (!me.ok) { if (me.status === 401) go('signin'); else { captureException(new Error(`bag_me_${me.status}_${me.code}`), { area: 'hf_merch_fan', step: 'boot' }); go('broken'); } return; }
      if (me.data.whatsappVerified === false) { go('whatsapp'); return; }
      const [w, a] = await Promise.all([fetchWallet(), listAddresses()]);
      if (!live) return;
      const bal = w.ok ? spendablePaise(w.data) : null;
      setBalance(bal);
      const list = a.ok ? a.data.addresses : [];
      setSaved(list);
      if (list.length) { setPickId(list[0].id); setSave(false); }
      go('address');
    })().catch(e => { captureException(e, { area: 'hf_merch_fan', step: 'boot' }); if (live) go('broken'); });
    return () => { live = false; };
  }, [go]);
  // default payment method: wallet when it covers the total
  useEffect(() => { if (balance != null && balance >= total && total > 0) setMethod(m => (m === 'cashfree' && !key.current ? 'wallet' : m)); }, [balance]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen: AddressInput | null = useMemo(() => {
    if (pickId === 'new') return { ...addr, phone: phone10(addr.phone), name: addr.name.trim(), line1: addr.line1.trim(), line2: addr.line2.trim(), city: addr.city.trim() };
    const s = saved.find(x => x.id === pickId);
    return s ? { name: s.name, phone: phone10(s.phone), line1: s.line1, line2: s.line2 ?? '', city: s.city, state: s.state, pincode: s.pincode } : null;
  }, [pickId, addr, saved]);
  const set = (k: keyof AddressInput, v: string) => { setAddr(a => ({ ...a, [k]: v })); if (errs[k]) setErrs(e => ({ ...e, [k]: undefined })); };

  const toPayment = () => {
    if (!chosen) return;
    const e = validateAddress(chosen);
    setErrs(e);
    if (Object.keys(e).length) { setMsg({ text: 'Please fix the highlighted fields.' }); return; }
    go('payment');
  };
  const removeSaved = async (id: string) => {
    const r = await deleteAddress(id);
    if (r.ok) { const rest = saved.filter(s => s.id !== id); setSaved(rest); if (pickId === id) setPickId(rest[0]?.id ?? 'new'); }
    else setMsg({ text: 'We could not remove that address. Please try again.' });
  };

  const fail = (status: number, code: string, message: string, body: Record<string, unknown>) => {
    capture('merch_checkout_failed', { code, status, surface: 'bag', lines: lines.length });
    if (status === 0 || status >= 500 || code === 'gateway_error') captureException(new Error(`bag_checkout_${status}_${code}`), { area: 'hf_merch_fan', step: 'pay', code });
    if (code === 'whatsapp_required') { go('whatsapp'); return; }
    if (code === 'insufficient_balance') {
      key.current = null;
      const short = Number(body.shortPaise) || (balance != null ? Math.max(0, total - balance) : 0);
      if (typeof body.balancePaise === 'number') setBalance(body.balancePaise);
      setMsg({ text: short ? `Your wallet is short by ${rupees(short)}. Top up the wallet, or pay online.` : 'Your wallet balance is too low. Top up the wallet, or pay online.', topup: true }); return;
    }
    if (code === 'item_unavailable') {
      key.current = null;
      // The server answers FLAT: { error:'item_unavailable', message, productId, reason }. Older shape kept as a fallback.
      const extra = (body.extra ?? {}) as { productId?: string; reason?: string };
      const pid = typeof body.productId === 'string' ? body.productId : extra.productId;
      const reason = typeof body.reason === 'string' ? body.reason : extra.reason;
      const line = lines.find(l => l.productId === pid);
      setBadId(pid ?? null);
      setMsg({ text: `${line ? `“${line.title}”` : 'One of the items'} is no longer available${reason === 'size' || reason === 'colour' ? ' in that option' : ''}. Remove it from your bag to continue. Nothing was charged.`, productId: pid }); return;
    }
    if (code === 'order_closed') key.current = null;
    if (status === 400 && typeof body.field === 'string' && /^(address|name|phone|line1|line2|city|state|pincode)/.test(body.field)) { go('address'); setMsg({ text: message || 'Please check your address.' }); return; }
    const friendly: Record<string, string> = {
      checkout_off: 'Buying opens soon.', own_product: 'You cannot buy your own product.', gone: 'An item in your bag is no longer available.',
      account_closing: message || 'Your account is being closed.', wallet_debt: message || 'Please clear the amount due on your wallet first.',
      gateway_error: 'The payment page did not open. Nothing was charged. Please try again.', payments_unavailable: 'Payments are not available right now. Please try again in a little while.',
    };
    setMsg({ text: friendly[code] ?? (message || 'Something went wrong. Nothing was charged. Please try again.') });
  };

  const pay = async () => {
    if (!chosen || busy || !agree || lines.length === 0) return;
    capture('bag_checkout_started', { source: 'checkout', method, lines: lines.length, items: n, total_paise: total });
    capture('merch_pay_method_chosen', { method, surface: 'bag', price_paise: total, wallet_paise: balance ?? undefined });
    setBusy(true); setMsg(null);
    const items = lines.map(l => ({ productId: l.productId, colour: l.colour, size: l.size, qty: l.qty }));
    const sig = JSON.stringify([items, chosen, method]);
    if (!key.current || key.current.sig !== sig) key.current = { sig, key: crypto.randomUUID() };
    const r = await checkoutBag({ items, address: chosen, saveAddress: pickId === 'new' && save, acceptTerms: true, acceptRefund: true, method, requestKey: key.current.key });
    if (!r.ok) { setBusy(false); if (r.status === 401) { go('signin'); return; } fail(r.status, r.code, r.message, r.body); return; }
    const d = r.data;
    if (d.status === 'paid') {
      capture('bag_paid', { group_id: d.groupId, method: 'wallet', orders: d.orders.length, total_paise: d.totalPaise });
      const last = lines[lines.length - 1];
      setDone({ d, hostSlug: last?.hostSlug ?? '', hostName: last?.hostName ?? '', total: d.totalPaise });
      clearBag(); setBusy(false); go('done'); return;
    }
    try { sessionStorage.setItem('hf_bag_group', d.groupId); } catch { /* optional */ }
    const back = `/dashboard/orders?group=${encodeURIComponent(d.groupId)}`;
    if (d.checkoutUrl && /^https:\/\//.test(d.checkoutUrl)) { location.assign(d.checkoutUrl); return; }
    if (d.paymentSessionId) {
      try { await openCheckout('cashfree', { payment_session_id: d.paymentSessionId }, false); } catch { /* the orders page decides */ }
      location.assign(back); return;
    }
    setBusy(false); fail(502, 'gateway_error', '', {});
  };

  const walletOk = balance != null && balance >= total;
  const empty = lines.length === 0 && step !== 'done';
  const stepNo = step === 'payment' ? 3 : step === 'done' ? 4 : 2;

  const stepper = <div className="steps" aria-label="Steps">
    <div className="step done"><span className="n">✓</span>Bag</div><span className="step-l" />
    <div className={`step ${stepNo > 2 ? 'done' : 'on'}`} aria-current={stepNo === 2 ? 'step' : undefined}><span className="n">{stepNo > 2 ? '✓' : 2}</span>Address</div><span className="step-l" />
    <div className={`step ${stepNo === 3 ? 'on' : stepNo > 3 ? 'done' : ''}`} aria-current={stepNo === 3 ? 'step' : undefined}><span className="n">{stepNo > 3 ? '✓' : 3}</span>Payment</div><span className="step-l" />
    <div className={`step ${stepNo === 4 ? 'on' : ''}`} aria-current={stepNo === 4 ? 'step' : undefined}><span className="n">4</span>Done</div>
  </div>;

  if (step === 'done' && done) {
    const art = artUrl('orderDone');
    const one = done.d.orders.length === 1;
    return <section className="sec done" aria-labelledby="dn" style={{ minHeight: '60vh' }}>
      <div className="wrap">
        <div>
          <p className="eyebrow">Order placed</p>
          <h1 className="h2 poster-title" id="dn">Picture abhi<br />baaki hai!</h1>
          <p style={{ marginTop: 16, fontSize: 19, color: '#e2dbee' }}>{one ? `Order ${done.d.orders[0].orderNo}` : `${done.d.orders.length} orders`} · {rupees(done.total)} paid. We’ll message you when {one ? 'it’s' : 'they’re'} printed and on the way.</p>
          <div className="acts2">
            <a className="btn btn-y" href={`/dashboard/orders?group=${encodeURIComponent(done.d.groupId)}`}>Track my order</a>
            {done.hostSlug && <a className="btn btn-ghost" href={`/h/${done.hostSlug}`}>Back to {done.hostName}</a>}
          </div>
        </div>
        <div className="art">{art ? <img src={art} alt="" width="1600" height="1200" /> : <span>Your parcel is on its way to the printer.</span>}</div>
      </div>
    </section>;
  }

  return <main className="sec" style={{ paddingTop: 40 }} id="checkout-main"><div className="wrap">
    <SessionBridge on />
    {stepper}
    {enabled === false && <p className="banner" role="status">Buying opens soon. Your bag is saved, so you can come back and pay when it opens.</p>}
    {step === 'boot' && <p className="sub" role="status">Getting things ready…</p>}
    {step === 'signin' && <div className="gate"><h2>Sign in to pay</h2><p>Sign in with your WhatsApp number. You will come straight back to your bag.</p><a className="btn btn-r" href={signInUrl('/checkout/merch')}>Sign in</a></div>}
    {step === 'whatsapp' && <div className="gate"><h2>Verify your WhatsApp number</h2><p>We send your order updates on WhatsApp, so a verified number is needed to buy.</p><a className="btn btn-r" href="/dashboard/profile">Verify WhatsApp</a></div>}
    {step === 'broken' && <div className="gate"><h2>We could not start checkout</h2><p>Please check your internet and try again.</p><button type="button" className="btn btn-r" onClick={() => location.reload()}>Try again</button></div>}
    {empty && (step === 'address' || step === 'payment') && <div className="gate"><h2>Your bag is empty</h2><p>Add something first.</p><a className="btn btn-r" href="/marketplace">Find influencers</a></div>}

    {!empty && (step === 'address' || step === 'payment') && <div className="two">
      <div>
        {step === 'address' && <form className="panel" noValidate onSubmit={e => { e.preventDefault(); toPayment(); }} aria-labelledby="ad">
          <h2 id="ad">Delivery address</h2>
          {saved.length > 0 && <div className="saved" role="radiogroup" aria-label="Saved addresses">
            {saved.map(s => <label key={s.id} className={`payopt${pickId === s.id ? ' on' : ''}`}>
              <input type="radio" name="addr" checked={pickId === s.id} onChange={() => setPickId(s.id)} /><span className="rd" />
              <span style={{ flex: 1 }}><b>{s.name} · {s.phone}</b>{s.line1}{s.line2 ? `, ${s.line2}` : ''}, {s.city}, {s.state} {s.pincode}</span>
              <button type="button" className="lnk" onClick={() => void removeSaved(s.id)} aria-label={`Remove address for ${s.name}`}>Remove</button>
            </label>)}
            <label className={`payopt${pickId === 'new' ? ' on' : ''}`}><input type="radio" name="addr" checked={pickId === 'new'} onChange={() => setPickId('new')} /><span className="rd" /><span><b>Use a new address</b></span></label>
          </div>}
          {pickId === 'new' && <div className="form">
            <Field id="a-name" label="Full name" err={errs.name}><input id="a-name" autoComplete="name" value={addr.name} onChange={e => set('name', e.target.value)} aria-invalid={!!errs.name} /></Field>
            <Field id="a-phone" label="Mobile number (10 digits)" err={errs.phone}><input id="a-phone" type="tel" inputMode="numeric" autoComplete="tel-national" maxLength={14} value={addr.phone} onChange={e => set('phone', phone10(e.target.value))} aria-invalid={!!errs.phone} /></Field>
            <Field id="a-l1" label="House no., building, street" err={errs.line1} full><input id="a-l1" autoComplete="address-line1" maxLength={LINE_MAX} value={addr.line1} onChange={e => set('line1', e.target.value)} aria-invalid={!!errs.line1} /></Field>
            <Field id="a-l2" label="Area, landmark (optional)" err={errs.line2} full><input id="a-l2" autoComplete="address-line2" maxLength={LINE_MAX} value={addr.line2} onChange={e => set('line2', e.target.value)} aria-invalid={!!errs.line2} /></Field>
            <Field id="a-city" label="City" err={errs.city}><input id="a-city" autoComplete="address-level2" maxLength={40} value={addr.city} onChange={e => set('city', e.target.value)} aria-invalid={!!errs.city} /></Field>
            <Field id="a-pin" label="Pincode" err={errs.pincode}><input id="a-pin" inputMode="numeric" autoComplete="postal-code" maxLength={6} value={addr.pincode} onChange={e => set('pincode', e.target.value.replace(/\D/g, '').slice(0, 6))} aria-invalid={!!errs.pincode} /></Field>
            <Field id="a-state" label="State" err={errs.state} full><select id="a-state" autoComplete="address-level1" value={addr.state} onChange={e => set('state', e.target.value)} aria-invalid={!!errs.state}><option value="">Select state</option>{INDIAN_STATES.map(s => <option key={s}>{s}</option>)}</select></Field>
            <label className="ck field full"><input type="checkbox" checked={save} onChange={e => setSave(e.target.checked)} /><i aria-hidden="true">{save ? '✓' : ''}</i><span>Save this address for next time</span></label>
          </div>}
          {msg && <p className="errp" role="alert">{msg.text}</p>}
          <button type="submit" className="btn btn-r" style={{ marginTop: 22, minWidth: 260 }}>Continue to payment</button>
        </form>}

        {step === 'payment' && chosen && <>
          <section className="panel" aria-labelledby="ad2">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><h2 id="ad2">Delivery address</h2><button className="lnk" type="button" onClick={() => go('address')}>Change</button></div>
            <p style={{ marginTop: 8 }}>{chosen.name} · {maskPhone(chosen.phone)}<br />{chosen.line1}{chosen.line2 ? `, ${chosen.line2}` : ''}, {chosen.city}, {chosen.state} {chosen.pincode}</p>
          </section>
          <section className="panel" aria-labelledby="pm">
            <h2 id="pm" style={{ marginBottom: 16 }}>Payment</h2>
            <div role="radiogroup" aria-label="Payment method">
              <label className={`payopt${method === 'wallet' ? ' on' : ''}${!walletOk ? ' dis' : ''}`}>
                <input type="radio" name="pm" checked={method === 'wallet'} disabled={!walletOk} onChange={() => setMethod('wallet')} /><span className="rd" />
                <span><b>Wallet</b>{balance != null ? `Balance ${rupees(balance)} · ` : ''}{walletOk ? 'pays instantly' : `short by ${rupees(total - (balance ?? 0))}`}</span>
              </label>
              <label className={`payopt${method === 'cashfree' ? ' on' : ''}`}>
                <input type="radio" name="pm" checked={method === 'cashfree'} onChange={() => setMethod('cashfree')} /><span className="rd" />
                <span><b>Pay online</b>UPI, cards or netbanking</span>
              </label>
            </div>
            {!walletOk && <p style={{ margin: '4px 0 8px' }}><a className="nun" href="/dashboard/wallet" onClick={() => capture('merch_topup_clicked', { surface: 'bag' })}>Top up your wallet →</a></p>}
            <label className="ck"><input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} /><i aria-hidden="true">{agree ? '✓' : ''}</i>
              <span>I agree to the <a href="/terms" target="_blank" rel="noopener">Terms</a>. Printed-to-order items can’t be returned for a change of mind; wrong or damaged items are fixed if reported within 48 hours of delivery. See the <a href="/refunds" target="_blank" rel="noopener">refund policy</a>.</span></label>
            {msg && <p className="errp" role="alert">{msg.text}{msg.topup && <> <a href="/dashboard/wallet">Top up wallet</a></>}{msg.productId && <> <button type="button" className="lnk" onClick={() => { const l = lines.find(x => x.productId === msg.productId); if (l) removeFromBag(bagLineKey(l)); setBadId(null); setMsg(null); }}>Remove it</button></>}</p>}
            <button type="button" className="btn btn-r" style={{ marginTop: 22, minWidth: 320 }} disabled={!agree || busy || enabled === false} onClick={() => void pay()}>
              {enabled === false ? 'Buying opens soon' : busy ? (method === 'cashfree' ? 'Opening payment page…' : 'Paying…') : `Pay ${rupees(total)}`}</button>
          </section>
        </>}
      </div>
      <aside className="sumcard" aria-label="Order summary">
        <h2 style={{ marginBottom: 12 }}>Your order</h2>
        {lines.map(l => <div className={`miniline${badId && l.productId === badId ? ' unavail' : ''}`} key={bagLineKey(l)} aria-invalid={badId && l.productId === badId ? true : undefined}>
          <div className="im">{l.imageUrl && <img src={publicImage(l.imageUrl, { width: 160 })} alt="" width="64" height="64" />}</div>
          <div><b className="nun">{l.title}</b><br />{[l.colour, l.size].filter(Boolean).join(' · ')}{l.qty > 1 ? ` · × ${l.qty}` : ''}</div>
          <b className="nun">{rupees(l.unitPaise * l.qty)}</b>
        </div>)}
        <div className="srow" style={{ marginTop: 8 }}><span>Delivery</span><span className="nun">Free</span></div>
        <div className="srow t"><span>Total</span><span>{rupees(total)}</span></div>
        <p className="fine" style={{ textAlign: 'left', marginTop: 10 }}>GST included. We check each order before it goes to print.</p>
        <p style={{ marginTop: 10 }}><a className="nun" href="/bag">← Edit bag</a></p>
      </aside>
    </div>}
  </div></main>;
}

function Field({ id, label, err, full, children }: { id: string; label: string; err?: string; full?: boolean; children: React.ReactNode }) {
  return <div className={`field${full ? ' full' : ''}`}><label htmlFor={id}>{label}</label>{children}{err && <span className="err" role="alert">{err}</span>}</div>;
}
