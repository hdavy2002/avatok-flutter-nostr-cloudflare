/* [SAATHUM-CHECKOUT-UI 2026-09-26] Step 4 — Review: quote lines, GST 18%
 * (only when gst.enabled), total, two required checkboxes, "Pay ₹X by UPI". */
import { useEffect, useState } from 'react';
import { capture } from '../../lib/analytics';
import type { Quote } from './types';

export function ReviewStep({
  quote,
  quoteError,
  gstEnabled,
  onBack,
  onPay,
  paying,
  listingId,
}: {
  quote: Quote | null;
  quoteError: string | null;
  gstEnabled: boolean;
  onBack: () => void;
  onPay: () => void;
  paying: boolean;
  listingId: string;
}) {
  const [terms, setTerms] = useState(false);
  const [refund, setRefund] = useState(false);

  useEffect(() => {
    capture('saathum_checkout_step', { step: 'review', listing_id: listingId });
    if (quote) capture('saathum_checkout_quote', { total_rupees: quote.total_rupees });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote?.total_rupees]);

  const canPay = terms && refund && !!quote && !paying;

  return (
    <div className="sthc-card">
      <button className="sthc-back" onClick={onBack} type="button">&larr; Back</button>
      <div className="sthc-kick">Step 4 of 5 · Review</div>
      <h3 className="sthc-h3">Your total</h3>
      <div className="sthc-dots"><i className="on" /><i className="on" /><i className="on" /><i className="on" /><i /></div>

      {quoteError && <p className="sthc-err" role="alert">{quoteError}</p>}
      {!quote && !quoteError && <p style={{ font: '700 14px Nunito, sans-serif', color: 'var(--sub)' }}>Calculating…</p>}
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
