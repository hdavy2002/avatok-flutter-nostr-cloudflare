# Ava Creative Studio: Higgsfield Tools and Continuous Job Presence

**Status:** Implementation specification  
**Date:** 2026-08-23  
**Environment:** Production design; implementation must remain feature-flagged until tested  
**Owner intent:** Ava is an intelligent participant in private and public chat. She may brainstorm with everyone, but only the person who initiates and pays for a generated asset may approve paid generation.

## 1. Outcome

Ava gains a bounded Creative Studio for:

1. UGC advertisements.
2. Music videos cut to the supplied music, without lip sync in the test phase.
3. Later creative capabilities such as dubbing, Shorts, faceless videos, voice changes, thumbnails, and brand kits.

Ava reasons over the actual conversation and attachments through Vertex Gemini. She does not invoke arbitrary Higgsfield operations directly. She produces a validated creative intent; deterministic server code owns authorization, price checks, queueing, provider calls, retries, storage, assembly, and delivery.

Every accepted operation has one durable job identity. From the instant Ava says she is working until the job succeeds, fails, is cancelled, or expires, the chat must show an authoritative live state. Ava must never post “Starting production” without either creating a durable job or immediately posting a visible failure.

## 2. Non-negotiable product rules

### 2.1 Ava is a participant, not a messenger

- In public `#ava` mode, all visible participants may speak to Ava and shape the brief.
- Ava reads the recent shared conversation, relevant saved project state, and approved attachments.
- Ava responds to the person who addressed her while maintaining the shared idea.
- Ava must not answer with presence-based handoff copy such as “Davy is online and will handle it” when the conversation is asking Ava to reason or create.
- The behaviour is semantic and model-driven. Topic keyword lists may route coarse capability families but must not compose Ava's substantive answer.

### 2.2 Paid approval belongs to the initiator

- The first participant who starts a paid creative project becomes `initiator_uid` and `payer_uid`.
- Everyone may add ideas, references, corrections, votes, and requested revisions.
- Only `initiator_uid` may approve a credit-spending generation or regeneration.
- A non-initiator approval receives a natural response naming the initiator and explaining that their approval is required.
- Authorization is enforced in server code, not only in the model prompt.
- Project ownership must survive reconnects, app restarts, delayed messages, and provider retries.

### 2.3 Attachments are first-class context

Ava must accept chat references including images, video, audio, lyrics, documents, PDFs, brand guides, and URLs where permitted.

For every attachment used in a creative project:

- Display an immediate, correlated state such as `Reading the brand guide…`, `Listening to the reference track…`, or `Studying 3 product images…`.
- Do not claim to have read an attachment until ingestion succeeds.
- Store only safe derived metadata in the job record; do not put raw private content into telemetry.
- Respect private/E2E limitations and per-account storage scoping.
- On an unsupported, inaccessible, or corrupt input, end the ingestion state with a visible explanation and recovery action.

### 2.4 Higgsfield credit truth

- Higgsfield MCP generations consume plan credits. Do not implement `use_unlim` or assume web “unlimited” generations apply to MCP.
- Discover live MCP tools, model identifiers, schemas, workflow identifiers, and account capabilities after OAuth.
- Run cost preflight before every billable batch or generation step when the provider supports it.
- Do not hard-code unverified prices or concurrency limits from the builder brief.
- Enforce application-side per-user, per-project, and global test caps even if the provider has its own limits.

### 2.5 Existing Google generation remains available during the test

- Higgsfield is introduced behind a provider feature flag.
- Do not delete the existing Google media pipeline during the test phase.
- Provider selection and emergency fallback are deterministic policy decisions, never improvised silently by Ava.
- If fallback would materially change quality, model, price, duration, or capability, obtain initiator approval again.

## 3. Ava-facing domain tools

These are product tools exposed to Ava's Vertex tool-calling loop. Raw Higgsfield MCP tools remain behind the server adapter.

### 3.1 `creative_brief_start`

