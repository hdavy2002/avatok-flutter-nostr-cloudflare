/* [AUMFE-CONSULT-F2-1 2026-10-02] Steps 3 + 4 in one scroll, as in the mockup BookSlotPay: day + time, up to three
 * questions, price lines, UPI / wallet choice, refund-policy tickbox, Pay. The slot is only HELD when Pay is pressed
 * (the wizard creates the booking then), so browsing times never blocks anyone. */
import { useEffect, useState } from 'react';
import { capture, captureException } from '../../lib/analytics';
import { getSlots, consultMessage } from '../../lib/consultApi';
import type { PriceBreakdown, SlotDay } from '../../lib/consultTypes';
import { inr } from '../../lib/shopUi';
import { dayParts, fmtSlotDay, fmtSlotTime, istTodayISO } from './bookLogic';

export type PayMethod = 'upi' | 'wallet';

export function SlotPay({
  slug, auth, consultantFirst, slotMs, onSlot, questions, onQuestions, price, walletBalance, method, onMethod,
  agree, onAgree, busy, error, photoIssue, onRetakePhotos, onPay,
}: {
  slug: string; auth: string; consultantFirst: string;
  slotMs: number | null; onSlot: (ms: number | null) => void;
  questions: string[]; onQuestions: (q: string[]) => void;
  price: PriceBreakdown; walletBalance: number | null;
  method: PayMethod; onMethod: (m: PayMethod) => void;
  agree: boolean; onAgree: (v: boolean) => void;
  busy: boolean; error: string | null;
  photoIssue: string | null; onRetakePhotos: () => void;
  onPay: () => void;
}) {
  const [days, setDays] = useState<SlotDay[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setDays(null); setLoadErr(null);
    getSlots(slug, istTodayISO(), 14, auth)
      .then((r) => {
        if (!live) return;
        setDays(r.days);
        const withSlot = slotMs ? r.days.find((d) => d.slots.some((s) => s.start_ms === slotMs)) : undefined;
        setDate((withSlot ?? r.days.find((d) => d.slots.length > 0))?.date ?? null);
        if (slotMs && !withSlot) onSlot(null); // the time from the link was taken meanwhile
      })
      .catch((e) => { if (live) { captureException(e, { where: 'consult_book_slots' }); setLoadErr(consultMessage(e, 'We couldn’t load the available times.')); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, auth === '' ? 0 : 1, tick]);

  const times = days?.find((d) => d.date === date)?.slots ?? [];
  const canWallet = walletBalance != null && walletBalance >= price.total;
  const ready = slotMs != null && agree && !busy && !photoIssue;
  const nQ = Math.max(2, Math.min(3, questions.length));
  const qs = [...questions, '', ''].slice(0, nQ);
  const tzNote = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone === 'Asia/Kolkata' ? 'Times in IST. You’re in India, so no conversion needed.' : 'Times are in IST (India time).'; } catch { return 'Times are in IST (India time).'; }
  })();

  return (
    <>
      <div className="cb-prog">
        <div className="steps"><span className="on" /><span className="on" /><span className="on" /><span /></div>
        <span className="label">Step 3 of 4 · Time and questions</span>
      </div>
      <div className="card cb-stack" style={{ gap: 12 }}>
        {loadErr && <p className="cb-err" role="alert">{loadErr} <button type="button" className="edit" onClick={() => setTick((t) => t + 1)}>Try again</button></p>}
        {!days && !loadErr && <p className="hint" role="status">Loading times…</p>}
        {days && days.every((d) => d.slots.length === 0) && <p className="hint" role="status">{consultantFirst} has no free times in the next two weeks. Please check back soon.</p>}
        {days && days.some((d) => d.slots.length > 0) && (
          <>
            <div className="cb-days" role="group" aria-label="Choose a day">
              {days.map((d) => {
                const p = dayParts(d.date);
                const none = d.slots.length === 0;
                return (
                  <button key={d.date} type="button" className={`slot${d.date === date ? ' on' : ''}${none ? ' off' : ''}`} disabled={none} aria-pressed={d.date === date} onClick={() => setDate(d.date)}>
                    {p.dow}<br />{p.day}
                  </button>
                );
              })}
            </div>
            <div className="cb-times" role="group" aria-label="Choose a time">
              {times.map((s) => (
                <button key={s.start_ms} type="button" className={`slot${s.start_ms === slotMs ? ' on' : ''}`} aria-pressed={s.start_ms === slotMs} onClick={() => onSlot(s.start_ms)}>{s.label || fmtSlotTime(s.start_ms)}</button>
              ))}
            </div>
            <span className="hint">{tzNote}</span>
          </>
        )}
      </div>

      <div className="cb-stack" style={{ gap: 10 }}>
        <h3 style={{ fontSize: 18 }}>Questions for {consultantFirst} <span className="muted" style={{ fontFamily: "'Nunito',sans-serif", fontSize: 15, fontWeight: 700 }}>(optional, up to 3)</span></h3>
        {qs.map((q, i) => (
          <div className="field" key={i}>
            <label htmlFor={`q${i + 1}`}>Question {i + 1}</label>
            <textarea id={`q${i + 1}`} value={q} maxLength={300} onChange={(e) => onQuestions(qs.map((x, j) => (j === i ? e.target.value : x)))} />
          </div>
        ))}
        {nQ < 3 && <button type="button" className="edit left" onClick={() => onQuestions([...qs, ''])}>+ Add a third question</button>}
      </div>

      <div className="cb-prog">
        <div className="steps"><span className="on" /><span className="on" /><span className="on" /><span className="on" /></div>
        <span className="label">Step 4 of 4 · Pay</span>
      </div>
      <div className="card cb-price">
        <div className="row"><span>Session · {slotMs ? `${fmtSlotDay(slotMs)}, ${fmtSlotTime(slotMs)}` : 'pick a time above'}</span><span>{inr(price.rate)}</span></div>
        <div className="row"><span>GST {price.gst_rate_pct}%</span><span>{inr(price.gst)}</span></div>
        <hr />
        <div className="row tot"><span>Total</span><span>{inr(price.total)}</span></div>
      </div>
      <div className="cb-stack" style={{ gap: 10 }}>
        <label className={`card cb-method${method === 'upi' ? ' on' : ''}`}>
          <input type="radio" name="pay" checked={method === 'upi'} onChange={() => onMethod('upi')} />
          <b>UPI — scan QR or pay to UPI ID</b>
        </label>
        {walletBalance != null && (
          <label className={`card cb-method${method === 'wallet' ? ' on' : ''}`} aria-disabled={!canWallet}>
            <input type="radio" name="pay" checked={method === 'wallet'} disabled={!canWallet} onChange={() => onMethod('wallet')} />
            <b>Wallet · balance {inr(walletBalance)}{!canWallet ? ' (not enough)' : ''}</b>
          </label>
        )}
      </div>
      <label className="cb-agree">
        <input type="checkbox" checked={agree} onChange={(e) => { onAgree(e.target.checked); if (e.target.checked) capture('consult_refund_policy_ticked'); }} />
        <span>I have read and agree to the <a href="/refunds" target="_blank" rel="noopener">refund policy</a></span>
      </label>
      {photoIssue && <p className="cb-err" role="alert">{photoIssue} <button type="button" className="edit" onClick={onRetakePhotos}>Retake photos</button></p>}
      {error && <p className="cb-err" role="alert">{error}</p>}
      <button type="button" className="btn red block" disabled={!ready} onClick={onPay}>{busy ? 'Please wait…' : `Pay ${inr(price.total)}`}</button>
      <p className="hint cb-center">This slot is held for you for 10 minutes once you tap Pay.</p>
    </>
  );
}
