# Unified availability implementation coordination

Owner authorized implementation, nine Luna assignments, local APK installation and production web deployment on 2026-09-10. Parent owns integration, reviews, validation and releases.

Branch: codex/unified-availability-20260910. Do not push main until backend and migration are ready; current web workflow DOES auto-deploy main web changes.

## Assignments

1. Luna01: scheduling authority, schema, schedule/availability/conflict endpoints.
2. Luna02: web creator calendar and shared TypeScript API.
3. Luna03: native Flutter creator calendar and shared Dart API.
4. Luna04: commercial checkout/hold/lifecycle enforcement and integration.
5. Luna05: web customer listing/checkout availability picker.
6. Luna06: Flutter customer booking and slot contract repair.
7. Luna07: listing Time setup, live/fixed listing reservations.
8. Luna08: Google sync, selected calendars, lifecycle reliability.
9. Luna09: independent regression tests and integration corrections.

Concurrency is three child agents plus the parent; assignments run in waves.

## Release notes in progress

- Production selected; .avatok-target remains prod.
- ADB initially returned no attached devices; owner asked to connect/unlock/authorize phone.
- No production code deployed yet.
- Validation must cover new scheduling operations and existing commercial checkout before publication.
- Installation must preserve existing device data. Do not use scripts/push_apk.sh automatic uninstall fallback without explicit authorization.