Creates a project and returns known/missing/ambiguous fields.

Input:

```json
{
  "conversation_id": "string",
  "product": "ugc_ad | music_video",
  "initiator_uid": "authenticated speaker",
  "attachment_ids": ["string"]
}
```

Output includes `project_id`, `initiator_uid`, `payer_uid`, `brief_version`, known slots, missing slots, attachment states, and next recommended conversational action.

### 3.2 `creative_brief_update`

Applies an idea from any participant to the shared brief. Each update records speaker identity and produces a new immutable brief version. Conflicts are surfaced for discussion rather than silently overwritten.

### 3.3 `creative_asset_picker_present`

Creates a choice card containing provider-generated or uploaded candidates. The card supports selection, rejection, “more like this,” and “none—try again.” Selection does not itself authorize final generation unless it is explicitly the final paid approval step.

### 3.4 `creative_approval_request`

Freezes a reviewable brief version and posts a recap card containing:

- Deliverable and duration.
- Format and destination.
- Creative direction.
- Selected assets.
- Estimated credit range.
- Known compromises or unsupported requests.
- `Approve`, `Change`, and `Cancel` controls.

Only the initiator receives an enabled `Approve` control. Other participants may use `Change` and continue brainstorming.

### 3.5 `ugc_ad_create`

Creates one durable creative job from an approved UGC brief version. The tool returns a `job_id` before any conversational success acknowledgement is posted.

### 3.6 `music_video_create`

Creates one parent job with scene child jobs. It validates music duration and scene timings before spending credits. Test phase is cut-to-beat and explicitly excludes lip sync.

### 3.7 `creative_job_get`

Returns safe state, current stage, progress, queue position if known, last heartbeat, recoverability, and completed artifacts. It lets Ava answer “what is happening?” from facts.

### 3.8 `creative_job_cancel`

Cancels future work, releases unspent reservations, and records whether already-submitted provider operations could be stopped.

### 3.9 `creative_scene_revise`

Regenerates selected child scenes against a new approved brief version without recreating unaffected work.

## 4. Validated intent contracts

### 4.1 Common fields

```json
{
  "schema_version": 1,
  "project_id": "uuid",
  "conversation_id": "string",
  "initiator_uid": "string",
  "payer_uid": "string",
  "brief_version": 4,
  "product": "ugc_ad",
  "target_duration_seconds": 15,
  "aspect_ratio": "9:16",
  "resolution": "720p",
  "language": "en",
  "reference_asset_ids": [],
  "approved_by_uid": "string",
  "approved_at": 0
}
```

The server rejects missing, stale, mismatched, or non-initiator approval. It also rejects any intent whose approved brief version is no longer current.

### 4.2 UGC slots

- Product and product assets.
- Target customer.
- Platform/destination.
- Goal and call to action.
- Offer and mandatory claims.
- Tone and creator style.
- Spoken language and voice direction.
- Duration and aspect ratio.
- Hook, proof/demo, payoff, and closing CTA.
- Brand constraints and prohibited claims.

### 4.3 Music-video slots

- Source audio and exact duration.
- Lyrics when available.
- Story/theme, mood arc, visual genre, and era.
- Performer/character references.
- Aspect ratio and resolution.
- No-lip-sync acknowledgement for test phase.
- Scene density and transition style.
- Must-include and must-avoid elements.
- Opening, climax, outro, and final fade treatment.

## 5. Durable execution architecture

### 5.1 `CreativeProjectDO`

One object per `project_id` owns:

- Initiator/payer identity.
- Participants and permissions.
- Evolving versioned brief.
- Attachment ingestion records.
- Asset-picker choices.
- Approval records.
- Parent/child job references.
- Safe audit trail.

The DO serializes concurrent participant updates and approval races.

### 5.2 `CreativeJobDO`

One object per parent job owns the state machine, heartbeats, child jobs, retries, compensation, assembly, and terminal outcome. It may enqueue work but must never perform a multi-minute provider wait in an unprotected request lifetime.

