import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/device_contacts.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'contacts.dart';

/// Helpers + UI for "unknown number" threads — a caller the AI Receptionist
/// took a message from who is NOT (yet) one of the owner's AvaTOK contacts.
///
/// A phone-only caller has no AvaTOK account, so there is no Clerk uid / npub to
/// key a [Contact] on. We mint a SYNTHETIC id `tel:<E.164>` instead. That id:
///   • de-dupes correctly (one entry per distinct number), and
///   • lets the SAME conversation survive a later "Save to contacts" (the thread
///     keeps its messages because the conv key is derived from the number, not
///     from whether a contact row exists).
/// If that person later joins AvaTOK we can [ContactsStore.mergeTel] the
/// `tel:` row into their real npub.
///
/// CONV KEY: the Worker delivers the receptionist card under server conv
/// `recept_<owner>__tel:<phone>`; SyncHub maps any non-`dm_` conv to a `g:`
/// local key, so the on-device convKey is `g:recept_<owner>__tel:<phone>`.
/// [receptTelConvKey] reproduces that string EXACTLY so the chat list, the
/// thread loader and the stored messages all agree.

/// Marker stored in [Contact.handle] for a PROVISIONAL phone-only row that the
/// receptionist auto-created (so the thread shows up) but the owner has NOT yet
/// explicitly saved. The "Save to contacts" affordances stay visible while this
/// marker is present; saving (or promotion to a real account) clears it.
const String kProvisionalContactHandle = '__recept_unsaved__';

/// Synthetic contact id for a phone-only caller.
String telNpub(String e164) => 'tel:$e164';

/// True when [npub] is a synthetic phone-only id.
bool isTelNpub(String npub) => npub.startsWith('tel:');

/// The E.164 number behind a synthetic id, or null if [s] isn't one.
String? telPhone(String s) => s.startsWith('tel:') ? s.substring(4) : null;

/// Local conv key for an unknown-number receptionist thread. MUST match the
/// `g:`-prefixed key SyncHub derives from the Worker's `recept_<owner>__tel:…`.
String receptTelConvKey(String myUid, String e164) =>
    'g:recept_${myUid}__tel:$e164';

/// Extract the caller number from a `g:recept_<owner>__tel:<phone>` conv key.
/// Robust to uids that themselves contain `_` because we split on `__tel:`.
String? phoneFromReceptConv(String convKey) {
  const marker = '__tel:';
  final i = convKey.indexOf(marker);
  if (i < 0) return null;
  final p = convKey.substring(i + marker.length).trim();
  return p.isEmpty ? null : p;
}

/// True if a local conv key is an unknown-number receptionist thread.
bool isReceptTelConv(String convKey) =>
    convKey.startsWith('g:recept_') && convKey.contains('__tel:');

/// A provisional auto-created receptionist row (not yet saved by the owner).
bool isProvisionalContact(Contact c) =>
    isTelNpub(c.npub) && c.handle == kProvisionalContactHandle;

/// True when the caller behind [e164] is a real, owner-known contact — either an
/// explicitly-saved phone contact or one promoted to a real AvaTOK account — as
/// opposed to a provisional auto-row. Drives whether the "Save to contacts"
/// affordances are shown.
bool callerIsSaved(List<Contact> contacts, String e164) {
  final tel = telNpub(e164);
  for (final c in contacts) {
    if (c.npub == tel) return c.handle != kProvisionalContactHandle;
    if (!c.isPhoneOnly && c.phone == e164) return true; // promoted to real npub
  }
  return false;
}

/// Light, readable formatting of an E.164 number for titles/labels. We don't
/// pull in a full libphonenumber — just group the national digits in 3s so a
/// raw `+233245550148` reads as `+233 245 550 148`.
String formatTelDisplay(String e164) {
  final s = e164.trim();
  if (s.isEmpty) return 'Unknown number';
  final plus = s.startsWith('+');
  final digits = s.replaceAll(RegExp(r'[^\d]'), '');
  if (digits.length < 7) return s; // too short to prettify — show as-is
  // Keep a 1–3 digit country code, then group the rest in 3s.
  final cc = digits.length > 10 ? digits.substring(0, digits.length - 9) : '';
  final rest = cc.isEmpty ? digits : digits.substring(cc.length);
  final buf = StringBuffer();
  for (var i = 0; i < rest.length; i += 3) {
    if (buf.isNotEmpty) buf.write(' ');
    final end = (i + 3) < rest.length ? i + 3 : rest.length;
    buf.write(rest.substring(i, end));
  }
  final body = cc.isEmpty ? buf.toString() : '$cc ${buf.toString()}';
  return (plus ? '+' : '') + body;
}

