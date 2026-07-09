import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'ava_number.dart';
import 'contacts.dart';

/// Settings → Privacy & discoverability (Specs/AVATOK-NUMBER-FEATURE-SPEC.md §10 #5).
///
/// Controls which network keys can find the user. The AvaTOK number is always
/// discoverable (that's its purpose); the real phone is private by default; email
/// is on by default. Handles are retired, so they never appear here.
///
/// [LASTSEEN-PRIVACY-1] (owner decision 2026-07-09): WhatsApp-style "who can see
/// my last seen" — Everyone / My contacts / Only these people (custom list) /
/// Nobody. 'My contacts' syncs the uid set of the saved contact list (uids only,
/// never phone numbers — the 2026-06-27 privacy rule); the custom list is a
/// hand-picked subset. Enforced SERVER-side in /api/user/last-seen.
class PrivacyScreen extends StatefulWidget {
  const PrivacyScreen({super.key});
  @override
  State<PrivacyScreen> createState() => _PrivacyScreenState();
}

class _PrivacyScreenState extends State<PrivacyScreen> {
  Discoverability? _p;
  MyNumber? _me;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final p = await AvaNumber.getPrivacy();
    final me = await AvaNumber.me();
    if (!mounted) return;
    setState(() { _p = p; _me = me; });
  }

  Future<void> _save({bool? phone, bool? email, String? who,
      String? lastSeenWho, List<String>? lastSeenAllow}) async {
    final cur = _p!;
    setState(() {
      _p = Discoverability(
        phoneDiscoverable: phone ?? cur.phoneDiscoverable,
        emailDiscoverable: email ?? cur.emailDiscoverable,
        whoCanAdd: who ?? cur.whoCanAdd,
        lastSeenWho: lastSeenWho ?? cur.lastSeenWho,
        lastSeenAllow: lastSeenAllow ?? cur.lastSeenAllow,
      );
      _saving = true;
    });
    await AvaNumber.setPrivacy(phoneDiscoverable: phone, emailDiscoverable: email, whoCanAdd: who,
        lastSeenWho: lastSeenWho, lastSeenAllow: lastSeenAllow);
    if (mounted) setState(() => _saving = false);
  }

  /// Real-account uids from the saved contact list (phone-only receptionist
  /// callers have no uid and can't query last-seen anyway).
  Future<List<Contact>> _accountContacts() async {
    final all = await ContactsStore().load();
    return [for (final c in all) if (!c.isPhoneOnly && c.uid.isNotEmpty) c];
  }

  Future<void> _chooseLastSeen(String key) async {
    switch (key) {
      case 'everyone':
      case 'nobody':
        await _save(lastSeenWho: key);
        return;
      case 'contacts':
        // Sync the CURRENT contact uid set as the allow list. Re-selecting the
        // option (or reopening this screen after adding contacts) refreshes it.
        final uids = [for (final c in await _accountContacts()) c.uid];
        await _save(lastSeenWho: 'contacts', lastSeenAllow: uids);
        return;
      case 'list':
        final contacts = await _accountContacts();
        if (!mounted) return;
        final picked = await Navigator.push<List<String>>(context, MaterialPageRoute(
            builder: (_) => _LastSeenListPicker(
                contacts: contacts, initial: _p?.lastSeenAllow ?? const [])));
        if (picked == null) return; // cancelled — keep the previous setting
        await _save(lastSeenWho: 'list', lastSeenAllow: picked);
        return;
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = _p;
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(title: 'Privacy', markWord: 'Privacy'),
      body: p == null
          ? const Center(child: CircularProgressIndicator())
          : ListView(padding: const EdgeInsets.all(20), children: [
              Text('HOW PEOPLE CAN FIND YOU', style: ZineText.kicker()),
              const SizedBox(height: 10),
              // AvaTOK number — always on, locked.
              ZineCard(
                child: Row(children: [
                  ZineIconBadge(icon: PhosphorIcons.hash(PhosphorIconsStyle.bold), color: Zine.blue, size: 28),
                  const SizedBox(width: 10),
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(_me?.hasNumber == true ? 'Your AvaTOK number' : 'AvaTOK number', style: ZineText.value(size: 15)),
                    Text(_me?.hasNumber == true ? (_me!.display ?? '') : 'Always discoverable', style: ZineText.sub(size: 12)),
                  ])),
                  PhosphorIcon(PhosphorIcons.lockSimple(PhosphorIconsStyle.bold), size: 16, color: Zine.inkMute),
                ]),
              ),
              const SizedBox(height: 10),
              // Owner request 2026-06-29: hide "Find me by my real phone number".
              // Exposing a private number now lives in Profile (the private-number
              // field + the "Show my private number" switch), so we never imply we
              // surface someone's real number from this discoverability toggle.
              // _toggleRow(PhosphorIcons.phone(PhosphorIconsStyle.bold), 'Find me by my real phone number',
              //     'Off keeps your real number private', p.phoneDiscoverable, (v) => _save(phone: v)),
              // const SizedBox(height: 10),
              _toggleRow(PhosphorIcons.envelope(PhosphorIconsStyle.bold), 'Find me by my email',
                  'People who know your email can add you', p.emailDiscoverable, (v) => _save(email: v)),
              const SizedBox(height: 22),
              Text('WHO CAN ADD ME', style: ZineText.kicker()),
              const SizedBox(height: 10),
              _whoOption('everyone', 'Everyone', 'Anyone who searches your AvaTOK number or email'),
              _whoOption('number_only', 'Only with my AvaTOK number', 'People must know your exact number'),
              _whoOption('nobody', 'Nobody', 'You won’t appear in search or QR adds'),
              const SizedBox(height: 22),
              // [LASTSEEN-PRIVACY-1] WhatsApp-style last-seen visibility.
              Text('WHO CAN SEE MY LAST SEEN', style: ZineText.kicker()),
              const SizedBox(height: 10),
              _lastSeenOption('everyone', 'Everyone', 'Anyone you chat with sees when you were last online'),
              _lastSeenOption('contacts', 'My contacts', 'Only people in your contact list'),
              _lastSeenOption('list', 'Only these people…',
                  p.lastSeenWho == 'list'
                      ? '${p.lastSeenAllow.length} ${p.lastSeenAllow.length == 1 ? 'person' : 'people'} — tap to edit'
                      : 'Pick exactly who can see it'),
              _lastSeenOption('nobody', 'Nobody', 'Your last seen and online status stay private'),
              if (_saving) const Padding(padding: EdgeInsets.only(top: 16), child: Center(child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)))),
            ]),
    );
  }

  Widget _toggleRow(IconData icon, String title, String sub, bool value, ValueChanged<bool> onChanged) => ZineCard(
        child: Row(children: [
          ZineIconBadge(icon: icon, color: Zine.mint, size: 28),
          const SizedBox(width: 10),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ZineText.value(size: 14.5)),
            Text(sub, style: ZineText.sub(size: 12)),
          ])),
          ZineToggle(value: value, onChanged: _saving ? null : onChanged),
        ]),
      );

  Widget _whoOption(String key, String title, String sub) {
    final selected = _p!.whoCanAdd == key;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: ZineCard(
        onTap: _saving ? null : () => _save(who: key),
        child: Row(children: [
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ZineText.value(size: 14.5)),
            Text(sub, style: ZineText.sub(size: 12)),
          ])),
          PhosphorIcon(
            selected ? PhosphorIcons.checkCircle(PhosphorIconsStyle.fill) : PhosphorIcons.circle(PhosphorIconsStyle.bold),
            size: 22, color: selected ? Zine.blue : Zine.inkMute,
          ),
        ]),
      ),
    );
  }

  Widget _lastSeenOption(String key, String title, String sub) {
    final selected = _p!.lastSeenWho == key;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: ZineCard(
        onTap: _saving ? null : () => _chooseLastSeen(key),
        child: Row(children: [
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ZineText.value(size: 14.5)),
            Text(sub, style: ZineText.sub(size: 12)),
          ])),
          PhosphorIcon(
            selected ? PhosphorIcons.checkCircle(PhosphorIconsStyle.fill) : PhosphorIcons.circle(PhosphorIconsStyle.bold),
            size: 22, color: selected ? Zine.blue : Zine.inkMute,
          ),
        ]),
      ),
    );
  }
}

