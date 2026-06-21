# AvaApps — In-Chat Action Cards · Design Brief

A designer/AI brief for the cards AVA renders inside the chat when a user asks
for things like "what's new in my inbox" or "what's my calendar today". This is
a **design spec only** — content slots and buttons are described abstractly.
Data wiring (Composio/Klavis) happens later; the designer never needs it.

---

## 0. The surface (shared shell)

Every result renders as a full-width **card bubble** on the left, from AVA.

- **Header strip:** sparkle + `AVA · PRIVATE` (tiny, uppercase, muted).
- **Lead line:** one bold human sentence summarizing the result
  ("Good news — you have a completely open schedule today.").
- **Context pill:** a dark rounded chip with an icon + summary
  (`INBOX · 5 EMAILS`, `SUN · JUN 21 · 0 EVENTS`).
- **Body:** one or more item cards, or an empty/hero state.
- **Action row(s):** buttons (see button system below).
- **Timestamp:** bottom-right, muted.

Visual language to reuse: thick rounded outlines, soft drop-shadow, lavender
card background, lime = go, pink = stop, mint = positive/done.

---

## 1. Card families (only three to design)

Everything reduces to three reusable archetypes. Design these once; the rest are skins.

1. **Digest card** — a lead line + context pill + a stack of item rows. (Inbox list, Calendar day.)
2. **Item card** — one object with its own mini action row. (One email, one event.)
3. **Result chip** — a compact confirmation that replaces a card/button after an action. ("Replied ✓", "Event added").

Plus two overlays:

4. **Compose sheet** — inline editor for reply / new email / new event.
5. **Loading / empty / error** states for each card.

---

## 2. Button system (design tokens)

Four button intents, used consistently across all cards:

| Intent | Look | Meaning | Examples |
|---|---|---|---|
| **Primary** | Solid lime, dark text, icon-left | the main forward action | View, Reply, Schedule a meeting, Join |
| **Secondary** | White fill, dark outline | neutral / alternative | Open in calendar, Reminder, Block focus, Draft |
| **Destructive** | Soft pink fill, ⊘/🗑 icon | removes or rejects | Spam, Delete, Decline |
| **Positive/status** | Mint text or pill, ✓ icon | confirms / done / free | Clear, RSVP Yes, success chips |

Rules for the designer:
- Max **3 buttons** in an item-card action row; overflow goes in a "⋯ More" menu.
- Exactly **one** primary per row.
- Destructive buttons never sit first; keep them right-aligned.
- Buttons are large, thumb-friendly, full-width-stacked on narrow phones.

---

## 3. Inbox Digest card

**Purpose:** answer "what's new in my inbox".

**Slots**
- Lead line (e.g. "Here are your 5 latest emails — one needs a look.")
- Context pill: inbox icon + count.
- Stack of **Email item cards** (§4).
- Optional footer: "Load more" (secondary) + "Mark all read" (secondary).

**States**
- *Populated:* list of email items.
- *Empty:* hero "Inbox zero" mint panel with checkmark.
- *Loading:* 3 skeleton rows.
- *Error:* "Couldn't reach Gmail" + Retry (secondary).

---

## 4. Email Item card

**Purpose:** one email, actionable.

**Slots**
- Avatar (sender initial in a colored circle).
- Sender name (bold) + sender address (muted, small).
- **Attention badge** (top-right): e.g. `ACTION` (red) or `UNREAD` (neutral) — show only when relevant.
- Subject (bold, 1 line, truncates).
- Snippet (muted, 2 lines, truncates with "…").
- Attachment chip (paperclip + filename) — only if present.

**Action row**
- **View** (primary) · **Spam** (destructive) · **Delete** (destructive).
- Optional **Reply** (primary) when expanded — swap View→Reply on tap.

**After an action:** row collapses into a **Result chip** ("Moved to spam", "Deleted", "Replied ✓") with an "Undo" link where it makes sense.

---

## 5. Calendar Day card

**Purpose:** answer "what's my calendar today".

**Slots**
- Lead line (changes by state: "Good news — completely open" vs "You've got 3 things today").
- Context pill: calendar icon + date + event count.
- **Hero state block (open day):** big mint panel, checkmark, "Open day / No scheduled events — you're free."
- **OR Event list:** stack of **Event item cards** (§6) for a busy day.
- **"Checked across N calendars" section:** small uppercase label + a list of **Calendar rows**.

**Calendar row (per source calendar)**
- Colored dot (calendar's color).
- Calendar name or address (truncates).
- Optional badge: `PRIMARY` or `SHARED` (small, muted, pill).
- Right side: status — **CLEAR** (mint ✓) when that calendar is empty, or a small count when not.
- (Row may be tappable to filter to that calendar.)

**Action row (footer)**
- **Schedule a meeting** (primary, full-width).
- **Block focus** (secondary) · **Reminder** (secondary).

**States**
- *Open day:* mint hero + all calendars CLEAR.
- *Busy day:* event list; calendars show counts.
- *Loading:* skeleton hero + 4 ghost calendar rows.
- *Error:* "Couldn't check your calendars" + Retry.

---

## 6. Event Item card

**Purpose:** one event, actionable. (For busy days.)

**Slots**
- Time block (left rail): start–end, big; "All day" variant.
- Title (bold).
- Location chip (pin icon) — if present.
- Attendee avatars (stacked) + your RSVP state dot.
- Source-calendar color stripe/dot.

**Action row**
- **Join** (primary) — only if a video link exists.
- **Reschedule** (secondary) · **RSVP** (positive/destructive toggle) · "⋯ More" → Open in calendar, Delete.

---

## 7. Compose sheet (reply / new email / new event)

Inline expanding panel (not a separate screen).

**Reply / email slots:** To (chip), Subject (for new only), Body (multiline), attach button. Footer: **Send** (primary) · **Save draft** (secondary) · **Cancel** (text).
**New event slots:** Title, Date/time pickers, Duration, Location, Attendees (chips), toggles for "Add video call" / "Notify guests". Footer: **Create** (primary) · **Cancel**.

**On success:** sheet collapses to a Result chip.

---

## 8. Result chip (post-action)

Compact, replaces the button/row that triggered it.
- Icon (✓ mint for success, ⊘ for removed) + short label.
- Optional **Undo** (text link) for ~5s.
- Error variant: red, short reason + Retry.

---

## 9. State checklist (design every card for all of these)

For each card type, deliver: **Loading** (skeleton), **Empty / hero**, **Populated**,
**Success-after-action** (result chip), **Error + Retry**. Plus light/dark if relevant.

---

## 10. What to hand the AI generator

> "Design a set of mobile chat 'action cards' for an AI assistant named AVA.
> Style: rounded thick-outline cards, lavender card background, lime-green primary
> buttons, soft-pink destructive buttons, mint-green success/positive states, bold
> friendly type. Produce: (1) an Inbox Digest card with Email item cards, (2) a
> Calendar Day card with an open-day hero state and a 'checked across N calendars'
> list with per-calendar status, plus a busy-day variant with Event item cards,
> (3) a reply/compose sheet, (4) result confirmation chips, and (5) loading/empty/
> error states for each. Follow the button intent system: one primary per row, max
> three buttons, destructive right-aligned."
