import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../avatok/chat_thread.dart';
import '../avatok/contacts.dart' show Contact, Directory;
import '../avatok/data.dart';
import '../avatok/invite_screen.dart';
import '../avatok/place_1to1_call.dart';
import 'avadial_theme.dart';
import 'block_list.dart';
import 'contact_call_history_screen.dart';
import 'contact_edit_screen.dart';
import 'contact_overrides.dart';
import 'contact_row_menu.dart';
import 'sms/sms_thread_screen.dart';

/// Full contact card for a Calls-app contact (owner spec, pic 3). Header avatar +
/// name/number, an action row (Call · Message · AvaTOK · Edit · Block) and every
/// saved field. The WhatsApp action is REPLACED by an AvaTOK action (owner spec):
/// tapping it opens the AvaTOK message thread with this contact.
class ContactDetailScreen extends StatefulWidget {
  final String number;
  final String? name;
  const ContactDetailScreen({super.key, required this.number, this.name});

  @override
  State<ContactDetailScreen> createState() => _ContactDetailScreenState();
}

class _ContactDetailScreenState extends State<ContactDetailScreen> {
  ContactOverride? _o;
  bool _blocked = false;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final o = await ContactOverrides.I.forNumber(widget.number);
    final blocked = await BlockList.I.isBlocked(widget.number);
    if (!mounted) return;
    setState(() {
      _o = o;
      _blocked = blocked;
      _loading = false;
    });
  }

  String get _title =>
      (_o?.displayName?.isNotEmpty ?? false)
          ? _o!.displayName!
          : (widget.name?.isNotEmpty ?? false)
              ? widget.name!
              : widget.number;

  String get _initials {
    final t = _title.trim();
    if (t.isEmpty || t.startsWith('+') || RegExp(r'^[0-9]').hasMatch(t)) return '#';
    final parts = t.split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return '#';
    final a = parts.first.substring(0, 1);
    final b = parts.length > 1 ? parts[1].substring(0, 1) : '';
    return (a + b).toUpperCase();
  }

  /// [AVADIAL-AVATOK-ONLY-1] AvaTOK-only call (owner pivot 2026-07-16). Resolve
  /// this contact against the AvaTOK directory and place an in-app AvaTOK-to-AvaTOK
  /// call through [place1to1Call] — the SAME flow the chat thread / dialpad use.
  /// The former carrier/PSTN dial (AvaDialChannel.placeCall via TelecomManager) is
  /// GONE: a number with no AvaTOK account shows a "Not on AvaTOK" state instead of
  /// falling back to the system dialer. Prefer the saved AvaTOK-number override
  /// when set, else resolve the phone number itself.
  Future<void> _call() async {
    final query =
        (_o?.avatokNumber?.isNotEmpty ?? false) ? _o!.avatokNumber! : widget.number;
    Analytics.capture('avadial_contact_call', const {'via': 'contact_detail'});
    Contact? hit;
    try {
      hit = await Directory.resolve(query);
    } catch (_) {
      hit = null;
    }
    if (!mounted) return;
    if (hit == null || hit.uid.isEmpty) {
      Analytics.capture('avadial_contact_not_on_avatok', const {'via': 'contact_detail'});
      await _showNotOnAvaTok();
      return;
    }
    await place1to1Call(context,
        uid: hit.uid,
        name: _title,
        avatarUrl: hit.avatarUrl,
        dialer: true);
  }

  Future<void> _showNotOnAvaTok() async {
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (dialogCtx) => AlertDialog(
        backgroundColor: AvaDialTheme.surface2,
        shape: RoundedRectangleBorder(
          side: const BorderSide(color: AvaDialTheme.border, width: 1),
          borderRadius: BorderRadius.circular(AD.rListCard),
        ),
        title: Text('Not on AvaTOK', style: ZineText.cardTitle(size: 17, color: AvaDialTheme.text)),
        content: Text(
          '${widget.number} isn\'t an AvaTOK number yet. AvaTOK only calls other '
          'AvaTOK users — invite them to join.',
          style: ZineText.sub(size: 13.5, color: AvaDialTheme.textSoft),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogCtx),
            child: Text('Cancel', style: ZineText.value(size: 14, color: AvaDialTheme.textSoft)),
          ),
          TextButton(
            onPressed: () {
              Navigator.pop(dialogCtx);
              Navigator.of(context, rootNavigator: true).push(
                  MaterialPageRoute<void>(builder: (_) => const InviteScreen()));
            },
            child: Text('Invite', style: ZineText.value(size: 14, color: AD.online)),
          ),
        ],
      ),
    );
  }

  void _sms() => Navigator.push(context,
      MaterialPageRoute<void>(builder: (_) => SmsThreadScreen(address: widget.number)));

  /// Open the AvaTOK message thread with this contact. Seeds the thread by their
  /// AvaTOK number/@handle when set, otherwise falls back to the phone number —
  /// same identifier-seeded open the chat list already uses for a not-yet-resolved
  /// peer.
  void _avatok() {
    final id = (_o?.avatokNumber?.isNotEmpty ?? false) ? _o!.avatokNumber! : widget.number;
    Analytics.capture('avadial_open_avatok_thread', {'from': 'contact_detail'});
    Navigator.push(
      context,
      MaterialPageRoute<void>(
        builder: (_) => ChatThreadScreen(
          chat: Chat(name: _title, seed: id, last: '', time: ''),
        ),
      ),
    );
  }

  Future<void> _edit() async {
    await Navigator.push<bool>(context, MaterialPageRoute<bool>(
        builder: (_) => ContactEditScreen(number: widget.number, initialName: _title)));
    _load();
  }

  Future<void> _toggleBlock() async {
    if (_blocked) {
      await BlockList.I.unblock(widget.number);
    } else {
      await BlockList.I.block(widget.number, label: _title);
    }
    _load();
  }

  @override
  Widget build(BuildContext context) {
    final hasAvatok = _o?.avatokNumber?.isNotEmpty ?? false;
    return Scaffold(
      backgroundColor: AvaDialTheme.bg,
      appBar: AppBar(
        backgroundColor: AvaDialTheme.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: const Border(bottom: BorderSide(color: AvaDialTheme.border, width: 1)),
        title: Text('Contact', style: ZineText.appbar(color: AvaDialTheme.text)),
        actions: [
          IconButton(
            icon: const Icon(Icons.more_vert, color: AvaDialTheme.text),
            onPressed: () => showAvaDialRowMenu(
              context,
              number: widget.number,
              name: _title,
              alreadyBlocked: _blocked,
              onChanged: _load,
            ),
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AvaDialTheme.accent))
          : ListView(
              padding: const EdgeInsets.fromLTRB(16, 20, 16, 32),
              children: [
                Center(
                  child: Column(children: [
                    Container(
                      width: 96,
                      height: 96,
                      decoration: BoxDecoration(
                        color: AD.card,
                        shape: BoxShape.circle,
                        border: Border.all(color: AvaDialTheme.border, width: 1),
                      ),
                      alignment: Alignment.center,
                      child: Text(_initials,
                          style: ZineText.cardTitle(size: 34, color: AD.iconSearch)),
                    ),
                    const SizedBox(height: 14),
                    Text(_title,
                        textAlign: TextAlign.center,
                        style: ZineText.cardTitle(size: 22, color: AvaDialTheme.text)),
                    const SizedBox(height: 4),
                    Text(widget.number,
                        style: ZineText.sub(size: 14, color: AvaDialTheme.textSoft)),
                  ]),
                ),
                const SizedBox(height: 22),
                Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
                  _action(PhosphorIcons.phone(PhosphorIconsStyle.bold), 'Call', AD.incomingCall, _call),
                  _action(PhosphorIcons.chatText(PhosphorIconsStyle.bold), 'Message', AD.iconVideo, _sms),
                  _action(PhosphorIcons.chatCircleDots(PhosphorIconsStyle.fill), 'AvaTOK', AD.primaryBadge, _avatok),
                  _action(PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold), 'Edit', AD.iconSearch, _edit),
                  _action(
                      _blocked
                          ? PhosphorIcons.prohibitInset(PhosphorIconsStyle.bold)
                          : PhosphorIcons.prohibit(PhosphorIconsStyle.bold),
                      _blocked ? 'Unblock' : 'Block',
                      AD.danger,
                      _toggleBlock),
                ]),
                const SizedBox(height: 24),
                if (hasAvatok)
                  _fieldTile(
                    icon: PhosphorIcons.chatCircleDots(PhosphorIconsStyle.fill),
                    color: AD.primaryBadge,
                    label: 'AvaTOK',
                    value: _o!.avatokNumber!,
                    onTap: _avatok,
                    trailing: 'Open chat',
                  ),
                _fieldTile(
                  icon: PhosphorIcons.phone(PhosphorIconsStyle.bold),
                  color: AD.incomingCall,
                  label: 'Phone',
                  value: widget.number,
                  onTap: _call,
                ),
                if (_o?.personalEmail?.isNotEmpty ?? false)
                  _fieldTile(
                    icon: PhosphorIcons.envelopeSimple(PhosphorIconsStyle.bold),
                    color: AD.iconSearch,
                    label: 'Personal email',
                    value: _o!.personalEmail!,
                  ),
                if (_o?.businessEmail?.isNotEmpty ?? false)
                  _fieldTile(
                    icon: PhosphorIcons.briefcase(PhosphorIconsStyle.bold),
                    color: AD.iconSearch,
                    label: 'Business email',
                    value: _o!.businessEmail!,
                  ),
                if (_o?.linkedin?.isNotEmpty ?? false)
                  _fieldTile(
                    icon: PhosphorIcons.linkedinLogo(PhosphorIconsStyle.bold),
                    color: AD.iconSearch,
                    label: 'LinkedIn',
                    value: _o!.linkedin!,
                  ),
                if (_o?.address?.isNotEmpty ?? false)
                  _fieldTile(
                    icon: PhosphorIcons.mapPin(PhosphorIconsStyle.bold),
                    color: AD.iconSearch,
                    label: 'Address',
                    value: _o!.address!,
                  ),
                for (final f in _o?.customFields ?? const <ContactField>[])
                  if (f.value.isNotEmpty)
                    _fieldTile(
                      icon: PhosphorIcons.tag(PhosphorIconsStyle.bold),
                      color: AvaDialTheme.textSoft,
                      label: f.label.isEmpty ? 'Field' : f.label,
                      value: f.value,
                    ),
                const SizedBox(height: 10),
                _fieldTile(
                  icon: PhosphorIcons.clockCounterClockwise(PhosphorIconsStyle.bold),
                  color: AD.incomingCall,
                  label: 'Call history',
                  value: 'View calls with this number',
                  onTap: () => Navigator.push(context, MaterialPageRoute<void>(
                      builder: (_) => ContactCallHistoryScreen(number: widget.number, name: _title))),
                  trailing: 'Open',
                ),
              ],
            ),
    );
  }

  Widget _action(IconData icon, String label, Color color, VoidCallback onTap) {
    return GestureDetector(
      onTap: onTap,
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Container(
          width: 52,
          height: 52,
          decoration: BoxDecoration(
            color: AvaDialTheme.surface2,
            shape: BoxShape.circle,
            border: Border.all(color: AvaDialTheme.border, width: 1),
          ),
          alignment: Alignment.center,
          child: PhosphorIcon(icon, color: color, size: 23),
        ),
        const SizedBox(height: 7),
        Text(label, style: ZineText.tag(size: 11.5, color: AvaDialTheme.textSoft)),
      ]),
    );
  }

  Widget _fieldTile({
    required IconData icon,
    required Color color,
    required String label,
    required String value,
    VoidCallback? onTap,
    String? trailing,
  }) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: GestureDetector(
        onTap: onTap,
        onLongPress: () async {
          await Clipboard.setData(ClipboardData(text: value));
          if (mounted) {
            ScaffoldMessenger.of(context)
                .showSnackBar(SnackBar(content: Text('$label copied')));
          }
        },
        child: AdCard(
          color: AvaDialTheme.surface2,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
          child: Row(children: [
            ZineIconBadge(icon: icon, color: color),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(label, style: ZineText.tag(size: 11, color: AvaDialTheme.textMute)),
                const SizedBox(height: 2),
                Text(value, style: ZineText.value(size: 15, color: AvaDialTheme.text)),
              ]),
            ),
            if (trailing != null) ...[
              const SizedBox(width: 8),
              Text(trailing, style: ZineText.tag(size: 11.5, color: color)),
            ],
          ]),
        ),
      ),
    );
  }
}
