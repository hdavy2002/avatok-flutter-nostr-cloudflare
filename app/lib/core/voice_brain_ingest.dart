/// [VOICE-BRAIN-1] Feed the two AvaLibrary voicemail folders — **Ava
/// Receptionist** (messages Ava took on a missed call) and **Voice notes**
/// (voice notes exchanged in chat threads) — into the DEVICE-PRIVATE brain, so
/// "what did Priya say in that voice note last week" and "did anyone leave me a
/// message about the invoice" resolve in Ava's chat thread.
///
/// ── WHY THIS FILE EXISTS (and is NOT inside core/local_brain/) ───────────────
/// `core/local_brain/` is the audited NETWORKLESS module — `AvaLocalBrain` may
/// import nothing that can reach the network, and
/// `test/local_brain_networkless_test.dart` walks its transitive imports and
/// fails the build if that changes. This helper needs [BrainConsent] (which
/// talks to `/api/brain/consent`) and [Analytics], so it lives OUTSIDE the
/// module and calls IN. Nothing here ever sends recording content anywhere:
/// the only sink is [AvaLocalBrain.ingest], i.e. the per-account SQLite file.
///
/// ── PER-ACCOUNT SCOPING (rulebook rule 1) ───────────────────────────────────
/// Inherited twice over, never re-derived:
///   • the brain itself → `AvaLocalBrain` → `AvaLocalIndex` → `Db.I`, the
///     per-account drift file `avatok_<AccountScope.id>.sqlite`;
///   • the dedup marker → [DiskCache], which is already namespaced to
///     `AccountScope.id` (same idiom as `InboxBrainIngestStore`).
/// A parent and a child sharing one phone therefore cannot see each other's
/// voicemails through Ava.
///
/// ── WHERE THE SEARCHABLE TEXT COMES FROM ────────────────────────────────────
/// Two very different answers, and pretending otherwise would be the bug:
///
///   • **Receptionist voicemails DO have a transcript.** The receptionist lane
///     transcribes server-side and the inbox row carries it —
///     `InboxCard.transcript` (`features/avadial/inbox/inbox_api.dart:49,236`).
///     Those are indexed by what was actually SAID.
///
///   • **Chat voice notes usually do NOT.** There is no automatic transcription
///     of a voice note: a transcript only exists if the viewer explicitly asked
///     for one (long-press → Transcribe, `chat_thread/voice.dart`
///     `_ensureTranscript` / `_transcribeVoice`), and it is cached per message.
///     So a voice note is indexed on its METADATA (who, direction, when, and
///     the AvaLibrary key), and UPGRADED to a transcript record if and when one
///     appears. Building an automatic transcription pipeline for every voice
///     note would be a much larger change (cost, consent, battery) and is an
///     owner decision, not one to make here.
///
/// ── WHY THE FACTS GO IN `text`, NOT `meta` ──────────────────────────────────
/// `AvaLocalBrain.ingest`'s `meta` is NOT persisted: it reads exactly one key
/// (`meta['convKey']`) and drops the rest — the row that lands in `ava_fts` is
/// (message_id, conv_key, body, created_at). So "carry the direction and the
/// correspondent in meta" would silently store nothing. Everything that must be
/// searchable or displayable is written into the descriptor body, and the one
/// identifier a caller needs to OPEN the result rides in `sourceId` (which the
/// index keeps and `BrainHit.sourceId` hands back).
library;

import 'dart:convert';

import '../identity/identity.dart' show AccountScope;
import 'analytics.dart';
import 'ava_log.dart';
import 'brain_consent.dart';
import 'disk_cache.dart';
import 'local_brain/local_brain.dart';

/// Which of the two AvaLibrary voicemail folders a record belongs to.
enum VoiceRecordKind {
  /// AvaLibrary › "Ava Receptionist" — a message Ava took on a missed call.
  receptionistVoicemail,

  /// AvaLibrary › "Voice notes" — a voice note sent or received in a chat.
  chatVoiceNote,
}

