import 'dart:async';
import 'dart:convert';
import 'dart:math' show min;

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/ava_log.dart';
import '../../core/config.dart';
import '../../core/disk_cache.dart';
import 'contact_backup_role.dart';
import 'contact_groups.dart';
import 'contact_overrides.dart';
import 'device_contacts.dart';

/// One entry in the **AvaTOK contact book** — a local, AvaTOK-owned snapshot of a
/// contact (owner request 2026-07-13). This is what makes AvaTOK independent of
/// Google/Gmail: contacts live locally here AND (Phase 2) get backed up to AvaTOK's
/// own servers, so losing a Google account or a SIM never locks the user out.
///
/// It merges the device phone book with AvaTOK's own extra fields (AvaTOK number,
/// emails, LinkedIn, custom fields) into one portable record.
class AvaBookContact {
  final String name;
  final String number;
  final String? avatokNumber;
  final String? personalEmail;
  final String? businessEmail;
  final String? linkedin;
  final List<ContactField> customFields;
  final String source; // 'device' | 'avatok'

  /// [AVADIAL-GROUPS-3] The colour-group marker (see [ContactGroup]) this
  /// contact is filed under, if any. The server stores each contact as opaque
  /// JSON inside the encrypted blob, so this round-trips with no server work.
  final String? groupId;

  const AvaBookContact({
    required this.name,
    required this.number,
    this.avatokNumber,
    this.personalEmail,
    this.businessEmail,
    this.linkedin,
    this.customFields = const [],
    this.source = 'device',
    this.groupId,
  });

  Map<String, dynamic> toJson() => {
        'name': name,
        'number': number,
        if (avatokNumber != null) 'avatokNumber': avatokNumber,
        if (personalEmail != null) 'personalEmail': personalEmail,
        if (businessEmail != null) 'businessEmail': businessEmail,
        if (linkedin != null) 'linkedin': linkedin,
        if (customFields.isNotEmpty)
          'customFields': customFields.map((f) => f.toJson()).toList(),
        'source': source,
        if (groupId != null) 'groupId': groupId,
      };

  factory AvaBookContact.fromJson(Map<String, dynamic> j) => AvaBookContact(
        name: '${j['name'] ?? ''}',
        number: '${j['number'] ?? ''}',
        avatokNumber: j['avatokNumber'] as String?,
        personalEmail: j['personalEmail'] as String?,
        businessEmail: j['businessEmail'] as String?,
        linkedin: j['linkedin'] as String?,
        customFields: (j['customFields'] as List<dynamic>? ?? const [])
            .whereType<Map>()
            .map((m) => ContactField.fromJson(m.map((k, v) => MapEntry('$k', v))))
            .toList(),
        source: '${j['source'] ?? 'device'}',
        groupId: j['groupId'] as String?,
      );
}

/// Local AvaTOK contact book — a single account-scoped snapshot persisted via
/// [DiskCache]. Rebuilt from the merged device+AvaTOK view whenever the Contacts
/// tab loads. Phase 2 pushes/pulls this exact blob to AvaTOK's servers for
/// backup/restore (server-side encrypted, owner decision 2026-07-13).
class AvaContactBook {
  AvaContactBook._();
  static final AvaContactBook I = AvaContactBook._();

  static const _kCache = 'ava_contact_book';

  /// Rebuild + persist the book from the current merged Contacts view.
  Future<void> capture(
      List<DeviceContact> device, Map<String, ContactOverride> overrides) async {
    try {
      final out = <AvaBookContact>[];
      final seen = <String>{};
      for (final c in device) {
        final key = DeviceContacts.normKey(c.number);
        final o = overrides[key];
        if (o?.hidden == true) continue;
        seen.add(key);
        out.add(AvaBookContact(
          name: o?.displayName ?? c.name ?? c.number,
          number: c.number,
          avatokNumber: o?.avatokNumber,
          personalEmail: o?.personalEmail,
          businessEmail: o?.businessEmail,
          linkedin: o?.linkedin,
          customFields: o?.customFields ?? const [],
          source: (o?.local ?? false) ? 'avatok' : 'device',
          groupId: o?.groupId,
        ));
      }
      // Any AvaTOK-only overrides not represented by a device row.
      for (final o in overrides.values) {
        final key = DeviceContacts.normKey(o.number);
        if (o.hidden || seen.contains(key)) continue;
        out.add(AvaBookContact(
          name: o.displayName ?? o.number,
          number: o.number,
          avatokNumber: o.avatokNumber,
          personalEmail: o.personalEmail,
          businessEmail: o.businessEmail,
          linkedin: o.linkedin,
          customFields: o.customFields,
          source: 'avatok',
          groupId: o.groupId,
        ));
      }
      await DiskCache.write(_kCache, jsonEncode(out.map((e) => e.toJson()).toList()));
    } catch (e) {
      AvaLog.I.log('avadial', 'contact book capture failed: $e');
    }
  }

