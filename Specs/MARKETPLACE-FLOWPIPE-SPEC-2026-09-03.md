# avaTOK Marketplace Flowpipe

**Status:** implementation specification  
**Scope:** creator listings, AI poster generation, admin approval, public poster cards, details, and in-card booking  
**Non-goal:** replace the existing Worker booking, wallet, auth, or email authorities

## 1. Product promise

A creator submits one structured listing. After approval, avaTOK turns the listing into a distinctive printed-film-poster card. The card tells the story visually and stays compact; **MORE INFO** opens the existing public listing details page. **BOOK NOW** stays in a modal and completes the correct booking path without losing state.

The poster is presentation, not a second source of truth. The listing record remains canonical for title, description, price, schedule, location, language, policies, capacity, and booking behavior.

## 2. User journeys

### Creator

1. Open Create Listing and complete the existing wizard.
2. Save every field as it changes; a draft can be resumed.
3. Submit for approval. The listing becomes `pending_review` and is not public.
4. Admin approves the listing content.
5. AI generates a poster draft from structured fields plus the creator's description.
6. Admin reviews poster crop, text legibility, safety, and factual accuracy.
7. Admin approves and publishes. The card appears in the marketplace and the listing is available at `/l/<id>` and its pretty URL when creator handle/slug exist.

### Buyer

1. Browse compact poster cards; do not show a wall of metadata.
2. Select **MORE INFO** to open the canonical details page.
3. Select **BOOK NOW**, **TALK NOW**, **RESERVE FREE**, or **CALENDAR** according to listing type.
4. Complete the flow inside a modal. Once checkout begins, the backdrop and escape/click-away dismissal are disabled; only the top-right X exits.
5. If unauthenticated, enter email, receive OTP, verify, then continue at the same step.
6. Resume from an autosaved incomplete checkout later, including from notifications/reminder email.
7. On success, show a downloadable ticket and send the ticket, receipt, and booking details by email.

## 3. Listing and poster states

Listing status is separate from poster status:

| Listing | Poster | Public behavior |
|---|---|---|
| `draft` | none/draft | creator only |
| `pending_review` | none | admin queue only |
| `approved` | `generating`/`draft` | not public |
| `approved` | `rejected` | not public; fix/regenerate |
| `published` | `approved` | marketplace + details page |
| `unpublished` | any | hidden, existing bookings preserved |

Publishing must reject missing required booking fields and must never publish an unapproved listing or poster.

## 4. Canonical data contract

Use the existing `Listing`/`Card` API shapes and extend only additively.

Required poster inputs: `id`, `title`, `description`, `kind`, `category`, `price`, `price_semantics`, `billing_unit`, `duration`, `schedule_mode`, `start/end` or availability, `location`, `language`, `capacity`, `adult_policy`, `house_rules`, creator identity, and poster prompt/style metadata.

Recommended additive fields:

- `approval_status`, `approved_at`, `approved_by`
- `poster_status`, `poster_asset`, `poster_version`, `poster_prompt_hash`, `poster_rejected_reason`
- `published_at`
- `checkout_draft_id` (client/server draft reference only; never payment authority)

Poster assets use the existing public upload/CDN pipeline. Store the asset reference and generation metadata, not base64 in D1.

## 5. Admin dashboard

Add a visible **Listings & Posters** area at `/admin/listings`, linked from the existing admin navigation and protected by `AdminGate`.

Queue views:

- Awaiting listing approval
- Poster generation/review
- Published/recently rejected

Actions:

- View full submitted listing
- Approve/reject listing with reason
- Generate/regenerate poster
- Approve/reject poster with reason
- Publish/unpublish
- View immutable audit history

Every action is server-authorized, idempotent, and audited with actor, timestamp, previous state, next state, and reason. Admin preview must show the exact public card and the full details-page data.

## 6. Poster/card design rules

- Poster-first visual: colored, film-poster-like artwork with varied palettes and period/genre typography.
- Printed white card paper treatment: crisp white border, dark offset shadow, rounded corners.
- The poster carries the story: title, scene, fictional/illustrative characters, slang, time, price, and mood may be rendered in artwork.
- Do not duplicate a long title/description block below the image on the compact card.
- Keep only essential compact controls on-card: status/time, favorite, primary booking action, **MORE INFO**, and optional share.
- Never rely on icon-only chips to communicate material information. Any metadata shown as chips remains text-visible, accessible, and limited to two rows.
- AI artwork must not imply a real celebrity, guarantee an outcome, or contradict listing data. Use fictional names/characters unless the creator supplied licensed assets.
- Preserve readable contrast and a legible fallback when image generation fails.

## 7. Details page

The existing `web/src/pages/l/[id].astro` and pretty `web/src/pages/[username]/[slug].astro` remain canonical. They fetch the created listing from the Worker and render the existing details component.

Acceptance requirements:

