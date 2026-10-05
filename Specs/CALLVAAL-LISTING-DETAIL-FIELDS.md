# Listing detail shell and field registry

Canonical design/form reference for issue **CALLVAAL-DETAIL-1**. Updated 2026-10-05.

This document records the implemented Dr. Ananya concept and the intended contract for future category-specific listing forms. The keys below are a design registry, **not an implemented API, database schema, registration form or verification service**. Requiredness describes the future published listing contract where known; unresolved requirements are marked TBD. The current route is static and all personal details, availability, qualifications, badges, ratings, reviews, prices and conversation counts are illustrative.

The public identity comes from `Specs/brand.json` → `homepageIdentity`. Do not duplicate the brand name or domain in category schemas, forms or page copy.

## Common visual shell

All categories retain the same look and feel: shared header and responsive footer, cream background, plum text, yellow heading underlines, lilac content cards, scrapbook notes, identity hero, gallery, reviews and call/booking controls. The desktop layout has a main content column and sticky booking rail. The mobile layout stacks the content, includes compact section anchors and a fixed price/Call now bar with safe-area spacing. Content sections, category-specific fields and appropriate qualifications vary by category; the surrounding presentation stays common.

Implemented sources:

- `web/src/components/callvaal/Header.astro` and `Footer.astro`: permanent shared chrome used by both the homepage and `Base.astro` pages. Nested-page links resolve back to homepage anchors; footer categories resolve to a validated homepage category filter. Default auth navigation follows the existing cookie/guest-session hint through `html[data-site-auth]`, without a Clerk island: signed-out visitors see Sign in; signed-in visitors see My account and Sign out. Explicit `in`/`static` modes and hidden auth CTAs are respected. `chrome=false` and the existing app embed mechanism hide chrome when required. Embedded mobile profiles retain an in-flow price and Call now button when the fixed browser CTA is hidden.
- `web/src/styles/callvaal-chrome.css`: shared typography, navigation, responsive footer and accessible menu styling.
- `web/src/pages/people/dr-ananya.astro`: sample doctor detail content.
- `web/src/styles/callvaal-detail.css`: responsive detail presentation.
- `web/src/components/callvaal/profileDetail.ts`: non-live interactions.
- `web/src/lib/callvaalHomeReference.ts`: homepage sample profile with a detail route.

Do not copy this page per category and let the shell drift. Future forms should map category data into these common sections; extract a typed reusable detail renderer when the second real category implementation establishes the required differences. Such a renderer and forms are not implemented by this issue.

## Ownership and evidence rules

**User-entered** means supplied by a future listing owner, with moderation/validation as appropriate. **Admin/verification** means supplied or approved by a verification process; a user must never be able to self-assert a verified badge. **System-derived** means calculated from platform records or operational state, never entered as promotional copy. Current samples are authored static fixtures, regardless of the future owner listed below.

No current field establishes a real professional credential, service availability or client outcome. Do not turn sample values into live claims during wiring. Reviews and conversation counts must come from real records, not owner-entered marketing fields.

## Shared field registry