  Future<List<AvaBookContact>> load() async {
    try {
      final raw = await DiskCache.read(_kCache);
      if (raw == null || raw.isEmpty) return [];
      return (jsonDecode(raw) as List<dynamic>)
          .whereType<Map>()
          .map((m) => AvaBookContact.fromJson(m.map((k, v) => MapEntry('$k', v))))
          .toList();
    } catch (e) {
      AvaLog.I.log('avadial', 'contact book load failed: $e');
      return [];
    }
  }

  Future<int> count() async => (await load()).length;

  /// [AVADIAL-BACKUP-OWNER] The contacts THIS account is entitled to back up —
  /// the single place the master/sub rule is applied.
  ///
  /// A MASTER (this phone's first account, or anyone grandfathered) backs up the
  /// whole book. A SUB backs up only what they created in AvaTOK: the device phone
  /// book belongs to the phone's owner, so a sub who leaves and restores on their
  /// own device gets their own contacts and nothing else. See
  /// [ContactBackupRoles] for why sub status can never be applied to an account
  /// that already has a backup.
  ///
  /// The filter is `source == 'avatok'`, which [capture] already sets for exactly
  /// the right rows: a contact the user created in AvaTOK (an override with
  /// `local: true`, or an AvaTOK-only entry with no device row). Contacts read out
  /// of the Android address book are `'device'` and belong to the handset.
  ///
  /// Applied at BACKUP time on purpose, not at restore time: a sub's stored book
  /// then simply never contains the phone book, so there is nothing for a restore —
  /// or a future bug in one — to leak. Filtering on the way out would leave the
  /// data sitting on the server waiting for a mistake.
  Future<List<AvaBookContact>> backupContacts() async {
    final role = await backupRole();
    final all = await load();
    if (role == ContactBackupRole.master) return all;
    return all.where((c) => c.source == 'avatok').toList();
  }

  /// [AVADIAL-BACKUP-OWNER] Match keys for the contacts that came from THIS
  /// handset's address book. Sent only with `prune_device`, where it bounds the
  /// deletion to contacts we can actually see on this phone right now.
  ///
  /// Same normalisation the server merges by ([DeviceContacts.normKey] ⇔ the
  /// worker's `mergeKey`), so the two agree on identity.
  Future<List<String>> _deviceKeys() async => (await load())
      .where((c) => c.source == 'device')
      .map((c) => DeviceContacts.normKey(c.number))
      .where((k) => k.isNotEmpty)
      .toSet()
      .toList();

  /// Serialized backup payload (uploaded to AvaTOK's backup endpoint). Includes
  /// the custom colour groups so a group-only edit still changes the signature
  /// and triggers an auto-sync. [AVADIAL-GROUPS-3]
  ///
  /// Built from [backupContacts], NOT the full book — the change signature MUST be
  /// computed over exactly the bytes we upload. If it covered the full book, a sub
  /// would re-upload every time an unrelated device contact changed (data they
  /// don't even back up), and the "nothing changed" check would never hold.
  Future<String> exportJson() async => jsonEncode({
        'contacts': (await backupContacts()).map((e) => e.toJson()).toList(),
        'groups': (await ContactGroups.I.customGroups()).map((g) => g.toJson()).toList(),
      });

