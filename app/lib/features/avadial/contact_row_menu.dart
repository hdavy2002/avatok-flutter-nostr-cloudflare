import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/zine.dart';
import '../avatok/contact_actions.dart';
import '../avatok/contacts.dart' show Contact;
import 'avadial_channel.dart';
import 'avadial_theme.dart';
import 'block_list.dart';
import 'contact_call_history_screen.dart';
import 'contact_edit_screen.dart';
import 'contact_overrides.dart';
import 'device_contacts.dart';
import 'outgoing_call_screen.dart';
import 'sms/sms_thread_screen.dart';

/// The shared 3-dot / long-press row menu for the Calls app's Contacts, Logs and
/// Block tabs (owner spec, pic 3): Call · Edit contact · Call history · Remove
/// contact · Block/Unblock · Report spam · Delete this contact · Forward to
/// messenger · Send SMS. ONE implementation so every row (tap the trailing
/// 3-dot icon, or long-press the row) gets the exact same menu.
Future<void> showAvaDialRowMenu(
  BuildContext context, {
  required String number,
  String? name,
  bool alreadyBlocked = false,
  VoidCallback? onChanged,
}) async {
  final navContext = Navigator.of(context, rootNavigator: true).context;
  await showModalBottomSheet<void>(
    context: context,
    backgroundColor: AvaDialTheme.surface,
    shape: const RoundedRectangleBorder(
      side: BorderSide(color: AvaDialTheme.border, width: Zine.bw),
      borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
    ),
    builder: (sheetCtx) => SafeArea(
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        const SizedBox(height: 10),
        Container(
          width: 40, height: 4,
          decoration: BoxDecoration(color: AvaDialTheme.textMute, borderRadius: BorderRadius.circular(100)),
        ),
        ListTile(
          leading: const Icon(Icons.perm_phone_msg_outlined, color: AvaDialTheme.text),
          title: Text(name?.isNotEmpty == true ? name! : number,
              style: ZineText.cardTitle(size: 15.5, color: AvaDialTheme.text)),
          subtitle: name?.isNotEmpty == true
              ? Text(number, style: ZineText.sub(size: 12.5, color: AvaDialTheme.textSoft))
              : null,
        ),
        const Divider(color: AvaDialTheme.border, height: 1),
        _row(
          icon: PhosphorIcons.phone(PhosphorIconsStyle.bold),
          color: Zine.mint,
          label: 'Call',
          onTap: () async {
            Navigator.pop(sheetCtx);
            final placed = await AvaDialChannel.I.placeCall(number);
            if (placed && navContext.mounted) {
              Navigator.push(navContext,
                  MaterialPageRoute<void>(builder: (_) => OutgoingCallScreen(number: number)));
            }
          },
        ),
        _row(
          icon: PhosphorIcons.chatCircle(PhosphorIconsStyle.bold),
          color: Zine.lilac,
          label: 'Send SMS',
          onTap: () {
            Navigator.pop(sheetCtx);
            Navigator.push(navContext,
                MaterialPageRoute<void>(builder: (_) => SmsThreadScreen(address: number)));
          },
        ),
        _row(
          icon: PhosphorIcons.userPlus(PhosphorIconsStyle.bold),
          color: Zine.blue,
          label: 'Save contact',
          onTap: () async {
            Navigator.pop(sheetCtx);
            await Navigator.push<bool>(navContext, MaterialPageRoute<bool>(
                builder: (_) =>
                    ContactEditScreen(number: number, initialName: name, create: true)));
            onChanged?.call();
          },
        ),
        _row(
          icon: PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold),
          color: Zine.blue,
          label: 'Edit contact',
          onTap: () async {
            Navigator.pop(sheetCtx);
            await Navigator.push<bool>(navContext, MaterialPageRoute<bool>(
                builder: (_) => ContactEditScreen(number: number, initialName: name)));
            onChanged?.call();
          },
        ),
        _row(
          icon: PhosphorIcons.clockCounterClockwise(PhosphorIconsStyle.bold),
          color: Zine.mint,
          label: 'Call history',
          onTap: () {
            Navigator.pop(sheetCtx);
            Navigator.push(navContext, MaterialPageRoute<void>(
                builder: (_) => ContactCallHistoryScreen(number: number, name: name)));
          },
        ),
        _row(
          icon: PhosphorIcons.arrowBendUpRight(PhosphorIconsStyle.bold),
          color: Zine.lilac,
          label: 'Forward to messenger',
          onTap: () {
            Navigator.pop(sheetCtx);
            ContactActions.forward(navContext, Contact(uid: '', name: name ?? '', phone: number));
          },
        ),
        _row(
          icon: PhosphorIcons.prohibit(PhosphorIconsStyle.bold),
          color: Zine.coral,
          label: alreadyBlocked ? 'Unblock' : 'Block this number',
          onTap: () async {
            Navigator.pop(sheetCtx);
            if (alreadyBlocked) {
              await BlockList.I.unblock(number);
            } else {
              await BlockList.I.block(number, label: name);
            }
            onChanged?.call();
          },
        ),
        _row(
          icon: PhosphorIcons.shieldWarning(PhosphorIconsStyle.bold),
          color: Zine.coral,
          label: 'Report spam',
          onTap: () async {
            Navigator.pop(sheetCtx);
            await BlockList.I.reportSpam(number, label: name);
            onChanged?.call();
          },
        ),
        _row(
          icon: PhosphorIcons.user(PhosphorIconsStyle.bold),
          color: Zine.coral,
          label: 'Remove contact',
          onTap: () async {
            Navigator.pop(sheetCtx);
            await ContactOverrides.I.hide(number);
            Analytics.capture('avadial_contact_removed', const {});
            onChanged?.call();
          },
        ),
        _row(
          icon: PhosphorIcons.trash(PhosphorIconsStyle.bold),
          color: Zine.coral,
          label: 'Delete this contact',
          danger: true,
          onTap: () async {
            Navigator.pop(sheetCtx);
            final ok = await _confirmDelete(navContext, name?.isNotEmpty == true ? name! : number);
            if (ok != true) return;
            // Delete the REAL device contact when there is one (owner request
            // 2026-07-13); always hide any AVA override / local contact too.
            await DeviceContacts.I.load();
            final id = DeviceContacts.I.lookup(number)?.id;
            var onDevice = false;
            if (id != null) onDevice = await DeviceContacts.I.delete(id);
            await ContactOverrides.I.hide(number);
            Analytics.capture('avadial_contact_deleted', {'on_device': onDevice});
            onChanged?.call();
          },
        ),
        const SizedBox(height: 8),
      ]),
    ),
  );
}

Future<bool?> _confirmDelete(BuildContext context, String label) => showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AvaDialTheme.surface2,
        shape: RoundedRectangleBorder(
          side: const BorderSide(color: AvaDialTheme.border, width: Zine.bw),
          borderRadius: BorderRadius.circular(Zine.rSm),
        ),
        title: Text('Delete $label?', style: ZineText.cardTitle(size: 17, color: AvaDialTheme.text)),
        content: Text(
          'This deletes the contact from your phone\'s address book. This can\'t be '
          'undone.',
          style: ZineText.sub(size: 13.5, color: AvaDialTheme.textSoft),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text('Cancel', style: ZineText.value(size: 14, color: AvaDialTheme.textSoft)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text('Delete', style: ZineText.value(size: 14, color: Zine.coral)),
          ),
        ],
      ),
    );

Widget _row({
  required IconData icon,
  required Color color,
  required String label,
  required VoidCallback onTap,
  bool danger = false,
}) {
  return ListTile(
    leading: PhosphorIcon(icon, color: color),
    title: Text(label,
        style: ZineText.value(size: 15, color: danger ? Zine.coral : AvaDialTheme.text)),
    onTap: onTap,
  );
}
