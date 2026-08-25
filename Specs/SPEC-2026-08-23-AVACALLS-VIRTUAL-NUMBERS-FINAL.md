# FINAL SPEC — AvaCalls and Virtual Numbers

**Status:** Canonical implementation specification  
**Owner decisions:** 2026-08-23  
**Environment:** Production-targeted development; all deploys, migrations, and flag writes still require explicit confirmation  
**Design references:** `design/avaphone/16` through `19`

## 1. Authority and supersession

This document is the canonical implementation specification for universal calling,
multiple virtual numbers, per-number activity, and provider-flexible PSTN telephony.

It supersedes the following conflicting decisions in
`SPEC-2026-08-09-personal-DID-virtual-number.md`:

- Free AvaTOK numbers are **not retired**. Users may create AvaTOK-only virtual
  numbers through Virtual Numbers.
- A user may own multiple DID virtual numbers rather than one personal DID.
- Dialing does not live inside each number. All calls originate from the existing
  Calls dialpad, renamed **AvaCalls**.
- Virtual-number activity is organized under each owned number.

Unless changed below, existing AvaTOK identity, human-call allowance, wallet,
storage, receptionist, privacy, and Cloudflare-native architecture rules remain in
force.

The established personal DID rental price remains **600 tokens per 30-day period**.
The 1,000-token value in the design mockup is illustrative and must not be shipped.
Legacy campaign DIDs may retain their existing separate price until migrated.

## 2. Product model

The product has two distinct surfaces.

### 2.1 AvaCalls

The existing **Calls** label and icon become **AvaCalls**. AvaCalls is the single
place for dialing and reviewing call history.

Its existing Dialpad accepts:

- AvaTOK numbers;
- national PSTN numbers;
- international PSTN numbers;
- saved contacts; and
- pasted numbers containing normal spaces, brackets, dashes, or a leading `+`.

The dialer classifies the destination before enabling the call action:

1. Normalize the input using the device region and canonical E.164 rules.
2. Ask the server whether the exact normalized value belongs to an AvaTOK number.
3. If it is an AvaTOK number, show an **AvaTOK number** recognition blip and use
   the existing in-network calling path.
4. Otherwise, if it is valid PSTN, show destination country, the selected outgoing
   DID, and **0.50 tokens/minute**, then use the provider-neutral DID pipeline.
5. If invalid or unsupported, disable Call and explain the reason.

The exact-number resolver must not expose directory search results, user identity,
or partial matches. It returns only callable classification and the minimum display
information already permitted by privacy rules.

### 2.2 Virtual Numbers

The proposed **AvaPhone** sidebar item and page are named **Virtual Numbers**.
Virtual Numbers is for acquiring, configuring, and viewing activity for owned
numbers. It is not a second dialer.

Users can:

- purchase multiple DID virtual numbers using wallet tokens;
- create free AvaTOK-only numbers;
- see all owned numbers and unread counts;
- choose a default outgoing DID;
- open the activity belonging to one number;
- play voicemail and call recordings;
- read SMS and OTP messages delivered to a DID;
- configure a separate AI receptionist for each number; and
- suspend, renew, rename, recolor, or release a number where permitted.

## 3. Number types and capabilities

### 3.1 DID virtual number

A DID is a provider-provisioned PSTN number. Its capabilities are provider and
country dependent and must be stored per number rather than assumed globally.

Possible capabilities:

- inbound voice;
- outbound caller ID;
- SMS receive;
- SMS send, when later enabled;
- OTP receive as an SMS classification;
- voicemail;
- AI receptionist;
- call recording; and
- transcription.

Costs:

- rental: `virtualNumberDidMonthlyTokens`, default **600 tokens / 30 days**;
- outgoing human PSTN calls: `avaCallsPstnTokensPerMinute`, default **0.50 tokens/minute**;
- incoming, receptionist, recording, transcription, and SMS prices remain separate
  configurable feature prices and must never be inferred from provider wholesale
  charges.

### 3.2 Free AvaTOK number

A free AvaTOK number is an in-network alias and never touches PSTN.

Capabilities:

- AvaTOK-to-AvaTOK audio/video calls;
- AvaTOK messaging where the current directory/message rules allow it;
- line-specific activity and unread state; and
- line-specific receptionist rules for in-network calls.

