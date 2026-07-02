import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/chat_state.dart';
import '../../identity/nostr_keys.dart';
import '../avatok/chat_thread.dart';
import '../avatok/contacts.dart';
import '../avatok/data.dart';
import 'phone_theme.dart';

/// AvaPhone › Messages — a phone-SMS-style inbox.
///
/// This is DELIBERATELY separate from the Messenger: the Messenger is for people
/// you've added and chat with richly; this surface is the "text a number"
/// experience. You compose to an AvaTOK number (a stranger included) and it sends
/// an in-network message — delivered live or via an FCM push when they're
/// offline — through the exact same messaging backend the Messenger uses
/// (conversations + InboxDO + FCM). Incoming number-messages surface here too.
class AvaSmsInbox extends StatefulWidget {
  const AvaSmsInbox({super.key});
  @override
  State<AvaSmsInbox> createState() => _AvaSmsInboxState();
}

class _AvaSmsInboxState extends State<AvaSmsInbox> {
  List<Contact> _contacts = [];
  Map<String, ({String text, int ts, bool me})> _previews = {};
  Map<String, int> _lastRead = {};
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avaphone', 'sms_inbox');
    _load();
  }

  Future<void> _load() async {
    final contacts = await ContactsStore().load();
    final previews = await ChatPreviewStore().load();
    final lastRead = await ReadStateStore().load();
    if (!mounted) return;
    setState(() {
      // SMS inbox only ever shows AvaTOK-network identities (never raw phone-book
      // entries) — anyone you've exchanged a number-message with.
      _contacts = contacts;
      _previews = previews;
      _lastRead = lastRead;
      _loaded = true;
    });
  }

  String _key(Contact c) => '1:${NostrKeys.npubToHex(c.npub) ?? c.npub}';

  String _fmt(int secs) {
    if (secs <= 0) return '';
    final d = DateTime.fromMillisecondsSinceEpoch(secs * 1000);
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final that = DateTime(d.year, d.month, d.day);
    final days = today.difference(that).inDays;
    if (days <= 0) return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
    if (days == 1) return 'Yesterday';
    return '${d.day}/${d.month}';
  }

  /// Threads that actually have a message exchanged, most-recent first.
  List<Contact> get _threads {
    final withMsg = _contacts.where((c) => (_previews[_key(c)]?.ts ?? 0) > 0).toList();
    withMsg.sort((a, b) => (_previews[_key(b)]?.ts ?? 0).compareTo(_previews[_key(a)]?.ts ?? 0));
    return withMsg;
  }

  void _open(Contact c) {
    final chat = Chat(
      name: c.name.isNotEmpty ? c.name : (c.number.isNotEmpty ? c.number : c.npub),
      seed: c.npub, avatarUrl: c.avatarUrl,
      last: '', time: '',
    );
    Navigator.push(context, MaterialPageRoute(builder: (_) => ChatThreadScreen(chat: chat)))
        .then((_) => _load());
  }

  Future<void> _compose() async {
    final c = await showModalBottomSheet<Contact>(
      context: context, isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => _ComposeSheet(contacts: _contacts),
    );
    if (c != null && mounted) _open(c);
  }

  @override
  Widget build(BuildContext context) {
    final threads = _threads;
    return Scaffold(
      backgroundColor: PhoneTheme.bg,
      floatingActionButton: FloatingActionButton.extended(
        backgroundColor: PhoneTheme.accent,
        foregroundColor: const Color(0xFF0E1116),
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: const BorderSide(color: PhoneTheme.border, width: 2)),
        onPressed: _compose,
        icon: PhosphorIcon(PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold), size: 18),
        label: Text('New message', style: PhoneTheme.tag(size: 11.5, color: const Color(0xFF0E1116))),
      ),
      body: SafeArea(
        bottom: false,
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 14, 18, 4),
            child: Row(children: [
              Text('Messages', style: PhoneTheme.title(size: 24)),
              const Spacer(),
              PhoneTheme.chip('AvaTOK SMS', color: PhoneTheme.teal,
                  icon: PhosphorIcons.chatText(PhosphorIconsStyle.fill)),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 0, 18, 8),
            child: Text('Text any AvaTOK number — separate from your Messenger chats.',
                style: PhoneTheme.sub(size: 12.5)),
          ),
          Expanded(
            child: !_loaded
                ? const Center(child: CircularProgressIndicator(color: PhoneTheme.accent))
                : (threads.isEmpty
                    ? _empty()
                    : ListView.builder(
                        padding: const EdgeInsets.only(bottom: 96),
                        itemCount: threads.length,
                        itemBuilder: (_, i) {
                          final c = threads[i];
                          final pv = _previews[_key(c)];
                          final unread = pv != null && !pv.me && pv.ts > (_lastRead[_key(c)] ?? 0);
                          return _SmsRow(
                            contact: c,
                            preview: pv == null ? '' : (pv.me ? 'You: ${pv.text}' : pv.text),
                            time: _fmt(pv?.ts ?? 0),
                            unread: unread,
                            onTap: () => _open(c),
                          );
                        },
                      )),
          ),
        ]),
      ),
    );
  }

  Widget _empty() => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(PhosphorIcons.chatText(PhosphorIconsStyle.bold), size: 46, color: PhoneTheme.textMute),
            const SizedBox(height: 14),
            Text('No messages yet', style: PhoneTheme.title(size: 17)),
            const SizedBox(height: 6),
            Text('Tap "New message" to text an AvaTOK number.',
                textAlign: TextAlign.center, style: PhoneTheme.sub(size: 13)),
          ]),
        ),
      );
}

