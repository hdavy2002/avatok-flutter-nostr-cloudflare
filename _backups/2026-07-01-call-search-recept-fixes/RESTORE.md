# Backup — 2026-07-01 call / search / receptionist / number-gate fixes

Taken before a multi-file change addressing production issues found in PostHog (build 0.1.17)
and reported by the owner. To restore any file, copy it back over the working tree:

```
cd /Users/davy/Documents/websites/avaTOK-2-Flutter
cp _backups/2026-07-01-call-search-recept-fixes/app/lib/features/avatok/call_screen.dart   app/lib/features/avatok/call_screen.dart
cp _backups/2026-07-01-call-search-recept-fixes/app/lib/features/avatok/contacts.dart       app/lib/features/avatok/contacts.dart
cp _backups/2026-07-01-call-search-recept-fixes/app/lib/features/avatok/search_screen.dart  app/lib/features/avatok/search_screen.dart
cp _backups/2026-07-01-call-search-recept-fixes/app/lib/features/avatok/ava_number.dart     app/lib/features/avatok/ava_number.dart
cp _backups/2026-07-01-call-search-recept-fixes/app/lib/main.dart                           app/lib/main.dart
cp _backups/2026-07-01-call-search-recept-fixes/app/pubspec.yaml                            app/pubspec.yaml
cp _backups/2026-07-01-call-search-recept-fixes/worker/src/routes/receptionist.ts          worker/src/routes/receptionist.ts
cp _backups/2026-07-01-call-search-recept-fixes/worker/src/do/reception_room_cf.ts          worker/src/do/reception_room_cf.ts
```

## What changed and why

1. **call_screen.dart** — `_send()` now swallows a write to an already-closed WebSocket
   sink (was `StateError: Cannot add event after closing` crashing on hang-up).
2. **contacts.dart** — `isCompleteEmail()` bounds-guards `indexOf(start)` (was `RangeError`
   crashing the Add-contact sheet / header search on short inputs like `a@b`).
3. **search_screen.dart** — header search now resolves an exact email / AvaTOK number the
   same way "Add a new chat" does (parity fix; email/number lookups returned empty before).
4. **main.dart** — Ably presence-lifecycle exceptions ("not currently attached" / "detached
   or failed state") are now classified non-fatal so they stop being logged as crashes.
5. **receptionist.ts** — HARD/SOFT caps raised to be pure stall-backstops so Ava's closing is
   never cut off (sitewide rule: greeting + 25s message window + untimed polite close).
6. **reception_room_cf.ts** — at time-up, Ava's close references the WHOLE captured message
   (was saying "no message" when the last turn's buffer was empty even though earlier turns
   captured a message).
7. **ava_number.dart** — `me()` no longer lets a replica-lagged empty `/me` response wipe a
   just-assigned number from the cache (was re-triggering the compulsory number gate → the
   "asked to pick a second number" bug). `release()` clears the cache.
8. **pubspec.yaml** — version bump 0.1.17+18 → 0.1.17+19 (wait: see final).
