/* [AUMFE-CONSULT-F2-1 2026-10-02] /dashboard/consultations — the customer's bookings (GET /api/consultants/bookings/mine).
 * Status chips, a Join button (links to /guides/session/<id>) once join_opens_ms has passed, cancel while a booking is
 * held / awaiting review. Dashboard 2 owns the ClerkProvider + auth guard, so this island only calls getActiveTokenWaited().
 * Admin-preview only while the flag is dark: a 403/404 from the API for a non-previewer sends the person to /dashboard. */
import { useCallback, useEffect, useState } from 'react';
import { getActiveTokenWaited } from '../../lib/clerk';
import { ApiError } from '../../lib/apiClient';
import { capture, captureException } from '../../lib/analytics';
import { usePreview } from '../../lib/preview';
import { cancelBooking, consultMessage, myBookings } from '../../lib/consultApi';
import { DISCIPLINE_LABEL } from '../../lib/consultTypes';
import type { BookingDTO, BookingStatus } from '../../lib/consultTypes';
import { inr } from '../../lib/shopUi';
import { fmtSlotDay, fmtSlotTime } from './bookLogic';
import '../../styles/consultants.css';
import './consultBook.css';

const STATUS: Record<BookingStatus, { text: string; cls: string }> = {
  held: { text: 'Waiting for payment', cls: 'gold' },
  awaiting_review: { text: 'Checking your payment', cls: 'gold' },
  confirmed: { text: 'Confirmed', cls: 'neel' },
  in_call: { text: 'Call in progress', cls: 'neel' },
  completed: { text: 'Completed', cls: '' },
  no_show_consultant: { text: 'Consultant did not join — refund being arranged', cls: 'red' },
  no_show_customer: { text: 'Missed', cls: 'gold' },
  cancelled: { text: 'Cancelled', cls: '' },
  expired: { text: 'Expired', cls: '' },
};
const UPCOMING: BookingStatus[] = ['held', 'awaiting_review', 'confirmed', 'in_call'];

export default function MyConsultations() {
  const preview = usePreview();
  const [rows, setRows] = useState<BookingDTO[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const t = await getActiveTokenWaited().catch(() => null);
      if (!t) { setErr('Please sign in again.'); return; }
      const r = await myBookings(t);
      setRows(r.bookings);
      setErr(null);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404) && !preview.loading && !preview.preview) { window.location.replace('/dashboard'); return; }
      captureException(e, { where: 'consult_mine_load' });
      setErr(consultMessage(e, 'We couldn’t load your consultations.'));
    }
  }, [preview.loading, preview.preview]);

  useEffect(() => { void load(); capture('consult_mine_viewed'); }, [load]);
  useEffect(() => {
    const id = window.setInterval(() => { setNow(Date.now()); if (document.visibilityState === 'visible') void load(); }, 30_000);
    return () => window.clearInterval(id);
  }, [load]);

  async function cancel(b: BookingDTO) {
    if (!window.confirm('Cancel this booking?')) return;
    setBusyId(b.id);
    try {
      const t = await getActiveTokenWaited();
      if (!t) throw new Error('signed_out');
      await cancelBooking(b.id, t);
      capture('consult_cancelled', { status: b.status });
      await load();
    } catch (e) {
      captureException(e, { where: 'consult_mine_cancel' });
      setErr(consultMessage(e, 'We couldn’t cancel that booking. Please try again.'));
    } finally { setBusyId(null); }
  }

  const upcoming = (rows ?? []).filter((b) => UPCOMING.includes(b.status)).sort((a, b) => a.slot_start_ms - b.slot_start_ms);
  const past = (rows ?? []).filter((b) => !UPCOMING.includes(b.status)).sort((a, b) => b.slot_start_ms - a.slot_start_ms);

  const card = (b: BookingDTO) => {
    const st = STATUS[b.status];
    const canJoin = (b.status === 'confirmed' || b.status === 'in_call') && now >= b.join_opens_ms && now < b.slot_end_ms + 5 * 60_000;
    const waiting = b.status === 'confirmed' && now < b.join_opens_ms;
    return (
      <div className="card cb-row" key={b.id}>
        <img className="sticker" src={b.consultant.photo_url} alt="" />
        <div className="who">
          <strong>{b.consultant.name}</strong>
          <span className="muted" style={{ fontSize: 15 }}>{DISCIPLINE_LABEL[b.discipline].en} · {fmtSlotDay(b.slot_start_ms)}, {fmtSlotTime(b.slot_start_ms)} · {inr(b.price.total)}</span>
          <span style={{ marginTop: 6 }}><span className={`chip ${st.cls}`}>{st.text}</span></span>
        </div>
        <div className="acts">
          {canJoin && <a className="btn small red" href={`/guides/session/${encodeURIComponent(b.id)}`} onClick={() => capture('consult_join_click', { from: 'mine' })}>Join call</a>}
          {waiting && <span className="hint">Join opens {fmtSlotTime(b.join_opens_ms)}</span>}
          {(b.status === 'held' || b.status === 'awaiting_review') && <button type="button" className="btn small ghost" disabled={busyId === b.id} onClick={() => void cancel(b)}>{busyId === b.id ? 'Please wait…' : 'Cancel'}</button>}
        </div>
      </div>
    );
  };

  return (
    <div className="consult-ui cb-list">
      {err && <p className="cb-err" role="alert">{err}</p>}
      {!rows && !err && <p className="hint" role="status">Loading your consultations…</p>}
      {rows && rows.length === 0 && (
        <div className="card cb-state"><h3>No consultations yet</h3><p className="muted" style={{ margin: '8px 0 14px' }}>Book a call with an astrologer, numerologist, palmist, face reader or tarot reader.</p><a className="btn" href="/guides">Find a consultant</a></div>
      )}
      {upcoming.length > 0 && <><h3>Upcoming</h3>{upcoming.map(card)}</>}
      {past.length > 0 && <><h3 style={{ marginTop: 8 }}>Past</h3>{past.map(card)}</>}
    </div>
  );
}
