import 'dart:convert';

import 'package:http/http.dart' as http;

import '../../../core/api_auth.dart';
import '../../../core/ava_log.dart';
import '../../../core/config.dart';
import '../../../identity/identity.dart';

/// AvaDial Inbox data layer (Specs/PLAN-2026-07-16-ava-receptionist-guardian-
/// FINAL.md, Owner-locked scope item 2 + Phase 3 AVA-RCPT-8/9/10).
///
/// Reads the owner's stored voicemail / Ava-Receptionist cards straight off the
/// EXISTING `GET /api/msg/sync` route (worker/src/routes/messaging.ts `syncMsg`
/// → worker/src/do/inbox.ts `InboxDO.syncPayload()`), the same per-account
/// InboxDO cursor-sync endpoint the legacy SyncHub/DM stack already uses
/// internally. That endpoint returns PLAINTEXT rows — no NIP-44/gift-wrap
/// decrypt needed — per the 2026-06-09 Cloudflare-native architecture pivot
/// (CLAUDE.md: "AvaVerse is now ... server-readable ... per-user InboxDO").
/// This module calls it directly via [ApiAuth] so the new Inbox surface does
/// not have to boot the whole legacy Identity/SyncHub/nostr machinery just to
/// read its own owner's voicemail cards.
///
/// `worker/src/do/inbox.ts` `messages` row columns (unchanged by this lane —
/// no worker file is touched here): `id, conv, sender, kind, body, media_ref,
/// client_id, created_at, edited_at, audience, hidden, conv_seq, mid`. `body`
/// is the JSON envelope for special kinds (mirrors what
/// `app/lib/features/avatok/chat_thread.dart`'s `_ReceptionistCard` /
/// `business_thread_widgets.dart`'s `VoicemailCard` already parse — this file
/// is a fresh, parallel reader of the SAME wire shape; neither of those files
/// is imported or modified here).
///
/// Conv-id namespace (per the plan): existing business-call voicemails use
/// `voicemail_<ownerUid>__<callerUid>` (worker/src/do/voicemail_room.ts); the
/// new PSTN receptionist lane (Phase 1-4, still landing in parallel) uses
/// `recept_<owner>__tel:<E.164>` for a known number and
/// `recept_<owner>__anon_<CallUUID>` for a hidden-caller-ID call (one thread
/// per anonymous call, per the AVA-RCPT-9 amendment). This module filters on
/// BOTH prefixes so the Inbox lights up incrementally as each lane ships.
class InboxCard {
  final String id; // InboxDO row id (sync cursor position) — also the sort key
  final String conv;
  final String kind; // 'voicemail' | 'recept'
  final int createdAtMs;
  final String? sessionId;
  final String? callerName;
  final String? callerPhone;
  final String? transcript;
  final String? summaryText; // one-line reason/summary shown above the transcript
  final int durationSec;
  final String? mediaRef; // R2 recording key
  final bool hasRecording;
  // The raw `messages.client_id` column (distinct from [sessionId], which
  // falls back through session_id/sid/client_id in that order — this is
  // ALWAYS the literal column, needed as the exact `target` the server's
  // `hide` RPC expects: `UPDATE messages SET hidden=?1 WHERE conv=?2 AND
  // client_id=?3` (worker/src/do/inbox.ts `hide()`).
  final String? clientId;

  const InboxCard({
    required this.id,
    required this.conv,
    required this.kind,
    required this.createdAtMs,
    this.sessionId,
    this.callerName,
    this.callerPhone,
    this.transcript,
    this.summaryText,
    this.durationSec = 0,
    this.mediaRef,
    this.hasRecording = false,
    this.clientId,
  });

  /// The stable per-card id used for the heard/unheard store and as the
  /// `hide` target — prefers the real `client_id` column, falls back to the
  /// sync-cursor row [id] for any legacy row that somehow lacks one.
  String get stableId => (clientId != null && clientId!.isNotEmpty) ? clientId! : id;

  /// [AVA-INBOX-READSTATE] Compact JSON for the on-disk, per-account inbox
  /// thread cache (inbox_thread_cache.dart) — NOT the wire shape; this is our
  /// own serialization of the already-parsed card, used only to render the
  /// list instantly from disk on open before the network refresh lands.
  Map<String, dynamic> toJson() => {
        'id': id,
        'conv': conv,
        'kind': kind,
        'createdAtMs': createdAtMs,
        if (sessionId != null) 'sessionId': sessionId,
        if (callerName != null) 'callerName': callerName,
        if (callerPhone != null) 'callerPhone': callerPhone,
        if (transcript != null) 'transcript': transcript,
        if (summaryText != null) 'summaryText': summaryText,
        'durationSec': durationSec,
        if (mediaRef != null) 'mediaRef': mediaRef,
        'hasRecording': hasRecording,
        if (clientId != null) 'clientId': clientId,
      };

