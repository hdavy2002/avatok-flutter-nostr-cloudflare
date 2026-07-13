import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'avadial_channel.dart';
import 'avadial_theme.dart';
import 'device_contacts.dart';
import 'outgoing_call_screen.dart';

/// The Calls app's Dialpad tab (2026-07-12 redesign): a live contact search bar
/// above a real PSTN keypad — no more hidden bottom-sheet dialer. Typing 2+
/// letters searches the device phone book by name; typing 3+ digits searches by
/// number. Tapping a search result or dialing the keypad places a REAL carrier
/// (PSTN) call via [AvaDialChannel.placeCall] and opens [OutgoingCallScreen] —
/// this is the AvaDial/Calls world's OWN dialer, distinct from AvaTOK's in-network
/// AvaPhone dialer (features/avaphone/ava_phone_screen.dart).
class DialpadSearchTab extends StatefulWidget {
  const DialpadSearchTab({super.key});

  @override
  State<DialpadSearchTab> createState() => _DialpadSearchTabState();
}

class _DialpadSearchTabState extends State<DialpadSearchTab> {
  final _searchCtrl = TextEditingController();
  String _digits = '';
  bool _dialing = false;
  String? _status;
  List<DeviceContact> _results = const [];
  bool _searching = false;

  static const _keys = <(String, String)>[
    ('1', ''), ('2', 'ABC'), ('3', 'DEF'),
    ('4', 'GHI'), ('5', 'JKL'), ('6', 'MNO'),
    ('7', 'PQRS'), ('8', 'TUV'), ('9', 'WXYZ'),
    ('*', ''), ('0', '+'), ('#', ''),
  ];

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  /// Live search: starts as soon as the query has 2+ letters OR 3+ digits (owner
  /// spec), matching a contact's name (contains, case-insensitive) or number
  /// (digit-suffix contains).
  Future<void> _onSearchChanged(String q) async {
    final letters = q.replaceAll(RegExp(r'[^A-Za-z]'), '');
    final digits = q.replaceAll(RegExp(r'[^0-9]'), '');
    if (letters.length < 2 && digits.length < 3) {
      setState(() {
        _results = const [];
        _searching = false;
      });
      return;
    }
    setState(() => _searching = true);
    final all = await DeviceContacts.I.load();
    if (!mounted) return;
    final query = q.trim().toLowerCase();
    final matches = all.where((c) {
      final nameHit = (c.name ?? '').toLowerCase().contains(query);
      final numHit = digits.isNotEmpty && c.number.replaceAll(RegExp(r'[^0-9]'), '').contains(digits);
      return nameHit || numHit;
    }).toList();
    if (!mounted) return;
    setState(() {
      _results = matches;
      _searching = false;
    });
  }

  void _press(String k) {
    HapticFeedback.lightImpact();
    setState(() { _digits += k; _status = null; });
  }

  void _press0Long() {
    HapticFeedback.mediumImpact();
    setState(() { _digits += '+'; _status = null; });
  }

  void _backspace() {
    if (_digits.isEmpty) return;
    HapticFeedback.selectionClick();
    setState(() => _digits = _digits.substring(0, _digits.length - 1));
  }

