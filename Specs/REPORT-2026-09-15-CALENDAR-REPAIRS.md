# Calendar repairs — progress report
15 September 2026

**Status: substantial changes are saved, but the work is unfinished and is not ready for production.** DeepSeek returned “402 Payment Required — Insufficient Balance” on three active runs. Coding is paused until its API balance is restored. Nothing has been deployed or shipped to Android.

## Who did the work
GPT-6 Astra planned the work, reviewed the changes, identified corrections, and managed integration and GitHub checks. Real DeepSeek CLI workers did the implementation, using `deepseek-flash`.

There were **12 DeepSeek worker runs across five workstreams**, including correction and continuation runs:

| Workstream | Runs |
|---|---:|
| Shared backend and booking protection | 4 |
| Web calendar and listing flow | 2 |
| Android calendar and settings | 3 |
| Active Android listing flow | 2 |
| Calendar test setup and CI | 1 |
| **Total** | **12** |

Eight runs reached completion, one timed out and was followed by a successful continuation, and three stopped because the DeepSeek balance was insufficient. The first backend completion was recovered after the chat interruption; its launcher did not record an exit code. These counts come from process records, not just worker claims.

## Changes implemented in the review branch
These are source changes; they are not live features yet. The final checks are not all passing.

- **Shared scheduling:** availability previews now follow the same Google readiness requirement as booking. Stale or missing calendar data produces an error instead of pretending there are no open slots.
- **Google Calendar:** clearer sync status, the oldest selected calendar determines freshness, and a separate “Sync busy times now” action with rate limits.
- **Booking cards:** the backend supplies booking details and the creator/customer role. It handles the long booking IDs actually produced by checkout. Web and Android can use these details to avoid duplicate cards and open booking management.
- **Busy time:** whole-day controls, separate breaks on the same day, individual editing/removal, and holiday ranges. Android edits preserve the chosen scope and existing exceptions.
- **Android diary:** the menu opens the calendar; the phone defaults to one agenda; date arrows follow the view; settings/resume refresh the diary; unknown availability is not shown as zero. Calendar times use the schedule timezone.
- **Android listing flow:** the screen creators actually use now has date/time pickers, shared/custom/exclusive availability controls, conflict feedback, schedule saving, and clearer wording about drafts not reserving time.
- **Policy settings:** shorter booking horizons are preserved. The configured notice period is shown separately from a listing’s longer booking minimum. An older-calendar migration case still needs correction.
- **Testing:** repaired calendar test setup so double-booking, holds and rescheduling are tested with the current sync requirement. Added a focused verification mode that does not package or deploy anything.

## Work still needed
1. Finish and review the interrupted web corrections: end-of-day editing, safe refresh after changing months, preserving other exceptions, and conflict feedback. Correct “Today” when the device and calendar timezones have different dates.
2. Finish Android listing protection against overwriting hours changed on another device, failed initial schedule loading, and account changes during a save.
3. Make sure a personal busy block never opens appointment management.
4. Preserve older creators’ existing notice settings when they first save through the newer calendar.
5. Fix any remaining CI failures and rerun the relevant checks. Then test the authenticated web and phone flows, including real Google changes and cross-device refresh. Those live scenarios have not been verified.

Partial work from the interrupted runs is preserved separately. It has not been mixed into the completed candidate or described as finished.

## Verification so far
The first repair run passed all **23 newly added backend calendar tests**. Its broader backend suite had exactly the same 50 failing tests as the unchanged starting commit. This comparison separates existing failures from new regressions; it does not mean the whole suite passed.

CI also found new web type errors, Android missing declarations/imports, and one forbidden color value. Completed Android corrections and further backend work are in a second focused run. The interrupted web revision still needs integration and validation.

- [First repair checks](https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/34914956003)
- [Unchanged baseline checks](https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/34915133159)
- [Focused candidate checks](https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/34916725322) — completed with failures; details below.

Latest focused results (candidate code commit `6227c654`):

| Check | Result |
|---|---|
| Design-system rules | Passed |
| Backend type checking | Passed |
| Backend calendar tests | 60 passed; 1 failed on the count of calendars that have never synced |
| Web type checking | Three new type errors remain; the interrupted correction is preserved separately |
| Flutter analysis | Failed on nullable account identifiers and a missing design-token import; Flutter tests did not run |
| Release manifest | New calendar entries are present; missing entries for older unrelated changes still fail the check |

The earlier baseline web content-type errors were resolved by generating Astro’s types in CI. Existing manifest entries were preserved; none were removed.

No Android APK/AAB was created, no production deployment ran, and no production calendar records were changed by this repair task. The code graph was refreshed using AST extraction without an AI API call.

## Where the work is saved
The completed candidate is on [codex/calendar-creator-repairs](https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/tree/codex/calendar-creator-repairs). The audit and repair plan remain in the project’s Specs folder. No merge to main has been made by this task.

The worker records also show a process deviation: the first web worker ran local esbuild syntax checks, and a backend worker ran an offline manifest-schema check despite the no-local-verification brief. These were not treated as acceptance tests. Subsequent briefs reinforced the restriction; GitHub Actions supplies the reported executable test evidence. No invoice or exact cost is available from the launcher.

## Next step
Restore the DeepSeek API balance, then resume the remaining corrections and verification. After the repairs are finished, I will provide the final completion report and wait for your separate approval to deploy production and ship Android.

The [DeepAstra skill](/Users/davy/.codex/skills/deepastra/SKILL.md) says to “stop after two repeats of the same provider failure.” Three runs returned the same insufficient-balance error, so no further DeepSeek retries or substitute coding provider were used.