  factory InboxCard.fromJson(Map<String, dynamic> j) => InboxCard(
        id: (j['id'] ?? '').toString(),
        conv: (j['conv'] ?? '').toString(),
        kind: (j['kind'] ?? '').toString(),
        createdAtMs: (j['createdAtMs'] as num?)?.toInt() ?? 0,
        sessionId: j['sessionId'] as String?,
        callerName: j['callerName'] as String?,
        callerPhone: j['callerPhone'] as String?,
        transcript: j['transcript'] as String?,
        summaryText: j['summaryText'] as String?,
        durationSec: (j['durationSec'] as num?)?.toInt() ?? 0,
        mediaRef: j['mediaRef'] as String?,
        hasRecording: j['hasRecording'] == true,
        clientId: j['clientId'] as String?,
      );

  /// Parses one `messages` row from `/api/msg/sync`. Returns null for any row
  /// that isn't a voicemail/receptionist kind (the caller should already have
  /// filtered by `conv` prefix, but this is a second, cheap guard).
  static InboxCard? fromRow(Map<String, dynamic> row) {
    final kind = (row['kind'] ?? '').toString();
    if (kind != 'voicemail' && kind != 'recept') return null;
    Map<String, dynamic> e = const {};
    final rawBody = row['body'];
    try {
      if (rawBody is String && rawBody.trim().startsWith('{')) {
        final j = jsonDecode(rawBody);
        if (j is Map) e = j.cast<String, dynamic>();
      }
    } catch (_) {
      // Malformed/legacy body — the card still renders with whatever the row
      // itself carries (caller/time), just without transcript/summary detail.
    }
    final summary = e['summary'];
    final callerName = (e['caller_name'] ?? (summary is Map ? summary['caller_name'] : null))
        ?.toString();
    final callerPhone = (e['caller_phone'] ?? e['caller_number'])?.toString();
    final transcript = (e['transcript'] ?? '').toString().trim();
    final reasonFromSummary = summary is Map ? (summary['reason'] ?? '').toString() : '';
    var reason = reasonFromSummary.isNotEmpty ? reasonFromSummary : (e['text'] ?? '').toString();
    reason = reason.trim();
    // [AVAVM-TRANSCRIPT-1] Defensive strip for ALREADY-DELIVERED envelopes.
    // Before this fix, the worker baked the full transcript into `text` too
    // ("📞 Voicemail from X: <transcript>"), and this screen (and
    // inbox_thread_screen.dart) also renders the expandable transcript block
    // from [transcript] separately — so those historical rows would render
    // the same words twice forever, since past messages are never rewritten
    // server-side. Voicemail envelopes never carry `summary.reason`, so this
    // only ever touches the `e['text']` fallback path. Whitespace-normalized
    // substring match (not exact-equality) because `text` may have collapsed
    // newlines differently than `transcript`, and a long-prefix fallback
    // covers the case where `text` truncated the transcript.
    if (transcript.isNotEmpty && reasonFromSummary.isEmpty && reason.isNotEmpty) {
      final normReason = reason.replaceAll(RegExp(r'\s+'), ' ');
      final normTranscript = transcript.replaceAll(RegExp(r'\s+'), ' ');
      int idx = normTranscript.isNotEmpty ? normReason.indexOf(normTranscript) : -1;
      if (idx < 0 && normTranscript.length > 40) {
        idx = normReason.indexOf(normTranscript.substring(0, 40));
      }
      if (idx > 0) {
        var head = normReason.substring(0, idx).trimRight();
        if (head.endsWith(':')) head = head.substring(0, head.length - 1).trimRight();
        reason = head;
      }
    }
    final mediaRef = (row['media_ref'] ?? e['media_ref'])?.toString();
    final hasRecording = e['has_recording'] == true ||
        (mediaRef != null && mediaRef.trim().isNotEmpty) ||
        (e['recording_url'] ?? '').toString().trim().isNotEmpty;
    return InboxCard(
      id: (row['id'] ?? '').toString(),
      conv: (row['conv'] ?? '').toString(),
      kind: kind,
      createdAtMs: _tsMs(row['created_at']),
      sessionId: (e['session_id'] ?? e['sid'] ?? row['client_id'])?.toString(),
      callerName: (callerName != null && callerName.trim().isNotEmpty) ? callerName : null,
      callerPhone: (callerPhone != null && callerPhone.trim().isNotEmpty) ? callerPhone : null,
      transcript: transcript.isEmpty ? null : transcript,
      summaryText: reason.trim().isEmpty ? null : reason.trim(),
      durationSec: (e['duration_s'] as num?)?.toInt() ?? 0,
      mediaRef: (mediaRef != null && mediaRef.trim().isNotEmpty) ? mediaRef : null,
      hasRecording: hasRecording,
      clientId: (row['client_id'] ?? '').toString().isEmpty ? null : row['client_id'].toString(),
    );
  }
}

