import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine.dart';
import '../avatok/contact_actions.dart';
import '../avatok/contacts.dart' show Contact;
import 'avadial_channel.dart';
import 'avadial_theme.dart';
import 'block_list.dart';
import 'contact_call_history_screen.dart';
import 'contact_detail_screen.dart';
import 'contact_edit_screen.dart';
import 'contact_groups.dart';
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
  // [AVADIAL-GROUPS-2] Resolve the contact's colour group up front so the menu can
  // offer a one-tap "Remove from colour group" only when the row is actually
  // coloured (owner request). Read here rather than threading it through every
  // call site, so the Logs/Block tabs get the same behaviour for free.
  final currentGroupId = (await ContactOverrides.I.forNumber(number))?.groupId;
  if (!context.mounted) return;
  await showModalBottomSheet<void>(
    context: context,
    backgroundColor: AvaDialTheme.surface,
    shape: const RoundedRectangleBorder(
      side: BorderSide(color: AvaDialTheme.border, width: 1),
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
          icon: PhosphorIcons.identificationCard(PhosphorIconsStyle.bold),
          color: AD.iconSearch,
          label: 'Open contact',
          onTap: () async {
            Navigator.pop(sheetCtx);
            await Navigator.push<void>(navContext,
                MaterialPageRoute<void>(builder: (_) => ContactDetailScreen(number: number, name: name)));
            onChanged?.call();
          },
        ),
        _row(
          icon: PhosphorIcons.phone(PhosphorIconsStyle.bold),
          color: AD.incomingCall,
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
          color: AD.iconVideo,
          label: 'Send SMS',
          onTap: () {
            Navigator.pop(sheetCtx);
            Navigator.push(navContext,
                MaterialPageRoute<void>(builder: (_) => SmsThreadScreen(address: number)));
          },
        ),
        _row(
          icon: PhosphorIcons.userPlus(PhosphorIconsStyle.bold),
          color: AD.iconSearch,
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
          color: AD.iconSearch,
          label: 'Edit contact',
          onTap: () async {
            Navigator.pop(sheetCtx);
            await Navigator.push<bool>(navContext, MaterialPageRoute<bool>(
                builder: (_) => ContactEditScreen(number: number, initialName: name)));
            onChanged?.call();
          },
        ),
        _row(
          icon: PhosphorIcons.tag(PhosphorIconsStyle.bold),
          color: AD.iconVideo,
          label: 'Add to color group',
          onTap: () async {
            Navigator.pop(sheetCtx);
            await _pickGroup(navContext, number);
            onChanged?.call();
          },
        ),
        // [AVADIAL-GROUPS-2] Only offered when this contact IS coloured — a
        // one-tap un-colour without going through the picker (owner request).
        if (currentGroupId != null)
          _row(
            icon: PhosphorIcons.prohibit(PhosphorIconsStyle.bold),
            color: AD.danger,
            label: 'Remove from color group',
            onTap: () async {
              Navigator.pop(sheetCtx);
              await ContactOverrides.I.setGroup(number, null);
              onChanged?.call();
            },
          ),
        _row(
          icon: PhosphorIcons.clockCounterClockwise(PhosphorIconsStyle.bold),
          color: AD.incomingCall,
          label: 'Call history',
          onTap: () {
            Navigator.pop(sheetCtx);
            Navigator.push(navContext, MaterialPageRoute<void>(
                builder: (_) => ContactCallHistoryScreen(number: number, name: name)));
          },
        ),
        _row(
          icon: PhosphorIcons.arrowBendUpRight(PhosphorIconsStyle.bold),
          color: AD.iconVideo,
          label: 'Forward to messenger',
          onTap: () {
            Navigator.pop(sheetCtx);
            ContactActions.forward(navContext, Contact(uid: '', name: name ?? '', phone: number));
          },
        ),
        _row(
          icon: PhosphorIcons.prohibit(PhosphorIconsStyle.bold),
          color: AD.danger,
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
          color: AD.danger,
          label: 'Report spam',
          onTap: () async {
            Navigator.pop(sheetCtx);
            await BlockList.I.reportSpam(number, label: name);
            onChanged?.call();
          },
        ),
        _row(
          icon: PhosphorIcons.user(PhosphorIconsStyle.bold),
          color: AD.danger,
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
          color: AD.danger,
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
          side: const BorderSide(color: AvaDialTheme.border, width: 1),
          borderRadius: BorderRadius.circular(AD.rListCard),
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
            child: Text('Delete', style: ZineText.value(size: 14, color: AD.danger)),
          ),
        ],
      ),
    );

/// [AVADIAL-GROUPS-1] Sub-sheet listing every colour group so the owner can
/// file this contact into one (or clear it), launched from the "Add to
/// group" row above. Styled to match the parent menu sheet.
Future<void> _pickGroup(BuildContext context, String number) async {
  final groups = await ContactGroups.I.load();
  final current = (await ContactOverrides.I.forNumber(number))?.groupId;
  if (!context.mounted) return;
  await showModalBottomSheet<void>(
    context: context,
    backgroundColor: AvaDialTheme.surface,
    shape: const RoundedRectangleBorder(
      side: BorderSide(color: AvaDialTheme.border, width: 1),
      borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
    ),
    builder: (ctx) => SafeArea(
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        const SizedBox(height: 10),
        Container(
          width: 40, height: 4,
          decoration: BoxDecoration(color: AvaDialTheme.textMute, borderRadius: BorderRadius.circular(100)),
        ),
        ListTile(
          title: Text('Add to color group',
              style: ZineText.cardTitle(size: 15.5, color: AvaDialTheme.text)),
        ),
        const Divider(color: AvaDialTheme.border, height: 1),
        Flexible(
          child: ListView(
            shrinkWrap: true,
            children: [
              for (final g in groups)
                ListTile(
                  leading: Container(
                    width: 22, height: 22,
                    decoration: BoxDecoration(color: g.colorValue, shape: BoxShape.circle),
                  ),
                  title: Text(g.name, style: ZineText.value(size: 15, color: AvaDialTheme.text)),
                  trailing: g.id == current ? const Icon(Icons.check, color: AD.online) : null,
                  // [AVADIAL-GROUPS-1] Write BEFORE popping: popping completes the
                  // sheet's future, so _pickGroup returns and the caller's
                  // onChanged/_reload can run before the assignment has landed.
                  onTap: () async {
                    await ContactOverrides.I.setGroup(number, g.id);
                    if (ctx.mounted) Navigator.pop(ctx);
                  },
                ),
              if (current != null)
                ListTile(
                  leading: PhosphorIcon(PhosphorIcons.prohibit(PhosphorIconsStyle.bold),
                      color: AvaDialTheme.textSoft),
                  title: Text('Remove from color group',
                      style: ZineText.value(size: 15, color: AvaDialTheme.textSoft)),
                  // [AVADIAL-GROUPS-1] Write before popping — see note above.
                  onTap: () async {
                    await ContactOverrides.I.setGroup(number, null);
                    if (ctx.mounted) Navigator.pop(ctx);
                  },
                ),
            ],
          ),
        ),
        const SizedBox(height: 8),
      ]),
    ),
  );
}

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
        style: ZineText.value(size: 15, color: danger ? AD.danger : AvaDialTheme.text)),
    onTap: onTap,
  );
}