  /// Upload the local book to AvaTOK's servers (server-side encrypted). Returns
  /// the count on success, or null on failure.
  ///
  /// [source] is echoed to the server and stamped onto BOTH the client and the
  /// server-side PostHog event, so a backup can be attributed to the surface that
  /// produced it: `manual` (the user tapped "Back up now"), `auto_sync` (an edit
  /// on the Contacts tab), or `daily_bg` (the WorkManager daily job — which runs
  /// in a headless isolate where client-side PostHog is inert, so the SERVER event
  /// is the only place those runs are visible). See contacts_daily_backup.dart.
  ///
  /// ── NEVER UPLOADS AN EMPTY BOOK ───────────────────────────────────────────
  /// The server is latest-wins, so POSTing `[]` DELETES a good backup of
  /// thousands of contacts. The local book is `[]` for entirely routine reasons
  /// that have nothing to do with the user having no contacts:
  ///   • READ_CONTACTS denied/revoked → `DeviceContacts.load()` returns `const []`
  ///     → `capture()` persists an empty book, and
  ///   • a fresh install before the Contacts tab has ever loaded.
  /// So empty means "we don't know", not "the user has none", and the only safe
  /// reading of "we don't know" is to leave the server's copy alone. This guard
  /// lives HERE, at the single chokepoint every caller funnels through, rather
  /// than in each of them — [AVADIAL-BACKUP-DAILY] made autoSyncIfNeeded()
  /// unconditional, and a guard sitting in only one caller would have quietly
  /// become the exception instead of the rule. A user who truly has zero contacts
  /// loses nothing by us declining to back up zero contacts; restore only ever
  /// ADDS to a device, so an out-of-date backup is harmless where a destroyed one
  /// is not. Returns 0 (not null) — declining to upload isn't a failure.
  /// [AVADIAL-BACKUP-MERGE] [mode] is the ONLY way an upload can remove anything.
  /// Default `merge` — every automatic path merges, so a routine upload can never
  /// delete. The two destructive modes are reachable only from a warned, explicit
  /// tap on the backup screen; never set them anywhere else:
  ///   • `replace`      — discard everything stored, keep only what we send.
  ///   • `prune_device` — drop only the contacts that came from a handset's address
  ///     book, keeping this account's own AvaTOK contacts (including any from an
  ///     older phone, which a blunt `replace` would throw away). This is the
  ///     "I was borrowing that phone, get its contacts out of my backup" action.
  Future<int?> uploadBackup({String source = 'manual', String mode = 'merge'}) async {
    final t0 = DateTime.now();
    final trace = TraceContext.mint();
    try {
      // [AVADIAL-BACKUP-OWNER] A sub uploads only its own contacts; a master the
      // whole book. Resolved here so EVERY caller (manual, auto-sync, daily) obeys
      // the same rule.
      final contacts = await backupContacts();
      // [AVADIAL-BACKUP-OWNER] prune_device legitimately sends LESS than it removes
      // — a borrower with no AvaTOK contacts of their own sends nothing at all — so
      // the empty guard must not veto it. Without this the prune button silently
      // does nothing for the most typical sub, and then reports success.
      if (contacts.isEmpty && mode != 'prune_device') {
        AvaLog.I.log('avadial',
            'contact book upload SKIPPED: nothing to back up (never overwrite the server copy)');
        Analytics.capture('avadial_contact_backup_skipped_empty', {
          'source': source,
          // This is THE event to pull when someone reports "my contacts stopped
          // backing up", so it has to say WHICH skip happened: 'undecided' (we
          // couldn't reach the server to establish whether this account owns the
          // phone book, so we refused to guess) reads nothing like an empty book
          // or a sub with nothing of their own yet.
          'role': (await backupRole()).name,
          'trace_id': trace,
        });
        return 0;
      }
      final payload = contacts.map((e) => e.toJson()).toList();
      final groups = await ContactGroups.I.customGroups();
      // Signature MUST come from the same string exportJson() produces (contacts
      // + groups), or auto-sync would think this upload never happened and
      // re-upload forever. [AVADIAL-GROUPS-3]
      final sigBody = await exportJson();
      // Larger books need a longer window than the 8s default (a 4.5k-contact
      // book is a few MB over TLS on a slow cell link).
      final resp = await ApiAuth.postJson(kContactBookUrl, {
        'contacts': payload,
        'groups': groups.map((g) => g.toJson()).toList(),
        'source': source,
        // Omitted for the default, so the server's own default (merge) applies and
        // an older build that never sends this field also merges — i.e. the safe
        // behaviour is what you get by saying nothing. [AVADIAL-BACKUP-MERGE]
        if (mode != 'merge') 'mode': mode,
        // [AVADIAL-BACKUP-OWNER] Which contacts are on THIS handset. Required by
        // prune_device, and it is the whole safety of that mode.
        //
        // `source` records only that a contact came from AN address book — never
        // WHICH one. Pruning on `source` alone would therefore delete every
        // device-origin contact the account has ever stored, from any phone. The
        // person most likely to tap prune is precisely the one that ruins: someone
        // with 2,000 contacts backed up from their OWN phone who is now a sub on a
        // borrowed one. They'd be told "this phone's contacts will be removed" and
        // lose their personal address book instead. Sending the keys turns
        // "device-origin" into "demonstrably sitting on the handset in my hand".
        if (mode == 'prune_device') 'deviceKeys': await _deviceKeys(),
      }, timeout: const Duration(seconds: 30));
      final ms = DateTime.now().difference(t0).inMilliseconds;
      if (resp.statusCode == 200) {
        await ContactBackupPrefs.I.markServerSync();
        // Remember what we uploaded so auto-sync won't re-send identical data.
        await ContactBackupPrefs.I.setSyncedSig(_sig(sigBody));
        // [AVADIAL-BACKUP-MERGE] Report what the ACCOUNT now holds, not what this
        // phone sent — after a merge they differ, and the stored total is the honest
        // answer to "how many contacts are backed up?". `kept` is how many the
        // server had that this upload didn't include; under the old replace
        // semantics every one of those was a silent deletion.
        int stored = contacts.length;
        int kept = 0;
        try {
          final b = jsonDecode(resp.body) as Map<String, dynamic>;
          stored = (b['count'] as num?)?.toInt() ?? contacts.length;
          kept = (b['kept'] as num?)?.toInt() ?? 0;
        } catch (_) {/* older worker: no counts in the body — fall back to sent */}
        Analytics.capture('avadial_contact_backup_uploaded', {
          'count': stored,
          'sent': contacts.length,
          'kept': kept,
          'mode': mode,
          'groups': groups.length,
          'bytes': sigBody.length,
          'ms': ms,
          'source': source,
          // [AVADIAL-BACKUP-OWNER] Without this, a sub's legitimately smaller book
          // looks identical to a master silently losing contacts. Tells them apart.
          // Memoised by now (backupContacts resolved it above), so no extra call.
          'role': (await backupRole()).name,
          'trace_id': trace,
        });
        // The account's total after merging — what the screen reports to the user.
        return stored;
      }
      AvaLog.I.log('avadial', 'contact book upload http ${resp.statusCode}');
      Analytics.capture('avadial_contact_backup_failed', {
        'reason': 'http',
        'status': resp.statusCode,
        'count': contacts.length,
        'ms': ms,
        'source': source,
        'trace_id': trace,
      });
      return null;
    } catch (e, st) {
      AvaLog.I.log('avadial', 'contact book upload failed: $e');
      Analytics.error(
          domain: 'contacts', code: 'backup_upload', message: '$e', action: 'uploadBackup');
      Analytics.captureException(e, st, screen: 'contacts_backup');
      Analytics.capture('avadial_contact_backup_failed', {
        'reason': 'exception',
        'ms': DateTime.now().difference(t0).inMilliseconds,
        'source': source,
        'trace_id': trace,
      });
      return null;
    }
  }

