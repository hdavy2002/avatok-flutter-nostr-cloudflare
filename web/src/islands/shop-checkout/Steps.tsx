/* [SAATHUM-SHOP-WEB-CHECKOUT-1] Steps 1-3 of the shop checkout (You / Delivery address / Review). Markup is
 * the mockup's renderCheckout() steps 1-3, one-to-one. Sign-in itself is the event checkout's YouStep
 * (reused, `shop` copy) — this file only draws the signed-in, WhatsApp-verified panel the mockup shows. */
import { useRef, useState } from 'react';
import { INDIAN_STATES } from '../saathum-checkout/OfferingsStep';
import type { CartLine } from '../../lib/shopCart';
import { StepsBar, Thumb } from './parts';
import type { Address } from './types';

/* ───────────── 1 · You ───────────── */
export function YouPanel({
  waMasked, name, onName, email, onContinue,
}: {
  waMasked: string | null; name: string; onName: (v: string) => void; email: string; onContinue: () => void;
}) {
  return (
    <>
      <StepsBar step={1} />
      <div className="sh-panel">
        <h2>You</h2>
        <p>Signed in. Order updates come on WhatsApp and email.</p>
        <div className="sh-wa"><i>✓</i>WhatsApp {waMasked ? `${waMasked} ` : ''}verified</div>
        <div className="sh-form">
          <label>Full name<input value={name} onChange={(e) => onName(e.target.value)} autoComplete="name" /></label>
          <label>Email<input value={email} readOnly autoComplete="email" /></label>
        </div>
        <div style={{ marginTop: 18 }}>
          <button type="button" className="sh-btn sh-btn--red" onClick={onContinue}>Continue to address →</button>
        </div>
      </div>
    </>
  );
}

/* ───────────── 2 · Delivery address ───────────── */
export type AddrErrors = Partial<Record<'line1' | 'pincode' | 'city' | 'state' | 'phone', string>>;

/** Same rules as the event checkout's OfferingsStep.validateAddress (phone optional, 6-digit PIN, state from the list). */
export function validateAddress(a: Address): AddrErrors {
  const errs: AddrErrors = {};
  const ph = a.phone.replace(/[\s-]/g, '').replace(/^(\+91|0)/, '');
  if (ph && !/^[6-9]\d{9}$/.test(ph)) errs.phone = 'Enter a 10-digit mobile number, or leave it blank.';
  if (!a.line1.trim()) errs.line1 = 'Enter the address.';
  if (!a.city.trim()) errs.city = 'Enter the city.';
  if (!a.state.trim()) errs.state = 'Choose a state.';
  if (!/^\d{6}$/.test(a.pincode.trim())) errs.pincode = 'Enter a 6-digit PIN code.';
  return errs;
}

