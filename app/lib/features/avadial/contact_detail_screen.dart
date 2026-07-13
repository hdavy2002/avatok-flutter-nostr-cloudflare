import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../avatok/chat_thread.dart';
import '../avatok/data.dart';
import 'avadial_channel.dart';
import 'avadial_theme.dart';
import 'block_list.dart';
import 'contact_call_history_screen.dart';
import 'contact_edit_screen.dart';
import 'contact_overrides.dart';
import 'contact_row_menu.dart';
import 'outgoing_call_screen.dart';
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

  Future<void> _call() async {
    final placed = await AvaDialChannel.I.placeCall(widget.number);
    if (placed && mounted) {
      Navigator.push(context,
          MaterialPageRoute<void>(builder: (_) => OutgoingCallScreen(number: widget.number)));
    }
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
        shape: const Border(bottom: BorderSide(color: AvaDialTheme.border, width: Zine.bw)),
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
                        color: Zine.blueMark,
                        shape: BoxShape.circle,
                        border: Border.all(color: AvaDialTheme.border, width: Zine.bw),
                      ),
                      alignment: Alignment.center,
                      child: Text(_initials,
                          style: ZineText.cardTitle(size: 34, color: Zine.blue)),
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
                  _action(PhosphorIcons.phone(PhosphorIconsStyle.bold), 'Call', Zine.mint, _call),
                  _action(PhosphorIcons.chatText(PhosphorIconsStyle.bold), 'Message', Zine.lilac, _sms),
                  _action(PhosphorIcons.chatCircleDots(PhosphorIconsStyle.fill), 'AvaTOK', Zine.lime, _avatok),
                  _action(PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold), 'Edit', Zine.blue, _edit),
                  _action(
                      _blocked
                          ? PhosphorIcons.prohibitInset(PhosphorIconsStyle.bold)
                          : PhosphorIcons.prohibit(PhosphorIconsStyle.bold),
                      _blocked ? 'Unblock' : 'Block',
                      Zine.coral,
                      _toggleBlock),
                ]),
                const SizedBox(height: 24),
                if (hasAvatok)
                  _fieldTile(
                    icon: PhosphorIcons.chatCircleDots(PhosphorIconsStyle.fill),
                    color: Zine.lime,
                    label: 'AvaTOK',
                    value: _o!.avatokNumber!,
                    onTap: _avatok,
                    trailing: 'Open chat',
                  ),
                _fieldTile(
                  icon: PhosphorIcons.phone(PhosphorIconsStyle.bold),
                  color: Zine.mint,
                  label: 'Phone',
                  value: widget.number,
                  onTap: _call,
                ),
                if (_o?.personalEmail?.isNotEmpty ?? false)
                  _fieldTile(
                    icon: PhosphorIcons.envelopeSimple(PhosphorIconsStyle.bold),
                    color: Zine.blue,
                    label: 'Personal email',
                    value: _o!.personalEmail!,
                  ),
                if (_o?.businessEmail?.isNotEmpty ?? false)
                  _fieldTile(
                    icon: PhosphorIcons.briefcase(PhosphorIconsStyle.bold),
                    color: Zine.blue,
                    label: 'Business email',
                    value: _o!.businessEmail!,
                  ),
                if (_o?.linkedin?.isNotEmpty ?? false)
                  _fieldTile(
                    icon: PhosphorIcons.linkedinLogo(PhosphorIconsStyle.bold),
                    color: Zine.blue,
                    label: 'LinkedIn',
                    value: _o!.linkedin!,
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
                  color: Zine.mint,
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
            border: Border.all(color: AvaDialTheme.border, width: Zine.bw),
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
        child: ZineCard(
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
