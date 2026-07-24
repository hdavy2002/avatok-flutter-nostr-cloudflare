/// [MEDIA-OUTBOX-DURABLE-1] A durable, per-account record of every media
/// attachment's UPLOAD leg — from "the user tapped send" through "the
/// ciphertext is on R2" — closing the orphan window F3/J7 describe:
///
///   the client uploads encrypted bytes to R2 FIRST, then sends the message
///   envelope. If the process dies after R2 accepts the bytes but before the
///   envelope is durably queued, the R2 object is orphaned and the local
///   bubble (which only ever lived in memory) is gone with no trace.
///
/// This store closes that window from the CLIENT side: before encryption/
/// upload starts we stage the PLAINTEXT bytes to a per-account file on disk
/// and record one row (`state = queued`). The row advances
/// `queued → uploading → uploaded → envelope_sent → acked` as the upload and
/// send progress, and [reconcile] resumes any row that wasn't already
/// `acked` the next time it gets a chance to run (thread open / app boot).
///
/// ── Why this reuses the existing per-account drift DB instead of a new file ──
/// `core/db.dart` already opens one per-account SQLite file
/// (`avatok_<scope>.sqlite`) via the singleton `Db.I`, and
/// `core/local_brain/local_index.dart` already proves the pattern of adding
/// auxiliary, non-drift-managed objects to that SAME connection via
/// `customStatement`/`customSelect` (its `ava_fts`/`ava_vectors` tables). This
/// store mirrors that exactly — one more `CREATE TABLE IF NOT EXISTS`, same
/// connection — so per-account scoping is inherited for free (the whole DB
/// file is already per-account) instead of standing up a second SQLite
/// database with its own account-scoping code to get right and keep right.
///
/// ── Envelope-ack observability (documented, see class doc on [markEnvelopeSent]) ──
/// Once ciphertext is on R2 this store hands the envelope to [Outbox] (the
/// EXISTING durable text/control queue — `sync/outbox.dart`) exactly the way
/// `AvaDm.send`/`AvaGroupDm.send` already do: `Outbox.I.enqueue(...)`. Outbox
/// already retries with backoff and durably owns the envelope leg end-to-end
/// (it survives restart on its own). This store does NOT reimplement that; it
/// listens to `Outbox.I.status` for the envelope's `client_id` and, once
/// Outbox reports `ok: true` (its ACK — see [Outbox]'s own doc on why ACK,
/// not the later echo, is the UI-visible completion signal), deletes the
/// staged plaintext file and the row. So the envelope LEG's ack observability
/// is Outbox's existing status stream — this store just watches it.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:drift/drift.dart' show Variable, Value;
import 'package:path_provider/path_provider.dart';

import '../core/analytics.dart';
import '../core/ava_log.dart';
import '../core/db.dart';
import '../identity/identity.dart';
import 'outbox.dart';

/// One media-outbox row, as read back from SQLite.
class MediaOutboxRow {
  final String clientId;
  final String envelopeClientId;
  final String convKey;
  final String toUid;
  final String gid;
  final String kind;
  final String mime;
  final String filename;
  final String caption;
  final String stagedPath;
  final String state; // queued | uploading | uploaded | envelope_sent | acked
  final int attempts;
  final int nextAttemptTs;
  final int createdTs;
  final int updatedTs;
  final String mediaJson; // ChatMedia.toEnvelope() JSON, set once uploaded

  MediaOutboxRow({
    required this.clientId,
    required this.envelopeClientId,
    required this.convKey,
    required this.toUid,
    required this.gid,
    required this.kind,
    required this.mime,
    required this.filename,
    required this.caption,
    required this.stagedPath,
    required this.state,
    required this.attempts,
    required this.nextAttemptTs,
    required this.createdTs,
    required this.updatedTs,
    required this.mediaJson,
  });
}

class MediaOutbox {
  static final MediaOutbox I = MediaOutbox._();
  MediaOutbox._();

  bool _schemaReady = false;
  bool _statusHooked = false;
  // clientId (media outbox row) → envelope client_id, for rows currently
  // waiting on Outbox's ACK. Populated on markEnvelopeSent + on reconcile().
  final Map<String, String> _watchingEnvelope = {}; // envelopeClientId -> mediaClientId

