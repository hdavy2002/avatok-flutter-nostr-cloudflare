# Calendar repairs — simple-English report
15 September 2026

**The calendar repairs are implemented and all focused calendar checks pass. Nothing has been deployed to production or shipped to Android. The wider release still has existing readiness blockers and needs your approval.**

## Are web and Android using the same calendar?
Yes: they use the same saved schedules and the same server checks for bookings. They have separate screens. This work brings the creator controls and their behaviour closer together.

A change saved on one device is read by the other on refresh. The screens also refresh when reopened or brought back into focus. This is not an instant live subscription between two open screens. Google busy times also need a successful sync.

## How many workers were used?
- **12 DeepSeek CLI runs across five workstreams**, including corrections and continuations. Eight had completion evidence, one timed out, and three stopped because the DeepSeek balance was insufficient. The first completion was recovered without a recorded launcher exit code.
- **3 GPT-5.5 workers**, after you asked to switch: one for web, one for Android, and one for the shared backend. The same workers handled review corrections.
- **GPT-6 Astra coordinated and reviewed** the work, rejected unsafe changes, integrated the accepted files, and ran GitHub verification.

These are actual recorded runs/workers. No exact provider invoice or total cost was available.

## What was fixed
| Area | What creators gain |
|---|---|
| Working hours | Shared hours and listing-specific hours have clearer scope. Existing notice periods and booking horizons are preserved. |
| Busy days | Whole-day blocks, several separate breaks, individual edit/remove controls, and holiday date ranges. Midnight at the end of a day keeps its correct meaning. |
| Events and 1:1 listings | The Android form creators actually use now connects to the shared calendar. It offers real pickers and shared, custom, or reserved availability. |
| Conflict feedback | Date/time changes trigger conflict feedback. Old responses cannot leave a misleading green result or old alternative times on screen. |
| Google Calendar | A connection alone is no longer presented as proof of a successful sync. Failed, old and never-synced calendars are identified, with a separate action to import busy times. |
| Booking cards | Verified booking IDs and creator/customer roles guide booking management and remove duplicates. Personal busy blocks are labelled as blocked time. |
| Android diary | The main menu opens the diary; Agenda appears once; date arrows follow the selected view; returning from settings refreshes the data. |
| Dates and timezones | Calendar dates, primary times and “Today” follow the schedule timezone, including midnight differences between devices. |
| Failed loads | Missing data is shown as unknown or needing refresh, rather than “0 available.” Failed listing loads remain visible and can be retried. |
| Changes on another device | Outdated saves cannot silently overwrite newer hours. The creator gets a clear reload/review path. Late loads also cannot silently replace edits or adopt a newer version for old edits. |
| Account changes | Calendar data and pending save steps are guarded when the active account changes. |

A conflict preview means no clash was found in the checked commitments. It is not a reservation or a guarantee that every booking rule is satisfied. Drafts do not reserve event time; publication and booking still perform the server checks.

## Audit coverage
The original report contains **20 numbered findings: 1–12 and A1–A8**. Several describe the same problem on different clients. Source changes address each group below; production acceptance is still separate.

| Findings | Repair |
|---|---|
| 1, 11 | Active Android listing integration and immediate conflict feedback on both clients |
| 2, 3, A8 | Whole-day/end-of-day handling, multiple intervals, ranges, removal and explicit scope |
| 4, A7 | Visible partial failures and unknown availability |
| 5, 6 | Shared Google readiness, per-source freshness and manual busy-time sync |
| 7, A1 | Canonical booking metadata, deduplication and correct management actions |
| 8 | Consistent schedule timezone in dates, times and Today |
| 9, 10, A3 | Safe edit scope, valid limits, preserved notice and horizon settings |
| 12, A6 | Focus/resume and return-from-settings refresh |
| A2, A4, A5 | Diary navigation, one agenda and matching date navigation |

## Verification
Executable checks run in GitHub Actions. No Android packaging or deployment workflow was started.

The final source candidate is commit `ef7c988d`, checked in [this verification run](https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/34919467619). Earlier runs found issues that were corrected before this run.

| Check | Result |
|---|---|
| Backend type checking | Passed |
| Backend calendar tests | All 64 passed, across 8 suites |
| Design rules | Passed |
| Web | Type checking and all 59 focused tests passed |
| Flutter | Analysis passed with non-fatal warnings; all 175 calendar/native-listing tests passed |
| Release-readiness definitions | Still fails on the same 28 older unrelated issue definitions; no malformed entries |

**Total: 298 focused tests passed.** The overall workflow is still marked failed because of the separate release-readiness definitions above; the calendar jobs themselves passed.

The broader backend suite was compared earlier against the unchanged starting commit: both had the same 50 failing tests. No additional failing test names appeared in that comparison. This is not a claim that the full repository test suite is green.

## What still needs a real acceptance test
Authenticated browser interaction, an installed Android build with these changes, real Google event changes, and web-to-phone/phone-to-web saves have not been tested together on the new code. Those checks need the approved release environment and test accounts. Production data was not changed to manufacture a pass.

Before calling the release fully accepted, test: whole-day blocks, two breaks, a holiday, shared versus listing-only scope, a conflicting event/1:1, simultaneous booking attempts, moving/cancelling a booking, Google sync failure/recovery, and switching accounts/devices.

## Release status
No merge to main, production deployment, APK/AAB packaging, Play submission or update notification was performed. Your separate approval is still required for production deployment and Android shipping. Existing release-readiness failures also remain visible and must be resolved before declaring the entire release healthy.

## Saved work and records
The code is on [codex/calendar-creator-repairs](https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/tree/codex/calendar-creator-repairs), isolated from main. The original audit and repair plan remain alongside this report.

The project code graph was refreshed from source. Graphiti memory updates were unavailable/failed, so no successful memory sync is claimed. The original audit reviewed existing PostHog activity; no new production success events were fabricated for undeployed code.

Process note: earlier DeepSeek workers ran a local esbuild syntax check and an offline schema check contrary to their brief. Those were not used as acceptance evidence. The GPT-5.5 continuation used source review locally and GitHub Actions for executable verification.
