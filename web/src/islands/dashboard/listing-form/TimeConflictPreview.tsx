/* [CAL-AUDIT-2026-09-15 · #11] Immediate conflict preview for the Time step.
 *
 * Before this, the ONLY check of a fixed time ran at save time
 * (ListingWizard.saveListingAvailability), so a creator typed a date, hit
 * Continue, and only then learned the time was taken. This island runs the same
 * authenticated POST /api/calendar/conflicts/preview — never a write — while the
 * date/time/duration fields change, and says one of four things:
 *
 *   "Checking your calendar…"   · the debounced request is in flight
 *   "This time is free…"        · ok
 *   "This overlaps <title>."    · with the free times the server offered
 *   "Could not check…"          · the preview itself failed
 *
 * Two rules it must not break:
 *   • NO automatic write on preview. It only reads; the server re-validates at
 *     publication/booking.
 *   • A slow answer for an OLD time must never overwrite the answer for the
 *     time on screen now — see createRequestGate in lib/calendarCore, which
 *     tickets every request and lets only the newest one set state.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { getActiveTokenWaited as getActiveToken } from '../../../lib/clerk';
import { epochForDateTime, previewCalendarConflicts } from '../../../lib/availability';
import type { ConflictAlternative, ConflictItem } from '../../../lib/availability';
import { conflictPreviewKey, createRequestGate, listingReservationSentence } from '../../../lib/calendarCore';
import { epochToLocal } from './wizardLogic';
import type { ListingDraft } from './types';

type PreviewStatus = 'idle' | 'checking' | 'free' | 'conflict' | 'error';

const PREVIEW_DEBOUNCE_MS = 450;

interface PreviewState {
  status: PreviewStatus;
  conflicts: ConflictItem[];
  alternatives: ConflictAlternative[];
  message: string | null;
  /** The conflictPreviewKey this answer belongs to; null while idle. */
  forKey: string | null;
}

const IDLE: PreviewState = { status: 'idle', conflicts: [], alternatives: [], message: null, forKey: null };

function previewErrorText(error: unknown): string {
  const e = error as { message?: string; body?: { reason?: string; error?: string } };
  return e?.body?.reason || e?.body?.error || e?.message || 'The preview could not be completed.';
}

export function TimeConflictPreview({ draft, listingId, onUseTime }: {
  draft: ListingDraft;
  listingId: string | null;
  onUseTime?: (localDateTime: string) => void;
}) {
  const [state, setState] = useState<PreviewState>(IDLE);
  const gate = useRef(createRequestGate());

  const isExclusiveConsult = draft.kind === 'consult' && draft.availability_mode === 'exclusive';
  const checkable = draft.schedule_mode === 'fixed_date' && draft.starts_at !== '' && (draft.kind !== 'consult' || isExclusiveConsult);

  const { startAt, endAt } = useMemo(() => {
    if (!checkable) return { startAt: null as number | null, endAt: null as number | null };
    const [date, time] = draft.starts_at.split('T');
    if (!date || !time) return { startAt: null, endAt: null };
    try {
      const start = epochForDateTime(date, time, draft.timezone);
      const duration = Number.isFinite(draft.duration_min) ? Math.max(5, draft.duration_min) : 60;
      return { startAt: start, endAt: start + duration * 60_000 };
    } catch { return { startAt: null, endAt: null }; }
  }, [checkable, draft.starts_at, draft.timezone, draft.duration_min]);

  const key = conflictPreviewKey({ listingId, startAt, endAt, timezone: draft.timezone });

  useEffect(() => {
    if (!checkable) { setState(IDLE); return; }
    if (!key) { setState(IDLE); return; }
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const token = await getActiveToken();
      if (cancelled) return;
      if (!token) {
        setState({ status: 'error', conflicts: [], alternatives: [], message: 'Sign in again to check this time.', forKey: key });
        return;
      }
      const ticket = gate.current.next();
      setState((current) => ({ ...current, status: 'checking', message: null, forKey: key }));
      try {
        const response = await previewCalendarConflicts(token, { listing_id: listingId, start_at: startAt!, end_at: endAt!, timezone: draft.timezone }, controller.signal);
        if (cancelled || !gate.current.isCurrent(ticket)) return;
        setState({
          status: response.ok ? 'free' : 'conflict',
          conflicts: response.conflicts ?? [],
          alternatives: response.alternatives ?? [],
          message: null,
          forKey: key,
        });
      } catch (error) {
        if (cancelled || !gate.current.isCurrent(ticket)) return;
        setState({ status: 'error', conflicts: [], alternatives: [], message: previewErrorText(error), forKey: key });
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timer); };
  }, [checkable, key, listingId, startAt, endAt, draft.timezone]);

  const reservation = listingReservationSentence(draft.status);

  if (!checkable) {
    return (
      <p className="mt-2 font-body text-[12px] font-bold text-inkSoft">
        {draft.kind === 'consult' && draft.availability_mode !== 'exclusive'
          ? 'This listing uses your calendar hours, so there is no single fixed time to check.'
          : 'Pick a date and time and this is checked against your calendar straight away.'}
      </p>
    );
  }
  if (!listingId) {
    return (
      <p className="mt-2 font-body text-[12px] font-bold text-inkSoft">
        Save this step once and the time you pick is checked against your calendar before you continue. {reservation}
      </p>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-zine border-zine border-dashed border-ink p-3" role="status" aria-live="polite">
      <div className="font-body text-[13px] font-bold text-ink">
        {state.status === 'checking' ? 'Checking your calendar…'
          : state.status === 'free' ? 'This time is free on your calendar.'
            : state.status === 'conflict' ? (state.conflicts[0] ? `This overlaps ${state.conflicts[0].title || 'another commitment'}.` : 'This time conflicts with another commitment.')
              : state.status === 'error' ? `Could not check this time: ${state.message}`
                : 'Checking this time against your calendar…'}
      </div>
      {state.conflicts.length > 0 && (
        <ul className="flex flex-col gap-1 font-body text-[12px] font-bold text-inkSoft">
          {state.conflicts.map((conflict) => (
            <li key={`${conflict.title}-${conflict.start_at}`}>
              {conflict.title || 'Commitment'} · {new Date(conflict.start_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: draft.timezone })}
            </li>
          ))}
        </ul>
      )}
      {state.alternatives.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 font-body text-[12px] font-bold text-ink">
          <span>Free times nearby:</span>
          {state.alternatives.map((slot) => (
            <button
              key={slot.start_at}
              type="button"
              className="rounded-full border border-ink/40 bg-card px-2 py-1"
              onClick={() => onUseTime?.(epochToLocal(slot.start_at, draft.timezone))}
            >
              {new Date(slot.start_at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: draft.timezone })}
            </button>
          ))}
        </div>
      )}
      <p className="font-body text-[12px] font-bold text-inkSoft">{reservation}</p>
    </div>
  );
}

export default TimeConflictPreview;