  /// A fresh id for a new media-outbox row / staged-file name.
  static String newId() {
    final r = Random.secure();
    return 'mo_${List<int>.generate(10, (_) => r.nextInt(256)).map((b) => b.toRadixString(16).padLeft(2, '0')).join()}';
  }

  Future<void> _ensureSchema() async {
    if (_schemaReady) return;
    final db = Db.I;
    await db.customStatement('''
      CREATE TABLE IF NOT EXISTS media_outbox (
        client_id TEXT PRIMARY KEY,
        envelope_client_id TEXT NOT NULL DEFAULT '',
        conv_key TEXT NOT NULL,
        to_uid TEXT NOT NULL DEFAULT '',
        gid TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        mime TEXT NOT NULL,
        filename TEXT NOT NULL DEFAULT '',
        caption TEXT NOT NULL DEFAULT '',
        staged_path TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_ts INTEGER NOT NULL DEFAULT 0,
        created_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL,
        media_json TEXT NOT NULL DEFAULT ''
      );
    ''');
    _schemaReady = true;
    _hookOutboxStatus();
  }

  /// Watch the EXISTING durable text/control outbox's ACK stream so a media
  /// row whose envelope has already been handed to it can complete (delete
  /// staged file + row) the instant Outbox reports the send ACKed — without
  /// this store re-implementing any retry/ack logic of its own for that leg.
  void _hookOutboxStatus() {
    if (_statusHooked) return;
    _statusHooked = true;
    Outbox.I.status.listen((s) {
      if (!s.ok) return;
      final mediaClientId = _watchingEnvelope.remove(s.clientId);
      if (mediaClientId == null) return;
      unawaited(_completeAcked(mediaClientId));
    });
  }

  // ── per-account staging dir ──────────────────────────────────────────────
  Future<Directory> _stageDir() async {
    final base = await getApplicationSupportDirectory();
    final scope = AccountScope.id == null || AccountScope.id!.isEmpty ? 'default' : AccountScope.id!;
    final d = Directory('${base.path}/media_outbox/$scope');
    if (!await d.exists()) await d.create(recursive: true);
    return d;
  }

  // Cap the staging directory at ~512MB, LRU-evicting files that no longer
  // belong to a live (non-acked) row. [J8-lite]
  static const int _kStageCapBytes = 512 * 1024 * 1024;

  Future<void> _pruneStagingDir() async {
    try {
      final dir = await _stageDir();
      if (!await dir.exists()) return;
      final live = <String>{};
      final rows = await _allRows();
      for (final r in rows) {
        live.add(r.stagedPath);
      }
      final files = <File>[];
      var total = 0;
      await for (final e in dir.list()) {
        if (e is File) {
          files.add(e);
          try { total += await e.length(); } catch (_) {}
        }
      }
      if (total <= _kStageCapBytes) return;
      files.sort((a, b) {
        final sa = a.statSync().modified;
        final sb = b.statSync().modified;
        return sa.compareTo(sb);
      });
      for (final f in files) {
        if (total <= _kStageCapBytes) break;
        if (live.contains(f.path)) continue; // never evict a live row's bytes
        try {
          final len = await f.length();
          await f.delete();
          total -= len;
        } catch (_) {}
      }
    } catch (e) {
      AvaLog.I.log('media_outbox', 'staging prune failed: $e');
    }
  }

  // ── writes ────────────────────────────────────────────────────────────────