| Key | Type | Requiredness | Future source/owner | Display location | Current status |
| --- | --- | --- | --- | --- | --- |
| `id` | string | Required | System-derived | Route/interactions | Static `dr-ananya` |
| `slug` | string | Required for public detail | System-derived/validated | `/people/{slug}` | Static `dr-ananya` |
| `categoryId` | category enum | Required | User-entered, validated | Breadcrumb/homepage filtering | Static `doctors` |
| `displayName` | string | Required | User-entered | Hero, About heading, CTA previews | Sample `Dr. Ananya` |
| `roleLabel` | string | Required | User-entered; credentials subject to verification | Hero/homepage card | Sample `General physician` |
| `portrait` | image asset + alt text + dimensions | Required for this design | User-entered upload; moderated | Hero, first gallery image, share metadata | Existing illustrative `portrait-1.png` |
| `languages` | language enum array | Required; allowed values TBD | User-entered | Hero facts | Sample Hindi, English |
| `experienceYears` | nonnegative integer | Optional; category rules TBD | User-entered claim; evidence requirements TBD | Hero facts/About | Sample 5+ years |
| `personalQuote` | short string | Optional | User-entered, moderated | Lilac quote panel | Sample quote below |
| `about` | plain text | Required | User-entered, moderated | About card | Sample paragraph below |
| `topicTags` | string/controlled-key array | Optional; vocabulary TBD per category | User-entered from approved topics | About chips | Four sample doctor tags |
| `services` | plain-text/controlled-key array | Required for this design; live rules TBD | User-entered, moderated | How I can help/Services | Six sample doctor services |
| `gallery` | array of image asset, alt text, dimensions | Optional beyond portrait | User-entered, consent checked/moderated | Gallery/lightbox | Three illustrative images |
| `ratePerMinute` | money amount + currency | Required if paid calling enabled | User-entered proposed rate; platform validation/approval TBD | Desktop rail/mobile sticky CTA | Sample INR 25; no charging |
| `availabilityStatus` | enum | Required when live calling enabled | System-derived | Online badge | Illustrative `Online now` |
| `nextAvailableAt` | timestamp with timezone | Optional | System-derived from availability | Booking rail | Illustrative `4:30 PM`; no date/timezone or scheduling authority |
| `verification.registry` | category-specific registry key | Conditional on regulated category | Admin/verification | Hero badge/rail | Illustrative NMC |
| `verification.status` | status enum; live values TBD | Required before any real badge | Admin/verification | Badge and explanatory disclosure | `illustrative`; no registry check completed |
| `rating.average` | number | Only when review evidence exists | System-derived | Hero/review summary | Sample 4.8 |
| `rating.count` | nonnegative integer | Only when review evidence exists | System-derived | Hero/review summary | Sample 42 |
| `conversationCount` | nonnegative integer | Optional | System-derived | Hero fact | Sample 120 people |
| `reviews` | review array | Optional | Reviewer submission + moderation; rating aggregation system-derived | Reviews cards | Two fictional reviews; no submission UI |
| `reviews[].displayName` | privacy-safe string | Required for displayed review | Reviewer identity rules/system; TBD | Review card | Riya S.; Amit K. |
| `reviews[].rating` | bounded number | Required for rated review | Reviewer submission | Review stars | Sample 5/5 each |
| `reviews[].body` | plain text | Required for displayed text review | Reviewer submission, moderated | Review card | Sample text below |
| `reviews[].publishedAt` | date/timestamp | Required for displayed date | System-derived | Review card | Sample February 2024 dates |
| `preparationTips` | array of title/body/icon key | Optional; category-specific | Admin/editorial; user extensions TBD | Before you call | Three doctor preparation cards |
| `serviceDisclosure` | plain text/policy reference | Required for sample; live policy TBD | Admin/editorial | Under hero/CTA preview | Sample and non-live disclosure |
| `privacyBenefits` | approved platform copy | Only when supported by platform | Admin/editorial backed by system behavior | Booking rail | Illustrative private-number/safe-space copy |
| `isSample` | boolean | Required | System/admin | Noindex, disclosure, interactions | `true`; all calls/bookings are previews |

## Doctor content and category fields implemented now

All values in this section are static sample content. The NMC badge is labeled illustrative in accessible text and the visible disclosure; it is not evidence of a registry lookup.

