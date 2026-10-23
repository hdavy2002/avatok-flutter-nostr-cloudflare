import 'dart:async';

import 'package:flutter/material.dart';

import '../data/api_exception.dart';
import '../data/repos/safety_repo.dart';
import '../data/services.dart';
import 'desi.dart';
import 'screens/sheets.dart';
import 'theme.dart';

/// [HF-APP-PARITY-SAFETY] The "..." menu on another person's profile and on a call record: Report a person, and (only when there
/// is a call to point at) Block. The worker blocks by call, so a profile with no call offers Report only.

/// The "..." button. 48dp tap target.
class SafetyMenuButton extends StatelessWidget {
  const SafetyMenuButton({super.key, required this.profileName, this.callId, this.slug, this.repo, this.color});

  final String profileName;

  /// [HF-BLOCK-PROFILE-1] The person's page name, so a profile (no call) can still offer Block.
  final String? slug;

  /// The call this is about, or null on a profile.
  final String? callId;
  final SafetyRepo? repo;
  final Color? color;

  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        label: 'More: report or block',
        child: Tooltip(
          message: 'More',
          child: InkResponse(
            radius: 26,
            onTap: () => showSafetyMenu(context, profileName: profileName, callId: callId, slug: slug, repo: repo),
            child: SizedBox(width: 48, height: 48, child: Icon(Icons.more_horiz_rounded, color: color ?? C.maroon)),
          ),
        ),
      );
}

Future<void> showSafetyMenu(BuildContext context, {required String profileName, String? callId, String? slug, SafetyRepo? repo}) {
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: C.clear,
    isScrollControlled: true,
    builder: (sheetContext) => SheetFrame(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(profileName, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(20, color: C.maroon, w: FontWeight.w900)),
          const SizedBox(height: 8),
          _MenuRow(
            icon: Icons.flag_outlined,
            title: 'Report a person',
            sub: 'Tell our team what happened.',
            onTap: () {
              Navigator.of(sheetContext).pop();
              showReportSheet(context, profileName: profileName, callId: callId, repo: repo);
            },
          ),
          if ((callId != null && callId.isNotEmpty) || (slug != null && slug.isNotEmpty))
            _MenuRow(
              icon: Icons.block_rounded,
              title: 'Block',
              sub: 'They can\'t call or book you.',
              danger: true,
              onTap: () {
                Navigator.of(sheetContext).pop();
                showBlockSheet(context, profileName: profileName, callId: callId, slug: slug, repo: repo);
              },
            ),
        ]),
      ),
    ),
  );
}

class _MenuRow extends StatelessWidget {
  const _MenuRow({required this.icon, required this.title, required this.sub, required this.onTap, this.danger = false});
  final IconData icon;
  final String title;
  final String sub;
  final VoidCallback onTap;
  final bool danger;

  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 56),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Row(children: [
                Icon(icon, color: danger ? C.ruby : C.maroon),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(title, style: t(16, color: danger ? C.ruby : C.maroon, w: FontWeight.w900)),
                    Text(sub, style: t(14, color: C.muted, w: FontWeight.w700)),
                  ]),
                ),
              ]),
            ),
          ),
        ),
      );
}

Future<void> showReportSheet(BuildContext context, {required String profileName, String? callId, SafetyRepo? repo}) {
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: C.clear,
    isScrollControlled: true,
    builder: (_) => ReportSheet(profileName: profileName, callId: callId, repo: repo),
  );
}

Future<void> showBlockSheet(BuildContext context, {required String profileName, String? callId, String? slug, SafetyRepo? repo, VoidCallback? onBlocked}) {
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: C.clear,
    isScrollControlled: true,
    builder: (_) => BlockSheet(profileName: profileName, callId: callId, slug: slug, repo: repo, onBlocked: onBlocked),
  );
}

/// "Shikayat": pick a reason, add a note if you want, send. Ends on the reference number.
class ReportSheet extends StatefulWidget {
  const ReportSheet({super.key, required this.profileName, this.callId, this.repo});

  final String profileName;
  final String? callId;
  final SafetyRepo? repo;

  @override
  State<ReportSheet> createState() => _ReportSheetState();
}

