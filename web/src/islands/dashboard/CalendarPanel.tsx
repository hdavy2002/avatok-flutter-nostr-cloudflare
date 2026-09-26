import { useTranslation as useUiTranslation } from "../../lib/i18n/react";
import { UiText } from "../../lib/i18n/react";
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
import { useEffect, useMemo, useRef, useState } from 'react';
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
  LAST_CLOCK_MIN, MAX_EXCEPTIONS, addDays, bookingRoleLabel, clampHorizonDays, clockFieldsToInterval,
  civilDateKey, dayItemsForRange, deriveGoogleReadiness, exceptionBudget, intervalsForDate, intervalLabel,
  intervalToClockFields, isAllDayInterval, isEndOfDayInterval, isValidDateKey, minutesAgo,
  minutesToClock, planDateRange, planIntervalUpserts, planSignature, policySummaryLines, scopeLabel,
  removeInterval, shouldRunConflictPreview, tokenAccountKey, weeklyRepeatDates,
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

type ClerkAccountSurface = {
  user?: { id?: string | null } | null;
  session?: { id?: string | null; user?: { id?: string | null } | null } | null;
  addListener?: (cb: () => void) => () => void;
};

function clerkAccountKey(): string | null {
  if (typeof window === 'undefined') return null;
  const clerk = (window as unknown as { Clerk?: ClerkAccountSurface }).Clerk;
  return clerk?.user?.id || clerk?.session?.user?.id || clerk?.session?.id || null;
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
  const {t:uiT}=useUiTranslation("web-dashboard");

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
                {item.status === 'reserved' ? uiT("web-dashboard.3385ffe6747065e4","Reserved") : item.status === 'available' ? uiT("web-dashboard.ed077f3d8125d60d","Open") : uiT("web-dashboard.18f2a0947f9d6523","Blocked")} · {intervalLabel(item.start_min, item.end_min)}
              </span>
            ))}
            {!items.length && !intervals.length && <span className="calendar-week-empty"><UiText id="web-dashboard.31acc78f4f1ee4a3" source="No commitments" /></span>}
            {items.map((row) => (
              <span className={`calendar-event ${row.tone}`} key={row.key}>
                <b>{row.title}</b><small>{epochRangeLabel(row.start, row.end, schedule.timezone)}{bookingRoleLabel(row.bookingRole) ? ` · ${bookingRoleLabel(row.bookingRole)}` : ''}</small>
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
  const {t:uiT}=useUiTranslation("web-dashboard");

  return (
    <div className="calendar-agenda" aria-label={uiT("web-dashboard.073c1262af0a81ea","Upcoming calendar agenda")}>
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
                  <small>{epochRangeLabel(row.start, row.end, schedule.timezone)} · {row.status}{bookingRoleLabel(row.bookingRole) ? ` · ${bookingRoleLabel(row.bookingRole)}` : ''}</small>
                </span>
              ))}
              {!intervals.length && !items.length && <span className="calendar-agenda-empty"><UiText id="web-dashboard.9b24163e5cadb8da" source="No commitments or exceptions" /></span>}
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
  const {t:uiT}=useUiTranslation("web-dashboard");

  const dayIntervals = intervalsForDate(schedule, date);
  const dayItems = itemsByDay.get(date) ?? [];
  const [composer, setComposer] = useState<Composer>({ mode: 'closed' });
  const [status, setStatus] = useState<ExceptionStatus>('unavailable');
  const [allDay, setAllDay] = useState(false);
  /* [audit #2] A PARTIAL window can also end at minute 1440 (18:00..24:00).
   * "All day" only covers 00:00..1440, so the end needs its own explicit
   * control — otherwise the stored "24:00" was fed to a time input the browser
   * rejects and re-saving the window silently changed it. */
  const [endOfDay, setEndOfDay] = useState(false);
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
  /* [audit #5] A save that would delete or re-write an existing window shows
   * exactly which windows are affected and waits for a second click. */
  const [replaceConfirm, setReplaceConfirm] = useState<{ kind: 'window' | 'range'; signature: string; windows: AvailabilityException[] } | null>(null);

  const dayLabel = dateLabel(date);
  const listingTitle = listings.find((listing) => listing.id === selectedListing)?.title ?? '';

  useEffect(() => {
    const preset = requestedStatus;
    setComposer(preset ? { mode: 'add' } : { mode: 'closed' });
    setStatus(preset ?? 'unavailable');
    setAllDay(false);
    setEndOfDay(false);
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
    setReplaceConfirm(null);
    // The schedule version changes after every successful save; resetting here
    // keeps a stale id from being written back onto a newer schedule.
  }, [date, schedule.version, schedule.listing_id, selectedListing, requestedStatus]);

  function openAdd(preset: ExceptionStatus = 'unavailable') {
    setComposer({ mode: 'add' });
    setStatus(preset);
    setAllDay(false);
    setEndOfDay(false);
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
    setReplaceConfirm(null);
  }

  function openEdit(exception: AvailabilityException) {
    const fields = intervalToClockFields(exception.start_min, exception.end_min);
    setComposer({ mode: 'edit', exception });
    setStatus(exception.status);
    setAllDay(fields.allDay);
    setEndOfDay(fields.endOfDay);
    setStart(fields.start);
    setEnd(fields.end);
    setScope('creator');
    setListingId(exception.listing_id ?? selectedListing ?? '');
    setRepeat('none');
    setError(null);
    setNotice(null);
    setConflicts([]);
    setAlternatives([]);
    setReplaceConfirm(null);
  }

  /** Epoch span of one saved interval. Minute 1440 means the END of the day, so
   *  it must resolve to the NEXT day's 00:00, never to midnight of the same
   *  day (that would collapse a whole-day window to zero length). */
  function intervalSpan(date: string, startMin: number, endMin: number): { start: number; end: number } | null {
    try {
      const startAt = epochForDateTime(date, minutesToClock(startMin), schedule.timezone);
      const endAt = endMin >= 1440
        ? epochForDateTime(addDays(date, 1), '00:00', schedule.timezone)
        : epochForDateTime(date, minutesToClock(endMin), schedule.timezone);
      return { start: startAt, end: endAt };
    } catch { return null; }
  }

  function exceptionRange(exception: AvailabilityException): { start: number; end: number } | null {
    return intervalSpan(exception.date, exception.start_min, exception.end_min);
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
      const fields = clockFieldsToInterval({ start, end, allDay: false, endOfDay });
      if (!fields) {
        return {
          error: endOfDay
            ? 'Choose a start time earlier than the end of the day.'
            : 'Enter a valid start and end time, with the end after the start — or tick “Ends at end of day”.',
        };
      }
      startMin = fields.start_min;
      endMin = fields.end_min;
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

  /** The one planner used by an add, an edit AND the date range. It never drops
   *  an unrelated window, refuses to cover a reserved one, and reports what it
   *  would replace BEFORE the write (see planIntervalUpserts). */
  function planSave(base: CreatorSchedule, dates: string[], template: IntervalTarget, creatorWide: boolean) {
    return planIntervalUpserts(base, template, dates, {
      newId: () => crypto.randomUUID(),
      creatorWide,
      labelForDate: dates.length > 1 ? (key) => dateLabel(key) : undefined,
    });
  }

  function signatureForPlan(mode: 'add' | 'edit', dates: string[], template: IntervalTarget, affected: AvailabilityException[]): string {
    return planSignature({
      mode,
      dates,
      startMin: template.start_min,
      endMin: template.end_min,
      status: template.status,
      listingId: template.listing_id ?? null,
      affectedIds: affected.map((item) => item.id).sort(),
    });
  }

  function replacementSentence(windows: AvailabilityException[]): string {
    const list = windows
      .slice(0, 3)
      .map((item) => `${intervalLabel(item.start_min, item.end_min)} (${statusWordForException(item.status)})`)
      .join(', ');
    const rest = windows.length > 3 ? ` and ${windows.length - 3} more` : '';
    return `${list}${rest}`;
  }

  function describeSaved(built: { dates: string[]; creatorWide: boolean }) {
    const scopeText = built.creatorWide ? 'across all your listings' : `for ${listingTitle || 'this listing'}`;
    const verb = status === 'reserved' ? 'Kept' : status === 'available' ? 'Opened' : 'Blocked';
    if (repeat !== 'none' && built.dates.length > 1) return `${verb} ${built.dates.length} weekly windows ${scopeText}, starting ${dateLabel(built.dates[0])}.`;
    if (built.dates.length > 1) return `${verb} ${built.dates.length} days ${scopeText}, starting ${dateLabel(built.dates[0])}.`;
    return `${verb} ${dayLabel} ${allDay ? 'all day' : `${start}–${endOfDay ? '24:00' : end}`} ${scopeText}.`;
  }

  async function previewSingle(auth: string, template: IntervalTarget, creatorWide: boolean, targetListing: string | null) {
    const hard = template.status === 'reserved' || (creatorWide && template.status === 'unavailable');
    if (!hard) return null;
    try {
      // Built from the template's own minutes, not from the composer's `allDay`
      // flag, so the preview always checks the interval that will be saved.
      const span = intervalSpan(date, template.start_min, template.end_min);
      if (!span) return null;
      const preview = await previewCalendarConflicts(auth, { listing_id: targetListing, start_at: span.start, end_at: span.end, timezone: schedule.timezone });
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
    const saveMode = composer.mode;
    if (saveMode === 'closed') { setError('Open a time window before saving.'); return; }
    const built = intervalFromForm();
    if ('error' in built) { setError(built.error); return; }
    setBusy(true); setError(null); setNotice(null); setConflicts([]); setAlternatives([]);
    try {
      await withCalendarAuth(async (auth) => {
        const resolved = await resolveTargetSchedule(auth);
        if (!resolved) return;
        // [audit #5] The plan runs FIRST: it is the check that refuses to cover a
        // reserved window and never drops an unrelated one, and it is what the
        // confirmation below describes.
        const plan = planSave(resolved.target, built.dates, built.template, resolved.creatorWide);
        if (plan.conflicts.length) { setError(plan.conflicts.join(' ')); return; }
        // [audit #3] Cosmetic pre-check only. An edit (or any save that
        // replaces/covers a window) is never run through it — the server preview
        // cannot exclude the window being changed, so it would report the block
        // as clashing with itself. Those saves rely on the atomic PUT, which
        // excludes this schedule's own prior reservation mirrors and still
        // refuses a real booking or another schedule's reservation.
        if (shouldRunConflictPreview({ mode: saveMode, dates: built.dates.length, conflicts: plan.conflicts, removed: plan.removed, replaced: plan.replaced })) {
          const preview = await previewSingle(auth, built.template, resolved.creatorWide, resolved.listingId);
          if (preview) {
            setConflicts(preview.conflicts);
            setAlternatives(preview.alternatives);
            if (preview.message) setError(preview.message);
            return;
          }
        }
        const affected = [...plan.removed, ...plan.replaced];
        const signature = signatureForPlan(saveMode, built.dates, built.template, affected);
        if (affected.length && (replaceConfirm?.kind !== 'window' || replaceConfirm.signature !== signature)) {
          setReplaceConfirm({ kind: 'window', signature, windows: affected });
          setError(`This would replace ${affected.length} existing window${affected.length === 1 ? '' : 's'} on ${dayLabel}: ${replacementSentence(affected)}. Nothing has been saved — confirm to continue.`);
          return;
        }
        const response = await saveCreatorSchedule(auth, { ...resolved.target, exceptions: plan.next });
        setNotice(`${describeSaved(built)}${affected.length ? ` ${affected.length} existing window${affected.length === 1 ? '' : 's'} were replaced.` : ''}`);
        onSaved(response.schedule);
        onStatusConsumed();
        setReplaceConfirm(null);
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
        const applied = planSave(resolved.target, plan.dates, target, resolved.creatorWide);
        if (applied.conflicts.length) {
          setError(`Nothing was saved. ${applied.conflicts.slice(0, 2).join(' ')}`);
          return;
        }
        // [audit #5] A range that would delete or re-write existing windows is
        // confirmed first, and the exact windows are named. Reserved windows are
        // refused above, never replaced here.
        const replacedWindows = [...applied.removed, ...applied.replaced];
        const signature = signatureForPlan('add', plan.dates, target, replacedWindows);
        if (replacedWindows.length && (replaceConfirm?.kind !== 'range' || replaceConfirm.signature !== signature)) {
          setReplaceConfirm({ kind: 'range', signature, windows: replacedWindows });
          setError(`Nothing was saved. ${plan.dates.length} date${plan.dates.length === 1 ? '' : 's'} would be added, replacing ${replacedWindows.length} existing window${replacedWindows.length === 1 ? '' : 's'}: ${replacementSentence(replacedWindows)}. Confirm to continue, or keep them.`);
          return;
        }
        const response = await saveCreatorSchedule(auth, { ...resolved.target, exceptions: applied.next });
        const affected = plan.dates.filter((key) => (itemsByDay.get(key) ?? []).some((item) => item.kind === 'booking'));
        const rangeVerb = status === 'reserved' ? 'Kept' : status === 'available' ? 'Opened' : 'Blocked';
        setNotice(`${rangeVerb} all day on ${plan.dates.length} date${plan.dates.length === 1 ? '' : 's'} ${resolved.creatorWide ? 'across all your listings' : `for ${listingTitle || 'this listing'}`}.${replacedWindows.length ? ` ${replacedWindows.length} existing window${replacedWindows.length === 1 ? '' : 's'} were replaced.` : ''}${affected.length ? ` ${affected.length} date${affected.length === 1 ? '' : 's'} already hold a booking; those appointments are NOT cancelled — open them to reschedule or cancel.` : ''}`);
        onSaved(response.schedule);
        setReplaceConfirm(null);
        setRangeOpen(false);
      });
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  async function removeOne(exception: AvailabilityException) {
    if (!token) { setError('Your session ended. Sign in again to change your calendar.'); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      await withCalendarAuth(async (auth) => {
        // [audit #5] Removing ONE window keeps every other exception, on this
        // date and on every other date — the same rule the unit test asserts.
        const response = await saveCreatorSchedule(auth, { ...schedule, exceptions: removeInterval(schedule, exception.id) });
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
          <p className="calendar-eyebrow"><UiText id="web-dashboard.b13a92d0b2d24515" source="Selected day ·" />{" "}{schedule.timezone}</p>
          <h2 id="day-editor-heading">{dayLabel}</h2>
        </div>
        <StatusBadge status={dayIntervals.length ? `${dayIntervals.length} exception${dayIntervals.length === 1 ? '' : 's'}` : uiT("web-dashboard.b1413f4a07d38ffc","Usual hours")} />
      </div>
      <p className="calendar-muted"><UiText id="web-dashboard.8565628c50a9ddc0" source="Every window on this day is listed below and can be changed on its own. Existing bookings stay protected until explicitly rescheduled or cancelled." />{" "}</p>

      <div className="calendar-intervals">
        {!dayIntervals.length && <p className="calendar-muted"><UiText id="web-dashboard.6dd2d37d553049c7" source="Your usual working hours apply on this day." /></p>}
        {dayIntervals.map((exception) => (
          <div className="calendar-interval" key={exception.id}>
            <div>
              <span className="calendar-interval-head">
                <StatusBadge status={statusWordForException(exception.status)} />
                <b>{intervalLabel(exception.start_min, exception.end_min)}</b>
              </span>
              <small>
                {exception.status === 'reserved'
                  ? uiT("web-dashboard.523cfe5ee2ac38dd","Kept for {value0}",{value0:String(scopeLabel(exception, listings))})
                  : exception.listing_id ? scopeLabel(exception, listings) : uiT("web-dashboard.39623e25ae17a8db","All listings")}
                {holdsCommitment(exception) ? uiT("web-dashboard.f4086c27598a9df8"," · overlaps an existing commitment") : ''}
              </small>
            </div>
            <div className="calendar-interval-actions">
              <button type="button" className={`${ACTION} calendar-secondary`} onClick={() => openEdit(exception)} disabled={busy}><UiText id="web-dashboard.464c4ffd019e1e96" source="Edit" /></button>
              {pendingRemove === exception.id ? (
                <>
                  <button type="button" className={`${ACTION} calendar-danger`} onClick={() => void removeOne(exception)} disabled={busy}><UiText id="web-dashboard.10764ef5d00450ba" source="Confirm remove" /></button>
                  <button type="button" className={`${ACTION} calendar-secondary`} onClick={() => setPendingRemove(null)} disabled={busy}><UiText id="web-dashboard.19766ed6ccb2f4a3" source="Cancel" /></button>
                </>
              ) : (
                <button type="button" className="calendar-remove" onClick={() => {
                  if (exception.status === 'reserved' || holdsCommitment(exception)) setPendingRemove(exception.id);
                  else void removeOne(exception);
                }} disabled={busy}><UiText id="web-dashboard.c3812fc4acb861d5" source="Remove" /></button>
              )}
            </div>
          </div>
        ))}
      </div>

      {composer.mode === 'closed' && (
        <div className="calendar-interval-actions">
          <button type="button" className={`${ACTION} calendar-secondary`} onClick={() => openAdd('unavailable')} disabled={busy}><UiText id="web-dashboard.ffa1b5d1b13974a6" source="+ Add another time" /></button>
          {dayIntervals.length > 0 && (pendingClear ? (
            <>
              <button type="button" className={`${ACTION} calendar-danger`} onClick={() => void clearDay()} disabled={busy}><UiText id="web-dashboard.e295717296152f6a" source="Confirm: use usual hours" /></button>
              <button type="button" className={`${ACTION} calendar-secondary`} onClick={() => setPendingClear(false)} disabled={busy}><UiText id="web-dashboard.19766ed6ccb2f4a3" source="Cancel" /></button>
            </>
          ) : (
            <button type="button" className={`${ACTION} calendar-secondary`} onClick={() => {
              if (reservedOverlap || dayItems.length) setPendingClear(true);
              else void clearDay();
            }} disabled={busy}><UiText id="web-dashboard.82678a7bb507641f" source="Use usual hours" /></button>
          ))}
        </div>
      )}

      {composer.mode !== 'closed' && (
        <div className="calendar-composer">
          <div className="calendar-editor-fields">
            <label><UiText id="web-dashboard.e0db220b9cb72120" source="What is this time?" />{" "}<select className={CONTROL} value={status} onChange={(event) => {
                const next = event.target.value as ExceptionStatus;
                setStatus(next);
                if (next === 'reserved') setScope('listing');
              }}>
                <option value="unavailable"><UiText id="web-dashboard.4fb4c407bc01d8bf" source="I'm busy" /></option>
                <option value="available"><UiText id="web-dashboard.a8f7245b7ac72427" source="I'm available" /></option>
                <option value="reserved"><UiText id="web-dashboard.902d53b9ec99e402" source="Keep this time for a listing" /></option>
              </select>
            </label>
            <label><UiText id="web-dashboard.6687458beee57a58" source="Applies to" />{" "}<select className={CONTROL} value={status === 'reserved' ? uiT("web-dashboard.0fc4dfc4feb3b154","listing") : scope} disabled={!!editing || status === 'reserved'} onChange={(event) => setScope(event.target.value as 'creator' | 'listing')}>
                <option value="creator"><UiText id="web-dashboard.eb8c47b7dc05e91a" source="All listings (creator-wide)" /></option>
                <option value="listing"><UiText id="web-dashboard.879d8fb64f88733e" source="Only" />{" "}{listingTitle || uiT("web-dashboard.5af17668bf98e7d3","one listing")}</option>
              </select>
            </label>
            {(status === 'reserved' || scope === 'listing') && (
              <label><UiText id="web-dashboard.fc7f1aa2054c2283" source="Listing" />{" "}<select className={CONTROL} value={listingId} onChange={(event) => setListingId(event.target.value)}>
                  <option value=""><UiText id="web-dashboard.5825664816d2370e" source="Choose a listing…" /></option>
                  {listings.map((listing) => <option key={listing.id} value={listing.id}>{listing.title}</option>)}
                </select>
              </label>
            )}
            <label className="calendar-check">
              <input type="checkbox" checked={allDay} onChange={(event) => {
                const next = event.target.checked;
                setAllDay(next);
                if (next) { setStart('00:00'); setEnd('17:00'); }
              }} /><UiText id="web-dashboard.b2aa99ef71c2d141" source="All day (00:00–24:00)" />{" "}</label>
            {!allDay && <label><UiText id="web-dashboard.96dbedeca7dfb7fa" source="Starts" /><input className={CONTROL} type="time" value={start} onChange={(event) => setStart(event.target.value)} /></label>}
            {!allDay && (
              <label><UiText id="web-dashboard.e98982c9f2ba3332" source="Ends" />{" "}<input className={CONTROL} type="time" value={end} disabled={endOfDay} onChange={(event) => setEnd(event.target.value)} />
                {/* [audit #2] The explicit end-of-day control. "24:00" is a legal
                 *  SAVED value but never a legal <input type="time"> value, so the
                 *  flag — not the field — decides the minute that is saved. */}
                <span className="calendar-check">
                  <input type="checkbox" checked={endOfDay} onChange={(event) => setEndOfDay(event.target.checked)} /><UiText id="web-dashboard.c7de137e86e1c924" source="ends at end of day (24:00)" />{" "}</span>
              </label>
            )}
            {!editing && (
              <label><UiText id="web-dashboard.b6b7a0065808a62e" source="Repeat" />{" "}<select className={CONTROL} value={repeat} onChange={(event) => setRepeat(event.target.value as 'none' | 'weekly')}>
                  <option value="none"><UiText id="web-dashboard.d31d574a22f3b563" source="This date only" /></option>
                  <option value="weekly"><UiText id="web-dashboard.145061a8f880fbbf" source="Every week through the schedule horizon" /></option>
                </select>
              </label>
            )}
          </div>
          {editing && (
            <p className="calendar-muted"><UiText id="web-dashboard.10b2e352507e181a" source="Editing the window that is already saved. Its scope stays" />{" "}{editing.listing_id ? `“${scopeLabel(editing, listings)}”` : uiT("web-dashboard.74616ca9579b6078","“all listings”")}<UiText id="web-dashboard.454cda9cd06a3983" source="; remove it and add a new window to change where it applies." />{" "}</p>
          )}
          <p className="calendar-muted">
            {allDay ? uiT("web-dashboard.34233e542b7b9a86","All day") : `${start}–${endOfDay ? '24:00' : end}`}
            {' · '}
            {status === 'reserved' ? uiT("web-dashboard.7341cde027598072","kept for {value0}",{value0:String(chosenListingTitle ?? 'the chosen listing')}) : status === 'available' ? uiT("web-dashboard.d1c4566539dc9d22","open for booking") : uiT("web-dashboard.6973dddd3ef9cb6a","blocked")}
            {' · '}
            {status === 'reserved' || scope === 'listing'
              ? uiT("web-dashboard.6ed890d2c0aa4a30","saved on {value0}'s own schedule",{value0:String(chosenListingTitle ?? 'the chosen listing')})
              : uiT("web-dashboard.7c55b257f55961ee","saved on your creator-wide schedule")}
          </p>

          {conflicts.length > 0 && (
            <div className="calendar-conflict" role="alert">
              <b><UiText id="web-dashboard.35b1bac2b4318e81" source="Conflict found" /></b>
              {conflicts.map((item) => (
                <span key={`${item.title}-${item.start_at}`}>{item.title} · {epochRangeLabel(item.start_at, item.end_at, schedule.timezone, true)}</span>
              ))}
            </div>
          )}
          {alternatives.length > 0 && (
            <div className="calendar-alternatives">
              <b><UiText id="web-dashboard.9cee155d6180a025" source="Free times nearby" /></b>
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

          {/* [audit #5] No silent data loss: every window this save would delete
           *  or re-write is named here, and nothing is written until the creator
           *  confirms. Reserved windows never appear here — the plan refuses them. */}
          {replaceConfirm && (
            <div className="calendar-conflict" role="alert">
              <b><UiText id="web-dashboard.9ef1f743c81c305c" source="This replaces" />{" "}{replaceConfirm.windows.length}{" "}<UiText id="web-dashboard.3f271f0521f923f6" source="existing window" />{replaceConfirm.windows.length === 1 ? '' : uiT("web-dashboard.043a718774c572bd","s")}</b>
              {replaceConfirm.windows.map((item) => (
                <span key={item.id}>
                  {dateLabel(item.date, { month: 'short', day: 'numeric' })} · {intervalLabel(item.start_min, item.end_min)} · {statusWordForException(item.status)}
                </span>
              ))}
              <span><UiText id="web-dashboard.d1a44a54c56a4f4a" source="Nothing has been saved yet. Confirm to replace them, or keep them." /></span>
            </div>
          )}

          <div className="calendar-interval-actions">
            <button type="button" className={`${ACTION} calendar-primary`} onClick={() => void save()} disabled={busy}>
              {busy ? uiT("web-dashboard.23e39291d6135814","Saving…") : replaceConfirm?.kind === 'window' ? uiT("web-dashboard.d854c9c3ac189c6f","Confirm: replace {value0} window{value1}",{value0:String(replaceConfirm.windows.length),value1:String(replaceConfirm.windows.length === 1 ? '' : 's')}) : editing ? uiT("web-dashboard.9daaa6974e82644c","Save this window") : uiT("web-dashboard.dd898991954a7a45","Add this time")}
            </button>
            <button type="button" className={`${ACTION} calendar-secondary`} onClick={() => { setComposer({ mode: 'closed' }); setConflicts([]); setAlternatives([]); setError(null); setReplaceConfirm(null); onStatusConsumed(); }} disabled={busy}>{replaceConfirm?.kind === 'window' ? uiT("web-dashboard.0d472b0953093973","Keep them") : uiT("web-dashboard.19766ed6ccb2f4a3","Cancel")}</button>
            {!editing && <button type="button" className={`${ACTION} calendar-secondary`} onClick={() => { setRangeOpen((open) => !open); setReplaceConfirm((current) => (current?.kind === 'range' ? null : current)); }} disabled={busy}>{rangeOpen ? uiT("web-dashboard.42011e7f8445179d","Hide date range") : uiT("web-dashboard.1a2ccb7710307748","Block several days")}</button>}
          </div>

          {!editing && rangeOpen && (
            <div className="calendar-range">
              <p className="calendar-eyebrow"><UiText id="web-dashboard.1bd623b608a46374" source="From this date through this date" /></p>
              <p className="calendar-muted"><UiText id="web-dashboard.7c8c9e8c63a7e3a7" source="Adds one all-day" />{" "}{status === 'reserved' ? uiT("web-dashboard.79f076abdd19a752","kept") : status === 'available' ? uiT("web-dashboard.2348f99874421257","open") : uiT("web-dashboard.6973dddd3ef9cb6a","blocked")}{" "}<UiText id="web-dashboard.494fba1ced6861f0" source="window per day, using the listing chosen above. Ranges stop at your" />{" "}{clampHorizonDays(schedule.horizon_days)}<UiText id="web-dashboard.edfd3fd9f1dd3222" source="-day booking horizon and the" />{" "}{MAX_EXCEPTIONS}<UiText id="web-dashboard.623431edd607a4b4" source="-exception limit for one schedule; anything left out is reported before saving." />{" "}</p>
              <div className="calendar-editor-fields">
                <label><UiText id="web-dashboard.218197693424e015" source="From" /><input className={CONTROL} type="date" value={rangeFrom} onChange={(event) => setRangeFrom(event.target.value)} /></label>
                <label><UiText id="web-dashboard.afc6abac44c4184c" source="Through" /><input className={CONTROL} type="date" value={rangeTo} onChange={(event) => setRangeTo(event.target.value)} /></label>
              </div>
              <p className="calendar-muted">
                {rangePreview.dates.length}{" "}<UiText id="web-dashboard.944c27e5b97ab779" source="day" />{rangePreview.dates.length === 1 ? '' : uiT("web-dashboard.043a718774c572bd","s")}{" "}<UiText id="web-dashboard.d203828dcc5cad39" source="will be added" />{" "}{rangeAffected.length ? uiT("web-dashboard.683f068ec6424759"," · {value0} already hold a booking (they are not cancelled)",{value0:String(rangeAffected.length)}) : ''}.
              </p>
              {rangePreview.messages.map((line) => <p className="calendar-form-message calendar-warning" key={line}>{line}</p>)}
              {rangeMessages.map((line) => <p className="calendar-form-message calendar-warning" key={line}>{line}</p>)}
              <div className="calendar-interval-actions">
                <button type="button" className={`${ACTION} calendar-primary`} onClick={() => void saveRange()} disabled={busy}>{busy ? uiT("web-dashboard.23e39291d6135814","Saving…") : replaceConfirm?.kind === 'range' ? uiT("web-dashboard.d854c9c3ac189c6f","Confirm: replace {value0} window{value1}",{value0:String(replaceConfirm.windows.length),value1:String(replaceConfirm.windows.length === 1 ? '' : 's')}) : uiT("web-dashboard.6e44ccee344f268a","Apply to these days")}</button>
                {replaceConfirm?.kind === 'range' && <button type="button" className={`${ACTION} calendar-secondary`} onClick={() => setReplaceConfirm(null)} disabled={busy}><UiText id="web-dashboard.0d472b0953093973" source="Keep them" /></button>}
              </div>
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
  const {t:uiT}=useUiTranslation("web-dashboard");

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
            <p className="calendar-eyebrow"><UiText id="web-dashboard.d2b877320f24092a" source="Weekly windows" /></p>
            <h2><UiText id="web-dashboard.b9c635214e54995c" source="Working hours" /></h2>
          </div>
          <button type="button" className={`${ACTION} calendar-secondary`} onClick={() => setDraft((value) => ({ ...value, rules: [...value.rules, { weekday: 1, start_min: 9 * 60, end_min: 17 * 60 }] }))}><UiText id="web-dashboard.241837054a718c3b" source="+ Add hours" /></button>
        </div>
        <p className="calendar-muted">
          {draft.listing_id
            ? uiT("web-dashboard.8a11b0d719fbd266","These hours belong to {value0} only.",{value0:String(listingTitle ?? 'this listing')})
            : uiT("web-dashboard.a459ac2b8d090e02","These are the creator windows every listing can inherit; a listing-specific schedule can narrow or replace them.")}
        </p>
        {!draft.rules.length && <div className="calendar-empty calendar-empty-small"><b><UiText id="web-dashboard.66db2aab9a84b932" source="No working hours yet" /></b><span><UiText id="web-dashboard.ea4c686ef185712d" source="Add a window before opening dates to customers." /></span></div>}
        <div className="calendar-rule-list">
          {draft.rules.map((rule, index) => {
            const wholeDay = isAllDayInterval(rule.start_min, rule.end_min);
            /* [audit #2] A weekly window can also END at minute 1440 (e.g.
             *  18:00–24:00). "All day" does not cover that, and the clock field
             *  cannot hold "24:00", so the rule carries an explicit end-of-day
             *  flag and the input is only ever fed an accepted value. */
            const endOfDay = isEndOfDayInterval(rule.start_min, rule.end_min);
            return (
              <div className="calendar-rule" key={`${rule.weekday}-${index}`}>
                <label><UiText id="web-dashboard.8f2364e11b8be3ff" source="Day" />{" "}<select className={CONTROL} value={rule.weekday} onChange={(event) => updateRule(index, { weekday: Number(event.target.value) })}>
                    {DAYS.map((day, weekday) => <option value={weekday} key={day}>{day}</option>)}
                  </select>
                </label>
                {!wholeDay && (
                  <label><UiText id="web-dashboard.96dbedeca7dfb7fa" source="Starts" /><input className={CONTROL} type="time" value={minutesToClock(Math.min(rule.start_min, LAST_CLOCK_MIN))} onChange={(event) => updateRule(index, { start_min: timeToMinutes(event.target.value) })} /></label>
                )}
                {!wholeDay && (
                  <label><UiText id="web-dashboard.e98982c9f2ba3332" source="Ends" />{" "}<input className={CONTROL} type="time" value={minutesToClock(Math.min(rule.end_min, LAST_CLOCK_MIN))} disabled={endOfDay} onChange={(event) => updateRule(index, { end_min: timeToMinutes(event.target.value) })} />
                    <span className="calendar-check">
                      <input type="checkbox" checked={endOfDay} onChange={(event) => updateRule(index, { end_min: event.target.checked ? 1440 : LAST_CLOCK_MIN })} /><UiText id="web-dashboard.c7de137e86e1c924" source="ends at end of day (24:00)" />{" "}</span>
                  </label>
                )}
                <label className="calendar-check">
                  <input type="checkbox" checked={wholeDay} onChange={(event) => updateRule(index, event.target.checked ? { start_min: 0, end_min: 1440 } : { start_min: 9 * 60, end_min: 17 * 60 })} /><UiText id="web-dashboard.34233e542b7b9a86" source="All day" />{" "}</label>
                <button type="button" className="calendar-remove" aria-label={`Remove ${DAYS[rule.weekday]} hours`} onClick={() => setDraft((value) => ({ ...value, rules: value.rules.filter((_, i) => i !== index) }))}><UiText id="web-dashboard.c3812fc4acb861d5" source="Remove" /></button>
              </div>
            );
          })}
        </div>
      </section>

      <section className="calendar-card">
        <p className="calendar-eyebrow"><UiText id="web-dashboard.58e3fced1c1a2554" source="Booking policy" /></p>
        <h2><UiText id="web-dashboard.97583372035de9f7" source="How slots behave" /></h2>
        <div className="calendar-policy-fields">
          <label><UiText id="web-dashboard.487e34fa0b7a121c" source="Creator timezone" />{" "}<select className={CONTROL} value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })}>
              {Array.from(new Set([draft.timezone, ...TIMEZONES])).map((timezone) => <option value={timezone} key={timezone}>{timezone}</option>)}
            </select>
          </label>
          <label><UiText id="web-dashboard.04a40528293f013d" source="Schedule mode" />{" "}<select className={CONTROL} value={draft.mode} onChange={(event) => setDraft({ ...draft, mode: event.target.value as CreatorSchedule['mode'] })}>
              <option value="shared"><UiText id="web-dashboard.4f6241d4163c0485" source="Shared across listings" /></option>
              <option value="custom"><UiText id="web-dashboard.a15b43d356b349a1" source="Custom listing hours" /></option>
              <option value="exclusive"><UiText id="web-dashboard.5bdc405187e439d9" source="Exclusive windows" /></option>
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
        <p className="calendar-muted"><UiText id="web-dashboard.dcf1d0f68a23c609" source="Timezone changes regroup recurring rules by wall time. Confirm affected appointments before making a change." /></p>
        <ul className="calendar-policy-summary">
          {policySummaryLines({ schedule: draft, listingTitle }).map((line) => <li key={line}>{line}</li>)}
        </ul>
        {message && <p className="calendar-form-message" role="status">{message}</p>}
        <button type="button" className={`${ACTION} calendar-primary`} onClick={() => void save()} disabled={saving}>
          {saving ? uiT("web-dashboard.23e39291d6135814","Saving…") : uiT("web-dashboard.1c013d87406c9e9e","Save working hours for {value0}",{value0:String(listingTitle ?? 'all listings')})}
        </button>
      </section>
    </div>
  );
}

/* ── Connected calendars (#5, #6) ───────────────────────────────────────── */
function ConnectedCalendars({ token, status, onStatus, onReload }: {
  token: string; status: GoogleCalendarStatus | null; onStatus: (value: GoogleCalendarStatus) => void; onReload: () => void;
}) {
  const {t:uiT}=useUiTranslation("web-dashboard");

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
    if (!destination || !selected.includes(destination) || !writable.includes(destination)) { setError('Choose a selected writable calendar as the Saa Thum event destination.'); return; }
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
          <p className="calendar-eyebrow"><UiText id="web-dashboard.d9c8d414e4caac2f" source="External availability" /></p>
          <h2><UiText id="web-dashboard.e4432d00d36f09f9" source="Connected calendars" /></h2>
        </div>
        <StatusBadge status={readiness.label} />
      </div>
      <p className="calendar-muted"><UiText id="web-dashboard.ce991ed3f1d4ae75" source="Selected Google calendars contribute busy time. Private titles and guest details never reach customers. Saa Thum bookings stay authoritative if Google is unavailable." />{" "}</p>
      <p className="calendar-muted"><UiText id="web-dashboard.e4fe7d7e1414cd03" source="Bookings are only accepted while this reads" />{" "}<b><UiText id="web-dashboard.5fa7aac5375c5815" source="Ready" /></b>{" "}<UiText id="web-dashboard.a18a4b42cbf643b3" source="— that is the same rule the booking engine applies before it takes a reservation. Not connected, Syncing and Needs attention all refuse new bookings." />{" "}</p>
      <p className="calendar-muted" role="status">{readiness.detail}</p>

      {!status && <div className="calendar-state calendar-state-loading"><Spinner size={20} />{" "}<UiText id="web-dashboard.de9fc337d5990009" source="Checking connection…" /></div>}

      {status && !status.connected && (
        <div className="calendar-empty calendar-empty-small">
          <b><UiText id="web-dashboard.c2be9bb61b0e163a" source="No calendar connected" /></b>
          <span><UiText id="web-dashboard.c299b2dfaed2bf3d" source="Connect Google Calendar when external meetings should block slots. Until then, Google busy time cannot be verified." /></span>
          <button type="button" className={`${ACTION} calendar-primary`} onClick={() => void connect()} disabled={!!busy}>{busy === 'connect' ? uiT("web-dashboard.c926c2c50e65d5a5","Opening…") : uiT("web-dashboard.c04f9d6a937ed0cb","Connect Google Calendar")}</button>
        </div>
      )}

      {status?.connected && (
        <>
          <div className="calendar-sync-panel">
            <div>
              <b><UiText id="web-dashboard.657c82108b65da18" source="Busy-time synchronisation" /></b>
              <span>{lastSuccessText}. {readiness.selectedCount}{" "}<UiText id="web-dashboard.5152790e278eb890" source="calendar" />{readiness.selectedCount === 1 ? '' : uiT("web-dashboard.043a718774c572bd","s")}{" "}<UiText id="web-dashboard.c3719d3982b02041" source="block time." /></span>
            </div>
            <div className="calendar-sync-actions">
              <button type="button" className={`${ACTION} calendar-primary`} onClick={() => void syncNow()} disabled={!!busy}>{busy === 'sync' ? uiT("web-dashboard.8a046cc90ab0a981","Syncing…") : uiT("web-dashboard.b3b0dc53fca87e58","Sync busy times now")}</button>
              <button type="button" className={`${ACTION} calendar-secondary`} onClick={() => void refreshCalendars()} disabled={!!busy}>{busy === 'list' ? uiT("web-dashboard.1c0def7be0607b96","Refreshing…") : uiT("web-dashboard.98071fc01411c436","Refresh calendar list")}</button>
              <button type="button" className={`${ACTION} calendar-secondary`} onClick={() => void connect()} disabled={!!busy}><UiText id="web-dashboard.bf8a9eab9e7e141b" source="Reconnect" /></button>
              <button type="button" className={`${ACTION} calendar-danger`} onClick={() => void disconnect()} disabled={!!busy}>{busy === 'disconnect' ? uiT("web-dashboard.cb2b6a572a8588d8","Disconnecting…") : uiT("web-dashboard.acfc5be785a9bb3d","Disconnect")}</button>
            </div>
          </div>

          {(readiness.state === 'attention' || readiness.state === 'syncing') && (
            <p className="calendar-form-message calendar-warning" role="status">
              {readiness.state === 'syncing'
                ? uiT("web-dashboard.12a5e2f61cb428aa","The first import has not finished. Until it does, new bookings are refused.")
                : uiT("web-dashboard.1cf3c7b93c4b931b","Fix this before relying on Google busy time: {value0}",{value0:String(readiness.detail)})}
            </p>
          )}

          {calendars.length > 0 && (
            <div className="calendar-card" style={{ marginTop: '1rem' }}>
              <p className="calendar-eyebrow"><UiText id="web-dashboard.5f3fee23a8fbc51a" source="Availability sources" /></p>
              <p className="calendar-muted"><UiText id="web-dashboard.3cfb0168649b2506" source="Choose which calendars block slots, then choose where Saa Thum bookings are written. CalendarList permission may require reconnecting an older connection." /></p>
              {calendars.map((item) => {
                const source = readiness.sources.find((entry) => entry.id === item.id);
                return (
                  <div className="calendar-source" key={item.id}>
                    <label className="calendar-source-main">
                      <input type="checkbox" checked={item.selected} onChange={() => toggleCalendar(item.id)} />
                      <span>{item.summary}{item.primary ? uiT("web-dashboard.940bbab2b1839a27"," · primary") : ''}</span>
                      {item.destination && <span className="calendar-badge calendar-badge-reserved"><UiText id="web-dashboard.f351ca0b2b77bd4a" source="Saa Thum events" /></span>}
                    </label>
                    <span className="calendar-source-meta">
                      <StatusBadge status={source?.state === 'ready' ? uiT("web-dashboard.5fa7aac5375c5815","Ready") : source?.state === 'attention' ? uiT("web-dashboard.c1ebc7817870e5be","Needs attention") : source?.state === 'syncing' ? uiT("web-dashboard.5c8b9e1ce0a2bc31","Syncing") : uiT("web-dashboard.dccafe55abe3dd98","Not used")} />
                      <small>{item.timezone || uiT("web-dashboard.3feedd19618b46ee","timezone unknown")}{source?.detail ? ` · ${source.detail}` : ''}</small>
                    </span>
                  </div>
                );
              })}
              <label className="calendar-destination"><UiText id="web-dashboard.e368d753c861712f" source="Saa Thum event destination" />{" "}<select className={CONTROL} value={destination} onChange={(event) => setDestination(event.target.value)}>
                  {calendars.filter((item) => item.selected && (!item.access_role || item.access_role === 'writer' || item.access_role === 'owner')).map((item) => <option key={item.id} value={item.id}>{item.summary}</option>)}
                </select>
              </label>
              <button type="button" className={`${ACTION} calendar-primary`} onClick={() => void saveSelection()} disabled={!!busy}>{busy === 'save' ? uiT("web-dashboard.23e39291d6135814","Saving…") : uiT("web-dashboard.665182a0c1700eaf","Save calendar choices")}</button>
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
  const {t:uiT}=useUiTranslation("web-dashboard");

  const loadSequence = useRef(0);
  const tokenRef = useRef<string | null>(null);
  const listingRef = useRef('');
  const lastLoadedRef = useRef<number | null>(null);
  const lastMutationRef = useRef(0);
  const selectedDateTouchedRef = useRef(false);
  /* [audit #1] The account the retained state belongs to. Signing into another
   * account in the same tab must clear it, never show the previous account's
   * calendar. */
  const accountKeyRef = useRef<string | null>(null);
  const clerkObservedAccountRef = useRef<string | null>(null);
  const clerkChangeSequenceRef = useRef(0);

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
  /* Bumped when the signed-in account changes, so the load effect runs again
   * against the cleared state instead of reusing the old account's data. */
  const [dataEpoch, setDataEpoch] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const nextToken = await getActiveToken();
        if (cancelled) return;
        const currentClerkKey = clerkAccountKey();
        const clerkLoaded = typeof window !== 'undefined' && Boolean((window as unknown as { Clerk?: ClerkAccountSurface }).Clerk);
        const nextTokenKey = tokenAccountKey(nextToken);
        if (nextToken && ((currentClerkKey && nextTokenKey && nextTokenKey !== currentClerkKey) || (clerkLoaded && !currentClerkKey && nextTokenKey && !nextToken.startsWith('g1.')))) {
          setToken(null);
          accountKeyRef.current = null;
          resetAccountState('error', 'Sign in to manage your calendar and availability.');
          return;
        }
        setToken(nextToken);
        if (!nextToken) {
          accountKeyRef.current = null;
          resetAccountState('error', 'Sign in to manage your calendar and availability.');
        }
      } catch {
        if (!cancelled) {
          setToken(null);
          accountKeyRef.current = null;
          resetAccountState('error', 'Could not check your sign-in. Try again.');
        }
      } finally { if (!cancelled) setChecked(true); }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { tokenRef.current = token; }, [token]);
  useEffect(() => { listingRef.current = selectedListing; }, [selectedListing]);
  useEffect(() => { lastLoadedRef.current = lastLoadedAt; }, [lastLoadedAt]);

  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | undefined;
    async function refreshForClerkAccountChange(nextAccountKey: string | null) {
      if (cancelled) return;
      if (nextAccountKey === clerkObservedAccountRef.current) return;
      const previousAccountKey = clerkObservedAccountRef.current;
      clerkObservedAccountRef.current = nextAccountKey;
      const ticket = ++clerkChangeSequenceRef.current;
      if (!nextAccountKey) {
        loadSequence.current += 1;
        setToken(null);
        tokenRef.current = null;
        accountKeyRef.current = null;
        resetAccountState('error', 'Sign in to manage your calendar and availability.');
        setChecked(true);
        return;
      }
      if (previousAccountKey !== null || (accountKeyRef.current && accountKeyRef.current !== nextAccountKey)) {
        loadSequence.current += 1;
        accountKeyRef.current = nextAccountKey;
        setToken(null);
        tokenRef.current = null;
        resetAccountState();
        setDataEpoch((value) => value + 1);
      }
      try {
        const nextToken = await getActiveToken(5000, { skipCache: true });
        if (cancelled || ticket !== clerkChangeSequenceRef.current || clerkAccountKey() !== nextAccountKey) return;
        if (!nextToken) {
          setToken(null);
          tokenRef.current = null;
          resetAccountState('error', 'Sign in to manage your calendar and availability.');
          return;
        }
        const tokenKey = tokenAccountKey(nextToken);
        if (tokenKey && tokenKey !== nextAccountKey) return;
        setToken(nextToken);
        setChecked(true);
      } catch {
        if (!cancelled && ticket === clerkChangeSequenceRef.current && clerkAccountKey() === nextAccountKey) {
          setToken(null);
          tokenRef.current = null;
          resetAccountState('error', 'Could not refresh your sign-in. Try again.');
        }
      }
    }
    function attach(): boolean {
      if (typeof window === 'undefined') return false;
      const clerk = (window as unknown as { Clerk?: ClerkAccountSurface }).Clerk;
      if (!clerk) return false;
      clerkObservedAccountRef.current = clerkAccountKey();
      if (!unsub && clerk.addListener) unsub = clerk.addListener(() => { void refreshForClerkAccountChange(clerkAccountKey()); });
      return true;
    }
    if (!attach()) {
      const poll = window.setInterval(() => { if (attach()) window.clearInterval(poll); }, 300);
      return () => { cancelled = true; window.clearInterval(poll); try { unsub?.(); } catch { /* ignore */ } };
    }
    return () => { cancelled = true; try { unsub?.(); } catch { /* ignore */ } };
  }, []);

  const range = useMemo(() => {
    const first = startOfCalendarWeek(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
    const last = addCalendarDays(first, 41);
    return { from: first, to: last, fromKey: formatDateKey(first), toKey: formatDateKey(last) };
  }, [cursor]);

  /** Drop everything that belonged to the previous account. */
  function resetAccountState(nextState: LoadState = 'loading', message: string | null = null) {
    selectedDateTouchedRef.current = false;
    setListings([]);
    setSchedule(null);
    setBlocks([]);
    setEvents([]);
    setAvailability(new Map());
    setAvailabilityChecked(false);
    setAvailabilityError(null);
    setGoogleStatus(null);
    setDegraded([]);
    setError(message);
    setLastLoadedAt(null);
    setRequestedStatus(null);
    setSelectedListing('');
    setState(nextState);
  }

  async function load(auth: string, listingId: string, silent = false) {
    // [audit #1] Take the ticket BEFORE the token-renewal await. Renewing can
    // take seconds; when the ticket was taken afterwards, an OLDER request that
    // renewed slowly could be handed the HIGHER sequence and land last,
    // overwriting the newer month/filter with stale data.
    const sequence = ++loadSequence.current;
    // Refresh Clerk's session before a dashboard reload: an idle/backgrounded
    // tab can otherwise reuse an expired JWT.
    let refreshed: string | null = null;
    try {
      refreshed = await getActiveToken(5000, { skipCache: true });
    } catch {
      if (sequence !== loadSequence.current) return;
      setToken(null);
      tokenRef.current = null;
      accountKeyRef.current = null;
      resetAccountState('error', 'Could not refresh your sign-in. Try again.');
      return;
    }
    if (sequence !== loadSequence.current) return;
    if (!refreshed) {
      setToken(null);
      tokenRef.current = null;
      accountKeyRef.current = null;
      resetAccountState('error', 'Sign in to manage your calendar and availability.');
      return;
    }
    auth = refreshed;
    // [audit #1] Account isolation, before anything from the old account can be
    // merged with the new one's response.
    const accountKey = tokenAccountKey(auth);
    if (accountKey && accountKey !== accountKeyRef.current) {
      clerkObservedAccountRef.current = accountKey;
      accountKeyRef.current = accountKey;
      resetAccountState();
      setDataEpoch((value) => value + 1);
      return;
    }
    if (!silent) setState('loading');
    setError(null);
    setAvailabilityError(null);
    const [listingResult, scheduleResult, blocksResult, eventsResult, googleResult] = await Promise.allSettled([
      request<{ listings: ListingCard[] }>('/api/listings/mine', { auth }),
      getCreatorSchedule(auth, listingId || null),
      getCalendarBlocks(auth, addCalendarDays(range.from, -2).getTime(), addCalendarDays(range.to, 3).getTime()),
      getCalendarEvents(auth),
      getGoogleCalendarStatus(auth),
    ]);
    if (sequence !== loadSequence.current) return;
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
    setDegraded(failures);
    setError(failures.length ? `Could not load ${failures[0]}.` : null);
    setState(scheduleResult.status === 'rejected' ? 'error' : 'ready');
    setLastLoadedAt(Date.now());

    /* [audit #4] Slot counts are asked for AFTER phase 1, in the timezone of the
     * schedule that was just returned. Issuing this call in parallel used the
     * timezone captured from the PREVIOUS schedule (or a guessed browser zone),
     * so after a timezone change the counts belonged to the wrong day window.
     * The same reasoning forbids using the counts when the schedule itself
     * failed: there is no trustworthy zone, so the days stay UNKNOWN. */
    setAvailability(new Map());
    setAvailabilityChecked(false);
    if (listingId && scheduleResult.status === 'fulfilled') {
      const timezone = scheduleResult.value.schedule.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      try {
        const availabilityResult = await getListingAvailability(listingId, range.fromKey, range.toKey, timezone, auth);
        if (sequence !== loadSequence.current) return;
        setAvailability(new Map((availabilityResult.days ?? []).map((day) => [day.date, day.available_count])));
        setAvailabilityChecked(true);
      } catch (availabilityFailure) {
        if (sequence !== loadSequence.current) return;
        setAvailabilityError(errorText(availabilityFailure));
      }
    }
  }

  useEffect(() => {
    if (!checked) return;
    if (!token) { setState('error'); setError('Sign in to manage your calendar and availability.'); return; }
    void load(token, selectedListing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked, token, selectedListing, range.fromKey, range.toKey, dataEpoch]);

  useEffect(() => { setRequestedStatus(null); }, [selectedDate]);

  useEffect(() => {
    if (!schedule || selectedDateTouchedRef.current) return;
    const todayKey = civilDateKey(Date.now(), schedule.timezone);
    if (!todayKey) return;
    setSelectedDate(todayKey);
    setCursor(parseDateKey(todayKey));
  }, [schedule?.timezone]);

  // [audit #12] An open tab is not a live view. Refreshing on focus (and when a
  // backgrounded tab becomes visible again) keeps the diary from silently
  // showing yesterday's commitments.
  //
  // [audit #1] The listener must call the load that matches the range on SCREEN
  // NOW. Registered once with `[]`, it closed over the mount render's `load`,
  // so after paging to a future month a focus/visibility reload fetched the
  // month that was on screen at mount and could overwrite the newer data. The
  // range keys are the only closure values `load` still reads, so they are the
  // effect's dependencies; the listener is re-registered when they change.
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
  }, [range.fromKey, range.toKey, dataEpoch]);

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
  function selectDate(value: string) {
    selectedDateTouchedRef.current = true;
    setSelectedDate(value);
  }
  function goToday() {
    const key = civilDateKey(Date.now(), calendarTimezone) ?? formatDateKey(new Date());
    selectedDateTouchedRef.current = true;
    setCursor(parseDateKey(key));
    setSelectedDate(key);
  }
  function refresh() { if (token) void load(token, selectedListing, true); }
  function handleSaved(value: CreatorSchedule) {
    lastMutationRef.current = Date.now();
    if ((value.listing_id ?? null) === (schedule?.listing_id ?? null)) setSchedule(value);
    if (token) void load(token, selectedListing, true);
  }

  if (!checked || (state === 'loading' && !schedule)) return <div className="calendar-state calendar-state-loading"><Spinner size={24} /><span><UiText id="web-dashboard.ba586c580595cc55" source="Loading your calendar…" /></span></div>;
  if (!token) return <div className="calendar-state calendar-state-error" role="alert"><UiText id="web-dashboard.3549fe36c397b45f" source="Sign in to manage your calendar and availability." /></div>;

  const listingTitle = listings.find((listing) => listing.id === selectedListing)?.title ?? null;

  return (
    <div className="calendar-shell">
      <style>{CSS}</style>

      {/* [audit #9] The edit scope is visible on every tab, not only inside the
       *  Calendar tab: a creator must never wonder which schedule a save hits. */}
      <div className="calendar-scope">
        <label className="calendar-scope-label" htmlFor="calendar-scope"><UiText id="web-dashboard.fab4539d26e078ca" source="Editing" /></label>
        <select id="calendar-scope" className={CONTROL} value={selectedListing} onChange={(event) => setSelectedListing(event.target.value)}>
          <option value=""><UiText id="web-dashboard.eb8c47b7dc05e91a" source="All listings (creator-wide)" /></option>
          {listings.map((listing) => <option key={listing.id} value={listing.id}>{listing.title}</option>)}
        </select>
        <span className="calendar-muted">
          {listingTitle
            ? uiT("web-dashboard.5d298c2cb20c4a25","Working hours, blocks and policy below belong to {value0}. Personal busy time still defaults to all listings.",{value0:String(listingTitle)})
            : uiT("web-dashboard.0fe5e22a87143a7f","Working hours, blocks and policy below apply to every listing. Pick a listing to plan its own windows.")}
        </span>
      </div>

      <nav className="calendar-nav" aria-label={uiT("web-dashboard.3676e86c090d177e","Calendar settings tabs")}>
        {([['calendar', 'Calendar'], ['hours', 'Working hours'], ['connected', 'Connected calendars']] as [Tab, string][]).map(([value, label]) => (
          <button type="button" className="calendar-tab" aria-selected={tab === value} key={value} onClick={() => setTab(value)}>{label}</button>
        ))}
      </nav>

      {state === 'error' && error && (
        <div className="calendar-form-message" role="alert">
          {error} <button type="button" className="underline" onClick={refresh}><UiText id="web-dashboard.d8b8392e2c542950" source="Try again" /></button>
        </div>
      )}
      {/* [audit #4] Busy time or appointments failing is NOT a quiet day. */}
      {state !== 'error' && degraded.length > 0 && (
        <div className="calendar-degraded" role="status">
          <b><UiText id="web-dashboard.cc634ffd2be94850" source="The diary may be incomplete." /></b>
          <span><UiText id="web-dashboard.81bc72e54792e9fc" source="Could not load" />{" "}{degraded.join('; ')}<UiText id="web-dashboard.d75fc6221e1a2190" source=". Showing the last known values — an apparently empty day is not proof you are free." />{" "}{' '}<button type="button" className="underline" onClick={refresh}><UiText id="web-dashboard.942087cc2d41e013" source="Retry" /></button>
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
            <label className="sr-only" htmlFor="calendar-timezone"><UiText id="web-dashboard.4ceca1d52cede44d" source="Timezone" /></label>
            <select id="calendar-timezone" className={CONTROL} value={schedule.timezone} disabled>
              {Array.from(new Set([schedule.timezone, ...TIMEZONES])).map((timezone) => <option value={timezone} key={timezone}>{timezone}</option>)}
            </select>
            <span className="calendar-updated">{updatedLabel(lastLoadedAt)}</span>
            <span className="calendar-toolbar-spacer" />
            <button type="button" className={`${ACTION} calendar-secondary`} onClick={refresh}><UiText id="web-dashboard.0e91610117029a62" source="Refresh" /></button>
            <button type="button" className={`${ACTION} calendar-secondary`} onClick={goToday}><UiText id="web-dashboard.2b065c7c9ce466e5" source="Today" /></button>
            <div className="calendar-view-toggle" aria-label={uiT("web-dashboard.66a89d9a70cdf18f","Calendar view")}>
              <button type="button" className="calendar-view-button" aria-pressed={view === 'month'} onClick={() => setView('month')}><UiText id="web-dashboard.310ca503ef36f177" source="Month" /></button>
              <button type="button" className="calendar-view-button" aria-pressed={view === 'week'} onClick={() => setView('week')}><UiText id="web-dashboard.e78041ab51a818a2" source="Week" /></button>
              <button type="button" className="calendar-view-button" aria-pressed={view === 'agenda'} onClick={() => setView('agenda')}><UiText id="web-dashboard.0fdf485f5bfd3762" source="Agenda" /></button>
              <button type="button" className="calendar-view-button" onClick={() => setRequestedStatus('unavailable')}><UiText id="web-dashboard.f2528d968937419e" source="Block time" /></button>
              <button type="button" className="calendar-view-button" onClick={() => setRequestedStatus('available')}><UiText id="web-dashboard.fc31b9e73c1696bd" source="Open availability" /></button>
            </div>
          </div>

          {availabilityError && (
            <p className="calendar-form-message calendar-warning" role="status"><UiText id="web-dashboard.57fb7a1d8cc8d71e" source="Bookable slot counts are unknown right now (" />{availabilityError}<UiText id="web-dashboard.489436244667a5d1" source="). The calendar still shows confirmed commitments and will not show “0 open” for a day it could not check." />{" "}</p>
          )}
          {!availabilityChecked && !selectedListing && listings.length > 0 && (
            <p className="calendar-muted"><UiText id="web-dashboard.c3d0ce7392ed0182" source="Select a listing above to see how many bookable slots each day has. Until then, no day is shown as “0 open”." /></p>
          )}
          {!listings.length && (
            <div className="calendar-empty calendar-empty-small" style={{ marginBottom: '1rem' }}>
              <b><UiText id="web-dashboard.38975ad4e8356135" source="No listings yet" /></b>
              <span><UiText id="web-dashboard.db6ae2bd5f8e8588" source="Create and publish a listing before reserving exclusive time." /></span>
              <a className={`${ACTION} calendar-primary`} href="/dashboard/listings/new"><UiText id="web-dashboard.9a697d39c1f46d3c" source="Create a listing" /></a>
            </div>
          )}

          <div className="calendar-main-grid">
            <section className="calendar-card calendar-month-panel">
              <div className="calendar-month-heading">
                <button type="button" className="calendar-arrow" aria-label={uiT("web-dashboard.6a2769502a5dda78","Previous month")} onClick={() => moveCursor(-1)}>←</button>
                <h2>{view === 'agenda' ? uiT("web-dashboard.533e21e0187ca38f","Upcoming agenda") : monthLabel(cursor)}</h2>
                <button type="button" className="calendar-arrow" aria-label={uiT("web-dashboard.74e53211fef4b4d4","Next month")} onClick={() => moveCursor(1)}>→</button>
              </div>
              <details className="calendar-phone-month">
                <summary><UiText id="web-dashboard.b2f58970cb5ff3c7" source="Show month overview" /></summary>
                <CalendarGrid cursor={cursor} selectedDate={selectedDate} onSelect={selectDate} schedule={schedule} itemsByDay={itemsByDay} availability={availability} availabilityChecked={availabilityChecked} />
              </details>
              {view === 'month' && <CalendarGrid cursor={cursor} selectedDate={selectedDate} onSelect={selectDate} schedule={schedule} itemsByDay={itemsByDay} availability={availability} availabilityChecked={availabilityChecked} />}
              {view === 'week' && <WeekGrid selectedDate={selectedDate} onSelect={selectDate} schedule={schedule} itemsByDay={itemsByDay} />}
              {view === 'month' && (
                <div className="calendar-phone-agenda">
                  <Agenda selectedDate={selectedDate} onSelect={selectDate} schedule={schedule} itemsByDay={itemsByDay} listings={listings} />
                </div>
              )}
              {view === 'agenda' && <Agenda selectedDate={selectedDate} onSelect={selectDate} schedule={schedule} itemsByDay={itemsByDay} listings={listings} />}
              {!monthItemCount && !schedule.rules.length && (
                <div className="calendar-empty calendar-empty-small" style={{ marginTop: '1rem' }}>
                  <b><UiText id="web-dashboard.ec63106d7896e0e8" source="Your calendar is quiet" /></b>
                  <span><UiText id="web-dashboard.5bcfe13f05f3ac7b" source="Add working hours or open a date to start accepting bookings." /></span>
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
              onSelectDate={selectDate}
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
