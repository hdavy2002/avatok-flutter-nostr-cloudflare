// gcal.ts — Google Calendar (Composio) for the in-chat calendar pilot. Fetches
// the day's events and composes an A2UI surface that mirrors the design in
// theme/design/AvaTOK Design System/ui_kits/avatok/kit-calendar.jsx (open-day
// hero when free; a stacked event list when busy). Read-only for the pilot — the
// scheduler / invite-compose overlays in the design are a later phase.
//
// Composio slug verified live: GOOGLECALENDAR_EVENTS_LIST {calendarId:"primary",
// timeMin,timeMax (RFC3339), singleEvents, orderBy:"startTime", maxResults}
// → data.items[] { summary, start.{dateTime|date}, end.{dateTime|date},
//   attendees[], hangoutLink, location }.

import type { Env } from "../types";
import { executeTool } from "./composio";
import { toolOk, toolErr } from "./gmail";
import { SurfaceBuilder, type A2uiSurface, type A2uiAction, type Token } from "./a2ui";

export interface CalEvent {
  id: string;
  title: string;
  start: string;   // "3:00 PM" | "All day"
  end: string;     // "3:30 PM" | ""
  allDay: boolean;
  location?: string;
  video: boolean;  // has a hangout/meet link
  guests: number;  // attendee count
  accent: Token;
}

const ACCENTS: Token[] = ["blue", "lime", "mint", "lilac", "coral"];

// ---- timezone-correct formatting -------------------------------------------
// Google returns each event's `start.dateTime` as an RFC3339 instant WITH its
// own UTC offset, and the events.list response carries the calendar's IANA
// `timeZone`. We MUST render in a real zone, not UTC: the old code called
// getUTCHours(), so a noon-local event showed as "7:00 PM" etc. We format the
// instant in the resolved IANA zone via Intl (DST-safe, same approach as
// cal/engine.ts). `tz` resolution: explicit caller hint → calendar's own zone →
// UTC. A bad/unknown zone falls back to UTC rather than throwing.
function safeTz(tz?: string): string {
  if (!tz) return "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return "UTC"; }
}

function clock(iso: string | undefined, tz: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  try {
    // e.g. "3:00 PM" in the viewer's zone.
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true,
    }).format(d);
  } catch {
    // Defensive: unknown zone — render the UTC wall clock so we never crash.
    let h = d.getUTCHours(); const m = d.getUTCMinutes();
    const ap = h < 12 ? "AM" : "PM"; h = h % 12 === 0 ? 12 : h % 12;
    return `${h}:${m === 0 ? "00" : String(m).padStart(2, "0")} ${ap}`;
  }
}

// Offset (ms) of IANA `tz` at instant `utcMs`. DST-safe (ported from cal/engine.ts).
function zoneOffsetMs(tz: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour === 24 ? 0 : +p.hour, +p.minute, +p.second);
  return asUTC - utcMs;
}

// UTC instant of local-wall midnight for (y,mo,da) in `tz`. Two-pass DST fix.
function zonedMidnight(y: number, mo: number, da: number, tz: string): number {
  const wall = Date.UTC(y, mo, da, 0, 0, 0);
  let utc = wall - zoneOffsetMs(tz, wall);
  utc = wall - zoneOffsetMs(tz, utc);
  return utc;
}

// Day window [00:00, 24:00) for `dayIso` (defaults to now), computed in `tz` so
// "today" means the user's local day — not the UTC day. Label is also in `tz`.
function dayWindow(dayIso: string | undefined, tz: string): { timeMin: string; timeMax: string; label: string } {
  const base = dayIso ? new Date(dayIso) : new Date();
  // Calendar date (Y-M-D) as seen in `tz` for the given instant.
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(base)) p[part.type] = part.value;
  const y = +p.year, mo = +p.month - 1, da = +p.day;
  const minMs = zonedMidnight(y, mo, da, tz);
  const maxMs = zonedMidnight(y, mo, da + 1, tz);
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric",
  }).format(new Date(minMs)).replace(",", " ·").replace(/ (\d)/, " $1"); // "Mon · Jun 22"
  return { timeMin: new Date(minMs).toISOString(), timeMax: new Date(maxMs).toISOString(), label };
}

// Local calendar date "YYYY-MM-DD" of `ms` as seen in `tz` (for all-day match).
function localDateStr(ms: number, tz: string): string {
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(ms))) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

