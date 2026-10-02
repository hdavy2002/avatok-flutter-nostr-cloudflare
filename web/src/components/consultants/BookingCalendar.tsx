// [AUMFE-CONSULT-F1-1 2026-10-02] Month calendar + slot grid. Free/full days come from the slots API (W1), per month.
// Selection (day + slot) is reported up so the Book link carries it: /guides/<slug>/book?d=<discipline>&slot=<start_ms>.
// Failures are never silent: a failed month shows a retry line and goes to PostHog (captureException).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SlotDay } from '../../lib/consultTypes';
import { captureException } from '../../lib/analytics';
import { fetchSlots } from './api';
import { MONTH_DEVA } from './categoryContent';
import { addMonths, dateStr, dayLabel, daysInMonth, istToday, leadingBlanks, monthTitle, rupees, ymKey, ymOf, type YM } from './format';

export interface SlotChoice { date: string; start_ms: number; label: string }
interface Props {
  slug: string;
  total: number;
  bookLabel: string;
  bookHref: (slot: SlotChoice | null) => string;
  onChange: (slot: SlotChoice | null) => void;
  onPick: (slot: SlotChoice) => void;
  onBook: (slot: SlotChoice | null) => void;
}

const MAX_AHEAD = 3; // months beyond the current one

export default function BookingCalendar({ slug, total, bookLabel, bookHref, onChange, onPick, onBook }: Props) {
  const today = istToday();
  const nowYm = ymOf(today);
  const [view, setView] = useState<YM>(nowYm);
  const [months, setMonths] = useState<Record<string, SlotDay[]>>({});
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  const [sel, setSel] = useState<SlotChoice | null>(null);
  const [selDate, setSelDate] = useState<string | null>(null);
  const started = useRef(false);

  const load = useCallback(async (ym: YM): Promise<SlotDay[] | null> => {
    const key = ymKey(ym);
    const from = ymKey(ym) === ymKey(nowYm) ? today : dateStr(ym, 1);
    const days = daysInMonth(ym) - (Number(from.slice(8, 10)) - 1);
    try {
      const d = await fetchSlots(slug, from, days);
      setMonths((m) => ({ ...m, [key]: d }));
      return d;
    } catch (e) {
      captureException(e, { where: 'consult_slots', slug, month: key });
      return null;
    }
  }, [slug, today, nowYm.y, nowYm.m]);

  // First load: find the first month (up to MAX_AHEAD) that has a free slot and auto-select its earliest slot.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let alive = true;
    (async () => {
      let ym = nowYm;
      let anyFailed = false;
      for (let i = 0; i <= MAX_AHEAD; i++) {
        const d = await load(ym);
        if (!alive) return;
        if (d === null) { anyFailed = true; break; }
        const first = d.find((x) => x.slots.length > 0);
        if (first) {
          const s = first.slots[0];
          const choice = { date: first.date, start_ms: s.start_ms, label: s.label };
          setView(ym); setSelDate(first.date); setSel(choice); onChange(choice);
          break;
        }
        ym = addMonths(ym, 1);
      }
      if (alive) { setFailed(anyFailed); setBusy(false); }
    })();
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const go = async (delta: number) => {
    const next = addMonths(view, delta);
    setView(next);
    if (!months[ymKey(next)]) {
      setBusy(true);
      const d = await load(next);
      setFailed(d === null);
      setBusy(false);
    }
  };
  const retry = async () => { setBusy(true); const d = await load(view); setFailed(d === null); setBusy(false); };

  const monthDays = months[ymKey(view)] ?? [];
  const byDate = new Map(monthDays.map((d) => [d.date, d.slots]));
  const blanks = leadingBlanks(view);
  const count = daysInMonth(view);
  const slotsForSel = selDate ? (byDate.get(selDate) ?? []) : [];
  const atStart = ymKey(view) === ymKey(nowYm);
  const atEnd = ymKey(view) === ymKey(addMonths(nowYm, MAX_AHEAD));

  const pickDay = (date: string) => {
    setSelDate(date);
    const s = byDate.get(date)?.[0];
    if (s) { const c = { date, start_ms: s.start_ms, label: s.label }; setSel(c); onChange(c); onPick(c); }
  };
  const pickSlot = (date: string, s: { start_ms: number; label: string }) => {
    const c = { date, start_ms: s.start_ms, label: s.label };
    setSel(c); onChange(c); onPick(c);
  };

  return (
    <aside className="card frame cp-cal" aria-label="Choose a time">
      <div className="cp-cal-head">
        <div className="cp-cal-title"><span className="deva">{MONTH_DEVA[view.m - 1]}</span><h3>{monthTitle(view)}</h3></div>
        <div className="cp-cal-nav">
          <button type="button" className="btn small ghost" aria-label="Previous month" disabled={atStart} onClick={() => void go(-1)}>‹</button>
          <button type="button" className="btn small ghost" aria-label="Next month" disabled={atEnd} onClick={() => void go(1)}>›</button>
        </div>
      </div>
      <div className="cal" aria-busy={busy}>
        {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((h) => <span key={h} className="h">{h}</span>)}
        {Array.from({ length: blanks }, (_, i) => <span key={`b${i}`} />)}
        {Array.from({ length: count }, (_, i) => {
          const date = dateStr(view, i + 1);
          const free = (byDate.get(date)?.length ?? 0) > 0;
          const cls = date === selDate ? 'sel' : free ? 'free' : 'full';
          return free
            ? <button key={date} type="button" className={`d ${cls}`} aria-pressed={date === selDate} aria-label={dayLabel(date)} onClick={() => pickDay(date)}>{i + 1}</button>
            : <span key={date} className={`d ${cls}`} aria-hidden="true">{i + 1}</span>;
        })}
      </div>
      {failed ? <p className="cp-cal-note" role="alert">We could not load the calendar. <button type="button" className="edit" onClick={() => void retry()}>Try again</button></p> : null}
      {!failed && !busy && monthDays.every((d) => d.slots.length === 0) ? <p className="cp-cal-note">No free times this month. Try the next month.</p> : null}
      {selDate && slotsForSel.length ? (
        <>
          <span className="label">{dayLabel(selDate)} · IST</span>
          <div className="cp-slots">
            {slotsForSel.map((s) => <button key={s.start_ms} type="button" className={`slot${sel?.start_ms === s.start_ms ? ' on' : ''}`} aria-pressed={sel?.start_ms === s.start_ms} onClick={() => pickSlot(selDate, s)}>{s.label}</button>)}
          </div>
        </>
      ) : null}
      <a className="btn cat" href={bookHref(sel)} onClick={() => onBook(sel)}>{sel ? `Book ${sel.label} · ${rupees(total)}` : bookLabel}</a>
    </aside>
  );
}
