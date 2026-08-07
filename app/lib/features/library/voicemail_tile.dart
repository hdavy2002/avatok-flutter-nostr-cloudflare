// [LIB-AUDIO-SPLIT-1] AvaLibrary's single `audio` category, carved into the
// three things it actually contains — and the generated preview tile that
// replaces the generic music glyph on a voice note.
//
// ─── WHY THIS IS CLIENT-SIDE ────────────────────────────────────────────────
// The server has ONE audio bucket. `worker/src/routes/media.ts` derives
// `user_media.category` straight from the mime (`categoryOf`), so a song, a
// chat voice note and (one day) a receptionist voicemail are all `"audio"`.
// Splitting them properly would mean a new column + a migration + a change to
// the `/api/library` contract that every shipped client already depends on.
// None of that is needed: the row ALREADY carries enough to tell them apart,
// so the split is a pure rendering decision made here. No wire change.
//
// ─── WHAT ACTUALLY DISCRIMINATES THEM ───────────────────────────────────────
//  • `original_app` (→ [LibraryItem.app]). Chat voice notes are uploaded by
//    `MediaService` with the header `x-app: 'avatok'` (media.dart:177 encrypted
//    lane, :252 plaintext lane); the worker stores that verbatim
//    (media.ts:147,173). A file the user uploaded through AvaLibrary's own "+"
//    sheet carries `'avalibrary'` (`LibraryApi.uploadFile`'s default).
//  • `file_name` (→ [LibraryItem.name]). Every recorded voice note is literally
//    `voice.m4a` — `chat_thread/voice.dart:221` and `call_outcome_menu.dart:193`
//    are the only two producers and both hardcode it. A song keeps its real
//    name.
//  • `source_kind` (→ [LibraryItem.sourceKind]) is `'sent'` on the sender's row
//    and `'received'` on the recipient's, which IS the incoming/outgoing flag
//    the tile needs. (Both directions land in `category='audio'`: the sender's
//    row categorises on `x-real-mime` = `audio/mp4`, media.ts:174 — only the
//    `mime_type` COLUMN is the opaque `application/octet-stream`, which is why
//    [LibraryItem.mime] must NOT be used to classify.)
//
// ─── THE RECEPTIONIST FOLDER — SERVER GAP NOW CLOSED ────────────────────────
// This used to read 0 forever. Ava's voicemails never reached `user_media` at
// all: all three receptionist engines (`do/reception_room_cf.ts`,
// `do/reception_room.ts`, `do/vobiz_agent_room.ts`) PUT the wav straight to the
// BLOBS bucket at `receptionist/<uid>/<phone>/<sid>.wav` and referenced it only
// from the inbox row + `receptionist_sessions.recording_url`, with playback via
// a bespoke endpoint. Nothing for AvaLibrary to list.
//
// [RECEPT-LIB-1 2026-08-07] All three now register the recording via
// `lib/voicemail_library.ts` → `registerExistingObjectMedia` (a NEW helper —
// `registerArtifactMedia` could NOT be reused because it owns the key and hashes
// the bytes to `u/<uid>/…`, which would have written a SECOND copy of the audio
// under a key with no `receptionist/` prefix, i.e. double storage plus a row
// this file would file under Music). Registration is idempotent on `(uid, key)`
// and best-effort inside `waitUntil` — losing a library row is a nuisance,
// losing a caller's message is not.
//
// So the matchers below (`receptionist/` key prefix first) are live. NOTE only
// NEW recordings appear: existing ones predate registration and need a deliberate
// backfill, which is an admin route, not a migration — `receptionist_sessions`
// lives in DB_META while `user_media` lives in DB_MEDIA, and `size_bytes`
// requires an R2 HEAD per object.

import 'dart:convert';

import 'package:drift/drift.dart' show Variable;
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/db.dart';
import '../../core/library_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../avatok/contacts.dart';

/// The three UI folders carved out of the server's single `audio` category.
enum AudioKind { music, receptionist, voiceNote }

