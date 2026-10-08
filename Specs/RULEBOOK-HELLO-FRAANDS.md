# Hello Fraands — Site Rulebook

**Owner:** Davy · **Started:** 2026-10-08 · **Status:** living document

This is the single record of what we decided for Hello Fraands, what we have
built so far, and what is still waiting. Every time the owner adds, changes or
drops a rule, it is recorded here **in the same change**, with a line in the
Change log at the bottom. Nothing is deleted silently: a dropped rule is marked
`DROPPED` with the date and reason, so we can always see what was first planned
and what was done.

> **For AI agents:** read this file before touching any Hello Fraands page,
> policy, help article, call flow, wallet or safety feature. If your change needs
> a rule that is not here, ask the owner and add it here in the same commit.
> Never write the brand name or domain in code — use `Specs/brand.json`.

### How to read a rule

Each rule has an ID (`HF-<area>-<n>`), the rule itself, and three status marks:

| Mark | Meaning |
|---|---|
| **Decision** | `ADOPTED` (owner decided) · `PROPOSED` (suggested, owner has not decided) · `DROPPED` |
| **Pages** | what the public website says today: `DONE` · `TODO` · `N/A` |
| **Backend** | whether the system actually does it: `DONE` · `TODO` · `N/A` |

The backend is not built yet (Oct 2026). Public pages describe how the service
works; the backend must be built to match these rules before calls go live.

---

## 1. Product and positioning

