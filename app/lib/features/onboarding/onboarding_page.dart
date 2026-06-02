import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/theme.dart';
import '../../identity/identity.dart';

/// First-run onboarding: generate the Nostr keypair, show npub, warn about nsec.
class OnboardingPage extends StatefulWidget {
  final ValueChanged<Identity> onComplete;
  const OnboardingPage({super.key, required this.onComplete});
  @override
  State<OnboardingPage> createState() => _OnboardingPageState();
}

class _OnboardingPageState extends State<OnboardingPage> {
  final _store = IdentityStore();
  Identity? _id;
  bool _revealed = false;
  bool _saved = false;
  bool _busy = false;

  Future<void> _generate() async {
    setState(() => _busy = true);
    final id = await _store.createAndStore();
    setState(() {
      _id = id;
      _busy = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: _id == null ? _welcome() : _keys(),
        ),
      ),
    );
  }

  Widget _welcome() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 40),
        Text('AvaTalk', style: AvaTheme.wordmark(40)),
        const SizedBox(height: 8),
        Text('One verified identity.\nEvery social format.',
            style: Theme.of(context).textTheme.headlineSmall),
        const SizedBox(height: 16),
        const Text(
          'Your identity is a cryptographic key that lives on your device. '
          'It works across every Ava app — no username, no password.',
          style: TextStyle(color: AvaColors.sub, height: 1.5),
        ),
        const Spacer(),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: _busy ? null : _generate,
            child: _busy
                ? const SizedBox(
                    height: 20, width: 20,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Text('Create my identity'),
          ),
        ),
        const SizedBox(height: 12),
        const Center(
          child: Text('Generated on-device · never uploaded',
              style: TextStyle(fontSize: 11, color: AvaColors.sub)),
        ),
      ],
    );
  }

  Widget _keys() {
    final id = _id!;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 12),
        Text('Your keys', style: Theme.of(context).textTheme.headlineSmall),
        const SizedBox(height: 4),
        const Text('Your public name is your npub. Your secret key (nsec) is the '
            'only way to recover your account — save it somewhere safe.',
            style: TextStyle(color: AvaColors.sub)),
        const SizedBox(height: 24),
        _field('Public key (npub)', id.npub, AvaColors.brand, copyable: true),
        const SizedBox(height: 14),
        _secretField(id),
        const Spacer(),
        CheckboxListTile(
          contentPadding: EdgeInsets.zero,
          value: _saved,
          activeColor: AvaColors.brand,
          controlAffinity: ListTileControlAffinity.leading,
          onChanged: (v) => setState(() => _saved = v ?? false),
          title: const Text('I have saved my secret key somewhere safe',
              style: TextStyle(fontSize: 14)),
        ),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: _saved ? () => widget.onComplete(id) : null,
            child: const Text('Continue'),
          ),
        ),
        const SizedBox(height: 8),
      ],
    );
  }

  Widget _field(String label, String value, Color accent, {bool copyable = false}) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white, borderRadius: BorderRadius.circular(14)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: accent)),
          const SizedBox(height: 6),
          Row(
            children: [
              Expanded(
                child: Text(value,
                    style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
              ),
              if (copyable)
                IconButton(
                  icon: const Icon(Icons.copy, size: 18),
                  onPressed: () {
                    Clipboard.setData(ClipboardData(text: value));
                    ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('Copied')));
                  },
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _secretField(Identity id) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFFFEF2F2), borderRadius: BorderRadius.circular(14)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Secret key (nsec) — never share',
              style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: AvaColors.danger)),
          const SizedBox(height: 6),
          if (!_revealed)
            TextButton.icon(
              style: TextButton.styleFrom(padding: EdgeInsets.zero),
              icon: const Icon(Icons.visibility, size: 18),
              label: const Text('Tap to reveal'),
              onPressed: () => setState(() => _revealed = true),
            )
          else
            Row(
              children: [
                Expanded(
                  child: Text(id.nsec,
                      style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
                ),
                IconButton(
                  icon: const Icon(Icons.copy, size: 18),
                  onPressed: () {
                    Clipboard.setData(ClipboardData(text: id.nsec));
                    ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('Secret key copied')));
                  },
                ),
              ],
            ),
        ],
      ),
    );
  }
}
