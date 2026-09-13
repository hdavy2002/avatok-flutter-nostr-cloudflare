# avaTOK — third-party entity anchors (copy-paste pack)

Purpose: give Google's Knowledge Graph three independent sources that all say the same thing about **avaTOK (avatok.ai)**, so "avatok" stops being confused with avatok.tech (industrial conductors) and the old AvaTok avatar-video app. Every field below matches `web/src/lib/org.ts` and the FAQ now live on avatok.ai/about — keep them identical everywhere; consistency is the signal.

When each profile is live, send me the URL and I'll add it to `sameAs` in org.ts (one line, deploys site-wide).

Contact email for every sign-up: team@avatok.ai (forwards to the owner's Gmail via the avatok.ai catch-all).

---

## 1. LinkedIn Company Page  (linkedin.com/company/setup/new)

| Field | Value |
|---|---|
| Name | avaTOK |
| LinkedIn public URL | linkedin.com/company/avatok |
| Website | https://avatok.ai |
| Industry | Technology, Information and Internet |
| Company size | 2–10 employees |
| Company type | Privately Held |
| Founded | 2025 |
| Headquarters | Mumbai, Maharashtra, India |
| Tagline (120 chars max) | Apna hunar. Apni kamaai. — India's creator marketplace for paid live streams and 1:1 video sessions. |
| Logo | web/public/app-logo2.png (the teal A on white; same file the site's schema uses) |

**About (description):**

avaTOK (avatok.ai) is an Indian creator marketplace for paid live streaming and paid 1:1 video sessions. Creators publish a listing — a live event, a private session, a conversation, a skill they can teach — people book or join it, and the creator gets paid. Built in India, for India, founded by three friends in India, working from Mumbai.

Earn from home: create a free listing and get paid to host live streams, run 1:1 video consultations, be a home friend, listen, or teach what you know. Book: browse the marketplace, join a live event, or book a creator's time in a slot they've opened on their calendar. 1 token = ₹1.

avaTOK is currently at the ideation and testing stage (invite-only). Not related to avatok.tech or to any avatar/selfie-video app that shares the name.

Contact: support@avatok.ai · YouTube: youtube.com/@avatok

Optional: your personal LinkedIn already names you as CTO of AvaTok.ai, which ties your name to the brand publicly. If you want to stay anonymous, consider removing or hiding that experience entry; do not link it to the new company page.

---

## 2. Crunchbase organization profile  (crunchbase.com/add-new → Organization)

| Field | Value |
|---|---|
| Organization name | avaTOK |
| Website | https://avatok.ai |
| Short description (one line) | Indian creator marketplace for paid live streaming and 1:1 video sessions. |
| Full description | Same as the LinkedIn "About" above. |
| Headquarters | Mumbai, Maharashtra, India |
| Founded date | 2025 |
| Company type | For profit |
| Operating status | Active |
| Industries | Marketplace; Live Streaming; Creator Economy; Video; Internet |
| Founders | leave blank |
| Contact email | team@avatok.ai |
| LinkedIn | (the page from step 1) |
| YouTube | https://www.youtube.com/@avatok |
| Logo | app-logo2.png |

Founders are deliberately not named anywhere public.

Leave "legal name" blank for now — the Indian company is not yet registered, and the site's legal pages say so. Add "Ava Global International Pvt Ltd" the day the CIN is issued (and tell me, so org.ts gets `legalName` in the same change).

---

## 3. Wikidata item — DONE: https://www.wikidata.org/wiki/Q141409718 (created 2026-09-10)  (wikidata.org/wiki/Special:NewItem)

Honest caveat first: Wikidata items with no independent references sometimes get deleted for notability. Create the LinkedIn and Crunchbase profiles **first**, then cite Crunchbase as the reference on each statement — that usually survives. Google reads Wikidata heavily for knowledge panels, so it is worth the ten minutes.

| Field | Value |
|---|---|
| Label (en) | avaTOK |
| Description (en) | Indian online marketplace for paid live streaming and one-to-one video sessions |
| Aliases | AvaTOK; AvaTok; avatok.ai |

**Statements** (search each property by name; Wikidata autocompletes):

| Property | Value |
|---|---|
| instance of (P31) | online marketplace (Q3390477) — add a second value: website (Q35127) |
| official website (P856) | https://avatok.ai |
| country (P17) | India |
| inception (P571) | 2025 |
| headquarters location (P159) | Mumbai |
| YouTube channel ID (P2397) | the channel's UC… id (YouTube Studio → Settings → Channel → Advanced) |
| Crunchbase organization ID (P2088) | the slug from your Crunchbase URL, e.g. `avatok` |
| LinkedIn company ID (P4264) | the slug from the LinkedIn URL, e.g. `avatok` |
| language of work or name (P407) | English; Hindi |

Reference on each statement: "reference URL" = the Crunchbase page (or avatok.ai/about for the definitional ones), plus "retrieved" = today's date.

---

## 4. Optional, later

- **Google Play listing public** — once out of Closed Alpha, the store page becomes a fourth anchor; I'll add it to `sameAs` then.
- **Google Business Profile** — needs the US office address and postcard/video verification; gives a map-style panel for US searchers.
- **Instagram** — send me the handle and it goes into `sameAs` now.

What NOT to do: don't create a Wikipedia article (it will be deleted and that hurts), and don't write "Ava Global International Pvt Ltd" anywhere public until it exists.
