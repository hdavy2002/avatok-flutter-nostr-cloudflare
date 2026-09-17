# UI localization, auth layout and image delivery — implementation record

Production feature selected; local implementation approved after the audit plan. This record is an implementation candidate, not evidence of a released or fully translated product.

## Implemented design

- Auth pages retain the sticky site header below 768px with 24px breathing room. At tablet/desktop sizes the header and drawer are removed; a standalone language control remains.
- Shared public UI source catalogs serve web and Flutter. Google Cloud Translation runs only in an explicitly authorized, budgeted generation workflow, never on page visits or arbitrary public requests.
- Immutable catalogs live under an environment-specific prefix in the existing R2 BLOBS bucket, with Worker edge caching, one-year immutable response caching and ETags. Release manifests revalidate on a short interval.
- Source-hash compatibility pointers retain matching catalogs for older installed apps. Source mismatches fall back to authored copy rather than mixing revisions.
- Browser catalogs use bounded memory/Cache Storage; preferences are account-scoped. Flutter catalogs/preferences and image files are account- and environment-scoped with late-response guards.
- Locale registry contains English, Hinglish, the 22 scheduled Indian languages (including Nepali once), Bhojpuri and Awadhi. Arabic is excluded; Urdu, Sindhi and Kashmiri retain their correct script direction.
- Authored interface strings are separated from user names, wallet values, private messages and user-authored content. Existing paid chat/call translation is unchanged.
- Public website artwork uses a same-origin image helper; API media uses its own helper. Exact first-party host checks, signed/private exclusions, bounded widths and idempotence prevent accidental public transformation of private URLs.
- Authorized CI prebuild creates content-hashed public image copies and a manifest. Only hashed image paths receive immutable browser caching. CSS raster backgrounds use the same manifest during production builds.
- Browser images request Cloudflare format negotiation at quality 60; native images use WebP with explicit Accept. This is an encoding policy, not proof of 70% byte savings.
- Native listing images use the disk cache. Real locale and sampled image telemetry use the existing analytics identity linkage; no fabricated test-user events were sent.

## Source coverage recorded

Current inventory contains 10,160 source messages across 199 namespaces, including 3,608 native app messages. The web migration covers 115 India guides, eight global guides and 140 authored text/accessibility keys in the raw global preview HTML. Meaningful global raster lettering has visible text alternatives. These counts describe prepared source catalogs, not published translations or passed runtime acceptance.

## Validation performed and limits

Only source/diff review and source inventories were performed. Project instructions prohibit local builds, compiler/analyzer runs and executable verification. Regression checks were authored for authorized CI; none were run in this session. No push, build, deployment, Google billing/API call, catalog publication or live service configuration change occurred.

Existing unrelated wallet, pricing, content and preview work was retained through baseline-hash integration. No shared-tree commit was made.

The pre-existing web-deploy workflow currently has a main-branch push trigger despite the session's manual-build rule. A push can publish the web client. Do not push this candidate as an assumed build-free action.

Final app follow-up closed the explicitly inventoried profile/listing/calendar validators, date/status helpers, billing display labels, call/attachment errors, GCal/conflict wording and nested fee-label components. Validation state, serialized codes, prices, timing and private values remain unchanged. Remaining content exclusions are user/server freeform content, protocol identifiers and non-UI model prompts. Full runtime coverage is still unverified.

## Remaining release gates

1. Complete source-coverage review using web route/message inventories and app localization inventories. Extraction counts do not establish full semantic or runtime coverage. Review generated prose, rich/interpolated text, accessibility copy, raw HTML/MDX and text baked into artwork explicitly.
2. Configure a dedicated Google translation project/principal and verify actual supported target languages, API enablement and billing. Set a finite authorized generation budget. Repeated generation jobs reuse saved provider results; failed budget-limited jobs retain completed work.
3. Supply reviewed catalogs for provider gaps such as Bodo, Kashmiri and Santali and review legal, payment and safety copy. Draft seeds are not marked reviewed. No translated app release has been published.
4. Run permitted CI compilation/regression checks, resolve the Flutter localization dependency lockfile in CI, and review actual browser/device layouts, placeholder correctness, RTL, fonts, long labels and state preservation.
5. Confirm Cloudflare image transformation availability/settings and measure output codecs, byte sizes, repeat cache behavior and device decode performance. Earlier live audit probes returned 403, so no edge HIT or compression ratio is certified. Target approximately 70% aggregate byte reduction without inflating already-small assets.
6. Validate cold/warm/offline translation performance and account switching. The <=100ms warm-switch objective is unmeasured. Confirm translated SEO prerendering separately; client metadata updates do not establish localized search indexing.
7. Obtain the required specific production publication/deployment authorization. Use scripts/cf.sh for Cloudflare writes. New ui-catalogs workflow is manual-only; generation and publication default off. Partial coverage publication requires explicit acknowledgement.