  Timer? _debounce;

  /// Auto-backup hook — called after the contact book is (re)captured. When the
  /// book has actually CHANGED since the last upload it uploads in the background,
  /// debounced so a burst of edits sends once.
  ///
  /// [AVADIAL-BACKUP-DAILY] No longer gated on the old opt-in switch (owner
  /// decision 2026-07-15: backup is a default app behaviour, not a toggle —
  /// users were switching it off and then losing their contacts). This is the
  /// real-time lane; the ~24h WorkManager job in contacts_daily_backup.dart is
  /// the floor for users who never open the Contacts tab.
  Future<void> autoSyncIfNeeded() async {
    _debounce?.cancel();
    _debounce = Timer(const Duration(seconds: 4), _runAutoSync);
  }

  Future<void> _runAutoSync() async {
    try {
      final body = await exportJson();
      if (_sig(body) == await ContactBackupPrefs.I.syncedSig()) return; // no change
      await uploadBackup(source: 'auto_sync');
    } catch (e) {
      AvaLog.I.log('avadial', 'contact book auto-sync failed: $e');
    }
  }

  // [AVADIAL-BACKUP-MERGE 2026-07-15] `autoUploadAllowed()` — the restore-first hold —
  // WAS HERE AND IS DELETED. It existed to stop a new phone auto-uploading over the
  // backup its owner hadn't restored yet, back when an upload REPLACED the stored
  // book. The server now merges (owner decision: "the copy on the server always
  // remains with us"), so that upload can no longer destroy anything: phone B's book
  // unions with the stored one and the user restores the lot. The hold had become
  // pure friction — it paused backups, and told users "Restore first" for a danger
  // that no longer exists. Same reasoning retires the "Replace your backup?" warning
  // on every automatic path.
  //
  // Deliberately not kept "just in case": a guard that no longer guards anything
  // still has to be understood, obeyed and worked around by everyone who touches
  // this file next.

  /// How stale a backup may get before the daily job re-uploads.
  static const Duration kDailyInterval = Duration(hours: 24);