/// Category keys. `audio` keeps the server's own value (it is still what gets
/// sent to `/api/library?category=`); the other two are UI-ONLY identities and
/// are never put on the wire — [AudioKind] narrows the SAME `audio` request
/// client-side.
const String kCatMusic = 'audio';
const String kCatReceptionist = 'ava_receptionist';
const String kCatVoiceNote = 'voice_note';

/// Apps whose audio is a CHAT recording rather than a music file.
const Set<String> _kChatApps = {'avatok', 'avatalk', 'avachat'};

/// The worker's `defaultName()` fallback when a chat upload arrives with no
/// `x-file-name` header: `audio-<hash8>.<ext>` (media.ts:917).
final RegExp _kDefaultAudioName = RegExp(r'^audio-[0-9a-f]{6,}\.');

/// Which of the three folders [m] belongs to. TOTAL — every audio item gets
/// exactly one answer, so nothing is double-listed and nothing vanishes.
///
/// FALLBACK RULE: anything chat-shaped that is not clearly a receptionist
/// recording lands in **Voice notes**, never dropped. A genuine song shared
/// into a chat therefore keeps its real filename and still reads as Music,
/// while an unnameable chat blob is reachable under Voice notes.
AudioKind classifyAudio(LibraryItem m) {
  final n = m.name.toLowerCase();
  final k = m.key.toLowerCase();
  final app = m.app.toLowerCase();

  // 1. Ava receptionist (see the header note — no producer writes these yet).
  if (k.startsWith('receptionist/') ||
      k.contains('/receptionist/') ||
      n.contains('voicemail') ||
      k.contains('voicemail') ||
      app == 'receptionist' ||
      app == 'avarecept' ||
      app == 'avareceptionist') {
    return AudioKind.receptionist;
  }

  // 2. A chat voice note: the hardcoded `voice.m4a`, its historical variants,
  //    or the worker's nameless-upload fallback from a chat app.
  if (n == 'voice.m4a' ||
      n.startsWith('voice.') ||
      n.startsWith('voice_') ||
      n.startsWith('voice-') ||
      (_kChatApps.contains(app) && _kDefaultAudioName.hasMatch(n))) {
    return AudioKind.voiceNote;
  }

  // 3. Everything else with a real filename is real audio.
  return AudioKind.music;
}

