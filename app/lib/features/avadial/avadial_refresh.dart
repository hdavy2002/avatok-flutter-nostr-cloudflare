import 'package:flutter/foundation.dart';

/// Shared revision counter for the Calls app's data-backed tabs (Contacts, Logs,
/// Block). Because those tabs live inside an [IndexedStack] they stay alive across
/// tab switches, so their `FutureBuilder`s — loaded once in `initState` — would
/// otherwise show STALE data (e.g. you block a number on the Contacts tab, switch
/// to Block, and nothing is there until an app restart — owner bug report, pic 6).
///
/// Every mutation to the account-scoped stores ([BlockList], [ContactOverrides],
/// hidden call log) bumps this notifier; each tab listens and reloads. One counter,
/// one source of truth — no per-screen wiring.
final ValueNotifier<int> avaDialRev = ValueNotifier<int>(0);

/// Bump the revision so every listening Calls tab reloads its data.
void bumpAvaDial() => avaDialRev.value++;
