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
import { SurfaceBuilder, type A2uiSurface, type Token } from "./a2ui";

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

function clock(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  let h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const ap = h < 12 ? "AM" : "PM";
  h = h % 12 === 0 ? 12 : h % 12;
  return `${h}:${m === 0 ? "00" : String(m).padStart(2, "0")} ${ap}`;
}

// Day window [00:00, 24:00) in UTC for `dayIso` (defaults to today).
function dayWindow(dayIso?: string): { timeMin: string; timeMax: string; label: string } {
  const base = dayIso ? new Date(dayIso) : new Date();
  const y = base.getUTCFullYear(), mo = base.getUTCMonth(), da = base.getUTCDate();
  const min = new Date(Date.UTC(y, mo, da, 0, 0, 0));
  const max = new Date(Date.UTC(y, mo, da + 1, 0, 0, 0));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][min.getUTCDay()];
  const mn = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][mo];
  return { timeMin: min.toISOString(), timeMax: max.toISOString(), label: `${wd} · ${mn} ${da}` };
}

export async function fetchDayEvents(
  env: Env, uid: string, dayIso?: string,
): Promise<{ events: CalEvent[]; label: string }> {
  const { timeMin, timeMax, label } = dayWindow(dayIso);
  const r = await executeTool(env, uid, "GOOGLECALENDAR_EVENTS_LIST", {
    calendarId: "primary", timeMin, timeMax,
    singleEvents: true, orderBy: "startTime", maxResults: 10,
  });
  if (!toolOk(r)) throw new Error(toolErr(r));
  const data = r?.data ?? {};
  const items: any[] = data?.items ?? data?.response_data?.items ?? [];
  const events = items.map((e: any, i: number): CalEvent => {
    const startDt = e?.start?.dateTime;
    const endDt = e?.end?.dateTime;
    const allDay = !startDt && !!(e?.start?.date);
    return {
      id: String(e?.id ?? `ev${i}`),
      title: String(e?.summary ?? "(no title)"),
      start: allDay ? "All day" : clock(startDt),
      end: allDay ? "" : clock(endDt),
      allDay,
      location: e?.location ? String(e.location) : undefined,
      video: !!(e?.hangoutLink || e?.conferenceData),
      guests: Array.isArray(e?.attendees) ? e.attendees.length : 0,
      accent: ACCENTS[i % ACCENTS.length],
    };
  });
  return { events, label };
}

// Compose the A2UI surface for a day (mirrors kit-calendar.jsx).
export function buildCalendarSurface(events: CalEvent[], label: string): A2uiSurface {
  const b = new SurfaceBuilder();
  const kids: string[] = [];

  // header strip: "Sun · Jun 21 · N events"
  kids.push(b.pill(`${label} · ${events.length} ${events.length === 1 ? "event" : "events"}`,
    "calendar-blank", events.length ? "ink" : "paper", events.length ? "paper" : "ink"));
  kids.push(b.spacer(8));

  if (events.length === 0) {
    // open-day hero + schedule action
    kids.push(b.card(b.openDay("Open day", "No scheduled events — you're free."), { fill: "mint" }));
    kids.push(b.spacer(8));
    kids.push(b.button("Schedule a meeting",
      { type: "prompt", text: "schedule a meeting" }, { icon: "calendar-plus", fill: "lime", full: true }));
  } else {
    const rows = events.map((e) => b.card(
      b.eventRow({
        start: e.start, end: e.end, title: e.title,
        location: e.location, video: e.video, guests: e.guests, accent: e.accent,
      }),
      { pad: 0 },
    ));
    kids.push(b.column(rows, 7));
    kids.push(b.spacer(8));
    kids.push(b.button("Add another",
      { type: "prompt", text: "schedule a meeting" }, { icon: "calendar-plus", fill: "lime", full: true }));
  }

  const root = b.column(kids, 0);
  return b.build(root, `cal_${Date.now()}`);
}
