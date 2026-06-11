import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/avatar.dart';
import '../../core/config.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'contacts.dart';

/// Bottom sheet to add a contact — matches the mockup:
/// "Add by ID" (paste @handle / npub) and "Search site" (directory search).
Future<Contact?> showAddContactSheet(BuildContext context) {
  return showModalBottomSheet<Contact>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Zine.paper,
    shape: const RoundedRectangleBorder(
        side: BorderSide(color: Zine.ink, width: Zine.bw),
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
            // Grab handle — ink-mute pill.
            Center(
              child: Container(
                width: 44, height: 5, margin: const EdgeInsets.only(bottom: 16),
                decoration: BoxDecoration(
                    color: Zine.inkMute, borderRadius: BorderRadius.circular(100)),
              ),
            ),
            Text('Add contact', style: ZineText.cardTitle(size: 22)),
            const SizedBox(height: 14),
            _tabs(),
            const SizedBox(height: 14),
            if (_byId) _byIdBody() else _searchBody(),
          ],
        ),
      ),
    );
  }

  Widget _tabs() => Row(children: [
        Expanded(child: ZineChip(
            label: 'Add by email',
            active: _byId,
            onTap: () => setState(() => _byId = true))),
        const SizedBox(width: 9),
        Expanded(child: ZineChip(
            label: 'Search by handle',
            active: !_byId,
            onTap: () => setState(() => _byId = false))),
      ]);

  Widget _byIdBody() => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ZineField(
            controller: _idCtrl,
            hint: 'e.g. username@domain.com',
            leadIcon: PhosphorIcons.user(PhosphorIconsStyle.bold),
            keyboardType: TextInputType.emailAddress,
            error: _error != null,
            onChanged: (_) => setState(() => _error = null),
            onSubmitted: (_) => _addById(),
            trailing: GestureDetector(
              onTap: () => ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('QR scan coming with the camera pass'))),
              child: PhosphorIcon(PhosphorIcons.qrCode(PhosphorIconsStyle.bold),
                  size: 20, color: Zine.ink),
            ),
          ),
          if (_error != null) ...[
            Row(children: [
              Expanded(child: ZineErrorMsg(_error!)),
              const SizedBox(width: 8),
              ZineLink('INVITE', onTap: _shareInvite),
            ]),
          ],
          const SizedBox(height: 16),
          ZineButton(
            label: 'Add contact',
            fullWidth: true,
            loading: _busy,
            icon: PhosphorIcons.userPlus(PhosphorIconsStyle.bold),
            onPressed: _idCtrl.text.trim().isEmpty || _busy ? null : _addById,
          ),
          const SizedBox(height: 12),
          Center(
            child: Text(
                'Add a friend by the email they signed up with. To find them by @handle, use Search by handle.',
                style: ZineText.sub(size: 12.5), textAlign: TextAlign.center),
          ),
        ],
      );

  Widget _searchBody() => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ZineField(
            controller: _searchCtrl,
            hint: 'e.g. @handle_name',
            leadIcon: PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
            onChanged: _onSearchChanged,
          ),
          const SizedBox(height: 10),
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
                          style: ZineText.sub(size: 13)),
                    ),
                  )
                : ListView.builder(
                    shrinkWrap: true,
                    itemCount: _results.length,
                    itemBuilder: (_, i) {
                      final c = _results[i];
                      return ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: Container(
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            border: Border.all(color: Zine.ink, width: 2),
                          ),
                          child: Avatar(seed: c.seed, name: c.name, size: 40,
                              avatarUrl: c.avatarUrl.isEmpty ? null : c.avatarUrl),
                        ),
                        title: Text(c.name, style: ZineText.value(size: 14.5)),
                        subtitle: c.subtitle.isNotEmpty
                            ? Text(c.subtitle, style: ZineText.sub(size: 12.5))
                            : null,
                        trailing: PhosphorIcon(
                            PhosphorIcons.plusCircle(PhosphorIconsStyle.fill),
                            color: Zine.blueInk),
                        onTap: () => Navigator.pop(context, c),
                      );
                    },
                  ),
          ),
        ],
      );
}