class _SmsRow extends StatelessWidget {
  final Contact contact;
  final String preview;
  final String time;
  final bool unread;
  final VoidCallback onTap;
  const _SmsRow({required this.contact, required this.preview, required this.time, required this.unread, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          PhoneTheme.ring(Avatar(
              seed: contact.npub, name: contact.name, size: 48,
              avatarUrl: contact.avatarUrl.isEmpty ? null : contact.avatarUrl)),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Flexible(
                  child: Text(contact.name.isNotEmpty ? contact.name : (contact.number.isNotEmpty ? contact.number : contact.npub),
                      maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: PhoneTheme.value(size: 15)),
                ),
                if (contact.number.isNotEmpty) ...[
                  const SizedBox(width: 6),
                  PhosphorIcon(PhosphorIcons.hash(PhosphorIconsStyle.bold), size: 12, color: PhoneTheme.teal),
                ],
              ]),
              const SizedBox(height: 3),
              Text(preview.isEmpty ? 'Tap to open' : preview,
                  maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: PhoneTheme.sub(size: 13, color: unread ? PhoneTheme.text : PhoneTheme.textSoft)),
            ]),
          ),
          const SizedBox(width: 8),
          Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Text(time.toUpperCase(), style: PhoneTheme.tag(size: 9.5, color: unread ? PhoneTheme.accent : PhoneTheme.textMute)),
            const SizedBox(height: 6),
            if (unread)
              Container(width: 10, height: 10,
                  decoration: const BoxDecoration(color: PhoneTheme.accent, shape: BoxShape.circle))
            else
              const SizedBox(height: 10),
          ]),
        ]),
      ),
    );
  }
}

// ─────────────────────── compose: text an AvaTOK number ───────────────────

class _ComposeSheet extends StatefulWidget {
  final List<Contact> contacts;
  const _ComposeSheet({required this.contacts});
  @override
  State<_ComposeSheet> createState() => _ComposeSheetState();
}