## Operational references

- Shared catalogs and locale policy: shared/i18n/README.md and shared/i18n/locales.json.
- Manual workflow: .github/workflows/ui-catalogs.yml.
- Catalog generation/publication: scripts/i18n/ and scripts/cf.sh catalogs publish.
- Web adapters: web/src/lib/i18n/.
- Native adapters: app/lib/core/localization/.
- Image policy: web/src/lib/config.ts, web/scripts/prepare-public-images.mjs, app/lib/core/avatar_cache.dart.
- Source inventories: shared/i18n/web-*.json, app/localization-coverage.json, app/localization-surface-inventory.json.

Official documentation consulted: https://docs.cloud.google.com/translate/docs/languages, https://docs.cloud.google.com/translate/docs/translate-text, https://docs.cloud.google.com/translate/quotas, https://developers.cloudflare.com/images/optimization/features/, https://developers.cloudflare.com/workers/runtime-apis/cache/.

Project code graph refreshed with graphify update . (AST-only, no LLM): 1,725 code files, 18,495 nodes and 45,298 edges. This is navigation metadata maintenance, not compilation or runtime validation. Graphiti was unavailable in this session; no memory write could be made. Existing PostHog test-user telemetry was inspected during the audit; new hooks will emit actual usage data after release.

Read-only GitHub configuration inventory found no repository or production-environment variables, and no dedicated UI_TRANSLATION_GOOGLE_SA_JSON / UI_CATALOG_R2_ACCESS_KEY_ID / UI_CATALOG_R2_SECRET_ACCESS_KEY secrets. The existing CLOUDFLARE_ACCOUNT_ID repository secret is reused by the new workflow. No secret values were read or exposed; Google translation project/principal and R2 publication credentials still need configuration before an authorized job can run.

## Production setup and CI continuation

The owner subsequently authorized Google Cloud project setup using hdavy2005@gmail.com and production deployment after completion. No Google project, principal, API/billing configuration, paid request, catalog publication or production deployment has occurred. Browser sign-in required the owner's passkey and expired while awaiting it. The browser panel is left at Google's sign-in page. A one-time US$250 generation cap and Android release scope/format were requested; no answers received yet.

The release candidate is now isolated at `/tmp/avatok-ui-localization-release-20260916`, branch `codex/ui-localization-release-20260916`, pushed through commit `dc17e0253` (resolve the full SHA from git). The original shared main checkout remains dirty with other work and the earlier integration; do not release that working tree. Exact original dirty web snapshots were recovered; wallet localization was replayed onto clean HEAD. Unrelated pricing, wallet payment changes and untracked preview routes/assets were excluded. Source-only preview keys may remain unused in the catalogs.

Current prepared source inventory: 199 namespaces, 10,250 messages, 504,264 Unicode characters; app 3,628 messages, source hash `c2f72f4587d822b701c0fc33f1368a7d88a0db1c28261e8004f5a704f459e614`. Counts are source preparation, not translated or published coverage. Bodo, Kashmiri, Santali and complete curated Hinglish coverage remain unresolved.

GitHub CI round 2 passed the website build, public image URL checks (446 prepared immutable references), new catalog regression tests, actual no-paid source generation and Flutter static analysis. Flutter passed 329 tests, with five source-string contract assertions subsequently updated to check exact catalog copy and actual UI bindings. Web type errors exposed internal values incorrectly included in translation; those styles, URLs, IDs, ARIA tokens and state values were restored. The CI-resolved Flutter lockfile was integrated.

Third verification is running on the corrected commit:
- https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/35051386594
- https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/35051387746

