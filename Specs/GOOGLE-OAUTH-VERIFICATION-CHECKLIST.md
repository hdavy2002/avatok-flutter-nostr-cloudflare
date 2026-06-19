# Google OAuth App Verification — AvaTOK submission package

**Goal:** get AvaTOK's OAuth app approved so users can connect Google apps (Calendar,
Drive, Docs/Sheets, Gmail) without the "unverified app" warning. One-time, done by us
in the Google Cloud Console. Date: 2026-06-18.

> What's already live: OAuth client exists (`GOOGLE_CLIENT_ID`/`SECRET`), redirect
> `https://api.avatok.ai/api/calendar/gcal/callback`, already requesting
> `calendar.events` + `drive.file` (`worker/src/cal/gcal.ts`).

---

## 1. The three tiers (this decides cost + time)

| Scope | What it's for | Google class | Review needed |
|---|---|---|---|
| `drive.file` | store/open files the app creates in the user's Drive | **Non-sensitive** | **None** — works today, no review |
| `calendar.events` | read/write the user's calendar | **Sensitive** | Brand + demo video + justification. No security audit. |
| `documents` / `spreadsheets` (Docs/Sheets) | read/write user docs | **Sensitive** | Same as above (no audit) |
| `gmail.readonly` | "find me my email" (read) | **Restricted** | **CASA security assessment** — Tier 3 pen test, **$$$ + weeks + annual re-validation** |

**The Gmail lever (important):** `gmail.readonly` is *restricted* (full CASA pen test,
typically thousands of $/yr). Per current Google docs, **`gmail.modify` is classified
*sensitive* (CASA Tier 2)**, which is far cheaper/faster — and it still lets Ava *read*
mail (it's read + write minus permanent delete). **Confirm the classification in the
Console**, but if it holds, requesting `gmail.modify` instead of `gmail.readonly` keeps
Gmail in the cheap "sensitive" lane and avoids the Tier-3 audit.

**Recommended phasing:**
- **Phase 1 (submit now):** `drive.file` (no review) + `calendar.events` + Docs/Sheets →
  one **sensitive** verification (video + justifications, no audit). Unlocks Calendar +
  Docs + Drive for all users in ~days–weeks.
- **Phase 2 (when you decide Gmail is worth it):** add the Gmail scope and the CASA
  assessment. This is the long/expensive pole — don't let it block Phase 1.

---

## 2. OAuth consent screen — exact values to enter

Cloud Console → APIs & Services → **OAuth consent screen** (User type: **External**, Publishing status: **In production**).

- **App name:** AvaTOK
- **User support email:** support@avatok.ai
- **App logo:** *(you provide — 120×120 px PNG, no rounded corners; must match the AvaTOK brand)*
- **Application home page:** https://avatok.ai
- **Privacy policy URL:** https://avatok.ai/privacy  *(confirm exact path — the legal pages are live)*
- **Terms of service URL:** https://avatok.ai/terms  *(confirm exact path)*
- **Authorized domains:** `avatok.ai`
- **Developer contact email:** *(your dev email, e.g. hdavy2005@gmail.com)*

**Must be true before submitting:**
- The domain `avatok.ai` is **verified in Google Search Console** under the *same* Google account that owns this Cloud project.
- The privacy policy is **publicly reachable** at the URL above and **hosted on `avatok.ai`**.
- The OAuth client's **Authorized redirect URI** includes `https://api.avatok.ai/api/calendar/gcal/callback` (add any others you use).

---

## 3. Privacy policy — required Google language

Your privacy policy must (a) disclose that the app accesses/uses Google user data, and
(b) include the **Limited Use** statement verbatim (Google checks for this):

> "AvaTOK's use and transfer to any other app of information received from Google APIs
> will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
> including the Limited Use requirements."

It should also state, per scope: what data is accessed (calendar events, Drive files the
app creates, Docs/Sheets, Gmail messages), why, that it is **not** sold or used for ads,
and how users revoke access.

---

## 4. Per-scope justifications (paste into the Verification Center)

- **`drive.file`** — "Ava stores and opens only the files the user creates or selects
  within AvaTOK (e.g. saving a chat attachment to their Drive). We never access other
  Drive files."
- **`calendar.events`** — "Ava reads and creates calendar events on the user's request
  (e.g. 'add this to my calendar', booking confirmations). Access is initiated by the
  user and limited to event management."
- **`documents` / `spreadsheets`** — "Ava reads and edits documents/sheets the user
  explicitly asks it to work with (e.g. 'summarize this doc', 'add a row'). Used only in
  direct response to the user's request."
- **`gmail.modify` (Phase 2)** — "Ava reads and organizes the user's email on request
  (e.g. 'find me the email from my landlord', 'label these'). We do not permanently
  delete mail. Data is processed transiently to answer the user and is not stored,
  sold, or used for advertising."

---

## 5. Demo video (required for sensitive/restricted)

Record one **unlisted YouTube** video showing, for each requested scope:
1. The **OAuth consent screen** — must visibly show **"AvaTOK"** as the app name, and the
   **browser address bar must show your OAuth client ID** (zoom so it's legible).
2. The user **granting** the scope.
3. The feature **using** that scope in the app (e.g. connect Calendar → Ava creates an
   event; connect Docs → Ava summarizes a doc; connect Gmail → "find my email" returns a
   result). Show the *in-app* usage in detail, not just the grant.

Paste the unlisted link into the YouTube field in the Verification Center.

---

## 6. Submit

Cloud Console → **APIs & Services → OAuth consent screen → Verification Center** →
declare all scopes → attach justifications + the video → confirm policy compliance →
submit. Sensitive-only review is typically days–weeks; **CASA (Gmail) adds weeks + cost**.

---

## 7. What I (code) do once you're approved — no further Console work

- Add the approved scopes to the OAuth request in `worker/src/cal/gcal.ts` (today it
  requests `calendar.events drive.file`; I add `documents spreadsheets` and, in Phase 2,
  the Gmail scope), behind a `GOOGLE_SCOPES_TIER` flag so we expand exactly when approved.
- Build the per-user **connect / disconnect / green-dot** flow in AvaApps on top of the
  existing encrypted token store (`GCAL_TOKEN_KEY`).
- Wire `@ava find my email` to the Gmail REST call once Gmail is approved.

## 8. What I need from you to finalize this doc
1. **Logo** PNG (120×120) for the consent screen.
2. Confirm the **exact privacy policy + terms URLs** on avatok.ai.
3. Confirm **avatok.ai is verified in Google Search Console** under the project's Google account.
4. Decision: **Gmail now (CASA) or Phase 2?** (My recommendation: submit Calendar + Docs +
   Drive now; do Gmail/CASA as a deliberate Phase 2.)
