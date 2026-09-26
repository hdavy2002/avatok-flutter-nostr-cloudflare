/* [SAATHUM-CHECKOUT-UI 2026-09-26] Step 3 — Offerings: chadhava qty,
 * dakshina for the priest, prasad courier toggle + (when on) the REQUIRED
 * shipping address. Chadhava images fall back gracefully on 404, per spec's
 * seed-data note. The live total footer reads the debounced quote the parent
 * (SaathumCheckout) fetches from POST /checkout/quote. */
import { useEffect, useState } from 'react';
import { capture } from '../../lib/analytics';
import type { Address, ChadhavaItem, ChadhavaSelection, OfferingsState, Quote } from './types';

const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh',
  'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland',
  'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir',
  'Ladakh', 'Lakshadweep', 'Puducherry',
];

function ChadhavaImage({ item }: { item: ChadhavaItem }) {
  const [broken, setBroken] = useState(false);
  if (!item.image_url || broken) return <div className="sthc-im">🪔</div>;
  return (
    <div className="sthc-im">
      <img src={item.image_url} alt="" onError={() => setBroken(true)} />
    </div>
  );
}

export function OfferingsStep({
  chadhavaCatalog,
  dakshinaPresets,
  prasadAvailable,
  prasadPriceRupees,
  state,
  onChange,
  address,
  onAddressChange,
  quote,
  quoteError,
  onBack,
  onContinue,
  listingId,
}: {
  chadhavaCatalog: ChadhavaItem[];
  dakshinaPresets: number[];
  prasadAvailable: boolean;
  prasadPriceRupees: number;
  state: OfferingsState;
  onChange: (s: OfferingsState) => void;
  address: Address | null;
  onAddressChange: (a: Address) => void;
  quote: Quote | null;
  quoteError: string | null;
  onBack: () => void;
  onContinue: () => void;
  listingId: string;
}) {
  const [dakshinaOther, setDakshinaOther] = useState('');
  const [addrErr, setAddrErr] = useState<Record<string, string>>({});
  const a: Address = address ?? { name: '', phone: '', line1: '', line2: '', city: '', state: '', pincode: '' };

  useEffect(() => {
    capture('saathum_checkout_step', { step: 'offerings', listing_id: listingId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function qtyFor(id: string): number {
    return state.chadhava.find((c) => c.id === id)?.qty ?? 0;
  }
  function setQty(id: string, qty: number) {
    const clamped = Math.max(0, Math.min(20, qty));
    const next: ChadhavaSelection[] = state.chadhava.filter((c) => c.id !== id);
    if (clamped > 0) next.push({ id, qty: clamped });
    onChange({ ...state, chadhava: next });
  }
  function setDakshina(v: number) {
    onChange({ ...state, dakshina_rupees: v });
  }
  function setPrasad(on: boolean) {
    onChange({ ...state, prasad: on });
  }

  function validateAddress(): boolean {
    const errs: Record<string, string> = {};
    if (!a.name.trim()) errs.name = 'Enter a name for delivery.';
    if (!a.phone.trim()) errs.phone = 'Enter a phone number.';
    if (!a.line1.trim()) errs.line1 = 'Enter the address.';
    if (!a.city.trim()) errs.city = 'Enter the city.';
    if (!a.state.trim()) errs.state = 'Choose a state.';
    if (!/^\d{6}$/.test(a.pincode.trim())) errs.pincode = 'Enter a 6-digit PIN code.';
    setAddrErr(errs);
    return Object.keys(errs).length === 0;
  }

  function submit() {
    if (state.prasad && !validateAddress()) return;
    onContinue();
  }

  return (
    <div className="sthc-card">
      <button className="sthc-back" onClick={onBack} type="button">&larr; Back</button>
      <div className="sthc-kick">Step 3 of 5 · Offerings</div>
      <h3 className="sthc-h3">Chadhava &amp; donation</h3>
      <div className="sthc-dots"><i className="on" /><i className="on" /><i className="on" /><i /><i /></div>

      {chadhavaCatalog.map((item) => (
        <div className="sthc-item" key={item.id}>
          <ChadhavaImage item={item} />
          <div>
            <b>{item.title}</b>
            <small>₹{item.price_rupees}</small>
          </div>
          <div className="sthc-qty">
            <button type="button" aria-label={`Fewer ${item.title}`} disabled={qtyFor(item.id) <= 0} onClick={() => setQty(item.id, qtyFor(item.id) - 1)}>&minus;</button>
            <span>{qtyFor(item.id)}</span>
            <button type="button" aria-label={`More ${item.title}`} disabled={qtyFor(item.id) >= 20} onClick={() => setQty(item.id, qtyFor(item.id) + 1)}>+</button>
          </div>
        </div>
      ))}

      <div className="sthc-fld" style={{ marginTop: 10 }}>
        <label>Dakshina for the priest <em>Optional</em></label>
      </div>
      <div className="sthc-chips">
        {dakshinaPresets.map((v) => (
          <button
            key={v}
            type="button"
            className={state.dakshina_rupees === v ? 'on' : ''}
            onClick={() => { setDakshina(v); setDakshinaOther(''); }}
          >
            ₹{v}
          </button>
        ))}
        <button
          type="button"
          className={!dakshinaPresets.includes(state.dakshina_rupees) && state.dakshina_rupees > 0 ? 'on' : ''}
          onClick={() => setDakshina(dakshinaOther ? Number(dakshinaOther) : 0)}
        >
          Other
        </button>
        {!dakshinaPresets.includes(state.dakshina_rupees) && (
          <input
            className="sthc-in"
            style={{ width: 100 }}
            inputMode="numeric"
            placeholder="₹"
            value={dakshinaOther}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, '').slice(0, 6);
              setDakshinaOther(v);
              setDakshina(v ? Math.min(100000, Number(v)) : 0);
            }}
          />
        )}
      </div>

      {prasadAvailable && (
        <>
          <div className="sthc-tog">
            <span>📦 Prasad courier · ₹{prasadPriceRupees}</span>
            <button type="button" className={state.prasad ? 'on' : ''} aria-pressed={state.prasad} onClick={() => setPrasad(!state.prasad)} />
          </div>
          {state.prasad && (
            <>
              <div className="sthc-fld">
                <label>Shipping address <em>Required</em></label>
              </div>
              <div className="sthc-fld">
                <input className="sthc-in" placeholder="Full name" aria-invalid={!!addrErr.name} value={a.name} onChange={(e) => onAddressChange({ ...a, name: e.target.value })} />
                {addrErr.name && <p className="sthc-err">{addrErr.name}</p>}
              </div>
              <div className="sthc-fld">
                <input className="sthc-in" placeholder="Phone" inputMode="tel" aria-invalid={!!addrErr.phone} value={a.phone} onChange={(e) => onAddressChange({ ...a, phone: e.target.value })} />
                {addrErr.phone && <p className="sthc-err">{addrErr.phone}</p>}
              </div>
              <div className="sthc-fld">
                <input className="sthc-in" placeholder="House, street" aria-invalid={!!addrErr.line1} value={a.line1} onChange={(e) => onAddressChange({ ...a, line1: e.target.value })} />
                {addrErr.line1 && <p className="sthc-err">{addrErr.line1}</p>}
              </div>
              <div className="sthc-fld">
                <input className="sthc-in" placeholder="Area, landmark (optional)" value={a.line2 ?? ''} onChange={(e) => onAddressChange({ ...a, line2: e.target.value })} />
              </div>
              <div className="sthc-two-col">
                <div className="sthc-fld">
                  <input className="sthc-in" placeholder="City" aria-invalid={!!addrErr.city} value={a.city} onChange={(e) => onAddressChange({ ...a, city: e.target.value })} />
                  {addrErr.city && <p className="sthc-err">{addrErr.city}</p>}
                </div>
                <div className="sthc-fld">
                  <select className="sthc-in" aria-invalid={!!addrErr.state} value={a.state} onChange={(e) => onAddressChange({ ...a, state: e.target.value })}>
                    <option value="">State</option>
                    {INDIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  {addrErr.state && <p className="sthc-err">{addrErr.state}</p>}
                </div>
              </div>
              <div className="sthc-fld">
                <input className="sthc-in" placeholder="6-digit PIN code" inputMode="numeric" maxLength={6} aria-invalid={!!addrErr.pincode}
                  value={a.pincode} onChange={(e) => onAddressChange({ ...a, pincode: e.target.value.replace(/\D/g, '').slice(0, 6) })} />
                {addrErr.pincode && <p className="sthc-err">{addrErr.pincode}</p>}
              </div>
              <div className="sthc-hint sthc-hint--gold">
                Prasad ships the same day as the havan. You can change this address any time before it starts.
              </div>
            </>
          )}
        </>
      )}

      {quoteError && <p className="sthc-err" role="alert">{quoteError}</p>}
      {quote && (
        <div className="sthc-row tot" style={{ marginTop: 4 }}>
          <span>Total so far</span><span>₹{quote.total_rupees.toLocaleString('en-IN')}</span>
        </div>
      )}
      <button className="sthc-btn" onClick={submit}>Continue &rarr;</button>
    </div>
  );
}
