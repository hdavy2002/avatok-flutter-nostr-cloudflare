# Plan — Dialpad business calls + Ava AI Voice Agent

**Date:** 2026-07-11 · **Status:** 🔒 FINAL — DESIGN LOCKED + GAP REVIEW (§15) + fourth-review engineering refinements applied in §13/§14 (`routing_decision`, routing-policy snapshot, `span_id`, `agent_profile_version`, `event_schema_version`, reason-code registry, append-only invariant, Guardian-on-raw-events, `call_aggregate` rename). Ready to build Phase A. · Owner: Humphrey

> **Locked 2026-07-11.** Grok Voice Agent pipeline; primary=Mode A / service=Mode B (bound,
> not chosen); refund matrix + escrow rules (§11); shared Agent Profiles (§12); event-sourced
> calls (§13); observability architecture with PII on Person Profiles only (§14). Remaining
> owner inputs are *values, not design*: `MIN_SERVICE_RATE` (proposed 20), the §11 timeout
> constants, the token→USD rate, and confirmation that the 3-token line fee lands with the
> platform (callee nets `rate−13`).

This is written in plain English. It first states the vision, then lists exactly what
gets built.

---

## 1. The big idea — two separate channels

AvaTok has two ways to reach someone. They are deliberately different.

- **Email = the friend channel.** You find people by email. You add them, chat like
  friends, and if you call them it's a friend-to-friend call. Miss their call? You can
  leave a voicemail that their *personal receptionist* handles.
- **AvaTOK number = the business channel.** You dial a number on the dialpad. This is a
  formal / business call. If the owner doesn't answer, it can be handled by an **Ava AI
  Voice Agent** that actually talks to the caller, answers questions, and can take a
  booking.

Think of it like: **email is your personal line, your AvaTOK number is your business
line.**

All AvaTOK calls are app-to-app (never the phone network / PSTN), so **we always know
who is calling** — there is no "unknown number."

---

## 2. What changes in the app (the friend channel)

- **New chat search becomes email-only.** In Messenger → New chat, remove "search by
  phone number." You add people by **email only**. That is the one, clear way to add a
  friend to chat.
- **A friend's AvaTOK number still shows on their profile.** Once you've added someone,
  their profile / contact card shows their AvaTOK (business) number too.
- **Every AvaTOK number in the app becomes tappable.** On a profile page or a shared
  contact card, tapping the number **drops it into the dialpad, ready to dial** (it does
  not auto-dial — the user still presses call). This is how the two channels connect:
  you meet by email, you can then call their business line.

---

## 3. The dialpad business call — step by step

This is what happens when someone dials an AvaTOK number on the dialpad.

1. **Liveness first (already built).** A first-time / unverified caller must pass the
   liveness check before the call is placed. The dialpad now goes through the server
   (`/api/call`), which both rings the callee AND runs the gate. ✅ done 2026-07-11.
2. **It looks like a phone call, not a chat.** Full-screen call UI (avatar/logo, name,
   call status, phone controls). It is NOT the messenger thread.
3. **The callee sees WHO is calling — by name.** Because it's app-to-app, we pull the
   caller's name and show *"[Name] is calling."* Never "Unknown caller." Options for the
   callee: **Accept · Decline · Send to Ava AI Agent · Block.**
4. **No answer → we behave like a phone carrier.** If nobody picks up:
   - **If the callee tapped "Send to Ava AI Agent" on the ringing screen:** the caller
     is handed to the Ava AI Voice Agent right then (see §4).
   - **If the callee has the AI Agent set to AUTO:** after **2 rings** the agent picks
     up automatically.
   - **If the callee declines the call, OR has no AI Agent set up:** the caller is sent
     to **voicemail** — after **5 rings** a voice plays inside the call: *"Hi, [Name]
     isn't available. Please leave a 25-second voicemail after the tone."* The caller
     records up to **25 seconds**, then the call disconnects automatically.
5. **Decline → the caller leaves a voicemail** (or can save the contact).
6. **Cost control (important).**
   - The Ava AI Voice Agent is **OFF by default.** It can only be turned on if the
     callee has **tokens in their wallet** (tokens are our internal currency, and the
     **callee pays** for agent minutes — deducted from their wallet).
   - So a stranger's call reaches the paid agent **only** when the callee explicitly
     enabled it (auto, or by tapping "Send to Ava AI Agent"). Everyone else gets the
     free 25-second voicemail. This protects the callee's spend.
   - **Anyone with the number can call** — it does not matter how the caller got it.
     The number being advertised in a group, on a card, wherever, is fine.

### No-answer card (agreed in §1 of the earlier discussion)
On no-answer, the caller stays on a **phone-style "No answer" card** — *Call again ·
Leave a voicemail · Save contact* — and only lands in Messenger if they explicitly
choose to send a text.

---

## 3B. NEW billing model — Paid calls (the caller pays the callee)

Until now the plan assumed the **callee pays** (their AI agent answers on their own
tokens). This adds a SECOND model: the callee can **charge the caller** a per-minute rate.
It works for **both a human callee and an AI voice agent.**

**There are now three call types. The callee chooses which one applies:**

| Type | Who pays | Example |
|---|---|---|
| **Free friend call** | Nobody | You call a friend (email channel) |
| **Callee-pays business call** | The callee | A shop's AI agent answers questions for free |
| **Paid call (NEW)** | The **caller** | A paid advice line, or a paid AI practice line |

### How a paid call works

1. Caller dials the number.
2. The callee has set a price (e.g. **10 tokens/min**) **and their own list of length
   options** (custom — the callee adds e.g. 15/45/60 min; there is no fixed ladder). BEFORE
   anyone connects, the caller's app shows Ava's price + the callee's length choices:
   *"This call costs 10 tokens per minute. Choose a length: 15 / 45 / 60 minutes."*
3. Caller **picks a length** (client-side selection, so the media path stays pure P2P).
4. **System checks the caller's wallet covers the FULL chosen length** (rate × minutes).
   Not enough → tell them, offer a shorter length or to top up. **Nobody is connected
   until the funds are confirmed and held.**
5. **Hold (escrow) the full amount** from the caller's wallet up front.
6. Connect:
   - **Human callee** → their phone actually rings; they talk.
   - **AI agent** → the agent starts.
7. **Meter per minute.** Each minute, out of the hold: **`rate − 10` tokens → the callee's
   wallet, `10` tokens → the admin (platform) wallet** as the platform fee.
8. **Beep tones** near the end warn the caller time is almost up.
9. At the time limit the call ends. **If it ended early, the unused hold is refunded** to
   the caller.

### Your two examples
- **(a) Paid person-to-person call** — someone offering paid advice / companionship sets a
  rate; the caller is told the cost, agrees, and talks to the person for the paid minutes.
- **(b) Paid AI agent** — e.g. a visa-interview practice agent with a rate; the caller
  agrees, talks to the agent, hears the end beeps, call finishes.

### Money flow (per minute)
- Caller pays **`rate`** tokens · **`rate − 10`** → callee wallet · **`10`** → admin wallet.
  (`rate` = what the callee added; the platform fee is **10 tokens/min** on top of / carved
  from that, per the 2026-07-11 decision.)
- In a **paid AI-agent call** the callee is **not also** charged the 6-token agent fee — the
  10-token/min platform fee taken from the caller covers Ava/Grok compute.
