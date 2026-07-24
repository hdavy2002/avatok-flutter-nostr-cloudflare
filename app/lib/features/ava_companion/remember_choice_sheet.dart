import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/account_storage.dart';
import '../../core/analytics.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine_widgets.dart';

/// [AVABRAIN-CLIENT-REC-1] The per-recording "Remember this in AvaBrain?"
/// choice (Product Bible §5.1 item 4): every recorded voice note/media clip
/// must carry an explicit user choice — Remember / Keep local only / the
/// account default — rather than silently always/never remembering.
///
/// STANDALONE WIDGET — mirrors `brain_export_sheet.dart`'s pattern exactly.
/// NOT wired into `chat_thread.dart` or `companion_thread.dart` (both
/// quarantined this batch; owned by other agents). See the integration note
/// at the bottom of this file for the exact call site + hook to add there.
Future<RememberChoiceResult?> showRememberChoiceSheet(
  BuildContext context, {
  String subtitle = 'Your voice note',
}) async {
  Analytics.uiInteraction('avabrain_remember_sheet_opened', 0);
  return showModalBottomSheet<RememberChoiceResult>(
    context: context,
    backgroundColor: AD.overlaySheet,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
        side: BorderSide(color: AD.borderHairline, width: 1),
        borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
    builder: (ctx) => _RememberChoiceSheet(subtitle: subtitle),
  );
}

/// Result of the sheet: [remember] is the EFFECTIVE decision for this clip
/// (already resolved against the account default if the user picked that
/// option); [setAsDefault] is true when the user also asked to stop being
/// asked, in which case the caller should NOT show this sheet again until
/// the user changes it in Settings (the default is persisted here either way,
/// this flag is informational for telemetry/UI only).
class RememberChoiceResult {
  final bool remember;
  final bool setAsDefault;
  const RememberChoiceResult({required this.remember, required this.setAsDefault});
}

/// Persists the per-account "account default" for the third sheet option, and
/// exposes it so a caller can skip the sheet entirely once the user has opted
/// to stop being asked (Settings can also expose this same toggle later).
class BrainRememberPref {
  static const _s = FlutterSecureStorage(
    mOptions: MacOsOptions(useDataProtectionKeyChain: false),
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );
  static const _key = 'avabrain_remember_default';
  // "Ask every time" until the user explicitly sets a default (Settings-level
  // opt-out semantics are for the master AvaBrain toggle in brain_consent.dart;
  // THIS is a narrower per-recording UX preference, so it stays neutral/unset
  // until the user picks "always do this").
  static const String _kUnset = '';

  /// null = no account default set yet (caller should keep asking each time).
  static Future<bool?> get() async {
    try {
      final raw = await readScoped(_s, _key);
      if (raw == null || raw == _kUnset) return null;
      return raw == '1';
    } catch (_) {
      return null;
    }
  }

  static Future<void> set(bool remember) async {
    try {
      await _s.write(key: scopedKey(_key), value: remember ? '1' : '0');
    } catch (_) {}
  }

  static Future<void> clear() async {
    try {
      await _s.delete(key: scopedKey(_key));
    } catch (_) {}
  }
}

class _RememberChoiceSheet extends StatefulWidget {
  final String subtitle;
  const _RememberChoiceSheet({required this.subtitle});

  @override
  State<_RememberChoiceSheet> createState() => _RememberChoiceSheetState();
}

