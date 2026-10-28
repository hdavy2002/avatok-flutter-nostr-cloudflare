import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../data/api_exception.dart';
import '../../../data/call_flags.dart';
import '../../../data/instagram_login.dart';
import '../../../data/models/intro_onboarding.dart';
import '../../../data/repos/intro_onboarding_repo.dart';
import '../../../data/services.dart';
import '../../../data/telemetry.dart';
import '../../../data/youtube_sign_in.dart';
import '../../theme.dart';
import 'intro_onb_hints.dart';
import 'intro_onb_kit.dart';

// ---------------------------------------------------------------------------------------------------------------- 1 Categories

/// Step 1 (design "Pick your categories"): multi-select chips from the server; the four that need an Aadhaar check sit apart at the end.
class OnbCategoriesStep extends StatelessWidget {
  const OnbCategoriesStep({
    super.key,
    required this.config,
    required this.selected,
    required this.womenBlocked,
    required this.notice,
    required this.onToggle,
    required this.onNext,
    required this.onBack,
  });

  final OnbConfig config;
  final List<String> selected;

  /// Her Aadhaar is already verified and does not show Female: Women-to-Women cannot be picked.
  final bool womenBlocked;

  /// A sentence from the flow (for example after Women-to-Women was unticked), or null.
  final String? notice;
  final void Function(OnbCategory) onToggle;
  final VoidCallback onNext;
  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    final normal = config.categories.where((c) => !c.sensitive).toList();
    final sensitive = config.categories.where((c) => c.sensitive).toList();
    final n = selected.length;
    return OnbScaffold(
      step: OnbStep.categories,
      eyebrow: 'Become an influencer',
      title: 'What can fans call you about?',
      subtitle: 'Pick one or more. You can change these later.',
      onBack: onBack,
      primaryLabel: n == 0 ? 'Pick at least one' : 'Next · $n picked',
      primaryEnabled: n > 0,
      onPrimary: onNext,
      error: null,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (notice != null) ...[
          OnbCard(color: IO.pinkWash, border: IO.pink, radius: 18, child: Text(notice!, style: t(15, color: IO.ink, w: FontWeight.w700, h: 1.45))),
          const SizedBox(height: 12),
        ],
        Wrap(spacing: 10, runSpacing: 10, children: [
          for (final c in normal) OnbChip(label: c.label, selected: selected.contains(c.id), onTap: () => onToggle(c)),
        ]),
        if (sensitive.isNotEmpty) ...[
          const SizedBox(height: 18),
          const Divider(height: 2, thickness: 2, color: IO.softLine),
          const SizedBox(height: 12),
          Text('These need an Aadhaar check', style: t(14, color: IO.muted, w: FontWeight.w800)),
          const SizedBox(height: 10),
          Wrap(spacing: 10, runSpacing: 10, children: [
            for (final c in sensitive)
              OnbChip(
                label: c.label,
                selected: selected.contains(c.id),
                soft: true,
                pinkOutline: c.id == kWomenToWomenId,
                onTap: () => onToggle(c),
              ),
          ]),
          const SizedBox(height: 10),
          Text(
            womenBlocked
                ? 'Your Aadhaar does not show Female, so Women-to-Women is not open for you.'
                : 'Women-to-Women is for women only — your Aadhaar must show Female.',
            style: t(14, color: IO.muted, w: FontWeight.w600, h: 1.45),
          ),
        ],
      ]),
    );
  }
}

// ------------------------------------------------------------------------------------------------- 2 Social media verification

/// Step 2 (design "Social media verification"): optional. YouTube, Instagram and (behind its flag) Facebook log in to prove the account is hers.
class OnbSocialStep extends StatefulWidget {
  const OnbSocialStep({super.key, required this.me, required this.onRefresh, required this.onNext, required this.onBack});

  final OnbMe? me;

