/* [CAL-AUDIT-2026-09-15] The creator calendar island.
 *
 * Rewritten (same markup language, same class names, same API calls) from the
 * 131-line minified original so the audit's fixes are legible in a diff. What
 * changed, and why — every line traces to
 * Specs/AUDIT-2026-09-15-CALENDAR-CREATOR-EXPERIENCE.md web findings 2–12:
 *
 *   #2  full-day round-trip — ALL DAY is stored as 00:00..1440 and read back as
 *       "All day"; minute 1440 never becomes "00:00"→0 again (calendarCore).
 *   #3  one day holds SEVERAL intervals: every saved exception is listed with
 *       its own Edit and Remove, "Add another time" never replaces the first
 *       one, and "Use usual hours" clears the day explicitly.
 *   #2  holiday range: "From … through …" bounded by the schedule's OWN
 *       horizon (max 62) and the 100-exception limit, with every cut reported.
 *   #4  partial source failure: if busy time, events, listings or Google status
 *       fail to load the diary is marked INCOMPLETE (last known values stay
 *       visible) instead of quietly looking free.
 *   #5/#6 Google readiness comes from the OLDEST SELECTED calendar, per-source
 *       status is visible, "Refresh calendar list" and "Sync busy times now"
 *       are separate actions, and an unverifiable status is never "Ready".
 *   #7  one card per booking: a booking's own busy block is folded into its
 *       appointment card instead of being counted twice.
 *   #9  the edit scope is visible on EVERY tab and personal busy time defaults
 *       to creator-wide, independent of the listing filter.
 *   #10 the policy summary says, in plain English, what is inherited vs
 *       overridden, that the notice is the LONGER of calendar and listing, and
 *       that the buffer keeps time free on BOTH sides.
 *   #12 the diary refreshes on window focus and shows "Updated at …" plus an
 *       explicit Refresh action.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getActiveTokenWaited as getActiveToken } from '../../lib/clerk';
import { request, ApiError } from '../../lib/apiClient';
import type { Card as ListingCard } from '../../lib/types';
import { Spinner } from '../../components/Spinner';
import {
  addCalendarDays, disconnectGoogleCalendar, epochForDateTime, formatDateKey, getCalendarBlocks,
  getCalendarEvents, getCreatorSchedule, getGoogleCalendarConnectUrl, getGoogleCalendarStatus,
  getGoogleCalendars, getListingAvailability, parseDateKey, previewCalendarConflicts,
  saveCreatorSchedule, saveGoogleCalendarSelection, startOfCalendarWeek, syncGoogleCalendarNow,
  timeToMinutes,
} from '../../lib/availability';
import type {
  AvailabilityException, AvailabilityRule, CalendarBlock, CalendarEvent, CreatorSchedule,
  ExceptionStatus, GoogleCalendar, GoogleCalendarStatus,
} from '../../lib/availability';
import {
  MAX_EXCEPTIONS, addDays, clampHorizonDays, clockToMinutes, dayItemsForRange,
  deriveGoogleReadiness, exceptionBudget, intervalsForDate, intervalLabel, isAllDayInterval,
  isValidDateKey, minutesAgo, minutesToClock, planDateRange, planIntervalUpsert,
  policySummaryLines, scopeLabel, weeklyRepeatDates,
} from '../../lib/calendarCore';
import type { DayItem, GoogleReadiness, IntervalTarget } from '../../lib/calendarCore';

type Tab = 'calendar' | 'hours' | 'connected';
type CalendarView = 'month' | 'week' | 'agenda';
type LoadState = 'loading' | 'ready' | 'error';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TIMEZONES = ['Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'UTC'];
const CONTROL = 'calendar-control rounded-zineField border border-ink/30 bg-card px-3 py-2.5 font-body text-[14px] font-extrabold text-ink outline-none focus-visible:ring-2 focus-visible:ring-blueInk';
const ACTION = 'calendar-action inline-flex min-h-11 items-center justify-center rounded-full border border-ink/50 px-4 py-2 font-mono text-[12px] font-bold uppercase tracking-[0.06em] text-ink transition hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-blueInk disabled:cursor-wait disabled:opacity-50';
/** How long a loaded diary stays "fresh" before a focus event refreshes it. */
const FOCUS_REFRESH_AFTER_MS = 60_000;

function dateLabel(key: string, options: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' }) {
  return parseDateKey(key).toLocaleDateString(undefined, options);
}
function monthLabel(date: Date) { return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }); }
function errorText(error: unknown) {
  const e = error as { message?: string; body?: { error?: string; reason?: string; message?: string } };
  return e?.body?.reason || e?.body?.message || e?.body?.error || e?.message || 'Something went wrong. Try again.';
}
function epochRangeLabel(start: number, end: number, timezone: string, withDate = false) {
  const options: Intl.DateTimeFormatOptions = { ...(withDate ? { month: 'short', day: 'numeric' } : {}), hour: 'numeric', minute: '2-digit', timeZone: timezone };
  return `${new Date(start).toLocaleString(undefined, options)}–${new Date(end).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: timezone })}`;
}
/** Wall-clock date + time of an epoch in an IANA zone, as plain strings. Built
 *  from formatToParts so a locale's separator cannot break the split. */