- A newly published listing appears with its real title, description, poster, price, schedule, location, language, policies, creator, reviews, and slots where available.
- `/l/<id>` remains permanently usable for shared links; redirect to pretty URL only when handle and slug are present.
- **MORE INFO** and share links resolve to the same listing, not mock data.
- Draft, rejected, and unpublished listings return the existing non-public behavior.

## 8. Booking modal state machine

`idle → selecting → auth_email → auth_otp → booking_context → payment/live/join → success | abandoned`.

Branch by listing contract:

- fixed date/time: confirm slot → mock Paytm/payment step → entitlement/ticket
- calendar: slot picker → hold/confirm → payment → success
- live now: live join entitlement → join pipeline
- free: confirmation/entitlement without payment
- AI agent/consult: duration/availability → existing consultation/agent booking path

The modal freezes the page while active. Draft state is debounced and namespaced per account/email. Closing with X marks the draft abandoned/resumable; it does not silently discard it. Payment and booking remain server-authoritative and idempotent.

## 9. Email, ticket, and reminders

On confirmed booking:

- create the existing booking/entitlement/ledger records;
- render a ticket with listing, buyer, date/time, duration, venue/join instructions, and booking ID;
- provide download in the success view;
- email ticket plus itemized receipt;
- retain delivery status and retry safely.

Incomplete checkout reminders are opt-in/configurable, deduplicated, and must never expose private listing or payment data in notification previews.

## 10. Phased implementation plan

### Phase 0 — Contract and safety baseline

- Freeze the existing listing/booking APIs as authorities.
- Document required fields and status transitions.
- Add feature flags for poster generation, poster-first cards, and in-modal checkout.
- Add telemetry events and server audit schema.

**Exit:** no behavior change for existing published listings; status transitions are tested.

### Phase 1 — Details-page data parity

- Verify create/update/publish responses contain every field used by details.
- Add/repair additive serialization only where missing.
- Add integration fixtures proving `/l/<id>` and pretty URLs render a newly published listing.

**Exit:** created listing data is visible on the existing details page without mock fallbacks.

### Phase 2 — Admin listing approval queue

- Add `/admin/listings` UI and Worker endpoints for queue, approve, reject, publish, and audit.
- Add role checks, idempotency, rejection reasons, and optimistic UI refresh.

**Exit:** admin can approve/reject/publish a listing end to end; unpublished data stays private.

### Phase 3 — Poster generation pipeline

- Add generation job/endpoint using the structured listing prompt.
- Persist asset/version/status metadata.
- Add admin poster review, regenerate, approve, reject.
- Add safe fallback poster and content-safety/factuality checks.

**Exit:** approved listing produces a reviewable poster draft; only approved poster + listing can publish.

### Phase 4 — Poster-first marketplace card

- Replace card artwork area with the approved poster asset.
- Add compact, two-row maximum text metadata.
- Rename secondary action to **MORE INFO** and retain details analytics target.
- Add share action using canonical listing URL.
- Preserve responsive sizing and accessible text fallbacks.

**Exit:** desktop and mobile cards remain compact, readable, varied, and link to real details.

### Phase 5 — Modal details and booking shell

- Build poster preview/modal shell with title/description and all long-form details inside More Info.
- Wire existing OTP, slot, live, fixed-date, free, consultation, and Paytm-mock components into one state machine.
- Freeze backdrop dismissal after checkout starts.

**Exit:** every listing lane reaches the correct existing booking pipeline without leaving the modal.

### Phase 6 — Autosave, resume, and notifications

- Persist debounced checkout drafts, scoped per account/email.
- Add resume links and notification/reminder surfaces.
- Add abandonment, resume, and conversion telemetry.

**Exit:** interrupted checkout resumes at the correct step and never leaks another account's data.

### Phase 7 — Ticket/email completion

- Generate downloadable ticket and itemized receipt.
- Send confirmation email with retry/delivery tracking.
- Add success, duplicate-submit, cancellation, and failure recovery states.

**Exit:** a successful booking produces a usable ticket and matching email receipt.

### Phase 8 — Hardening and rollout

- Accessibility, responsive, rate-limit, idempotency, and security review.
- Test AI failure, stale drafts, rejected posters, missing fields, expired slots, payment failure, and duplicate clicks.
- Stage rollout behind flags, review telemetry, then promote deliberately.

**Exit:** production checklist signed; rollback is one feature-flag change and listing APIs remain backward compatible.

## 11. Acceptance checklist

- No backend booking authority is duplicated in the card or modal.
- Every published listing has a real details page populated from its API record.
- Admin approval is required for both listing content and poster before publication.
- **MORE INFO** is the front-card label everywhere a details action appears.
- Poster failures fall back gracefully and never block access to details.
- Modal checkout cannot be lost through backdrop clicks or accidental navigation.
- Guest OTP, autosave, resume, ticket, email, receipt, and audit trails work.
- Existing deep links, creator pages, and current booking flows continue to work.