  /// Reload `GET /api/hf/onboarding/me` in the flow (the verified accounts come from there). Answers the fresh data, or null when it failed.
  final Future<OnbMe?> Function() onRefresh;
  final VoidCallback onNext;
  final VoidCallback onBack;

  @override
  State<OnbSocialStep> createState() => _OnbSocialStepState();
}

class _OnbSocialStepState extends State<OnbSocialStep> with WidgetsBindingObserver {
  String? _busy; // platform whose login is starting
  String? _waiting; // platform whose browser login was opened
  String? _error;
  String? _note;
  bool _igOn = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    IntroOnbSession.socialReturn.addListener(_onReturn);
    unawaited(_probeInstagram());
  }

  @override
  void dispose() {
    IntroOnbSession.socialReturn.removeListener(_onReturn);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  Future<void> _probeInstagram() async {
    final on = await Services.instance.channelsRepo.instagramLoginEnabled();
    if (mounted) setState(() => _igOn = on);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _waiting != null) unawaited(widget.onRefresh());
  }

  static String _name(String platform) => platform == 'instagram' ? 'Instagram' : (platform == 'facebook' ? 'Facebook' : 'YouTube');

  void _onReturn() {
    final platform = IntroOnbSession.lastPlatform ?? '';
    final ok = IntroOnbSession.lastResult == 'connected';
    Telemetry.event('hf_onb_social_login', {'platform': platform, 'ok': ok});
    if (!mounted) return;
    setState(() {
      _waiting = null;
      _error = ok ? null : _reasonText(platform, IntroOnbSession.lastReason);
      _note = ok ? '${_name(platform)} is connected.' : null;
    });
    unawaited(widget.onRefresh());
  }

  static String _reasonText(String platform, String? reason) {
    switch (reason) {
      case 'cancelled':
        return 'You closed the login before it finished. Tap Log in to try again.';
      case 'no_page':
        return 'We could not find a Facebook Page on your account. Create a free Page, then try again.';
      case 'claimed':
        return 'That account is already linked to another person.';
      case 'limit_reached':
        return 'You have added the most accounts you can.';
      case 'not_enabled':
      case 'not_configured':
        return '${_name(platform)} login is not open yet. You can skip this step.';
      default:
        return 'We could not connect ${_name(platform)}. Please try again, or skip this step.';
    }
  }

  Future<void> _login(String platform) async {
    if (_busy != null) return;
    setState(() {
      _busy = platform;
      _error = null;
      _note = null;
    });
    try {
      if (platform == 'youtube') {
        await _youtube();
      } else {
        await _browser(platform);
      }
    } on YoutubeSignInCancelled {
      if (mounted) setState(() => _error = 'Sign-in was cancelled. Tap Log in to try again.');
    } on YoutubeSignInFailed catch (e) {
      if (mounted) setState(() => _error = e.message);
    } on ApiException catch (e) {
      Telemetry.event('hf_onb_social_login', {'platform': platform, 'ok': false});
      if (mounted) setState(() => _error = e.userMessage);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _youtube() async {
    final signIn = Services.instance.youtubeSignIn;
    final token = await signIn.accessToken();
    final check = await Services.instance.channelsRepo.connectYoutube(token);
    await signIn.signOut();
    final fresh = await widget.onRefresh();
    final ok = fresh?.social('youtube') != null;
    Telemetry.event('hf_onb_social_login', {'platform': 'youtube', 'ok': ok});
    if (!mounted) return;
    setState(() {
      if (ok) {
        _note = 'YouTube is connected.';
      } else {
        _error = check.message.isNotEmpty ? check.message : 'We could not verify that channel. You can skip this step.';
      }
    });
  }

  Future<void> _browser(String platform) async {
    final Uri url;
    var opened = false;
    if (platform == 'instagram') {
      url = await Services.instance.channelsRepo.instagramLoginUrl();
      opened = await const UrlLauncherInstagramLogin().open(url);
    } else {
      url = await IntroOnboardingRepo(Services.instance.api).facebookLoginUrl();
      try {
        opened = await launchUrl(url, mode: LaunchMode.inAppBrowserView);
      } catch (_) {
        opened = false;
      }
    }
    if (!mounted) return;
    setState(() {
      _waiting = opened ? platform : null;
      _error = opened ? null : 'We could not open ${_name(platform)}. Please try again.';
    });
  }

  Widget _row(String platform, Color tile, Widget glyph) {
    final s = widget.me?.social(platform);
    final verified = s != null;
    final working = _busy == platform;
    final waiting = _waiting == platform;
    final handle = s?.handle;
    final who = (handle == null || handle.isEmpty) ? '' : ' · ${handle.startsWith('@') ? handle : '@$handle'}';
    final followers = (s?.followers ?? 0) > 0 ? ' · ${_compact(s!.followers!)}' : '';
    return OnbCard(
      padding: const EdgeInsets.all(14),
      radius: 20,
      child: Row(children: [
        Container(width: 48, height: 48, decoration: BoxDecoration(color: tile, borderRadius: BorderRadius.circular(14)), alignment: Alignment.center, child: glyph),
        const SizedBox(width: 14),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(_name(platform), style: t(17, color: IO.ink, w: FontWeight.w900)),
            if (verified)
              Text('✓ Verified$who$followers', style: t(14, color: IO.ok, w: FontWeight.w700))
            else
              Text(waiting ? 'Finish logging in, then come back here' : 'Not added', style: t(14, color: IO.ink, w: FontWeight.w600, h: 1.3)),
          ]),
        ),
        if (!verified) ...[
          const SizedBox(width: 8),
          Semantics(
            button: true,
            label: 'Log in with ${_name(platform)}',
            onTap: working ? null : () => unawaited(_login(platform)),
            excludeSemantics: true,
            child: Opacity(
              opacity: working ? 0.6 : 1,
              child: Container(
                constraints: const BoxConstraints(minWidth: 74, minHeight: 48),
                decoration: BoxDecoration(color: IO.yellow, borderRadius: BorderRadius.circular(14), border: Border.all(color: IO.ink, width: 2.5)),
                child: Material(
                  color: C.clear,
                  child: InkWell(
                    borderRadius: BorderRadius.circular(11),
                    onTap: working ? null : () => unawaited(_login(platform)),
                    child: Center(
                      child: working
                          ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2.5, color: IO.ink))
                          : Padding(padding: const EdgeInsets.symmetric(horizontal: 14), child: Text('Log in', style: t(15, color: IO.ink, w: FontWeight.w900))),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ]),
    );
  }

  static String _compact(int n) {
    if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(n >= 10000000 ? 0 : 1)}M';
    if (n >= 1000) return '${(n / 1000).toStringAsFixed(n >= 10000 ? 0 : 1)}K';
    return '$n';
  }

  @override
  Widget build(BuildContext context) {
    final anyVerified = (widget.me?.socials ?? const <OnbSocial>[]).isNotEmpty;
    return OnbScaffold(
      step: OnbStep.social,
      eyebrow: 'Optional',
      title: 'Social media verification',
      subtitle: 'Log in to prove the account is yours. Fans see a small icon next to your name and can open your page.',
      onBack: widget.onBack,
      primaryLabel: 'Next',
      onPrimary: widget.onNext,
      secondaryLabel: anyVerified ? null : 'Skip — I don’t use social media',
      onSecondary: widget.onNext,
      error: _error,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        _row('youtube', IO.youtubeRed, const Icon(Icons.play_arrow_rounded, color: IO.white, size: 30)),
        if (_igOn) ...[const SizedBox(height: 12), _row('instagram', IO.pink, const Icon(Icons.photo_camera_rounded, color: IO.white, size: 26))],
        if (CallFlags.facebookLogin) ...[
          const SizedBox(height: 12),
          _row('facebook', IO.facebookBlue, Text('f', style: t(26, color: IO.white, w: FontWeight.w900))),
        ],
        if (_note != null) ...[const SizedBox(height: 12), Text(_note!, style: t(15, color: IO.ok, w: FontWeight.w800))],
        const SizedBox(height: 14),
        OnbDashed(
          color: IO.orange,
          fill: IO.cream,
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Text('No social media? That’s fine. We’ll ask for a quick Aadhaar check instead.', style: t(14, color: IO.ink, w: FontWeight.w600, h: 1.5)),
          ),
        ),
      ]),
    );
  }
}