function zonedDateAndTime(epoch: number, timezone: string): { date: string; time: string } {
  const parts: Record<string, string> = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(epoch))
    .forEach((part) => { if (part.type !== 'literal') parts[part.type] = part.value; });
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
function updatedLabel(ms: number | null) {
  if (!ms) return 'Not updated yet';
  return `Updated ${new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}
function statusWordForException(status: ExceptionStatus) {
  return status === 'reserved' ? 'Reserved' : status === 'available' ? 'Available' : 'Unavailable';
}
function exceptionKind(status: ExceptionStatus) {
  return status === 'reserved' ? 'Keep this time for a listing' : status === 'available' ? "I'm available" : "I'm busy";
}
async function withCalendarAuth<T>(run: (auth: string) => Promise<T>): Promise<T> {
  const first = await getActiveToken();
  if (!first) throw new ApiError(401, 'Your session ended. Sign in again to manage your calendar.');
  try {
    return await run(first);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    const fresh = await getActiveToken(5000, { skipCache: true });
    if (!fresh || fresh === first) throw new ApiError(401, 'Your session ended. Sign in again to manage your calendar.');
    return run(fresh);
  }
}
function StatusBadge({ status }: { status: string }) {
  const tone = status === 'Available' || status === 'Ready' ? 'calendar-badge-available'
    : status === 'Reserved' || status === 'Syncing' ? 'calendar-badge-reserved'
      : status === 'Booked' ? 'calendar-badge-booked'
        : 'calendar-badge-unavailable';
  return <span className={`calendar-badge ${tone}`}>{status}</span>;
}

/* ── month / week / agenda ─────────────────────────────────────────────────
 * Every view reads the SAME day items (one card per booking, #7) and lists
 * EVERY interval on the day instead of only the first exception (#3). Slot
 * counts are only shown when a listing was actually checked: "unknown" is never
 * rendered as "0 open". */
function monthCell(schedule: CreatorSchedule, day: Date, items: DayItem[], intervals: AvailabilityException[], bookable: number | undefined) {
  const hasRule = schedule.rules.some((rule) => rule.weekday === day.getDay());
  const reserved = intervals.some((item) => item.status === 'reserved');
  const status = reserved ? 'Reserved'
    : bookable !== undefined ? (bookable > 0 ? 'Available' : 'No open slots')
      : intervals.length ? 'Unavailable'
        : hasRule ? 'Hours set' : 'Closed';
  const meta = bookable !== undefined
    ? (bookable > 0 ? `${bookable} open` : 'No open slots')
    : items.length ? `${items.length} booked/busy`
      : intervals.length ? `${intervals.length} exception${intervals.length === 1 ? '' : 's'}`
        : hasRule ? 'hours set' : '';
  return { status, meta };
}

function CalendarGrid({ cursor, selectedDate, onSelect, schedule, itemsByDay, availability, availabilityChecked }: {
  cursor: Date; selectedDate: string; onSelect: (date: string) => void; schedule: CreatorSchedule;
  itemsByDay: Map<string, DayItem[]>; availability: Map<string, number>; availabilityChecked: boolean;
}) {
  const first = startOfCalendarWeek(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
  return (
    <div className="calendar-month-grid" role="grid" aria-label={`${monthLabel(cursor)} calendar`}>
      {DAYS.map((day) => <div role="columnheader" className="calendar-weekday" key={day}>{day}</div>)}
      {Array.from({ length: 42 }, (_, index) => {
        const day = addCalendarDays(first, index);
        const key = formatDateKey(day);
        const items = itemsByDay.get(key) ?? [];
        const intervals = intervalsForDate(schedule, key);
        const bookable = availabilityChecked ? availability.get(key) : undefined;
        const inMonth = day.getMonth() === cursor.getMonth();
        const { status, meta } = monthCell(schedule, day, items, intervals, bookable);
        return (
          <button
            type="button" role="gridcell" key={key} aria-selected={selectedDate === key}
            aria-label={`${dateLabel(key)}: ${status}${meta ? `, ${meta}` : ''}`}
            className={`calendar-day ${inMonth ? '' : 'calendar-day-outside'} ${selectedDate === key ? 'calendar-day-selected' : ''}`}
            onClick={() => onSelect(key)}
          >
            <span className="calendar-day-number">{day.getDate()}</span>
            <span className="calendar-day-status"><StatusBadge status={status} /></span>
            <span className="calendar-day-meta">{meta}</span>
          </button>
        );
      })}
    </div>
  );
}

function WeekGrid({ selectedDate, onSelect, schedule, itemsByDay }: {
  selectedDate: string; onSelect: (date: string) => void; schedule: CreatorSchedule; itemsByDay: Map<string, DayItem[]>;
}) {
  const first = startOfCalendarWeek(parseDateKey(selectedDate));
  return (
    <div className="calendar-week-grid" role="grid" aria-label={`Week of ${dateLabel(formatDateKey(first))}`}>
      {Array.from({ length: 7 }, (_, index) => {
        const day = addCalendarDays(first, index);
        const key = formatDateKey(day);
        const items = itemsByDay.get(key) ?? [];
        const intervals = intervalsForDate(schedule, key);
        return (
          <button type="button" role="gridcell" key={key} onClick={() => onSelect(key)}
            className={`calendar-week-day ${key === selectedDate ? 'calendar-day-selected' : ''}`}
            aria-label={`${dateLabel(key)} with ${items.length} commitments and ${intervals.length} exceptions`}>
            <span className="calendar-week-head"><b>{DAYS[day.getDay()]}</b><strong>{day.getDate()}</strong></span>
            {intervals.map((item) => (
              <span className={`calendar-week-exception ${item.status}`} key={item.id}>
                {item.status === 'reserved' ? 'Reserved' : item.status === 'available' ? 'Open' : 'Blocked'} · {intervalLabel(item.start_min, item.end_min)}
              </span>
            ))}
            {!items.length && !intervals.length && <span className="calendar-week-empty">No commitments</span>}
            {items.map((row) => (
              <span className={`calendar-event ${row.tone}`} key={row.key}>
                <b>{row.title}</b><small>{epochRangeLabel(row.start, row.end, schedule.timezone)}</small>
              </span>
            ))}
          </button>
        );
      })}
    </div>
  );
}

function Agenda({ selectedDate, onSelect, schedule, itemsByDay, listings, days = 14 }: {
  selectedDate: string; onSelect: (date: string) => void; schedule: CreatorSchedule; itemsByDay: Map<string, DayItem[]>;
  listings: ListingCard[]; days?: number;
}) {
  return (
    <div className="calendar-agenda" aria-label="Upcoming calendar agenda">
      {Array.from({ length: days }, (_, index) => addCalendarDays(parseDateKey(selectedDate), index)).map((day) => {
        const key = formatDateKey(day);
        const items = itemsByDay.get(key) ?? [];
        const intervals = intervalsForDate(schedule, key);
        return (
          <button type="button" className={`calendar-agenda-day ${key === selectedDate ? 'calendar-day-selected' : ''}`} key={key} onClick={() => onSelect(key)}>
            <span className="calendar-agenda-date">
              <b>{day.toLocaleDateString(undefined, { weekday: 'short' })}</b>
              <strong>{day.getDate()}</strong>
              <small>{day.toLocaleDateString(undefined, { month: 'short' })}</small>
            </span>
            <span className="calendar-agenda-items">
              {intervals.map((item) => (
                <span className={`calendar-event calendar-event-exception ${item.status}`} key={item.id}>
                  <b>{exceptionKind(item.status)}</b>
                  <small>{intervalLabel(item.start_min, item.end_min)}{item.listing_id ? ` · ${scopeLabel(item, listings)}` : ''}</small>
                </span>
              ))}
              {items.map((row) => (
                <span className={`calendar-event ${row.tone}`} key={row.key}>
                  <b>{row.title}</b>
                  <small>{epochRangeLabel(row.start, row.end, schedule.timezone)} · {row.status}</small>
                </span>
              ))}
              {!intervals.length && !items.length && <span className="calendar-agenda-empty">No commitments or exceptions</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ── the selected day ─────────────────────────────────────────────────────
 * The old editor picked `exceptions.find(date)` — the FIRST exception — and
 * saved by replacing it, so a second break on the same day could overwrite the
 * first (#3). This editor lists every interval, edits/removes exactly one at a
 * time, supports ALL DAY (0..1440, #2), a bounded date range (#2/#3) and an
 * explicit scope that defaults personal busy time to creator-wide (#9). */
type Composer = { mode: 'closed' } | { mode: 'add' } | { mode: 'edit'; exception: AvailabilityException };

interface DayEditorProps {
  date: string;
  schedule: CreatorSchedule;
  listings: ListingCard[];
  token: string;
  selectedListing: string;
  requestedStatus: ExceptionStatus | null;
  itemsByDay: Map<string, DayItem[]>;
  onSelectDate: (date: string) => void;
  onSaved: (schedule: CreatorSchedule) => void;
  onStatusConsumed: () => void;
}

function DayEditor({ date, schedule, listings, token, selectedListing, requestedStatus, itemsByDay, onSelectDate, onSaved, onStatusConsumed }: DayEditorProps) {
  const dayIntervals = intervalsForDate(schedule, date);
  const dayItems = itemsByDay.get(date) ?? [];
  const [composer, setComposer] = useState<Composer>({ mode: 'closed' });
  const [status, setStatus] = useState<ExceptionStatus>('unavailable');
  const [allDay, setAllDay] = useState(false);
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('17:00');
  const [scope, setScope] = useState<'creator' | 'listing'>('creator');
  const [listingId, setListingId] = useState('');
  const [repeat, setRepeat] = useState<'none' | 'weekly'>('none');
  const [rangeOpen, setRangeOpen] = useState(false);
  const [rangeFrom, setRangeFrom] = useState(date);
  const [rangeTo, setRangeTo] = useState(date);
  const [rangeMessages, setRangeMessages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<{ title: string; start_at: number; end_at: number }[]>([]);
  const [alternatives, setAlternatives] = useState<{ start_at: number; end_at: number }[]>([]);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [pendingClear, setPendingClear] = useState(false);

  const dayLabel = dateLabel(date);
  const listingTitle = listings.find((listing) => listing.id === selectedListing)?.title ?? '';

  useEffect(() => {
    const preset = requestedStatus;
    setComposer(preset ? { mode: 'add' } : { mode: 'closed' });
    setStatus(preset ?? 'unavailable');
    setAllDay(false);
    setStart('09:00');
    setEnd('17:00');
    setScope('creator');
    setListingId(selectedListing || '');
    setRepeat('none');
    setRangeOpen(false);
    setRangeFrom(date);
    setRangeTo(date);
    setRangeMessages([]);
    setError(null);
    setNotice(null);
    setConflicts([]);
    setAlternatives([]);
    setPendingRemove(null);
    setPendingClear(false);
    // The schedule version changes after every successful save; resetting here
    // keeps a stale id from being written back onto a newer schedule.
  }, [date, schedule.version, schedule.listing_id, selectedListing, requestedStatus]);

  function openAdd(preset: ExceptionStatus = 'unavailable') {
    setComposer({ mode: 'add' });
    setStatus(preset);
    setAllDay(false);
    setStart('09:00');
    setEnd('17:00');
    // [audit #9] A personal busy block is ALWAYS creator-wide by default, even
    // when the calendar is filtered to one listing; the scope select is the
    // explicit opt-in to a listing-only closure.
    setScope(preset === 'reserved' ? 'listing' : 'creator');
    setListingId(selectedListing || '');
    setRepeat('none');
    setError(null);
    setNotice(null);
    setConflicts([]);
    setAlternatives([]);
  }

  function openEdit(exception: AvailabilityException) {
    setComposer({ mode: 'edit', exception });
    setStatus(exception.status);
    const wholeDay = isAllDayInterval(exception.start_min, exception.end_min);
    setAllDay(wholeDay);
    setStart(wholeDay ? '00:00' : minutesToClock(exception.start_min));
    setEnd(wholeDay ? '17:00' : minutesToClock(exception.end_min));
    setScope('creator');
    setListingId(exception.listing_id ?? selectedListing ?? '');
    setRepeat('none');
    setError(null);
    setNotice(null);
    setConflicts([]);
    setAlternatives([]);
  }

  function exceptionRange(exception: AvailabilityException): { start: number; end: number } | null {
    try {
      const startAt = epochForDateTime(exception.date, minutesToClock(exception.start_min), schedule.timezone);
      const endAt = exception.end_min >= 1440
        ? epochForDateTime(addDays(exception.date, 1), '00:00', schedule.timezone)
        : epochForDateTime(exception.date, minutesToClock(exception.end_min), schedule.timezone);
      return { start: startAt, end: endAt };
    } catch { return null; }
  }

  function holdsCommitment(exception: AvailabilityException): boolean {
    const span = exceptionRange(exception);
    if (!span) return false;
    return dayItems.some((item) => item.start < span.end && item.end > span.start);
  }

  function intervalFromForm(): { template: IntervalTarget; dates: string[]; creatorWide: boolean } | { error: string } {
    const editing = composer.mode === 'edit' ? composer.exception : null;
    let startMin = 0;
    let endMin = 1440;
    if (!allDay) {
      const s = clockToMinutes(start);
      const e = clockToMinutes(end);
      if (s === null || e === null) return { error: 'Enter a valid start and end time.' };
      if (e <= s) return { error: 'End time must be after start time. Use All day to cover the whole day.' };
      startMin = s;
      endMin = e;
    }
    const reserved = status === 'reserved';
    if (reserved && !listingId) return { error: 'Choose the listing that owns this reserved time.' };
    const creatorWide = editing ? !schedule.listing_id : (!reserved && scope === 'creator');
    const dates = editing || repeat === 'none' ? [date] : weeklyRepeatDates(date, schedule.horizon_days, exceptionBudget(schedule, []));
    return {
      template: {
        id: editing?.id,
        date,
        start_min: startMin,
        end_min: endMin,
        status,
        ...(reserved ? { listing_id: listingId } : {}),
        ...(editing?.listing_id && !reserved ? { listing_id: editing.listing_id } : {}),
      },
      dates,
      creatorWide,
    };
  }

  async function resolveTargetSchedule(auth: string): Promise<{ target: CreatorSchedule; creatorWide: boolean; listingId: string | null } | null> {
    if (composer.mode === 'edit') return { target: schedule, creatorWide: !schedule.listing_id, listingId: schedule.listing_id };
    if (scope === 'creator' && status !== 'reserved') {
      if (!schedule.listing_id) return { target: schedule, creatorWide: true, listingId: null };
      try {
        const shared = await getCreatorSchedule(auth, null);
        return { target: shared.schedule, creatorWide: true, listingId: null };
      } catch (e) { setError(errorText(e)); return null; }
    }
    const targetListing = listingId || selectedListing;
    if (!targetListing) { setError('Choose the listing this time belongs to.'); return null; }
    if (schedule.listing_id === targetListing) return { target: schedule, creatorWide: false, listingId: targetListing };
    try {
      const own = await getCreatorSchedule(auth, targetListing);
      return { target: own.schedule, creatorWide: false, listingId: targetListing };
    } catch (e) { setError(errorText(e)); return null; }
  }

  function applyPlan(base: CreatorSchedule, dates: string[], template: IntervalTarget, creatorWide: boolean) {
    let exceptions = base.exceptions;
    const conflicts: string[] = [];
    let covered = 0;
    for (const targetDate of dates) {
      const plan = planIntervalUpsert(
        { ...base, exceptions },
        { ...template, date: targetDate, id: dates.length === 1 ? template.id : undefined },
        { newId: crypto.randomUUID(), creatorWide },
      );
      if (plan.conflicts.length) { conflicts.push(`${dates.length > 1 ? `${dateLabel(targetDate)}: ` : ''}${plan.conflicts[0]}`); continue; }
      exceptions = plan.next;
      covered += plan.removed.length;
    }
    return { exceptions, conflicts, covered };
  }

  function describeSaved(built: { dates: string[]; creatorWide: boolean }) {
    const scopeText = built.creatorWide ? 'across all your listings' : `for ${listingTitle || 'this listing'}`;
    const verb = status === 'reserved' ? 'Kept' : status === 'available' ? 'Opened' : 'Blocked';
    if (repeat !== 'none' && built.dates.length > 1) return `${verb} ${built.dates.length} weekly windows ${scopeText}, starting ${dateLabel(built.dates[0])}.`;
    if (built.dates.length > 1) return `${verb} ${built.dates.length} days ${scopeText}, starting ${dateLabel(built.dates[0])}.`;
    return `${verb} ${dayLabel} ${allDay ? 'all day' : `${start}–${end}`} ${scopeText}.`;
  }

  async function previewSingle(auth: string, template: IntervalTarget, creatorWide: boolean, targetListing: string | null) {
    const hard = template.status === 'reserved' || (creatorWide && template.status === 'unavailable');
    if (!hard) return null;
    try {
      const startAt = allDay ? epochForDateTime(date, '00:00', schedule.timezone) : epochForDateTime(date, minutesToClock(template.start_min), schedule.timezone);
      const endAt = allDay ? epochForDateTime(addDays(date, 1), '00:00', schedule.timezone) : epochForDateTime(date, minutesToClock(template.end_min), schedule.timezone);
      const preview = await previewCalendarConflicts(auth, { listing_id: targetListing, start_at: startAt, end_at: endAt, timezone: schedule.timezone });
      if (preview.ok && !preview.conflicts.length) return null;
      return {
        conflicts: preview.conflicts ?? [],
        alternatives: preview.alternatives ?? [],
        message: preview.conflicts?.length
          ? 'This time overlaps an existing commitment. Choose another time, or one of the suggestions below.'
          : 'This change could not be applied safely.',
      };
    } catch (e) {
      setError(errorText(e));
      return { conflicts: [], alternatives: [], message: null };
    }
  }

  async function save() {
    if (!token) { setError('Your session ended. Sign in again to change your calendar.'); return; }
    const built = intervalFromForm();
    if ('error' in built) { setError(built.error); return; }
    setBusy(true); setError(null); setNotice(null); setConflicts([]); setAlternatives([]);
    try {
      await withCalendarAuth(async (auth) => {
        const resolved = await resolveTargetSchedule(auth);
        if (!resolved) return;
        const preview = composer.mode === 'add' && built.dates.length === 1
          ? await previewSingle(auth, built.template, resolved.creatorWide, resolved.listingId)
          : null;
        if (preview) {
          setConflicts(preview.conflicts);
          setAlternatives(preview.alternatives);
          if (preview.message) setError(preview.message);
          return;
        }
        const plan = applyPlan(resolved.target, built.dates, built.template, resolved.creatorWide);
        if (plan.conflicts.length) { setError(plan.conflicts.join(' ')); return; }
        const response = await saveCreatorSchedule(auth, { ...resolved.target, exceptions: plan.exceptions });
        setNotice(`${describeSaved(built)}${plan.covered ? ` ${plan.covered} covered window${plan.covered === 1 ? '' : 's'} were replaced.` : ''}`);
        onSaved(response.schedule);
        onStatusConsumed();
        setComposer({ mode: 'closed' });
      });
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  async function saveRange() {
    if (!token) { setError('Your session ended. Sign in again to change your calendar.'); return; }
    if (!isValidDateKey(rangeFrom) || !isValidDateKey(rangeTo)) { setError('Choose a valid start and end date.'); return; }
    const template: IntervalTarget = { start_min: 0, end_min: 1440, status, date: rangeFrom };
    setBusy(true); setError(null); setNotice(null); setRangeMessages([]);
    try {
      await withCalendarAuth(async (auth) => {
        const resolved = await resolveTargetSchedule(auth);
        if (!resolved) return;
        const plan = planDateRange({
          from: rangeFrom, to: rangeTo,
          horizonDays: resolved.target.horizon_days,
          existingCount: resolved.target.exceptions.length,
          maxExceptions: MAX_EXCEPTIONS,
        });
        setRangeMessages(plan.messages);
        if (!plan.dates.length) { setError(plan.messages[0] ?? 'No dates to block.'); return; }
        const target: IntervalTarget = { ...template, listing_id: listingId || undefined };
        const applied = applyPlan(resolved.target, plan.dates, target, resolved.creatorWide);
        if (applied.conflicts.length) {
          setError(`Nothing was saved. ${applied.conflicts.slice(0, 2).join(' ')}`);
          return;
        }
        const response = await saveCreatorSchedule(auth, { ...resolved.target, exceptions: applied.exceptions });
        const affected = plan.dates.filter((key) => (itemsByDay.get(key) ?? []).some((item) => item.kind === 'booking'));
        const rangeVerb = status === 'reserved' ? 'Kept' : status === 'available' ? 'Opened' : 'Blocked';
        setNotice(`${rangeVerb} all day on ${plan.dates.length} date${plan.dates.length === 1 ? '' : 's'} ${resolved.creatorWide ? 'across all your listings' : `for ${listingTitle || 'this listing'}`}.${affected.length ? ` ${affected.length} date${affected.length === 1 ? '' : 's'} already hold a booking; those appointments are NOT cancelled — open them to reschedule or cancel.` : ''}`);
        onSaved(response.schedule);
        setRangeOpen(false);
      });
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  async function removeOne(exception: AvailabilityException) {
    if (!token) { setError('Your session ended. Sign in again to change your calendar.'); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      await withCalendarAuth(async (auth) => {
        const response = await saveCreatorSchedule(auth, { ...schedule, exceptions: schedule.exceptions.filter((item) => item.id !== exception.id) });
        setNotice(`Removed the ${intervalLabel(exception.start_min, exception.end_min)} ${exception.status} window on ${dayLabel}.`);
        onSaved(response.schedule);
        setPendingRemove(null);
      });
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  async function clearDay() {
    if (!token) { setError('Your session ended. Sign in again to change your calendar.'); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      await withCalendarAuth(async (auth) => {
        const removed = dayIntervals.length;
        const response = await saveCreatorSchedule(auth, { ...schedule, exceptions: schedule.exceptions.filter((item) => item.date !== date) });
        setNotice(`Removed ${removed} exception${removed === 1 ? '' : 's'} on ${dayLabel}. Your usual hours apply again.`);
        onSaved(response.schedule);
        setPendingClear(false);
      });
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  const rangePreview = useMemo(() => planDateRange({
    from: rangeFrom, to: rangeTo, horizonDays: schedule.horizon_days, existingCount: schedule.exceptions.length,
  }), [rangeFrom, rangeTo, schedule.horizon_days, schedule.exceptions.length]);
  const rangeAffected = rangePreview.dates.filter((key) => (itemsByDay.get(key) ?? []).some((item) => item.kind === 'booking'));
  const editing = composer.mode === 'edit' ? composer.exception : null;
  const chosenListingTitle = listings.find((listing) => listing.id === (listingId || selectedListing))?.title ?? null;
  const reservedOverlap = dayIntervals.filter((item) => item.status === 'reserved' && holdsCommitment(item)).length;

  return (
    <section className="calendar-card calendar-editor" aria-labelledby="day-editor-heading">
      <div className="calendar-card-heading">
        <div>
          <p className="calendar-eyebrow">Selected day · {schedule.timezone}</p>
          <h2 id="day-editor-heading">{dayLabel}</h2>
        </div>
        <StatusBadge status={dayIntervals.length ? `${dayIntervals.length} exception${dayIntervals.length === 1 ? '' : 's'}` : 'Usual hours'} />
      </div>
      <p className="calendar-muted">
        Every window on this day is listed below and can be changed on its own. Existing bookings stay protected until explicitly rescheduled or cancelled.
      </p>

      <div className="calendar-intervals">
        {!dayIntervals.length && <p className="calendar-muted">Your usual working hours apply on this day.</p>}
        {dayIntervals.map((exception) => (
          <div className="calendar-interval" key={exception.id}>
            <div>
              <span className="calendar-interval-head">
                <StatusBadge status={statusWordForException(exception.status)} />
                <b>{intervalLabel(exception.start_min, exception.end_min)}</b>
              </span>
              <small>
                {exception.status === 'reserved'
                  ? `Kept for ${scopeLabel(exception, listings)}`
                  : exception.listing_id ? scopeLabel(exception, listings) : 'All listings'}
                {holdsCommitment(exception) ? ' · overlaps an existing commitment' : ''}
              </small>
            </div>
            <div className="calendar-interval-actions">
              <button type="button" className={`${ACTION} calendar-secondary`} onClick={() => openEdit(exception)} disabled={busy}>Edit</button>
              {pendingRemove === exception.id ? (
                <>
                  <button type="button" className={`${ACTION} calendar-danger`} onClick={() => void removeOne(exception)} disabled={busy}>Confirm remove</button>
                  <button type="button" className={`${ACTION} calendar-secondary`} onClick={() => setPendingRemove(null)} disabled={busy}>Cancel</button>
                </>
              ) : (
                <button type="button" className="calendar-remove" onClick={() => {
                  if (exception.status === 'reserved' || holdsCommitment(exception)) setPendingRemove(exception.id);
                  else void removeOne(exception);
                }} disabled={busy}>Remove</button>
              )}
            </div>
          </div>
        ))}
      </div>

      {composer.mode === 'closed' && (
        <div className="calendar-interval-actions">
          <button type="button" className={`${ACTION} calendar-secondary`} onClick={() => openAdd('unavailable')} disabled={busy}>+ Add another time</button>
          {dayIntervals.length > 0 && (pendingClear ? (
            <>
              <button type="button" className={`${ACTION} calendar-danger`} onClick={() => void clearDay()} disabled={busy}>Confirm: use usual hours</button>
              <button type="button" className={`${ACTION} calendar-secondary`} onClick={() => setPendingClear(false)} disabled={busy}>Cancel</button>
            </>
          ) : (
            <button type="button" className={`${ACTION} calendar-secondary`} onClick={() => {
              if (reservedOverlap || dayItems.length) setPendingClear(true);
              else void clearDay();
            }} disabled={busy}>Use usual hours</button>
          ))}
        </div>
      )}

      {composer.mode !== 'closed' && (
        <div className="calendar-composer">
          <div className="calendar-editor-fields">
            <label>What is this time?
              <select className={CONTROL} value={status} onChange={(event) => {
                const next = event.target.value as ExceptionStatus;
                setStatus(next);
                if (next === 'reserved') setScope('listing');
              }}>
                <option value="unavailable">I'm busy</option>
                <option value="available">I'm available</option>
                <option value="reserved">Keep this time for a listing</option>
              </select>
            </label>
            <label>Applies to
              <select className={CONTROL} value={status === 'reserved' ? 'listing' : scope} disabled={!!editing || status === 'reserved'} onChange={(event) => setScope(event.target.value as 'creator' | 'listing')}>
                <option value="creator">All listings (creator-wide)</option>
                <option value="listing">Only {listingTitle || 'one listing'}</option>
              </select>
            </label>
            {(status === 'reserved' || scope === 'listing') && (
              <label>Listing
                <select className={CONTROL} value={listingId} onChange={(event) => setListingId(event.target.value)}>
                  <option value="">Choose a listing…</option>
                  {listings.map((listing) => <option key={listing.id} value={listing.id}>{listing.title}</option>)}
                </select>
              </label>
            )}
            <label className="calendar-check">
              <input type="checkbox" checked={allDay} onChange={(event) => {
                const next = event.target.checked;
                setAllDay(next);
                if (next) { setStart('00:00'); setEnd('17:00'); }
              }} />
              All day (00:00–24:00)
            </label>
            {!allDay && <label>Starts<input className={CONTROL} type="time" value={start} onChange={(event) => setStart(event.target.value)} /></label>}
            {!allDay && <label>Ends<input className={CONTROL} type="time" value={end} onChange={(event) => setEnd(event.target.value)} /></label>}
            {!editing && (
              <label>Repeat
                <select className={CONTROL} value={repeat} onChange={(event) => setRepeat(event.target.value as 'none' | 'weekly')}>
                  <option value="none">This date only</option>
                  <option value="weekly">Every week through the schedule horizon</option>
                </select>
              </label>
            )}
          </div>
          {editing && (
            <p className="calendar-muted">
              Editing the window that is already saved. Its scope stays {editing.listing_id ? `“${scopeLabel(editing, listings)}”` : '“all listings”'}; remove it and add a new window to change where it applies.
            </p>
          )}
          <p className="calendar-muted">
            {allDay ? 'All day' : `${start}–${end}`}
            {' · '}
            {status === 'reserved' ? `kept for ${chosenListingTitle ?? 'the chosen listing'}` : status === 'available' ? 'open for booking' : 'blocked'}
            {' · '}
            {status === 'reserved' || scope === 'listing'
              ? `saved on ${chosenListingTitle ?? 'the chosen listing'}'s own schedule`
              : 'saved on your creator-wide schedule'}
          </p>

          {conflicts.length > 0 && (
            <div className="calendar-conflict" role="alert">
              <b>Conflict found</b>
              {conflicts.map((item) => (
                <span key={`${item.title}-${item.start_at}`}>{item.title} · {epochRangeLabel(item.start_at, item.end_at, schedule.timezone, true)}</span>
              ))}
            </div>
          )}
          {alternatives.length > 0 && (
            <div className="calendar-alternatives">
              <b>Free times nearby</b>
              {alternatives.map((slot) => (
                <button type="button" key={slot.start_at} className="calendar-alternative" onClick={() => {
                  const { date: slotDate, time } = zonedDateAndTime(slot.start_at, schedule.timezone);
                  if (slotDate !== date) { onSelectDate(slotDate); return; }
                  setStart(time);
                  setEnd(zonedDateAndTime(slot.end_at, schedule.timezone).time);
                }}>
                  {epochRangeLabel(slot.start_at, slot.end_at, schedule.timezone, true)}
                </button>
              ))}
            </div>
          )}
          {error && <p className="calendar-form-message" role="alert">{error}</p>}
          {notice && <p className="calendar-form-message" role="status">{notice}</p>}

          <div className="calendar-interval-actions">
            <button type="button" className={`${ACTION} calendar-primary`} onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : editing ? 'Save this window' : 'Add this time'}
            </button>
            <button type="button" className={`${ACTION} calendar-secondary`} onClick={() => { setComposer({ mode: 'closed' }); setConflicts([]); setAlternatives([]); setError(null); onStatusConsumed(); }} disabled={busy}>Cancel</button>
            {!editing && <button type="button" className={`${ACTION} calendar-secondary`} onClick={() => setRangeOpen((open) => !open)} disabled={busy}>{rangeOpen ? 'Hide date range' : 'Block several days'}</button>}
          </div>

          {!editing && rangeOpen && (
            <div className="calendar-range">
              <p className="calendar-eyebrow">From this date through this date</p>
              <p className="calendar-muted">
                Adds one all-day {status === 'reserved' ? 'kept' : status === 'available' ? 'open' : 'blocked'} window per day, using the listing chosen above. Ranges stop at your {clampHorizonDays(schedule.horizon_days)}-day booking horizon and the {MAX_EXCEPTIONS}-exception limit for one schedule; anything left out is reported before saving.
              </p>
              <div className="calendar-editor-fields">
                <label>From<input className={CONTROL} type="date" value={rangeFrom} onChange={(event) => setRangeFrom(event.target.value)} /></label>
                <label>Through<input className={CONTROL} type="date" value={rangeTo} onChange={(event) => setRangeTo(event.target.value)} /></label>
              </div>
              <p className="calendar-muted">
                {rangePreview.dates.length} day{rangePreview.dates.length === 1 ? '' : 's'} will be added
                {rangeAffected.length ? ` · ${rangeAffected.length} already hold a booking (they are not cancelled)` : ''}.
              </p>
              {rangePreview.messages.map((line) => <p className="calendar-form-message calendar-warning" key={line}>{line}</p>)}
              {rangeMessages.map((line) => <p className="calendar-form-message calendar-warning" key={line}>{line}</p>)}
              <button type="button" className={`${ACTION} calendar-primary`} onClick={() => void saveRange()} disabled={busy}>{busy ? 'Saving…' : 'Apply to these days'}</button>
            </div>
          )}
        </div>
      )}

      {composer.mode === 'closed' && error && <p className="calendar-form-message" role="alert">{error}</p>}
      {composer.mode === 'closed' && notice && <p className="calendar-form-message" role="status">{notice}</p>}
    </section>
  );
}