### 5.3 `GenerationQueueDO`

A global coordinator controls:

- Corporate-account concurrency.
- Fairness between paying users.
- Per-user and per-project caps.
- Provider backoff and circuit breaking.
- Queue position and approximate wait based on measured history.
- Idempotent dispatch keyed by child job ID.

Do not assume eight slots until measured. Concurrency is configuration with a conservative default and emergency kill switch.

### 5.4 `HiggsfieldClient`

Responsibilities:

- OAuth connection and refresh.
- MCP initialization and live tool discovery.
- Schema validation.
- Account/credit query.
- Cost preflight where available.
- Generation submission.
- Poll/wait normalization.
- Cancellation where supported.
- Provider error normalization.
- Immediate import of completed results into R2.

OAuth refresh material must be encrypted with an application-held secret, narrowly accessible, rotated, and audited. Never log tokens or raw provider payloads.

### 5.5 Assembly container

Music-video assembly uses a Cloudflare Container running FFmpeg to:

- Analyze or consume the scene timeline.
- Trim clips precisely.
- Join clips without timeline drift.
- Preserve the original music as the authoritative audio track.
- Apply planned transitions.
- Fade visuals at the ending.
- Encode the final delivery format.
- Upload the result to R2.

The assembler must be idempotent by `assembly_job_id` and able to resume from already completed child scenes.

## 6. Continuous presence and job-state contract

This section is release-blocking.

### 6.1 Root problem

The current system has two different lifecycles:

1. A short Ava conversational turn, represented by `ava_status` and a local working indicator.
2. A durable `ai_media_job`, represented by a job card.

Ava may post “Starting production…” during lifecycle 1. The turn is then closed with `phase:end`. If lifecycle 2 is not visibly established—because the job was not yet created, its envelope was lost, hydration failed, the client is old, or the provider call is still blocking inline—the screen becomes silent even though Ava promised work.

The visible text bubble is not proof of accepted work. A durable job record is.

### 6.2 Required invariant

From user approval until terminal outcome:

```text
visible_turn_indicator OR visible_durable_job_card = true
```

There must never be a frame where both are false while server state is pending, queued, running, retrying, assembling, or delivering.

### 6.3 Create-before-promise rule

- Ava may say `Preparing your project…` while the conversational turn is still active.
- Ava must not say `Starting production`, `Generating`, `Filming`, or equivalent until a durable `job_id` exists.
- The server creates the job first, persists it, then posts one job envelope containing `job_id`, `kind`, and initial state.
- The client acknowledges that envelope by inserting the job card.
- Only after the job envelope has been emitted may the turn-level status end.
- If creation fails, end the turn indicator and post a terminal failure in the same operation.

### 6.4 Handoff acknowledgement

The client sends a lightweight `job_card_seen(job_id, device_id)` acknowledgement after the card is inserted. The server does not depend on this for correctness, but missing acknowledgements are telemetry evidence of delivery/render failure.

On older clients without this card contract, the server maintains a correlated persisted status message until completion or failure.

### 6.5 State machine

Parent job states:

```text
preparing
  -> awaiting_assets
  -> awaiting_approval
  -> queued
  -> generating
  -> retrying
  -> assembling
  -> delivering
  -> succeeded | failed | cancelled | expired
```

UGC may use `casting`, `product_imaging`, `script_planning`, and `filming` as stages. Music video may use `analyzing_audio`, `scene_planning`, `hero_selection`, `generating_scene`, and `editing`.

Every transition persists before broadcast and contains:

```json
{
  "job_id": "uuid",
  "event_seq": 12,
  "state": "generating",
  "stage": "filming",
  "progress": 42,
  "label": "Filming scene 3 of 7…",
  "updated_at": 0,
  "heartbeat_at": 0,
  "terminal": false
}
```

The client applies events only when `event_seq` is newer than its cached version.

### 6.6 Heartbeats and stale detection

