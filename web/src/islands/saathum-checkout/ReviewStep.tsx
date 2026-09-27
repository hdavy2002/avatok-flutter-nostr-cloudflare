/* [SAATHUM-CHECKOUT-UI 2026-09-26] Step 4 — Review: quote lines, GST 18%
 * (only when gst.enabled), total, two required checkboxes, "Pay ₹X by UPI".
 *
 * [SAATHUM-EVENT-TYPES 2026-09-27] Non-ritual events (satsang, sermon,
 * meditation) never see chadhava, prasad or an address — this step is where
 * they instead get one optional "offering" chips row (copy.offeringLabel),
 * writing the chosen amount into the same dakshina_rupees field a ritual
 * event's Offerings step would have set.
 */
import { useEffect, useState } from 'react';
import { capture } from '../../lib/analytics';
import type { Quote } from './types';
import type { EventType, EventTypeCopy } from '../../lib/eventTypes';

export function ReviewStep({
  quote,
  quoteError,
  gstEnabled,
  onBack,
  onPay,
  paying,
  listingId,
  ritual,
  copy,
  eventType,
  stepIndex,
  totalSteps,
  offeringPresets,
  offeringAmount,
  onOfferingChange,
}: {
  quote: Quote | null;
  quoteError: string | null;
  gstEnabled: boolean;
  onBack: () => void;
  onPay: () => void;
  paying: boolean;
  listingId: string;
  ritual: boolean;
  copy: EventTypeCopy;
  eventType: EventType;
  stepIndex: number;
  totalSteps: number;
  offeringPresets: number[];
  offeringAmount: number;
  onOfferingChange: (v: number) => void;
}) {
  const [terms, setTerms] = useState(false);
  const [refund, setRefund] = useState(false);
  const [offeringOther, setOfferingOther] = useState('');

  useEffect(() => {
    capture('saathum_checkout_step', { step: 'review', listing_id: listingId, event_type: eventType });
    if (quote) capture('saathum_checkout_quote', { total_rupees: quote.total_rupees });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote?.total_rupees]);

  const canPay = terms && refund && !!quote && !paying;
  const dots = Array.from({ length: totalSteps }, (_, i) => (
    <i key={i} className={i < stepIndex ? 'on' : ''} />
  ));

  return (
    <div className="sthc-card">
      <button className="sthc-back" onClick={onBack} type="button">&larr; Back</button>
      <div className="sthc-kick">Step {stepIndex} of {totalSteps} · Review</div>
      <h3 className="sthc-h3">Your total</h3>
      <div className="sthc-dots">{dots}</div>

      {!ritual && (
        <>
          <div className="sthc-fld" style={{ marginTop: 4 }}>
            <label>{copy.offeringLabel}</label>
          </div>
          <div className="sthc-chips">
            {offeringPresets.map((v) => (
              <button
                key={v}
                type="button"
                className={offeringAmount === v ? 'on' : ''}
                onClick={() => { onOfferingChange(v); setOfferingOther(''); }}
              >
                ₹{v}
              </button>
            ))}
            <button
              type="button"
              className={!offeringPresets.includes(offeringAmount) && offeringAmount > 0 ? 'on' : ''}
              onClick={() => onOfferingChange(offeringOther ? Number(offeringOther) : 0)}
            >
              Other
            </button>
            {!offeringPresets.includes(offeringAmount) && (
              <input
                className="sthc-in"
                style={{ width: 100 }}
                inputMode="numeric"
                placeholder="₹"
                value={offeringOther}
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, '').slice(0, 6);
                  setOfferingOther(v);
                  onOfferingChange(v ? Math.min(100000, Number(v)) : 0);
                }}
              />
            )}
          </div>
        </>
      )}

      {quoteError && <p className="sthc-err" role="alert">{quoteError}</p>}
      {!quote && !quoteError && <p style={{ font: '700 17px Nunito, sans-serif', color: 'var(--sub)' }}>Calculating…</p>}
      {quote && (
        <div style={{ marginBottom: 12 }}>
          {quote.lines.map((line, i) => (
            <div className="sthc-row" key={`${line.kind}-${line.id ?? i}`}>
              <span>{line.label}{line.qty > 1 ? ` × ${line.qty}` : ''}</span>
              <b>₹{line.amount_rupees.toLocaleString('en-IN')}</b>
            </div>
          ))}
          <div className="sthc-row">
            <span>Subtotal</span><b>₹{quote.subtotal_rupees.toLocaleString('en-IN')}</b>
          </div>
          {gstEnabled && quote.gst_rate_pct > 0 && (
            <div className="sthc-row">
              <span>GST {quote.gst_rate_pct}%</span><b>₹{quote.gst_rupees.toLocaleString('en-IN')}</b>
            </div>
          )}
          <div className="sthc-row tot">
            <span>Total</span><span>₹{quote.total_rupees.toLocaleString('en-IN')}</span>
          </div>
        </div>
      )}

      <label className="sthc-check">
        <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
        <span>I agree to the <a href="/terms" target="_blank" rel="noopener noreferrer">Terms</a></span>
      </label>
      <label className="sthc-check">
        <input type="checkbox" checked={refund} onChange={(e) => setRefund(e.target.checked)} />
        <span>I have read the <a href="/refunds" target="_blank" rel="noopener noreferrer">Refund policy</a></span>
      </label>

      <button className="sthc-btn" disabled={!canPay} onClick={onPay}>
        {paying ? 'One moment…' : `Pay ₹${quote ? quote.total_rupees.toLocaleString('en-IN') : '—'} by UPI →`}
      </button>
    </div>
  );
}
