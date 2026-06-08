import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/avatar.dart';
import '../../core/profile_store.dart';
import '../../core/theme.dart';
import '../../identity/identity.dart';
import '../avatok/contacts.dart';
import 'phone_verify_card.dart';

/// Set your public display name + @handle. Saving publishes you to the AvaTok
/// directory (opt-in discovery) and makes your @handle resolvable.
class ProfileScreen extends StatefulWidget {
  final Identity? identity;
  const ProfileScreen({super.key, this.identity});
  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  final _store = ProfileStore();
  final _name = TextEditingController();
  final _handle = TextEditingController();
  bool _saving = false;
  bool _listed = false;
  bool _sharePresence = true;

  @override
  void initState() {
    super.initState();
    _store.load().then((p) {
      if (!mounted) return;
      setState(() {
        _name.text = p.displayName;
        _handle.text = p.handle;
        _listed = !p.isEmpty;
        _sharePresence = p.sharePresence;
      });
    });
  }

  @override
  void dispose() { _name.dispose(); _handle.dispose(); super.dispose(); }

  Future<void> _save() async {
    final id = widget.identity;
    if (id == null || _saving) return;
    final handle = _handle.text.trim().toLowerCase().replaceAll('@', '');
    setState(() => _saving = true);
    await _store.save(Profile(displayName: _name.text.trim(), handle: handle, sharePresence: _sharePresence));
    // Opt-in discovery: publish to the directory so others can find me.
    if (_name.text.trim().isNotEmpty || handle.isNotEmpty) {
      await Directory.registerProfile(npub: id.npub, handle: handle, name: _name.text.trim());
    }
    if (!mounted) return;
    setState(() { _saving = false; _listed = true; });
    ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Profile saved — people can now find you')));
  }

  @override
  Widget build(BuildContext context) {
    final id = widget.identity;
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white, elevation: 0, foregroundColor: AvaColors.ink,
        title: const Text('Profile'),
      ),
      // Bottom padding clears the system nav bar so the Update button is never chopped.
      body: ListView(padding: EdgeInsets.fromLTRB(20, 20, 20, 24 + MediaQuery.of(context).padding.bottom), children: [
        Center(child: Avatar(seed: id?.npub ?? 'me', name: _name.text.isEmpty ? 'You' : _name.text, size: 88)),
        const SizedBox(height: 20),
        const Text('Display name', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13)),
        const SizedBox(height: 6),
        TextField(
          controller: _name,
          onChanged: (_) => setState(() {}),
          decoration: _dec('Your name'),
        ),
        const SizedBox(height: 16),
        const Text('Handle', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13)),
        const SizedBox(height: 6),
        TextField(
          controller: _handle,
          decoration: _dec('@yourhandle', prefix: '@'),
          inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[a-zA-Z0-9_]'))],
        ),
        const SizedBox(height: 6),
        const Text('Others can add you by @handle. Leave blank to stay unlisted.',
            style: TextStyle(color: AvaColors.sub, fontSize: 12)),
        const SizedBox(height: 12),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          activeColor: AvaColors.brand,
          value: _sharePresence,
          onChanged: (v) => setState(() => _sharePresence = v),
          title: const Text('Share last seen / online', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
          subtitle: const Text('Let contacts see when you are online', style: TextStyle(color: AvaColors.sub, fontSize: 12)),
        ),
        const SizedBox(height: 16),
        const PhoneVerifyCard(),
        const SizedBox(height: 8),
        if (id != null) Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(14)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('Your AvaTOK ID (npub)', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: AvaColors.brand)),
            const SizedBox(height: 4),
            Row(children: [
              Expanded(child: SelectableText(id.npub, style: const TextStyle(fontFamily: 'monospace', fontSize: 11.5))),
              IconButton(icon: const Icon(Icons.copy, size: 18), onPressed: () {
                Clipboard.setData(ClipboardData(text: id.npub));
                ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Copied')));
              }),
            ]),
          ]),
        ),
        const SizedBox(height: 20),
        SizedBox(width: double.infinity, child: FilledButton(
          style: FilledButton.styleFrom(backgroundColor: AvaColors.brand, padding: const EdgeInsets.symmetric(vertical: 15)),
          onPressed: _saving ? null : _save,
          child: _saving
              ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
              : Text(_listed ? 'Update profile' : 'Save & get discoverable',
                  style: const TextStyle(fontWeight: FontWeight.w700)),
        )),
      ]),
    );
  }

  InputDecoration _dec(String hint, {String? prefix}) => InputDecoration(
        hintText: hint,
        prefixText: prefix,
        filled: true,
        fillColor: AvaColors.soft,
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide.none),
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      );
}
