/* [SAATHUM-CHECKOUT-UI 2026-09-26] Step 3 — Offerings: chadhava qty,
 * offering for the priest, prasad courier toggle + (when on) the REQUIRED
 * shipping address. Chadhava images fall back gracefully on 404, per spec's
 * seed-data note. The live total footer reads the debounced quote the parent
 * (SaathumCheckout) fetches from POST /checkout/quote. */
import { useEffect, useState } from 'react';
import { capture } from '../../lib/analytics';
import type { Address, ChadhavaItem, ChadhavaSelection, OfferingsState, Quote } from './types';
import type { EventType } from '../../lib/eventTypes';

const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh',
  'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland',
  'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir',
  'Ladakh', 'Lakshadweep', 'Puducherry',
];

// [SAATHUM-CHECKOUT-READABLE 2026-09-27] Owner: "the pictures of the chadhava
// are too tiny, I can hardly see what it is". Thumb is bigger by default and
// is a button — tapping it opens a lightbox with the full image and an X.
function ChadhavaImage({ item, onZoom }: { item: ChadhavaItem; onZoom: (item: ChadhavaItem) => void }) {
  const [broken, setBroken] = useState(false);
  if (!item.image_url || broken) return <div className="sthc-im">🪔</div>;
  return (
    <button type="button" className="sthc-im sthc-im--zoom" onClick={() => onZoom(item)} aria-label={`See a bigger picture of ${item.title}`}>
      <img src={item.image_url} alt="" onError={() => setBroken(true)} />
      <span className="sthc-im-zoom" aria-hidden="true">⤢</span>
    </button>
  );
}

function ChadhavaLightbox({ item, onClose }: { item: ChadhavaItem; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);
  return (
    <div className="sthc-lb" role="dialog" aria-modal="true" aria-label={item.title} onClick={onClose}>
      <div className="sthc-lb-box" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="sthc-lb-x" onClick={onClose} aria-label="Close" autoFocus>×</button>
        <img src={item.image_url ?? ''} alt={item.title} />
        <div className="sthc-lb-cap"><b>{item.title}</b><span>₹{item.price_rupees}</span></div>
        {item.description && <p>{item.description}</p>}
      </div>
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
  eventType,
  stepIndex,
  totalSteps,
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
  eventType: EventType;
  stepIndex: number;
  totalSteps: number;
}) {
  const [dakshinaOther, setDakshinaOther] = useState('');
  const [addrErr, setAddrErr] = useState<Record<string, string>>({});
  const a: Address = address ?? { name: '', phone: '', line1: '', line2: '', city: '', state: '', pincode: '' };

  useEffect(() => {
    capture('saathum_checkout_step', { step: 'offerings', listing_id: listingId, event_type: eventType });
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
    // [SAATHUM-PHONE-OPTIONAL 2026-09-27] Phone is optional; if typed, it must be a real mobile.
    const ph = a.phone.replace(/[\s-]/g, '').replace(/^(\+91|0)/, '');
    if (ph && !/^[6-9]\d{9}$/.test(ph)) errs.phone = 'Enter a 10-digit mobile number, or leave it blank.';
    if (!a.line1.trim()) errs.line1 = 'Enter the address.';
    if (!a.city.trim()) errs.city = 'Enter the city.';
    if (!a.state.trim()) errs.state = 'Choose a state.';
    if (!/^\d{6}$/.test(a.pincode.trim())) errs.pincode = 'Enter a 6-digit PIN code.';
    setAddrErr(errs);
    return Object.keys(errs).length === 0;
  }

  const [zoom, setZoom] = useState<ChadhavaItem | null>(null);

  function submit() {
    if (state.prasad && !validateAddress()) return;
    onContinue();
  }

  return (
    <div className="sthc-card">
      <button className="sthc-back" onClick={onBack} type="button">&larr; Back</button>
      <div className="sthc-kick">Step {stepIndex} of {totalSteps} · Offerings</div>
      <h3 className="sthc-h3">Chadhava &amp; offerings</h3>
      <div className="sthc-dots">
        {Array.from({ length: totalSteps }, (_, i) => <i key={i} className={i < stepIndex ? 'on' : ''} />)}
      </div>

      {chadhavaCatalog.map((item) => (
        <div className="sthc-item" key={item.id}>
          <ChadhavaImage item={item} onZoom={(it) => { setZoom(it); capture('saathum_chadhava_zoom', { chadhava_id: it.id }); }} />
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

      {zoom && <ChadhavaLightbox item={zoom} onClose={() => setZoom(null)} />}

      <div className="sthc-fld" style={{ marginTop: 10 }}>
        <label>Offering for the priest <em>Optional</em></label>
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
                <input className="sthc-in" placeholder="Phone (optional)" inputMode="tel" aria-invalid={!!addrErr.phone} value={a.phone} onChange={(e) => onAddressChange({ ...a, phone: e.target.value })} />
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