  /// [AVADIAL-BACKUP-DAILY] The once-a-day upload, driven by the WorkManager job
  /// (contacts_daily_backup.dart) and safe to call from anywhere — it decides for
  /// itself whether anything is actually due. Returns true only when it uploaded.
  ///
  /// Three guards, in order of how badly each would hurt if it were missing:
  ///
  ///  1. **Empty book** — skip. [uploadBackup] enforces this for every caller (see
  ///     its docs: an empty local book means "we don't know", and uploading `[]`
  ///     to a latest-wins server destroys a real backup). Re-checked here purely
  ///     to skip the pointless `exportJson()` work below.
  ///  2. **Not due yet** — a successful upload inside the last [kDailyInterval].
  ///  3. **Nothing changed** — same content signature as the last upload, so the
  ///     round-trip would be pure waste. Cheap to re-check tomorrow.
  Future<bool> dailyBackupIfDue({String source = 'daily_bg', bool force = false}) async {
    try {
      // backupContacts(), not load(): for a SUB an all-device book is legitimately
      // nothing-to-back-up, and we shouldn't do the work below to discover that.
      final contacts = await backupContacts();
      if (contacts.isEmpty) {
        AvaLog.I.log('avadial', 'daily backup skipped: nothing to back up (never overwrite)');
        return false;
      }

      if (!force) {
        final last = await ContactBackupPrefs.I.lastServerSync();
        if (last != null && DateTime.now().difference(last) < kDailyInterval) return false;

        final body = await exportJson();
        if (_sig(body) == await ContactBackupPrefs.I.syncedSig()) {
          AvaLog.I.log('avadial', 'daily backup skipped: book unchanged');
          return false;
        }
      }

      // > 0, not != null: uploadBackup returns 0 when it declines an empty book.
      return (await uploadBackup(source: source) ?? 0) > 0;
    } catch (e) {
      AvaLog.I.log('avadial', 'daily backup failed: $e');
      return false;
    }
  }