| Field key | Type / requirement | Source | Current displayed content and location |
| --- | --- | --- | --- |
| `doctor.specialtyLabel` | string; required for this sample | Future owner-entered, verified where applicable | General physician — hero |
| `doctor.experienceYears` | integer; optional pending evidence policy | Future owner-entered claim | 5+ years experience — hero; over 5 years in About |
| `doctor.registry` | enum; conditional before a real verification badge | Future admin/verification | NMC — illustrative hero badge and rail |
| `doctor.registrationEvidence` | private verification record; schema TBD | Admin/verification | **Not collected, stored or displayed**; future only |
| `personalQuote` | string; optional | Future user-entered | “I believe in simple, practical advice for a healthier, happier you.” — quote panel, attributed to Dr. Ananya |
| `about` | text; required | Future user-entered | Dr. Ananya is a general physician with over 5 years of experience in preventive and primary care. She focuses on listening carefully, explaining things in simple language, and helping you make informed choices about your health. |
| `topicTags` | string array; optional | Future user-entered approved topics | Preventive care; Lifestyle & nutrition; Common illnesses; Health guidance |
| `services` | string array; required for this design | Future user-entered, scope moderated | General health consultations; Lifestyle & diet guidance; Fever, cold, cough and common illnesses; Second opinion on diagnosis; Medication guidance (non-prescription advice); Health check-up planning |
| `gallery` | image array; optional | Future user-entered, moderated | Portrait; `doctor-notes.png`; `doctor-consultation.png` — Gallery and accessible lightbox |
| `preparationTips.questions` | title + body; editorial | Admin/editorial | Keep your questions ready — Jot down your symptoms or concerns to make the most of your call. |
| `preparationTips.reports` | title + body; editorial | Admin/editorial | Have relevant reports handy — Lab reports or previous prescriptions can be useful. |
| `preparationTips.quietPlace` | title + body; editorial | Admin/editorial | Find a quiet place — For a better and more private conversation. |
| `reviews[0]` | review object; optional | Future reviewer/system | Riya S., 12 Feb 2024, five stars: Very patient and explains things so well. Felt comfortable and got helpful advice. |
| `reviews[1]` | review object; optional | Future reviewer/system | Amit K., 3 Feb 2024, five stars: Listened carefully and gave practical suggestions. Highly recommend! |
| `doctor.emergencyDisclaimer` | policy text/reference; required before live medical use | Admin/editorial | **Future field/section, not implemented.** Must explain that this is not emergency/crisis care and direct urgent cases to appropriate local emergency care; exact approved wording/location TBD. |
| `doctor.consultationScope` | approved scope keys + explanation; required before live use | Admin/editorial + verified professional scope | Second-opinion/report-explanation and general educational guidance scope. The current sample explicitly offers a second opinion and non-prescription medication guidance; report explanation is an existing homepage doctor topic, not a new live workflow. Future form must make scope explicit. |

Medical framing: no cure, diagnosis-accuracy or health-outcome guarantees. The quote describes an intention, not a promised outcome. Do not infer prescribing permission from the mock. Do not add medication ordering, emergency handling, medical-record uploads, guaranteed diagnosis or automatic NMC verification when connecting forms. Eligibility, consent, regulated scope, evidence handling and the emergency disclaimer require separate reviewed implementation before live use. No medical records are collected by this sample.

## Shared feature registry

| Feature | Current implementation | Future wiring boundary |
| --- | --- | --- |
| Navigation | Shared header/footer, mobile menu with expanded state/Escape, footer disclosure groups, nested-route-safe links and cookie-derived auth navigation | Preserve the original homepage footer contract: All categories, Find your person, How it works and Join & earn link to homepage anchors; Contact us uses the centrally configured support email. The nine Explore category buttons filter in place on the homepage and navigate to its validated category filter from other routes. All other footer labels open concept-preview dialogs, including policy/help labels; legacy routes are not represented as published policies for this concept service. |
| Profile discovery | Homepage portrait/name/primary action for Dr. Ananya open `/people/dr-ananya`; other profiles keep existing previews | Real listing routing/search contracts TBD |
| Save | Per-visit in-memory button toggle and polite status | No persistence, account write or saved-list backend; future storage must be per-account |
| Share | Web Share when available, clipboard fallback and selectable clean profile URL | No messages sent automatically; no incoming query/hash copied |
| Gallery | Responsive image helpers, native dialog, previous/next and arrow keys, Escape/close, focus restoration | Upload pipeline and media moderation not included |
| Section navigation | About/Services/Reviews/Gallery anchors on mobile; native See more/See less disclosure for the final two About tags | No category form or data API implied |
| Call now | Desktop rail/mobile bar open truthful preview dialog | No call, phone-number lookup, payment or metering write |
| Book a time | Preview dialog only | No availability lookup, appointment, checkout or notification |
| Reviews | Static illustrative cards and aggregate | No review form or fabricated production aggregate |
| Responsiveness | Grid/flex/media queries; touch controls at least 44px; sticky desktop rail/mobile CTA; safe-area padding; reduced-motion support | Browser/build verification is separate from this source-only implementation |
| Accessibility | Semantic headings/sections, named controls, visible focus, dialog focus management, descriptive image text, illustrative verification labels | Validate with assistive technology before launch |
| Analytics | Existing capture helper; fixed actions, sample profile/category/section identifiers, boolean state/photo index | Never send search input, report content, contacts or other form PII in these UI events |
| Search indexing | Static route explicitly requests `noindex` through Base | Reassess only when real approved content exists |

