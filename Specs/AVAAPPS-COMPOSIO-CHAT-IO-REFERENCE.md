# AvaApps — Composio I/O Reference for In-Chat Cards

**Purpose:** map the inputs/outputs of the Composio actions behind common
user intents ("what's new in my inbox", "get my today's schedule") so the
chat-card UI (buttons, badges, fields) can be designed against real field names.

**Source:** Composio toolkit docs — Gmail (`GMAIL`, v20260506_01, 63 tools) and
Google Calendar (`GOOGLECALENDAR`, v20260429_00, 49 tools).
https://docs.composio.dev/toolkits/gmail · https://docs.composio.dev/toolkits/googlecalendar

**Universal envelope:** every Composio action returns the same wrapper. Design
your renderer once around this, then bind per-action fields inside `data`:

```json
{
  "data":       { /* action-specific payload — see below */ },
  "successful": true,
  "error":      null,
  "log_id":     "log_xxx"
}
```

Always render an error state for `successful:false` / `error != null`.

---

## 1. Intent: "What's new in my inbox" → `GMAIL_FETCH_EMAILS`

### Input (what you send)
| Field | Type | Notes — good defaults for the card flow |
|---|---|---|
| `query` | string | Gmail search syntax. `is:unread newer_than:1d` for "what's new". |
| `max_results` | int | Cards to show. Default 1; use 5–10. Max 500. |
| `label_ids` | string[] | e.g. `["INBOX"]`. |
| `include_spam_trash` | bool | Default false. |
| `verbose` | bool | `true` returns full `messageText` (needed for the View screen). |
| `ids_only` | bool | `true` = just IDs (cheap, for counts/badges). |
| `page_token` | string | For "load more". |
| `user_id` | string | Default `"me"`. |

### Output (what comes back) — each `messages[]` item = one card
```json
{
  "data": {
    "messages": [
      {
        "messageId": "18f...",
        "threadId": "18f...",
        "messageTimestamp": "2026-06-21T12:01:00Z",
        "labelIds": ["UNREAD", "INBOX", "IMPORTANT"],
        "sender": "AvaTOK Ops <noreply@avatok.ai>",
        "to": "hdavy2005@gmail.com",
        "subject": "Wallet recon mismatch — 2026-06-21",
        "preview": {
          "subject": "Wallet recon mismatch — 2026-06-21",
          "body": "AvaWallet reconciliation found 1 invariant violation..."
        },
        "messageText": "full plain-text body (only when verbose=true)",
        "attachmentList": [
          { "attachmentId": "...", "filename": "report.pdf", "mimeType": "application/pdf", "size": 20481 }
        ]
      }
    ],
    "nextPageToken": "0987...",
    "resultSizeEstimate": 12
  },
  "successful": true,
  "error": null
}
```

### Field → UI mapping
| Card element | Bind to |
|---|---|
| Avatar / sender name | `sender` (parse name vs `<email>`) |
| Subject (bold) | `subject` |
| Snippet (2 lines) | `preview.body` |
| Timestamp | `messageTimestamp` |
| "UNREAD" / "ACTION" badge | `labelIds` contains `UNREAD` / `IMPORTANT` |
| Attachment chip | `attachmentList.length > 0` |
| Hidden keys for buttons | `messageId`, `threadId` |

### Buttons → actions
| Button | Action | Required input |
|---|---|---|
| **View** | `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID` | `message_id` |
| **Reply** | `GMAIL_REPLY_TO_THREAD` | `thread_id`, `message_body` |
| **Spam** | `GMAIL_ADD_LABEL_TO_EMAIL` | `message_id`, `add_label_ids:["SPAM"]` |
| **Delete** | `GMAIL_MOVE_TO_TRASH` | `message_id` |
| **Archive** | `GMAIL_ADD_LABEL_TO_EMAIL` | `message_id`, `remove_label_ids:["INBOX"]` |

---

