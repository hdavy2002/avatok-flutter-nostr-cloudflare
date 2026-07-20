// worker/src/lib/campaign_tools.ts
//
// AVA-CAMP-C-CAL — calendar booking ToolDefs for the campaign AI agent.
// Spec: Specs/OUTBOUND-AI-CALLING-CAMPAIGNS.md §10 (Connectors & tools —
// Google Calendar) and §19 seam 6.
//
// §10 summary this file implements:
//   - Gating: only called when the campaign's "Appointment booking" toggle is
//     on AND the owner's Composio `googlecalendar` connected_account is
//     ACTIVE — that check happens upstream (the wizard / room construction);
//     this module just returns [] when `bookingEnabled` is false so the tool
//     never appears in the model's declarations.
//   - `check_availability(date_range)` -> GOOGLECALENDAR_FIND_FREE_SLOTS
//   - `book_appointment(...)` -> GOOGLECALENDAR_CREATE_EVENT, attendee/contact
//     info + campaign + attempt_uuid in the description, explicit timeZone
//     (India-only v1, IST assumptions fine per §10).
//   - Idempotency: CREATE_EVENT carries `attempt_uuid` in a private extended
//     property (`extendedProperties.private.avatok_attempt_uuid`). NOTE: the
//     curated Composio GOOGLECALENDAR_CREATE_EVENT input fields verified in
//     Specs/AVAAPPS-COMPOSIO-CHAT-IO-REFERENCE.md §5 do not enumerate
//     `extendedProperties` explicitly (only calendar_id/summary/description/
//     location/start_datetime/event_duration_*/attendees/timezone/
//     create_meeting_room/send_updates/recurrence are documented) — we pass
//     it anyway since the underlying Google Calendar API supports it and
//     Composio's schema in practice is a passthrough superset; if Composio
//     silently drops unknown fields, `attempt_uuid` in the description is the
//     fallback breadcrumb. A REAL dedupe-on-retry (as opposed to this
//     best-effort single-attempt path) would need to call
//     GOOGLECALENDAR_FIND_EVENT filtered by the private extended property
//     BEFORE creating, to detect "we already booked this" on a retried tool
//     call — that lookup is not implemented here (FIND_EVENT's filter
//     support for extendedProperties is unverified against the curated
//     slug list); ToolRuntime's own idempotency is limited to "never
//     silently book a DIFFERENT slot on conflict" (below), not "never
//     double-book on exact retry."
//   - On a conflict/slot-taken response from Composio: return
//     `{success:false, error_code:'slot_taken', alternatives:[...]}` with the
//     next 2 free slots (best-effort follow-up FIND_FREE_SLOTS call) and
//     NEVER silently book a different slot.
//   - Composio 401/auth failure -> `error_code:'authorization_failed'`.

import type { ToolDef, ToolResult } from "./tool_runtime";
import { executeTool } from "./composio";
import type { Env } from "../types";

/** India-only v1 default (§10). */
const DEFAULT_TZ = "Asia/Kolkata";

export interface CampaignToolsCtx {
  ownerUid: string;
  attemptUuid: string;
  campaignId: string;
  contactName?: string;
  contactE164?: string;
  bookingEnabled: boolean;
  timeZone?: string;
}

// ---- shared helpers ---------------------------------------------------------

// Composio's universal envelope is {data, successful, error, log_id} (verified
// in Specs/AVAAPPS-COMPOSIO-CHAT-IO-REFERENCE.md). executeTool() can also
// reject (network/timeout/non-2xx) — those land here as a thrown Error whose
// message embeds the HTTP status, e.g. "composio /tools/execute/X 401: ...".
function isAuthError(err: unknown, composioResult?: any): boolean {
  const s = [
    err instanceof Error ? err.message : String(err ?? ""),
    composioResult?.error ? String(composioResult.error) : "",
  ].join(" ");
  return /\b401\b|unauthor|invalid_grant|invalid_token|re-?auth|not authenticated|no connected account/i.test(s);
}

function isConflictError(err: unknown, composioResult?: any): boolean {
  const s = [
    err instanceof Error ? err.message : String(err ?? ""),
    composioResult?.error ? String(composioResult.error) : "",
  ].join(" ");
  return /\bconflict\b|already booked|slot.?taken|busy|409/i.test(s);
}

function composioFailed(r: any): boolean {
  return !!(r && (r.successful === false || r.error));
}