- **CONFIRMED: the 10-token platform fee is PER MINUTE** (settled each minute alongside the
  callee's `rate − 10`), not a one-time per-call fee.

### Reuses what we already have
- **Escrow** = the existing **ledger** (`ledger.ts` hold → settle per minute → refund
  unused) + the money engine. This is exactly what hold/refund was built for.
- **Duration prompt + length pick + end beeps** run **CLIENT-side** for the human P2P path
  (the caller's app renders the price/length screen from the callee's published rate, and
  each client plays its own end beeps) so no server audio touches the P2P media. The
  server-side voice bot (§7 build item 5) is only used where a bot is *already* a
  participant — voicemail and the AI agent.
- **Wallet** = the existing tokens wallet.

### Where the price is set
- **Human paid calls:** a "Paid call" toggle + rate in the callee's call settings.
- **Paid AI agent:** the rate lives in the Ava Business Agent settings.

### ⚠️ Compliance — needs a policy + legal pass before this goes live
Monetised person-to-person "companionship/comfort" calls, **plus tokens that represent
real money, plus minors on the platform**, together create real obligations:
- **Adults-only + age-gating** — these calls must be blocked for child accounts and only
  offered to verified adults. This ties directly into the liveness/age work.
- **Content moderation & trust-and-safety** — what services are allowed on the platform.
- **Payments / AML / payout rules** — if tokens cash out to real money, this is a
  regulated payments question.
- **Jurisdiction** — some paid services are illegal in some places.

Engineering can build the mechanism (escrow, metering, IVR). **What is allowed to run on
it is a policy decision, and this one genuinely needs review** — the same way §10 of the
identity spec needs counsel. Flagging it now so it's a deliberate choice, not a default.

---

## 4. Ava AI Voice Agent — the NEW thing to build

This is a **new, separate** pipeline from the existing Ava Receptionist. Keep them
distinct:

| | **Ava Receptionist** (exists) | **Ava AI Voice Agent** (new) |
|---|---|---|
| For | Friend / chat-thread calls | Business calls to your AvaTOK number |
| Job | Take a short message | Have a real conversation |
| Max length | ~2 minutes | Up to ~5 minutes |
| Knowledge | Just takes a message | Answers using the owner's uploaded documents (RAG) |
| Can it book? | No | Yes — takes a booking end to end |

**The agent does WHATEVER THE OWNER INSTRUCTED — it is not hard-wired to "take a
booking."** Booking is just one example. The owner writes the instructions; the agent is
smart enough to understand what the caller wants and act on it, using its tools.

**What the agent CAN do (driven by the owner's instructions):**

1. Greets the caller as the business.
2. Has a natural conversation (**Grok Voice Agent API** — §4).
3. **Answers questions from the owner's documents** (RAG / **Grok Collection `file_search`** — §5).
4. **Uses Composio connectors to act in the real world** (already wired). This is the key
   part: the agent is **Composio-aware** and decides which tool to use based on the
   conversation. Example instruction an owner might write:
   > *"When a caller asks about a room, check Supabase for which dates that room is
   > available and tell them. If they agree to a date, take the booking, block the room
   > in the DB, collect their name + email + phone, and email them the confirmation."*
   The agent must have the **brains to map the caller's intent to the right tool call**
   (check availability → confirm → write booking → email), not just answer trivia.
5. **Booking (one possible action, not mandatory):** collect details → write to the
   owner's system (Google Calendar / Supabase / whatever, via Composio) → email the
   caller a confirmation.
6. Wraps up within the ~5-minute cap.

**In engineering terms (UPDATED 2026-07-11 — Grok, not Gemini):** the agent is a **Grok
Voice Agent realtime session** (`wss://api.x.ai/v1/realtime?model=grok-voice-latest`). The
owner's instructions become the session `instructions` (the brain); the tools are the hands,
declared in one `session.update` `tools` array:
- **`file_search`** over the owner's Grok **Collection** = the RAG knowledge (replaces
  Cloudflare AutoRAG for the agent — see §5).
- **`mcp`** remote tools → this is how the owner's **email, calendar, and other app
  connectors** plug in (Composio exposed as an MCP endpoint, or Grok's own connectors).
- **custom `function`** tools (`create_booking`, etc.) — handled client-side by our Worker,
  which writes to Supabase/Calendar and emails the confirmation.
- **`web_search` / `x_search` are NOT enabled** (owner decision 2026-07-11) — the agent
  answers from the owner's Collection + connectors only. This removes the $5/1,000 search
  cost entirely.

The agent must have the brains to map caller intent → the right tool call (check
availability → confirm → write booking → email). Grok orchestrates that reasoning inside
the session; our Worker only executes the custom-function side effects.

### Why we switched to Grok (billing — verified 2026-07-11)

The owner is right that Gemini Live's cost climbs with call length: audio is a flat
~25 tokens/sec, but the Live API **re-bills the whole session context window every turn**
(prior turns + instructions + RAG chunks), so a long call reprocesses its history and cost
grows super-linearly; transcription adds text tokens on top. That is the reason for the
switch.

**Grok Voice Agent bills a flat ~$0.05 / minute of audio, voices included** — no per-turn
context re-billing — which makes the per-minute token price predictable. Our external cost,
after the owner's 2026-07-11 decisions, is deliberately minimal:
- **No Grok PSTN phone number** → **$0.01/min avoided.** Our calls are in-app P2P WebRTC, so
  the agent bridges audio over the realtime WebSocket directly. (When a callee wants a
  *separate* number per service, we hand out another **AvaTOK** number, never a Grok number —
  see "Multiple service numbers" below.)
- **No `web_search` / `x_search`** → **$5/1,000 avoided.**
- The only remaining per-use cost is **`file_search` (RAG) ≈ $2.50 / 1,000 calls**. So our
  effective external cost ≈ **$0.05/min + a little RAG.** Cap `max_num_results` to keep it
  tight; there is **no runaway context re-billing** to defend against.
- Sources: [x.ai Grok Voice Agent](https://x.ai/news/grok-voice-agent-api),
  [Grok Voice Agent Builder pricing](https://www.eesel.ai/blog/grok-voice-agent-builder-pricing).

### Memory + speed (simplified under Grok)

Because Grok's flat per-minute price removes the context-re-billing problem, the aggressive
Gemini caching layer is no longer load-bearing. What remains useful:

| Layer | Answers | Tech | Loaded when |
|---|---|---|---|
| **Knowledge** | "What does the business know?" | **Grok Collection** via `file_search` | retrieved per question by Grok |
| **Caller memory** | "Who is this caller?" | **mem0**, scoped to `(business, caller)` | loaded at call start → injected into `instructions`; written at call end |
| **Live facts** | "Frequent answers + tool results" | short-TTL KV cache (optional) | during the call |

- **Call start:** load the owner's agent config + the caller's mem0 memories for this
  business, and open the Grok session with `instructions` = owner rules + caller memory,
  `tools` = the Collection + the owner's MCP connectors + custom functions.
- **During call:** Grok drives `file_search` / connector calls itself. Our Worker only
  services custom-function calls (booking writes are never cached).
- **Call end:** write a mem0 summary for `(business, caller)`, AND save the full transcript
  as a messenger thread on the callee's side (§6).

mem0 stays because Grok Collections is *document* RAG, not per-caller conversational memory —
mem0 is what makes a returning caller feel remembered.

**Human P2P paid calls have no Grok in the loop** — this section only concerns AI-agent calls.

### The two agent billing modes (bound to the number kind — NOT chosen)

**There is no "pick a billing mode" toggle.** The mode is fixed by which *kind* of number it
is (resolves the earlier ambiguity, 2026-07-11):
- **Primary number → always Mode A.** (One per account, the identity number.)
- **Service number → always Mode B.** (Extra, caller-pays, advertised services.)

Both run on the **same Grok pipeline**; only *who pays* differs:

| Mode | Who pays | Rate | Cap | Use |
|---|---|---|---|---|
| **A — Callee-pays agent** (personal receptionist) | the **callee's** wallet | **6 tokens/min** | 5-min call | Runs on the account's **one primary number**. Answers the owner's own incoming calls (take a message, book, answer FAQs). |
| **B — Caller-pays agent** (paid service) | the **caller's** wallet | callee's `rate`; **10 tokens/min** → admin platform fee, `rate − 10` → callee (`− 3` more on a service number) | callee-set length | Runs on **additional service numbers** the owner advertises (e.g. visa-interview practice). Caller agrees to the price before connect; escrow up front (§3B). |

In Mode B the callee is **not** also charged the 6-token agent fee — the caller's 10/min
platform fee covers Grok compute. Both modes: no web search, no Grok phone number. **Mode A
is the single identity number; multiple numbers exist only in Mode B** (see below).

### The primary number vs service numbers (identity, no confusion)

**Decision 2026-07-11 — two clearly separated kinds of number:**

1. **The primary number (Mode A only).** Issued **once at signup**, free. This is the number
   that **represents the user's AvaTOK account to us** — the account's identity. There is
   exactly **one**, it is Mode A (callee-pays personal receptionist), and it is the number we
   key the account on everywhere. It is **never** a paid-service number.
2. **Service numbers (Mode B only).** A callee may add **additional AvaTOK numbers purely for
   caller-pays services** they want to advertise — e.g. one for **US-visa-interview practice**,
   one for **consultancy**. Rules:
   - **Multiple numbers are allowed ONLY in Mode B (caller-pays).** You cannot spawn extra
     Mode-A personal numbers — Mode A is the single identity number, full stop.
   - A **service number does NOT represent the account owner** — it identifies a *service*,
     not the person. This is deliberate so the account's identity always resolves to the one
     primary number and we never get confused about "which number is this user."
   - **Each service number costs 3 tokens/min**, billed to the **callee**, on the calls it
     handles — the "extra line" fee, **on top of** the Mode-B split. So per minute on a
     service number: caller pays `rate`; **10 → admin** (platform fee), **3 → admin/platform**
     (line fee), **`rate − 13` → callee**. *(Confirm the 3-token line fee lands with the
     platform, and that callee nets `rate − 13`.)*
   - **Always an AvaTOK number, never a Grok/PSTN number** — no $0.01/min telephony cost;
     it's just another in-app P2P line.
   - Each service number has its **own agent config** (instructions, docs/Collection, routing,
     rate + length options).

**Where the owner sets it up:** Account & Settings → Settings → **Ava Business Agent**.
- **Primary number (Mode A):** turn the receptionist on/off (gated on wallet tokens), write
  its instructions, upload its docs → its Collection, choose routing (auto-after-2-rings vs
  manual "Send to Agent" vs off). Billing is fixed to Mode A (6 tokens/min from the callee).
- **Add a service (Mode B):** creates a new AvaTOK service number (3 tokens/min in use) with
  its own instructions, docs/Collection, routing, and **caller-pays rate + length options**.

---

## 5. The knowledge pipeline (RAG) — what powers the agent's answers

The agent answers from the **owner's uploaded documents**. We need a pipeline that:

1. Lets the owner upload documents in the Ava Business Agent settings.
2. Ingests them (splits + indexes them so they're searchable by meaning).
3. Lets the voice agent, mid-conversation, retrieve the right passages to answer.

**DECIDED (UPDATED 2026-07-11): Grok Collections + `file_search`.** RAG for the voice agent
now lives inside Grok, not Cloudflare AutoRAG. The owner uploads documents in Ava Business
Agent settings → our Worker pushes them into a Grok **Collection** (one per business) via
the Collections API → the voice session declares
`{"type":"file_search","vector_store_ids":["<collection-id>"],"max_num_results":N}` and Grok
retrieves the right passages mid-call itself. This keeps the whole agent stack in one
provider (voice + RAG + connectors), which is the point of the switch. (`file_search` is
billed ≈ $2.50/1,000 calls — cap `max_num_results` and optionally KV-cache hot answers.)

---

## 6. Where conversations and voicemails live

**Everything from a business call — a voicemail OR a full AI-agent conversation — is
saved as a messenger THREAD, and that thread is visible on the CALLEE's side only.**

- **Voicemail:** the caller records it; it shows up as a thread/entry on the **callee's**
  side with options **Accept · Block · Save contact.**
- **AI-agent conversation:** the whole transcript of the caller ↔ Ava AI Voice Agent chat
  is stored as a thread on the **callee's** side, so the owner can read exactly what was
  said and what the agent did (e.g. "booked Room 5 for the 14th").
- **The caller sees NONE of this in their own chat.** No voicemail bubble, no transcript.
  From the caller's side, they called, left a message or spoke to the assistant, and the
  call ended — no chat artifact appears on their thread list.
- **The callee can reply.** If the callee wants to message the caller back, there's an
  option on that thread to start a normal chat with them. That is the only way this
  business interaction turns into a two-way conversation.

So: business calls flow **into** the messenger as callee-only threads (a record), and only
become a real back-and-forth if the callee chooses to reply.

---

## 7. What's already built vs what's new

**Already wired (reuse it):**
- Dialpad calls now go through `/api/call` → real ring + **liveness gate** (2026-07-11). ✅
- **Grok Voice Agent API** (voice conversations + bundled RAG/connectors) — NEW pipeline
  for the agent, replacing the earlier Gemini-Live plan (2026-07-11).
- Composio (Google Calendar + more) — exposed to Grok as `mcp` tools / custom functions.
- Ava Receptionist pipeline (message-taking) — the pattern to fork from.
- Cloudflare R2 storage + AI Search building blocks.
- The call screen (`CallScreen`) — needs the business-call polish.

**New to build:**
1. Email-only new-chat search (remove phone-number search).
2. Tappable AvaTOK numbers everywhere → paste into dialpad.
3. Phone-style **no-answer card** (stop dropping into the messenger thread).
4. Named incoming-call screen for business calls (Accept / Decline / Send to Ava AI
   Agent / Block).
5. **Carrier-style voicemail:** the 5-rings → in-call voice prompt → record 25s →
   auto-disconnect flow (this needs a small server-side voice bot that joins the call).
6. **Business calls stored as callee-side messenger threads** (voicemail + full AI-agent
   transcript); caller sees nothing; callee can reply.
7. **Ava AI Voice Agent** pipeline (the big one): Grok realtime session, 5-min conversation,
   RAG answers (`file_search`), and agentic **connector tool use** (Composio-as-MCP + custom
   functions) driven by the owner's instructions (booking is one example, not fixed). **No
   web/X search; no Grok phone number.**
8. **Ava Business Agent settings screen** (per number: on/off gated on wallet tokens;
   **mode is implied by number kind — primary=A, service=B, not a toggle**; service numbers
   also set rate + length options; instructions; document upload; routing: auto-after-2-rings
   vs manual "Send to Agent" vs off).
8b. **Service numbers (Mode B only)** — the primary Mode-A number is the account identity
   (one, free, issued at signup). Additional numbers can be added **only as caller-pays
   service numbers**, each its own AvaTOK number (never Grok), own agent config, **3
   tokens/min line fee** billed to the callee. Service numbers do **not** represent the
   account owner.
9. **RAG document pipeline** (upload → push into a **Grok Collection** → `file_search`
    retrieves mid-call). Replaces the AutoRAG plan for the agent.
10. **mem0 layer** for the agent (per §4): caller memory injected into the Grok session
    `instructions`; optional short-TTL KV cache for hot answers.
11. **Wallet billing for callee-pays agent minutes** — meter the agent's talk time and
    deduct **6 tokens/min (max 5-min call)** from the callee's wallet; block/disable the
    agent when the wallet can't cover it.
12. **Paid calls (§3B)** — caller-pays model for human OR AI-agent calls: client-side price
    + custom-length prompt, up-front escrow hold of the full amount, per-minute settle
    (`rate−10` → callee, `10` → admin **per minute**), local end beeps, refund of the unused
    hold. **Enforce MIN_SERVICE_RATE** so `rate−13 > 0`. Guardrail = liveness gate; legal
    review is a separate prerequisite (§12.13).
13. **Refund & escrow engine (§11)** — hold, per-minute idempotent settle, auto-refund on the
    whole refund matrix (no-answer, drop, agent-fail, partial minute), ledger-as-source-of-
    truth with retry-until-committed. The timeout constants (§11) become real config values.
14. **Agent Profiles (§12.5)** — a reusable { instructions, Collection, tool manifest, rate,
    length options, routing, booking_authority } that **many service numbers reference**;
    per-profile Composio scope isolation (§12.12); versioned prompt/tool manifests (§14).
15. **Booking authority setting (§12.8)** — `auto_write | confirm_with_caller (default) |
    require_owner_approval` per Agent Profile.
16. **Caller-side AI-call history (§12.11)** — caller can view/download their own transcript
    (outside Messenger). Callee-facing service display = "‹Service› by ‹owner›" (§12.10).
17. **Gap-review items (§15)** — busy/offline routing + agent-fail fallback, concurrency caps
    (A=1, B=5), fixed AI-disclosure greeting, account-level silent block, number retirement
    (never recycle), rate snapshot at `call_created`, Mode A on the escrow engine, child-account
    hard blocks, voicemail transcription, per-number business hours, connector-health alerts,
    feature flags + per-env Grok keys, caller-side GDPR erasure.
18. **Observability architecture (§13–§14)** — append-only `call_id` + `trace_id` event stream
    as the source of truth, fanning out to Ledger / Guardian / PostHog / Billing / Fraud /
    Call Replay. PII on **Person Profiles only** (IDs on events); **version everything**;
    **business events 100% / diagnostics sampled**; roll-up events + the compact
    **`call_aggregate`** roll-up that most dashboards read; `guardian_call_summary` deltas;
    cost prediction-vs-actual; `call_setup_latency` breakdown. Built in from the FIRST call
    feature, not bolted on later.

---

## 8. Build order (phased, so we ship value early)

**Phase A — the channel split (fast, mostly UI):**
- Email-only new-chat search.
- Tappable AvaTOK numbers → dialpad.
- Phone-style no-answer card.
- Named incoming-call screen with the 4 options.

**Phase B — voicemail + the in-call voice bot (carrier behaviour):**
- Server-side voice-prompt + 25s recording bot in the call room (also the foundation for
  the paid-call price prompt + keypress + end beeps).
- Callee-side voicemail inbox (Accept / Block / Save); no caller bubble.
- Callee setting: default = voicemail after 5 rings.

**Cross-cutting from Phase A onward — build these INTO every call feature, not after:**
- **Event-sourced call model + PostHog (§13–§14)** — every call feature emits the append-only
  `call_id` event stream and its telemetry from day one; the Call Replay dashboard grows with it.
- **Refund & escrow engine (§11)** — the money-safety layer any paid feature depends on.
- **Feature flags (§15.6)** — every phase ships behind its own `config.ts` kill switch
  (`businessCallUx`, `voicemailBot`, `paidCalls`, `voiceAgent`, `serviceNumbers`), staging
  first, prod flipped one at a time on the owner's say-so.

**Phase B2 — Paid calls (§3B), builds on the Phase B voice bot + the ledger + §11 engine:**
- Client-side price + custom-length prompt (callee-defined options), **≥ MIN_SERVICE_RATE**.
- Wallet check + up-front escrow hold; connect only when funds are held.
- Per-minute idempotent settle: `rate−10` → callee, `10` → admin; local end beeps; **auto-
  refund per the §11 matrix** (no-answer, drop, partial minute).
- Settings: service "Paid call" rate + callee's own length options.
- Guardrail = the existing first-time-caller liveness gate. **No additional *automated*
  policy engine is built in the MVP** beyond that gate — but **legal/compliance review
  remains a separate, non-engineering prerequisite** before enabling paid human-to-human
  services publicly (these are two different things; see §12.13).

**Phase C — Ava AI Voice Agent on GROK + settings + RAG (the big build):**
- Ava Business Agent settings screen, **per number**: on/off gated on wallet tokens;
  **mode fixed by number kind (primary=A, service=B — no toggle)**; service numbers set
  rate + length options; instructions; docs upload; routing (auto-2-rings vs manual vs off).
- **Primary vs service numbers:** the Mode-A primary number (account identity, one, free) +
  **Mode-B-only** service numbers (each its own AvaTOK number, never Grok, **3 tokens/min**
  line fee to the callee, not account-identity).
- RAG = **Grok Collection** per number/service (upload → push to Collection → `file_search`).
- Voice agent = **Grok Voice Agent realtime session** (`wss://api.x.ai/v1/realtime`),
  `instructions` = owner rules + caller mem0, `tools` = `file_search` (RAG) + `mcp`
  connectors (email/calendar via Composio-as-MCP) + custom functions (`create_booking`,
  `send_email`) handled client-side by our Worker. **`web_search`/`x_search` OFF.** Agentic:
  Grok maps caller intent → the right tool.
- mem0 layer (caller memory into `instructions`); optional KV hot-answer cache.
- Store the full agent transcript as a callee-side messenger thread (kept forever, backed
  up like any message).
- Wallet metering: **Mode A** = 6 tokens/min from the callee (≥6 to answer, max 5-min call);
  **Mode B** = caller escrow, `rate−10`→callee / `10`→admin per min; both pro-rated with
  graceful low-balance wrap-up; **+3 tokens/min line fee to the callee** on a service number
  (→ callee nets `rate−13`).
- Guardrails: agent OFF by default; only reachable when the callee enabled it (auto or
  "Send to Agent"); everyone else → free voicemail.
- **Business hours (§15.1):** optional per-number schedule in routing — in-hours = ring then
  agent; out-of-hours = agent/voicemail immediately. Ships with this settings screen.
- **Concurrency caps (§15.1):** Mode A agent = 1 concurrent call; service number = up to 5
  concurrent escrowed sessions; overflow → voicemail.
- **Disclosure greeting (§15.4):** fixed non-editable prefix before the owner's instructions.

---

## 9. Decisions — now locked in

- **AI voice agent + RAG engine:** **Grok Voice Agent API** (`wss://api.x.ai/v1/realtime`)
  with **Grok Collections `file_search`** for RAG and **`mcp` connectors** for
  email/calendar/apps. Replaces the earlier Gemini-Live + Cloudflare-AutoRAG plan. Chosen
  for the **flat ~$0.05/min** voice price (no per-turn context re-billing) and the bundled
  RAG + connectors. ✅ (2026-07-11)
- **Who pays:** the **callee**, from their **wallet (tokens)**. Agent minutes are metered
  and deducted. ✅
- **Agent default:** **OFF.** Can only be enabled if the wallet has tokens. ✅
- **Who can call:** anyone with the number, regardless of how they got it — not limited to
  "business" accounts. ✅
- **Routing:** callee taps "Send to Agent" → agent; callee has agent on AUTO → agent after
  2 rings; callee declines or has no agent → voicemail (5 rings → 25s). ✅
- **Storage:** all voicemails + agent transcripts = callee-side messenger threads;
  caller sees nothing; callee can reply. ✅
- **Agent behaviour:** whatever the owner instructs (Composio-aware, agentic) — booking is
  one example, not mandatory. ✅
- **Memory/speed:** mem0 (caller memory into `instructions`) + Grok Collection RAG +
  optional KV hot-answer cache. (Gemini-style context caching no longer needed — Grok's
  flat per-minute price removes the re-billing problem.) ✅
- **Two agent billing modes:** **A callee-pays** = 6 tokens/min from the callee (max 5-min
  call); **B caller-pays** = caller pays the callee's rate, 10 tokens/min → admin platform
  fee, `rate−10` → callee. Same Grok pipeline. **The mode is NOT chosen — it's fixed by
  number kind: primary→A, service→B.** Auto-answer (Mode A) and paid (Mode B) can therefore
  never coexist on one number. ✅
  (2026-07-11)
- **No Grok web/X search; no Grok phone number.** Agent uses Collection RAG + connectors
  only; extra numbers are AvaTOK numbers. Removes the $5/1,000 search and $0.01/min number
  costs; external cost ≈ $0.05/min voice + a little `file_search` RAG. ✅ (2026-07-11)
- **Primary number = account identity (Mode A, one, free).** Issued at signup; it's how we
  key the account. Exactly one; never a paid-service number. ✅ (2026-07-11)
- **Service numbers = Mode B only.** Extra numbers may be added ONLY as caller-pays service
  numbers (advertised services); each an **AvaTOK** number (never Grok), own agent config,
  **3 tokens/min** line fee billed to the callee (callee nets `rate−13`/min). Service numbers
  do **not** represent the account owner. ✅ (2026-07-11)
- **Voicemail length:** **25 seconds, fixed.** ✅
- **Transcript retention:** treated like any other message — **retained until the user
  deletes it / per the account retention policy** (not auto-expired), and backed up in the
  normal message backup. *(Reworded from "forever" so account deletion / GDPR-style erase
  stays clean — §11 point 7. Same practical intent as the owner's "keep it like a normal
  message.")* ✅

### Paid calls (§3B) — decided
- **Two billing directions coexist:** callee-pays (business support) and **caller-pays
  (paid calls)** — bound to number kind (primary=A / service=B), not a per-setup toggle. ✅
- **Paid calls work for both human and AI-agent** callees. ✅
- **Up-front escrow:** verify + hold the full chosen-duration cost before connecting;
  refund the unused hold if the call ends early. ✅
- **Per-minute split:** `rate − 10` → callee wallet, **10 tokens → admin (platform fee).** ✅

### Paid calls — all confirmed (2026-07-11)
1. **Platform fee is PER MINUTE.** 10 tokens/min to the admin wallet, every minute, for the
   life of the call. Not a per-call fee. ✅ (2026-07-11, was 5)
2. **No extra policy layer.** We rely on the existing **first-time-caller liveness gate** —
   the same gate that already fronts messaging and dialling. No separate adults-only/AML
   policy engine at MVP; **we modify as we learn how the platform is used.** ✅
   (The liveness record — face on file + traceable identity — is the deterrent, consistent
   with the whole identity-gate rationale.)
3. **Duration is CUSTOM.** No fixed 10/20/30 ladder. The **callee** configures the duration
   options they offer (e.g. they add "15 min", "45 min", "60 min"); the caller picks from
   that callee-defined list at call time. ✅
4. **All paid calls are P2P**, exactly like every other 1:1 call (see the P2P note below). ✅

### P2P constraint — how paid calls stay peer-to-peer
The owner confirmed **all these calls are P2P as usual** (CallRoom DO = thin signaling, media
flows caller↔callee, 2-peer cap unchanged). That shapes the design so we do NOT need a
server-side media mixer for the human paid path:

- **Price/duration prompt is CLIENT-side, not a server voice bot.** When the callee answers,
  the *caller's app* shows Ava's "this call costs N tokens/min — pick a length" screen from
  the callee's published rate + duration list. No server audio is injected into the P2P
  stream, so the media path stays pure P2P.
- **Metering is time-based, driven by the DO — it never touches media.** CallRoom DO already
  knows connect + disconnect timestamps. A per-minute ticker settles from the escrow hold on
  wall-clock minutes; it does not need to hear or see the call.
- **End-of-time beeps play locally.** Both clients know the agreed duration, so each plays its
  own countdown/warning beeps — no server-side audio.
- **Only the AI-agent path and voicemail are server-mediated** (the agent/voicemail *is* a
  server participant, by nature). Those are explicitly not the 1:1 human P2P call, so the
  "all P2P" rule is preserved for person-to-person.

### Callee-pays agent billing (6 tokens/min, max 5 min)

- Before the agent answers a call, check the callee's wallet has **at least 1 minute
  (6 tokens)**; if not, the agent is treated as off → the caller gets the free voicemail.
- Meter talk time and deduct **6 tokens/min** (pro-rated) from the callee's wallet, and
  **hard-cap the call at 5 minutes**.
- If the wallet runs low **mid-call**, the agent **wraps up gracefully** ("I have to go
  now — please call back or leave a message") rather than a hard cut. Log a
  `agent_call_wallet_cutoff` event so the owner can see it happened.

---

## 10. One thing to keep firm

**The dialpad stays liveness-gated.** Every new build in this plan keeps the first-call
liveness check on the dialpad (already live). None of the call-UX work removes it.

---

## 11. Refunds, escrow & fraud (paid calls) — the money-safety rules

**Core principle: escrow is a HOLD, never an immediate charge. Money moves ONLY as delivered
minutes settle; everything undelivered is refunded automatically.** So "caller picked 10 min
but it disconnects at minute 3" is not a special case — only 3 minutes ever settle, the other
7 are released back. Settlement is **per delivered minute, rounded UP: a started minute
counts as a whole minute** (owner decision 2026-07-11, superseding the earlier round-down
rule — talked 4m20s on a 10-min booking = charged 5 minutes, 5 refunded). Charging begins
only when the callee/agent actually answers; the pre-connect escrow is a hold, and the price
sheet says so explicitly.

### Refund matrix

| Scenario | Charge | Refund |
|---|---|---|
| Callee never accepts within the ring window (RING_TIMEOUT) | 0 | **100% auto-refund**, hold released |
| Caller abandons at the price/length prompt (ESCROW_PROMPT_TIMEOUT) | 0 | hold never taken / released |
| Wallet can't cover the chosen length | — | not connected; nothing held |
| Connected, then **callee** drops / network fails | only delivered minutes | remainder auto-refunded |
| Connected, then **caller** hangs up early | only delivered minutes | remainder auto-refunded |
| **AI agent fails to start** (Grok session errors before first response) | 0 | **100% auto-refund** |
| AI/tool failure **mid-call** (agent dies) | minutes up to failure | remainder auto-refunded |
| In-progress partial minute at any disconnect | **charged as a full minute (round UP** — owner decision 2026-07-11**)** | remainder refunded |
| Dispute / suspected fraud | **held pending review** | manual resolution |

### Fraud & abuse rules (MVP-level, feeds Guardian later)
- **Refund abuse:** repeated connect→instant-hangup→refund loops are rate-limited and scored
  (`refund_abuse` telemetry). A caller who repeatedly forces refunds gets throttled.
- **Ring-bait:** a callee who repeatedly lets paid calls ring out to farm nothing is harmless
  (caller refunded) but is tracked; a caller who repeatedly rings paid numbers without ever
  connecting is throttled (`rapid_calling`).
- **Idempotent settlement:** every hold/settle/refund carries the `call_id` + minute index so
  a retry can never double-charge or double-refund.
- **Ledger is the source of truth** (see §6 point 6): settlement writes are append-only and
  **retry until committed**; we never rely on a transient DB write for money state. If a
  downstream (Supabase, etc.) is down, the ledger entry still stands and reconciles later.

### Timeout constants (proposed — confirm the numbers)
`RING_TIMEOUT` = 30 s (≈5 rings) · `AGENT_AUTOANSWER` = 12 s (≈2 rings) ·
`VOICEMAIL_RECORD` = 25 s (+3 s grace) · `ESCROW_PROMPT_TIMEOUT` = 30 s ·
`WALLET_CHECK_TIMEOUT` = 5 s · `TOOL_CALL_TIMEOUT` = 10 s · `AGENT_MAX_CALL` = 5 min ·
`NETWORK_RECONNECT_WINDOW` = 20 s (drop past this = call ended, settle+refund) ·
`OFFLINE_DETECT` = 6 s (no device push-ack → skip ring, route per §15.1) ·
`AGENT_CONCURRENCY_A` = 1 · `AGENT_CONCURRENCY_B` = 5 (per service number — §15.1).

---

## 12. Resolutions to the design review (before freeze)

1. **Mode A/B ambiguity — FIXED.** Mode is bound to number kind (primary=A, service=B); there
   is no "pick a mode" toggle. Auto-answer + paid can never coexist. (Applied in §4/§7/§8/§9.)
2. **Minimum service rate — ADD (confirm value).** Because `caller rate → 10 admin + 3 line +
   (rate−13) callee`, a rate ≤ 13 makes the callee earn ≤ 0. **Enforce a minimum caller-paid
   rate.** Proposed **MIN_SERVICE_RATE = 20 tokens/min** (callee nets ≥ 7). Hard floor is 14
   (nets ≥ 1); recommended default 20. UI blocks setting a rate below the minimum.
5. **Shared Agent Profiles — ADOPT.** A **service number references an Agent Profile**, it
   doesn't *own* one. An Agent Profile = { instructions, Collection, tool manifest, rate,
   length options, routing }. Many numbers (USA-visa, UK-visa, Canada-visa) can point at one
   profile; edit once, all inherit. (Reshapes the §5/§7 data model — no per-number duplication.)
7. **Retention wording — FIXED.** "Forever" → "retained until deletion / per account retention
   policy." Keeps GDPR-style erase clean. (Applied in §9.)
8. **AI booking authority — ADD as owner setting.** Per Agent Profile: `booking_authority` =
   `auto_write` | `confirm_with_caller` (**default**) | `require_owner_approval`. The agent
   reads back details and only commits on the chosen gate; limits "booked the wrong date" harm.
10. **Service-number identity — ADOPT ("YouTube model").** Internally a service number does
    NOT key the account (identity = primary number). **Caller-facing UI shows "‹Service name›
    by ‹owner display name›"** so callers know who they're paying. Service has its own identity;
    owner is visible for trust.
11. **Caller-side AI transcript — ADOPT.** The caller can **view/download their own** AI-call
    transcript from a "My AI calls" history area (NOT in Messenger, preserving the channel
    split). Paid callers never "lose" the conversation they paid for.
12. **Composio scope isolation — ADOPT.** Each Agent Profile exposes **only the tools it
    needs**; connector OAuth scopes are per-profile. A visa bot can't reach a hotel-booking
    tool. Tool manifest is versioned (see §14).
13. **Policy wording — RECONCILED.** MVP ships **no additional *automated* policy engine**
    beyond the liveness gate; **legal/compliance review remains a separate prerequisite**
    before enabling paid human-to-human services publicly. (Applied in §8/§9.)

*(Items 3, 4, 6, 9 from the review are handled by §11 above: refund matrix, mode-binding,
ledger-source-of-truth, and the timeout constants.)*

---

## 13. Calls are event-sourced (append-only)

Call state is **not** stored as a mutable row. Each call has a permanent `call_id`, and its
life is an **append-only event stream** — the same philosophy as the ledger, messaging, and
trust engine. Reconstructing "what happened" = replaying the events.

**Canonical events:** `call_created` · **`routing_decision`** (see below) ·
`call_liveness_started` · `call_liveness_passed`/`_failed` · `call_ringing` ·
`call_answered` · `call_declined` · `agent_joined` · `voicemail_started` · `escrow_held` ·
`rag_query` · `tool_called` · `booking_created` · `minute_settled` · `call_ended` ·
`refund_completed` · `guardian_call_summary` · `call_aggregate` (the auto-emitted canonical
roll-up, formerly `call_summary_generated` — see §14).

**`routing_decision` (2026-07-11 refinement):** emitted immediately after `call_created`,
recording WHY the call went where it went, with a structured `reason` enum:
`busy | offline | blocked | business_hours | manual_send_to_agent | agent_auto |
paid_prompt | voicemail | rang_owner`. This is the first thing support reads when debugging
"why did this call never ring?" — no log correlation needed.

**Snapshot the routing policy too (extends §15.3):** `call_created` snapshots not just
rate/length/fees but the **entire routing configuration in force**: routing mode,
business-hours schedule version, block status, agent enabled, voicemail enabled,
`booking_authority`, concurrency state. Replay six months later reflects the settings *at
call time*, not today's.

**Three IDs, three jobs (2026-07-11):**
- **`call_id`** = the **business identity** of the call (billing, dashboards, replay).
- **`trace_id`** = the **distributed-debugging** correlation ID. Every downstream action a
  call spawns inherits it — Grok → Composio → Calendar → Supabase → ledger → email — so one
  `trace_id` ties the whole fan-out together across systems.
- **`span_id`** = a **child span per external call** under the trace: Calendar write = span A,
  Supabase write = span B, confirmation email = span C — each with its own start/end/latency.
  When a booking takes 9 seconds, the spans show exactly which dependency ate the time.

**Two hard invariants (write them into the code, not just this doc):**
1. **Events are immutable — append-only means append-only.** Never edited, never deleted,
   only **superseded** by a later event. There is no `UPDATE call_event`; the write path
   physically doesn't expose one (insert-only API / DB grants). Corrections are new events
   referencing the old one.
2. **Every event carries `event_schema_version`.** Event shapes will evolve; replay/consumer
   code decodes any historical event by its schema version, indefinitely. No consumer may
   assume "current shape."

Benefits: billing reconciliation, debugging, analytics, and the fraud signals all read the
**same** stream — no separate mutable call table to drift out of sync.

---

## 14. Observability Architecture (Event Stream + PostHog)

**The append-only event stream (§13) is the source of truth; PostHog is one consumer, not the
centre.** The same stream fans out to many consumers:

```
Call → Append-only event stream → { Ledger · Guardian · PostHog · Analytics · Billing ·
                                     Fraud Engine · Call Replay · future ML models }
```

Four goals for the PostHog consumer: (1) debug any failed call in <30 s, (2) business metrics,
(3) automatic fraud/abuse detection, (4) AI quality + cost visibility.

### PII lives on the Person, NOT on every event (2026-07-11)

**Events reference IDs only** — `person_id`, `caller_id`, `callee_id`, `call_id`, `trace_id`.
**PII lives once on the PostHog Person Profile:** email, phone, display name, avatar, account
type, country, trust score. This satisfies the project mandate ("pull telemetry by email/
phone") — the email/phone are set **once** on the Person, and every event resolves to it via
`person_id` — **without** stamping PII onto millions of events. Why: smaller events, lower
ingestion cost, no duplicated PII, clean GDPR deletion (erase the Person), less export risk.
Mental model: `Person ↑ Events`, never `Event contains email/phone`.

**Shared properties on every call event:** `call_id`, `trace_id`, `span_id` (on external-call
events), `person_id`, `caller_id`, `callee_id`, `primary_number`, `service_number`,
`call_mode` (friend | business | paid_human | paid_ai), `billing_mode` (A|B),
`agent_profile_id`, **`agent_profile_version`**, `room_id`, `region`, `colo`, `worker`,
`build_version`, **`event_schema_version`**.

**Reason codes, never free text (2026-07-11):** every failure/decision field is a stable
enum, not a string — `CAL_TIMEOUT`, `CAL_403`, `CAL_429`, `TOOL_TIMEOUT`, `OAUTH_EXPIRED`,
`NETWORK`, `VALIDATION`, `WALLET_INSUFFICIENT`, `GROK_SESSION_FAIL`, … A human-readable
message may ride alongside, but analytics, alerts, and Guardian key off the code only.
New codes are added to a versioned registry; codes are never renamed or reused.

### Version EVERYTHING (not just prompts)

Every call event carries the versions of the logic that produced it: `prompt_version`,
`agent_version`, **`agent_profile_version`** (the Agent Profile as a whole — instructions +
Collection + tool manifest + rate + routing are one versioned unit; owner edits bump v21→v22,
and a booking dispute six months later resolves to *the exact profile version that handled the
call*, not merely the prompt), `collection_version`, `tool_manifest_version`,
**`liveness_policy_version`, `guardian_policy_version`, `pricing_policy_version`,
`refund_policy_version`, `trust_engine_version`, `voice_pipeline_version`,
`rag_pipeline_version`, `event_schema_version`.** So six months on we can always answer
"which logic produced this behaviour."

### Business vs diagnostic events (sampling)

- **Business events — 100%, NEVER sampled:** `signup`, `booking_created`, `paid_call`,
  `wallet_charge`, `wallet_refund`, `escrow_held`, `minute_settled`, `call_ended`, etc.
- **Diagnostic events — sampled (≈5% or adaptive):** `call_network_sample`, RTT/jitter/
  packet-loss telemetry, and other high-volume signals. This keeps ingestion sane at
  hundreds-of-thousands-to-millions of calls/day without losing money-truth.

**Event families (properties summarised):**
- **Liveness:** `call_liveness_started/_passed/_failed` — `camera_ready_ms`, `face_detected_ms`,
  `challenge_type/count`, `failure_reason` (screen_detected | multiple_faces | lighting |
  camera_denied | timeout | head_pose | blink | spoof | policy), `latency_ms`.
- **Ring:** `caller_online`, `callee_online`, `push_sent/_received`, `push_latency`,
  `ring_count`, `answered_after_ring`, `declined`, `timed_out`, `sent_to_agent/_voicemail`.
- **WebRTC quality** (`call_network_sample`, every few s): `rtt`, `jitter`, `packet_loss`,
  `bitrate`, `codec`, `ice_type` (relay/turn/direct), `candidate_pair`, `audio_level`,
  `frames_dropped`, `reconnect_count`.
- **AI session** (`agent_session_started`): `provider=grok`, `model`, `voice`, `collection_id`,
  `instruction_version`, `tool_count`, `memory_loaded/_size`, `rag_enabled`, `connector_count`.
- **RAG** (`rag_query`): `query_length`, `retrieval_latency`, `documents_returned`,
  `max_results`, `cache_hit`, `collection`, `total_context_tokens`.
- **mem0:** `memory_loaded/_written/_updated/_deleted` — `memory_count`, `summary_size`,
  `latency`, `success`.
- **Tools** (`tool_call` / `tool_call_failed`): `tool`, `arguments_size`, `latency`,
  `success`, `retry_count`, failure `reason` (oauth_expired | 403 | 429 | network | validation).
- **Booking:** `booking_started/_confirmed/_written/_email_sent/_failed` — `provider`,
  `latency`, `failure_reason`.
- **Wallet** (every ledger move): `wallet_hold_created/_released`, `wallet_minute_settled`,
  `wallet_refund/_payout/_charge` — `amount`, `balance_before/_after`, `call_id`, `reason`.
- **Paid-call funnel:** `paid_call_offer_shown`, `duration_selected`, `wallet_check`,
  `wallet_passed/_failed`, `escrow_created`, `refund_amount`, `call_completed`.
- **Revenue/cost (per minute + per session):** `platform_revenue`, `platform_tokens`,
  `grok_cost`, `line_fee`, `rag_cost`, `profit_estimate`; `agent_cost` session totals
  (`voice_minutes`, `rag_queries`, `rag_cost`, `provider_cost`, `estimated_margin`).
- **Fraud** (feeds Guardian): `suspicious_call`, `rapid_calling`, `wallet_abuse`,
  `refund_abuse`, `spam_pattern`, `mass_dialing`, `agent_prompt_attack`,
  `rag_prompt_injection`, `tool_abuse` — each with `risk_score` + `action`
  (allowed | blocked | shadow_scored).
- **AI quality** (`agent_summary`, at call end): `caller_goal`, `resolved`, `booking_created`,
  `tools_used`, `memory_used`, `escalated`, `duration`, **plus confidence:
  `retrieval_used`, `retrieval_confidence`, `tool_confidence`, `hallucination_guard_triggered`,
  `fallback_used`** (so we can later find e.g. "bookings fail when confidence < 0.45" without
  reading transcripts).
- **Latency breakdown** — compute **`call_setup_latency`** = liveness + wallet + ring + answer
  + agent-startup + first-AI-token, each as a component field, so support sees *where* delay
  comes from instantly.
- **AI cost prediction vs actual:** at call start emit `estimated_call_cost` +
  `estimated_margin`; at call end emit `actual_cost` + `actual_margin`. Finance sees
  prediction → reality per call.
- **Derived (roll-up) events — emit these so dashboards don't parse low-level streams:**
  `call_successful` / `call_failed`, `booking_successful` / `booking_failed`,
  `wallet_successful` / `wallet_failed`.
- **Guardian integration (refined 2026-07-11)** — Guardian **consumes the RAW event stream**
  (`call_created`, `routing_decision`, `call_answered`, wallet/escrow/refund, `rag_query`,
  `tool_called`, `booking_*`), not the roll-ups — fraud engines need the detail that
  summaries discard. Guardian then **produces** `guardian_call_summary` at call end
  (`trust_delta`, `spam_delta`, `wallet_delta`, `behaviour_delta`, `risk_delta`) as its
  *output* back onto the stream, so every other consumer learns from every interaction.
- **Derived profiles:** `caller_profile` (calls_today, avg_duration, agent/voicemail usage,
  topups) and callee dashboards (calls_received/_answered/_to_agent/_to_voicemail, bookings,
  earnings, agent_minutes, wallet_spend/_income).
- **Geo:** `country`, `region`, `city`, `colo`, `ASN`, `ISP`, `carrier` (Cloudflare metadata).

### The canonical roll-up event — `call_aggregate` (renamed from `call_summary_generated`)

When a call finishes, the event-stream automatically emits **one** rich `call_aggregate`
event. It is not merely a summary — it is **the canonical analytics object**: Revenue,
Finance, Support, and dashboards (~90% of reads) all read this one event, while the raw
forensic stream stays available for deep debugging and Guardian (the Stripe/Cloudflare
pattern: keep the forensic stream, serve analytics off compact aggregates).
Fields: `call_id`, `trace_id`, `person_id`s, `human|AI`, `friend|business`, `duration`,
`resolved`, `booking`, `wallet`, `revenue`, `cost`, `margin`, `caller_sentiment`,
`callee_sentiment`, `quality_score`, `network_score`, `guardian_score`,
`agent_profile_version`, `event_schema_version`.

**"Call Replay" dashboard (build it):** selecting a `call_id` reconstructs the full timeline
from the event stream — created → liveness → ringing → sent-to-AI → Grok opened → mem0 loaded
→ RAG query → tool called → booking written → email sent → minute settled → session closed →
transcript stored. When a user reports "my booking never happened," support opens the timeline
and sees exactly which stage failed, instead of correlating logs across systems.

---

## 15. Gap-review resolutions (2026-07-11, third review — ALL LOCKED)

A completeness review found the gaps below; solutions were agreed with the owner on
2026-07-11. These carry the same locked status as §9.

### 15.1 Call-routing edge cases

- **Busy.** Callee already on a call = treated as a decline → agent (if enabled) or voicemail
  **immediately**. No fake ringing.
- **Offline.** No device push-ack within `OFFLINE_DETECT` (6 s) → skip the ring entirely →
  agent (if AUTO) or voicemail. Never ring 5 times into a dead device.
- **Agent-failure fallback.** If the Grok session fails to start or dies mid-call, the caller
  is **auto-routed to free voicemail** (on top of the §11 refund). A caller never hits a dead
  end.
- **Concurrency (owner decision).** `AGENT_CONCURRENCY_A = 1` — the primary number's agent
  takes one call at a time; a second simultaneous caller goes to voicemail.
  `AGENT_CONCURRENCY_B = 5` — each service number handles up to **5 concurrent paid sessions**
  (safe because every Mode-B caller escrows their own funds up front). Enforced at the routing
  layer. **Overflow UX (owner decision 2026-07-11): PAID lines never overflow to voicemail —
  the caller gets a BUSY tone + message.** AI service number with all 5 agents busy: *"All
  agents are busy right now — please try again in a while."* Human paid callee already on a
  call: plain busy tone, no voicemail, no charge, hold released. (Future enhancement: show
  the callee's calendar to book a slot instead.) Mode A (free receptionist) keeps
  overflow → voicemail.
- **Business hours (owner decision).** Optional per-number schedule in routing, built into the
  Phase C settings screen: **in-hours** = ring the owner, then agent per normal rules;
  **out-of-hours** = agent/voicemail immediately, no ring.

### 15.2 Blocking (owner decision: silent)

- Block is **account-level**: blocking a caller blocks their calls to ALL of my numbers, plus
  voicemail, the agent, and messaging. One list, managed in Settings → Blocked users (reuses
  the existing messenger block list).
- **Silent no-answer UX.** A blocked caller sees normal ringing, then the standard no-answer
  card with voicemail unavailable. They are never told they're blocked — no retaliation signal.

### 15.3 Money-path hardening

- **Rate snapshot.** At `call_created`, snapshot the rate, length options, and fee constants
  into the event stream. **All metering and settlement read the snapshot**, never the live
  setting — a mid-prompt rate change can't cause shown-price ≠ charged-price.
- **Mode A runs on the §11 escrow engine too.** When the agent answers, **hold 30 tokens**
  (6/min × 5-min cap) from the callee's wallet, settle 6/min as minutes are delivered, refund
  the unused hold at hang-up. One money path for every call type; kills the wallet race.
- **Number lifecycle — numbers are NEVER recycled.** It's our internal namespace; numbers are
  free. A deleted service number is retired forever (callers hear "this service is no longer
  available"); deletion is blocked while any escrow is in flight; account deletion retires the
  primary number too. A reassigned number can never route a paying caller to a stranger.

### 15.4 Legal & safety

- **AI-disclosure greeting (mandatory, non-editable).** Every agent call begins with the fixed
  platform line: *"You've reached ‹Business›'s Ava AI assistant. This call is transcribed."*
  The owner's instructions run after it. Covers bot-disclosure and recording-consent in one
  sentence.
- **Child accounts — hard-blocked NOW** (independent of the deferred §3B policy engine): child
  accounts cannot create service numbers, cannot set paid rates, and **cannot call paid
  lines**. A one-line account-type check at each of those three gates.
- **Caller-side GDPR.** On a caller's account erasure: delete their mem0 memories across all
  businesses and their "My AI calls" history. The callee's transcript thread is retained but
  **pseudonymized** (business-records basis — include this in the §3B legal review).

### 15.5 Product polish

- **Voicemail transcription.** Transcribe at save time (Grok STT); the callee's thread shows
  audio + text, and voicemails become searchable.
- **Language.** The agent auto-detects and replies in the caller's language by default; the
  owner can pin allowed languages per Agent Profile.
- **Connector-health alerts.** `tool_call_failed` with `oauth_expired` (etc.) → push
  notification + badge in Ava Business Agent settings ("Your Google Calendar disconnected").
- **Missed-call + voicemail push notifications** to the callee — explicit, standard.

### 15.6 Platform & rulebook plumbing

- **Feature flags.** One `config.ts` kill switch per phase: `businessCallUx`, `voicemailBot`,
  `paidCalls`, `voiceAgent`, `serviceNumbers`. Staging first; prod flags flipped one at a time
  on the owner's say-so (per the deploy rules).
- **Environments.** Separate xAI API key AND separate Grok Collections per environment;
  staging wallets can mint free test tokens. No staging data ever promotes to prod (existing
  rule).
- **2-peer cap preserved.** The voicemail/agent bot occupies the **second** peer slot
  (caller + bot; the callee never joined). It never joins a call that already has two humans.
  The CallRoom 2-peer cap is untouched.
- **Per-account scoping.** ALL new local state — agent configs, "My AI calls" history,
  voicemail cache — via `scopedKey(...)` / per-account subdirs, per the rulebook.
- **Storage quota.** Voicemails + transcripts count against the universal 5 GB pool, but
  **inbound records are always accepted even over quota** — over-quota read-only mode blocks
  the user's own uploads, never someone else's message/voicemail to them.