It does not receive PSTN calls, carrier SMS, or bank/delivery OTPs and cannot be
used as a PSTN caller ID. The UI must state these limitations clearly.

Free-number creation is controlled by a server-side configurable per-account cap.
Default: `virtualNumberFreeMaxPerAccount = 5`. Admin and abuse controls may lower,
raise, suspend, or deny creation without an app update.

## 4. User experience

### 4.1 Sidebar and navigation

- Rename the current Calls destination to **AvaCalls** everywhere visible.
- Add **Virtual Numbers** as a standard sidebar destination.
- Route `virtual_numbers`, `avaphone`, and legacy `phone_numbers` links to the new
  Virtual Numbers list.
- Preserve `avadial`, `dial`, and call-notification routes for AvaCalls.
- Add routing to both legacy `AvaShell` and Shell V2; neither may fall through to
  Coming Soon.

### 4.2 AvaCalls dialpad states

The Dialpad has these states:

- `empty` — neutral call action;
- `resolving` — short inline progress indicator, with debounce and cancellation;
- `avatok` — AvaTOK-colored recognition blip and free/in-network explanation;
- `pstn` — country, outgoing DID selector, and 0.50 tokens/minute disclosure;
- `no_did` — valid PSTN number but no usable DID; call action becomes
  **Get a Virtual Number**;
- `insufficient_wallet` — show required runway and wallet action;
- `unsupported` — invalid destination or no capable DID/provider route; and
- `offline` — preserve the number and offer retry.

Recognition must be repeated server-side at call admission. Client classification
is display state, never routing authority.

### 4.3 Outgoing DID selection

- Zero active voice-capable DIDs: PSTN calling is unavailable.
- One active voice-capable DID: select it automatically.
- Multiple active voice-capable DIDs: use the account-scoped saved default and
  expose a **Calling from** selector.
- If the default is suspended, released, incompatible, or unavailable, select the
  next eligible DID and explain the change.
- Persist only the internal line ID locally, using `scopedKey`/`readScoped`.

### 4.4 Virtual Numbers list

Implement the supplied number-list design with production data.

Each card displays:

- user label;
- formatted number;
- DID or AvaTOK badge;
- capability summary;
- status;
- unread count;
- stable user-selected color plus a text/icon type marker for accessibility; and
- overflow menu for Settings, Make default, Suspend/Resume, and Release.

The page contains one **Add new number** action. Do not add per-card dial buttons.

### 4.5 Add number

The add-number page presents two distinct choices:

1. **Get a DID virtual number** — country, inventory, capabilities, rental price,
   verification eligibility, wallet balance, and purchase confirmation.
2. **Create a free AvaTOK number** — number selection/generation, capability
   limitations, remaining free-number allowance, and creation confirmation.

Purchase endpoints must re-check every eligibility condition server-side.

### 4.6 Per-number activity

Opening a number shows activity scoped to that line. Filters:

- All;
- Calls;
- Recordings;
- Voicemail;
- AI receptionist;
- OTP; and
- Text messages.

The activity hierarchy is:

`owned number -> remote party/activity thread -> individual events`.

The current AvaDial Inbox playback, caching, read/heard state, transcript, card
metadata, delete/archive, caller resolution, and mini-player behavior must be
extracted into reusable components. Do not fork these behaviors into a second
implementation.

The old standalone Inbox routes and notification deep links stay compatible until
all supported clients understand line IDs. During migration, unscoped historical
items may appear in a clearly labelled **Earlier Inbox activity** section rather
than being guessed onto a number.

### 4.7 Per-number settings

Implement the supplied settings design for each line:

- label;
- color;
- default outgoing DID toggle, DID only;
- AI receptionist enabled;
- persona/display name;
- voice and language;
- greeting;
- receptionist instructions;
- answer timing/rules;
- maximum conversation duration;
- record calls;
- transcribe calls;
- block unknown callers;
- rental/status/renewal details; and
- suspend/release action.

Settings are line-specific with optional account-level defaults copied only at
line creation. Changing account defaults must not silently overwrite customized
existing lines.

## 5. Data model

Do not repurpose `avatok_numbers` as the multi-line store. It currently represents
the account's singular AvaTOK identity and has a unique active-owner constraint.

Reuse and extend the existing `user_dids` ownership machinery where safe, but add
a canonical cross-type line table.

