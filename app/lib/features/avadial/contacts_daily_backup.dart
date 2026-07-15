/// DAILY CONTACT-BOOK BACKUP (owner decision 2026-07-15).
///
/// The owner's rule: **"this backup should run regardless of toggle … users might
/// toggle things off and then complain that they cannot access their contacts on
/// another device."** So a daily upload is now a DEFAULT app behaviour, not an
/// opt-in — the old `ContactBackupPrefs.enabled()` switch was removed from the UI
/// in the same change (a switch that no longer governed anything would have been
/// a lie to the user). Manual "Back up now" is untouched and still works.
///
/// WHY WORKMANAGER (owner decision 2026-07-15: "true OS background task"). An
/// app-open check only protects users who open AvaTOK; the whole point of this
/// lane is the user who *doesn't* open it for a week and then loses their phone.
/// WorkManager lets Android wake a headless Flutter isolate ~daily on its own.
/// It needs **no runtime permission** (no BOOT_COMPLETED, no exact alarms, no
/// foreground-service type) — the plugin's own manifest entries are enough, so
/// nothing new is ever prompted for. Reading contacts still rides the READ_CONTACTS
/// grant AvaDial already holds; this job never asks for it (see below).
///
/// ── What the background isolate CAN and CANNOT do ──────────────────────────
/// WorkManager spins up its OWN headless FlutterEngine. It is NOT the UI isolate:
///   • Dart statics are NOT shared — `ApiAuth.clerkBearer` and `AccountScope.id`
///     are unset here and must be re-bootstrapped from storage (that is exactly
///     what [_bootstrapIsolate] does).
///   • Only plugins registered through the generated registrant attach. AvaDial's
///     `AvaDialPlugin` is added BY HAND in `MainActivity.configureFlutterEngine`,
///     so `AvaDialChannel.readContacts()` — and therefore a fresh device-contacts
///     capture — is UNAVAILABLE here and would just throw MissingPluginException.
///     So this job uploads the LAST CAPTURED book (persisted by `AvaContactBook.
///     capture()` via DiskCache/path_provider, which does work headless). That is
///     the correct trade: the book is re-captured every time the Contacts tab
///     loads, and an at-most-slightly-stale backup beats no backup at all.
///
/// Everything is best-effort and never throws out of [executeTask] — a crash in a
/// WorkManager task gets the job retried/penalised by the OS, and a contacts
/// backup is never worth that.
library;

import 'dart:io' show Platform;
import 'dart:ui' show DartPluginRegistrant;

import 'package:flutter/widgets.dart';
import 'package:workmanager/workmanager.dart';

import '../../auth/clerk_client.dart';
import '../../core/api_auth.dart';
import '../../core/ava_log.dart';
import '../../core/disk_cache.dart';
import '../../core/remote_config.dart';
import '../../identity/identity.dart';
import 'ava_contact_book.dart';

/// Task name reported back to [Workmanager.executeTask].
const String kContactsDailyBackupTask = 'ai.avatok.contacts.daily_backup';

/// Unique work name — versioned so a future scheduling change can supersede the
/// old registration instead of silently coexisting with it.
const String kContactsDailyBackupWork = 'avatok-contacts-daily-backup-v1';

/// Device-global key holding the ACTIVE Clerk account id. MUST match `_kAcct` in
/// main.dart — it is the same value, written on every successful boot/auth. This
/// is what lets the background isolate scope itself to the right account on a
/// shared phone (parent + child accounts, per the AvaVerse rulebook) instead of
/// reading the guest scope and uploading the wrong book.
///
/// KNOWN GAP — on a shared phone only the MOST RECENTLY ACTIVE account gets a
/// daily backup; the others are not backed up until someone switches to them (at
/// which point the Contacts tab's change-triggered sync covers them anyway). This
/// key holds one id, by design — it is what the UI isolate itself boots from. The
/// fix would be a device-global LIST of known account ids and a loop that re-scopes
/// per account, which also means minting a Clerk session per account from a headless
/// isolate. That is a bigger change than this one and is deliberately not attempted
/// here; the common case (one account per phone) is fully covered.
const String _kAcctGlobal = 'clerk_account_id';

/// Entry point for the headless isolate. MUST be a top-level function and MUST
/// carry `@pragma('vm:entry-point')` or the AOT tree-shaker drops it and the task
/// silently never runs in a release APK.
@pragma('vm:entry-point')
void contactsBackupDispatcher() {
  Workmanager().executeTask((task, inputData) async {
    try {
      if (task != kContactsDailyBackupTask) return true;
      return await runDailyContactsBackup();
    } catch (e) {
      AvaLog.I.log('avadial', 'daily contacts backup task threw: $e');
      return true; // never let the OS penalise/retry-storm us over a backup
    }
  });
}