class _ReportSheetState extends State<ReportSheet> {
  SafetyReason? _reason;
  final _note = TextEditingController();
  final _contact = TextEditingController();
  bool _busy = false;
  String? _error;
  ReportReceipt? _done;

  SafetyRepo get _repo => widget.repo ?? Services.instance.safetyRepo;

  /// The person's own email or number when the app knows it; otherwise the sheet asks.
  String? get _knownContact {
    final me = Services.instance.me;
    final e = me?.email;
    if (e != null && e.trim().length >= 3) return e.trim();
    final p = me?.phoneMasked;
    if (p != null && p.trim().length >= 3) return p.trim();
    return null;
  }

  @override
  void dispose() {
    _note.dispose();
    _contact.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final reason = _reason;
    if (reason == null || _busy) return;
    final contact = _knownContact ?? _contact.text.trim();
    if (contact.length < 3) {
      setState(() => _error = 'Please add your phone number or email so we can reach you.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await _repo.report(contact: contact, profile: widget.profileName, call: widget.callId ?? reportNoCall, reason: reason, note: _note.text);
      if (mounted) setState(() => _done = r);
    } catch (e) {
      if (mounted) setState(() => _error = e is ApiException ? e.userMessage : ApiException.genericText);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SheetFrame(
        child: Flexible(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
            child: _done != null ? _thanks(context, _done!) : _form(context),
          ),
        ),
      ),
    );
  }

  Widget _thanks(BuildContext context, ReportReceipt r) => Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Shukriya', style: t(14, color: C.tan, w: FontWeight.w900, ls: 1)),
        const SizedBox(height: 4),
        Semantics(header: true, child: Text('Report received', style: t(24, color: C.maroon, w: FontWeight.w900))),
        const SizedBox(height: 10),
        Text(r.message, style: t(16, color: C.deep, w: FontWeight.w700, h: 1.4)),
        const SizedBox(height: 20),
        _PrimaryBar(label: 'Done', onTap: () => Navigator.of(context).pop()),
      ]);

  Widget _form(BuildContext context) {
    final known = _knownContact != null;
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text('Shikayat', style: t(14, color: C.tan, w: FontWeight.w900, ls: 1)),
      const SizedBox(height: 4),
      Semantics(header: true, child: Text('Report ${widget.profileName}', maxLines: 2, overflow: TextOverflow.ellipsis, style: t(24, color: C.maroon, w: FontWeight.w900))),
      const SizedBox(height: 6),
      Text('What happened? Pick the closest one.', style: t(14, color: C.muted, w: FontWeight.w700)),
      const SizedBox(height: 8),
      for (final r in reportReasons)
        Semantics(
          inMutuallyExclusiveGroup: true,
          checked: _reason == r,
          child: InkWell(
            borderRadius: BorderRadius.circular(14),
            onTap: _busy ? null : () => setState(() => _reason = r),
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 48),
              child: Row(children: [
                Icon(_reason == r ? Icons.radio_button_checked_rounded : Icons.radio_button_unchecked_rounded, color: _reason == r ? C.rani : C.muted),
                const SizedBox(width: 12),
                Expanded(child: Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text(r.label, style: t(16, color: C.deep, w: FontWeight.w800)))),
              ]),
            ),
          ),
        ),
      const SizedBox(height: 8),
      TextField(
        controller: _note,
        enabled: !_busy,
        maxLength: reportNoteMax,
        maxLines: 3,
        textCapitalization: TextCapitalization.sentences,
        style: t(16, w: FontWeight.w700),
        decoration: const InputDecoration(labelText: 'Anything to add? (optional)'),
      ),
      if (!known) ...[
        const SizedBox(height: 8),
        TextField(
          controller: _contact,
          enabled: !_busy,
          maxLength: 200,
          keyboardType: TextInputType.emailAddress,
          style: t(16, w: FontWeight.w700),
          decoration: const InputDecoration(labelText: 'Your phone number or email'),
        ),
      ],
      if (_error != null)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Semantics(liveRegion: true, child: Text(_error!, style: t(14, color: C.ruby, w: FontWeight.w800))),
        ),
      const SizedBox(height: 8),
      _PrimaryBar(label: _busy ? 'Sending…' : 'Send report', onTap: _reason == null || _busy ? null : () => unawaited(_send())),
      const SizedBox(height: 10),
      Text('In danger right now? Call 112.', textAlign: TextAlign.center, style: t(14, color: C.muted, w: FontWeight.w700)),
    ]);
  }
}

