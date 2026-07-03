import 'package:flutter/material.dart';

import '../../../core/remote_config.dart';
import '../../../core/ui/zine.dart';
import '../../avatok/stranger_gate_api.dart';

/// STREAM B (SAFE-GATE-2) — the stranger safety gate action bar.
///
/// Rendered IN PLACE OF the composer when a thread's accept_state is `pending`
/// (a new thread from a non-contact). The message list stays scrollable above it;
/// there is no typing indicator, media is blurred (tap-to-reveal, handled in the
/// bubble via [StrangerGateBar.isPendingFor]) and link previews are suppressed.
///
/// Actions:
///   • Safety shield → POST /api/safety/score (STREAM G). >=0.8 → red "Likely
///     scam" banner with one-tap Block. A 404/error degrades to a soft note.
///   • Block        → block the sender, pop the thread.
///   • Report spam  → copy last 10 envelopes to spam_reports + block, pop.
///   • Accept       → restore the composer (parent rebuilds via [onAccepted]).
///
/// Replying while pending counts as an implicit Accept — the chat screen calls
/// [StrangerGateApi.accept] before sending; this bar is only the explicit path.
///
/// Hidden entirely when RemoteConfig.strangerGateEnabled is false (caller checks
/// [enabled] / [shouldGate]).
class StrangerGateBar extends StatefulWidget {
  /// The SERVER conv id (`dm_<lo>__<hi>`) — see dmConvIdFor.
  final String conv;

  /// The sender's uid (for block/report attribution); may be empty for groups.
  final String peerUid;

  /// Display name of the stranger (for the score banner copy).
  final String peerName;

  /// Called after a successful Accept so the parent restores the composer.
  final VoidCallback onAccepted;

  /// Called after Block/Report so the parent can pop the thread out of view.
  final VoidCallback onBlockedOrReported;

  const StrangerGateBar({
    super.key,
    required this.conv,
    required this.peerUid,
    required this.peerName,
    required this.onAccepted,
    required this.onBlockedOrReported,
  });

  /// Whether the feature is on at all (kill switch).
  static bool get enabled => RemoteConfig.strangerGateEnabled;

  @override
  State<StrangerGateBar> createState() => _StrangerGateBarState();

  /// One-shot shown-telemetry helper the parent calls when it first renders the
  /// gate for a conversation.
  static void trackShown(String conv, String peerUid) =>
      trackStrangerGate('stranger_gate_shown', {'conv': conv, 'peer': peerUid});
}

class _StrangerGateBarState extends State<StrangerGateBar> {
  bool _busy = false;
  SafetyScore? _score; // set after a Safety-shield tap
  bool _scored = false;

  Future<void> _accept() async {
    if (_busy) return;
    setState(() => _busy = true);
    await StrangerGateApi.accept(widget.conv);
    trackStrangerGate('stranger_gate_accept', {'conv': widget.conv, 'peer': widget.peerUid});
    if (!mounted) return;
    widget.onAccepted();
  }

  Future<void> _block() async {
    if (_busy) return;
    setState(() => _busy = true);
    await StrangerGateApi.block(conv: widget.conv, uid: widget.peerUid.isEmpty ? null : widget.peerUid);
    trackStrangerGate('stranger_gate_block', {'conv': widget.conv, 'peer': widget.peerUid});
    if (!mounted) return;
    widget.onBlockedOrReported();
  }

  Future<void> _report() async {
    if (_busy) return;
    setState(() => _busy = true);
    final id = await StrangerGateApi.report(conv: widget.conv, lastN: 10);
    trackStrangerGate('stranger_gate_report', {'conv': widget.conv, 'peer': widget.peerUid, 'ok': id != null});
    if (!mounted) return;
    widget.onBlockedOrReported();
  }