  /// Stage the plaintext bytes + insert a `queued` row BEFORE encryption/
  /// upload starts. Returns the staged file path. Best-effort: on any staging
  /// failure this returns null and the caller proceeds WITHOUT durability for
  /// this attempt (never blocks a send on disk I/O failing).
  Future<String?> stage({
    required String clientId,
    required Uint8List bytes,
    required String convKey,
    required String kind,
    required String mime,
    required String filename,
    String caption = '',
    String toUid = '',
    String gid = '',
  }) async {
    try {
      await _ensureSchema();
      final dir = await _stageDir();
      final f = File('${dir.path}/$clientId');
      await f.writeAsBytes(bytes, flush: true);
      final now = DateTime.now().millisecondsSinceEpoch;
      await Db.I.customStatement(
        'INSERT OR REPLACE INTO media_outbox '
        '(client_id, envelope_client_id, conv_key, to_uid, gid, kind, mime, filename, caption, '
        ' staged_path, state, attempts, next_attempt_ts, created_ts, updated_ts, media_json) '
        'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)',
        [
          clientId, '', convKey, toUid, gid, kind, mime, filename, caption,
          f.path, 'queued', 0, 0, now, now, '',
        ],
      );
      unawaited(_pruneStagingDir());
      return f.path;
    } catch (e) {
      AvaLog.I.log('media_outbox', 'stage FAILED $clientId: $e');
      return null;
    }
  }

  Future<void> _setState(String clientId, String state, {String? mediaJson, String? envelopeClientId, int? attempts}) async {
    try {
      await _ensureSchema();
      final sets = <String>['state = ?', 'updated_ts = ?'];
      final vars = <Object?>[state, DateTime.now().millisecondsSinceEpoch];
      if (mediaJson != null) { sets.add('media_json = ?'); vars.add(mediaJson); }
      if (envelopeClientId != null) { sets.add('envelope_client_id = ?'); vars.add(envelopeClientId); }
      if (attempts != null) { sets.add('attempts = ?'); vars.add(attempts); }
      vars.add(clientId);
      await Db.I.customStatement(
        'UPDATE media_outbox SET ${sets.join(', ')} WHERE client_id = ?${vars.length}',
        vars,
      );
    } catch (e) {
      AvaLog.I.log('media_outbox', 'setState($state) FAILED $clientId: $e');
    }
  }

  Future<void> markUploading(String clientId) => _setState(clientId, 'uploading');

  /// Upload succeeded — the ciphertext is durably on R2. [mediaJson] is
  /// `ChatMedia.toEnvelope()` so a reconcile after a kill can resend the exact
  /// same reference without re-uploading.
  Future<void> markUploaded(String clientId, String mediaJson) =>
      _setState(clientId, 'uploaded', mediaJson: mediaJson);

  /// The message envelope has been handed to the EXISTING durable [Outbox]
  /// (`envelopeClientId` is the id `AvaDm.send`/`AvaGroupDm.send` returned).
  /// From here Outbox owns retry/backoff for the envelope leg; this store only
  /// waits for Outbox's ACK (see [_hookOutboxStatus]) to clean up.
  Future<void> markEnvelopeSent(String clientId, String envelopeClientId) async {
    await _setState(clientId, 'envelope_sent', envelopeClientId: envelopeClientId);
    await _ensureSchema();
    _watchingEnvelope[envelopeClientId] = clientId;
  }

  Future<void> _completeAcked(String clientId) async {
    try {
      await _ensureSchema();
      final rows = await Db.I.customSelect(
        'SELECT staged_path FROM media_outbox WHERE client_id = ?1',
        variables: [Variable<String>(clientId)],
      ).get();
      if (rows.isNotEmpty) {
        final path = rows.first.read<String>('staged_path');
        try { final f = File(path); if (await f.exists()) await f.delete(); } catch (_) {}
      }
      await Db.I.customStatement('DELETE FROM media_outbox WHERE client_id = ?1', [clientId]);
    } catch (e) {
      AvaLog.I.log('media_outbox', 'complete(acked) FAILED $clientId: $e');
    }
  }

  /// Upload (or envelope hand-off) failed. Schedules a backoff retry rather
  /// than dropping the row — [reconcile] picks it back up. Mirrors [Outbox]'s
  /// backoff schedule (5s, 15s, 60s, then every 2min) so the two queues behave
  /// consistently to the user.
  Future<void> scheduleRetry(String clientId, {required String reason}) async {
    try {
      await _ensureSchema();
      final rows = await Db.I.customSelect(
        'SELECT attempts FROM media_outbox WHERE client_id = ?1',
        variables: [Variable<String>(clientId)],
      ).get();
      final attempts = (rows.isNotEmpty ? rows.first.read<int>('attempts') : 0) + 1;
      final delayMs = switch (attempts) { 1 => 5000, 2 => 15000, 3 => 60000, _ => 120000 };
      final next = DateTime.now().millisecondsSinceEpoch + delayMs;
      await Db.I.customStatement(
        'UPDATE media_outbox SET state = ?1, attempts = ?2, next_attempt_ts = ?3, updated_ts = ?4 WHERE client_id = ?5',
        ['queued', attempts, next, DateTime.now().millisecondsSinceEpoch, clientId],
      );
    } catch (e) {
      AvaLog.I.log('media_outbox', 'scheduleRetry FAILED $clientId: $e');
    }
  }