// `tzHint` (optional, IANA) forces the viewer's zone (e.g. the client device/geo
// zone). When omitted we adopt the calendar's own zone from the events.list
// response. The query uses a PADDED window (±18h covers every UTC offset) so a
// single read is enough; we then keep only events that fall on the local day in
// the resolved zone and format their times in it. "today" = the local day, and
// the times shown match what the user sees in Google Calendar.
export async function fetchDayEvents(
  env: Env, uid: string, dayIso?: string, tzHint?: string,
): Promise<{ events: CalEvent[]; label: string }> {
  const base = dayIso ? new Date(dayIso) : new Date();
  // Padded window so the single query is guaranteed to include the local day for
  // any timezone (max real offset is ±14h; ±18h is safe headroom).
  const pad = 18 * 60 * 60 * 1000;
  const timeMin = new Date(base.getTime() - pad).toISOString();
  const timeMax = new Date(base.getTime() + 24 * 60 * 60 * 1000 + pad).toISOString();
  const r = await executeTool(env, uid, "GOOGLECALENDAR_EVENTS_LIST", {
    calendarId: "primary", timeMin, timeMax,
    singleEvents: true, orderBy: "startTime", maxResults: 50,
  });
  if (!toolOk(r)) throw new Error(toolErr(r));
  const data: any = r?.data ?? {};
  // Resolve the viewer zone: explicit hint → calendar's own zone → UTC.
  const tz = safeTz(tzHint ?? data?.timeZone ?? data?.response_data?.timeZone);
  const win = dayWindow(dayIso, tz);
  const dayMin = new Date(win.timeMin).getTime();
  const dayMax = new Date(win.timeMax).getTime();
  const dayDate = localDateStr(dayMin, tz);

  const items: any[] = data?.items ?? data?.response_data?.items ?? [];
  const events: CalEvent[] = [];
  items.forEach((e: any, i: number) => {
    const startDt = e?.start?.dateTime;
    const endDt = e?.end?.dateTime;
    const allDay = !startDt && !!(e?.start?.date);
    // Keep only events on the local day. Timed: instant inside [00:00,24:00) of
    // the local day. All-day: its date equals the local day's date.
    if (allDay) {
      if (String(e?.start?.date ?? "") !== dayDate) return;
    } else {
      const t = new Date(startDt).getTime();
      if (isNaN(t) || t < dayMin || t >= dayMax) return;
    }
    const evTz = safeTz(e?.start?.timeZone ?? tz);
    events.push({
      id: String(e?.id ?? `ev${i}`),
      title: String(e?.summary ?? "(no title)"),
      start: allDay ? "All day" : clock(startDt, evTz),
      end: allDay ? "" : clock(endDt, evTz),
      allDay,
      location: e?.location ? String(e.location) : undefined,
      video: !!(e?.hangoutLink || e?.conferenceData),
      guests: Array.isArray(e?.attendees) ? e.attendees.length : 0,
      accent: ACCENTS[events.length % ACCENTS.length],
    });
  });
  return { events, label: win.label };
}

// Compose the A2UI surface for a day (mirrors kit-calendar.jsx).
//
// `scheduleAction` is the REAL create-event affordance resolved from Composio's
// catalog (GOOGLECALENDAR_CREATE_EVENT, with its actual fields: summary,
// start_datetime, event_duration_*, calendar_id="primary"). Passing it makes the
// "Schedule a meeting" button OPEN A FORM and create the event — fixing the old
// bug where the button fired a bare "schedule a meeting" prompt that just
// re-listed the day. If it couldn't be resolved we omit the button rather than
// ship a dead-end prompt loop.
export function buildCalendarSurface(events: CalEvent[], label: string, scheduleAction?: A2uiAction): A2uiSurface {
  const b = new SurfaceBuilder();
  const kids: string[] = [];

  // header strip: "Sun · Jun 21 · N events"
  kids.push(b.pill(`${label} · ${events.length} ${events.length === 1 ? "event" : "events"}`,
    "calendar-blank", events.length ? "ink" : "paper", events.length ? "paper" : "ink"));
  kids.push(b.spacer(8));

  if (events.length === 0) {
    // open-day hero + schedule action
    kids.push(b.card(b.openDay("Open day", "No scheduled events — you're free."), { fill: "mint" }));
    if (scheduleAction) {
      kids.push(b.spacer(8));
      kids.push(b.button("Schedule a meeting", scheduleAction, { icon: "calendar-plus", fill: "lime", full: true }));
    }
  } else {
    const rows = events.map((e) => b.card(
      b.eventRow({
        start: e.start, end: e.end, title: e.title,
        location: e.location, video: e.video, guests: e.guests, accent: e.accent,
      }),
      { pad: 0 },
    ));
    kids.push(b.column(rows, 7));
    if (scheduleAction) {
      kids.push(b.spacer(8));
      kids.push(b.button("Add another", scheduleAction, { icon: "calendar-plus", fill: "lime", full: true }));
    }
  }

  const root = b.column(kids, 0);
  return b.build(root, `cal_${Date.now()}`);
}
