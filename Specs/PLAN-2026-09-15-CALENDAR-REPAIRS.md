# Calendar repair plan — 15 September 2026
Scope: production-targeted source changes only. Owner approval is required before production deployment and Android release.
Coordinator: runtime-confirmed GPT-6 Astra. Initial implementation: actual DeepSeek CLI workers through DeepAstra. After the provider balance failure, the owner explicitly selected GPT-5.5 workers; three parallel GPT-5.5 workers are finishing web, Android and backend corrections.

## Delivery stages
1. Preserve existing dirty files and prepare private isolated source copies without secrets, live datasets or credentials.
2. Run backend, web, and Android diary workers concurrently; run a separate active Android listing integration worker.
3. Review actual diffs and worker tool evidence. Send focused revisions for defects; do not treat worker summaries as validation.
4. Integrate accepted changes into an isolated review branch. Add targeted regression coverage and run allowed non-deploying CI checks.
5. Update the graph, produce the simple-English completion report and audit closure matrix, then wait for production/Android release approval.

## Work allocation and acceptance
| Workstream | Audit findings | Required result |
|---|---|---|
| Backend schedule/readiness | 5, 6, 7, 10 and support for A1 | Consistent Google readiness for preview/booking; oldest selected sync governs status; explicit sync endpoint; safe booking metadata in owner calendar; preserve atomic overlap, version, hold and lifecycle protections; policy origin clearly reported. |
| Web calendar and listing | 2–12 web portions | Whole-day and date-range controls; independently editable intervals and removal; visible scope; visible partial-load errors; deduplicated actionable appointments; accurate sync state; preserve horizon; useful live conflict feedback; refresh and updated timestamps. |
| Android diary/settings | 2–10, 12 phone portions and A1–A8 | Same blocking capabilities and clear scope; correct modern booking actions; diary entry point; valid limits; one agenda; consistent navigation/timezone; refresh on return/resume; no false zero; Google selection/readiness parity; accessible narrow layouts. |
| Active Android listing | 1, 11 and policy clarity | Wire the actual routed screen to shared/custom/exclusive schedules, real pickers and conflict feedback; persist listing schedule; explain draft versus reserved time; preserve existing listing/review flow. |
| Integration and validation | All | Cross-client API contract review, regression tests in CI, closure matrix separating implemented changes from unverified live scenarios. |

## Shared contracts
- Keep existing schedule API and minute intervals; end_min=1440 means end of day. Day ranges expand into bounded independent exceptions; never overwrite unrelated intervals.
- All personal busy-time actions default to creator-wide scope. Listing-specific closure is an explicit selection. A filter alone is not authorization to change the wrong scope.
- Keep existing Google-required policy on current main; use one readiness rule at picker/hold/publish. No relaxation of conflict protection.
- Additive GET gcal/status fields: ready (boolean), reason (readiness reason or null), last_success_at (oldest selected successful sync or null). Retain existing fields and per-calendar records.
- Add authenticated POST /api/calendar/gcal/sync; import busy events, return the same status shape. Bound/rate-limit repeated calls; no new permissions or external invitations.
- Additive calendar block fields: booking_id, listing_id, booking_kind and booking_status where resolvable; no ambiguous legacy IDs or cross-account records. Client deduplication uses canonical booking/listing IDs.
- Same timezone for heading, day placement, slots and appointments. Show unknown and stale distinctly from zero/empty.
- UI policy text shows inherited versus listing-specific rules and effective notice. Preserve explicit listing horizons. No payment, call pricing, or message architecture changes.

## Review and release boundary
No worker may commit, push, deploy, build, access secrets, contact live services or mutate production data.
No local build, analyzer or test runner. Tests are authored for GitHub Actions; Android packaging and production deploy workflows are not triggered.
Existing unrelated files remain untouched. Any source changes that cannot be validated are clearly listed, not described as proven.
Worker accounting will distinguish unique workstreams, actual CLI runs, revision runs, failures, tool evidence and token usage. Costs, if available, remain estimates, not receipts.