export function AddressPanel({
  saved, mode, onMode, draft, onDraft, errors, onBack, onContinue,
}: {
  saved: Address | null;
  mode: 'saved' | 'new';
  onMode: (m: 'saved' | 'new') => void;
  draft: Address;
  onDraft: (a: Address) => void;
  errors: AddrErrors;
  onBack: () => void;
  onContinue: () => void;
}) {
  const set = (patch: Partial<Address>) => onDraft({ ...draft, ...patch });
  return (
    <>
      <StepsBar step={2} />
      <div className="sh-panel">
        <h2>Delivery address</h2>
        <p>Saved addresses from your profile appear first.</p>
        {saved && (
          <label className="sh-opt" style={{ background: '#fff', border: `2px solid ${mode === 'saved' ? '#b3261e' : '#e3cfa9'}`, borderRadius: 14, padding: 14, marginBottom: 14 }}>
            <input type="radio" name="ad" checked={mode === 'saved'} onChange={() => onMode('saved')} />{' '}
            <span><b style={{ color: '#5a1f14' }}>{saved.name || 'Saved address'}</b> — {saved.line1}{saved.line2 ? `, ${saved.line2}` : ''}, {saved.city}, {saved.state} {saved.pincode}</span>
          </label>
        )}
        {saved ? (
          <details open={mode === 'new'} onToggle={(e) => onMode((e.currentTarget as HTMLDetailsElement).open ? 'new' : 'saved')}>
            <summary className="sh-link" style={{ display: 'inline' }}>+ Use a new address</summary>
            <NewAddressForm draft={draft} set={set} errors={errors} />
          </details>
        ) : (
          <NewAddressForm draft={draft} set={set} errors={errors} />
        )}
        <div style={{ marginTop: 18, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" className="sh-btn sh-btn--ghost" onClick={onBack}>← Back</button>
          <button type="button" className="sh-btn sh-btn--red" onClick={onContinue}>Continue to review →</button>
        </div>
      </div>
    </>
  );
}

function NewAddressForm({ draft, set, errors }: { draft: Address; set: (p: Partial<Address>) => void; errors: AddrErrors }) {
  return (
    <div className="sh-form" style={{ marginTop: 14 }}>
      <label className="full">Address line
        <input placeholder="House, street, area" value={draft.line1} autoComplete="address-line1" onChange={(e) => set({ line1: e.target.value })} aria-invalid={!!errors.line1} />
        {errors.line1 && <span className="sh-err" role="alert">{errors.line1}</span>}
      </label>
      <label>Pincode
        <input placeholder="248001" inputMode="numeric" maxLength={6} value={draft.pincode} autoComplete="postal-code" onChange={(e) => set({ pincode: e.target.value.replace(/\D/g, '').slice(0, 6) })} aria-invalid={!!errors.pincode} />
        {errors.pincode && <span className="sh-err" role="alert">{errors.pincode}</span>}
      </label>
      <label>City
        <input value={draft.city} autoComplete="address-level2" onChange={(e) => set({ city: e.target.value })} aria-invalid={!!errors.city} />
        {errors.city && <span className="sh-err" role="alert">{errors.city}</span>}
      </label>
      <label>State
        <select value={draft.state} onChange={(e) => set({ state: e.target.value })} aria-invalid={!!errors.state}>
          <option value="">Choose a state</option>
          {INDIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {errors.state && <span className="sh-err" role="alert">{errors.state}</span>}
      </label>
      <label>Phone for courier
        <input placeholder="+91" inputMode="tel" value={draft.phone} autoComplete="tel" onChange={(e) => set({ phone: e.target.value })} aria-invalid={!!errors.phone} />
        {errors.phone && <span className="sh-err" role="alert">{errors.phone}</span>}
      </label>
    </div>
  );
}

/* ───────────── 3 · Review ───────────── */
export function ReviewPanel({
  cart, hexOf, onQty, shipTo, agree, onAgree, agreeErr, busy, createErr, onBack, onPay,
}: {
  cart: CartLine[];
  hexOf: (l: CartLine) => string;
  onQty: (index: number, qty: number) => void;
  shipTo: string;
  agree: [boolean, boolean];
  onAgree: (i: 0 | 1, v: boolean) => void;
  agreeErr: string;
  busy: boolean;
  createErr: string | null;
  onBack: () => void;
  onPay: () => void;
}) {
  return (
    <>
      <StepsBar step={3} />
      <div className="sh-panel">
        <h2>Review your order</h2>
        <p>Check sizes now — every tee is printed to order, so sizes can’t be changed later.</p>
        {cart.map((l, i) => (
          <div className="sh-sum-item" key={`${l.product_id}|${l.colour}|${l.size}`}>
            <Thumb url={l.image_url} hex={hexOf(l)} />
            <div><b>{l.name}</b><small>{l.colour} · Size {l.size}</small></div>
            <div className="sh-qty" style={{ height: 40 }}>
              <button type="button" aria-label="Decrease quantity" onClick={() => onQty(i, l.qty - 1)}>−</button>
              <span>{l.qty}</span>
              <button type="button" aria-label="Increase quantity" onClick={() => onQty(i, l.qty + 1)}>+</button>
            </div>
          </div>
        ))}
        <p style={{ font: '700 15px Nunito', color: '#3c4a4c', margin: '16px 0 0' }}>Ships to: {shipTo} · Printed to order, arrives in 5–8 days</p>
        <label className="sh-opt" style={{ marginTop: 14 }}>
          <input type="checkbox" checked={agree[0]} onChange={(e) => onAgree(0, e.target.checked)} /> I agree to the{' '}
          <a className="sh-link" style={{ fontSize: 15 }} href="/terms#shop" target="_blank" rel="noopener">Terms &amp; Conditions</a>
        </label>
        <label className="sh-opt" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={agree[1]} onChange={(e) => onAgree(1, e.target.checked)} /> I agree to the{' '}
          <a className="sh-link" style={{ fontSize: 15 }} href="/refunds#shop" target="_blank" rel="noopener">Refund policy</a> — no returns; refund only if we send the wrong item
        </label>
        <p className="sh-err" role="alert">{agreeErr || createErr}</p>
        <div style={{ marginTop: 18, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" className="sh-btn sh-btn--ghost" onClick={onBack}>← Back</button>
          <button type="button" className="sh-btn sh-btn--red" disabled={busy} onClick={onPay}>{busy ? 'Please wait…' : 'Go to payment →'}</button>
        </div>
      </div>
    </>
  );
}

export function useToast(): [string, boolean, (m: string) => void] {
  const [msg, setMsg] = useState('');
  const [on, setOn] = useState(false);
  const timer = useRef<number | null>(null);
  function toast(m: string) {
    setMsg(m); setOn(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOn(false), 2200);
  }
  return [msg, on, toast];
}