/// Best-effort "already fed to AvaBrain" marker, keyed by the exact `sourceId`
/// that was ingested. Mirrors `InboxBrainIngestStore`'s shape (a flat id set)
/// so the two stores behave identically; per-account via [DiskCache].
///
/// It is a fast path, not the correctness guarantee: `AvaLocalIndex` keys its
/// FTS row on `message_id == sourceId` and skips an id it has already indexed,
/// so re-ingesting is idempotent even if this file is lost or wiped.
class VoiceBrainIngestStore {
  VoiceBrainIngestStore._();
  static final VoiceBrainIngestStore I = VoiceBrainIngestStore._();

  static const _kCache = 'voice_brain_ingested';

  // In-memory mirror — a thread open asks once per audio bubble, and re-reading
  // the JSON file every time would be a needless burst of disk I/O on the
  // render path. It is KEYED BY ACCOUNT (`_memScope`): the file itself is
  // already per-account via [DiskCache], but a static mirror would otherwise
  // outlive the account that filled it and make the next account's look-ups
  // answer from the previous one's markers — which on a shared parent/child
  // phone would silently SKIP ingesting the new account's notes.
  Set<String>? _mem;
  String? _memScope;

  Future<Set<String>> _load() async {
    final scope = AccountScope.id ?? '';
    final cached = _mem;
    if (cached != null && _memScope == scope) return cached;
    _memScope = scope;
    try {
      final raw = await DiskCache.read(_kCache);
      final ids = (raw == null || raw.isEmpty)
          ? <String>{}
          : (jsonDecode(raw) as List<dynamic>).map((e) => '$e').toSet();
      _mem = ids;
      return ids;
    } catch (e) {
      AvaLog.I.log('voice_brain', 'ingest store load failed: $e');
      final ids = <String>{};
      _mem = ids;
      return ids;
    }
  }

  Future<bool> isIngested(String sourceId) async => (await _load()).contains(sourceId);

  Future<void> markIngested(String sourceId) async {
    if (sourceId.isEmpty) return;
    final ids = await _load();
    if (!ids.add(sourceId)) return;
    try {
      await DiskCache.write(_kCache, jsonEncode(ids.toList()));
    } catch (e) {
      AvaLog.I.log('voice_brain', 'ingest store save failed: $e');
    }
  }

  /// Drop the in-memory mirror. Not required for correctness ([_load] already
  /// re-reads when `AccountScope.id` changes) — exposed so an explicit
  /// account-switch teardown can free it eagerly.
  void onAccountSwitched() {
    _mem = null;
    _memScope = null;
  }
}

/// The ingest entry point for both voicemail folders.
class VoiceBrainIngest {
  VoiceBrainIngest._();

  /// Brain domains. `voicemail` is an existing device-lane domain
  /// (`brain_recall.dart` `_kDeviceDomains`); `voicenote` is added there by this
  /// change so a domain-filtered recall keeps the device lane.
  static const String kDomainVoicemail = 'voicemail';
  static const String kDomainVoiceNote = 'voicenote';