/// [LASTSEEN-PRIVACY-1] Multi-select contact picker for the custom last-seen
/// list (same CheckboxListTile idiom as NewGroupScreen). Pops the picked uid
/// list, or null on back/cancel.
class _LastSeenListPicker extends StatefulWidget {
  final List<Contact> contacts;
  final List<String> initial;
  const _LastSeenListPicker({required this.contacts, required this.initial});
  @override
  State<_LastSeenListPicker> createState() => _LastSeenListPickerState();
}

class _LastSeenListPickerState extends State<_LastSeenListPicker> {
  late final Set<String> _picked = {...widget.initial};

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(title: 'Last seen', markWord: 'seen'),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 4),
          child: Align(
            alignment: Alignment.centerLeft,
            child: Text('ONLY THESE PEOPLE SEE YOUR LAST SEEN', style: ZineText.kicker()),
          ),
        ),
        Expanded(
          child: widget.contacts.isEmpty
              ? Center(child: Text('No contacts yet', style: ZineText.sub(size: 13)))
              : ListView.builder(
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  itemCount: widget.contacts.length,
                  itemBuilder: (_, i) {
                    final c = widget.contacts[i];
                    return CheckboxListTile(
                      value: _picked.contains(c.uid),
                      onChanged: (v) => setState(() =>
                          v == true ? _picked.add(c.uid) : _picked.remove(c.uid)),
                      title: Text(c.name.isNotEmpty ? c.name : c.subtitle,
                          style: ZineText.value(size: 14.5)),
                      subtitle: c.subtitle.isEmpty
                          ? null
                          : Text(c.subtitle, style: ZineText.sub(size: 12)),
                      controlAffinity: ListTileControlAffinity.trailing,
                    );
                  },
                ),
        ),
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: () => Navigator.pop(context, _picked.toList()),
                child: Text('Save (${_picked.length})'),
              ),
            ),
          ),
        ),
      ]),
    );
  }
}