Broader checks revealed 28 older issue IDs missing success-manifest records, plus 44 backend test failures with baseline evidence and a missing Paytm test fixture. These gates were not bypassed. Localization-related wallet and paid-consent source assertions were updated without removing their semantic checks. Full passing release verification, live codec/cache measurements, browser/device acceptance and translation-provider setup are outstanding.

The release copy makes web deployment manual-only and main-only, adds no-paid catalog checks to the existing typecheck workflow and preserves the production catalog publication guards. The existing Worker deploy workflow still applies unrelated listing migrations; use the mandated Cloudflare wrapper for a deliberate deploy-only action when release gates are satisfied. No local build/compiler/test tools were run. AST graph updates occurred through the prescribed tool and commit hook. Graphiti pre-push writes failed; no success was claimed.

### Latest CI evidence

At release commit `dc17e025378a20e22ca2ccc36614ceb365bd81fc`, Flutter analysis and the complete Flutter test job passed: 334 tests passed, two skipped. Website build, web TypeScript preflight, Worker typecheck/focused checks, catalog regression tests and actual no-paid source generation passed. The full workflows are not green: older backend failures and release-evidence gaps remain.

Bounded remediation audits were saved at `/tmp/avatok-baseline-ci-remediation-plan.md` and `/tmp/avatok-legacy-manifest-plan.md`. The 28 legacy issue records cannot honestly be certified by a blanket manifest patch; several require new discriminating telemetry and real observations. No baseline failure was waived and no telemetry was fabricated. Google sign-in, spending cap, complete language coverage, live acceptance/cache measurements and production rollout remain pending.

## Owner scope change: translation postponed

The owner cancelled translation setup and requested removal of language controls and production deployment of the other web updates. Do not resume Google/IndicTrans2 setup or bulk translation without a new request. No model installation/inference or paid translation occurred. Two Luna agents were used after the owner's explicit model override.

A separate web-only release was prepared from origin/main `54963fc3` at `/tmp/avatok-web-ui-release-20260916`, branch `codex/web-ui-release-20260916`; promotion uses isolated clone `/tmp/avatok-web-prod-promotion-20260916` to preserve the original shared dirty main. Commits: `29392e2b` manual-only web deployment; `569cad55` public image delivery; `01900379` mobile auth header/spacing and language controls removed; `2974d2ca` cached-artwork smoke checks. The unfinished full-localization branch remains separate and is not being released.

Live preflight: original sign-in artwork PNG 380,330 bytes; existing CF format=auto quality=60 transform returned AVIF 65,689 bytes (82.7% smaller), followed by CF-Cache-Status HIT. This is a single-image measurement, not an all-images guarantee.

First web-only CI run 35054142983 passed web build/image URL checks, worker focused checks, consumers and design guard. Historical app/backend ship-manifest check remains failing; no exemptions or fabricated telemetry added. Final predeployment web smoke checks are running in 35054371452. Production deployment result will be appended below; no Android release is included in this web-only scope.

### Web-only production deployment completed

Production web workflow https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/35054522641 succeeded on main release `2974d2ca`. Its exact production environment gate was approved under the owner's deployment request. Build, homepage/archive checks, help-centre checks and Cloudflare Pages publication passed. The shared root dirty main was not committed/reset; an isolated promotion clone pushed only the four owned web commits. A clone credential mismatch was resolved by using the already-authenticated hdavy2002 GitHub CLI helper for that push, without exposing credentials or changing global auth.

Live CUA checks: sign-in at390px has sticky visible header,24px auth top padding, full logo and loaded artwork;768px and1440px hide the auth header. Sign-up390px artwork loaded. Opening its mobile drawer then resizing768px closes the drawer and restores document scrolling. Homepage language selectors=0 and no broken visible images. Temporary viewport override reset.

Live hashed sign-in artwork: AVIF65,689bytes and WebP43,100bytes, bothHTTP200; observed CFcacheHIT and Cache-Control public,max-age31536000,immutable. Format=auto negotiates supported codecs; this does not guarantee the smaller codec for every image (WebP was smaller in this sample). No Google/IndicTrans2 inference, paid translation, backend/catalog publication or Android release occurred. Translation remains postponed. Graphiti prepush memory writes failed; AST graph refresh succeeded.
