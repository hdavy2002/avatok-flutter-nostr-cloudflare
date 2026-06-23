# Discuss This Chat With Ava — implementation plan

**Status:** proposal (2026-06-23) · **Owner idea:** from a Messenger session (e.g. with Sonal),
open ChatAVA and ask "what do you think about my chat with Sonal?" → Ava reads that thread,
gives an opinion, then you iterate / draft replies together.

**Verdict:** ~80% of the plumbing already exists. This adds a thread-scoped context path,
one entry point, and a "draft a reply" return action. No new datastore, no new model.

---

## 1. What already exists (reuse, don't rebuild)

| Piece | Where | Reuse for |
|---|---|---|
| Per-conversation message store | `Db.I.messagesFor(convKey)` → `List<MessageRow>` (`app/lib/core/db.dart`, `Messages` table keyed by `convKey` = `1:<peerHex>` or `g:<gid>`) | Pull the exact Sonal thread |
| On-device private index | `AvaOnDeviceRag` (`app/lib/core/ava_ondevice_rag.dart`, SQLite FTS5; DMs auto-ingest when Local Ava AI active) | Optional keyword recall across older history |
| Cloud generation w/ grounding | `AvaAiClient.I.ask(message:, context:, history:)` (`app/lib/core/ava_ai_client.dart`) → Worker Gemini proxy w/ moderation gate + daily cap | Generate Ava's opinion from the thread |
| Prompt budget caps | `AvaPromptBudget` (`app/lib/core/ava_prompt_budget.dart`, RAG ≤700 tok) | Keep long threads under budget |
| In-thread `@ava` spine | `AvaInvoke.makeHandler(convKey)` + `AvaTurnController.I.summon` (`app/lib/features/ava/ava_invoke.dart`) | Pattern for convKey-bound Ava turns; the `#ava`/`@ava` private-vs-shared model |
| ChatAVA tile + screen route | `_special('avachat', 'ChatAVA', …)` in `app/lib/shell/ava_sidebar.dart` (routed via `ava_shell`) | Where the discussion lands |
| Composer + focus + send | `chat_thread.dart` (`_composerFocus`, `_send`, `_convKey`) | Insert a drafted reply |
| AvaBrain consent | `brain_consent.dart`, server `brain_consent` table (opt-out, default ON) | Gate reading a chat with another person |

**Key architecture facts that shape the design:**

- DM content is **end-to-end encrypted**; the server brain never sees plaintext
  (`BrainApi` doc comment). So thread context for a 1:1 must be assembled **on-device**
  from `messagesFor(convKey)` and passed as the `context:` arg — never indexed server-side.
- The on-device LLM was removed (2026-06-21, too weak). Generation is cloud Gemini 3 via
  the Worker proxy, which already enforces moderation + the daily turn cap. We send
  on-device-assembled context to it per request; we do **not** persist the thread anywhere new.

---

## 2. Two entry points (both small)

### A. From inside the thread — "Discuss with Ava" (primary)
In `chat_thread.dart`, add a thread-overflow / app-bar action **"Discuss with Ava"**.
It already knows `_convKey` and the peer display name. Tapping it opens the ChatAVA screen
with a seed payload:

```dart
AvaDiscussSeed(
  convKey: _convKey!,
  peerLabel: _peerDisplayName,      // "Sonal"
  isGroup: _convKey!.startsWith('g:'),
)
```

### B. From ChatAVA — pick a conversation
In the ChatAVA screen, a "+ About a chat…" chip opens a recent-conversations picker
(from the `Chats` table) and produces the same `AvaDiscussSeed`.

Either way the screen lands in **thread-discussion mode**: it shows a context header
("Discussing your chat with Sonal · last 40 messages") and the rest is a normal ChatAVA
conversation.

---

## 3. Thread-scoped context assembly (the core new logic)

New file: `app/lib/features/avachat/thread_context.dart`

```
buildThreadContext(convKey, {maxTurns = 40}) -> String (grounding block)
```

Steps:

1. **Load** recent turns: `Db.I.messagesFor(convKey)`, take the last `maxTurns`,
   decode each `payload` JSON to `{who, text/kind}`. Skip media-only bubbles (or
   render as `[photo]`, `[voice note]`).
2. **Label** speakers as `Me:` / `<peerLabel>:` so Ava can reason about each side.
3. **Budget**: estimate tokens (≈4 chars/tok, same heuristic as `AvaPromptBudget`).
   - If under ~700 tok → pass the transcript verbatim.
   - If over → **map-reduce summarize**: chunk the thread, summarize each chunk via
     `AvaAiClient.ask` (cheap mode), then concatenate summaries + keep the **last
     ~10 raw turns** verbatim (recency matters most for "what do you think"). Cap the
     final block with `AvaPromptBudget.rag(...)`.
4. **(Optional) recall**: also run `AvaOnDeviceRag.I.contextFor(userQuestion)` to pull
   older relevant snippets about this peer and append under a `Related earlier:` heading.

Output shape handed to generation:

```
You are reviewing the user's private conversation. Be candid and useful.
--- Conversation with Sonal (last 40 messages) ---
Me: …
Sonal: …
…
--- Related earlier ---
• (chat: Sonal) …
```