/// Tolerant ms-epoch parse. `created_at` is sender-stamped and normally
/// already ms (`Date.now()` server-side default), but guard against a stray
/// seconds-scale value the same way the rest of the codebase does.
int _tsMs(dynamic v) {
  final n = (v is num) ? v : num.tryParse('$v');
  if (n == null) return 0;
  final i = n.toInt();
  return i > 100000000000 ? i : i * 1000;
}

/// One AvaDial Inbox thread: every [InboxCard] for one caller, oldest first
/// (newest last — matches the "newest at bottom" thread-view spec).
class InboxThread {
  final String conv;
  /// The caller-identifying suffix of the conv id — `tel:<E.164>`,
  /// `anon_<CallUUID>`, or a bare AvaTOK uid (business-call voicemail). Null
  /// only if the id didn't match either known namespace shape.
  final String? callerKey;
  final List<InboxCard> cards;
  final bool unread;

  const InboxThread({
    required this.conv,
    required this.callerKey,
    required this.cards,
    required this.unread,
  });

  InboxCard get latest => cards.last;

  /// True when [callerKey] is a phone number (`tel:<E.164>`).
  bool get isTel => callerKey != null && callerKey!.startsWith('tel:');
  /// True when the caller's number was hidden (one thread per call).
  bool get isAnonymous => callerKey != null && callerKey!.startsWith('anon_');

  /// The bare E.164 number for a [isTel] thread, else null.
  String? get telPhone => isTel ? callerKey!.substring(4) : null;

  /// [AVA-INBOX-READSTATE] JSON for the per-account inbox thread cache
  /// (inbox_thread_cache.dart). Serializes every card so the cached paint is
  /// identical to a fresh fetch (unread badge, preview text, timestamps).
  Map<String, dynamic> toJson() => {
        'conv': conv,
        if (callerKey != null) 'callerKey': callerKey,
        'unread': unread,
        'cards': cards.map((c) => c.toJson()).toList(),
      };

  factory InboxThread.fromJson(Map<String, dynamic> j) => InboxThread(
        conv: (j['conv'] ?? '').toString(),
        callerKey: j['callerKey'] as String?,
        unread: j['unread'] == true,
        cards: ((j['cards'] as List?) ?? const [])
            .whereType<Map>()
            .map((m) => InboxCard.fromJson(m.cast<String, dynamic>()))
            .toList(),
      );
}

class InboxApi {
  InboxApi._();

  static const _kPrefixes = ['voicemail_', 'recept_'];

  static bool _isInboxConv(String conv) => _kPrefixes.any((p) => conv.startsWith(p));

  /// Pulls every sync page (cursor-paginated, `SYNC_LIMIT` rows per page
  /// server-side) and returns the voicemail/recept rows plus the latest
  /// per-conv unread snapshot. Bounded to 20 pages as a hard stop against a
  /// runaway loop if the cursor were ever to stop advancing.
  static Future<({List<InboxCard> cards, Map<String, bool> unread})> _fetchAll() async {
    final cards = <InboxCard>[];
    final unread = <String, bool>{};
    var cursor = 0;
    for (var page = 0; page < 20; page++) {
      final http.Response res;
      try {
        res = await ApiAuth.getSigned('$kApiBase/msg/sync?cursor=$cursor',
            timeout: const Duration(seconds: 15));
      } catch (e) {
        AvaLog.I.log('avadial', 'inbox sync failed: $e');
        break;
      }
      if (res.statusCode != 200) break;
      Map<String, dynamic> j;
      try {
        final decoded = jsonDecode(res.body);
        if (decoded is! Map) break;
        j = decoded.cast<String, dynamic>();
      } catch (_) {
        break;
      }
      final rows = (j['messages'] as List?) ?? const [];
      // conv_meta is a FULL snapshot every call (not cursor-filtered) — safe to
      // overwrite on every page; the last page wins with the same values.
      for (final c in (j['convs'] as List?) ?? const []) {
        if (c is! Map) continue;
        final conv = (c['conv'] ?? '').toString();
        if (!_isInboxConv(conv)) continue;
        final u = (c['unread'] as num?)?.toInt() ?? 0;
        unread[conv] = u > 0;
      }
      if (rows.isEmpty) break;
      var maxId = cursor;
      for (final r in rows) {
        if (r is! Map) continue;
        final row = r.cast<String, dynamic>();
        final conv = (row['conv'] ?? '').toString();
        final rid = int.tryParse('${row['id']}') ?? 0;
        if (rid > maxId) maxId = rid;
        if (!_isInboxConv(conv)) continue;
        if (row['hidden'] == true || row['hidden'] == 1) continue;
        final card = InboxCard.fromRow(row);
        if (card != null) cards.add(card);
      }
      if (rows.length < 200 || maxId <= cursor) break; // last page or stuck cursor
      cursor = maxId;
    }
    return (cards: cards, unread: unread);
  }