- A running coordinator updates `heartbeat_at` at least every 20 seconds while actively orchestrating.
- Provider polling may use a slower cadence, but the parent job still emits a user-facing heartbeat or freshness update at least every 30 seconds.
- Repeated heartbeats need not create new chat bubbles; they update the existing card animation and “updated just now” state.
- If no heartbeat is observed for 60 seconds, show `This is taking longer than expected—still checking…` and automatically reconcile from the server.
- If the server cannot prove live work after the configured stale limit, transition to `retrying` or a terminal `failed`; never leave an infinite spinner.

### 6.7 Reconnect and restart

On thread open, foreground, WebSocket reconnect, and push-open:

- Fetch all non-terminal jobs for the conversation.
- Restore cards from the per-account scoped cache immediately.
- Reconcile each card with the server.
- Keep succeeded/failed/cancelled cards in history.
- Never reconstruct ownership or authorization from UI messages alone.

### 6.8 User-visible behaviour for the reported screenshot

After the valid initiator says `go ahead`, the expected sequence is:

1. Immediate animated indicator: `Preparing your song…`.
2. Durable card appears: `Song queued` or `Generating your track…`.
3. The temporary indicator disappears only after the card is present.
4. The same card continues animating and advances through provider and delivery stages.
5. After 30 seconds without a material update, the card still visibly shows activity and a freshness message.
6. Success replaces the working card with the playable song.
7. Failure replaces it with a clear error and `Retry` action.

No additional user message such as “try again” may be required merely to wake the pipeline.

## 7. UGC workflow

1. Ava detects/starts a UGC project from meaning, not a hard-coded phrase.
2. Ava and participants fill the brief naturally.
3. Attachments ingest with visible, correlated states.
4. Ava presents product/creator/style candidates when needed.
5. Ava posts a final recap and cost range.
6. Initiator approves.
7. Server atomically validates approval, reserves the cap, creates the parent job, and emits its card.
8. Planner produces a structured shot list.
9. Queue dispatches deterministic image/video/audio operations.
10. Failed child scenes retry within policy; accepted scenes are never regenerated unnecessarily.
11. Assembly completes, R2 becomes authoritative, credits reconcile, and the card becomes ready.

Initial supported delivery: 15 seconds, 9:16, 720p, one output. Expand only after measured reliability and cost.

## 8. Music-video workflow

1. Ingest and analyze the authoritative audio.
2. Validate exact duration.
3. Generate a timestamped scene plan whose total equals the audio duration.
4. Present performer/hero/style candidates.
5. Initiator approves the frozen plan and cost range.
6. Create the parent job before posting any production promise.
7. Generate short scene clips through the queue.
8. Permit selective scene retries.
9. Assemble against the original audio.
10. Start the visual outro before the final beat and fade visuals naturally through the ending.
11. Upload to R2, reconcile credits, and replace the job card with the final video.

Test-phase constraint: no lip sync. Ava must state that limitation before approval when a concept visibly expects singing mouths.

## 9. Client surfaces

- Shared creative-brief recap card.
- Missing-information quick replies, without turning the conversation into a questionnaire.
- Attachment-ingestion card.
- Three-up or configurable asset picker.
- Initiator-aware approval card.
- Durable multi-stage job card.
- Queue position when truthful and available.
- Cancel, retry, revise scene, open, download, share, and save controls as appropriate.
- Animated state must respect reduced-motion settings while retaining a visible textual state.
- All cached job state and downloaded previews are per-account scoped.

## 10. Configuration and rollout controls

Minimum flags:

- `higgsfieldCreativeStudioEnabled`
- `higgsfieldUgcEnabled`
- `higgsfieldMusicVideoEnabled`
- `higgsfieldOwnerAllowlist`
- `higgsfieldGlobalConcurrency`
- `higgsfieldPerUserDailyCreditCap`
- `higgsfieldGlobalDailyCreditCap`
- `creativeJobPresenceV2Enabled`
- `creativeAssemblyEnabled`