  /// Ingest one recording's descriptor into the device brain.
  ///
  /// Returns true when a NEW record was written (false = consent off, already
  /// ingested, or a failure — all non-fatal).
  ///
  ///   • [record]        — which AvaLibrary folder this belongs to.
  ///   • [sourceKey]     — the stable id that lets a hit be re-opened. For a
  ///                       voice note this is `ChatMedia.id`, which IS the
  ///                       AvaLibrary `LibraryItem.key`; for a receptionist
  ///                       voicemail it is `InboxCard.stableId`.
  ///   • [correspondent] — resolved display name. NEVER pass a raw `user_…`.
  ///   • [outgoing]      — direction. Always false for a receptionist voicemail.
  ///   • [tsSec]         — event time, epoch SECONDS.
  ///   • [transcript]    — what was said, when it exists (see the library doc).
  ///
  /// Never throws.
  static Future<bool> ingest({
    required VoiceRecordKind record,
    required String sourceKey,
    required String correspondent,
    required bool outgoing,
    required int tsSec,
    String correspondentUid = '',
    String correspondentPhone = '',
    int durationSec = 0,
    String? transcript,
    String? summary,
    String? title,
    List<String> tags = const [],
    String groupName = '',
  }) async {
    if (sourceKey.isEmpty) return false;
    final text = (transcript ?? '').trim();
    final hasText = text.isNotEmpty;
    final sourceId = _sourceId(record, sourceKey, hasText);

    try {
      if (await VoiceBrainIngestStore.I.isIngested(sourceId)) return false;
    } catch (_) {/* worst case: one extra idempotent write into the index */}

    if (!await _allowed(record)) {
      // ignore: unawaited_futures
      Analytics.capture('voice_brain_ingest', {
        'ok': false,
        'reason': 'guardrail_off',
        'record': record.name,
        if (Analytics.currentEmail != null) 'email': Analytics.currentEmail!,
      });
      return false;
    }

    try {
      await AvaLocalBrain.I.ingest(
        domain: record == VoiceRecordKind.receptionistVoicemail
            ? kDomainVoicemail
            : kDomainVoiceNote,
        kind: _kind(record, hasText),
        text: describe(
          record: record,
          sourceKey: sourceKey,
          correspondent: correspondent,
          outgoing: outgoing,
          tsSec: tsSec,
          correspondentUid: correspondentUid,
          correspondentPhone: correspondentPhone,
          durationSec: durationSec,
          transcript: transcript,
          summary: summary,
          title: title,
          tags: tags,
          groupName: groupName,
        ),
        meta: {'convKey': _convKey(record, correspondent)},
        ts: tsSec > 0 ? tsSec : DateTime.now().millisecondsSinceEpoch ~/ 1000,
        sourceId: sourceId,
      );
      await VoiceBrainIngestStore.I.markIngested(sourceId);
      // ignore: unawaited_futures
      Analytics.capture('voice_brain_ingest', {
        'ok': true,
        'record': record.name,
        'has_transcript': hasText,
        'outgoing': outgoing,
        'is_group': groupName.isNotEmpty,
        if (Analytics.currentEmail != null) 'email': Analytics.currentEmail!,
      });
      return true;
    } catch (e) {
      AvaLog.I.log('voice_brain', 'ingest FAILED $sourceId: $e');
      // ignore: unawaited_futures
      Analytics.capture('voice_brain_ingest', {
        'ok': false,
        'reason': 'exception',
        'record': record.name,
        if (Analytics.currentEmail != null) 'email': Analytics.currentEmail!,
      });
      return false;
    }
  }

  /// The searchable descriptor. Public so a caller can log/preview exactly what
  /// would be indexed without writing it (and so it is unit-testable without a
  /// database). Deliberately plain English: FTS5 (`porter unicode61`) stems it,
  /// and the vector lane embeds it, so natural phrasing in the query — "voice
  /// note from Priya last week" — lands on these words.
  static String describe({
    required VoiceRecordKind record,
    required String sourceKey,
    required String correspondent,
    required bool outgoing,
    required int tsSec,
    String correspondentUid = '',
    String correspondentPhone = '',
    int durationSec = 0,
    String? transcript,
    String? summary,
    String? title,
    List<String> tags = const [],
    String groupName = '',
  }) {
    final who = correspondent.trim().isEmpty ? 'someone' : correspondent.trim();
    final b = StringBuffer();
    if (record == VoiceRecordKind.receptionistVoicemail) {
      b.writeln('Voicemail — Ava the receptionist took a message from $who');
      b.writeln('Folder: AvaLibrary > Ava Receptionist');
      b.writeln('Direction: incoming');
    } else {
      b.writeln(outgoing
          ? 'Voice note — I sent a voice note to $who'
          : 'Voice note — $who sent me a voice note');
      b.writeln('Folder: AvaLibrary > Voice notes');
      b.writeln('Direction: ${outgoing ? 'outgoing' : 'incoming'}');
      if (groupName.trim().isNotEmpty) {
        b.writeln('Group chat: ${groupName.trim()}');
      }
    }
    b.writeln('With: $who');
    if (correspondentPhone.trim().isNotEmpty) b.writeln('Number: ${correspondentPhone.trim()}');
    if (correspondentUid.trim().isNotEmpty) b.writeln('Contact id: ${correspondentUid.trim()}');
    if (tsSec > 0) b.writeln('When: ${_stamp(tsSec)}');
    if (durationSec > 0) b.writeln('Duration: ${durationSec}s');
    if ((title ?? '').trim().isNotEmpty) b.writeln('Title: ${title!.trim()}');
    if (tags.isNotEmpty) b.writeln('Tags: ${tags.join(', ')}');
    if ((summary ?? '').trim().isNotEmpty) b.writeln('Summary: ${summary!.trim()}');
    if ((transcript ?? '').trim().isNotEmpty) {
      b.writeln('Transcript: ${transcript!.trim()}');
    }
    // The AvaLibrary/media key, so a hit can be resolved back to the real item
    // through the app's own scoped media pipeline (never a synthesized URL —
    // see `brainHitOpenTarget`'s doc in brain_recall.dart). It also rides in
    // `sourceId`; repeating it here costs one short token and makes the body
    // self-contained if a caller only ever sees the snippet.
    b.write('Key: $sourceKey');
    return b.toString();
  }