  /// The caller-identifying suffix of a conv id (see [InboxThread.callerKey]).
  /// Conv ids look like `<prefix><ownerUid>__<callerKey>` — the owner segment
  /// length varies, so this splits on the LAST `__` rather than assuming a
  /// fixed owner-uid length.
  static String? _callerKeyOf(String conv) {
    for (final p in _kPrefixes) {
      if (!conv.startsWith(p)) continue;
      final rest = conv.substring(p.length);
      final sep = rest.lastIndexOf('__');
      if (sep < 0) return null;
      return rest.substring(sep + 2);
    }
    return null;
  }

  /// Grouped, newest-thread-first list for the Inbox list screen.
  static Future<List<InboxThread>> threads() async {
    final res = await _fetchAll();
    final byConv = <String, List<InboxCard>>{};
    for (final c in res.cards) {
      byConv.putIfAbsent(c.conv, () => []).add(c);
    }
    final out = <InboxThread>[];
    byConv.forEach((conv, list) {
      list.sort((a, b) => a.createdAtMs.compareTo(b.createdAtMs));
      out.add(InboxThread(
        conv: conv,
        callerKey: _callerKeyOf(conv),
        cards: list,
        unread: res.unread[conv] ?? false,
      ));
    });
    out.sort((a, b) => b.latest.createdAtMs.compareTo(a.latest.createdAtMs));
    return out;
  }

  /// Cards for ONE conversation, oldest first (thread screen).
  static Future<List<InboxCard>> cardsFor(String conv) async {
    final res = await _fetchAll();
    final list = res.cards.where((c) => c.conv == conv).toList()
      ..sort((a, b) => a.createdAtMs.compareTo(b.createdAtMs));
    return list;
  }

  /// Marks a conversation read (mirrors every other AvaTOK thread — `POST
  /// /api/msg/read`, worker/src/routes/messaging.ts `readMsg`). Best-effort;
  /// the Inbox list re-derives unread from the server on next load either way.
  static Future<void> markRead(String conv) async {
    try {
      await ApiAuth.postJson('$kApiBase/msg/read', {
        'conv': conv,
        'read_ts': DateTime.now().millisecondsSinceEpoch ~/ 1000,
      });
    } catch (e) {
      AvaLog.I.log('avadial', 'inbox mark-read failed: $e');
    }
  }

  /// Owner soft-delete for ONE voicemail card — the EXACT client path
  /// `chat_thread.dart`'s `_syncHidden` already uses for "delete for me"
  /// (`POST kMsgHideUrl` → `worker/src/do/inbox.ts` `hide()`, which flips the
  /// row's `hidden` column and broadcasts a `{type:'hide'}` frame to the
  /// owner's other devices). `_fetchAll()` above already filters out
  /// `hidden == true` rows, so once this call succeeds the next `threads()`/
  /// `cardsFor()` read simply stops returning the card — no separate local
  /// hidden-ids store needed. Returns true on a 200 so the caller can decide
  /// whether to also drop it from any in-memory list immediately.
  static Future<bool> hideCard(String conv, String clientId) async {
    try {
      final res = await ApiAuth.postJson(
          kMsgHideUrl, {'conv': conv, 'target': clientId, 'hidden': true});
      return res.statusCode == 200;
    } catch (e) {
      AvaLog.I.log('avadial', 'inbox hide failed: $e');
      return false;
    }
  }
}

/// Re-exported so callers only need this one import for the account uid used
/// to sanity-check a conv namespace belongs to the signed-in owner. Not used
/// for filtering (the server's own /api/msg/sync already scopes rows to the
/// caller's InboxDO) but kept available for a reviewer/telemetry cross-check.
String? currentOwnerUid() => AccountScope.id;