// Best-effort normalizer for GOOGLECALENDAR_FIND_FREE_SLOTS's response shape.
// The exact field name for the returned slot list isn't pinned down in the
// verified reference doc (only the input fields timeMin/timeMax are), so this
// defensively tries the plausible shapes and always returns an array (never
// throws) — worst case an empty list rather than a crash.
function normalizeSlots(data: any): Array<{ start: string; end: string }> {
  if (!data || typeof data !== "object") return [];
  const candidates: any[] =
    data.slots ?? data.free_slots ?? data.availableSlots ?? data.available_slots ??
    data.free ?? data.freeSlots ?? [];
  const arr = Array.isArray(candidates) ? candidates : [];
  const out: Array<{ start: string; end: string }> = [];
  for (const s of arr) {
    if (!s || typeof s !== "object") continue;
    const start = s.start ?? s.start_datetime ?? s.startTime ?? s.from;
    const end = s.end ?? s.end_datetime ?? s.endTime ?? s.to;
    if (start && end) out.push({ start: String(start), end: String(end) });
  }
  return out;
}

async function findFreeSlots(
  env: Env, ownerUid: string, timeMin: string, timeMax: string, timeZone: string,
): Promise<Array<{ start: string; end: string }>> {
  const r = await executeTool(env, ownerUid, "GOOGLECALENDAR_FIND_FREE_SLOTS", {
    calendarId: "primary",
    timeMin,
    timeMax,
    timeZone,
  });
  if (composioFailed(r)) return [];
  return normalizeSlots(r?.data ?? r);
}

// ---- check_availability -----------------------------------------------------