  Future<void> _dial(String number) async {
    final n = number.trim();
    if (n.replaceAll(RegExp(r'[^\d]'), '').length < 3) {
      setState(() => _status = 'Enter a number to call');
      return;
    }
    setState(() { _dialing = true; _status = null; });
    Analytics.capture('avadial_dialpad_dial', {'len': n.length});
    final placed = await AvaDialChannel.I.placeCall(n);
    if (!mounted) return;
    setState(() => _dialing = false);
    if (placed) {
      Navigator.of(context, rootNavigator: true).push(
        MaterialPageRoute<void>(builder: (_) => OutgoingCallScreen(number: n)),
      );
    }
    // placed == false → CALL_PHONE permission prompt was kicked off by the
    // plugin; the next dial (post-grant) connects. No dead-end.
  }

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
        child: TextField(
          controller: _searchCtrl,
          onChanged: _onSearchChanged,
          style: ZineText.value(size: 15, color: AvaDialTheme.text),
          decoration: InputDecoration(
            hintText: 'Search name or number…',
            hintStyle: ZineText.sub(size: 14, color: AvaDialTheme.textMute),
            prefixIcon: const Icon(Icons.search, color: AvaDialTheme.textSoft),
            suffixIcon: _searchCtrl.text.isEmpty
                ? null
                : IconButton(
                    icon: const Icon(Icons.close, color: AvaDialTheme.textSoft),
                    onPressed: () {
                      _searchCtrl.clear();
                      _onSearchChanged('');
                    },
                  ),
            filled: true,
            fillColor: AvaDialTheme.surface2,
            contentPadding: const EdgeInsets.symmetric(vertical: 10),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(AD.rInput),
              borderSide: const BorderSide(color: AvaDialTheme.border, width: 1),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(AD.rInput),
              borderSide: const BorderSide(color: AvaDialTheme.border, width: 1),
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(AD.rInput),
              borderSide: const BorderSide(color: AvaDialTheme.accent, width: 1),
            ),
          ),
        ),
      ),
      Expanded(
        child: (_searching || _results.isNotEmpty || _searchCtrl.text.isNotEmpty)
            ? _searchResults()
            : _keypad(),
      ),
    ]);
  }

  Widget _searchResults() {
    if (_searching) {
      return const Center(child: CircularProgressIndicator(color: AvaDialTheme.accent));
    }
    if (_results.isEmpty) {
      return Center(
        child: Text('No matches yet', style: ZineText.sub(size: 14, color: AvaDialTheme.textSoft)),
      );
    }
    return ListView.builder(
      padding: const EdgeInsets.fromLTRB(14, 4, 14, 24),
      itemCount: _results.length,
      itemBuilder: (context, i) {
        final c = _results[i];
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: AdCard(
            color: AvaDialTheme.surface2,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Row(children: [
              ZineIconBadge(icon: PhosphorIcons.user(PhosphorIconsStyle.bold), color: AD.primaryBadge),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(c.name ?? c.number, style: ZineText.cardTitle(size: 15.5, color: AvaDialTheme.text)),
                  if (c.name != null) Text(c.number, style: ZineText.sub(size: 12.5, color: AvaDialTheme.textSoft)),
                ]),
              ),
              IconButton(
                onPressed: () => _dial(c.number),
                icon: const Icon(Icons.call, color: AD.incomingCall),
              ),
            ]),
          ),
        );
      },
    );
  }

  Widget _keypad() {
    return Column(mainAxisSize: MainAxisSize.min, children: [
      const SizedBox(height: 4),
      SizedBox(
        height: 44,
        child: Center(
          child: Text(
            _digits.isEmpty ? 'Enter a number' : _digits,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: ZineText.cardTitle(
                size: 26, color: _digits.isEmpty ? AvaDialTheme.textMute : AvaDialTheme.text),
          ),
        ),
      ),
      if (_status != null)
        Padding(
          padding: const EdgeInsets.only(bottom: 4),
          child: Text(_status!, style: ZineText.sub(size: 12.5, color: AD.danger)),
        ),
      const SizedBox(height: 8),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 28),
        child: GridView.count(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          crossAxisCount: 3,
          mainAxisSpacing: 10,
          crossAxisSpacing: 16,
          childAspectRatio: 1.35,
          children: [
            for (final k in _keys)
              _DialKey(
                digit: k.$1,
                sub: k.$2,
                onTap: () => _press(k.$1),
                onLongPress: k.$1 == '0' ? _press0Long : null,
              ),
          ],
        ),
      ),
      const SizedBox(height: 14),
      Row(mainAxisAlignment: MainAxisAlignment.center, children: [
        const SizedBox(width: 64),
        const Spacer(),
        GestureDetector(
          onTap: _dialing ? null : () => _dial(_digits),
          child: Container(
            width: 62, height: 62,
            decoration: BoxDecoration(
              color: _dialing ? AD.incomingCall.withValues(alpha: 0.5) : AD.incomingCall,
              shape: BoxShape.circle,
              border: Border.all(color: AvaDialTheme.border, width: 1),
              boxShadow: const [],
            ),
            child: _dialing
                ? const Padding(padding: EdgeInsets.all(18),
                    child: CircularProgressIndicator(strokeWidth: 2.6, color: Colors.white))
                : const Icon(Icons.call, size: 28, color: Colors.white),
          ),
        ),
        const Spacer(),
        SizedBox(
          width: 64,
          child: _digits.isEmpty
              ? null
              : IconButton(
                  onPressed: _backspace,
                  icon: const Icon(Icons.backspace_outlined, color: AvaDialTheme.textSoft),
                ),
        ),
      ]),
      const SizedBox(height: 12),
    ]);
  }
}

class _DialKey extends StatelessWidget {
  final String digit;
  final String sub;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;
  const _DialKey({required this.digit, required this.sub, required this.onTap, this.onLongPress});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      onLongPress: onLongPress,
      behavior: HitTestBehavior.opaque,
      child: Container(
        decoration: BoxDecoration(
          color: AvaDialTheme.surface2,
          borderRadius: BorderRadius.circular(AD.rListCard),
          border: Border.all(color: AvaDialTheme.border, width: 1),
          boxShadow: const [],
        ),
        child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
          Text(digit, style: ZineText.cardTitle(size: 22, color: AvaDialTheme.text)),
          if (sub.isNotEmpty)
            Text(sub, style: ZineText.tag(size: 9, color: AvaDialTheme.textMute)),
        ]),
      ),
    );
  }
}