/// Asks once, then blocks.
class BlockSheet extends StatefulWidget {
  const BlockSheet({super.key, required this.profileName, this.callId, this.slug, this.repo, this.onBlocked});

  final String profileName;

  /// Block by call (call records) or by [slug] (profile, [HF-BLOCK-PROFILE-1]); one of the two is given.
  final String? callId;
  final String? slug;
  final SafetyRepo? repo;
  final VoidCallback? onBlocked;

  @override
  State<BlockSheet> createState() => _BlockSheetState();
}

class _BlockSheetState extends State<BlockSheet> {
  bool _busy = false;
  String? _error;

  SafetyRepo get _repo => widget.repo ?? Services.instance.safetyRepo;

  Future<void> _block() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final callId = widget.callId;
      final slug = widget.slug;
      var key = '';
      if (callId != null && callId.isNotEmpty) {
        await _repo.block(callId);
      } else if (slug != null && slug.isNotEmpty) {
        key = await _repo.blockProfile(slug);
      } else {
        return;
      }
      if (!mounted) return;
      widget.onBlocked?.call();
      final messenger = ScaffoldMessenger.of(context);
      final repo = _repo;
      final name = widget.profileName;
      Navigator.of(context).pop();
      // [HF-BLOCK-PROFILE-1] Show it, and offer Unblock at once when the server gave us the key.
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(
          content: Text('$name is blocked.'),
          action: key.isEmpty
              ? null
              : SnackBarAction(
                  label: 'Unblock',
                  onPressed: () async {
                    try {
                      await repo.unblock(key);
                      messenger
                        ..hideCurrentSnackBar()
                        ..showSnackBar(SnackBar(content: Text('$name is unblocked.')));
                    } catch (e) {
                      messenger
                        ..hideCurrentSnackBar()
                        ..showSnackBar(SnackBar(content: Text(e is ApiException ? e.userMessage : ApiException.genericText)));
                    }
                  },
                ),
        ));
    } catch (e) {
      if (mounted) setState(() => _error = e is ApiException ? e.userMessage : ApiException.genericText);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return SheetFrame(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Semantics(header: true, child: Text('Block ${widget.profileName}?', maxLines: 2, overflow: TextOverflow.ellipsis, style: t(24, color: C.maroon, w: FontWeight.w900))),
          const SizedBox(height: 8),
          Text('They can\'t call or book you, and they leave your My Fraands.', style: t(16, color: C.deep, w: FontWeight.w700, h: 1.4)),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Semantics(liveRegion: true, child: Text(_error!, style: t(14, color: C.ruby, w: FontWeight.w800))),
            ),
          const SizedBox(height: 20),
          _PrimaryBar(label: _busy ? 'Blocking…' : 'Block', onTap: _busy ? null : () => unawaited(_block()), danger: true),
          const SizedBox(height: 8),
          DesiButton('Not now', kind: DesiButtonKind.ghost, expand: true, onTap: _busy ? null : () => Navigator.of(context).pop()),
        ]),
      ),
    );
  }
}

/// Full-width 56dp button, one-line label.
class _PrimaryBar extends StatelessWidget {
  const _PrimaryBar({required this.label, required this.onTap, this.danger = false});
  final String label;
  final VoidCallback? onTap;
  final bool danger;

  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        enabled: onTap != null,
        child: Material(
          color: onTap == null ? const Color(0xFFE8DDE6) : (danger ? C.ruby : C.maroon),
          shape: const StadiumBorder(),
          child: InkWell(
            customBorder: const StadiumBorder(),
            onTap: onTap,
            child: SizedBox(
              height: 56,
              child: Center(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(16, color: onTap == null ? C.muted : C.white, w: FontWeight.w900))),
            ),
          ),
        ),
      );
}
