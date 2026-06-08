import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/avatar.dart';
import '../../core/config.dart';
import '../../core/theme.dart';
import 'contacts.dart';

/// Bottom sheet to add a contact — matches the mockup:
/// "Add by ID" (paste @handle / npub) and "Search site" (directory search).
Future<Contact?> showAddContactSheet(BuildContext context) {
  return showModalBottomSheet<Contact>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.white,
    shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(26))),
    builder: (_) => const _AddContactSheet(),
  );
}

class _AddContactSheet extends StatefulWidget {
  const _AddContactSheet();
  @override
  State<_AddContactSheet> createState() => _AddContactSheetState();
}

class _AddContactSheetState extends State<_AddContactSheet> {
  bool _byId = true; // false = Search site
  final _idCtrl = TextEditingController();
  final _searchCtrl = TextEditingController();
  bool _busy = false;
  String? _error;
  List<Contact> _results = [];
  Timer? _debounce;

  @override
  void dispose() {
    _idCtrl.dispose();
    _searchCtrl.dispose();
    _debounce?.cancel();
    super.dispose();
  }

  Future<void> _addById() async {
    final q = _idCtrl.text.trim();
    if (q.isEmpty) return;
    setState(() { _busy = true; _error = null; });
    final c = await Directory.resolve(q);
    if (!mounted) return;
    setState(() => _busy = false);
    if (c == null) {
      setState(() => _error = 'No one found. Share an invite link instead.');
      return;
    }
    Navigator.pop(context, c);
  }

