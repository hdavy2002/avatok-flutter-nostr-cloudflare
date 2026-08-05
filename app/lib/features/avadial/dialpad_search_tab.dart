import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine_widgets.dart';
import '../avatok/contacts.dart';
import '../avatok/invite_screen.dart';
import '../avatok/place_1to1_call.dart';
import 'avadial_theme.dart';
import '../../core/ui/messenger_theme.dart';

/// The Calls app's Dialpad tab — AVATOK-ONLY (owner pivot 2026-07-16). AvaDial no
/// longer places carrier/PSTN calls: dialing a number now resolves it against the
/// AvaTOK directory (the same in-network identity every AvaTOK number already
/// carries — see features/avatok/ava_number.dart) and, on a hit, starts an
/// in-app AvaTOK-to-AvaTOK call through [place1to1Call] — the SAME call flow the
/// chat thread / contact profile "Call" buttons use. No `ACTION_CALL`/`tel:`
/// intent and no [AvaDialChannel.placeCall] path exist on this screen anymore.
///
/// A number that resolves to no AvaTOK account shows a "Not on AvaTOK" state
/// with an Invite action (reuses the existing [InviteScreen] friends-invite flow)
/// instead of silently failing or falling back to a carrier call.
class DialpadSearchTab extends StatefulWidget {
  const DialpadSearchTab({super.key});

  @override
  State<DialpadSearchTab> createState() => _DialpadSearchTabState();
}

class _DialpadSearchTabState extends State<DialpadSearchTab> {
  final _searchCtrl = TextEditingController();
  String _digits = '';
  bool _dialing = false;
  bool _searching = false;
  String? _status;
  // 0 or 1 result: AvaTOK directory lookups are exact-key (email or number), so
  // there is never a fuzzy list here — see Directory.search's doc comment.
  Contact? _searchHit;
  bool _searchedNoHit = false;

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

  /// [AVADIAL-AVATOK-ONLY-1] Search is wired to the SAME AvaTOK directory lookup
  /// the rest of the app uses (Directory.search — features/avatok/contacts.dart),
  /// which is deliberately EXACT-KEY: a complete email, an AvaTOK number (6+
  /// digits), or a raw uid. A bare name matches nothing here on purpose (the
  /// directory has no name index at scale — see Directory.search's doc comment);
  /// name search only ever applied to the LOCAL saved-contacts list, which this
  /// dialpad doesn't show (that's the Contacts tab).
  Future<void> _onSearchChanged(String q) async {
    final query = q.trim();
    if (query.length < 3) {
      setState(() {
        _searching = false;
        _searchHit = null;
        _searchedNoHit = false;
      });
      return;
    }
    setState(() => _searching = true);
    final hits = await Directory.search(query);
    if (!mounted) return;
    setState(() {
      _searching = false;
      _searchHit = hits.isEmpty ? null : hits.first;
      _searchedNoHit = hits.isEmpty;
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

  Future<void> _callContact(Contact c) async {
    Analytics.capture('avadial_dialpad_call', {'via': 'search'});
    await place1to1Call(context, uid: c.uid, name: c.name.isNotEmpty ? c.name : c.number,
        avatarUrl: c.avatarUrl, dialer: true);
  }

  Future<void> _dial(String number) async {
    final n = number.trim();
    if (n.replaceAll(RegExp(r'[^\d]'), '').length < 3) {
      setState(() => _status = 'Enter an AvaTOK number to call');
      return;
    }
    setState(() { _dialing = true; _status = null; });
    Analytics.capture('avadial_dialpad_dial', {'len': n.length});
    Contact? hit;
    try { hit = await Directory.resolve(n); } catch (_) { hit = null; }
    if (!mounted) return;
    setState(() => _dialing = false);
    if (hit == null || hit.uid.isEmpty) {
      Analytics.capture('avadial_dialpad_not_on_avatok', {'len': n.length});
      await _showNotOnAvaTok(n);
      return;
    }
    await place1to1Call(context, uid: hit.uid, name: hit.name.isNotEmpty ? hit.name : hit.number,
        avatarUrl: hit.avatarUrl, dialer: true);
  }

  Future<void> _showNotOnAvaTok(String number) async {
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (dialogCtx) => AlertDialog(
        backgroundColor: AvaDialTheme.surface2,
        shape: RoundedRectangleBorder(
          side: const BorderSide(color: AvaDialTheme.border, width: 1),
          borderRadius: BorderRadius.circular(AD.rDialog),
        ),
        title: Text('Not on AvaTOK', style: ADText.threadName(c: AvaDialTheme.text)),
        content: Text(
          '$number isn’t an AvaTOK number yet. AvaDial only calls other AvaTOK '
          'users — invite them to join.',
          style: ADText.preview(c: AvaDialTheme.textSoft),
        ),
        actionsPadding: const EdgeInsets.fromLTRB(Msg.s5, 0, Msg.s5, Msg.s4),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogCtx),
            child: Text('Cancel', style: ADText.rowName(c: AvaDialTheme.textSoft)),
          ),
          TextButton(
            onPressed: () {
              Navigator.pop(dialogCtx);
              Navigator.of(context, rootNavigator: true).push(
                MaterialPageRoute<void>(builder: (_) => const InviteScreen()));
            },
            child: Text('Invite', style: ADText.rowName(c: AD.online)),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s3, Msg.s4, Msg.s2),
        // [AVADIAL-SEARCH-2] White box, black text (owner spec) — same
        // AvaDialTheme.search* tokens as the four tab search bars. This field
        // keeps its own outlined/prefixIcon shape rather than the pill used
        // there; only the colours are shared.
        child: TextField(
          controller: _searchCtrl,
          onChanged: _onSearchChanged,
          // The app-wide cursor colour is tuned for the dark surface and
          // vanishes on white — pin it to the input's own ink.
          cursorColor: AvaDialTheme.searchText,
          style: AvaDialTheme.value(size: 15, color: AvaDialTheme.searchText),
          decoration: InputDecoration(
            hintText: 'Search by AvaTOK number or email…',
            hintStyle: AvaDialTheme.sub(size: 14, color: AvaDialTheme.searchHint),
            prefixIcon: Icon(PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.regular), color: AvaDialTheme.searchHint),
            suffixIcon: _searchCtrl.text.isEmpty
                ? null
                : IconButton(
                    icon: Icon(PhosphorIcons.x(PhosphorIconsStyle.regular), color: AvaDialTheme.searchHint),
                    onPressed: () {
                      _searchCtrl.clear();
                      _onSearchChanged('');
                    },
                  ),
            filled: true,
            fillColor: AvaDialTheme.searchFill,
            contentPadding: const EdgeInsets.symmetric(vertical: Msg.s3),
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
        child: _searchCtrl.text.trim().length >= 3 ? _searchResults() : _keypad(),
      ),
    ]);
  }