## 2. Intent: "Reply to this email" → `GMAIL_REPLY_TO_THREAD`

### Input
| Field | Type | Notes |
|---|---|---|
| `thread_id` | string ✅ req | from the card's `threadId` |
| `message_body` | string ✅ req | the reply text (user types in chat) |
| `recipient_email` | string | defaults to thread sender |
| `cc` / `bcc` | string[] | optional |
| `is_html` | bool | `true` to send HTML |
| `attachment` | file | optional |

### Output
```json
{ "data": { "id": "18g...", "threadId": "18f...", "labelIds": ["SENT"] },
  "successful": true, "error": null }
```
**UI:** on `successful:true` collapse the composer to a "Replied ✓" pill.

> **Draft instead of send** → `GMAIL_CREATE_EMAIL_DRAFT` (same fields + optional
> `thread_id`). Output: `data.id` (draft id) + `data.message.{id,threadId}`.
> Good for a "Review before sending" button.

---

## 3. Intent: "Send a new email" → `GMAIL_SEND_EMAIL`

### Input
| Field | Type | Notes |
|---|---|---|
| `recipient_email` | string ✅ req | |
| `subject` | string | |
| `body` | string | |
| `cc` / `bcc` | string[] | |
| `is_html` | bool | |
| `attachment` | file | |

### Output
```json
{ "data": { "id": "18h...", "threadId": "18h...", "labelIds": ["SENT"] },
  "successful": true, "error": null }
```

---

## 4. Intent: "Get my today's schedule" → `GOOGLECALENDAR_EVENTS_LIST`

> Alternative: `GOOGLECALENDAR_FIND_EVENT` (text search), or
> `GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS` (merge every calendar).
> To compute "today" reliably, call `GOOGLECALENDAR_GET_CURRENT_DATE_TIME` first.

### Input
| Field | Type | Notes — defaults for "today" |
|---|---|---|
| `calendarId` | string | `"primary"` |
| `timeMin` | RFC3339 | today 00:00 in user TZ |
| `timeMax` | RFC3339 | today 23:59 in user TZ |
| `singleEvents` | bool | `true` (expands recurring) |
| `orderBy` | string | `"startTime"` (requires singleEvents) |
| `maxResults` | int | e.g. 20 |
| `q` | string | optional text filter |
| `timeZone` | string | e.g. `Asia/Kolkata` |
| `pageToken` | string | "load more" |

### Output — each `items[]` = one event card
```json
{
  "data": {
    "items": [
      {
        "id": "abc123",
        "status": "confirmed",
        "summary": "Film tonight",
        "description": "Meet out front",
        "location": "PVR, MG Road",
        "start": { "dateTime": "2026-06-21T19:30:00+05:30", "timeZone": "Asia/Kolkata" },
        "end":   { "dateTime": "2026-06-21T21:30:00+05:30", "timeZone": "Asia/Kolkata" },
        "attendees": [
          { "email": "maya@hey.com", "responseStatus": "accepted" },
          { "email": "hdavy2005@gmail.com", "responseStatus": "needsAction", "self": true }
        ],
        "hangoutLink": "https://meet.google.com/xyz-abcd-efg",
        "htmlLink": "https://www.google.com/calendar/event?eid=...",
        "organizer": { "email": "maya@hey.com" },
        "creator":   { "email": "maya@hey.com" }
      }
    ],
    "nextPageToken": null,
    "timeZone": "Asia/Kolkata"
  },
  "successful": true,
  "error": null
}
```

### Field → UI mapping
| Card element | Bind to |
|---|---|
| Title | `summary` |
| Time row | `start.dateTime` → `end.dateTime` (format to local) |
| All-day handling | use `start.date` when `dateTime` absent |
| Location chip | `location` |
| Attendee avatars + RSVP | `attendees[].email` / `.responseStatus` |
| "Join" button (only if present) | `hangoutLink` |
| Your RSVP state | `attendees[]` where `self:true` |
| Hidden key for buttons | `id` |