/// The [AudioKind] a UI category key selects, or null if the key is not one of
/// the three audio folders.
AudioKind? audioKindOfCat(String key) {
  switch (key) {
    case kCatMusic:
      return AudioKind.music;
    case kCatReceptionist:
      return AudioKind.receptionist;
    case kCatVoiceNote:
      return AudioKind.voiceNote;
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// Correspondent resolution
// ───────────────────────────────────────────────────────────────────────────

/// What the tile prints: who, which way, and when.
class VoiceNoteMeta {
  final String display; // resolved name, or a number — NEVER a raw uid
  final bool outgoing;
  final DateTime at;
  const VoiceNoteMeta({required this.display, required this.outgoing, required this.at});
}

/// Resolves "who is this voice note with" ON DEVICE, with **no network and no
/// await at paint time** — [load] once into state, then [metaFor] is a pure
/// synchronous map lookup safe to call from `build()`.
///
/// THE MAPPING: `LibraryItem.key` IS `ChatMedia.id` (the same identity
/// `LibThumbs` relies on), and every media message envelope persisted in the
/// per-account `messages` table carries that id as `env['id']` next to its
/// `conv_key`. So one query over the local drift DB gives media key → `1:<peer
/// uid>` / `g:<gid>`, which the contacts map turns into a name.
///
/// A received row also carries the SENDER's own R2 path (`u/<uid>/dm/<hash>` —
/// `libraryRecord` stores the key verbatim), so an incoming note still resolves
/// after its message row has been pruned. That is the second line of defence.
///
/// Per-account safety: nothing is persisted here. `Db.I` already reopens per
/// [AccountScope] and `ContactsStore` is account-scoped, and this index is held
/// by a screen State — it dies with the screen rather than outliving an account
/// switch in a static.
class VoiceNoteIndex {
  Map<String, String> _convByMediaKey = const {};
  Map<String, Contact> _byUid = const {};
  bool _ready = false;

  /// True once [load] has finished. Until then callers should pass `null` meta
  /// to the tile rather than render a fallback name that may be wrong.
  bool get ready => _ready;

  Future<void> load() async {
    // Media envelopes only. NOTE the `kind` column cannot be used as the
    // filter: it is populated on the INBOUND path (sync_hub) but left NULL by
    // every outbound insert (media_outbox / dm.send / group_dm), so keying off
    // it would silently lose exactly the outgoing half this feature needs.
    try {
      final rows = await Db.I.customSelect(
        'SELECT conv_key, payload FROM messages WHERE payload LIKE ?1 OR payload LIKE ?2',
        variables: [
          Variable<String>('%"t":"media"%'),
          Variable<String>('%"t":"gmedia"%'),
        ],
      ).get();
      final idx = <String, String>{};
      for (final r in rows) {
        try {
          final env = jsonDecode(r.read<String>('payload'));
          if (env is! Map) continue;
          final id = (env['id'] ?? '').toString();
          if (id.isEmpty) continue;
          idx[id] = r.read<String>('conv_key');
        } catch (_) {/* one unparseable row must not lose the rest */}
      }
      _convByMediaKey = idx;
    } catch (_) {/* no DB / no rows — the key fallback below still works */}

    try {
      final cs = await ContactsStore().load();
      _byUid = {for (final c in cs) c.uid: c};
    } catch (_) {/* unresolved names degrade to the number / Unknown */}

    _ready = true;
  }

  /// SYNCHRONOUS. Safe inside `build()`.
  VoiceNoteMeta metaFor(LibraryItem m) {
    final outgoing = m.sourceKind != 'received';
    final at = DateTime.fromMillisecondsSinceEpoch(m.createdAt);

    var display = '';
    final conv = _convByMediaKey[m.key];
    if (conv != null && conv.startsWith('1:')) {
      display = _nameForUid(conv.substring(2));
    } else if (conv != null && conv.startsWith('g:')) {
      display = 'Group chat';
    }
    if (display.isEmpty && !outgoing) {
      final owner = _uidFromKey(m.key);
      if (owner != null) display = _nameForUid(owner);
    }
    if (display.isEmpty) display = outgoing ? 'a chat' : 'Unknown sender';
    return VoiceNoteMeta(display: display, outgoing: outgoing, at: at);
  }

  /// Name → number → phone → the `tel:` handle. Deliberately returns EMPTY for
  /// an unresolvable uid so the caller falls through to a human fallback: a raw
  /// `user_2xY…` on a tile is worse than "Unknown sender".
  String _nameForUid(String uid) {
    if (uid.isEmpty) return '';
    final c = _byUid[uid];
    if (c != null) {
      if (c.name.trim().isNotEmpty) return c.name.trim();
      if (c.number.trim().isNotEmpty) return c.number.trim();
      if (c.phone.trim().isNotEmpty) return c.phone.trim();
    }
    if (uid.startsWith('tel:')) return uid.substring(4);
    return '';
  }

  /// `u/<uid>/dm/<hash>` → `<uid>` (media.ts `userKey`). Null on any other shape.
  static String? _uidFromKey(String key) {
    final parts = key.split('/');
    if (parts.length >= 3 && parts[0] == 'u' && parts[1].isNotEmpty) return parts[1];
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Date / time
// ───────────────────────────────────────────────────────────────────────────

const List<String> _kMonShort = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

String _hhmm(DateTime d) =>
    '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';

/// Today / Yesterday / "12 Jun" / "12 Jun 2025" — the same ladder
/// `chat_thread/formatting.dart`'s `_dayLabel` uses. Re-stated rather than
/// imported because that file is a `part of chat_thread.dart` and every helper
/// in it is a private extension member on a private State class: none of them
/// are reachable from another library.
String _dayShort(DateTime d) {
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final that = DateTime(d.year, d.month, d.day);
  final diff = today.difference(that).inDays;
  if (diff == 0) return 'Today';
  if (diff == 1) return 'Yesterday';
  final base = '${d.day} ${_kMonShort[d.month - 1]}';
  return d.year == now.year ? base : '$base ${d.year}';
}

/// "Yesterday · 14:07"
String voiceNoteWhen(DateTime d) => '${_dayShort(d)} · ${_hhmm(d)}';

// ───────────────────────────────────────────────────────────────────────────
// The tile
// ───────────────────────────────────────────────────────────────────────────

/// A GENERATED square preview for an audio item that has no frame to show.
///
/// There is deliberately no image here: a voice note is audio, so there is
/// nothing to decode. The tile is painted — a direction pill, the
/// correspondent, and (outgoing) when it was sent — and it lives inside the
/// grid's existing 1:1 box, so the grid never reflows.
class VoiceNoteTile extends StatelessWidget {
  final LibraryItem item;

  /// Null while [VoiceNoteIndex] is still loading — the tile shows the
  /// direction and a muted placeholder rather than a possibly-wrong name.
  final VoiceNoteMeta? meta;

  /// Receptionist tiles read "Ava took this" instead of incoming/outgoing.
  final bool receptionist;

  const VoiceNoteTile({
    super.key,
    required this.item,
    required this.meta,
    this.receptionist = false,
  });

  @override
  Widget build(BuildContext context) {
    final m = meta;
    final outgoing = m?.outgoing ?? false;
    final tint = receptionist
        ? AD.primaryBadge
        : (outgoing ? AD.outgoingCall : AD.incomingCall);
    final label = receptionist ? 'Ava took this' : (outgoing ? 'Outgoing' : 'Incoming');
    final icon = receptionist
        ? PhosphorIcons.robot(PhosphorIconsStyle.bold)
        : (outgoing
            ? PhosphorIcons.arrowUpRight(PhosphorIconsStyle.bold)
            : PhosphorIcons.arrowDownLeft(PhosphorIconsStyle.bold));

    // Outgoing reads "to <name>" (the owner's wording); incoming is just the
    // sender. Both fall back to a muted dash while the index loads.
    final who = m == null ? '—' : (outgoing && !receptionist ? 'to ${m.display}' : m.display);

    return Container(
      color: AD.card,
      child: Container(
        color: tint.withValues(alpha: 0.10),
        padding: const EdgeInsets.all(Msg.s2),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            // Direction pill.
            Container(
              padding: const EdgeInsets.symmetric(horizontal: Msg.s2, vertical: 2),
              decoration: BoxDecoration(
                color: tint.withValues(alpha: 0.22),
                borderRadius: Msg.brPill,
                border: Border.all(color: tint.withValues(alpha: 0.55), width: 1),
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                PhosphorIcon(icon, size: 10, color: tint),
                const SizedBox(width: 3),
                Flexible(
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: ADText.statCaption(c: tint),
                  ),
                ),
              ]),
            ),
            Flexible(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(children: [
                    PhosphorIcon(PhosphorIcons.waveform(PhosphorIconsStyle.bold),
                        size: 13, color: AD.textTertiary),
                    const SizedBox(width: 4),
                    Expanded(
                      child: Text(
                        who,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: ADText.statCaption(c: AD.textPrimary),
                      ),
                    ),
                  ]),
                  // The owner asked for the date + time on OUTGOING tiles: an
                  // outgoing note is "one I sent to X, then", and the grid's
                  // date header alone doesn't carry the time.
                  if (m != null && (outgoing || receptionist)) ...[
                    const SizedBox(height: 2),
                    Text(
                      voiceNoteWhen(m.at),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: ADText.statCaption(),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
