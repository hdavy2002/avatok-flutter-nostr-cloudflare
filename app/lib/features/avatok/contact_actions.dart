import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';
import '../../push/push_service.dart';
import 'contacts.dart';
import 'forward_sheet.dart';

/// [FIX-CONTACT-1] Shared contact-row context-menu actions.
///
/// This is the ONE canonical implementation of Copy / Share (vCard) / Forward
/// for a saved [Contact]. Every contact-row long-press menu across the app
/// (AvaPhone contacts, the chat list, the dialpad favourites) calls these so
/// there is exactly one pattern — no per-screen re-implementation.
///
/// Forward reuses Stream I's [showForwardSheet] + the existing card message kind
/// ('card') so it never competes with the forward-to-groups system.
class ContactActions {
  /// Best contact number to display/copy: AvaTOK number first, then real phone.
  static String _bestNumber(Contact c) =>
      c.number.isNotEmpty ? c.number : c.phone;

  /// Copy a contact to the clipboard as "Name — +number" (plus " · @handle" when
  /// a handle is present). Shows a 'Contact copied' snackbar.
  static Future<void> copy(BuildContext context, Contact c) async {
    final name = c.name.isNotEmpty ? c.name : _bestNumber(c);
    final num = _bestNumber(c);
    final hasHandle = c.handle.isNotEmpty;
    final buf = StringBuffer(name);
    if (num.isNotEmpty) buf.write(' — $num');
    if (hasHandle) buf.write(' · ${c.atHandle}');
    await Clipboard.setData(ClipboardData(text: buf.toString()));
    Analytics.capture('contact_copied', {
      'has_handle': hasHandle,
      'has_number': num.isNotEmpty,
    });
    if (context.mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Contact copied')));
    }
  }

  /// Build a minimal vCard 3.0 string for [c].
  static String buildVCard(Contact c) {
    final name = c.name.isNotEmpty ? c.name : _bestNumber(c);
    final num = _bestNumber(c);
    final lines = <String>[
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:$name',
      if (num.isNotEmpty) 'TEL;TYPE=CELL:$num',
      if (c.handle.isNotEmpty) 'NOTE:AvaTOK @${c.handle}',
      'END:VCARD',
    ];
    // vCard spec uses CRLF line endings.
    return '${lines.join('\r\n')}\r\n';
  }

  /// Share a contact as a `.vcf` vCard file via the system share sheet.
  static Future<void> share(BuildContext context, Contact c) async {
    try {
      final vcf = buildVCard(c);
      final dir = await getTemporaryDirectory();
      final safe = (c.name.isNotEmpty ? c.name : 'contact')
          .replaceAll(RegExp(r'[^A-Za-z0-9._ -]'), '_')
          .trim();
      final file = File(
          '${dir.path}/${safe.isEmpty ? 'contact' : safe}-${c.uid.hashCode.toUnsigned(20)}.vcf');
      await file.writeAsString(vcf);
      Analytics.capture('contact_shared', {
        'has_handle': c.handle.isNotEmpty,
        'has_number': _bestNumber(c).isNotEmpty,
      });
      await Share.shareXFiles(
        [XFile(file.path, mimeType: 'text/vcard')],
        subject: c.name.isNotEmpty ? c.name : 'AvaTOK contact',
      );
    } catch (_) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text("Couldn't share contact")));
      }
    }
  }

  /// Forward a contact as a chat card ('card' kind) to any number of DMs/groups
  /// picked in the shared [showForwardSheet]. Reuses Stream I's picker + the
  /// existing card envelope, so it never forks the forward system.
  static Future<void> forward(BuildContext context, Contact c) async {
    final targets = await showForwardSheet(context, msgKind: 'card');
    if (targets == null || targets.isEmpty) return;
    // The card envelope matches chat_thread's `_sendSpecial('card', …)` exactly.
    final card = <String, dynamic>{
      't': 'card',
      'name': c.name,
      'uid': c.uid,
      'handle': c.handle,
    };
    final dmUids = <String>[];
    for (final t in targets) {
      final now = DateTime.now().millisecondsSinceEpoch;
      final clientId = 'fwd_card_${now}_${t.seed.hashCode.toUnsigned(20)}';
      try {
        if (t.isGroup) {
          // Group send: address the conversation id (same shape AvaGroupDm posts).
          final payload = jsonEncode({...card, 'gid': t.groupId});
          await ApiAuth.postJson(kMsgSendUrl, {
            'conv': t.groupId,
            'kind': 'text',
            'body': payload,
            'client_id': clientId,
          });
        } else {
          // DM send: address the peer uid (same shape AvaDm posts).
          await ApiAuth.postJson(kMsgSendUrl, {
            'to': t.peerUid,
            'kind': 'text',
            'body': jsonEncode(card),
            'client_id': clientId,
          });
          dmUids.add(t.peerUid);
        }
      } catch (_) {/* best-effort per target */}
    }
    if (dmUids.isNotEmpty) {
      PushService.notifyMessage(dmUids, c.name.isNotEmpty ? c.name : 'AvaTOK',
          preview: '👤 ${c.name}');
    }
    Analytics.capture('contact_forwarded', {
      'targets': targets.length,
      'groups': targets.where((t) => t.isGroup).length,
      'dms': dmUids.length,
    });
    if (context.mounted) {
      final n = targets.length;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(
              'Contact sent to $n ${n == 1 ? 'chat' : 'chats'}')));
    }
  }
}