// ------------------------------------------------------------------------------------------------------------- 3 Aadhaar

/// Step 3 (design "Verify with Aadhaar"): only shown when the server says it is needed. Native: the same `/api/hosts/kyc/aadhaar/*`
/// calls the Video KYC screen uses. The number is held in a field until the code is sent, then cleared; it is never logged or sent to telemetry.
class OnbAadhaarStep extends StatefulWidget {
  const OnbAadhaarStep({super.key, required this.reason, required this.womenPicked, required this.whatsappVerified, required this.onVerified, required this.onBack});

  /// Why it is needed, in plain words ("you picked Women-to-Women", "you have not logged in to a social account").
  final String reason;
  final bool womenPicked;
  final bool whatsappVerified;
  final VoidCallback onVerified;
  final VoidCallback onBack;

  @override
  State<OnbAadhaarStep> createState() => _OnbAadhaarStepState();
}

class _OnbAadhaarStepState extends State<OnbAadhaarStep> {
  final _aadhaar = TextEditingController();
  final _otp = TextEditingController();
  bool _consent = false;
  bool _sent = false;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _aadhaar.dispose();
    _otp.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final digits = _aadhaar.text.replaceAll(RegExp(r'\D'), '');
    if (digits.length != 12) {
      setState(() => _error = 'Type your 12-digit Aadhaar number.');
      return;
    }
    if (!_consent) {
      setState(() => _error = 'Please tick the box to agree.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final already = await Services.instance.spacesRepo.aadhaarOtp(digits, role: 'host');
      _aadhaar.clear();
      if (!mounted) return;
      if (already) {
        setState(() => _busy = false);
        widget.onVerified();
        return;
      }
      setState(() {
        _busy = false;
        _sent = true;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.extra['fallback'] == 'digilocker' ? 'We could not send the code right now. Please try again in a little while.' : e.userMessage;
      });
    }
  }