  /// Cheap, stable content signature (FNV-1a) — persisted to detect real changes
  /// without re-uploading identical data. (String.hashCode isn't stable across
  /// runs, so we can't use it here.)
  static String _sig(String s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.codeUnitAt(i);
      h = (h * 0x01000193) & 0xFFFFFFFF;
    }
    return h.toRadixString(16);
  }

  // ── Restore queue tunables ────────────────────────────────────────────────
  static const _kPageLimit = 200;       // contacts fetched per server page
  static const _kWriteBatch = 60;       // device writes per native transaction / yield
  static const _kJobKey = 'ava_contact_restore_job'; // resume state (account-scoped)
  static const _kPageTimeout = Duration(seconds: 25);
  static const _kBatchTimeout = Duration(seconds: 45);
  static const _kOverallDeadline = Duration(minutes: 10);
  static const _kMaxPageRetries = 3;

  /// Restore the book from AvaTOK's servers onto THIS device as a ROBUST,
  /// RESUMABLE, BATCHED job (owner request 2026-07-14) — the old version fetched
  /// the whole book and wrote 1000s of contacts one-by-one with no yields, no
  /// timeouts and an O(n²) override save, which froze the app ("contacts stuck").
  ///
  /// Now: paginate the download (a few hundred at a time), apply each page to the
  /// device in small batches that YIELD to the UI between them, guard every network
  /// page and every write batch with a TIMEOUT so a single stall can't hang the
  /// flow, bulk-save overrides once per page, and persist progress so a kill /
  /// backgrounding resumes instead of restarting. Existing device contacts (matched
  /// by number) are never duplicated. [onProgress] reports (done, total); total is
  /// 0 until the server reports it. Returns contacts restored this run, or null on a
  /// hard failure (a partial count is returned when it made progress but was cut
  /// short — tapping Restore again resumes).
  Future<int?> restoreBackup({void Function(int done, int total)? onProgress}) async {
    final t0 = DateTime.now();
    final trace = TraceContext.mint();
    final deadline = t0.add(_kOverallDeadline);
    Analytics.capture('avadial_contact_restore_started', {'trace_id': trace});

    // Warm the on-device dedupe set ONCE (the old code relied on lookup(), which
    // write() wiped after the first contact — so it treated everyone as missing).
    final onDevice = <String>{};
    try {
      for (final c in await DeviceContacts.I.load(force: true)) {
        onDevice.add(DeviceContacts.normKey(c.number));
      }
    } catch (_) {/* permission denied / unsupported — treat as empty */}

    final doneKeys = <String>{}; // guards intra-run cross-page duplicates
    var groupsImported = false; // guards the one-time custom-groups import below
    final job = await _loadRestoreJob();
    var offset = job?.offset ?? 0;
    var restored = job?.restored ?? 0;
    var total = job?.total ?? -1;
    var pages = 0;
    var serverPaged = true;

    // Resuming a job left behind by a previous (killed/backgrounded) run.
    if (job != null && (offset > 0 || restored > 0)) {
      Analytics.capture('avadial_contact_restore_resumed',
          {'offset': offset, 'restored': restored, 'total': total, 'trace_id': trace});
    }
    // Device-contacts (and thus write) permission is what lets restore rebuild the
    // phone book; record when it's absent so a "restored nothing" report is explained.
    if (onDevice.isEmpty && !await DeviceContacts.I.ensureWritePermission()) {
      Analytics.capture('avadial_contact_restore_no_permission', {'trace_id': trace});
    }

    try {
      while (true) {
        if (DateTime.now().isAfter(deadline)) {
          await _saveRestoreJob(offset, restored, total);
          Analytics.capture('avadial_contact_restore_failed',
              {'reason': 'deadline', 'restored': restored, 'offset': offset, 'trace_id': trace});
          return restored; // resumable
        }

        final page = await _fetchPage(offset, _kPageLimit, trace);
        if (page == null) {
          await _saveRestoreJob(offset, restored, total);
          Analytics.capture('avadial_contact_restore_failed',
              {'reason': 'fetch', 'restored': restored, 'offset': offset, 'trace_id': trace});
          return restored > 0 ? restored : null;
        }
        if (!page.found) {
          await _clearRestoreJob();
          Analytics.capture('avadial_contact_restore_completed', {
            'restored': restored, 'total': 0, 'found': false,
            'ms': DateTime.now().difference(t0).inMilliseconds, 'trace_id': trace,
          });
          return restored; // 0 when there was never a backup
        }
        if (page.total >= 0) {
          total = page.total;
        } else {
          serverPaged = false; // old worker returned the whole book at once
        }

        // [AVADIAL-GROUPS-3] Import the custom colour groups ONCE, from the
        // first successful page (every successful page carries them, so no
        // need to repeat it per page).
        if (!groupsImported) {
          groupsImported = true;
          try {
            final n = await ContactGroups.I.importCustom(page.groups);
            if (n > 0) {
              Analytics.capture(
                  'avadial_contact_groups_restored', {'count': n, 'trace_id': trace});
            }
          } catch (e) {
            Analytics.error(
                domain: 'contacts', code: 'restore_groups', message: '$e');
          }
        }

        final list = page.contacts;
        if (list.isEmpty) break;

        // Partition this page: brand-new (write to device) vs already-present
        // (just re-apply AVA extras). Overrides are collected and saved in ONE
        // bulk write per page (kills the O(n²) per-contact save).
        final toWrite = <Map<String, dynamic>>[];
        final overrides = <ContactOverride>[];
        for (final c in list) {
          if (c.number.isEmpty) continue;
          final key = DeviceContacts.normKey(c.number);
          if (doneKeys.contains(key)) continue;
          doneKeys.add(key);
          final already = onDevice.contains(key);
          if (!already) toWrite.add(_writeMapFor(c));
          overrides.add(ContactOverride(
            number: c.number,
            displayName: c.name.isEmpty ? null : c.name,
            local: !already, // ensure it stays visible even if a device write missed
            avatokNumber: c.avatokNumber,
            personalEmail: c.personalEmail,
            businessEmail: c.businessEmail,
            linkedin: c.linkedin,
            customFields: c.customFields,
            groupId: c.groupId,
          ));
        }

        // Apply device writes in sub-batches, yielding to the UI between each so
        // the spinner animates and the app never appears frozen.
        var pageWritten = 0;
        for (var i = 0; i < toWrite.length; i += _kWriteBatch) {
          final slice = toWrite.sublist(i, min(i + _kWriteBatch, toWrite.length));
          var w = 0;
          try {
            w = await DeviceContacts.I.writeBatch(slice).timeout(_kBatchTimeout, onTimeout: () {
              Analytics.capture('avadial_contact_restore_batch_timeout',
                  {'size': slice.length, 'offset': offset, 'trace_id': trace});
              return 0;
            });
          } catch (e) {
            Analytics.error(
                domain: 'contacts', code: 'restore_batch', message: '$e', action: 'writeBatch');
            w = 0;
          }
          pageWritten += w;
          restored += w;
          onProgress?.call(
              (offset + i + slice.length), total < 0 ? 0 : total);
          await Future<void>.delayed(Duration.zero); // let the UI breathe
        }

        // One bulk override save for the whole page.
        try {
          await ContactOverrides.I.saveMany(overrides);
        } catch (e) {
          Analytics.error(domain: 'contacts', code: 'restore_overrides', message: '$e');
        }

        pages++;
        offset += list.length;
        await _saveRestoreJob(offset, restored, total);
        Analytics.capture('avadial_contact_restore_progress', {
          'page': pages, 'offset': offset, 'page_count': list.length,
          'written': pageWritten, 'restored': restored, 'total': total, 'trace_id': trace,
        });
        onProgress?.call(offset, total < 0 ? 0 : total);

        // Termination: old (unpaged) worker gives everything in one page; a paged
        // worker signals the end via nextOffset==null or offset>=total.
        if (!serverPaged) break;
        if (page.nextOffset == null) break;
        if (total >= 0 && offset >= total) break;
        if (list.length < _kPageLimit) break;
      }

      await _clearRestoreJob();
      final ms = DateTime.now().difference(t0).inMilliseconds;
      Analytics.capture('avadial_contact_restore_completed', {
        'restored': restored, 'total': total < 0 ? restored : total,
        'pages': pages, 'ms': ms, 'found': true, 'trace_id': trace,
      });
      return restored;
    } catch (e, st) {
      AvaLog.I.log('avadial', 'contact book restore failed: $e');
      Analytics.captureException(e, st, screen: 'contacts_backup');
      Analytics.capture('avadial_contact_restore_failed',
          {'reason': 'exception', 'restored': restored, 'trace_id': trace});
      await _saveRestoreJob(offset, restored, total);
      return restored > 0 ? restored : null;
    }
  }

  /// Fetch one restore page with retry + backoff. Sends `?offset&limit`; a paged
  /// worker returns {total, nextOffset}, an older one ignores the params and
  /// returns the whole book (handled by the caller via [_RestorePage.total] == -1).
  /// Returns null only after exhausting retries (hard network failure).
  Future<_RestorePage?> _fetchPage(int offset, int limit, String trace) async {
    for (var attempt = 0; attempt < _kMaxPageRetries; attempt++) {
      try {
        final url = '$kContactBookUrl?offset=$offset&limit=$limit';
        final resp = await ApiAuth.getSigned(url, timeout: _kPageTimeout);
        if (resp.statusCode == 200) {
          final body = jsonDecode(resp.body) as Map<String, dynamic>;
          if (body['found'] != true) return const _RestorePage.notFound();
          final list = (body['contacts'] as List<dynamic>? ?? const [])
              .whereType<Map>()
              .map((m) => AvaBookContact.fromJson(m.map((k, v) => MapEntry('$k', v))))
              .toList();
          // [AVADIAL-GROUPS-3] Custom groups, present on every successful page.
          final groups = (body['groups'] as List<dynamic>? ?? const [])
              .whereType<Map>()
              .map((m) => ContactGroup.fromJson(m.map((k, v) => MapEntry('$k', v))))
              .toList();
          return _RestorePage(
            found: true,
            contacts: list,
            total: (body['total'] as num?)?.toInt() ?? -1,
            nextOffset: (body['nextOffset'] as num?)?.toInt(),
            groups: groups,
          );
        }
        AvaLog.I.log('avadial', 'contact book restore page http ${resp.statusCode}');
        Analytics.capture('avadial_contact_restore_page_error',
            {'status': resp.statusCode, 'offset': offset, 'attempt': attempt, 'trace_id': trace});
      } catch (e) {
        AvaLog.I.log('avadial', 'contact book restore page failed: $e');
        Analytics.capture('avadial_contact_restore_page_error',
            {'status': 0, 'offset': offset, 'attempt': attempt, 'trace_id': trace});
      }
      // Backoff before the next attempt (0.5s, 1s, 2s…), never blocking forever.
      await Future<void>.delayed(Duration(milliseconds: 500 * (1 << attempt)));
    }
    return null;
  }

  Map<String, dynamic> _writeMapFor(AvaBookContact c) => {
        'name': c.name.isEmpty ? c.number : c.name,
        'number': c.number,
        if (c.personalEmail != null) 'personalEmail': c.personalEmail,
        if (c.businessEmail != null) 'businessEmail': c.businessEmail,
        if (c.linkedin != null) 'linkedin': c.linkedin,
        'note': _noteFor(c),
      };

  Future<_RestoreJob?> _loadRestoreJob() async {
    try {
      final raw = await DiskCache.read(_kJobKey);
      if (raw == null || raw.isEmpty) return null;
      final j = jsonDecode(raw) as Map<String, dynamic>;
      return _RestoreJob(
        offset: (j['offset'] as num?)?.toInt() ?? 0,
        restored: (j['restored'] as num?)?.toInt() ?? 0,
        total: (j['total'] as num?)?.toInt() ?? -1,
      );
    } catch (_) {
      return null;
    }
  }

  Future<void> _saveRestoreJob(int offset, int restored, int total) async {
    try {
      await DiskCache.write(
          _kJobKey, jsonEncode({'offset': offset, 'restored': restored, 'total': total}));
    } catch (_) {/* best-effort */}
  }

  Future<void> _clearRestoreJob() async {
    try {
      await DiskCache.delete(_kJobKey);
    } catch (_) {}
  }

  String? _noteFor(AvaBookContact c) {
    final lines = <String>[
      if (c.avatokNumber != null && c.avatokNumber!.isNotEmpty) 'AvaTOK: ${c.avatokNumber}',
      for (final f in c.customFields)
        if (f.value.isNotEmpty) '${f.label.isEmpty ? 'Note' : f.label}: ${f.value}',
    ];
    return lines.isEmpty ? null : lines.join('\n');
  }

  // [AVADIAL-BACKUP-MERGE] `serverBackupProbe()` is GONE with the grandfathering it
  // served. It answered "does this account already own a full phone book that a
  // sub-sized upload would delete?" — a question that only existed while uploads
  // replaced. Merge retired it: no role decision can delete a stored contact.

  /// This account's backup role. Local, cheap, never null. See [ContactBackupRoles].
  Future<ContactBackupRole> backupRole() => ContactBackupRoles.I.resolve();

  /// Server-side backup metadata (count + last-updated ms), or null when there is
  /// no backup / the call failed.
  Future<({int count, int updatedAt})?> serverStatus() async {
    try {
      final resp = await ApiAuth.getSigned(kContactBookStatusUrl);
      if (resp.statusCode != 200) return null;
      final b = jsonDecode(resp.body) as Map<String, dynamic>;
      if (b['found'] != true) return null;
      return (
        count: (b['count'] as num?)?.toInt() ?? 0,
        updatedAt: (b['updatedAt'] as num?)?.toInt() ?? 0,
      );
    } catch (e) {
      return null;
    }
  }
}