| ID | Rule | Decision | Pages | Backend |
|---|---|---|---|---|
| HF-PROD-1 | Brand is **Hello Fraands** at hellofraands.com (from 2026-10-08). Earlier names CallVaal, Aum Fe (aumfe.com), Saa Thum (saathum.com) are retired; never shown on the site. | ADOPTED | DONE | N/A |
| HF-PROD-2 | India only: Indian numbers, UPI, Indian KYC, Indian languages. | ADOPTED | DONE | TODO |
| HF-PROD-3 | One product: "talk to someone" — real people, per-minute phone calls, mood-based (exam ki tension, can't sleep, naye dost, bas baat…). No service categories. | ADOPTED | DONE | TODO |
| HF-PROD-4 | Friendship and "regulars" (calling the same host again) is part of the offer — but it is friendship, never romance. See HF-WELL-5. | ADOPTED | DONE | TODO |
| HF-PROD-5 | Not therapy, counselling, crisis line, dating, adult chat or professional (medical, legal, money) advice. Said on the home page, FAQ, help centre and terms. | ADOPTED | DONE | N/A |
| HF-PROD-6 | 18+ only, for callers and hosts. | ADOPTED | DONE | TODO (caller age gate, see HF-WELL-10) |

## 2. How calls work

| ID | Rule | Decision | Pages | Backend |
|---|---|---|---|---|
| HF-CALL-1 | We are a **switch**: the host's phone rings first with a private announcement (caller handle, past call count). Host presses 1 to accept, 2 to decline; 10 s silence = decline. Only then the caller is dialled, and the two calls are joined through a platform number. | ADOPTED | DONE | TODO (Vobiz PSTN) |
| HF-CALL-2 | Neither person ever sees the other's real phone number. | ADOPTED | DONE | TODO |
| HF-CALL-3 | No app needed: calls come to the normal phone number. Wallet, favourites and history live on the website. | ADOPTED | DONE | TODO |
| HF-CALL-4 | Either person can hang up any time. **#** at any time ends the call, blocks the other person and reports the incident. | ADOPTED | DONE | TODO |
| HF-CALL-5 | Both people hear a short **safety notice** before connecting (not a recording notice). Proposed wording: *"This is a friendly chat, not counselling. In crisis, dial 14416."* | ADOPTED (wording PROPOSED) | DONE (wording in terms) | TODO |

## 3. Privacy and recording

| ID | Rule | Decision | Pages | Backend |
|---|---|---|---|---|
| HF-PRIV-1 | **No call recording. No stored call audio. No transcripts.** | ADOPTED | DONE (all policy pages updated 2026-10-08) | TODO |
| HF-PRIV-2 | **No human monitors or listens** to live calls. | ADOPTED | DONE | N/A |
| HF-PRIV-3 | We keep only call metadata: account IDs, time, duration, price, how the call ended (person or safety action). | ADOPTED | DONE | TODO |
| HF-PRIV-4 | We keep a **safety log** without audio: AI flags, welfare flags, crisis numbers shown, strikes, blocks — each with a time. This is our proof that the safety system worked. | PROPOSED | TODO | TODO |
| HF-PRIV-5 | We never sell personal data. Legal name, Aadhaar details and phone number are never shown to the other person. | ADOPTED | DONE | TODO |

## 4. AI safety and spam

| ID | Rule | Decision | Pages | Backend |
|---|---|---|---|---|
| HF-AI-1 | AI follows every live call and understands **intention**, not keywords. No word triggers. | ADOPTED | DONE | TODO |
| HF-AI-2 | AI ends the call automatically on harassment, abuse, threats, sexual pressure, or scams (OTP, UPI PIN, card, bank, Aadhaar, "verify" links, fake bank/police/courier, loans, investments, remedies). | ADOPTED | DONE | TODO |
| HF-AI-3 | Spammers and scammers are blocked **across the whole platform**; repeat attempts from new accounts are matched and blocked. | ADOPTED | DONE | TODO |
| HF-AI-4 | The platform never asks for OTP, UPI PIN, password or bank details — on any channel. | ADOPTED | DONE | N/A |
| HF-AI-5 | Women-only lane: AI is tuned so health and intimate-wellness talk, or describing a bad experience, is never treated as misconduct. | ADOPTED | DONE | TODO |
| HF-AI-6 | Self-harm mentions are **never a strike** — they go to welfare follow-up (HF-WELL-2). | ADOPTED | DONE | TODO |

## 5. Conduct

| ID | Rule | Decision | Pages | Backend |
|---|---|---|---|---|
| HF-CON-1 | No sexual or suggestive talk. Only exception: a genuine health conversation with a host who has consented to that topic (shown on the profile), e.g. women-only lane or a host listing sexual-health discussion. Explicit or erotic talk is never allowed. | ADOPTED | DONE | TODO |
| HF-CON-2 | Not allowed: abuse, threats, gaali; sharing or asking for numbers, WhatsApp, Instagram, UPI IDs; meeting; selling anything; asking for money or payment outside the platform; recording the other person. | ADOPTED | DONE | TODO |
| HF-CON-3 | Hosts choose and publish the topics they consent to talk about. | ADOPTED | DONE | TODO |
| HF-CON-4 | Strikes: AI flags and reports are reviewed by the team before a strike is confirmed. 3 confirmed strikes = permanent ban. Threats, sexual harassment or fraud can mean an immediate ban. AI never bans on its own. | ADOPTED | DONE | TODO |
| HF-CON-5 | A banned account cannot make calls or re-register with the same number, but **can still sign in and withdraw its wallet balance to UPI**. Wallet money is never forfeited as a penalty. | ADOPTED | DONE | TODO |

## 6. Women's safety

| ID | Rule | Decision | Pages | Backend |
|---|---|---|---|---|
| HF-WOM-1 | Women's safety is the main design goal: masked numbers, verified hosts, AI ends abusive calls, # ends and blocks instantly. Payment never buys permission to cross a boundary. | ADOPTED | DONE | TODO |
| HF-WOM-2 | Women-only lane: only women talk to women; hidden from everyone else. **Both** caller and host must pass video KYC **and** Aadhaar KYC showing they are women before the lane appears. | ADOPTED | DONE | TODO |

## 7. Money

| ID | Rule | Decision | Pages | Backend |
|---|---|---|---|---|
| HF-PAY-1 | Prepaid talk-time wallet, topped up by UPI. Rates from ₹5/min (general-lane floor); host sets own rate, shown before the call. | ADOPTED | DONE | TODO |
| HF-PAY-2 | Billing per started minute of connected time. Ringing, decline, timeout, failed connection = ₹0. Need 2 minutes of balance to start. Max 60 min per call, warning ~60 s before the end. Balance never goes negative. | ADOPTED | DONE | TODO |
| HF-PAY-3 | **No refunds for connected calls.** We are not responsible for a caller's experience with a particular host. | ADOPTED | DONE | N/A |
| HF-PAY-4 | Billing errors (charged for a call that never connected, double charge) are corrected back to the wallet — this is not a refund. | ADOPTED | DONE | TODO |
| HF-PAY-5 | Unused wallet balance is always the user's: withdraw to own UPI ID any time (also after a ban, before deleting the account). | ADOPTED | DONE | TODO |
| HF-PAY-6 | Platform share per minute: ₹2 + 40% of the amount above ₹2, 18% GST included in the platform share. ₹5 → host ₹1.80; ₹10 → ₹4.80; ₹20 → ₹10.80; ₹30 → ₹16.80. Host earnings paid to a UPI ID in the host's own name. Payout minimum and timing not decided. | ADOPTED | DONE | TODO |
| HF-PAY-7 | **Daily spending limit** for callers, and an "Are you sure?" step on large top-ups (money trouble is a risk factor). Amounts to be decided. | PROPOSED | DONE (described as coming at launch) | TODO |

## 8. Wellbeing, mental health and attachment (added 2026-10-08)

The risk: a caller in a low state, or one who becomes attached to a host, is
refused or blocked and harms himself — and police or family blame the platform
or the host. We cannot remove this risk, but we must be able to show that we
took reasonable care, every time, with records. A disclaimer alone is not enough.

| ID | Rule | Decision | Pages | Backend |
|---|---|---|---|---|
| HF-WELL-1 | Crisis numbers are visible on every key page and in every help area: **Tele-MANAS 14416** (free, 24×7) and **112**. We are not an emergency service. | ADOPTED | DONE | N/A |
| HF-WELL-2 | **Welfare detection:** when AI hears hopelessness or self-harm talk, it (a) plays a short message with 14416 and 112 during the call, (b) sends the same by WhatsApp after the call, (c) writes a welfare entry in the safety log. Never a strike. | PROPOSED | TODO | TODO |
| HF-WELL-3 | **A block is never shown as a rejection.** A blocked or limited caller only ever sees "This host isn't available right now." The host's name is never attached to a refusal. | PROPOSED | DONE (described: /wellbeing, terms, help, FAQ) | TODO |
| HF-WELL-4 | **Attachment detection:** AI and usage patterns flag a caller who calls the same host daily, long late-night calls, rising spend, or talk of love / "I can't live without you". | PROPOSED | DONE (described in host guide) | TODO |
| HF-WELL-5 | **Healthy-use limits on one host:** a daily minutes cap with the same host and a cooling-off gap; a gentle reminder that hosts offer friendly conversation, not relationships. The platform — not the host — ends the pairing if it continues. Numbers to be decided. | PROPOSED | DONE (described as coming at launch; numbers TBD) | TODO |
| HF-WELL-6 | **Host welfare training** (with the scam training): warning signs, what to do, what never to do, attachment boundaries, how to flag. See Appendix A. | ADOPTED (content PROPOSED) | DONE (/hosts/crisis-script = Welfare & crisis guide; help article) | N/A |
| HF-WELL-7 | **No misguiding:** hosts give no medical, medicine, legal, money or relationship advice, and never keep a vulnerable caller on the line for money. Doing so is a removal offence in the host agreement. | ADOPTED | DONE (host guide + host agreement clause) | N/A |
| HF-WELL-8 | **Signup acknowledgement** (checkbox) for callers. Proposed text in Appendix B. | PROPOSED | DONE (text published in terms) | TODO |
| HF-WELL-9 | **Terms and host agreement clauses** on: platform only connects calls; hosts are independent; not a crisis line; user responsible for own decisions; platform may limit any account for its wellbeing; host follows welfare script and indemnifies breaches. Lawyer to review. | PROPOSED | DONE (terms, disclaimer, host agreement — lawyer review pending) | N/A |
| HF-WELL-10 | **Caller age gate:** callers confirm 18+ at signup; minors are suspended. (Hosts already KYC.) | PROPOSED | DONE (stated) / TODO (signup step) | TODO |
| HF-WELL-11 | **Welfare page** for users: "Using Hello Fraands in a healthy way" — limits, attachment, where to get real help. | PROPOSED | DONE (/wellbeing) | N/A |

## 9. Legal protection (business)

| ID | Rule | Decision | Pages | Backend |
|---|---|---|---|---|
| HF-LEG-1 | Register the Indian company **before calls go live**, so liability sits with the company, not the owner personally. Until then the site must not claim a company exists. | PROPOSED | N/A | N/A |
| HF-LEG-2 | Keep intermediary "due diligence" (IT Act s.79, IT Rules 2021): grievance officer, published rules, act on complaints. | ADOPTED | DONE (grievance, guidelines, intermediary pages) | TODO (complaint handling) |
| HF-LEG-3 | An Indian lawyer reviews the terms, host agreement, disclaimer and the wellbeing wording before launch. Ask about abetment-of-suicide exposure and a police-response plan. | PROPOSED | N/A | N/A |
| HF-LEG-4 | Consider liability insurance once the company exists. | PROPOSED | N/A | N/A |

## 10. Hosts

| ID | Rule | Decision | Pages | Backend |
|---|---|---|---|---|
| HF-HOST-1 | Host onboarding: WhatsApp OTP → video KYC (Didit) → Aadhaar OTP → moods, languages, price, topics → go online. Own Indian number; the KYC'd WhatsApp number is the number calls come to. | ADOPTED | DONE | TODO |
| HF-HOST-2 | Regular host training on spam, scam and fraud calls (OTP asks, "KYC update", sextortion, emotional money stories). | ADOPTED | DONE | N/A |
| HF-HOST-3 | Hosts go online/offline any time and may decline any call. Never ask callers for money outside the platform (removal). | ADOPTED | DONE | TODO |

## 11. Site design and pages (added 2026-10-08)

| ID | Rule | Decision | Pages | Backend |
|---|---|---|---|---|
| HF-SITE-1 | The help centre uses the **old "help skin v2" design** (terracotta hero, photo topic tiles, plum FAQ band, white panels, rail + on-this-page). Do not re-skin it. Only the art and copy are Hello Fraands; header/footer are the shared site ones. | ADOPTED | DONE | N/A |
| HF-SITE-2 | Old Aum Fe pages are **archived, not deleted** (kept for reuse): /rituals, /shop, /temples, /pandit, /guides, /desk, /watch, /book, /free-videos, /marketplace/page. Archived = URL still works, noindex, out of sitemap and menus (`web/src/lib/archivedPages.ts`). Archived pages wear the **Hello Fraands header and footer** — never the old brand's logo or menus (owner 2026-10-08, HF-ARCHIVE-RESKIN-1). | ADOPTED | DONE | N/A |
| HF-SITE-3 | /marketplace stays live and will be **re-skinned** for Hello Fraands. What it should list is to be confirmed. | ADOPTED | DONE (/marketplace = Explore: all hosts, mood/language/price/online filters, same cards as home; real cards replace samples later) | TODO |
| HF-SITE-4 | All other pages (content/legal pages, FAQ, wellbeing) get the **same full-width, responsive treatment as the front page**. Mock first, owner approves, then exact rollout. | ADOPTED | DONE (all HelloFraandsPage content/legal pages, FAQ, wellbeing) | N/A |
| HF-SITE-5 | Logged-in dashboard: give it the **new-look shell now** (front-page width, fonts, colours, menu); real Hello Fraands screens (wallet, favourites, call history, host earnings) are built when the backend is ready. | ADOPTED | DONE (shell: palette, fonts, width, logo, menu: Explore hosts, Favourites, Wallet, Billing, Profile) | TODO |
| HF-SITE-6 | **One standard type size on every page, matching the front page.** Root font size is a fixed 16px everywhere (no growing on wide monitors), header and footer are identical on every page, and no text is smaller than 14px. Never make tiny fonts. | ADOPTED | DONE (HF-TYPE-SCALE-1: global root fixed, help centre labels 11–13px → 14px, home/explore card labels → 14px, /talk-safely uses the shared header/footer) | N/A |
| HF-SITE-7 | **Two fonts only: Nunito for headlines, Comfortaa for everything else** (body, links, buttons, labels, forms). No Instrument Sans, Baloo, Kalam or other faces. Enforced in `web/src/styles/callvaal-chrome.css` (HF-FONTS-1). | ADOPTED | DONE | N/A |
| HF-NAV-1 | **Header must have "Explore" → /marketplace** (first item). | ADOPTED | DONE | N/A |
| HF-NAV-2 | **Every new public page gets a relevant link in the header or footer** in the same change (and the footer link-count checks in web/scripts are updated with it). Footer columns: Company · Hosts · Trust & Safety · Legal & Payments · Explore. | ADOPTED | DONE (so far) | N/A |

---

## Implementation plan — public pages first (backend not ready)

**Phase 1 — public pages (can do now):**

1. **Host welfare training** — expand `/hosts/crisis-script` into a full welfare
   and attachment guide (Appendix A). Link from host rules, join page and the
   help article on rude/scam callers. → HF-WELL-6, HF-WELL-7
2. **Wellbeing page for users** — new `/wellbeing` page ("use it in a healthy
   way"), linked from the footer, safety centre, FAQ and help. → HF-WELL-11
3. **Terms, disclaimer and host agreement clauses** — add the wellbeing,
   not-a-relationship, independent-host and no-misguiding clauses; mark for
   legal review. → HF-WELL-7, HF-WELL-9
4. **Publish the signup acknowledgement and pre-call notice text** in the terms
   and FAQ so it is on record before the backend shows it. → HF-WELL-8, HF-CALL-5
5. **Help centre** — new articles: "Hosts are friends, not partners",
   "Healthy limits and cooling-off", "For hosts: spotting distress and
   attachment". Add matching FAQ entries. → HF-WELL-3/4/5/6
6. **Mark planned features honestly** — daily caps and spend limits are
   described as "coming with launch", not as live.

**Phase 2 — backend (later, build to these rules):** safety log (HF-PRIV-4),
welfare detection (HF-WELL-2), block-as-unavailable (HF-WELL-3), attachment
detection and limits (HF-WELL-4/5), spend limit (HF-PAY-7), signup checkbox and
age gate (HF-WELL-8/10), pre-call notice (HF-CALL-5).

**Phase 3 — business:** company registration (HF-LEG-1), lawyer review
(HF-LEG-3), insurance (HF-LEG-4).

---

## Appendix A — Host welfare training (draft content)

**Warning signs of distress:** "No one will miss me", "I won't be here
tomorrow", saying goodbye, giving things away, talk of a method or a date,
sudden calm after deep sadness, "you are the only reason I am alive".

**What to do:** stay calm and kind · listen, don't argue · don't counsel or
diagnose · don't promise to keep it secret · give **Tele-MANAS 14416** and
**112** · flag the call as a welfare concern after it ends.

**Signs of attachment:** calls you every day, wants only you, says "I love you",
asks for your number, photo or meeting, gets angry when you are offline, spends
far more than before.

**What to do:** never flirt or say "I love you too" · never promise "I'll always
be there" · never share contact details or meet · keep it friendly and general ·
flag the caller early — **the platform limits or ends the pairing, not you**,
and he only sees "host not available".

**Never:** give medical, medicine, legal, money or relationship advice · keep a
caller on the line for money · encourage dependence.

## Appendix B — Proposed wording (for lawyer review)

**Signup checkbox (callers):** "I understand Hello Fraands is friendly
conversation, not counselling, therapy or a relationship service. Hosts are
independent people and are not mental-health professionals. If I am in crisis I
will call Tele-MANAS 14416 or 112. I am 18 or older."

**Pre-call spoken notice:** "This is a friendly chat, not counselling. In
crisis, dial 14416."

**Limit message:** "This host isn't available right now. You can talk to someone
else, or come back later."

---

## Change log

| Date | Change |
|---|---|
| 2026-10-08 | HF-SITE-7 added (owner): Nunito for headlines, Comfortaa for all other text on every page (HF-FONTS-1). |
| 2026-10-08 | Sign in / Sign up pages: old Ganesh, lotus and Suswagatam artwork replaced with Hello Fraands art (friendship collage, notebook + chai) on cream/lilac panels; old "Creator Marketplace" and "Light a diya" text replaced (HF-AUTH-ART-1). |
| 2026-10-08 | HF-SITE-2: archived pages (/free-videos, /pandit, /temples, /guides, /shop) re-skinned with the Hello Fraands header and footer; old logo and menus gone (HF-ARCHIVE-RESKIN-1). |
| 2026-10-08 | HF-SITE-6 added (owner: one standard font size like the front page). Help/blog/dashboard pages no longer grow header, footer and text on wide monitors; tiny labels raised to 14px; /talk-safely got the real header/footer (HF-TYPE-SCALE-1). |
| 2026-10-08 | Full-width front-page look rolled out to content pages, FAQ and wellbeing (HELLO-FRAANDS-WIDE-1); /marketplace re-skinned as Explore (HELLO-FRAANDS-EXPLORE-1); header "Explore" + footer "Explore all hosts" added, HF-NAV-1/2 recorded; dashboard new-look shell (HELLO-FRAANDS-DASH-SHELL-1). |
| 2026-10-08 | Section 11 added. Help centre restored to the old help skin v2 design with Hello Fraands art/copy (HELLO-FRAANDS-HELP-RESTORE-1); old Aum Fe pages archived (HELLO-FRAANDS-ARCHIVE-1). Site-wide front-page treatment, marketplace re-skin and dashboard shell pending owner approval of mocks. |
| 2026-10-08 | Footer: added "Help centre" (/help) to the Company column (HELLO-FRAANDS-FOOTER-HELP-1). |
| 2026-10-08 | Owner decision: limit numbers (daily minutes with one host, cooling-off gap, daily spending cap) are deliberately left open for now — pages keep saying they will be published before launch. Do not invent numbers. (HF-WELL-5, HF-PAY-7) |
| 2026-10-08 | Phase 1 public pages for wellbeing done (HELLO-FRAANDS-WELL-1): new /wellbeing page; /hosts/crisis-script expanded into the Welfare & crisis guide (footer label renamed); wellbeing, healthy-use-limit and acknowledgement clauses in terms; not-a-relationship/crisis section in disclaimer (Hindi recording text fixed); wellbeing duties in host agreement; 2 help articles; 4 FAQ entries. Backend items unchanged (TODO). Limit numbers still to be decided by owner. |
| 2026-10-08 | Rulebook created. Sections 1–7, 9–10 record decisions already made and shipped on the public site (FAQ, policy pages, help centre deployed 2026-10-08). Section 8 (wellbeing) added from the owner's mental-health concern; most items PROPOSED pending owner decisions on numbers. |