## Category extension placeholders

Every category below inherits the shared field registry and common shell. **Only the doctor sample is implemented.** Candidate category-specific fields below are intentionally undefined placeholders: no qualification, certification, allowed practice, eligibility or backend support is asserted. Field names, types, requiredness, validation, sources and display positions need a separate category specification before any form is built.

### Legal (`legal`)

| Field set | Type / requiredness | Owner/source | Display | State |
| --- | --- | --- | --- | --- |
| Shared registry | As above | User/admin/system as above | Common shell | Design contract only |
| `legal.*` | TBD | TBD; credentials must be admin/verification-owned | Category content blocks TBD | Define later |

### Tax & money (`tax`)

| Field set | Type / requiredness | Owner/source | Display | State |
| --- | --- | --- | --- | --- |
| Shared registry | As above | User/admin/system as above | Common shell | Design contract only |
| `tax.*` | TBD | TBD; credentials must be admin/verification-owned | Category content blocks TBD | Define later; preserve existing homepage exclusion of stock/crypto tips |

### Career & workplace (`career`)

| Field set | Type / requiredness | Owner/source | Display | State |
| --- | --- | --- | --- | --- |
| Shared registry | As above | User/admin/system as above | Common shell | Design contract only |
| `career.*` | TBD | TBD | Category content blocks TBD | Define later |

### Counsellor (`counsellor`)

| Field set | Type / requiredness | Owner/source | Display | State |
| --- | --- | --- | --- | --- |
| Shared registry | As above | User/admin/system as above | Common shell | Design contract only |
| `counsellor.*` | TBD | TBD; credentials must be admin/verification-owned | Category content blocks TBD | Define later; do not infer clinical or crisis capabilities |

### Listener (`listener`)

| Field set | Type / requiredness | Owner/source | Display | State |
| --- | --- | --- | --- | --- |
| Shared registry | As above | User/admin/system as above | Common shell | Design contract only |
| `listener.*` | TBD | TBD | Category content blocks TBD | Define later; preserve existing non-clinical, non-therapy, non-crisis framing |

### Astrology (`astrology`)

| Field set | Type / requiredness | Owner/source | Display | State |
| --- | --- | --- | --- | --- |
| Shared registry | As above | User/admin/system as above | Common shell | Design contract only |
| `astrology.*` | TBD | TBD | Category content blocks TBD | Define later; no outcome guarantees |

### Relationships & marriage (`relationships`)

| Field set | Type / requiredness | Owner/source | Display | State |
| --- | --- | --- | --- | --- |
| Shared registry | As above | User/admin/system as above | Common shell | Design contract only |
| `relationships.*` | TBD | TBD | Category content blocks TBD | Define later |

### Practice (`practice`)

| Field set | Type / requiredness | Owner/source | Display | State |
| --- | --- | --- | --- | --- |
| Shared registry | As above | User/admin/system as above | Common shell | Design contract only |
| `practice.*` | TBD | TBD | Category content blocks TBD | Define later |

## Next implementation boundary

When building category forms, update this file first with the approved category fields and evidence policy, map each field to the common sections, and preserve the user/admin/system ownership separation. Decide the real API and storage contract independently; none is created here. Keep private verification evidence and user reports out of public fields and analytics. Replace sample metrics only with authoritative data, and retain noindex/sample disclosure until the route truly represents an approved live listing.