Production defaults remain off until the respective acceptance suite passes. Flags are changed individually; staging state is never copied wholesale into production.

## 11. Telemetry and audit

Required events include safe identifiers and timing, never raw prompts, lyrics, documents, OAuth tokens, or provider responses:

- `creative_project_started`
- `creative_attachment_ingest_started|completed|failed`
- `creative_brief_updated`
- `creative_approval_requested|approved|rejected|unauthorized`
- `creative_job_created`
- `creative_job_envelope_emitted`
- `creative_job_card_seen`
- `creative_job_transition`
- `creative_job_heartbeat`
- `creative_job_stale_detected`
- `creative_provider_submitted|completed|failed`
- `creative_scene_retry`
- `creative_assembly_started|completed|failed`
- `creative_job_completed|failed|cancelled`

For presence diagnosis, record `turn_status_started_at`, `job_created_at`, `job_envelope_emitted_at`, `job_card_seen_at`, `turn_status_ended_at`, and `first_terminal_at`. Alert when `turn_status_ended_at < job_card_seen_at` by more than the allowed rendering handoff or when a promise bubble exists without `job_created_at`.

## 12. Acceptance criteria

### 12.1 Continuous presence

- After approval, a visible indicator appears within 250 ms locally.
- A durable job is created before any production promise.
- Turn indicator to job-card handoff has no visible gap.
- Killing and reopening the app restores the non-terminal card.
- WebSocket loss followed by reconnect reconciles state.
- A provider timeout becomes a failed/retryable card, never silence.
- An unrelated Ava answer cannot remove a running job card.
- Two concurrent Ava jobs update independently by `job_id`.
- A late status event cannot close or overwrite a newer job.

### 12.2 Authorization

- Every participant can update the shared brief.
- Non-initiator approval is refused without spending credits.
- Initiator approval of the current brief version starts exactly one job.
- Duplicate approval produces the same job ID and no duplicate charge.
- A changed brief invalidates an older approval.

### 12.3 UGC

- One 15-second 9:16 UGC ad completes from an uploaded product image.
- Cost is checked and capped before dispatch.
- Each stage is visible.
- One failed scene retries without regenerating completed scenes.
- Final asset is stored in R2 and opens from the chat card.

### 12.4 Music video

- One 30-second test video uses the exact uploaded audio duration.
- Scene plan has no gaps or overlaps outside transition tolerances.
- No lip-sync capability is promised.
- Final visuals close deliberately and fade with the audio ending.
- A rejected scene can be replaced without recreating the entire video.

## 13. Delivery order

### Phase 0 — live Higgsfield discovery

- Connect corporate OAuth.
- Discover live tools/models/schemas.
- Verify balance and cost operations.
- Generate one image and one short clip.
- Measure concurrency, polling, cancellation, result URL lifetime, and actual credit use.

### Phase 1 — presence repair and UGC vertical slice

- Ship the continuous job-presence contract first.
- Owner allowlist only.
- One uploaded product image to one 15-second 9:16 ad.
- R2 delivery, cost cap, cancellation, retry, PostHog timings.

### Phase 2 — full shared UGC brainstorming

- CreativeProjectDO.
- Attachment ingestion and picker loops.
- Initiator recap/approval.
- Multiple UGC variations and selective retries.

### Phase 3 — music-video pilot

- 30-second source audio.
- Scene planner, hero selection, child jobs, FFmpeg assembly.
- Expand to 60 seconds only after measured reliability.

### Phase 4 — expanded Creative Studio

- Longer videos, dubbing, Shorts, faceless videos, voice tools, brand kits, and thumbnails.

## 14. Explicitly out of scope for the first release

- Lip sync.
- Voice cloning without a separate consent and abuse-prevention specification.
- Arbitrary raw MCP access by Ava.
- Unlimited corporate-credit use.
- Deleting the existing Google media provider.
- Assuming unverified provider pricing, tool names, or concurrency.
- Production enablement before owner-only acceptance testing.