  /// Terminal give-up (used only if a row has been retried an excessive
  /// number of times — the manual tap-to-retry UI stays available even after
  /// this). Deletes the staged file too.
  Future<void> giveUp(String clientId, {required String reason}) async {
    Analytics.capture('outbox_terminal_failure', {'client_id': clientId, 'reason': reason, 'queue': 'media'});
    await _completeAcked(clientId); // same cleanup (delete staged file + row)
  }

  // ── reads ────────────────────────────────────────────────────────────────

  Future<List<MediaOutboxRow>> _allRows() async {
    await _ensureSchema();
    final rows = await Db.I.customSelect('SELECT * FROM media_outbox').get();
    return [
      for (final r in rows)
        MediaOutboxRow(
          clientId: r.read<String>('client_id'),
          envelopeClientId: r.read<String>('envelope_client_id'),
          convKey: r.read<String>('conv_key'),
          toUid: r.read<String>('to_uid'),
          gid: r.read<String>('gid'),
          kind: r.read<String>('kind'),
          mime: r.read<String>('mime'),
          filename: r.read<String>('filename'),
          caption: r.read<String>('caption'),
          stagedPath: r.read<String>('staged_path'),
          state: r.read<String>('state'),
          attempts: r.read<int>('attempts'),
          nextAttemptTs: r.read<int>('next_attempt_ts'),
          createdTs: r.read<int>('created_ts'),
          updatedTs: r.read<int>('updated_ts'),
          mediaJson: r.read<String>('media_json'),
        ),
    ];
  }

  Future<Uint8List?> readStaged(String stagedPath) async {
    try {
      final f = File(stagedPath);
      if (await f.exists()) return await f.readAsBytes();
    } catch (_) {}
    return null;
  }

  // ── reconcile (thread open / app boot) ──────────────────────────────────

  bool _reconciling = false;