### 5.1 `virtual_lines`

- `id TEXT PRIMARY KEY`
- `owner_uid TEXT NOT NULL`
- `kind TEXT NOT NULL` — `did` or `avatok`
- `canonical_number TEXT NOT NULL`
- `display_number TEXT NOT NULL`
- `number_hash TEXT NOT NULL`
- `provider TEXT` — null for AvaTOK numbers
- `provider_number_id TEXT`
- `provider_account_ref TEXT`
- `country_iso2 TEXT`
- `region TEXT`
- `label TEXT NOT NULL`
- `color_key TEXT NOT NULL`
- `capabilities_json TEXT NOT NULL`
- `status TEXT NOT NULL` — `provisioning`, `active`, `past_due`, `suspended`, `releasing`, `released`, `failed`
- `is_default_outgoing INTEGER NOT NULL DEFAULT 0`
- `monthly_tokens_subunits INTEGER NOT NULL DEFAULT 0`
- `current_period_start INTEGER`
- `next_renewal_at INTEGER`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`
- `released_at INTEGER`

Constraints:

- globally unique active canonical number;
- at most one active default outgoing DID per owner;
- every query scoped by authenticated `owner_uid`;
- provider metadata must not contain credentials; and
- no hard deletion of financial or provider audit identity.

### 5.2 `virtual_line_settings`

One row per line containing receptionist and call-handling settings. Use additive
columns or a versioned JSON policy with strict validation; never store secrets.

### 5.3 `virtual_line_activity`

Canonical index for telephony activity:

- internal event ID;
- owner UID;
- line ID;
- remote-party key/hash;
- normalized type;
- provider and provider event ID;
- call/message/session ID;
- direction;
- timestamps and duration;
- read/heard state or references to existing state;
- recording/transcript references;
- safe display metadata; and
- raw-event audit reference, never unrestricted raw webhook content.

High-write chat/media bodies remain in the appropriate InboxDO/R2 storage. D1 is
ownership, routing, billing, configuration, reconciliation, and activity indexing;
it is not a replacement central message store.

### 5.4 `telephony_webhook_receipts`

Store provider, provider event ID, event type, first-seen time, processing state,
and normalized resource ID. This supplies cross-retry idempotency and reconciliation.

## 6. Provider architecture

The existing `TelephonyProvider` abstraction is the starting point. Generalize it
from the Vobiz-only union/factory into a registry supporting **FreJun**, Vobiz, and
future providers.

### 6.1 Required provider contract

- health/capabilities;
- search number inventory;
- reserve number when supported;
- purchase number;
- configure voice and messaging webhooks;
- release number;
- place outbound call;
- get call state;
- hang up call;
- fetch or stream recording;
- verify webhook signature/authentication;
- parse provider webhook into normalized events; and
- return typed normalized errors with retryability and uncertainty status.

Transfer-call and campaign-specific methods may remain optional capabilities rather
than blocking providers that do not support them.

### 6.2 Provider selection

- New provisioning uses `virtualNumberPrimaryProvider`.
- Each line permanently records the provider that owns it.
- Changing the primary provider affects new purchases only.
- Existing lines continue through their recorded provider.
- Migration between providers is an explicit porting workflow, never a flag flip.
- Automatic failover may route new outbound calls only when caller-ID ownership and
  regulatory/provider rules permit it.
- The Flutter client never sends or chooses a raw provider name.

### 6.3 FreJun integration

Implement `FrejunProvider` after verifying its current API, webhook authentication,
inventory, caller-ID, recording, SMS, and call-state contracts against official
provider documentation and a sandbox account. Keep provider field mapping inside
the adapter. No FreJun-shaped JSON may escape into app or domain APIs.

## 7. APIs

Suggested stable domain API surface:

- `GET /api/virtual-lines`
- `POST /api/virtual-lines/avatok`
- `GET /api/virtual-lines/dids/search`
- `POST /api/virtual-lines/dids/purchase`
- `GET /api/virtual-lines/:lineId`
- `PATCH /api/virtual-lines/:lineId`
- `PUT /api/virtual-lines/:lineId/default-outgoing`
- `GET /api/virtual-lines/:lineId/activity`
- `GET /api/virtual-lines/:lineId/threads/:threadId`
- `PUT /api/virtual-lines/:lineId/settings`
- `POST /api/virtual-lines/:lineId/suspend`
- `POST /api/virtual-lines/:lineId/resume`
- `DELETE /api/virtual-lines/:lineId`
- `POST /api/avacalls/resolve`
- `POST /api/avacalls/pstn/prepare`
- `POST /api/avacalls/pstn/place`
- `POST /api/avacalls/pstn/:callId/hangup`
- provider webhook routes under `/api/telephony/webhooks/:provider/*`

All mutation endpoints require Clerk authentication except authenticated provider
webhooks. Line access is always checked by opaque line ID plus owner UID. Never
accept an owner UID from the client.

## 8. Call routing

### 8.1 AvaTOK destination

- Server exact-match resolves the destination.
- Use existing 1:1 or group AvaTOK calling architecture as applicable.
- Preserve the current 200 shared participant-minute monthly allowance and
  post-allowance human audio/video pricing rules.
- Do not route the call through FreJun/Vobiz.
- Store call activity against the chosen AvaTOK line where one was selected;
  otherwise use the account's canonical in-network identity line.

### 8.2 PSTN destination

Admission sequence:

1. Authenticate and rate-limit.
2. Normalize and validate destination.
3. Confirm it is not an AvaTOK destination.
4. Resolve and authorize the selected active DID.
5. Confirm voice and outbound-caller-ID capability.
6. Apply destination/country restrictions and blocklists.
7. Check provider availability.
8. Reserve wallet headroom.
9. Create an idempotent internal call attempt.
10. Place the provider call.
11. Transition only from normalized provider webhooks or verified state reads.
12. Finalize billing and append line activity.

Provider `makeCall` success means queued, not answered. Charging begins only from
the normalized confirmed answer time.

## 9. Billing

### 9.1 Monetary representation

The wallet must support deterministic fractional-token accounting. Represent
prices and usage in integer token subunits; recommended scale: 1 token = 1,000
subunits. Never use floating-point ledger amounts.

`0.50 tokens/minute = 500 subunits/minute`.

### 9.2 Outgoing PSTN settlement

- Display the price before placement.
- Reserve configurable minimum call runway before provider placement.
- Meter from provider-confirmed answer time to provider-confirmed end time.
- Bill in deterministic increments with a documented final partial-minute rule.
- Canonical default: per-second proration after answer, rounded up to the nearest
  whole token subunit.
- Use stable operation IDs per call and billing interval.
- Duplicate/out-of-order webhooks must not double-charge.
- Release unused reservation on call failure or completion.
- If balance/headroom is exhausted, terminate the PSTN call safely and settle once.
- Record the originating line, destination country, duration, rate, amount, and
  provider call reference in the wallet statement without exposing provider cost.

### 9.3 DID purchase and renewal

Use charge/reserve plus provisioning with explicit compensation and reconciliation:

- insufficient balance never reaches the provider;
- provider purchase failure releases/refunds the wallet operation;
- provider success plus database failure creates an urgent reconciliation record
  and must not automatically release the just-purchased number;
- renewal operation IDs are unique by line and billing period;
- past-due enters a grace/suspended state before release; and
- number release is confirmed, idempotent, and auditable.

## 10. Incoming activity

Every provider webhook resolves:

`provider + destination DID -> virtual line -> owner account`.

Normalize to these activity types:

- `call.incoming`
- `call.outgoing`
- `call.missed`
- `voicemail.created`
- `recording.ready`
- `receptionist.started`
- `receptionist.completed`
- `sms.received`
- `sms.sent`
- `otp.detected`

OTP is a classification of an SMS, not a separate provider transport. Preserve the
original message. OTP extraction must avoid placing the code in notification text
or analytics. Expiry is display metadata and does not delete the underlying SMS.

Every normalized item includes `line_id`, direction, remote-party key, provider
event identity, timestamps, and relevant recording/transcript references.

## 11. Inbox reuse and migration

- Add `line_id` to new voicemail, receptionist, recording, call-log, and SMS
  envelopes.
- Extend Inbox API queries to accept an authorized line filter.
- Refactor existing Inbox widgets/services into reusable line-aware components.
- Preserve per-account local-first recording cache and read/heard stores; include
  line ID in new keys where collision is possible.
- Keep old standalone Inbox behavior and deep links during the compatibility window.
- Do not fabricate a line assignment for historical events that lack one.
- Once adoption telemetry proves compatibility, redirect the standalone phone
  Inbox to Virtual Numbers and remove duplicate navigation in a later release.

## 12. Privacy, security, and compliance

- All local data is scoped by account and line.
- Exact-number AvaTOK resolution is rate-limited, abuse-monitored, and privacy-aware.
- Provider credentials and webhook secrets remain Worker secrets.
- Each provider has independent webhook verification and replay prevention.
- Raw phone numbers and OTP codes are excluded from PostHog and ordinary logs; use
  hashes, country, line kind, and capability metadata.
- Recording and transcription require the existing consent and jurisdiction rules.
- Private recordings/transcripts live in private R2 paths and per-account local
  caches; never public upload/CDN paths.
- Releasing a DID stops routing immediately but does not silently erase retained
  user content. The UI states the retention policy before release.
- Free AvaTOK number generation is rate-limited and protected against enumeration,
  squatting, recycling abuse, and impersonation.

## 13. Feature flags and configuration

Declare all keys in Worker defaults and mirror relevant values in Flutter in the
same change. Add numeric keys to the configuration validator.

- `avaCallsEnabled` — master AvaCalls label/routing switch
- `avaCallsUniversalDialpadEnabled`
- `avaCallsAvatokResolveEnabled`
- `avaCallsPstnOutboundEnabled`
- `avaCallsPstnTokensPerMinute` — numeric, default `0.50`
- `avaCallsPstnMinRunwayMinutes` — numeric
- `virtualNumbersEnabled` — master sidebar/backend switch
- `virtualNumberDidPurchaseEnabled`
- `virtualNumberFreeEnabled`
- `virtualNumberFreeMaxPerAccount` — numeric, default `5`
- `virtualNumberDidMonthlyTokens` — numeric, default `600`
- `virtualNumberSmsEnabled`
- `virtualNumberOtpEnabled`
- `virtualNumberRecordingsEnabled`
- `virtualNumberReceptionistEnabled`
- `virtualNumberPrimaryProvider` — server string enum
- `virtualNumberFrejunEnabled`
- `virtualNumberVobizEnabled`
- `virtualNumberProviderFailoverEnabled`

Master flags fail closed. Disabling a provider must stop new purchases and new
outbound calls through it without corrupting ownership or dropping access to stored
activity. Emergency behavior for inbound numbers must be provider-aware and tested.

## 14. Telemetry

Telemetry includes authenticated account identity through the existing PostHog
person setup, but event properties must not repeat raw email, phone number, OTP,
recording content, or transcript content.

Required events include:

- `avacalls_dialpad_opened`
- `avacalls_destination_resolved`
- `avacalls_route_selected`
- `avacalls_pstn_prepare_failed`
- `avacalls_pstn_started`
- `avacalls_pstn_answered`
- `avacalls_pstn_ended`
- `avacalls_pstn_settled`
- `virtual_numbers_opened`
- `virtual_number_create_started`
- `virtual_number_provisioned`
- `virtual_number_provision_failed`
- `virtual_number_renewed`
- `virtual_number_suspended`
- `virtual_number_released`
- `virtual_number_activity_opened`
- `telephony_webhook_rejected`
- `telephony_reconciliation_required`

Useful safe properties: environment, app/build version, line kind, provider, country,
capabilities, normalized outcome, duration bucket, amount subunits, failure code,
and idempotency/replay classification.

## 15. Accessibility and content rules

- Color is never the only indicator of line or event type.
- All number cards and activity types include text/icon labels.
- Screen-reader labels read number type, label, formatted number, status, and unread
  count in that order.
- Token costs always state the unit and billing basis.
- Use **AvaTOK** consistently, including the dialpad recognition blip.
- Use **AvaCalls** for the calling surface and **Virtual Numbers** for line management.
- Provider names are not shown in normal customer UI.

## 16. Implementation work packages

### AVACALLS-001 — Navigation and flags

- Rename Calls to AvaCalls.
- Register and route Virtual Numbers in both shells.
- Add dark master flags with no production rollout.

### AVACALLS-002 — Universal resolution

- Shared national/international normalization.
- Exact AvaTOK resolver with privacy/rate limits.
- Dialpad recognition states and AvaTOK blip.

### AVACALLS-003 — Virtual-line schema and APIs

- Add migrations, ownership APIs, settings, capabilities, default outgoing DID,
  idempotency, and per-account scoping.

### AVACALLS-004 — Virtual Numbers UI

- Implement the four supplied screens using production models.
- Remove dialing actions from number cards.

### AVACALLS-005 — Inbox extraction

- Make current Inbox cards, threads, playback, caching, and read/heard state line-aware.
- Mount them beneath individual Virtual Numbers.

### AVACALLS-006 — Provider registry and FreJun

- Generalize the existing Vobiz-only factory.
- Implement and contract-test FreJun.
- Remove hard-coded provider choices from domain call paths in scope.

### AVACALLS-007 — DID lifecycle

- Inventory, purchase, webhook configuration, renewal, suspension, release, refunds,
  and reconciliation.

### AVACALLS-008 — PSTN outgoing calls and billing

- DID selection, wallet reservation, placement, state machine, 0.50-token/minute
  settlement, insufficient-balance termination, and call activity.

### AVACALLS-009 — Incoming voice, SMS, OTP, and recordings

- Destination-DID ownership resolution, normalized webhooks, InboxDO delivery,
  private media, OTP classification, and notifications.

### AVACALLS-010 — Per-number receptionist

- Line settings, routing, prompts, recordings, transcripts, summaries, and charges.

### AVACALLS-011 — Migration and production rollout

- Compatibility adapters, reconciliation tooling, telemetry dashboards, security
  review, staged cohorts, provider kill-switch drill, and rollback validation.

Each work package is one issue and one commit. No build workflow is dispatched unless
the owner explicitly requests a build.

## 17. Verification matrix

Minimum automated and integration coverage:

- national, international, malformed, premium-rate, emergency, and AvaTOK inputs;
- exact-match privacy and enumeration controls;
- zero, one, and multiple DID selection;
- provider timeout before/after accepted placement;
- duplicate, missing, delayed, and out-of-order webhooks;
- answer-time versus queue-time billing;
- fractional-token rounding and wallet exhaustion;
- purchase charge/provision/database failure combinations;
- renewal, grace, suspension, resume, and release;
- inbound routing to two different DIDs owned by the same account;
- no cross-line activity leakage;
- no cross-account local cache leakage on a shared device;
- SMS versus OTP classification without logging the OTP;
- recording playback local-first and offline;
- old notification/deep-link compatibility;
- Vobiz/FreJun normalized contract parity; and
- master/provider kill-switch behavior.

## 18. Rollout and production safety

1. Land schemas, APIs, and UI with all new master flags false.
2. Apply additive migrations only after explicit production confirmation.
3. Enable internal/admin visibility without enabling purchase or calling.
4. Verify AvaTOK resolution and free-number creation.
5. Provision one real FreJun DID and verify inbound voice, SMS, recording, and release
   in an approved test account.
6. Enable PSTN outbound for the test account; verify answer-time billing and wallet
   reconciliation.
7. Test multiple DIDs on one account and prove strict line isolation.
8. Exercise provider and master kill switches.
9. Expand by controlled production cohort.
10. Remove the standalone Inbox entry only after supported-client telemetry confirms
    line-aware adoption.

Rollback disables new actions through flags while preserving number ownership,
incoming recovery paths, historical activity, and wallet audit data. Never roll back
by copying staging data or replacing the production flag blob.

## 19. Definition of done

The feature is complete when:

- Calls is visibly and consistently AvaCalls;
- the existing Dialpad correctly recognizes AvaTOK, national, and international
  destinations;
- AvaTOK calls stay in-network and PSTN calls use an owned DID;
- the customer sees and is correctly charged 0.50 tokens/minute for answered PSTN
  call time;
- Virtual Numbers supports multiple DIDs and free AvaTOK numbers;
- each number has isolated settings, threads, SMS/OTP, voicemail, receptionist
  sessions, recordings, and unread state;
- FreJun and Vobiz satisfy the same normalized provider contract;
- changing the primary provider does not break existing numbers;
- provider retries and webhooks cannot double-purchase or double-charge;
- account/line scoping prevents shared-device data leakage;
- production flags can stop each risky lane independently; and
- rollout telemetry and reconciliation prove successful outcomes, not merely request
  attempts.
