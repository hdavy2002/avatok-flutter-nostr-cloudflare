import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import 'package:flutter_svg/flutter_svg.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ava_dm_client.dart'; // [AVA-TOGGLE-DM-1] per-thread Ava mode
import '../../core/avatar.dart';
import '../../core/group_store.dart';
import '../../core/remote_config.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/illustrations.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/rajasthani_motifs.dart';
import '../../identity/identity.dart';
import '../profile/qr_share.dart';
import 'contacts.dart';
import 'dialpad_prefill.dart';
import 'stranger_gate_api.dart' show dmConvIdFor; // [AVA-TOGGLE-DM-1] server conv id

/// Contact details: name, AvaTOK number, and shared groups.
///
/// Handles are retired and the old Nostr "safety number" (out-of-band E2E
/// verification) is removed — messaging is server-readable under the
/// Cloudflare-native architecture, so that fingerprint no longer has meaning.
/// The network identity shown is the contact's AvaTOK number.
class ContactProfileScreen extends StatefulWidget {
  final String name;
  final String uid; // contact routing id (Clerk uid)
  final String? handle; // DEPRECATED; ignored
  final Identity? me;
  // [AVA-GRP-UI] Optional known photo URL so the profile popup shows the user's
  // actual picture instantly (e.g. a group member's avatar the chat already
  // resolved). Additive + backward compatible — existing callers pass nothing
  // and get the previous initials-then-directory-resolve behaviour. The
  // directory resolve below still refines/fills it when this is null.
  final String? avatarUrl;
  const ContactProfileScreen({super.key, required this.name, required this.uid, this.handle, this.me, this.avatarUrl});
  @override
  State<ContactProfileScreen> createState() => _ContactProfileScreenState();
}

class _ContactProfileScreenState extends State<ContactProfileScreen> {
  List<Group> _shared = [];
  String _number = '';
  String _email = '';

  // [AVA-TOGGLE-DM-1 / WS-17] Per-thread Ava mode ('off'|'assistant'|'companion').
  // Feature-detected: the section renders ONLY after a successful GET with
  // `enabled:true` (avaDmToggleEnabled on server-side), so while the flag is
  // dark this screen is pixel-identical to before.
  AvaDmState? _avaDm;
  bool _avaDmBusy = false;
  late String _name = widget.name;
  late String _avatarUrl = widget.avatarUrl ?? ''; // [AVA-GRP-UI] photo, refined below

  /// A name that is really just the raw routing id (e.g. "user_3FcSU…tojL") is
  /// no name at all — show a friendly label resolved from the saved contact or
  /// the directory instead of a wall of base-62. Empty / equal-to-id also count.
  static bool _looksLikeRawId(String name, String uid) {
    final n = name.trim();
    if (n.isEmpty) return true;
    if (n == uid) return true;
    if (n.startsWith('user_')) return true;
    // Shortened form the UI renders, e.g. "user_3FcSU…tojL".
    if (n.contains('…') && n.startsWith('user')) return true;
    return false;
  }

