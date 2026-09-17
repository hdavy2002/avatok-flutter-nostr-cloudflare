
import '../../../core/localization/ui_text.dart';
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
  messenger.showSnackBar(const SnackBar(content: UiText(UiMessage.m_forwarding_voicemail_3d712627b7)));

  try {
    final bytes = await fetchBytes();
    if (bytes == null) {
      Analytics.capture('inbox_voicemail_forward', {'ok': false, 'stage': 'fetch'});
      messenger.showSnackBar(const SnackBar(content: UiText(UiMessage.m_couldn_t_load_the_recording_9cd54fae5a)));
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
            ? uiCopy(UiMessage.m_forwarded_to_value1_value2_b8609d9420, {'value1': (targets.length).toString(), 'value2': (targets.length == 1 ? 'chat' : 'chats').toString()})
            : uiCopy(UiMessage.m_couldn_t_forward_the_recording_95e2efd0a0)),
      ));
    }
  } catch (e) {
    AvaLog.I.log('avadial', 'inbox forward failed: $e');
    Analytics.capture('inbox_voicemail_forward', {'ok': false, 'stage': 'send'});
    if (context.mounted) {
      messenger.showSnackBar(const SnackBar(content: UiText(UiMessage.m_couldn_t_forward_the_recording_95e2efd0a0)));
    }
  }
}