/// Bottom sheet to save an unknown caller as an AvaTOK contact. Pre-fills the
/// number (read-only) and lets the owner give them a name. Returns the saved
/// [Contact] (or null if cancelled). Also offers to mirror into the device
/// address book.
Future<Contact?> showSavePhoneContactSheet(
  BuildContext context, {
  required String phone,
  String? presetName,
  String source = 'unknown_thread',
}) {
  return showModalBottomSheet<Contact>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Zine.paper,
    shape: const RoundedRectangleBorder(
        side: BorderSide(color: Zine.ink, width: Zine.bw),
        borderRadius: BorderRadius.vertical(top: Radius.circular(26))),
    builder: (_) => _SavePhoneContactSheet(phone: phone, presetName: presetName, source: source),
  );
}

class _SavePhoneContactSheet extends StatefulWidget {
  const _SavePhoneContactSheet({required this.phone, this.presetName, required this.source});
  final String phone;
  final String? presetName;
  final String source;
  @override
  State<_SavePhoneContactSheet> createState() => _SavePhoneContactSheetState();
}

class _SavePhoneContactSheetState extends State<_SavePhoneContactSheet> {
  late final TextEditingController _name =
      TextEditingController(text: widget.presetName ?? '');
  bool _alsoDevice = false;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avatok', 'save_phone_contact');
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_saving) return;
    setState(() => _saving = true);
    final e164 = DeviceContactsService.normPhone(widget.phone);
    final name = _name.text.trim().isEmpty ? formatTelDisplay(e164) : _name.text.trim();
    final contact = Contact(npub: telNpub(e164), name: name, phone: e164);
    try {
      await ContactsStore().add(contact);
      if (_alsoDevice) {
        try {
          final parts = name.split(RegExp(r'\s+'));
          await DeviceContactsService.createDeviceContact(
            firstName: parts.first,
            lastName: parts.length > 1 ? parts.sublist(1).join(' ') : '',
            phoneE164: e164,
          );
        } catch (_) {/* device book is best-effort */}
      }
      Analytics.capture('unknown_caller_saved', {
        'source': widget.source,
        'named': _name.text.trim().isNotEmpty,
        'also_device': _alsoDevice,
      });
    } catch (_) {
      Analytics.capture('unknown_caller_save_failed', {'source': widget.source});
    }
    if (mounted) Navigator.pop(context, contact);
  }

  @override
  Widget build(BuildContext context) {
    final mq = MediaQuery.of(context);
    final bottom = mq.viewInsets.bottom + mq.padding.bottom + 16;
    final pretty = formatTelDisplay(DeviceContactsService.normPhone(widget.phone));
    return Padding(
      padding: EdgeInsets.only(bottom: bottom),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 10, 20, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 44, height: 5, margin: const EdgeInsets.only(bottom: 16),
                decoration: BoxDecoration(color: Zine.inkMute, borderRadius: BorderRadius.circular(100)),
              ),
            ),
            Text('Save to contacts', style: ZineText.cardTitle(size: 22)),
            const SizedBox(height: 4),
            Text('Add this caller to your AvaTOK contacts so the thread shows their name.',
                style: ZineText.sub(size: 12.5)),
            const SizedBox(height: 16),
            Row(children: [
              Avatar(seed: telNpub(widget.phone), name: pretty, size: 44),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Icon(Icons.phone, size: 14, color: Zine.inkSoft),
                    const SizedBox(width: 5),
                    Flexible(child: Text(pretty, style: ZineText.value(size: 15))),
                  ]),
                  Text('Not on AvaTOK', style: ZineText.tag(size: 10.5, color: Zine.inkMute)),
                ]),
              ),
            ]),
            const SizedBox(height: 14),
            ZineField(
              controller: _name,
              hint: 'Name (optional)',
              leadIcon: PhosphorIcons.user(PhosphorIconsStyle.bold),
              onSubmitted: (_) => _save(),
            ),
            const SizedBox(height: 8),
            GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => setState(() => _alsoDevice = !_alsoDevice),
              child: Row(children: [
                Icon(_alsoDevice ? Icons.check_box : Icons.check_box_outline_blank,
                    size: 20, color: _alsoDevice ? Zine.mintInk : Zine.inkMute),
                const SizedBox(width: 8),
                Text('Also save to my phone contacts', style: ZineText.sub(size: 13)),
              ]),
            ),
            const SizedBox(height: 16),
            ZineButton(
              label: _saving ? 'Saving…' : 'Save contact',
              onPressed: _saving ? null : _save,
              loading: _saving,
              fullWidth: true,
            ),
          ],
        ),
      ),
    );
  }
}