  @override
  void initState() {
    super.initState();
    final peerHex = widget.uid;
    if (peerHex.isNotEmpty) {
      GroupStore().load().then((groups) {
        if (mounted) setState(() => _shared = groups.where((g) => g.members.contains(peerHex)).toList());
      });
    }
    // If we were handed a raw id instead of a real name, recover one. Prefer the
    // user's OWN saved contact name (e.g. "JDee"), then the directory profile.
    if (_looksLikeRawId(widget.name, widget.uid)) {
      _recoverName();
    }
    // Resolve the contact's AvaTOK number for display (best-effort).
    // Seed number + email from the saved contact immediately (directory resolve
    // refines them). The saved contact usually already has the AvaTOK number, so
    // we show it right away instead of a raw "user_…" id.
    ContactsStore().load().then((cs) {
      final m = cs.where((c) => c.uid == widget.uid).toList();
      if (mounted && m.isNotEmpty) {
        setState(() {
          if (m.first.number.isNotEmpty) _number = m.first.number;
          if (m.first.email.isNotEmpty) _email = m.first.email;
          if (_avatarUrl.isEmpty && m.first.avatarUrl.isNotEmpty) _avatarUrl = m.first.avatarUrl;
        });
      }
    });
    // [AVA-TOGGLE-DM-1] Load my Ava mode for this 1:1. Needs both uids for the
    // deterministic conv id; silently skipped when either is unknown.
    final myUid = AccountScope.id ?? '';
    if (myUid.isNotEmpty && widget.uid.startsWith('user_') && myUid != widget.uid) {
      AvaDmApi.getState(dmConvIdFor(myUid, widget.uid)).then((s) {
        if (mounted && s != null && s.enabled) setState(() => _avaDm = s);
      });
    }
    Directory.resolve(widget.uid).then((c) {
      if (!mounted || c == null) return;
      setState(() {
        if (c.number.isNotEmpty) _number = c.number;
        if (c.email.isNotEmpty) _email = c.email;
        if (_avatarUrl.isEmpty && c.avatarUrl.isNotEmpty) _avatarUrl = c.avatarUrl;
        // Directory name is a fallback when no saved contact matched.
        if (_looksLikeRawId(_name, widget.uid) &&
            c.name.isNotEmpty && !_looksLikeRawId(c.name, widget.uid)) {
          _name = c.name;
        }
      });
    });
  }

  Future<void> _recoverName() async {
    try {
      final contacts = await ContactsStore().load();
      final match = contacts.where((c) => c.uid == widget.uid).toList();
      if (match.isNotEmpty && !_looksLikeRawId(match.first.name, widget.uid)) {
        if (mounted) setState(() => _name = match.first.name);
      }
    } catch (_) {/* best-effort — directory resolve still runs as a fallback */}
  }

  /// The big title: a real name when we have one, otherwise the AvaTOK number,
  /// and only as a last resort a neutral "AvaTOK user" — never a raw user_… id.
  String get _displayName {
    if (!_looksLikeRawId(_name, widget.uid)) return _name;
    if (_number.isNotEmpty) return _number;
    return 'AvaTOK user';
  }