### Buttons → actions
| Button | Action | Required input |
|---|---|---|
| **Join** | open `hangoutLink` | — |
| **Open in Calendar** | open `htmlLink` | — |
| **Reschedule** | `GOOGLECALENDAR_UPDATE_EVENT` | `event_id`, new `start`/`end` |
| **RSVP yes/no** | `GOOGLECALENDAR_UPDATE_EVENT` | `event_id`, attendee `responseStatus` |
| **Delete** | `GOOGLECALENDAR_DELETE_EVENT` | `event_id` |
| **Add event** | `GOOGLECALENDAR_CREATE_EVENT` | see §5 |
| **Find a free time** | `GOOGLECALENDAR_FIND_FREE_SLOTS` | `timeMin`, `timeMax` |

---

## 5. Intent: "Create / add an event" → `GOOGLECALENDAR_CREATE_EVENT`

### Input
| Field | Type | Notes |
|---|---|---|
| `calendar_id` | string | `"primary"` |
| `summary` | string ✅ | title |
| `description` | string | |
| `location` | string | |
| `start_datetime` | RFC3339 ✅ | |
| `event_duration_hour` / `event_duration_minutes` | int | OR pass an end time |
| `attendees` | string[] | emails |
| `timezone` | string | |
| `create_meeting_room` | bool | `true` adds a Google Meet link |
| `send_updates` | bool/string | notify attendees |
| `recurrence` | string[] | RRULE for repeats |

### Output
```json
{ "data": { "id": "newid", "summary": "...", "htmlLink": "...", "hangoutLink": "...",
            "start": {...}, "end": {...} },
  "successful": true, "error": null }
```

---

## 6. Quick reference — full intent → action table

| User says | Action(s) | Returns (cards from) |
|---|---|---|
| "what's new in my inbox" | `GMAIL_FETCH_EMAILS` | `data.messages[]` |
| "open / read this email" | `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID` | full body + headers |
| "reply" | `GMAIL_REPLY_TO_THREAD` | sent confirmation |
| "draft a reply" | `GMAIL_CREATE_EMAIL_DRAFT` | draft id |
| "send an email" | `GMAIL_SEND_EMAIL` | sent confirmation |
| "mark spam" | `GMAIL_ADD_LABEL_TO_EMAIL` (`SPAM`) | updated labels |
| "delete email" | `GMAIL_MOVE_TO_TRASH` | trashed confirmation |
| "show my labels/folders" | `GMAIL_LIST_LABELS` | `data.labels[]` |
| "today's schedule" | `GOOGLECALENDAR_EVENTS_LIST` | `data.items[]` |
| "what time is it / today" | `GOOGLECALENDAR_GET_CURRENT_DATE_TIME` | current datetime |
| "search calendar" | `GOOGLECALENDAR_FIND_EVENT` | `data.items[]` |
| "am I free at X" | `GOOGLECALENDAR_FIND_FREE_SLOTS` | busy/free ranges |
| "add event" | `GOOGLECALENDAR_CREATE_EVENT` | event id + link |
| "reschedule / move" | `GOOGLECALENDAR_UPDATE_EVENT` | updated event |
| "delete event" | `GOOGLECALENDAR_DELETE_EVENT` | deleted confirmation |

---

## Notes for the designer / generator
- **One renderer per output shape, not per action.** Gmail messages, Calendar
  events, and "confirmation" results are the only 3 card shapes you need.
- **Every action is two-phase:** a *list/read* response renders cards; each card
  button fires a *write* action that returns a small confirmation to swap in.
- **Always bind hidden IDs** (`messageId`/`threadId`, event `id`) so buttons have
  what they need without another round trip.
- Field availability depends on OAuth scopes granted at connect time.
- These are stable Composio action names; exact optional fields can be confirmed
  live with `composio execute <ACTION> --get-schema` or the dashboard playground.
