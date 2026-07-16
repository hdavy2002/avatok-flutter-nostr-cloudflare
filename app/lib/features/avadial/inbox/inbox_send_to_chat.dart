import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/api_auth.dart';
import '../../../core/ava_log.dart';
import '../../../core/config.dart';
import '../../../core/ui/avatok_dark.dart';
import '../../../identity/identity.dart';
import '../../../sync/dm.dart';
import '../../../sync/sync_hub.dart';
import '../../avatok/contacts.dart';
import '../../avatok/media.dart' show MediaKind, MediaService;
import '../avadial_theme.dart';
import 'inbox_api.dart';

/// [INBOX-SENDCHAT-1] "Send to AvaTOK chat" — forwards ONE voicemail
/// recording into an ordinary AvaTOK 1:1 chat as a normal playable voice
/// note. Reuses the EXACT pieces `chat_thread.dart`'s own voice-note send
/// path uses, without importing or modifying that file:
///   - `MediaService.encryptAndUpload(bytes, kind: MediaKind.audio, ...)`
///     (chat_thread.dart `_upload`) — same client-side AES-GCM encrypt +
///     upload to R2 every chat attachment uses.
///   - `ChatMedia.toEnvelope()` → `{'t': 'media', 'kind': 'audio', ...}` —
///     the SAME envelope shape `_stopAndSendRecording` produces for a
///     live-recorded voice note, so the recipient's chat_thread renders this
///     exactly like any other voice note bubble.
///   - `AvaDm` (sync/dm.dart) — the same standalone 1:1-send class
///     `chat_thread.dart._setupDm` constructs (`AvaDm(client:
///     SyncHub.I.ensure(...), myPriv: id.uid, myPub: id.uid, peerPub: ...)`),
///     used here as a one-shot sender: `.send()` enqueues onto the durable
///     Outbox (same at-least-once delivery every DM gets) then this local
///     instance is torn down — the actual POST/retry lives in the
///     already-running `Outbox.I` singleton, so nothing is lost by not
///     keeping this `AvaDm` alive.
///
/// The contact picker is a minimal single-select list over
/// [ContactsStore] (not `forward_sheet.dart`, which is text-forward-only UI
/// coupled to `chat_thread.dart`'s own `_forward` sender) — same visual
/// idiom as the rest of this Inbox surface (bottom sheet, grab handle,
/// AvaDialTheme colors).
Future<void> sendVoicemailToChat(
  BuildContext context, {
  required InboxCard card,
  required String callerName,
}) async {
  if (!card.hasRecording) return;
  final contact = await _pickContact(context);
  if (contact == null) return; // cancelled
  if (!context.mounted) return;

  final messenger = ScaffoldMessenger.of(context);
  messenger.showSnackBar(SnackBar(content: Text('Sending to ${contact.name}…')));

  try {
    final bytes = await _fetchRecordingBytes(card);
    if (bytes == null) {
      Analytics.capture('inbox_send_to_chat', {'ok': false, 'stage': 'fetch'});
      messenger.showSnackBar(const SnackBar(content: Text('Couldn’t load the recording to send.')));
      return;
    }
    final id = await IdentityStore().load();
    if (id == null) {
      Analytics.capture('inbox_send_to_chat', {'ok': false, 'stage': 'identity'});
      messenger.showSnackBar(const SnackBar(content: Text('Couldn’t send — try again after signing in.')));
      return;
    }
    final name = 'Voicemail from $callerName.wav'
        .replaceAll(RegExp(r'[\\/:*?"<>|]'), '_');
    final media = await MediaService.encryptAndUpload(
      bytes,
      kind: MediaKind.audio,
      contentType: 'audio/wav',
      name: name,
    );
    final dm = AvaDm(
      client: SyncHub.I.ensure(id.uid, id.uid),
      myPriv: id.uid,
      myPub: id.uid,
      peerPub: contact.uid,
    );
    dm.start();
    dm.send(jsonEncode(media.toEnvelope()));
    dm.stop(); // Outbox.I (already running) owns the actual POST/retry from here.
    Analytics.capture('inbox_send_to_chat', {
      'ok': true, 'bytes': bytes.length, 'duration_s': card.durationSec,
    });
    if (context.mounted) {
      messenger.showSnackBar(SnackBar(content: Text('Sent to ${contact.name}')));
    }
  } catch (e) {
    AvaLog.I.log('avadial', 'inbox send-to-chat failed: $e');
    Analytics.capture('inbox_send_to_chat', {'ok': false, 'stage': 'send'});
    if (context.mounted) {
      messenger.showSnackBar(const SnackBar(content: Text('Couldn’t send the recording.')));
    }
  }
}