function buildCheckAvailability(env: Env, ctx: CampaignToolsCtx): ToolDef {
  const tz = ctx.timeZone || DEFAULT_TZ;
  return {
    name: "check_availability",
    description:
      "Check the business owner's Google Calendar for free time slots within a date/time range, so you can offer the caller real available appointment times before booking.",
    kind: "composio",
    budgetClass: "availability",
    parameters: {
      type: "object",
      properties: {
        date_range: {
          type: "object",
          description: "RFC3339 window to search for free slots in.",
          properties: {
            start_iso: { type: "string", description: "Start of the search window, RFC3339, e.g. 2026-07-22T09:00:00+05:30" },
            end_iso: { type: "string", description: "End of the search window, RFC3339, e.g. 2026-07-22T19:00:00+05:30" },
          },
          required: ["start_iso", "end_iso"],
        },
      },
      required: ["date_range"],
    },
    async handler(args: any): Promise<ToolResult> {
      try {
        const dr = args?.date_range ?? {};
        const timeMin = String(dr.start_iso ?? "");
        const timeMax = String(dr.end_iso ?? "");
        if (!timeMin || !timeMax) {
          return { success: false, error_code: "bad_args", message: "date_range.start_iso and end_iso are required" };
        }
        let r: any;
        try {
          r = await executeTool(env, ctx.ownerUid, "GOOGLECALENDAR_FIND_FREE_SLOTS", {
            calendarId: "primary",
            timeMin,
            timeMax,
            timeZone: tz,
          });
        } catch (e) {
          if (isAuthError(e)) return { success: false, error_code: "authorization_failed" };
          return { success: false, error_code: "calendar_unavailable", message: e instanceof Error ? e.message : String(e) };
        }
        if (composioFailed(r)) {
          if (isAuthError(undefined, r)) return { success: false, error_code: "authorization_failed" };
          return { success: false, error_code: "calendar_unavailable", message: String(r?.error ?? "") };
        }
        const slots = normalizeSlots(r?.data ?? r);
        return { success: true, slots };
      } catch (e) {
        // Defensive last-resort — handler contract says never throw.
        return { success: false, error_code: "calendar_unavailable", message: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

// ---- book_appointment --------------------------------------------------------

function buildBookAppointment(env: Env, ctx: CampaignToolsCtx): ToolDef {
  const tz = ctx.timeZone || DEFAULT_TZ;
  return {
    name: "book_appointment",
    description:
      "Book a confirmed appointment on the business owner's Google Calendar at a specific start time. Only call this AFTER offering the caller a real free slot (via check_availability) and getting their agreement — never invent a time.",
    kind: "composio",
    budgetClass: "booking",
    parameters: {
      type: "object",
      properties: {
        start_iso: { type: "string", description: "Confirmed appointment start time, RFC3339, e.g. 2026-07-22T15:00:00+05:30" },
        duration_min: { type: "number", description: "Appointment length in minutes. Default 30." },
        notes: { type: "string", description: "Optional notes to attach to the appointment (what the caller wants, context from the call)." },
      },
      required: ["start_iso"],
    },
    async handler(args: any): Promise<ToolResult> {
      try {
        const startIso = String(args?.start_iso ?? "");
        if (!startIso) return { success: false, error_code: "bad_args", message: "start_iso is required" };
        const durationMin = Math.max(5, Math.min(480, Number(args?.duration_min) || 30));
        const notes = args?.notes ? String(args.notes).slice(0, 1000) : "";

        const who = ctx.contactName || "Contact";
        const summary = `${who} — appointment (via AvaTOK campaign call)`;
        const description = [
          `Booked automatically by the AvaTOK AI calling agent.`,
          `Campaign: ${ctx.campaignId}`,
          `Attempt: ${ctx.attemptUuid}`,
          `Contact: ${who}${ctx.contactE164 ? ` (${ctx.contactE164})` : ""}`,
          `Transcript: see call attempt ${ctx.attemptUuid} in the AvaTOK campaign inbox.`,
          notes ? `Notes: ${notes}` : "",
        ].filter(Boolean).join("\n");

        let r: any;
        try {
          r = await executeTool(env, ctx.ownerUid, "GOOGLECALENDAR_CREATE_EVENT", {
            calendar_id: "primary",
            summary,
            description,
            start_datetime: startIso,
            event_duration_hour: Math.floor(durationMin / 60),
            event_duration_minutes: durationMin % 60,
            timezone: tz,
            // See file-header note: extendedProperties is not in the verified
            // curated field list for CREATE_EVENT, but is passed as a
            // best-effort idempotency breadcrumb (Google's underlying API
            // supports it). The description above is the durable fallback.
            extendedProperties: { private: { avatok_attempt_uuid: ctx.attemptUuid } },
          });
        } catch (e) {
          if (isAuthError(e)) return { success: false, error_code: "authorization_failed" };
          if (isConflictError(e)) {
            const alternatives = await safeAlternatives(env, ctx.ownerUid, startIso, tz);
            return { success: false, error_code: "slot_taken", alternatives };
          }
          return { success: false, error_code: "calendar_unavailable", message: e instanceof Error ? e.message : String(e) };
        }

        if (composioFailed(r)) {
          if (isAuthError(undefined, r)) return { success: false, error_code: "authorization_failed" };
          if (isConflictError(undefined, r)) {
            const alternatives = await safeAlternatives(env, ctx.ownerUid, startIso, tz);
            return { success: false, error_code: "slot_taken", alternatives };
          }
          return { success: false, error_code: "calendar_unavailable", message: String(r?.error ?? "") };
        }

        const eventId = r?.data?.id ?? r?.data?.eventId;
        return { success: true, event_id: eventId ? String(eventId) : undefined, when: startIso };
      } catch (e) {
        return { success: false, error_code: "calendar_unavailable", message: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

// Best-effort "next 2 free slots" lookup for a slot_taken response — a search
// window starting at the attempted time, extending 7 days out. Never throws;
// an empty array is an acceptable degraded result (the agent still gets a
// structured slot_taken it can act on, just without suggestions).
async function safeAlternatives(
  env: Env, ownerUid: string, fromIso: string, timeZone: string,
): Promise<Array<{ start: string; end: string }>> {
  try {
    const from = new Date(fromIso);
    const start = isNaN(from.getTime()) ? new Date() : from;
    const end = new Date(start.getTime() + 7 * 86_400_000);
    const slots = await findFreeSlots(env, ownerUid, start.toISOString(), end.toISOString(), timeZone);
    return slots.slice(0, 2);
  } catch {
    return [];
  }
}

// ---- entrypoint ---------------------------------------------------------------

/**
 * Build the ToolDef[] for one campaign call attempt. Returns [] when booking
 * is disabled (either the campaign didn't enable it, or upstream determined
 * the owner has no ACTIVE googlecalendar connected_account — that gating
 * check per §10 happens before this is called, not inside it).
 */
export function buildCampaignTools(env: Env, ctx: CampaignToolsCtx): ToolDef[] {
  if (!ctx.bookingEnabled) return [];
  return [buildCheckAvailability(env, ctx), buildBookAppointment(env, ctx)];
}