  Future<void> _verify() async {
    final otp = _otp.text.replaceAll(RegExp(r'\D'), '');
    if (otp.length != 6) {
      setState(() => _error = 'Type the 6-digit code.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await Services.instance.spacesRepo.aadhaarVerify(otp);
      _otp.clear();
      if (!mounted) return;
      setState(() => _busy = false);
      widget.onVerified();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        if (e.code == 'no_otp' || e.code == 'otp_expired') _sent = false;
        _error = e.userMessage;
      });
    }
  }

  InputDecoration _dec(String hint) => InputDecoration(
        hintText: hint,
        counterText: '',
        filled: true,
        fillColor: IO.white,
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 16),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: const BorderSide(color: IO.ink, width: 2.5)),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: const BorderSide(color: IO.pink, width: 2.5)),
        disabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: const BorderSide(color: IO.softLine, width: 2.5)),
      );

  Widget _label(String text) => Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(text, style: t(15, color: IO.ink, w: FontWeight.w800)));

  @override
  Widget build(BuildContext context) {
    return OnbScaffold(
      step: OnbStep.aadhaar,
      eyebrow: 'Quick ID check',
      title: 'Verify with Aadhaar',
      subtitle: 'Needed because ${widget.reason}. We get a code on your Aadhaar-linked phone. Your Aadhaar number is never shown to anyone.',
      onBack: widget.onBack,
      primaryLabel: _sent ? 'Verify' : 'Send code',
      primaryBusy: _busy,
      onPrimary: () => unawaited(_sent ? _verify() : _send()),
      error: _error,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (!widget.whatsappVerified) ...[
          OnbCard(
            color: IO.cream,
            border: IO.orange,
            radius: 18,
            child: Text('Your WhatsApp number is not verified yet. Log out and log in with your WhatsApp number to verify it, then come back.',
                style: t(14, color: IO.ink, w: FontWeight.w600, h: 1.5)),
          ),
          const SizedBox(height: 14),
        ],
        OnbCard(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            _label('Aadhaar number'),
            TextField(
              controller: _aadhaar,
              enabled: !_sent && !_busy,
              keyboardType: TextInputType.number,
              obscureText: true,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(12)],
              style: t(20, color: IO.ink, w: FontWeight.w800, ls: 0.1),
              decoration: _dec('12 digits'),
            ),
            const SizedBox(height: 14),
            _label('Code sent to your phone'),
            TextField(
              controller: _otp,
              enabled: _sent && !_busy,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
              style: t(20, color: IO.ink, w: FontWeight.w800, ls: 0.2),
              decoration: _dec('6 digits'),
            ),
            if (!_sent) ...[
              const SizedBox(height: 10),
              InkWell(
                onTap: _busy ? null : () => setState(() => _consent = !_consent),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: 48),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
                    Checkbox(value: _consent, activeColor: IO.pink, onChanged: _busy ? null : (v) => setState(() => _consent = v == true)),
                    Expanded(child: Text('I agree to use my Aadhaar once to verify who I am, and I am 18 or older.', style: t(14, color: IO.ink, w: FontWeight.w700, h: 1.4))),
                  ]),
                ),
              ),
            ] else
              TextButton(
                onPressed: _busy ? null : () => setState(() { _sent = false; _error = null; }),
                child: Text('Start again', style: t(15, color: IO.pink, w: FontWeight.w900)),
              ),
          ]),
        ),
        if (widget.womenPicked) ...[
          const SizedBox(height: 16),
          OnbCard(
            color: IO.pinkWash,
            border: IO.pink,
            radius: 18,
            padding: const EdgeInsets.all(14),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Container(width: 34, height: 34, decoration: const BoxDecoration(color: IO.pink, shape: BoxShape.circle), alignment: Alignment.center, child: Text('♀', style: t(18, color: IO.white, w: FontWeight.w900))),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  'Women-to-Women is only for women. If your Aadhaar doesn’t show Female, we’ll untick that category and you can carry on with the others.',
                  style: t(14, color: IO.ink, w: FontWeight.w600, h: 1.5),
                ),
              ),
            ]),
          ),
        ],
      ]),
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------- 4 Get ready