  /// Deep link others can scan/click to add THIS contact by their AvaTOK number.
  /// Forward-compatible `?n=` form (the web landing + server add-by-number resolve
  /// it; non-installers are sent to the Play Store).
  String get _addLink {
    final digits = _number.replaceAll(RegExp(r'[^0-9+]'), '');
    return 'https://avatok.ai/add?n=${Uri.encodeQueryComponent(digits)}';
  }


  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      // [RAJ-INDIGO-1] The outer SafeArea is gone: `_header` now paints the band
      // above its own SafeArea so the pink reaches the status bar (pic 5). A
      // SafeArea out here would consume the inset first and re-open the cream
      // strip this change exists to close.
      body: Column(children: [
          _header(context),
          Expanded(
            child: ListView(padding: const EdgeInsets.all(Msg.s5), children: [
        // [RAJ-INDIGO-1] Petal ring (pic 5). Same construction as
        // `profile_screen.dart:642` — the petals are the `profileHero` SVG laid
        // BEHIND the avatar in a centred Stack, not a painter, so the two
        // screens can never drift apart. 156px art around a 96px avatar is the
        // ratio profile_screen uses; the avatar keeps its own 2px ink ring so it
        // still reads as a circle against the petals.
        Center(
          child: Stack(
            clipBehavior: Clip.none,
            alignment: Alignment.center,
            children: [
              SvgPicture.asset(Illustrations.profileHero,
                  width: 156, height: 156, fit: BoxFit.contain,
                  excludeFromSemantics: true),
              Container(
                decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(color: AD.borderAvatar, width: 2)),
                child: Avatar(seed: widget.uid, name: _displayName, size: 96,
                    avatarUrl: _avatarUrl.isEmpty ? null : _avatarUrl),
              ),
            ],
          ),
        ),
        const SizedBox(height: Msg.s3),
        Center(child: Text(_displayName, style: ADText.appTitle())),
        const SizedBox(height: Msg.s4),
        if (_number.isNotEmpty)
          _box('AvaTOK number', PhosphorIcons.hash(PhosphorIconsStyle.bold), AD.iconSearch,
              child: Row(children: [
            Expanded(
              // [DIALPAD-BIZ-CALLS] Tapping the number drops it into the dialpad,
              // ready to dial (not auto-dialed) — connects the friend channel
              // (this profile, met by email) to the business channel (their
              // AvaTOK number). Flag-gated; plain SelectableText when off.
              child: RemoteConfig.businessCallUx
                  ? GestureDetector(
                      onTap: () => openDialpadWithNumber(context, _number),
                      child: Text(_number,
                          style: ADText.rowName(c: AD.iconSearch)
                              .copyWith(decoration: TextDecoration.underline)),
                    )
                  : SelectableText(_number, style: ADText.rowName()),
            ),
            IconButton(
                icon: PhosphorIcon(PhosphorIcons.copy(PhosphorIconsStyle.bold), size: 18, color: AD.textPrimary),
                onPressed: () {
                  Clipboard.setData(ClipboardData(text: _number));
                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Copied')));
                }),
          ]))
        else
          // No shared AvaTOK number — show a friendly note, never the raw user_… id.
          _box('AvaTOK number', PhosphorIcons.hash(PhosphorIconsStyle.bold), AD.iconSearch,
              child: Text('This contact hasn’t shared an AvaTOK number yet.',
                  style: ADText.preview(c: AD.textSecondary))),
        if (_email.isNotEmpty) ...[
          const SizedBox(height: 12),
          _box('Email', PhosphorIcons.envelope(PhosphorIconsStyle.bold), AD.iconVideo,
              child: Row(children: [
            Expanded(child: SelectableText(_email, style: ADText.rowName())),
            IconButton(
                icon: PhosphorIcon(PhosphorIcons.copy(PhosphorIconsStyle.bold), size: 18, color: AD.textPrimary),
                onPressed: () {
                  Clipboard.setData(ClipboardData(text: _email));
                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Copied')));
                }),
          ])),
        ],
        if (_number.isNotEmpty) ...[
          const SizedBox(height: 16),
          _box('Add $_displayName on AvaTOK', PhosphorIcons.qrCode(PhosphorIconsStyle.bold), AD.online,
              child: Column(children: [
            // QR keeps a WHITE tile so the code stays scannable on the dark card.
            Center(child: Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                  color: AD.inputField,
                  borderRadius: Msg.brMd,
                  border: Border.all(color: AD.borderControl, width: 1)),
              child: QrImageView(data: _addLink, size: 150, backgroundColor: AD.inputField),
            )),
            const SizedBox(height: 12),
            _primaryButton(
              label: 'Share contact',
              icon: PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold),
              onPressed: () async {
                try {
                  await QrShare.share(link: _addLink, name: _displayName, number: _number);
                } catch (_) {
                  if (mounted) ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text("Couldn't prepare the QR image — try again.")));
                }
              }),
          ])),
        ],
        // [AVA-TOGGLE-DM-1 / WS-17] Per-thread Ava mode — rendered only when the
        // server said `enabled:true` (avaDmToggleEnabled), so this is invisible
        // until the owner flips the flag with a client build already out.
        if (_avaDm != null) ...[
          const SizedBox(height: Msg.s4),
          _avaDmSection(),
        ],
        const SizedBox(height: Msg.s4),
        Text('SHARED GROUPS', style: ADText.sectionLabel()),
        const SizedBox(height: Msg.s1),
        if (_shared.isEmpty)
          Padding(padding: const EdgeInsets.symmetric(vertical: 8),
              child: Text('No groups in common', style: ADText.preview(c: AD.textSecondary)))
        else
          for (final g in _shared)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Container(
                decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: AD.borderAvatar, width: 2)),
                child: Avatar(seed: 'group-${g.id}', name: g.name, size: 40),
              ),
              title: Text(g.name, style: ADText.rowName()),
              subtitle: Text('${g.members.length} members', style: ADText.preview(c: AD.textSecondary)),
            ),
            ]),
          ),
        ]),
    );
  }

  // ── [AVA-TOGGLE-DM-1 / WS-17] Ava-in-this-chat section ─────────────────────
  // Mirrors group_info_screen's _companionModeSection: three chips, same
  // vocabulary ('off'|'assistant'|'companion'). Differences that are the DM
  // contract, not style choices:
  //  * EITHER participant may change it (a DM has no admin) — chips are always
  //    tappable; the server writes MY row only.
  //  * `effective_mode` (min of both rows) is what governs the thread; when it
  //    differs from my own choice we say so WITHOUT attributing it to the peer
  //    (the GET deliberately never returns their row).
  //  * The peer-visible disclosure notice is posted by the SERVER as Ava on an
  //    effective change; nothing is posted from here.
  Widget _avaDmSection() {
    final s = _avaDm!;
    const modes = [
      ('off', 'Off'),
      ('assistant', 'Assistant'),
      ('companion', 'Companion'),
    ];
    return Container(
      padding: const EdgeInsets.all(Msg.s4),
      decoration: BoxDecoration(
        color: AD.card,
        borderRadius: BorderRadius.circular(AD.rListCard),
        border: Border.all(color: AD.borderCard, width: 1),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill), size: 16, color: AD.iconVideo),
          const SizedBox(width: 8),
          Text('Ava in this chat', style: ADText.rowName()),
        ]),
        const SizedBox(height: 4),
        Text(
          'Off: no observation. Assistant: Ava replies only when asked directly. '
          'Companion: Ava may quietly suggest things or occasionally join in — '
          'always clearly as Ava. Either of you can change this; Off on either '
          'side switches Ava off for both.',
          style: ADText.preview(),
        ),
        if (s.effectiveMode != s.mode) ...[
          const SizedBox(height: 4),
          Text(
            // Never attribute the difference to the peer — see the section doc.
            'Right now Ava is ${s.effectiveMode == 'off' ? 'off' : 'limited to "${s.effectiveMode}"'} in this chat.',
            style: ADText.preview(c: AD.textSecondary),
          ),
        ],
        const SizedBox(height: Msg.s2),
        Row(children: [
          for (final m in modes) ...[
            Expanded(child: _avaDmChip(m.$1, m.$2)),
            if (m != modes.last) const SizedBox(width: 8),
          ],
        ]),
      ]),
    );
  }

  Widget _avaDmChip(String value, String label) {
    final s = _avaDm!;
    final selected = s.mode == value;
    return GestureDetector(
      onTap: _avaDmBusy || selected ? null : () => _setAvaDmMode(value),
      child: Container(
        alignment: Alignment.center,
        padding: const EdgeInsets.symmetric(vertical: Msg.s3),
        decoration: BoxDecoration(
          color: selected ? AD.newGroup.withValues(alpha: 0.22) : AD.headerFooter,
          borderRadius: BorderRadius.circular(AD.rChip),
          border: Border.all(color: selected ? AD.newGroup : AD.borderControl, width: 1),
        ),
        child: Text(label, style: ADText.statCaption(c: selected ? AD.newGroup : AD.textSecondary)),
      ),
    );
  }

  Future<void> _setAvaDmMode(String mode) async {
    final conv = _avaDm?.conv ?? '';
    if (conv.isEmpty || _avaDmBusy) return;
    setState(() => _avaDmBusy = true);
    final next = await AvaDmApi.setMode(conv, mode);
    if (!mounted) return;
    setState(() {
      _avaDmBusy = false;
      if (next != null && next.enabled) _avaDm = next;
    });
    if (next == null) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Could not change Ava for this chat — please try again.')));
    }
    // Server already emits dm_ava_enabled/disabled with both emails; this is
    // the client-side interaction marker only.
    Analytics.capture('dm_ava_mode_tapped', {'mode': mode, 'ok': next != null});
  }

  /// Contact info header.
  ///
  /// [RAJ-INDIGO-1] Owner (pic 5): "can you decorate the top part like we have
  /// in pic 6 — where the profile photo has petals and where we have a border
  /// of flowers and pink colour all the way up." Pic 6 is the Profile screen,
  /// so this is deliberately built to the SAME recipe as
  /// `profile/profile_screen.dart:569-635` rather than an approximation of it:
  ///
  ///   * `AD.bandRani` fill, not `headerFooter` — the pink the owner pointed at.
  ///   * band Container OUTSIDE the `SafeArea` so the pink runs "all the way
  ///     up" through the status bar (this was also complaint pic 2 №1).
  ///   * 3px ink bottom border, and the `FlowerChainSeam` anchored to the
  ///     Stack's BOTTOM (not offset from the top) so the 30px daisy chain
  ///     straddles that border evenly on any device — the reason profile_screen
  ///     uses `Positioned(bottom: 0)` plus a `SizedBox(height: 15)` spacer.
  ///   * every foreground via `AD.onBand(band)`; rani is a DARK band.
  Widget _header(BuildContext context) {
    const band = AD.bandRani;
    final onBand = AD.onBand(band);
    return Stack(
      clipBehavior: Clip.none,
      children: [
        Column(children: [
          Container(
            padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s2, Msg.s4, Msg.s3),
            decoration: const BoxDecoration(
              color: band,
              border: Border(bottom: BorderSide(color: AD.borderHairline, width: 3)),
            ),
            child: SafeArea(
              bottom: false,
              child: Row(children: [
                GestureDetector(
                  onTap: () => Navigator.of(context).maybePop(),
                  child: Container(
                    width: 38, height: 38,
                    decoration: BoxDecoration(borderRadius: BorderRadius.circular(AD.rIconButton)),
                    child: Icon(PhosphorIcons.arrowLeft(PhosphorIconsStyle.bold),
                        size: 22, color: onBand),
                  ),
                ),
                const SizedBox(width: Msg.s1),
                Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                  Text('CONTACT', style: ADText.sectionLabel(c: onBand)),
                  const SizedBox(height: 1),
                  Text('Contact info', style: ADText.appTitle(c: onBand)),
                ]),
              ]),
            ),
          ),
          // Room for the lower half of the daisy chain to hang below the border.
          const SizedBox(height: 15),
        ]),
        const Positioned(left: 0, right: 0, bottom: 0, child: FlowerChainSeam()),
      ],
    );
  }

  /// Inline dark v2 primary (full-width) button — replaces ZineButton.
  Widget _primaryButton({required String label, required IconData icon, required VoidCallback onPressed}) =>
      GestureDetector(
        onTap: onPressed,
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: Msg.s5, vertical: Msg.s4),
          decoration: BoxDecoration(
            color: AD.primaryBadge,
            borderRadius: Msg.brMd,
          ),
          child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            Icon(icon, size: 17, color: AD.textPrimary),
            const SizedBox(width: Msg.s2),
            Text(label, style: ADText.rowName()),
          ]),
        ),
      );

  Widget _box(String label, IconData icon, Color accent, {required Widget child}) => Container(
        padding: const EdgeInsets.all(Msg.s4),
        decoration: BoxDecoration(
          color: AD.card,
          borderRadius: BorderRadius.circular(AD.rListCard),
          border: Border.all(color: AD.borderCard, width: 1),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            // Inline AD icon badge (accent-tinted fill + colored glyph).
            Container(
              width: 28, height: 28,
              decoration: BoxDecoration(
                color: accent.withValues(alpha: 0.18),
                borderRadius: BorderRadius.circular(AD.rChip),
              ),
              child: Icon(icon, size: 15, color: accent),
            ),
            const SizedBox(width: Msg.s2),
            Expanded(child: Text(label, style: ADText.sectionLabel())),
          ]),
          const SizedBox(height: Msg.s2),
          child,
        ]),
      );
}