  /// Resume every non-terminal row. Called best-effort from
  /// `ChatThreadScreen.initState` (a thread open is also Outbox's own retry
  /// trigger — this mirrors that). A row in `uploaded`/`envelope_sent` whose
  /// envelope never got picked back up by [_hookOutboxStatus] (e.g. the ACK
  /// listener wasn't attached yet on a previous run) is re-driven here too.
  ///
  /// [resumeUpload] is supplied by the caller (chat_thread.dart) because the
  /// actual encrypt+upload call lives in `MediaService` (media.dart) and this
  /// sync-layer file deliberately has no UI/feature dependency — it only owns
  /// the durable bookkeeping, mirroring how [Outbox] itself never imports a
  /// screen. [resendEnvelope] similarly re-enqueues into the existing [Outbox]
  /// without needing a live socket/thread — `AvaDm.send`/`AvaGroupDm.send`
  /// don't either (see their source): they just call `Outbox.I.enqueue(...)`.
  Future<void> reconcile({
    required Future<({String? mediaId, String toEnvelopeJson})?> Function(MediaOutboxRow row, Uint8List bytes) resumeUpload,
  }) async {
    if (_reconciling) return;
    _reconciling = true;
    try {
      await _ensureSchema();
      final rows = await _allRows();
      final now = DateTime.now().millisecondsSinceEpoch;
      for (final row in rows) {
        if (row.state == 'envelope_sent' && row.envelopeClientId.isNotEmpty) {
          // Already handed to Outbox in a PREVIOUS run of this process (or this
          // one, before a hot-restart re-created the listener). Re-arm the
          // ack watch; if Outbox already completed it while we weren't
          // listening, Outbox.isPending will be false and we can complete now.
          _watchingEnvelope[row.envelopeClientId] = row.clientId;
          if (!Outbox.I.isPending(row.envelopeClientId)) {
            // Outbox has no memory of it — either it was ACKed+echoed and
            // dropped already (safe to complete) or it was never actually
            // enqueued (process died mid-call). Re-send from mediaJson to be
            // safe; Outbox/InboxDO idempotency on client_id makes a duplicate
            // enqueue harmless.
            unawaited(_resendFromRow(row));
          }
          continue;
        }
        if (row.state == 'uploaded') {
          Analytics.capture('media_job_recovered', {'client_id': row.clientId, 'kind': row.kind, 'stage': 'uploaded'});
          unawaited(_resendFromRow(row));
          continue;
        }
        // queued / uploading: resume the upload from the staged file.
        if (row.nextAttemptTs > now) continue; // still backing off
        final bytes = await readStaged(row.stagedPath);
        if (bytes == null) {
          // Staged file is gone (evicted / corrupted) — nothing to resume.
          Analytics.capture('media_orphan_reconciled', {
            'client_id': row.clientId, 'kind': row.kind, 'reason': 'staged_file_missing',
          });
          await giveUp(row.clientId, reason: 'staged_file_missing');
          continue;
        }
        Analytics.capture('media_job_recovered', {'client_id': row.clientId, 'kind': row.kind, 'stage': row.state});
        await markUploading(row.clientId);
        try {
          final result = await resumeUpload(row, bytes);
          if (result == null) {
            await scheduleRetry(row.clientId, reason: 'resume_upload_failed');
            continue;
          }
          await markUploaded(row.clientId, result.toEnvelopeJson);
          final reRow = MediaOutboxRow(
            clientId: row.clientId, envelopeClientId: row.envelopeClientId, convKey: row.convKey,
            toUid: row.toUid, gid: row.gid, kind: row.kind, mime: row.mime, filename: row.filename,
            caption: row.caption, stagedPath: row.stagedPath, state: 'uploaded', attempts: row.attempts,
            nextAttemptTs: row.nextAttemptTs, createdTs: row.createdTs, updatedTs: row.updatedTs,
            mediaJson: result.toEnvelopeJson,
          );
          unawaited(_resendFromRow(reRow));
        } catch (e) {
          AvaLog.I.log('media_outbox', 'resume upload FAILED ${row.clientId}: $e');
          await scheduleRetry(row.clientId, reason: e.toString());
        }
      }
    } finally {
      _reconciling = false;
    }
  }

  /// Re-enqueue the envelope for an already-uploaded row directly through the
  /// existing durable [Outbox] — the same call `AvaDm.send`/`AvaGroupDm.send`
  /// make — without needing a live thread/socket open. Idempotent: Outbox +
  /// the server's client_id dedup make a duplicate enqueue harmless.
  Future<void> _resendFromRow(MediaOutboxRow row) async {
    if (row.mediaJson.isEmpty) return;
    try {
      final env = jsonDecode(row.mediaJson) as Map<String, dynamic>;
      final isGroup = row.gid.isNotEmpty;
      final wire = <String, dynamic>{
        ...env,
        't': isGroup ? 'gmedia' : 'media',
        if (isGroup) 'gid': row.gid,
      };
      final payload = jsonEncode(wire);
      final envelopeClientId = 'ct_${row.clientId}';
      Db.I.upsertMessage(MessagesCompanion.insert(
        rumorId: envelopeClientId, convKey: row.convKey, mine: true, payload: payload,
        createdAt: DateTime.now().millisecondsSinceEpoch ~/ 1000,
        senderPub: Value(isGroup ? (AccountScope.id ?? '') : ''),
      ));
      await markEnvelopeSent(row.clientId, envelopeClientId);
      await Outbox.I.enqueue(
        clientId: envelopeClientId,
        payload: payload,
        convKey: row.convKey,
        to: isGroup ? '' : row.toUid,
        conv: isGroup ? row.gid : '',
        kind: isGroup ? 'gmedia' : 'media',
      );
    } catch (e) {
      AvaLog.I.log('media_outbox', 'resend envelope FAILED ${row.clientId}: $e');
      await scheduleRetry(row.clientId, reason: 'resend_failed');
    }
  }
}