---

## 4. Generating Ava's opinion + iterating

Reuse `AvaAiClient.I.ask`:

```dart
final answer = await AvaAiClient.I.ask(
  message: userQuestion,            // "what do you think about my chat with Sonal?"
  context: threadContextBlock,      // from §3, on-device assembled
  history: priorTurnsInThisAvaChat, // so follow-ups ("draft a nicer reply") keep context
);
```

- The context block is sent **once per turn** but cheaply (already summarized for long
  threads). The running ChatAVA `history` carries the back-and-forth so the user can say
  "ok now write a reply that sets a boundary" without re-sending the whole thread.
- All generation goes through the existing moderation gate + daily cap — no new server work.

---

## 5. "Draft a reply" return action (closes the loop)

When Ava proposes a reply, render it as a chat bubble in ChatAVA with two buttons:
**Copy** and **Use in chat**.

"Use in chat" pops back to the originating thread (we hold `convKey`) and **pre-fills the
composer** rather than sending — the user always reviews/edits before it goes to Sonal.
The composer controller (`_ctrl`) + `_composerFocus` already exist; expose a tiny setter
on the thread state:

```dart
// chat_thread.dart  (controller is the existing `_ctrl`)
void prefillComposer(String text) {
  _ctrl.text = text;
  _composerFocus.requestFocus();
}
```

This mirrors the existing **Ava Mode** toggle in the composer (already in the quick-tools
row per the menu work), so the affordance is familiar. We **never auto-send** a drafted reply.

---

## 6. Privacy & consent (must-haves, not optional)

- **On-device only for DM/group plaintext.** Thread context is built from local `messagesFor`
  and passed transiently as `context:`; it is **not** synced to the server brain or Vectorize.
  This matches the existing `BrainApi` E2E rule.
- **Consent gate.** Before building context, check the matching AvaBrain capability via
  `BrainConsent.isEnabled(...)` (`brain_consent.dart`; default ON, opt-out). The relevant
  keys already exist: **`avatok_dms`** ("Read my AvaTok DMs — On-device only") for 1:1
  threads and **`group_chats`** for groups (`avatok_messages` covers indexing). If the key
  is OFF, the "Discuss with Ava" action is disabled with a one-line explainer.
- **Group threads.** For `g:` convKeys the content involves multiple third parties — gate on
  `group_chats`, keep the same on-device-only rule, and note summaries stay personal + local.
- **Retention.** The ChatAVA discussion transcript follows existing ChatAVA history rules and
  is covered by "Delete my AvaBrain data" (`BrainApi.purge`). The raw thread is untouched.

---

## 7. Telemetry (PostHog) & memory

- Emit events: `discuss_with_ava_opened` (props: surface=thread|picker, isGroup),
  `discuss_with_ava_turn` (props: thread_len, summarized:bool, budget_tokens),
  `discuss_with_ava_draft_used`. Include `email` (`hdavy2005@gmail.com`) per project rule.
- After build, add a Graphiti episode (`group_id="proj_avaflutterapp"`) recording the new
  files and the on-device-context decision.

---

## 8. File-by-file change list

| File | Change |
|---|---|
| `app/lib/features/avachat/thread_context.dart` | **NEW** — `buildThreadContext()` + map-reduce summarizer (§3) |
| `app/lib/features/avachat/discuss_seed.dart` | **NEW** — `AvaDiscussSeed` model |
| ChatAVA screen (resolve exact widget behind `avachat` route in `ava_shell`) | Accept optional `AvaDiscussSeed`; render context header + thread-discussion mode; "Use in chat" / "Copy" on Ava bubbles |
| `app/lib/features/avatok/chat_thread.dart` | Add "Discuss with Ava" app-bar/overflow action (uses `_convKey`, peer label); add `prefillComposer(text)` setter |
| `app/lib/shell/ava_sidebar.dart` / `ava_shell` | Route the seed into the ChatAVA screen when opened from a thread |
| `app/lib/core/analytics.dart` (or existing PostHog helper) | The three telemetry events |
| consent check via existing `brain_consent.dart` | Gate the entry point |

No worker/D1 changes required — generation reuses the existing Gemini proxy route.

---

## 9. Phasing

1. **MVP (read-only opinion):** entry point A + `buildThreadContext` (verbatim, no summarizer)
   + `AvaAiClient.ask`. Ship behind a flag. → "Ava reads the thread and gives an opinion."
2. **Iterate + draft:** ChatAVA `history` continuity + "Use in chat" prefill.
3. **Long-thread robustness:** map-reduce summarizer + budget caps + optional RAG recall.
4. **Picker entry (B)** + group-thread handling + telemetry polish.

---

## 10. Open questions for the owner

1. **Scope of "the chat":** last N messages (proposed: 40) vs the whole thread vs a date range?
2. **Drafting:** always land in the composer for review (proposed), or also offer a `#ava`-style
   shared draft both parties can see?
3. **Free-tier gating:** this consumes Gemini turns — count it against the existing AI daily cap,
   or give "Discuss with Ava" its own small allowance?
4. **Groups:** allow discussing group threads at launch, or DMs only for v1?
