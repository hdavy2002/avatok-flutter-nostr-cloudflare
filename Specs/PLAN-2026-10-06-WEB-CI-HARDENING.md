# WEB-CI-HARDEN-1 — web CI contracts and runtime

Approved implementation plan and audit record, 2026-10-06. Scope: improve signal, reproducibility and setup latency in the manually dispatched web release checks. Production remains `main` only and retains its approval environment. This work does not authorize a build, dispatch or production deployment.

## Audit: 15 failed runs

The reviewed web-deploy failures from September 29 through October 5 comprise **8 stale or over-specific contracts, 6 real defects and 1 timing race**. The classification records the reviewed cause; it does not excuse a failed gate or imply that every affected check should be removed.

| Run | Classification | Evidence / disposition |
| --- | --- | --- |
| `37353861539` | Stale contract | Extracted footer no longer matched the browser's `.footer-group` selector. Preserve deliberate automation hooks or replace them with explicit behavioral hooks. |
| `37353051198` | Stale contract | Guide/article checks expected retired bazaar footer classes after the approved shared-chrome change. |
| `37352124536` | Stale contract | Explore category button/anchor contract drift during footer extraction. The complete category/filter behavior remains required. |
| `37343748217` | Stale contract | Case-sensitive `Illustrative preview` copy check failed on equivalent approved copy. |
| `37229648346` | Over-specific contract | Transformed card bounding boxes were used to infer layout rows. Fixed in `559655e5`. |
| `36969392033` | Over-specific contract | A document-wide header count rejected a nested semantic header. Product adjustment recorded in `b445166d`; future checks must target the shared site header. |
| `36662435466` | Stale test infrastructure | Data-URL module loader could not resolve `./env`. Fixed in `7cb15349`. |
| `36544102606` | Stale contract | Browser still expected `All pujas` after an approved navigation change. Fixed in `da4266c2`. |
| `37340611324` | Real defect | Typography below 16px and overflow. Fixed in `76d2212b`. |
| `37288906003` | Real defect | Compact layout overflow at 200% text. Fixed in `030dc3a2`. |
| `37228407675` | Real defect | Broken `/#experiences` destination. |
| `36898290712` | Real defect | Undefined `--primary` CSS variable. Fixed in `2314fb79`. |
| `36800469915` | Real defect | `/free-videos` missing from the sitemap. Fixed in `387c3739`. |
| `36595410296` | Real defect | Astro parse failure in EventPage. |
| `37290580452` | Timing race | Native dialog close was observed before queued focus restoration. Fixed in `886910f3`. |

Setup cost was material: run `37340611324` spent **11m53s installing Playwright OS dependencies** before reaching the substantive failure. The runtime changes below remove that repeated browser/OS installation step; elapsed-time improvement still needs measurement in an authorized CI run.

## Observed warnings, separate from failures

The successful run `37355089770` still reported Node 20 action deprecation/forced Node 24 notices, an `ubuntu-latest` migration notice for Ubuntu 26, and annotations for existing Worker TypeScript debt covered by the approved baseline. Deployment also showed deprecated-package notices and a missing Preeti sync token. The latter was nonfatal and unrelated to the browser failures.

This issue adopts Node 24-native action runtimes and pins `ubuntu-24.04` to address the runtime/OS drift warnings. It does **not** expand the Worker diagnostic baseline, silence new diagnostics, remove deprecated packages indiscriminately, add production secrets or change the best-effort Preeti behavior. Existing dependency and TypeScript warnings may remain until their own scoped fixes.

## Design rules for durable checks

1. Assert user-visible behavior and explicit semantic hooks. Do not infer identity from incidental CSS class strings, presentation casing, transformed coordinates or unrelated nested semantic elements.
2. Keep exact contracts where exactness matters: the complete approved category set/order, filter state, stable route destinations, privacy and sample disclosures, authentication/account isolation, payment recovery, brand configuration, SEO, accessibility, image delivery and performance limits.
3. Scope site-chrome checks to the actual shared header/footer markers. New page sections may legitimately contain their own header elements.
4. Retain real-defect gates: readable font floors, 200% text, no overflow or clipped/overlapping content, valid anchors, correct CSS tokens, sitemap coverage and compilation.
5. Wait for the actual end state of asynchronous interactions, including focus restoration and closed-dialog state. Do not replace race-sensitive checks with arbitrary long sleeps or remove keyboard/focus assertions.
6. When a failure exposes stale implementation assumptions, update the contract to the approved behavior and retain its substantive safety assertion. Do not weaken checks merely to produce green CI.
7. Keep runtime and browser versions reproducible. Browser package and official image versions must be changed together; do not install an untracked package over a completed `npm ci`.
8. Keep failure evidence available, and measure setup versus test duration separately. A shorter run is not evidence that an omitted check was unnecessary.

## Workflow topology

`hdfc-safety` and `build` start independently. The build retains the dispatch/branch guard, brand checks, build and account/session checks. Its aggregate release-contract runner executes homepage/archive, help, SEO/OG, performance, brand-leak and public-image checks independently, reports all failures, then fails the gate if any check failed. It uploads the exact `web/dist` output only after that aggregate passes, including for `publish=false`, because the browser job needs that artifact.

`browser-check` depends on `build`, downloads that artifact, and runs the existing homepage desktop/mobile browser suite in the matching Playwright container. It does not rebuild or create a second candidate artifact. The reusable HDFC workflow retains its independent Worker and web jobs, including TypeScript delta, real-SQL receipt/recovery, invitation invariants, payment controllers and customer/admin browser interactions.

