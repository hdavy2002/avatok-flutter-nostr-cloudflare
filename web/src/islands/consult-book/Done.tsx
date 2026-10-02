/* [AUMFE-CONSULT-F2-1 2026-10-02] Step 5 — "You're booked" (mockup BookDone). "Add to calendar" builds an .ics in the
 * browser. The mockup's "Download receipt" has no endpoint in the contract yet, so the second button goes to
 * "My consultations" instead (where the booking, its Join button and the receipt-less history live). */
import { capture, captureException } from '../../lib/analytics';
import { BRAND } from '../../lib/brand';
import type { BookingDTO } from '../../lib/consultTypes';
import { DISCIPLINE_LABEL } from '../../lib/consultTypes';
import { inr } from '../../lib/shopUi';
import { buildIcs, fmtSlotDay, fmtSlotTime, maskEmail } from './bookLogic';

export function addToCalendar(b: BookingDTO): void {
  try {
    const ics = buildIcs({
      uid: `${b.id}@${BRAND.domain}`,
      title: `${DISCIPLINE_LABEL[b.discipline].en} call with ${b.consultant.name}`,
      startMs: b.slot_start_ms,
      endMs: b.slot_end_ms,
      description: `Audio call booked on ${BRAND.name}. Open ${BRAND.webOrigin}/dashboard/consultations to join (the Join button opens shortly before your time). Booking ${b.ref}.`,
      url: `${BRAND.webOrigin}/guides/session/${b.id}`,
      prodId: BRAND.name,
    });
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${BRAND.slug}-consultation-${b.ref}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    capture('consult_add_to_calendar', { discipline: b.discipline });
  } catch (e) {
    captureException(e, { where: 'consult_ics' });
  }
}

export function DonePanel({ booking, waMasked, email }: { booking: BookingDTO; waMasked: string | null; email: string }) {
  const mins = Math.round((booking.slot_end_ms - booking.slot_start_ms) / 60000);
  const early = Math.max(1, Math.round((booking.slot_start_ms - booking.join_opens_ms) / 60000));
  return (
    <>
      <div className="ribbon" />
      <div className="cb-done">
        <img className="sticker" src={booking.consultant.photo_url} alt={booking.consultant.name} />
        <h1>You&rsquo;re booked</h1>
        <p style={{ fontSize: 17 }}>{booking.consultant.name} will call with you on</p>
        <div className="card" style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6, padding: 18 }}>
          <span className="when">{fmtSlotDay(booking.slot_start_ms)} · {fmtSlotTime(booking.slot_start_ms)}</span>
          <span className="muted" style={{ fontSize: 15 }}>{mins} minutes · audio call · {inr(booking.price.total)} paid</span>
        </div>
        <div className="notes">
          <div><span className="chip">WhatsApp</span> Confirmation sent to {waMasked ?? 'your WhatsApp number'}</div>
          <div><span className="chip">Email</span> Sent to {email ? maskEmail(email) : 'your email'} with the details</div>
          <div><span className="chip neel">Reminder</span> A day before, and 15 min before</div>
        </div>
        <div className="acts">
          <button type="button" className="btn" onClick={() => addToCalendar(booking)}>Add to calendar</button>
          <a className="btn ghost" href="/dashboard/consultations">My consultations</a>
        </div>
        <p className="hint">The &ldquo;Join call&rdquo; button opens {early} minutes before your time.</p>
      </div>
    </>
  );
}