class _ComposeSheetState extends State<_ComposeSheet> {
  final _ctrl = TextEditingController();
  bool _resolving = false;
  String? _error;

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _go() async {
    final q = _ctrl.text.trim();
    if (q.replaceAll(RegExp(r'[^\d]'), '').length < 4) {
      setState(() => _error = 'Enter a full AvaTOK number');
      return;
    }
    setState(() { _resolving = true; _error = null; });
    Analytics.capture('avaphone_sms_compose_resolve', {'len': q.length});
    Contact? hit;
    try { hit = await Directory.resolve(q); } catch (_) { hit = null; }
    if (!mounted) return;
    if (hit == null || hit.npub.isEmpty) {
      setState(() { _resolving = false; _error = 'No AvaTOK account on that number'; });
      return;
    }
    Navigator.pop(context, hit);
  }

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.of(context).viewInsets.bottom + MediaQuery.of(context).padding.bottom;
    // Only AvaTOK-network contacts are offered as quick-picks (never the phone book).
    final saved = widget.contacts.where((c) => c.number.isNotEmpty).take(20).toList();
    return Padding(
      padding: EdgeInsets.only(bottom: bottom),
      child: Container(
        decoration: const BoxDecoration(
          color: PhoneTheme.surface,
          borderRadius: BorderRadius.vertical(top: Radius.circular(26)),
          border: Border(top: BorderSide(color: PhoneTheme.border, width: 1.5)),
        ),
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 18),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Center(
            child: Container(width: 44, height: 5, margin: const EdgeInsets.only(bottom: 16),
                decoration: BoxDecoration(color: PhoneTheme.border, borderRadius: BorderRadius.circular(100))),
          ),
          Text('New message', style: PhoneTheme.title(size: 20)),
          const SizedBox(height: 4),
          Text('Send to any AvaTOK number.', style: PhoneTheme.sub(size: 12.5)),
          const SizedBox(height: 14),
          TextField(
            controller: _ctrl,
            autofocus: true,
            keyboardType: TextInputType.phone,
            style: PhoneTheme.value(size: 16),
            cursorColor: PhoneTheme.accent,
            decoration: InputDecoration(
              hintText: 'AvaTOK number, e.g. +233 24 555 0148',
              hintStyle: PhoneTheme.sub(size: 13.5, color: PhoneTheme.textMute),
              filled: true,
              fillColor: PhoneTheme.surface2,
              prefixIcon: PhosphorIcon(PhosphorIcons.hash(PhosphorIconsStyle.bold), size: 18, color: PhoneTheme.teal),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(14),
                borderSide: const BorderSide(color: PhoneTheme.border, width: 1.5)),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(14),
                borderSide: const BorderSide(color: PhoneTheme.accent, width: 1.8)),
            ),
            onSubmitted: (_) => _go(),
          ),
          if (_error != null)
            Padding(padding: const EdgeInsets.only(top: 8),
                child: Text(_error!, style: PhoneTheme.sub(size: 12.5, color: PhoneTheme.danger))),
          const SizedBox(height: 14),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton.icon(
              style: ElevatedButton.styleFrom(
                backgroundColor: PhoneTheme.accent,
                foregroundColor: const Color(0xFF0E1116),
                elevation: 0,
                padding: const EdgeInsets.symmetric(vertical: 14),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(14),
                  side: const BorderSide(color: PhoneTheme.border, width: 2)),
              ),
              onPressed: _resolving ? null : _go,
              icon: _resolving
                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2.4, color: Color(0xFF0E1116)))
                  : PhosphorIcon(PhosphorIcons.paperPlaneTilt(PhosphorIconsStyle.fill), size: 18),
              label: Text(_resolving ? 'Finding…' : 'Start chat', style: PhoneTheme.value(size: 15, color: const Color(0xFF0E1116))),
            ),
          ),
          if (saved.isNotEmpty) ...[
            const SizedBox(height: 18),
            Text('YOUR AVATOK CONTACTS', style: PhoneTheme.tag(size: 10.5, color: PhoneTheme.textMute)),
            const SizedBox(height: 8),
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 220),
              child: ListView.builder(
                shrinkWrap: true,
                itemCount: saved.length,
                itemBuilder: (_, i) {
                  final c = saved[i];
                  return ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: PhoneTheme.ring(Avatar(seed: c.npub, name: c.name, size: 40,
                        avatarUrl: c.avatarUrl.isEmpty ? null : c.avatarUrl)),
                    title: Text(c.name.isNotEmpty ? c.name : c.number, style: PhoneTheme.value(size: 14.5)),
                    subtitle: Text(c.number, style: PhoneTheme.sub(size: 12)),
                    onTap: () => Navigator.pop(context, c),
                  );
                },
              ),
            ),
          ],
        ]),
      ),
    );
  }
}