`deploy` requires **all three** of `build`, `hdfc-safety` and `browser-check`. It still requires `publish=true`, consumes the same SHA-named artifact, and retains `environment: production`. The build guard still rejects non-manual triggers and rejects publishing from any branch except `main`. No push trigger, unconditional deployment or gate bypass is introduced.

## Runtime and dependency changes

- Both workflows explicitly select **Node 24**. All jobs pin `ubuntu-24.04` instead of following an OS migration implicitly.
- Action metadata was inspected: `actions/checkout@v5`, `actions/setup-node@v5`, `actions/upload-artifact@v6`, `actions/download-artifact@v7` and `cloudflare/wrangler-action@v4` declare Node 24. Existing action inputs and production secrets remain unchanged. Earlier artifact action majors did not all declare Node 24, so a blanket same-major upgrade would not establish this property.
- `@playwright/test` is an exact `1.56.1` web devDependency. The lock includes matching `playwright` and `playwright-core` packages. Its optional Darwin-only `fsevents@2.3.2` is nested under Playwright, preserving the existing unrelated root `fsevents@2.3.3` resolution.
- The homepage browser job and HDFC web job use `mcr.microsoft.com/playwright:v1.56.1-noble` with `--ipc=host`. This supplies matching browser binaries and OS libraries at its baked-in `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`. Its bundled Node 22 is explicitly superseded by the Node 24 setup step before dependency installation or tests. `npm ci` still installs the locked JS test package; the container is not a substitute for dependency installation.
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` makes the preinstalled-browser intent explicit. The repeated `npm install --no-save --package-lock=false` and `playwright install --with-deps` steps are removed. The HDFC browser CLI uses `npx --no-install` to fail if the declared dependency is absent.
- Homepage evidence is uploaded with `if: always()` and its existing three-day retention. HDFC browser failure traces/results retain the existing failure upload and seven-day retention. The build artifact retains hidden files and one-day retention.
- `check-release-contracts.mjs` is the production post-build gate. It gives every independent contract its own process, GitHub log group and failure annotation, then exits nonzero when any failed. `check-homepage.mjs` still invokes the brand-leak guard when called directly by another workflow; the aggregate sets `CI_CONTRACT_AGGREGATE=1` to avoid running that same check twice.

Reference: [Playwright CI containers](https://playwright.dev/docs/ci#via-containers) and [official Docker guidance](https://playwright.dev/docs/docker). The official image tag was confirmed available in the Microsoft Container Registry. Registry package metadata supplied exact tarball URLs/integrities for [the test package](https://registry.npmjs.org/@playwright%2ftest/1.56.1), [Playwright](https://registry.npmjs.org/playwright/1.56.1), [Playwright Core](https://registry.npmjs.org/playwright-core/1.56.1) and [the optional macOS dependency](https://registry.npmjs.org/fsevents/2.3.2).

## Acceptance criteria

| ID | Required outcome | Verification boundary |
| --- | --- | --- |
| CI-1 | Manual-only trigger, main-only production publication and production environment approval remain enforced. | Workflow source inspection; authorized CI branch/publish behavior later. |
| CI-2 | Build and HDFC safety run concurrently; deployment requires both and the browser job. | Inspect dependency graph; confirm job timing in authorized CI. |
| CI-3 | HDFC/payment, Worker diagnostic delta, account isolation, brand, homepage/archive, help, SEO/OG, performance and image checks remain required. | Compare workflow step commands and conditions; full CI execution later. |
| CI-3A | Independent release contracts all run and are summarized before the build gate fails; a failed aggregate never uploads the deployable artifact. | Inspect the registry, exit aggregation and step ordering; demonstrate with controlled failures in an authorized non-publishing CI run. |
| CI-4 | Node 24 across both workflows and Node 24-native action versions; fixed Ubuntu 24.04 runner/container generation. | Inspect workflow/action metadata; record actual runtime versions in CI logs. |
| CI-5 | Exact Playwright 1.56.1 package/lock/image alignment; no runtime untracked install or repeated OS browser setup. | Parse manifests and inspect workflow source; clean CI `npm ci` is final installability verification. |
| CI-6 | Browser checks use the build artifact that deployment will publish, including validation-only runs. | Match upload/download names and dependency edges; exercise `publish=false` in an authorized run. |
| CI-7 | Browser failures still retain screenshots/metrics/traces or available result evidence. | Inspect upload conditions/paths; verify artifacts after a failing CI run. |
| CI-8 | Browser/source contract hardening preserves real-defect, accessibility, keyboard/focus and product checks. | Review companion contract diffs; run unchanged-strength suites only in authorized CI. |
| CI-9 | No local build/test, shared-node_modules mutation, automatic dispatch or deployment is needed to author this change. | Work log and explicit command review. |

## Authoring checks and remaining validation

Lock changes were made surgically from authoritative registry metadata, without `npm install`, package-lock-only installation or node_modules edits. Existing package resolutions remain intact. Permitted checks are JSON/YAML syntax parsing, source/diff inspection and `git diff --check`; they are not substitutes for a clean dependency install or browser run.

The first owner-authorized CI run must validate clean `npm ci`, the official container/browser path, all retained suites, artifact transfer and actual setup latency. Production deployment remains a separate authorized action after successful gates and its environment approval. No local compiler, build or test is run as part of this implementation.
