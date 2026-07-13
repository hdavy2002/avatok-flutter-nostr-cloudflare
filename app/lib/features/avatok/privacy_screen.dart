import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/avatok_dark.dart';
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
      backgroundColor: AD.bg,
      appBar: _header('Privacy'),
      body: p == null
          ? const Center(child: CircularProgressIndicator(color: AD.iconSearch))
          : ListView(padding: const EdgeInsets.all(20), children: [
              Text('HOW PEOPLE CAN FIND YOU', style: ADText.sectionLabel()),
              const SizedBox(height: 10),
              // AvaTOK number — always on, locked.
              _card(
                child: Row(children: [
                  _iconBadge(PhosphorIcons.hash(PhosphorIconsStyle.bold), color: AD.iconSearch, size: 28),
                  const SizedBox(width: 10),
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(_me?.hasNumber == true ? 'Your AvaTOK number' : 'AvaTOK number', style: ADText.rowName()),
                    Text(_me?.hasNumber == true ? (_me!.display ?? '') : 'Always discoverable', style: ADText.preview(c: AD.textSecondary)),
                  ])),
                  PhosphorIcon(PhosphorIcons.lockSimple(PhosphorIconsStyle.bold), size: 16, color: AD.textTertiary),
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
              Text('WHO CAN ADD ME', style: ADText.sectionLabel()),
              const SizedBox(height: 10),
              _whoOption('everyone', 'Everyone', 'Anyone who searches your AvaTOK number or email'),
              _whoOption('number_only', 'Only with my AvaTOK number', 'People must know your exact number'),
              _whoOption('nobody', 'Nobody', 'You won’t appear in search or QR adds'),
              const SizedBox(height: 22),
              // [LASTSEEN-PRIVACY-1] WhatsApp-style last-seen visibility.
              Text('WHO CAN SEE MY LAST SEEN', style: ADText.sectionLabel()),
              const SizedBox(height: 10),
              _lastSeenOption('everyone', 'Everyone', 'Anyone you chat with sees when you were last online'),
              _lastSeenOption('contacts', 'My contacts', 'Only people in your contact list'),
              _lastSeenOption('list', 'Only these people…',
                  p.lastSeenWho == 'list'
                      ? '${p.lastSeenAllow.length} ${p.lastSeenAllow.length == 1 ? 'person' : 'people'} — tap to edit'
                      : 'Pick exactly who can see it'),
              _lastSeenOption('nobody', 'Nobody', 'Your last seen and online status stay private'),
              if (_saving) const Padding(padding: EdgeInsets.only(top: 16), child: Center(child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: AD.iconSearch)))),
            ]),
    );
  }

  /// Inline dark v2 header (mirrors chat_list.dart) — replaces the light ZineAppBar.
  PreferredSizeWidget _header(String title, {bool showBack = true}) {
    return PreferredSize(
      preferredSize: const Size.fromHeight(72),
      child: Container(
        decoration: const BoxDecoration(
          color: AD.headerFooter,
          border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
        ),
        child: SafeArea(
          bottom: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(18, 10, 18, 12),
            child: Row(children: [
              if (showBack) ...[
                GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () => Navigator.of(context).maybePop(),
                  child: Container(
                    width: 42, height: 42,
                    decoration: BoxDecoration(
                      color: AD.card,
                      shape: BoxShape.circle,
                      border: Border.all(color: AD.borderControl, width: 1),
                    ),
                    child: Center(
                      child: PhosphorIcon(PhosphorIcons.arrowLeft(PhosphorIconsStyle.bold),
                          size: 20, color: AD.textPrimary),
                    ),
                  ),
                ),
                const SizedBox(width: 14),
              ],
              Expanded(
                child: Text(title, style: ADText.appTitle(),
                    maxLines: 1, overflow: TextOverflow.ellipsis),
              ),
            ]),
          ),
        ),
      ),
    );
  }

  Widget _card({required Widget child, VoidCallback? onTap}) {
    final box = Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: AD.card,
        borderRadius: BorderRadius.circular(AD.rListCard),
        border: Border.all(color: AD.borderCard, width: 1),
      ),
      child: child,
    );
    if (onTap == null) return box;
    return GestureDetector(behavior: HitTestBehavior.opaque, onTap: onTap, child: box);
  }

  Widget _iconBadge(IconData icon, {Color color = AD.iconSearch, double size = 28}) => Container(
        width: size, height: size,
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.18),
          borderRadius: BorderRadius.circular(AD.rBadge),
        ),
        child: Icon(icon, size: size * 0.53, color: color),
      );

  /// Inline dark v2 toggle — teal track when on, thumb white; preserves onChanged.
  Widget _toggle(bool value, ValueChanged<bool>? onChanged) {
    final enabled = onChanged != null;
    return GestureDetector(
      onTap: enabled ? () => onChanged(!value) : null,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 160),
        width: 52, height: 30,
        padding: const EdgeInsets.all(3),
        decoration: BoxDecoration(
          color: value ? AD.newGroup : AD.borderControl,
          borderRadius: BorderRadius.circular(100),
        ),
        child: AnimatedAlign(
          duration: const Duration(milliseconds: 160),
          alignment: value ? Alignment.centerRight : Alignment.centerLeft,
          child: Container(
            width: 24, height: 24,
            decoration: const BoxDecoration(shape: BoxShape.circle, color: Colors.white),
          ),
        ),
      ),
    );
  }

  Widget _toggleRow(IconData icon, String title, String sub, bool value, ValueChanged<bool> onChanged) => _card(
        child: Row(children: [
          _iconBadge(icon, color: AD.online, size: 28),
          const SizedBox(width: 10),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ADText.rowName().copyWith(fontSize: 14.5)),
            Text(sub, style: ADText.preview(c: AD.textSecondary)),
          ])),
          _toggle(value, _saving ? null : onChanged),
        ]),
      );

  Widget _whoOption(String key, String title, String sub) {
    final selected = _p!.whoCanAdd == key;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: _card(
        onTap: _saving ? null : () => _save(who: key),
        child: Row(children: [
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ADText.rowName().copyWith(fontSize: 14.5)),
            Text(sub, style: ADText.preview(c: AD.textSecondary)),
          ])),
          PhosphorIcon(
            selected ? PhosphorIcons.checkCircle(PhosphorIconsStyle.fill) : PhosphorIcons.circle(PhosphorIconsStyle.bold),
            size: 22, color: selected ? AD.iconSearch : AD.textTertiary,
          ),
        ]),
      ),
    );
  }

  Widget _lastSeenOption(String key, String title, String sub) {
    final selected = _p!.lastSeenWho == key;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: _card(
        onTap: _saving ? null : () => _chooseLastSeen(key),
        child: Row(children: [
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ADText.rowName().copyWith(fontSize: 14.5)),
            Text(sub, style: ADText.preview(c: AD.textSecondary)),
          ])),
          PhosphorIcon(
            selected ? PhosphorIcons.checkCircle(PhosphorIconsStyle.fill) : PhosphorIcons.circle(PhosphorIconsStyle.bold),
            size: 22, color: selected ? AD.iconSearch : AD.textTertiary,
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
      backgroundColor: AD.bg,
      appBar: _pickerHeader(context, 'Last seen'),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 4),
          child: Align(
            alignment: Alignment.centerLeft,
            child: Text('ONLY THESE PEOPLE SEE YOUR LAST SEEN', style: ADText.sectionLabel()),
          ),
        ),
        Expanded(
          child: widget.contacts.isEmpty
              ? Center(child: Text('No contacts yet', style: ADText.preview(c: AD.textSecondary)))
              : ListView.builder(
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  itemCount: widget.contacts.length,
                  itemBuilder: (_, i) {
                    final c = widget.contacts[i];
                    return CheckboxListTile(
                      value: _picked.contains(c.uid),
                      activeColor: AD.primaryBadge,
                      checkColor: Colors.white,
                      side: const BorderSide(color: AD.borderControl, width: 1.5),
                      onChanged: (v) => setState(() =>
                          v == true ? _picked.add(c.uid) : _picked.remove(c.uid)),
                      title: Text(c.name.isNotEmpty ? c.name : c.subtitle,
                          style: ADText.rowName().copyWith(fontSize: 14.5)),
                      subtitle: c.subtitle.isEmpty
                          ? null
                          : Text(c.subtitle, style: ADText.preview(c: AD.textSecondary)),
                      controlAffinity: ListTileControlAffinity.trailing,
                    );
                  },
                ),
        ),
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => Navigator.pop(context, _picked.toList()),
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(vertical: 15),
                decoration: BoxDecoration(
                  color: AD.primaryBadge,
                  borderRadius: BorderRadius.circular(100),
                ),
                alignment: Alignment.center,
                child: Text('Save (${_picked.length})',
                    style: const TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w800, fontSize: 16, color: Colors.white)),
              ),
            ),
          ),
        ),
      ]),
    );
  }

  /// Inline dark v2 header for the picker.
  PreferredSizeWidget _pickerHeader(BuildContext context, String title) {
    return PreferredSize(
      preferredSize: const Size.fromHeight(72),
      child: Container(
        decoration: const BoxDecoration(
          color: AD.headerFooter,
          border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
        ),
        child: SafeArea(
          bottom: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(18, 10, 18, 12),
            child: Row(children: [
              GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () => Navigator.of(context).maybePop(),
                child: Container(
                  width: 42, height: 42,
                  decoration: BoxDecoration(
                    color: AD.card,
                    shape: BoxShape.circle,
                    border: Border.all(color: AD.borderControl, width: 1),
                  ),
                  child: Center(
                    child: PhosphorIcon(PhosphorIcons.arrowLeft(PhosphorIconsStyle.bold),
                        size: 20, color: AD.textPrimary),
                  ),
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Text(title, style: ADText.appTitle(),
                    maxLines: 1, overflow: TextOverflow.ellipsis),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}