/// The actual job. Exposed (not private) so it can be driven directly in a test
/// or from a debug action without going through WorkManager.
Future<bool> runDailyContactsBackup() async {
  final ok = await _bootstrapIsolate();
  if (!ok) return true; // nobody signed in on this device → nothing to back up

  // Server kill switch. The flag lives in the Worker's KV-backed config, so the
  // daily lane can be stopped for every user WITHOUT shipping a build — the same
  // panic-off discipline as contactsBookEnabled.
  await RemoteConfig.refresh();
  if (!RemoteConfig.contactsDailyBackup) {
    AvaLog.I.log('avadial', 'daily contacts backup: disabled by remote config');
    return true;
  }

  await AvaContactBook.I.dailyBackupIfDue(source: 'daily_bg');
  return true;
}

/// Re-create, inside the headless isolate, the small slice of app state the
/// upload needs: the active account scope and a Clerk bearer.
///
/// Returns false when no account is signed in on this device (a guest has no
/// server-side book to write to).
Future<bool> _bootstrapIsolate() async {
  try {
    // Attaches the plugins registered via the generated registrant (path_provider
    // + flutter_secure_storage + http are all we need). Without this, DiskCache's
    // getApplicationSupportDirectory() throws MissingPluginException.
    WidgetsFlutterBinding.ensureInitialized();
    DartPluginRegistrant.ensureInitialized();

    final acct = await DiskCache.readGlobal(_kAcctGlobal);
    if (acct == null || acct.isEmpty) return false;
    // Scope EVERY subsequent DiskCache read to this account, exactly as the UI
    // isolate does at boot. Without this the job would read the 'guest' scope and
    // upload the wrong (or an empty) book — a cross-account leak AND a data loss.
    AccountScope.id = acct;

    // ClerkClient rehydrates `clerk_client_token` from secure storage (a
    // device-level key — the rulebook's explicit exception to per-account
    // scoping) and mints a fresh session JWT over the network, so auth works here
    // without the UI isolate ever having run.
    final clerk = ClerkClient();
    ApiAuth.clerkBearer = clerk.sessionToken;
    return true;
  } catch (e) {
    AvaLog.I.log('avadial', 'daily contacts backup bootstrap failed: $e');
    return false;
  }
}

/// Register the daily job. Called on every entry into the shell, so it MUST be
/// idempotent — hence [ExistingPeriodicWorkPolicy.keep]: if the work is already
/// queued, leave it entirely alone. The alternative, `.update`, would rewrite the
/// spec on every single app launch, and re-registering all day long is exactly how
/// a "daily" job quietly becomes a never-fires job.
///
/// The documented cost of `.keep` is that a future change to [frequency] won't
/// reach devices that already have the old work queued. That's why
/// [kContactsDailyBackupWork] carries a `-v1` suffix: changing the schedule means
/// bumping to `-v2`, which is a NEW unique name and so enqueues fresh. (Leave the
/// old name cancelled explicitly if that ever happens, or both will run.)
///
/// Android only. iOS BGTaskScheduler needs Info.plist identifiers plus its own
/// registration, and grants no ~24h guarantee — it runs when iOS feels like it,
/// based on app-usage patterns. Wiring that is a separate change; the Android APK
/// is what ships today.
Future<void> scheduleDailyContactsBackup() async {
  if (!Platform.isAndroid) return;
  try {
    // No isInDebugMode: deprecated in 0.9.x in favour of WorkmanagerDebug handlers.
    await Workmanager().initialize(contactsBackupDispatcher);
    await Workmanager().registerPeriodicTask(
      kContactsDailyBackupWork,
      kContactsDailyBackupTask,
      frequency: const Duration(hours: 24),
      // Give the OS a wide window to fold this into an existing wakeup rather than
      // burning a dedicated one — kinder to the battery, and we do not care WHEN
      // in the day it runs, only that it does.
      flexInterval: const Duration(hours: 4),
      // Don't compete with cold start; the user's first minutes matter more.
      initialDelay: const Duration(minutes: 30),
      existingWorkPolicy: ExistingPeriodicWorkPolicy.keep,
      constraints: Constraints(
        // No point waking with no network — WorkManager just waits instead.
        networkType: NetworkType.connected,
        requiresBatteryNotLow: true,
      ),
      backoffPolicy: BackoffPolicy.exponential,
      backoffPolicyDelay: const Duration(minutes: 30),
      tag: 'contacts-backup',
    );
  } catch (e) {
    // A scheduling failure must never break app start.
    AvaLog.I.log('avadial', 'daily contacts backup schedule failed: $e');
  }
}