  void _onSearchChanged(String v) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), () async {
      final r = await Directory.search(v);
      if (mounted) setState(() => _results = r);
    });
  }

  void _shareInvite() {
    // Invite link is built from the typed value if it's an npub; else generic.
    final q = _idCtrl.text.trim();
    final link = q.startsWith('npub1') ? '$kInviteBase$q' : kInviteBase;
    Clipboard.setData(ClipboardData(text: link));
    ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Invite link copied — share it anywhere')));
  }

  @override
  Widget build(BuildContext context) {
    final mq = MediaQuery.of(context);
    // Lift the sheet clear of the keyboard AND the system nav bar so the
    // "Add contact" button is never cut off the bottom of the screen.
    final bottom = mq.viewInsets.bottom + mq.padding.bottom + 16;
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
                width: 40, height: 4, margin: const EdgeInsets.only(bottom: 16),
                decoration: BoxDecoration(
                    color: const Color(0xFFE2E4E9), borderRadius: BorderRadius.circular(2)),
              ),
            ),
            const Text('Add contact',
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: AvaColors.ink)),
            const SizedBox(height: 14),
            _tabs(),
            const SizedBox(height: 14),
            if (_byId) _byIdBody() else _searchBody(),
          ],
        ),
      ),
    );
  }

  Widget _tabs() => Container(
        padding: const EdgeInsets.all(4),
        decoration: BoxDecoration(
            color: AvaColors.soft, borderRadius: BorderRadius.circular(14)),
        child: Row(children: [
          _tab('Add by email', _byId, () => setState(() => _byId = true)),
          _tab('Search by handle', !_byId, () => setState(() => _byId = false)),
        ]),
      );

  Widget _tab(String label, bool active, VoidCallback onTap) => Expanded(
        child: GestureDetector(
          onTap: onTap,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 150),
            padding: const EdgeInsets.symmetric(vertical: 11),
            alignment: Alignment.center,
            decoration: BoxDecoration(
                color: active ? AvaColors.ink : Colors.transparent,
                borderRadius: BorderRadius.circular(11)),
            child: Text(label,
                style: TextStyle(
                    color: active ? Colors.white : AvaColors.sub,
                    fontWeight: FontWeight.w700, fontSize: 14)),
          ),
        ),
      );

  Widget _byIdBody() => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14),
            decoration: BoxDecoration(
                color: AvaColors.soft, borderRadius: BorderRadius.circular(14)),
            child: Row(children: [
              const Icon(Icons.person_outline, size: 18, color: Color(0xFF9AA1AC)),
              const SizedBox(width: 8),
              Expanded(
                child: TextField(
                  controller: _idCtrl,
                  onChanged: (_) => setState(() => _error = null),
                  onSubmitted: (_) => _addById(),
                  keyboardType: TextInputType.emailAddress,
                  decoration: const InputDecoration(
                      hintText: 'e.g. username@domain.com',
                      border: InputBorder.none, isDense: true,
                      contentPadding: EdgeInsets.symmetric(vertical: 14)),
                ),
              ),
              IconButton(
                tooltip: 'Scan QR',
                icon: const Icon(Icons.qr_code_scanner, size: 20, color: AvaColors.brand),
                onPressed: () => ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('QR scan coming with the camera pass'))),
              ),
            ]),
          ),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Row(children: [
              Expanded(child: Text(_error!, style: const TextStyle(color: AvaColors.danger, fontSize: 12.5))),
              TextButton(onPressed: _shareInvite, child: const Text('Invite')),
            ]),
          ],
          const SizedBox(height: 14),
          SizedBox(
            width: double.infinity,
            child: FilledButton(
              style: FilledButton.styleFrom(
                  backgroundColor: AvaColors.brand,
                  disabledBackgroundColor: const Color(0xFFBFC4CC),
                  padding: const EdgeInsets.symmetric(vertical: 15),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14))),
              onPressed: _idCtrl.text.trim().isEmpty || _busy ? null : _addById,
              child: _busy
                  ? const SizedBox(width: 20, height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                  : const Text('Add contact',
                      style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
            ),
          ),
          const SizedBox(height: 10),
          const Center(
            child: Text("Add a friend by the email they signed up with. To find them by @handle, use Search by handle.",
                style: TextStyle(color: AvaColors.sub, fontSize: 12), textAlign: TextAlign.center),
          ),
        ],
      );

  Widget _searchBody() => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14),
            decoration: BoxDecoration(
                color: AvaColors.soft, borderRadius: BorderRadius.circular(14)),
            child: Row(children: [
              const Icon(Icons.search, size: 18, color: Color(0xFF9AA1AC)),
              const SizedBox(width: 8),
              Expanded(
                child: TextField(
                  controller: _searchCtrl,
                  onChanged: _onSearchChanged,
                  decoration: const InputDecoration(
                      hintText: 'e.g. @handle_name',
                      border: InputBorder.none, isDense: true,
                      contentPadding: EdgeInsets.symmetric(vertical: 14)),
                ),
              ),
            ]),
          ),
          const SizedBox(height: 8),
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 280),
            child: _results.isEmpty
                ? Padding(
                    padding: const EdgeInsets.symmetric(vertical: 24),
                    child: Center(
                      child: Text(
                          _searchCtrl.text.trim().length < 2
                              ? 'e.g. @handle_name'
                              : 'No matches yet',
                          style: const TextStyle(color: AvaColors.sub, fontSize: 13)),
                    ),
                  )
                : ListView.builder(
                    shrinkWrap: true,
                    itemCount: _results.length,
                    itemBuilder: (_, i) {
                      final c = _results[i];
                      return ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: Avatar(seed: c.seed, name: c.name, size: 40, avatarUrl: c.avatarUrl.isEmpty ? null : c.avatarUrl),
                        title: Text(c.name,
                            style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14.5)),
                        subtitle: c.subtitle.isNotEmpty
                            ? Text(c.subtitle, style: const TextStyle(color: AvaColors.sub, fontSize: 12.5))
                            : null,
                        trailing: const Icon(Icons.add_circle, color: AvaColors.brand),
                        onTap: () => Navigator.pop(context, c),
                      );
                    },
                  ),
          ),
        ],
      );
}