  Widget _searchResults() {
    if (_searching) {
      return const Center(child: CircularProgressIndicator(color: AvaDialTheme.accent));
    }
    final hit = _searchHit;
    if (hit == null) {
      if (!_searchedNoHit) {
        return Center(
          child: Text('No matches yet', style: AvaDialTheme.sub(size: 14, color: AvaDialTheme.textSoft)),
        );
      }
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            ZineIconBadge(icon: PhosphorIcons.userMinus(PhosphorIconsStyle.bold), color: AD.textTertiary, size: 48),
            const SizedBox(height: Msg.s3),
            Text('Not on AvaTOK', style: AvaDialTheme.title(size: 16, color: AvaDialTheme.text)),
            const SizedBox(height: Msg.s1),
            Text('No AvaTOK account matches that number or email.',
                textAlign: TextAlign.center, style: AvaDialTheme.sub(size: 13, color: AvaDialTheme.textSoft)),
            const SizedBox(height: Msg.s3),
            AdButton(
              label: 'Invite',
              variant: AdButtonVariant.teal,
              fontSize: 14,
              trailingIcon: false,
              onPressed: () => Navigator.of(context, rootNavigator: true).push(
                  MaterialPageRoute<void>(builder: (_) => const InviteScreen())),
            ),
          ]),
        ),
      );
    }
    return ListView(
      padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s1, Msg.s4, Msg.s5),
      children: [
        AdCard(
          color: AvaDialTheme.surface2,
          padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s3),
          child: Row(children: [
            ZineIconBadge(icon: PhosphorIcons.user(PhosphorIconsStyle.bold), color: AD.primaryBadge),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(hit.name.isNotEmpty ? hit.name : hit.number,
                    style: AvaDialTheme.title(size: 15, color: AvaDialTheme.text)),
                if (hit.number.isNotEmpty)
                  Text(hit.number, style: AvaDialTheme.sub(size: 12, color: AvaDialTheme.textSoft)),
              ]),
            ),
            IconButton(
              onPressed: () => _callContact(hit),
              icon: Icon(PhosphorIcons.phone(PhosphorIconsStyle.bold), color: AD.incomingCall),
            ),
          ]),
        ),
      ],
    );
  }

  Widget _keypad() {
    return Column(mainAxisSize: MainAxisSize.min, children: [
      const SizedBox(height: 4),
      SizedBox(
        height: 44,
        child: Center(
          child: Text(
            _digits.isEmpty ? 'Enter an AvaTOK number' : _digits,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: AvaDialTheme.title(
                size: 26, color: _digits.isEmpty ? AvaDialTheme.textMute : AvaDialTheme.text),
          ),
        ),
      ),
      if (_status != null)
        Padding(
          padding: const EdgeInsets.only(bottom: 4),
          child: Text(_status!, style: AvaDialTheme.sub(size: 12, color: AD.danger)),
        ),
      const SizedBox(height: 8),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: Msg.s6),
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
      const SizedBox(height: Msg.s3),
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
                : Icon(PhosphorIcons.phone(PhosphorIconsStyle.bold), size: 28, color: Colors.white),
          ),
        ),
        const Spacer(),
        SizedBox(
          width: 64,
          child: _digits.isEmpty
              ? null
              : IconButton(
                  onPressed: _backspace,
                  icon: Icon(PhosphorIcons.backspace(PhosphorIconsStyle.regular), color: AvaDialTheme.textSoft),
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
          Text(digit, style: AvaDialTheme.title(size: 22, color: AvaDialTheme.text)),
          if (sub.isNotEmpty)
            Text(sub, style: AvaDialTheme.tag(size: 9, color: AvaDialTheme.textMute)),
        ]),
      ),
    );
  }
}