/// One page of a paginated restore. [total] is -1 when the server did not report
/// it (an older, unpaged worker that returned the whole book at once); [nextOffset]
/// is null when there are no more pages.
class _RestorePage {
  final bool found;
  final List<AvaBookContact> contacts;
  final int total;
  final int? nextOffset;
  // [AVADIAL-GROUPS-3] Custom colour groups the server sent alongside this
  // page (top-level 'groups' in the response body), possibly empty.
  final List<ContactGroup> groups;
  const _RestorePage({
    required this.found,
    required this.contacts,
    required this.total,
    required this.nextOffset,
    required this.groups,
  });
  const _RestorePage.notFound()
      : found = false,
        contacts = const [],
        total = 0,
        nextOffset = null,
        groups = const [];
}

/// Persisted restore progress so a killed/backgrounded restore resumes instead of
/// starting over. Stored account-scoped via [DiskCache].
class _RestoreJob {
  final int offset;
  final int restored;
  final int total;
  const _RestoreJob({required this.offset, required this.restored, required this.total});
}

/// Status of the contact book's backup to AvaTOK's servers. All keys go through
/// [DiskCache], which is account-scoped by `AccountScope.id` — so on a shared
/// phone each account tracks its OWN last-backup time and signature.
///
/// [AVADIAL-BACKUP-DAILY 2026-07-15] This used to hold the user's opt-in CONSENT
/// (`ava_contact_backup_enabled`, owner request 2026-07-13 — "take permission to
/// back up"). The owner reversed that: backup is now a default app behaviour that
/// runs regardless, because users were switching it off and then finding their
/// contacts gone on a new device. The switch is gone from the UI and `enabled()`/
/// `setEnabled()` are gone with it — a pref nothing reads is just a trap for the
/// next reader. The stale `ava_contact_backup_enabled` file is harmlessly ignored
/// (DiskCache reads return null for keys nobody asks for); it is deliberately NOT
/// migrated, since an old `false` must not disable anything any more.
///
/// `markSnapshot`/`lastSnapshot` went the same way: `_kLastTs` was only ever
/// written by the button and never read back — [lastServerSync] (the timestamp of
/// a real, confirmed server write) is what the screen shows.
class ContactBackupPrefs {
  ContactBackupPrefs._();
  static final ContactBackupPrefs I = ContactBackupPrefs._();