  Future<void> _shield() async {
    if (_busy) return;
    setState(() => _busy = true);
    final s = await StrangerGateApi.score(widget.conv);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _score = s;
      _scored = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    final scam = _score != null && _score!.available && _score!.score >= 0.8;
    return Container(
      decoration: BoxDecoration(
        color: Zine.paper,
        border: Border(top: BorderSide(color: Zine.ink, width: Zine.bw)),
      ),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        // ── result banner (after Safety shield) ─────────────────────────────
        if (_scored) _scoreBanner(scam),
        if (_scored) const SizedBox(height: 10),
        // ── explainer line ──────────────────────────────────────────────────
        Row(children: [
          const Icon(Icons.shield_outlined, size: 16, color: Zine.inkSoft),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              'This person is not in your contacts. Accept to reply, or block/report if it looks like spam.',
              style: ZineText.sub(size: 12.5, color: Zine.inkSoft),
            ),
          ),
        ]),
        const SizedBox(height: 10),
        // ── action row ──────────────────────────────────────────────────────
        Row(children: [
          _iconBtn(Icons.verified_user_outlined, 'Safety', Zine.blue, _busy ? null : _shield),
          const SizedBox(width: 8),
          _iconBtn(Icons.block, 'Block', Zine.lilac, _busy ? null : _block),
          const SizedBox(width: 8),
          _iconBtn(Icons.report_gmailerrorred_outlined, 'Report', Zine.coral, _busy ? null : _report),
          const SizedBox(width: 8),
          Expanded(child: _acceptBtn()),
        ]),
      ]),
    );
  }

  Widget _scoreBanner(bool scam) {
    if (_score != null && !_score!.available) {
      return _bannerShell(
        Zine.paper,
        Icons.info_outline,
        Zine.inkSoft,
        "Couldn't check this chat right now. Trust your instincts.",
        null,
      );
    }
    if (scam) {
      return _bannerShell(
        Zine.coral,
        Icons.warning_amber_rounded,
        Colors.white,
        'Likely scam — this chat scored high risk.',
        TextButton(
          onPressed: _busy ? null : _block,
          style: TextButton.styleFrom(foregroundColor: Colors.white),
          child: const Text('BLOCK'),
        ),
      );
    }
    return _bannerShell(
      Zine.mint,
      Icons.check_circle_outline,
      Zine.ink,
      'No strong scam signals — stay cautious with strangers.',
      null,
    );
  }

  Widget _bannerShell(Color bg, IconData icon, Color fg, String text, Widget? trailing) => Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(Zine.rSm),
          border: Zine.border,
          boxShadow: Zine.shadowXs,
        ),
        child: Row(children: [
          Icon(icon, size: 18, color: fg),
          const SizedBox(width: 8),
          Expanded(child: Text(text, style: ZineText.value(size: 13, color: fg))),
          if (trailing != null) trailing,
        ]),
      );

  Widget _iconBtn(IconData icon, String label, Color color, VoidCallback? onTap) => GestureDetector(
        onTap: onTap,
        child: Opacity(
          opacity: onTap == null ? 0.5 : 1,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Container(
              width: 48,
              height: 44,
              decoration: BoxDecoration(
                color: color,
                borderRadius: BorderRadius.circular(Zine.rSm),
                border: Zine.border,
                boxShadow: Zine.shadowXs,
              ),
              child: Icon(icon, size: 20, color: color == Zine.coral || color == Zine.blue ? Colors.white : Zine.ink),
            ),
            const SizedBox(height: 4),
            Text(label.toUpperCase(), style: ZineText.tag(size: 9, color: Zine.inkSoft)),
          ]),
        ),
      );

  Widget _acceptBtn() => GestureDetector(
        onTap: _busy ? null : _accept,
        child: Opacity(
          opacity: _busy ? 0.6 : 1,
          child: Container(
            height: 44,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: Zine.lime,
              borderRadius: BorderRadius.circular(Zine.rSm),
              border: Zine.border,
              boxShadow: Zine.shadowSm,
            ),
            child: _busy
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Zine.ink))
                : Text('ACCEPT', style: ZineText.button(size: 15, color: Zine.ink)),
          ),
        ),
      );
}
