import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../../../core/analytics.dart';
import '../../../core/api_auth.dart';
import '../../../core/ava_log.dart';
import '../../../core/config.dart';
import '../../avatok/forward_sheet.dart';
import '../../avatok/media.dart' show MediaKind, MediaService;
import 'inbox_api.dart';

/// [AVAINBOX-1] "Forward" — owner spec pic3: the bubble menu needs
/// share/edit/rename/tag/delete/forward. This is distinct from the existing
/// "Send to AvaTOK chat" (inbox_send_to_chat.dart, a single-DM-only picker):
/// Forward reuses the SAME multi-select sheet (`showForwardSheet`) and the
/// SAME `/api/msg/forward` fan-out endpoint every other forwardable message in
/// the app uses (chat_thread.dart's `_forwardToTargets`, not imported/modified
/// here — this is a fresh, parallel call into the same public route so this
/// lane never touches chat_thread.dart), so a voicemail can be forwarded to
/// any MIX of DMs and groups in one send, exactly like forwarding a photo or
/// voice note.
Future<void> forwardVoicemail(
  BuildContext context, {
  required InboxCard card,
  required String callerName,
  required Future<Uint8List?> Function() fetchBytes,
}) async {
  if (!card.hasRecording) return;
  final targets = await showForwardSheet(context, msgKind: 'voicemail');
  if (targets == null || targets.isEmpty) return;
  if (!context.mounted) return;

  final messenger = ScaffoldMessenger.of(context);
  messenger.showSnackBar(const SnackBar(content: Text('Forwarding voicemail…')));

  try {
    final bytes = await fetchBytes();
    if (bytes == null) {
      Analytics.capture('inbox_voicemail_forward', {'ok': false, 'stage': 'fetch'});
      messenger.showSnackBar(const SnackBar(content: Text('Couldn’t load the recording to forward.')));
      return;
    }
    final name = 'Voicemail from $callerName.wav'.replaceAll(RegExp(r'[\\/:*?"<>|]'), '_');
    final media = await MediaService.encryptAndUpload(
      bytes,
      kind: MediaKind.audio,
      contentType: 'audio/wav',
      name: name,
    );
    final payload = {...media.toEnvelope(), 'fwd': true, 'forwarded': true};
    final serverTargets = [
      for (final t in targets) t.isGroup ? {'conv': t.groupId} : {'to': t.peerUid},
    ];
    final res = await ApiAuth.postJson(kMsgForwardUrl, {
      'kind': 'text',
      'body': jsonEncode(payload),
      'media_ref': media.id,
      'targets': serverTargets,
    });
    final ok = res.statusCode == 200;
    Analytics.capture('inbox_voicemail_forward', {
      'ok': ok, 'status': res.statusCode, 'n_targets': targets.length,
      'n_groups': targets.where((t) => t.isGroup).length,
      'duration_s': card.durationSec,
    });
    if (context.mounted) {
      messenger.showSnackBar(SnackBar(
        content: Text(ok
            ? 'Forwarded to ${targets.length} ${targets.length == 1 ? 'chat' : 'chats'}'
            : 'Couldn’t forward the recording.'),
      ));
    }
  } catch (e) {
    AvaLog.I.log('avadial', 'inbox forward failed: $e');
    Analytics.capture('inbox_voicemail_forward', {'ok': false, 'stage': 'send'});
    if (context.mounted) {
      messenger.showSnackBar(const SnackBar(content: Text('Couldn’t forward the recording.')));
    }
  }
}