  static const _kServerTs = 'ava_contact_backup_server_ts';
  static const _kSyncedSig = 'ava_contact_backup_sig';

  // [AVADIAL-BACKUP-MERGE] `_kRestoredHere` / `restoredHere()` / `markRestoredHere()`
  // are GONE with the restore-first hold they fed — the server merges now, so an
  // upload from a device that hasn't restored can't destroy anything. The stale
  // `ava_contact_backup_restored_here` file on existing installs is simply never
  // read again.

  /// Content signature of the last successfully-uploaded book (change detection).
  Future<String> syncedSig() async => (await DiskCache.read(_kSyncedSig)) ?? '';
  Future<void> setSyncedSig(String sig) async => DiskCache.write(_kSyncedSig, sig);

  /// Last successful upload to AvaTOK's servers.
  Future<DateTime?> lastServerSync() async => _readTs(_kServerTs);
  Future<void> markServerSync() async => _writeNow(_kServerTs);

  Future<DateTime?> _readTs(String key) async {
    final ms = int.tryParse(await DiskCache.read(key) ?? '');
    return ms == null ? null : DateTime.fromMillisecondsSinceEpoch(ms);
  }

  Future<void> _writeNow(String key) async =>
      DiskCache.write(key, '${DateTime.now().millisecondsSinceEpoch}');
}