/* ── Working hours + policy (#9, #10) ───────────────────────────────────── */
const POLICY_FIELDS: [keyof CreatorSchedule, string, string | null, number, number][] = [
  ['duration_min', 'Session length (min)', null, 5, 480],
  ['slot_interval_min', 'New slot every (min)', 'How often a new start time is offered.', 5, 240],
  ['buffer_min', 'Gap before and after (min)', 'Kept free on BOTH sides of a session — not only after it.', 0, 240],
  ['min_notice_min', 'Minimum notice (min)', 'Longer listing notices win when they are higher.', 0, 43200],
  ['max_per_day', 'Max bookings per day', 'The server accepts 1–100.', 1, 100],
  ['horizon_days', 'Booking horizon (days)', 'How far ahead customers can book. Maximum 62 days.', 1, 62],
];

function WorkingHours({ schedule, token, listings, selectedListing, onSaved }: {
  schedule: CreatorSchedule; token: string; listings: ListingCard[]; selectedListing: string;
  onSaved: (schedule: CreatorSchedule) => void;
}) {
  const [draft, setDraft] = useState(schedule);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { setDraft(schedule); setMessage(null); }, [schedule]);
  const listingTitle = listings.find((listing) => listing.id === selectedListing)?.title ?? null;

  function updateRule(index: number, patch: Partial<AvailabilityRule>) {
    setDraft((value) => ({ ...value, rules: value.rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)) }));
    setMessage(null);
  }
  function updateField(key: keyof CreatorSchedule, raw: number, min: number, max: number) {
    const value = Number.isFinite(raw) ? Math.max(min, Math.min(max, Math.round(raw))) : draft[key] as number;
    setDraft((current) => ({ ...current, [key]: value }));
    setMessage(null);
  }
  async function save() {
    setSaving(true); setMessage(null);
    try {
      // [audit #10] The horizon the creator chose is PRESERVED, only clamped to
      // the server's 1..62 contract — the wizard used to force 62 here.
      const payload: CreatorSchedule = {
        ...draft,
        horizon_days: clampHorizonDays(draft.horizon_days),
        max_per_day: Math.max(1, Math.min(100, Math.round(draft.max_per_day) || 1)),
      };
      const response = await withCalendarAuth((auth) => saveCreatorSchedule(auth, payload));
      onSaved(response.schedule);
      setMessage(`Working hours saved for ${listingTitle ?? 'all listings'}.`);
    } catch (error) { setMessage(errorText(error)); } finally { setSaving(false); }
  }

  return (
    <div className="calendar-settings-grid">
      <section className="calendar-card">
        <div className="calendar-card-heading">
          <div>
            <p className="calendar-eyebrow">Weekly windows</p>
            <h2>Working hours</h2>
          </div>
          <button type="button" className={`${ACTION} calendar-secondary`} onClick={() => setDraft((value) => ({ ...value, rules: [...value.rules, { weekday: 1, start_min: 9 * 60, end_min: 17 * 60 }] }))}>+ Add hours</button>
        </div>
        <p className="calendar-muted">
          {draft.listing_id
            ? `These hours belong to ${listingTitle ?? 'this listing'} only.`
            : 'These are the creator windows every listing can inherit; a listing-specific schedule can narrow or replace them.'}
        </p>
        {!draft.rules.length && <div className="calendar-empty calendar-empty-small"><b>No working hours yet</b><span>Add a window before opening dates to customers.</span></div>}
        <div className="calendar-rule-list">
          {draft.rules.map((rule, index) => {
            const wholeDay = isAllDayInterval(rule.start_min, rule.end_min);
            return (
              <div className="calendar-rule" key={`${rule.weekday}-${index}`}>
                <label>Day
                  <select className={CONTROL} value={rule.weekday} onChange={(event) => updateRule(index, { weekday: Number(event.target.value) })}>
                    {DAYS.map((day, weekday) => <option value={weekday} key={day}>{day}</option>)}
                  </select>
                </label>
                {!wholeDay && (
                  <label>Starts<input className={CONTROL} type="time" value={minutesToClock(rule.start_min)} onChange={(event) => updateRule(index, { start_min: timeToMinutes(event.target.value) })} /></label>
                )}
                {!wholeDay && (
                  <label>Ends<input className={CONTROL} type="time" value={minutesToClock(rule.end_min)} onChange={(event) => updateRule(index, { end_min: timeToMinutes(event.target.value) })} /></label>
                )}
                <label className="calendar-check">
                  <input type="checkbox" checked={wholeDay} onChange={(event) => updateRule(index, event.target.checked ? { start_min: 0, end_min: 1440 } : { start_min: 9 * 60, end_min: 17 * 60 })} />
                  All day
                </label>
                <button type="button" className="calendar-remove" aria-label={`Remove ${DAYS[rule.weekday]} hours`} onClick={() => setDraft((value) => ({ ...value, rules: value.rules.filter((_, i) => i !== index) }))}>Remove</button>
              </div>
            );
          })}
        </div>
      </section>

      <section className="calendar-card">
        <p className="calendar-eyebrow">Booking policy</p>
        <h2>How slots behave</h2>
        <div className="calendar-policy-fields">
          <label>Creator timezone
            <select className={CONTROL} value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })}>
              {Array.from(new Set([draft.timezone, ...TIMEZONES])).map((timezone) => <option value={timezone} key={timezone}>{timezone}</option>)}
            </select>
          </label>
          <label>Schedule mode
            <select className={CONTROL} value={draft.mode} onChange={(event) => setDraft({ ...draft, mode: event.target.value as CreatorSchedule['mode'] })}>
              <option value="shared">Shared across listings</option>
              <option value="custom">Custom listing hours</option>
              <option value="exclusive">Exclusive windows</option>
            </select>
          </label>
          {POLICY_FIELDS.map(([key, label, hint, min, max]) => (
            <label key={key}>{label}
              <input className={CONTROL} type="number" min={min} max={max} value={draft[key] as number}
                onChange={(event) => updateField(key, Number(event.target.value), min, max)} />
              {hint && <small className="calendar-hint">{hint}</small>}
            </label>
          ))}
        </div>
        <p className="calendar-muted">Timezone changes regroup recurring rules by wall time. Confirm affected appointments before making a change.</p>
        <ul className="calendar-policy-summary">
          {policySummaryLines({ schedule: draft, listingTitle }).map((line) => <li key={line}>{line}</li>)}
        </ul>
        {message && <p className="calendar-form-message" role="status">{message}</p>}
        <button type="button" className={`${ACTION} calendar-primary`} onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : `Save working hours for ${listingTitle ?? 'all listings'}`}
        </button>
      </section>
    </div>
  );
}