  /// The guardrail(s) the ingestion pipeline must respect (AvaBrain is ON by
  /// default / opt-out, so a fresh account indexes normally).
  ///
  /// NO NEW FLAG IS INTRODUCED. The existing `voicemail` consent already covers
  /// both folders by its own wording — `brain_consent.dart` `_kConsentBlurb`:
  /// "Transcribe voicemails **and voice notes** so you can find them by what was
  /// said" — and `receptionist`/`voicemails` alias onto it. A chat voice note is
  /// ALSO chat content, so it additionally requires the `messages` guardrail:
  /// someone who turned "Chat content" off did not consent to their chat audio
  /// being indexed just because the voicemail switch is on.
  static Future<bool> _allowed(VoiceRecordKind record) async {
    try {
      if (!await BrainConsent.isOn('voicemail')) return false;
      if (record == VoiceRecordKind.chatVoiceNote) {
        if (!await BrainConsent.isOn('messages')) return false;
      }
      return true;
    } catch (_) {
      return true; // default ON (opt-out model) if the consent read fails
    }
  }

  /// The idempotent primary key.
  ///
  /// A metadata-only record and its later transcript upgrade use DIFFERENT ids
  /// on purpose: `AvaLocalIndex.indexMessage` never rewrites a row it has
  /// already FTS-indexed (that is what makes re-ingestion safe), so the only way
  /// to add the words that were actually said is a second row. They are not
  /// duplicates in any useful sense — one is "a voice note from Priya", the
  /// other is what she said — and `brainRecall`'s `_rank` de-dups identical text.
  ///
  /// `vm:` is UNCHANGED from the pre-existing inbox ingest
  /// (`inbox_thread_screen.dart`), so no already-indexed voicemail is re-written.
  static String _sourceId(VoiceRecordKind record, String key, bool hasText) {
    if (record == VoiceRecordKind.receptionistVoicemail) {
      return hasText ? 'vm:$key' : 'vmm:$key';
    }
    return hasText ? 'vnt:$key' : 'vn:$key';
  }

  static String _kind(VoiceRecordKind record, bool hasText) {
    if (record == VoiceRecordKind.receptionistVoicemail) {
      // 'voicemail_transcript' is the kind the pre-existing inbox ingest used.
      return hasText ? 'voicemail_transcript' : 'voicemail_meta';
    }
    return hasText ? 'voice_note_transcript' : 'voice_note_meta';
  }

  /// The device-lane grouping key. `brain_recall.dart`'s `_deviceDomain` reads
  /// the prefix back out of this, which is why it must stay a real domain name.
  static String _convKey(VoiceRecordKind record, String correspondent) {
    final who = correspondent.trim().isEmpty ? 'unknown' : correspondent.trim();
    return record == VoiceRecordKind.receptionistVoicemail
        ? '$kDomainVoicemail:$who'
        : '$kDomainVoiceNote:$who';
  }

  /// `2026-08-01 14:07` — a date the user can also type back as a query.
  static String _stamp(int tsSec) {
    final d = DateTime.fromMillisecondsSinceEpoch(tsSec * 1000);
    String p(int v) => v.toString().padLeft(2, '0');
    return '${d.year}-${p(d.month)}-${p(d.day)} ${p(d.hour)}:${p(d.minute)}';
  }
}