/// Cache-first bytes fetch — mirrors `_VoicemailCardState._fetchBytes` in
/// inbox_thread_screen.dart (same cache key shape, same endpoint), kept as
/// its own copy since that method is private to that file's State class.
///
/// [AVAINBOX-1] Content-addressed by `media_ref` (the R2 recording key) when
/// available — same scheme inbox_thread_screen.dart moved to, so this picker
/// and the thread screen share ONE cache entry for the same recording instead
/// of two independent ones (the confirmed root cause of "it keeps
/// redownloading" — see inbox_thread_screen.dart's `_cacheKey` doc).
Future<Uint8List?> _fetchRecordingBytes(InboxCard card) async {
  final ref = card.mediaRef;
  final cacheKey = (ref != null && ref.isNotEmpty)
      ? 'vm_${ref.replaceAll(RegExp(r'[^a-zA-Z0-9_.-]'), '_')}'
      : 'inbox_${card.sessionId ?? card.id}';
  try {
    final cached = await MediaService.cachedBlob(cacheKey);
    if (cached != null && cached.isNotEmpty) return cached;
    final key = card.mediaRef;
    if (key == null || key.isEmpty) return null;
    final url = '$kApiBase/voicemail/recording?key=${Uri.encodeQueryComponent(key)}';
    final r = await ApiAuth.getBytes(url);
    if (r.statusCode == 200 && r.bodyBytes.isNotEmpty) {
      await MediaService.writeBlob(cacheKey, r.bodyBytes);
      return r.bodyBytes;
    }
  } catch (_) {/* caller shows the failure snackbar */}
  return null;
}

/// Minimal single-select contact picker — bottom sheet, same visual idiom as
/// the rest of this feature. Excludes phone-only ("tel:…") contacts: they
/// have no AvaTOK inbox to deliver a DM into ([Contact.isPhoneOnly]).
Future<Contact?> _pickContact(BuildContext context) {
  return showModalBottomSheet<Contact>(
    context: context,
    backgroundColor: AvaDialTheme.surface,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      side: BorderSide(color: AvaDialTheme.border, width: 1),
      borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
    ),
    builder: (ctx) => const _ContactPickerSheet(),
  );
}

class _ContactPickerSheet extends StatefulWidget {
  const _ContactPickerSheet();

  @override
  State<_ContactPickerSheet> createState() => _ContactPickerSheetState();
}

class _ContactPickerSheetState extends State<_ContactPickerSheet> {
  final _search = TextEditingController();
  List<Contact> _contacts = [];
  bool _loading = true;
  String _query = '';

  @override
  void initState() {
    super.initState();
    _load();
    _search.addListener(() {
      final q = _search.text.trim().toLowerCase();
      if (q != _query) setState(() => _query = q);
    });
  }

  Future<void> _load() async {
    final all = await ContactsStore().load();
    if (!mounted) return;
    setState(() {
      _contacts = all.where((c) => !c.isPhoneOnly).toList();
      _loading = false;
    });
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  List<Contact> get _filtered => _query.isEmpty
      ? _contacts
      : _contacts
          .where((c) =>
              c.name.toLowerCase().contains(_query) ||
              c.subtitle.toLowerCase().contains(_query))
          .toList();

  @override
  Widget build(BuildContext context) {
    final contacts = _filtered;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const SizedBox(height: 10),
          Container(
            width: 40, height: 4,
            decoration:
                BoxDecoration(color: AvaDialTheme.textMute, borderRadius: BorderRadius.circular(100)),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
            child: Row(children: [
              Text('Send to', style: ADText.threadName(c: AvaDialTheme.text)),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Container(
              decoration: BoxDecoration(
                color: AvaDialTheme.surface2,
                borderRadius: BorderRadius.circular(AD.rInput),
                border: Border.all(color: AvaDialTheme.border, width: 1),
              ),
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Row(children: [
                PhosphorIcon(PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
                    size: 18, color: AvaDialTheme.textMute),
                const SizedBox(width: 8),
                Expanded(
                  child: TextField(
                    controller: _search,
                    style: ADText.rowName(c: AvaDialTheme.text),
                    decoration: InputDecoration(
                      border: InputBorder.none,
                      isDense: true,
                      contentPadding: const EdgeInsets.symmetric(vertical: 13),
                      hintText: 'Search contacts',
                      hintStyle: ADText.preview(c: AvaDialTheme.textMute),
                    ),
                  ),
                ),
              ]),
            ),
          ),
          const SizedBox(height: 6),
          Flexible(
            child: _loading
                ? const Padding(
                    padding: EdgeInsets.symmetric(vertical: 40),
                    child: CircularProgressIndicator(color: AvaDialTheme.accent))
                : contacts.isEmpty
                    ? Padding(
                        padding: const EdgeInsets.symmetric(vertical: 30),
                        child: Text(
                          _query.isEmpty ? 'No AvaTOK contacts yet' : 'No matches',
                          style: ADText.preview(c: AvaDialTheme.textSoft),
                        ),
                      )
                    : ListView.builder(
                        shrinkWrap: true,
                        padding: const EdgeInsets.fromLTRB(8, 4, 8, 16),
                        itemCount: contacts.length,
                        itemBuilder: (ctx, i) {
                          final c = contacts[i];
                          return ListTile(
                            title: Text(c.name, style: ADText.rowName(c: AvaDialTheme.text)),
                            subtitle: c.subtitle.isNotEmpty
                                ? Text(c.subtitle, style: ADText.preview(c: AvaDialTheme.textMute))
                                : null,
                            onTap: () => Navigator.pop(context, c),
                          );
                        },
                      ),
          ),
        ]),
      ),
    );
  }
}