/* ── Connected calendars (#5, #6) ───────────────────────────────────────── */
function ConnectedCalendars({ token, status, onStatus, onReload }: {
  token: string; status: GoogleCalendarStatus | null; onStatus: (value: GoogleCalendarStatus) => void; onReload: () => void;
}) {
  const [busy, setBusy] = useState<null | 'connect' | 'list' | 'sync' | 'save' | 'disconnect'>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [calendars, setCalendars] = useState<GoogleCalendar[]>(status?.calendars ?? []);
  const [destination, setDestination] = useState(status?.destination_calendar_id ?? '');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setCalendars(status?.calendars ?? []);
    setDestination(status?.destination_calendar_id ?? status?.calendars?.find((item) => item.destination)?.id ?? '');
  }, [status]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const readiness: GoogleReadiness = useMemo(() => deriveGoogleReadiness(status, now), [status, now]);

  async function connect() {
    setBusy('connect'); setError(null);
    try {
      const result = await withCalendarAuth((auth) => getGoogleCalendarConnectUrl(auth));
      window.location.assign(result.url);
    } catch (e) { setError(errorText(e)); setBusy(null); }
  }
  async function refreshCalendars() {
    setBusy('list'); setError(null); setNotice(null);
    try {
      const result = await withCalendarAuth((auth) => getGoogleCalendars(auth));
      setCalendars(result.calendars ?? []);
      setDestination(result.destination_calendar_id ?? '');
      onStatus({ ...(status ?? { connected: true }), connected: true, calendars: result.calendars, destination_calendar_id: result.destination_calendar_id ?? null });
      setNotice('Calendar list refreshed. This reads WHICH calendars exist — use “Sync busy times now” to import events.');
    } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }
  async function syncNow() {
    setBusy('sync'); setError(null); setNotice(null);
    try {
      const result = await withCalendarAuth((auth) => syncGoogleCalendarNow(auth));
      onStatus(result);
      onReload();
      setNotice('Busy times imported just now. The diary has been reloaded.');
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 501)) {
        setError('This server version does not offer “Sync busy times now”. Use Reconnect, or wait for the next automatic sync. Nothing here may be treated as freshly synced.');
      } else setError(errorText(e));
    } finally { setBusy(null); }
  }
  async function disconnect() {
    setBusy('disconnect'); setError(null); setNotice(null);
    try {
      await withCalendarAuth((auth) => disconnectGoogleCalendar(auth));
      onStatus({ connected: false, calendars: [] });
      onReload();
      setNotice('Google Calendar disconnected. Imported busy time is cleared and bookings require a reconnection.');
    } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }
  async function saveSelection() {
    const selected = calendars.filter((item) => item.selected).map((item) => item.id);
    const writable = calendars.filter((item) => item.selected && (!item.access_role || item.access_role === 'writer' || item.access_role === 'owner')).map((item) => item.id);
    if (!selected.length) { setError('Choose at least one calendar that should block your time.'); return; }
    if (!destination || !selected.includes(destination) || !writable.includes(destination)) { setError('Choose a selected writable calendar as the AvaTOK event destination.'); return; }
    setBusy('save'); setError(null); setNotice(null);
    try {
      const result = await withCalendarAuth((auth) => saveGoogleCalendarSelection(auth, { read_calendar_ids: selected, destination_calendar_id: destination }));
      setCalendars(result.calendars ?? []);
      setDestination(result.destination_calendar_id);
      onStatus({ ...(status ?? { connected: true }), connected: true, calendars: result.calendars, destination_calendar_id: result.destination_calendar_id });
      setNotice('Saved. Busy time now blocks slots from the selected calendars.');
      onReload();
    } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }
  function toggleCalendar(id: string) {
    setCalendars((items) => items.map((item) => (item.id === id ? { ...item, selected: !item.selected } : item)));
  }

  const lastSuccessText = readiness.lastSuccessAt
    ? `Oldest selected calendar synced ${minutesAgo(now - readiness.lastSuccessAt)} ago`
    : 'No selected calendar has completed a sync yet';

  return (
    <section className="calendar-card calendar-connected-card">
      <div className="calendar-card-heading">
        <div>
          <p className="calendar-eyebrow">External availability</p>
          <h2>Connected calendars</h2>
        </div>
        <StatusBadge status={readiness.label} />
      </div>
      <p className="calendar-muted">
        Selected Google calendars contribute busy time. Private titles and guest details never reach customers. AvaTOK bookings stay authoritative if Google is unavailable.
      </p>
      <p className="calendar-muted">
        Bookings are only accepted while this reads <b>Ready</b> — that is the same rule the booking engine applies before it takes a reservation. Not connected, Syncing and Needs attention all refuse new bookings.
      </p>
      <p className="calendar-muted" role="status">{readiness.detail}</p>

      {!status && <div className="calendar-state calendar-state-loading"><Spinner size={20} /> Checking connection…</div>}

      {status && !status.connected && (
        <div className="calendar-empty calendar-empty-small">
          <b>No calendar connected</b>
          <span>Connect Google Calendar when external meetings should block slots. Until then, Google busy time cannot be verified.</span>
          <button type="button" className={`${ACTION} calendar-primary`} onClick={() => void connect()} disabled={!!busy}>{busy === 'connect' ? 'Opening…' : 'Connect Google Calendar'}</button>
        </div>
      )}

      {status?.connected && (
        <>
          <div className="calendar-sync-panel">
            <div>
              <b>Busy-time synchronisation</b>
              <span>{lastSuccessText}. {readiness.selectedCount} calendar{readiness.selectedCount === 1 ? '' : 's'} block time.</span>
            </div>
            <div className="calendar-sync-actions">
              <button type="button" className={`${ACTION} calendar-primary`} onClick={() => void syncNow()} disabled={!!busy}>{busy === 'sync' ? 'Syncing…' : 'Sync busy times now'}</button>
              <button type="button" className={`${ACTION} calendar-secondary`} onClick={() => void refreshCalendars()} disabled={!!busy}>{busy === 'list' ? 'Refreshing…' : 'Refresh calendar list'}</button>
              <button type="button" className={`${ACTION} calendar-secondary`} onClick={() => void connect()} disabled={!!busy}>Reconnect</button>
              <button type="button" className={`${ACTION} calendar-danger`} onClick={() => void disconnect()} disabled={!!busy}>{busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}</button>
            </div>
          </div>

          {(readiness.state === 'attention' || readiness.state === 'syncing') && (
            <p className="calendar-form-message calendar-warning" role="status">
              {readiness.state === 'syncing'
                ? 'The first import has not finished. Until it does, new bookings are refused.'
                : `Fix this before relying on Google busy time: ${readiness.detail}`}
            </p>
          )}

          {calendars.length > 0 && (
            <div className="calendar-card" style={{ marginTop: '1rem' }}>
              <p className="calendar-eyebrow">Availability sources</p>
              <p className="calendar-muted">Choose which calendars block slots, then choose where AvaTOK bookings are written. CalendarList permission may require reconnecting an older connection.</p>
              {calendars.map((item) => {
                const source = readiness.sources.find((entry) => entry.id === item.id);
                return (
                  <div className="calendar-source" key={item.id}>
                    <label className="calendar-source-main">
                      <input type="checkbox" checked={item.selected} onChange={() => toggleCalendar(item.id)} />
                      <span>{item.summary}{item.primary ? ' · primary' : ''}</span>
                      {item.destination && <span className="calendar-badge calendar-badge-reserved">AvaTOK events</span>}
                    </label>
                    <span className="calendar-source-meta">
                      <StatusBadge status={source?.state === 'ready' ? 'Ready' : source?.state === 'attention' ? 'Needs attention' : source?.state === 'syncing' ? 'Syncing' : 'Not used'} />
                      <small>{item.timezone || 'timezone unknown'}{source?.detail ? ` · ${source.detail}` : ''}</small>
                    </span>
                  </div>
                );
              })}
              <label className="calendar-destination">AvaTOK event destination
                <select className={CONTROL} value={destination} onChange={(event) => setDestination(event.target.value)}>
                  {calendars.filter((item) => item.selected && (!item.access_role || item.access_role === 'writer' || item.access_role === 'owner')).map((item) => <option key={item.id} value={item.id}>{item.summary}</option>)}
                </select>
              </label>
              <button type="button" className={`${ACTION} calendar-primary`} onClick={() => void saveSelection()} disabled={!!busy}>{busy === 'save' ? 'Saving…' : 'Save calendar choices'}</button>
            </div>
          )}
        </>
      )}

      {notice && <p className="calendar-form-message" role="status">{notice}</p>}
      {error && <p className="calendar-form-message" role="alert">{error}</p>}
    </section>
  );
}