/// Step 4 (design "Get ready to record"): language, what the video is about, and ideas to say / avoid. Ends with "open camera".
class OnbPrepStep extends StatelessWidget {
  const OnbPrepStep({
    super.key,
    required this.langs,
    required this.categories,
    required this.lang,
    required this.topic,
    required this.onLang,
    required this.onTopic,
    required this.onReady,
    required this.onBack,
    this.notice,
    this.onKeep,
  });

  /// A sentence from the flow shown on top (for example why she is back here), or null.
  final String? notice;

  /// When she already has a recorded video on the server: "Use the video I already recorded" (null hides the link).
  final VoidCallback? onKeep;

  /// The language codes the server accepts.
  final List<String> langs;

  /// The categories she picked (id, label).
  final List<OnbCategory> categories;
  final String lang;
  final String topic;
  final ValueChanged<String> onLang;
  final ValueChanged<String> onTopic;
  final VoidCallback onReady;
  final VoidCallback onBack;

  Widget _bullets(List<String> lines) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        for (final l in lines)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('•  ', style: t(15, color: IO.ink, w: FontWeight.w800)),
              Expanded(child: Text(l, style: t(15, color: IO.ink, w: FontWeight.w600, h: 1.5))),
            ]),
          ),
      ]);

  Widget _topicTab(String id, String label) {
    final on = topic == id;
    return Semantics(
      button: true,
      selected: on,
      label: label,
      onTap: () => onTopic(id),
      excludeSemantics: true,
      child: Material(
        color: C.clear,
        child: InkWell(
          customBorder: const StadiumBorder(),
          onTap: () => onTopic(id),
          child: Container(
            constraints: const BoxConstraints(minHeight: 48),
            padding: const EdgeInsets.symmetric(horizontal: 14),
            alignment: Alignment.center,
            decoration: BoxDecoration(color: on ? IO.ink : IO.white, borderRadius: BorderRadius.circular(999), border: Border.all(color: IO.ink, width: 2.5)),
            child: Text(label, style: t(14, color: on ? IO.white : IO.ink, w: FontWeight.w800)),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final shown = langs.isEmpty ? kOnbLangs : kOnbLangs.where((l) => langs.contains(l.code)).toList();
    final hint = hintFor(topic, lang);
    final selectedLang = onbLang(lang);
    return OnbScaffold(
      step: OnbStep.prep,
      title: 'What is this video about?',
      titleSize: 27,
      onBack: onBack,
      primaryLabel: 'I’m ready — open camera',
      onPrimary: onReady,
      secondaryLabel: onKeep == null ? null : 'Use the video I already recorded',
      onSecondary: onKeep,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (notice != null) ...[
          OnbCard(color: IO.pinkWash, border: IO.pink, radius: 18, child: Text(notice!, style: t(15, color: IO.ink, w: FontWeight.w700, h: 1.45))),
          const SizedBox(height: 14),
        ],
        Text('Language you’ll speak in', style: t(14, color: IO.ink, w: FontWeight.w800)),
        const SizedBox(height: 6),
        Container(
          height: 52,
          padding: const EdgeInsets.symmetric(horizontal: 14),
          decoration: BoxDecoration(color: IO.white, borderRadius: BorderRadius.circular(14), border: Border.all(color: IO.ink, width: 2.5)),
          child: DropdownButtonHideUnderline(
            child: DropdownButton<String>(
              isExpanded: true,
              value: shown.any((l) => l.code == lang) ? lang : null,
              hint: Text(selectedLang.label, style: t(16, color: IO.ink, w: FontWeight.w800)),
              iconEnabledColor: IO.ink,
              dropdownColor: IO.white,
              style: t(16, color: IO.ink, w: FontWeight.w800),
              items: [for (final l in shown) DropdownMenuItem<String>(value: l.code, child: Text(l.label, style: t(16, color: IO.ink, w: FontWeight.w800)))],
              onChanged: (v) {
                if (v != null) onLang(v);
              },
            ),
          ),
        ),
        const SizedBox(height: 16),
        Wrap(spacing: 8, runSpacing: 8, children: [
          _topicTab(kTopicGeneral, 'General'),
          for (final c in categories) _topicTab(c.id, c.label),
        ]),
        const SizedBox(height: 14),
        OnbCard(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('You could say…', style: t(16, color: IO.pink, w: FontWeight.w900)),
            const SizedBox(height: 8),
            _bullets(hint.say),
          ]),
        ),
        const SizedBox(height: 12),
        OnbCard(
          color: IO.cream,
          border: IO.orange,
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Please avoid', style: t(16, color: IO.orangeInk, w: FontWeight.w900)),
            const SizedBox(height: 8),
            _bullets(hint.avoid),
          ]),
        ),
        if (!hasOwnHints(lang)) ...[
          const SizedBox(height: 10),
          Text(englishFallbackNote(selectedLang.english), textAlign: TextAlign.center, style: t(14, color: IO.muted, w: FontWeight.w700, h: 1.45)),
        ],
        const SizedBox(height: 12),
        Text('These are only ideas — say it in your own words.', textAlign: TextAlign.center, style: t(15, color: IO.ink, w: FontWeight.w800, h: 1.4)),
      ]),
    );
  }
}