class _RememberChoiceSheetState extends State<_RememberChoiceSheet> {
  bool _alwaysDoThis = false;
  bool? _accountDefault;
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    BrainRememberPref.get().then((v) {
      if (!mounted) return;
      setState(() {
        _accountDefault = v;
        _loaded = true;
      });
    });
  }

  Future<void> _choose(bool remember) async {
    if (_alwaysDoThis) await BrainRememberPref.set(remember);
    Analytics.uiInteraction('avabrain_remember_choice', 0, extra: {
      'remember': remember,
      'via': 'explicit',
      'set_as_default': _alwaysDoThis,
    });
    if (!mounted) return;
    Navigator.pop(context, RememberChoiceResult(remember: remember, setAsDefault: _alwaysDoThis));
  }

  Future<void> _chooseAccountDefault() async {
    // Default-safe fallback: if the account has never set one, treat as
    // "keep local only" — never remember without either an explicit tap or a
    // previously-confirmed default.
    final remember = _accountDefault ?? false;
    Analytics.uiInteraction('avabrain_remember_choice', 0, extra: {
      'remember': remember,
      'via': 'account_default',
      'had_default': _accountDefault != null,
    });
    if (!mounted) return;
    Navigator.pop(context, RememberChoiceResult(remember: remember, setAsDefault: false));
  }

  @override
  Widget build(BuildContext context) {
    final defaultLabel = _accountDefault == null
        ? 'not set yet — defaults to local only'
        : (_accountDefault == true ? 'Remember' : 'Keep local only');
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(20, 14, 20, 18 + MediaQuery.of(context).viewInsets.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            ZineIconBadge(icon: PhosphorIcons.brain(PhosphorIconsStyle.fill), color: AD.iconVideo, size: 40),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Remember this in AvaBrain?', style: ADText.threadName(c: AD.textPrimary)),
              Text(widget.subtitle, style: ADText.preview()),
            ])),
          ]),
          const SizedBox(height: 14),
          AdCard(
            color: AD.card,
            onTap: () => _choose(true),
            child: Row(children: [
              PhosphorIcon(PhosphorIcons.brain(PhosphorIconsStyle.bold), size: 20, color: AD.textPrimary),
              const SizedBox(width: 12),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Remember this in AvaBrain', style: ADText.rowName(c: AD.textPrimary)),
                Text('Ava can recall what was said in this clip later.', style: ADText.preview()),
              ])),
            ]),
          ),
          const SizedBox(height: 10),
          AdCard(
            color: AD.card,
            onTap: () => _choose(false),
            child: Row(children: [
              PhosphorIcon(PhosphorIcons.lockKey(PhosphorIconsStyle.bold), size: 20, color: AD.textPrimary),
              const SizedBox(width: 12),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Keep local only', style: ADText.rowName(c: AD.textPrimary)),
                Text('This clip is sent as usual; AvaBrain never sees it.', style: ADText.preview()),
              ])),
            ]),
          ),
          const SizedBox(height: 10),
          AdCard(
            color: AD.card,
            onTap: _loaded ? _chooseAccountDefault : null,
            child: Row(children: [
              PhosphorIcon(PhosphorIcons.gearSix(PhosphorIconsStyle.bold), size: 20, color: AD.textSecondary),
              const SizedBox(width: 12),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Use my account default', style: ADText.rowName(c: AD.textPrimary)),
                Text('Currently: $defaultLabel', style: ADText.preview()),
              ])),
            ]),
          ),
          const SizedBox(height: 12),
          Row(children: [
            SizedBox(
              width: 22, height: 22,
              child: Checkbox(
                value: _alwaysDoThis,
                onChanged: (v) => setState(() => _alwaysDoThis = v ?? false),
                fillColor: WidgetStateProperty.resolveWith((s) =>
                    s.contains(WidgetState.selected) ? AD.iconVideo : Colors.transparent),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                'Always do this — stop asking (Remember/Keep local only above becomes my account default)',
                style: ADText.preview(c: AD.textSecondary),
              ),
            ),
          ]),
        ]),
      ),
    );
  }
}

/// ── Integration note (for whoever owns chat_thread.dart's recorder) ─────────
///
/// `chat_thread.dart` is the ONLY place in the app that currently records and
/// uploads a voice note (`_recorder`/`AudioRecorder` at ~line 642, feeding
/// `MediaService.encryptAndUpload` + `MediaOutbox` around lines 5270-5481). It
/// is quarantined this batch, so this file does NOT touch it. To wire §5.1
/// item 4 in once that file is unlocked, at the point a voice note finishes
/// recording (the `_stopAndSendRecording`-style path, before or right after
/// the local bubble is queued into the outbox) add:
///
/// ```dart
/// import 'brain_media_client.dart' show BrainMediaClient; // ../../core/
/// import '../ava_companion/remember_choice_sheet.dart';
///
/// bool remember = false;
/// final savedDefault = await BrainRememberPref.get();
/// if (savedDefault == null) {
///   // no account default yet — ask (skip entirely for non-voice attachments
///   // if you only want this for voice notes, per §5.1's "recorder" scope).
///   final choice = await showRememberChoiceSheet(context, subtitle: 'Your voice note');
///   remember = choice?.remember ?? false;
/// } else {
///   remember = savedDefault; // account default — no prompt
/// }
///
/// // AFTER the local bubble renders and MediaOutbox.stage/markUploaded has
/// // already run for normal delivery (do not block on any of this):
/// if (remember) {
///   unawaited(() async {
///     final hash = BrainMediaClient.contentHash(plaintextBytes);
///     final decision = await BrainMediaClient.prepare(
///       contentHash: hash, mime: uploadCt, sizeBytes: plaintextBytes.length,
///       durationSec: recordedDurationSec, kind: 'audio',
///     );
///     if (!decision.allowed) return; // never surface as a failed send
///     final res = await BrainMediaClient.complete(
///       bytes: plaintextBytes, contentHash: hash, mime: uploadCt,
///       durationSec: recordedDurationSec, kind: 'audio',
///     );
///     // Optionally: BrainMediaStatusPoller(res.id).run() to surface a subtle
///     // "processing" badge on the bubble — never a blocking or error state.
///   }());
/// }
/// ```
///
/// `plaintextBytes` is the SAME bytes already passed into
/// `MediaService.encryptAndUpload` at chat_thread.dart:5310/5411 (captured
/// before encryption) — the AvaBrain leg reads the plaintext directly and
/// never touches the DM ciphertext/keys, matching §6.1 (device-private lane
/// stays on-device unless separately, explicitly exported).