/* ── the island ─────────────────────────────────────────────────────────── */
function dayBounds(key: string, timezone: string): { from: number; to: number } {
  const fallback = Date.parse(`${key}T00:00:00Z`);
  let from = fallback;
  try { from = epochForDateTime(key, '00:00', timezone); } catch { from = fallback; }
  let to = from + 86_400_000;
  try { to = epochForDateTime(addDays(key, 1), '00:00', timezone); } catch { to = from + 86_400_000; }
  return { from, to };
}

function Inner() {
  const loadSequence = useRef(0);
  const tokenRef = useRef<string | null>(null);
  const listingRef = useRef('');
  const lastLoadedRef = useRef<number | null>(null);
  const lastMutationRef = useRef(0);

  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [degraded, setDegraded] = useState<string[]>([]);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>('calendar');
  const [view, setView] = useState<CalendarView>('month');
  const [cursor, setCursor] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState(() => formatDateKey(new Date()));
  const [selectedListing, setSelectedListing] = useState('');
  const [listings, setListings] = useState<ListingCard[]>([]);
  const [schedule, setSchedule] = useState<CreatorSchedule | null>(null);
  const [blocks, setBlocks] = useState<CalendarBlock[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [availability, setAvailability] = useState<Map<string, number>>(new Map());
  const [availabilityChecked, setAvailabilityChecked] = useState(false);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [googleStatus, setGoogleStatus] = useState<GoogleCalendarStatus | null>(null);
  const [requestedStatus, setRequestedStatus] = useState<ExceptionStatus | null>(null);

  useEffect(() => { void (async () => { setToken(await getActiveToken()); setChecked(true); })(); }, []);
  useEffect(() => { tokenRef.current = token; }, [token]);
  useEffect(() => { listingRef.current = selectedListing; }, [selectedListing]);
  useEffect(() => { lastLoadedRef.current = lastLoadedAt; }, [lastLoadedAt]);

  const range = useMemo(() => {
    const first = startOfCalendarWeek(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
    const last = addCalendarDays(first, 41);
    return { from: first, to: last, fromKey: formatDateKey(first), toKey: formatDateKey(last) };
  }, [cursor]);

  async function load(auth: string, listingId: string, silent = false) {
    // Refresh Clerk's session before a dashboard reload: an idle/backgrounded
    // tab can otherwise reuse an expired JWT.
    const refreshed = await getActiveToken(5000, { skipCache: true });
    if (refreshed) auth = refreshed;
    const sequence = ++loadSequence.current;
    if (!silent) setState('loading');
    setError(null);
    setAvailabilityError(null);
    const results = await Promise.allSettled([
      request<{ listings: ListingCard[] }>('/api/listings/mine', { auth }),
      getCreatorSchedule(auth, listingId || null),
      getCalendarBlocks(auth, addCalendarDays(range.from, -2).getTime(), addCalendarDays(range.to, 3).getTime()),
      getCalendarEvents(auth),
      getGoogleCalendarStatus(auth),
      ...(listingId ? [getListingAvailability(listingId, range.fromKey, range.toKey, schedule?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', auth)] : []),
    ]);
    if (sequence !== loadSequence.current) return;
    const [listingResult, scheduleResult, blocksResult, eventsResult, googleResult, availabilityResult] = results;
    const failures: string[] = [];
    if (listingResult.status === 'fulfilled') setListings((listingResult.value.listings ?? []).filter((listing) => listing.kind === 'consult' || listing.kind === 'live_event'));
    else failures.push(`your listings (${errorText(listingResult.reason)})`);
    if (scheduleResult.status === 'fulfilled') setSchedule(scheduleResult.value.schedule);
    else failures.push(`the schedule (${errorText(scheduleResult.reason)})`);
    if (blocksResult.status === 'fulfilled') setBlocks(blocksResult.value.blocks ?? []);
    else failures.push(`blocked/busy time (${errorText(blocksResult.reason)})`);
    if (eventsResult.status === 'fulfilled') setEvents(eventsResult.value.events ?? []);
    else failures.push(`appointments (${errorText(eventsResult.reason)})`);
    if (googleResult.status === 'fulfilled') setGoogleStatus(googleResult.value);
    else failures.push(`Google Calendar status (${errorText(googleResult.reason)})`);
    if (listingId && availabilityResult) {
      if (availabilityResult.status === 'fulfilled') {
        setAvailability(new Map(availabilityResult.value.days.map((day) => [day.date, day.available_count])));
        setAvailabilityChecked(true);
      } else {
        setAvailability(new Map());
        setAvailabilityChecked(false);
        setAvailabilityError(errorText(availabilityResult.reason));
      }
    } else {
      setAvailability(new Map());
      setAvailabilityChecked(false);
    }
    setDegraded(failures);
    setError(failures.length ? `Could not load ${failures[0]}.` : null);
    setState(scheduleResult.status === 'rejected' ? 'error' : 'ready');
    setLastLoadedAt(Date.now());
  }

  useEffect(() => {
    if (!checked) return;
    if (!token) { setState('error'); setError('Sign in to manage your calendar and availability.'); return; }
    void load(token, selectedListing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked, token, selectedListing, range.fromKey, range.toKey]);

  useEffect(() => { setRequestedStatus(null); }, [selectedDate]);

  // [audit #12] An open tab is not a live view. Refreshing on focus (and when a
  // backgrounded tab becomes visible again) keeps the diary from silently
  // showing yesterday's commitments.
  useEffect(() => {
    function maybeRefresh() {
      const auth = tokenRef.current;
      if (!auth || document.visibilityState === 'hidden') return;
      if (Date.now() - lastMutationRef.current < 5_000) return;
      if (Date.now() - (lastLoadedRef.current ?? 0) < FOCUS_REFRESH_AFTER_MS) return;
      void load(auth, listingRef.current, true);
    }
    window.addEventListener('focus', maybeRefresh);
    document.addEventListener('visibilitychange', maybeRefresh);
    return () => {
      window.removeEventListener('focus', maybeRefresh);
      document.removeEventListener('visibilitychange', maybeRefresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const calendarTimezone = schedule?.timezone || 'UTC';
  const itemsByDay = useMemo(() => {
    const map = new Map<string, DayItem[]>();
    const selected = parseDateKey(selectedDate);
    const start = range.from < selected ? range.from : selected;
    const monthEnd = range.to;
    const agendaEnd = addCalendarDays(selected, 13);
    const end = monthEnd > agendaEnd ? monthEnd : agendaEnd;
    const days = Math.min(120, Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1));
    for (let index = 0; index < days; index += 1) {
      const day = addCalendarDays(start, index);
      const key = formatDateKey(day);
      const { from, to } = dayBounds(key, calendarTimezone);
      map.set(key, dayItemsForRange(blocks, events, from, to));
    }
    return map;
  }, [blocks, events, range.fromKey, range.toKey, selectedDate, calendarTimezone]);

  const monthItemCount = useMemo(() => {
    let total = 0;
    for (let index = 0; index < 42; index += 1) total += (itemsByDay.get(formatDateKey(addCalendarDays(range.from, index))) ?? []).length;
    return total;
  }, [itemsByDay, range.fromKey]);

  function moveCursor(amount: number) { setCursor((value) => new Date(value.getFullYear(), value.getMonth() + amount, 1)); }
  function goToday() { const today = new Date(); setCursor(today); setSelectedDate(formatDateKey(today)); }
  function refresh() { if (token) void load(token, selectedListing, true); }
  function handleSaved(value: CreatorSchedule) {
    lastMutationRef.current = Date.now();
    if ((value.listing_id ?? null) === (schedule?.listing_id ?? null)) setSchedule(value);
    if (token) void load(token, selectedListing, true);
  }

  if (!checked || (state === 'loading' && !schedule)) return <div className="calendar-state calendar-state-loading"><Spinner size={24} /><span>Loading your calendar…</span></div>;
  if (!token) return <div className="calendar-state calendar-state-error" role="alert">Sign in to manage your calendar and availability.</div>;

  const listingTitle = listings.find((listing) => listing.id === selectedListing)?.title ?? null;

  return (
    <div className="calendar-shell">
      <style>{CSS}</style>

      {/* [audit #9] The edit scope is visible on every tab, not only inside the
       *  Calendar tab: a creator must never wonder which schedule a save hits. */}
      <div className="calendar-scope">
        <label className="calendar-scope-label" htmlFor="calendar-scope">Editing</label>
        <select id="calendar-scope" className={CONTROL} value={selectedListing} onChange={(event) => setSelectedListing(event.target.value)}>
          <option value="">All listings (creator-wide)</option>
          {listings.map((listing) => <option key={listing.id} value={listing.id}>{listing.title}</option>)}
        </select>
        <span className="calendar-muted">
          {listingTitle
            ? `Working hours, blocks and policy below belong to ${listingTitle}. Personal busy time still defaults to all listings.`
            : 'Working hours, blocks and policy below apply to every listing. Pick a listing to plan its own windows.'}
        </span>
      </div>

      <nav className="calendar-nav" aria-label="Calendar settings tabs">
        {([['calendar', 'Calendar'], ['hours', 'Working hours'], ['connected', 'Connected calendars']] as [Tab, string][]).map(([value, label]) => (
          <button type="button" className="calendar-tab" aria-selected={tab === value} key={value} onClick={() => setTab(value)}>{label}</button>
        ))}
      </nav>

      {state === 'error' && error && (
        <div className="calendar-form-message" role="alert">
          {error} <button type="button" className="underline" onClick={refresh}>Try again</button>
        </div>
      )}
      {/* [audit #4] Busy time or appointments failing is NOT a quiet day. */}
      {state !== 'error' && degraded.length > 0 && (
        <div className="calendar-degraded" role="status">
          <b>The diary may be incomplete.</b>
          <span>
            Could not load {degraded.join('; ')}. Showing the last known values — an apparently empty day is not proof you are free.
            {' '}<button type="button" className="underline" onClick={refresh}>Retry</button>
          </span>
        </div>
      )}

      {tab === 'hours' && schedule && (
        <WorkingHours schedule={schedule} token={token} listings={listings} selectedListing={selectedListing} onSaved={handleSaved} />
      )}
      {tab === 'connected' && (
        <ConnectedCalendars token={token} status={googleStatus} onStatus={setGoogleStatus} onReload={refresh} />
      )}

      {tab === 'calendar' && schedule && (
        <>
          <div className="calendar-toolbar">
            <label className="sr-only" htmlFor="calendar-timezone">Timezone</label>
            <select id="calendar-timezone" className={CONTROL} value={schedule.timezone} disabled>
              {Array.from(new Set([schedule.timezone, ...TIMEZONES])).map((timezone) => <option value={timezone} key={timezone}>{timezone}</option>)}
            </select>
            <span className="calendar-updated">{updatedLabel(lastLoadedAt)}</span>
            <span className="calendar-toolbar-spacer" />
            <button type="button" className={`${ACTION} calendar-secondary`} onClick={refresh}>Refresh</button>
            <button type="button" className={`${ACTION} calendar-secondary`} onClick={goToday}>Today</button>
            <div className="calendar-view-toggle" aria-label="Calendar view">
              <button type="button" className="calendar-view-button" aria-pressed={view === 'month'} onClick={() => setView('month')}>Month</button>
              <button type="button" className="calendar-view-button" aria-pressed={view === 'week'} onClick={() => setView('week')}>Week</button>
              <button type="button" className="calendar-view-button" aria-pressed={view === 'agenda'} onClick={() => setView('agenda')}>Agenda</button>
              <button type="button" className="calendar-view-button" onClick={() => setRequestedStatus('unavailable')}>Block time</button>
              <button type="button" className="calendar-view-button" onClick={() => setRequestedStatus('available')}>Open availability</button>
            </div>
          </div>

          {availabilityError && (
            <p className="calendar-form-message calendar-warning" role="status">
              Bookable slot counts are unavailable right now. The calendar still shows confirmed commitments; it will not infer open slots.
            </p>
          )}
          {!availabilityChecked && !selectedListing && listings.length > 0 && (
            <p className="calendar-muted">Select a listing above to see how many bookable slots each day has. Until then, no day is shown as “0 open”.</p>
          )}
          {!listings.length && (
            <div className="calendar-empty calendar-empty-small" style={{ marginBottom: '1rem' }}>
              <b>No listings yet</b>
              <span>Create and publish a listing before reserving exclusive time.</span>
              <a className={`${ACTION} calendar-primary`} href="/dashboard/listings/new">Create a listing</a>
            </div>
          )}

          <div className="calendar-main-grid">
            <section className="calendar-card calendar-month-panel">
              <div className="calendar-month-heading">
                <button type="button" className="calendar-arrow" aria-label="Previous month" onClick={() => moveCursor(-1)}>←</button>
                <h2>{view === 'agenda' ? 'Upcoming agenda' : monthLabel(cursor)}</h2>
                <button type="button" className="calendar-arrow" aria-label="Next month" onClick={() => moveCursor(1)}>→</button>
              </div>
              <details className="calendar-phone-month">
                <summary>Show month overview</summary>
                <CalendarGrid cursor={cursor} selectedDate={selectedDate} onSelect={setSelectedDate} schedule={schedule} itemsByDay={itemsByDay} availability={availability} availabilityChecked={availabilityChecked} />
              </details>
              {view === 'month' && <CalendarGrid cursor={cursor} selectedDate={selectedDate} onSelect={setSelectedDate} schedule={schedule} itemsByDay={itemsByDay} availability={availability} availabilityChecked={availabilityChecked} />}
              {view === 'week' && <WeekGrid selectedDate={selectedDate} onSelect={setSelectedDate} schedule={schedule} itemsByDay={itemsByDay} />}
              {view === 'month' && (
                <div className="calendar-phone-agenda">
                  <Agenda selectedDate={selectedDate} onSelect={setSelectedDate} schedule={schedule} itemsByDay={itemsByDay} listings={listings} />
                </div>
              )}
              {view === 'agenda' && <Agenda selectedDate={selectedDate} onSelect={setSelectedDate} schedule={schedule} itemsByDay={itemsByDay} listings={listings} />}
              {!monthItemCount && !schedule.rules.length && (
                <div className="calendar-empty calendar-empty-small" style={{ marginTop: '1rem' }}>
                  <b>Your calendar is quiet</b>
                  <span>Add working hours or open a date to start accepting bookings.</span>
                </div>
              )}
            </section>
            <DayEditor
              date={selectedDate}
              schedule={schedule}
              listings={listings}
              token={token}
              selectedListing={selectedListing}
              requestedStatus={requestedStatus}
              itemsByDay={itemsByDay}
              onSelectDate={setSelectedDate}
              onSaved={handleSaved}
              onStatusConsumed={() => setRequestedStatus(null)}
            />
          </div>
        </>
      )}
    </div>
  );
}

const CSS = `
.calendar-shell{--cal-border:rgba(25,25,25,.16);color:var(--zine-ink);font-family:Nunito,ui-sans-serif,sans-serif}.calendar-shell h2{font-size:1.18rem;line-height:1.2;font-weight:900;margin:0}.calendar-nav{display:flex;align-items:center;gap:.45rem;overflow:auto;border-bottom:1px solid var(--cal-border);margin-bottom:1rem}.calendar-tab{min-height:48px;border:0;border-bottom:3px solid transparent;background:transparent;padding:.55rem .75rem;color:#667085;font-weight:900;white-space:nowrap}.calendar-tab[aria-selected=true]{border-color:var(--zine-blueInk);color:var(--zine-ink)}.calendar-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem;margin-bottom:1rem}.calendar-toolbar-spacer{flex:1}.calendar-view-toggle{display:inline-flex;overflow:hidden;border:1px solid var(--cal-border);border-radius:999px}.calendar-view-button{min-height:44px;border:0;border-left:1px solid var(--cal-border);background:var(--zine-card);padding:0 .75rem;font-size:.75rem;font-weight:900}.calendar-view-button:first-child{border-left:0}.calendar-view-button[aria-pressed=true]{background:var(--zine-ink);color:var(--zine-paper)}.calendar-card{border:1px solid var(--cal-border);border-radius:16px;background:var(--zine-card);padding:1rem;box-shadow:0 3px 0 rgba(25,25,25,.06)}.calendar-card-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:.75rem;margin-bottom:.65rem}.calendar-eyebrow{margin:0 0 .22rem;color:#7c8495;font:800 .68rem/1.1 ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase}.calendar-muted{margin:.55rem 0 1rem;color:#667085;font-size:.86rem;font-weight:700;line-height:1.45}.calendar-main-grid{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(280px,.8fr);gap:1rem;align-items:start}.calendar-month-heading{display:flex;align-items:center;justify-content:space-between;gap:.5rem;margin-bottom:.8rem}.calendar-month-heading h2{font-size:1.45rem}.calendar-arrow{min-width:44px;min-height:44px;border:1px solid var(--cal-border);border-radius:999px;background:var(--zine-paper);font-size:1.1rem}.calendar-month-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));border-top:1px solid var(--cal-border);border-left:1px solid var(--cal-border)}.calendar-weekday{padding:.55rem .4rem;border-right:1px solid var(--cal-border);border-bottom:1px solid var(--cal-border);color:#7c8495;font:800 .68rem ui-monospace,monospace;text-align:center;text-transform:uppercase}.calendar-day{display:flex;min-height:88px;flex-direction:column;align-items:flex-start;gap:.3rem;border:0;border-right:1px solid var(--cal-border);border-bottom:1px solid var(--cal-border);background:var(--zine-card);padding:.55rem;text-align:left}.calendar-day:hover,.calendar-week-day:hover,.calendar-agenda-day:hover{background:var(--zine-paper2)}.calendar-day-outside{background:rgba(255,255,255,.35);color:#a2a8b4}.calendar-day-selected{background:#eef8fb!important;box-shadow:inset 0 0 0 2px var(--zine-blueInk)}.calendar-day-number{font-weight:900}.calendar-day-meta{font-size:.68rem;font-weight:800;color:#7c8495}.calendar-day-status{min-height:22px}.calendar-badge{display:inline-flex;align-items:center;min-height:22px;border-radius:999px;padding:.12rem .45rem;font:800 .64rem ui-monospace,monospace}.calendar-badge-available{background:#dbf6e9;color:#11623b}.calendar-badge-unavailable{background:#f6e1df;color:#984545}.calendar-badge-reserved{background:#e7e0fa;color:#553d96}.calendar-badge-booked{background:#dcecff;color:#275787}.calendar-week-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));border-top:1px solid var(--cal-border);border-left:1px solid var(--cal-border)}.calendar-week-day{display:flex;min-height:310px;flex-direction:column;align-items:stretch;gap:.45rem;border:0;border-right:1px solid var(--cal-border);border-bottom:1px solid var(--cal-border);background:var(--zine-card);padding:.55rem;text-align:left}.calendar-week-head{display:flex;align-items:center;justify-content:space-between;color:#667085;font-size:.75rem}.calendar-week-head strong{display:grid;width:30px;height:30px;place-items:center;border-radius:50%;background:var(--zine-paper2);color:var(--zine-ink)}.calendar-week-exception{padding:.3rem;border-radius:7px;font-size:.72rem;font-weight:900}.calendar-week-exception.available{background:#dbf6e9;color:#11623b}.calendar-week-exception.unavailable{background:#f6e1df;color:#984545}.calendar-week-exception.reserved{background:#e7e0fa;color:#553d96}.calendar-week-empty,.calendar-agenda-empty{color:#8992a2;font-size:.76rem;font-weight:800}.calendar-event{display:flex;flex-direction:column;gap:.12rem;border-left:3px solid;padding:.45rem .5rem;border-radius:7px;background:#f7f8fa;font-size:.75rem}.calendar-event b{font-size:.75rem;line-height:1.25}.calendar-event small{color:#667085;font-size:.68rem;font-weight:800}.calendar-event-block{border-color:#e26b67;background:#fff0ee}.calendar-event-google{border-color:#8b72d7;background:#f1edff}.calendar-event-booked{border-color:#2e8fd4;background:#eaf5fd}.calendar-event-exception{border-color:#d0aa39}.calendar-agenda{display:flex;flex-direction:column;gap:.55rem}.calendar-agenda-day{display:grid;grid-template-columns:96px minmax(0,1fr);gap:1rem;min-height:66px;border:1px solid var(--cal-border);border-radius:12px;background:var(--zine-card);padding:.75rem;text-align:left}.calendar-agenda-date{display:flex;align-items:baseline;gap:.35rem;color:#667085}.calendar-agenda-date b{font-size:.75rem}.calendar-agenda-date strong{font-size:1.25rem;color:var(--zine-ink)}.calendar-agenda-date small{font-size:.7rem}.calendar-agenda-items{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem}.calendar-settings-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1rem}.calendar-rule-list{display:flex;flex-direction:column;gap:.55rem}.calendar-rule{display:grid;grid-template-columns:1.1fr 1fr 1fr auto;align-items:end;gap:.5rem;border-top:1px solid var(--cal-border);padding-top:.65rem}.calendar-rule label,.calendar-policy-fields label,.calendar-editor-fields label{display:flex;flex-direction:column;gap:.3rem;color:#667085;font-size:.7rem;font-weight:900}.calendar-rule .calendar-remove{min-height:44px;border:0;background:transparent;color:#b44c4a;font-size:.7rem;font-weight:900}.calendar-policy-fields,.calendar-editor-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.7rem}.calendar-editor-wide{grid-column:1/-1}.calendar-primary{background:var(--zine-lime);border-color:var(--zine-ink);margin-top:.8rem}.calendar-secondary{background:var(--zine-paper)}.calendar-danger{background:#fff0ee;color:#984545}.calendar-empty{display:flex;min-height:240px;flex-direction:column;align-items:center;justify-content:center;gap:.55rem;border:1px dashed var(--cal-border);border-radius:12px;color:#667085;text-align:center}.calendar-empty b{color:var(--zine-ink)}.calendar-empty-small{min-height:140px}.calendar-empty-small .calendar-action{margin-top:.5rem}.calendar-state{display:flex;min-height:180px;align-items:center;justify-content:center;gap:.65rem;border:1px solid var(--cal-border);border-radius:16px;background:var(--zine-card);font-weight:900}.calendar-state-error{color:#984545}.calendar-form-message{margin:.7rem 0 0;color:#984545;font-size:.8rem;font-weight:800}.calendar-warning{color:#765b16}.calendar-conflict{display:flex;flex-direction:column;gap:.25rem;margin-top:.8rem;border-left:3px solid #e26b67;border-radius:7px;background:#fff0ee;padding:.65rem;color:#984545;font-size:.78rem;font-weight:800}.calendar-sync-panel{display:flex;align-items:center;justify-content:space-between;gap:1rem;border:1px solid var(--cal-border);border-radius:12px;background:var(--zine-paper2);padding:1rem}.calendar-sync-panel div:first-child{display:flex;flex-direction:column;gap:.3rem}.calendar-sync-panel span{color:#667085;font-size:.83rem;font-weight:700}.calendar-sync-actions{display:flex;flex-wrap:wrap;gap:.5rem}.calendar-phone-month,.calendar-phone-agenda{display:none}
@media (max-width:1023px){.calendar-main-grid{grid-template-columns:minmax(0,1fr) minmax(250px,.7fr)}.calendar-settings-grid{grid-template-columns:1fr}}
@media (max-width:599px){.calendar-phone-agenda{display:block}.calendar-view-toggle{flex-wrap:wrap;border-radius:12px}.calendar-toolbar{align-items:stretch}.calendar-toolbar-spacer{display:none}.calendar-toolbar .calendar-control{flex:1;min-width:140px}.calendar-main-grid{display:block}.calendar-month-panel>.calendar-month-grid{display:none}.calendar-phone-month{display:block;margin-bottom:.75rem}.calendar-phone-month summary{min-height:44px;cursor:pointer;list-style:none;border:1px solid var(--cal-border);border-radius:10px;background:var(--zine-paper2);padding:.7rem;font-weight:900}.calendar-phone-month summary::-webkit-details-marker{display:none}.calendar-agenda{margin-top:.8rem}.calendar-agenda-day{grid-template-columns:78px minmax(0,1fr);gap:.6rem;padding:.6rem}.calendar-agenda-date{flex-wrap:wrap;gap:.2rem}.calendar-agenda-date small{width:100%}.calendar-editor{margin-top:1rem}.calendar-editor-fields,.calendar-policy-fields{grid-template-columns:1fr}.calendar-editor-wide{grid-column:auto}.calendar-rule{grid-template-columns:1fr 1fr}.calendar-rule label:first-child{grid-column:1/-1}.calendar-rule .calendar-remove{justify-self:start}.calendar-sync-panel{align-items:stretch;flex-direction:column}.calendar-sync-actions .calendar-action{flex:1}.calendar-week-grid{display:block;border:0}.calendar-week-day{min-height:0;margin-bottom:.5rem;border:1px solid var(--cal-border);border-radius:12px}.calendar-month-heading h2{font-size:1.2rem}.calendar-view-toggle{width:100%}.calendar-view-button{flex:1}.calendar-day{min-height:86px}}

/* [CAL-AUDIT-2026-09-15] New surfaces for this pass: the always-visible edit
 * scope, the multi-interval day editor, honest source failures and per-calendar
 * Google status. Same tokens and card language as the rest of the diary. */
.calendar-scope{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin:.4rem 0 .9rem}
.calendar-scope-label{font-size:.7rem;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:#667085}
.calendar-scope .calendar-muted{flex:1;min-width:220px;margin:0}
.calendar-updated{color:#667085;font-size:.75rem;font-weight:900}
.calendar-intervals{display:flex;flex-direction:column;gap:.5rem;margin:.7rem 0}
.calendar-interval{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.6rem;border:1px solid var(--cal-border);border-radius:10px;background:var(--zine-paper2);padding:.6rem .7rem}
.calendar-interval-head{display:flex;align-items:center;gap:.45rem;flex-wrap:wrap}
.calendar-interval small{display:block;margin-top:.2rem;color:#667085;font-size:.72rem;font-weight:800}
.calendar-interval-actions{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.6rem}
.calendar-interval-actions .calendar-action{min-height:40px;padding:.4rem .85rem}
.calendar-composer{margin-top:.9rem;border:1px dashed var(--cal-border);border-radius:12px;padding:.8rem}
.calendar-check{flex-direction:row!important;align-items:center;gap:.45rem}
.calendar-hint{color:#667085;font-size:.68rem;font-weight:800}
.calendar-alternatives{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;margin-top:.6rem;font-size:.78rem;font-weight:900}
.calendar-alternative{border:1px solid var(--cal-border);border-radius:999px;background:var(--zine-card);padding:.35rem .7rem;font-size:.75rem;font-weight:900}
.calendar-range{margin-top:.8rem;border-left:3px solid var(--zine-ink);padding-left:.7rem}
.calendar-degraded{display:flex;flex-direction:column;gap:.3rem;margin:0 0 1rem;border-left:3px solid #d0aa39;border-radius:8px;background:#fffbef;padding:.7rem;color:#765b16;font-size:.82rem;font-weight:800}
.calendar-degraded button{font-weight:900;text-decoration:underline}
.calendar-source{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;justify-content:space-between;border-top:1px solid var(--cal-border);padding:.55rem 0}
.calendar-source-main{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;font-weight:800;min-height:44px}
.calendar-source-meta{display:flex;flex-wrap:wrap;align-items:center;gap:.45rem}
.calendar-source small{color:#667085;font-weight:800}
.calendar-policy-summary{display:flex;flex-direction:column;gap:.3rem;margin:.6rem 0;padding-left:1.1rem;color:#667085;font-size:.8rem;font-weight:800}
.calendar-destination{display:flex;flex-direction:column;gap:.3rem;margin-top:.7rem;font-weight:800}
@media (max-width:599px){.calendar-scope{align-items:stretch}.calendar-scope .calendar-control{flex:1}.calendar-interval{align-items:flex-start}.calendar-source{align-items:flex-start}}
`;

export function CalendarPanel() { return <Inner />; }
export default CalendarPanel;
