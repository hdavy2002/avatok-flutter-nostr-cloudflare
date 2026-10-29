import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../data/api_exception.dart';
import '../../../data/call_flags.dart'; // [HF-CALL-SAFETY-APP]
import '../../../data/intro_onboarding_draft.dart';
import '../../../data/models/intro_onboarding.dart';
import '../../../data/repos/intro_onboarding_repo.dart';
import '../../../data/services.dart';
import '../../../data/telemetry.dart';
import '../../theme.dart';
import '../../widgets.dart';
import '../availability_real.dart';
import '../call_rules.dart'; // [HF-CALL-SAFETY-APP]
import 'intro_onb_finish.dart';
import 'intro_onb_hints.dart';
import 'intro_onb_kit.dart';
import 'intro_onb_recorder.dart';
import 'intro_onb_steps.dart';

/// Which page of the flow is showing.
enum _V { loading, gate, loadError, categories, social, aadhaar, prep, profile, option, rules, sent, rejected, approved }

/// [HF-INTRO-A1] The influencer onboarding with an intro video (Specs/HF-INTRO-VIDEO-1.md), used while `hfIntroOnboardingEnabled` is on:
/// categories -> social media (optional) -> Aadhaar (only when needed) -> get ready -> recorder -> profile -> how to take calls -> sent.
/// Where she got to is kept on the phone per account, and everything else comes from `GET /api/hf/onboarding/me`, so she can leave and
/// come back to the same place.
class IntroOnboardingFlow extends StatefulWidget {
  const IntroOnboardingFlow({super.key, this.repo});

  final IntroOnboardingRepo? repo;

  @override
  State<IntroOnboardingFlow> createState() => _IntroOnboardingFlowState();
}

class _IntroOnboardingFlowState extends State<IntroOnboardingFlow> {
  late final IntroOnboardingRepo _repo = widget.repo ?? IntroOnboardingRepo(Services.instance.api);

  _V _v = _V.loading;
  OnbConfig? _config;
  OnbMe? _me;
  OnbApplication? _app;
  OnbVideo? _video;

  /// [HF-DESI-GAPS] The still of the video recorded in this visit (shown on "Sent for approval"); the server poster is used otherwise.
  Uint8List? _posterBytes;

  List<String> _cats = <String>[];
  String _lang = 'hi';
  String _topic = kTopicGeneral;
  String _option = 'B';
  String _name = '';
  String _about = '';
  int? _rate;
  int _retakeN = 0;
  bool _socialAsked = false;

  String? _notice;
  String? _error;
  String? _loadError;
  bool _busy = false;

  String? get _uid => Services.instance.user?.id;

  @override
  void initState() {
    super.initState();
    IntroOnbSession.active = true;
    unawaited(_load());
  }

  @override
  void dispose() {
    IntroOnbSession.active = false;
    super.dispose();
  }

  // ------------------------------------------------------------------------------------------------------------- rules

  bool get _hasSensitive => _cats.any(kSensitiveCategoryIds.contains);
  bool get _womenPicked => _cats.contains(kWomenToWomenId);
  bool get _live => _me?.host?.status == 'live';

  /// Her Aadhaar is verified and does not show Female.
  bool get _womenBlocked {
    final r = _me?.requirements;
    return r != null && r.aadhaarDone && r.aadhaarGender != 'F';
  }

  /// Spec D4: Aadhaar is needed when she has no verified social account, or picked a sensitive category.
  bool get _needsAadhaar {
    final r = _me?.requirements;
    if (r == null || r.aadhaarDone) return false;
    return _hasSensitive || !r.hasVerifiedSocial;
  }

  String get _aadhaarReason {
    if (_womenPicked) return 'you picked Women-to-Women';
    if (_hasSensitive) return 'you picked a category that needs an Aadhaar check';
    return 'you have not logged in to a social account';
  }

  List<String> get _orderedCats {
    final cfg = _config;
    if (cfg == null) return List<String>.of(_cats);
    return [for (final c in cfg.categories) if (_cats.contains(c.id)) c.id];
  }

  /// Takes Women-to-Women out of the picks when her Aadhaar does not show Female. True when it did.
  bool _dropWomenIfBlocked() {
    if (_womenPicked && _womenBlocked) {
      _cats = [for (final c in _cats) if (c != kWomenToWomenId) c];
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------------------------------------------------- loading

  Future<void> _load() async {
    if (!Services.instance.isSignedIn) {
      setState(() => _v = _V.gate);
      return;
    }
    setState(() {
      _v = _V.loading;
      _loadError = null;
    });
    try {
      final r = await Future.wait<Object?>(<Future<Object?>>[_repo.config(), _repo.me(), IntroOnbDraftStore.load(_uid)]);
      if (!mounted) return;
      final cfg = r[0] as OnbConfig;
      if (cfg.categories.isEmpty) {
        setState(() {
          _v = _V.loadError;
          _loadError = 'Categories are not available right now. Please try again in a little while.';
        });
        return;
      }
      _config = cfg;
      _me = r[1] as OnbMe;
      _applyLoaded(r[2] as IntroOnbDraft?);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _v = _V.loadError;
        _loadError = e.userMessage;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _v = _V.loadError;
        _loadError = ApiException.genericText;
      });
    }
  }

  void _applyLoaded(IntroOnbDraft? draft) {
    final cfg = _config!;
    final me = _me!;
    final host = me.host;
    final app = me.application;
    final known = cfg.categories.map((c) => c.id).toSet();

    _app = app;
    _video = me.video != null && me.video!.status == 'draft' ? me.video : null;
    _cats = [for (final c in (draft?.categories ?? const <String>[])) if (known.contains(c)) c];
    _lang = draft?.lang ?? app?.lang ?? 'hi';
    if (cfg.langs.isNotEmpty && !cfg.langs.contains(_lang)) _lang = cfg.langs.contains('hi') ? 'hi' : cfg.langs.first;
    _topic = draft?.topic ?? kTopicGeneral;
    _option = draft?.callOption ?? host?.callOption ?? app?.callOption ?? 'B';
    if (_option != 'A' && _option != 'B') _option = 'B';
    _name = (draft?.name.isNotEmpty ?? false) ? draft!.name : (host?.displayName ?? '');
    _about = (draft?.about.isNotEmpty ?? false) ? draft!.about : (host?.about ?? '');
    _rate = draft?.rate ?? host?.ratePerMin;
    _retakeN = draft?.retakeN ?? 0;
    _socialAsked = draft?.socialAsked ?? false;
    _fixTopic();

    if (app != null) {
      if (app.submitted) return _enter(_V.sent);
      if (app.approved) return _enter(_V.approved);
      if (app.rejected && draft == null) return _enter(_V.rejected);
    }

    final notice = _dropWomenIfBlocked() ? 'Your Aadhaar does not show Female, so Women-to-Women was unticked.' : null;
    if (_cats.isEmpty) return _goto(_V.categories, notice: notice);
    switch (draft?.step) {
      case 'social':
        _goto(_V.social, notice: notice);
      case 'aadhaar':
      case 'prep':
        _goto(_needsAadhaar ? _V.aadhaar : _V.prep, notice: notice);
      case 'profile':
        _goto(_video == null ? (_needsAadhaar ? _V.aadhaar : _V.prep) : _V.profile, notice: notice);
      case 'option':
        _goto(_video == null ? (_needsAadhaar ? _V.aadhaar : _V.prep) : _V.option, notice: notice);
      default:
        _goto(_V.categories, notice: notice);
    }
  }

  void _fixTopic() {
    if (_topic != kTopicGeneral && !_cats.contains(_topic)) _topic = kTopicGeneral;
  }

  // ------------------------------------------------------------------------------------------------------------ moving

  /// Shows a page that is not part of the draft (sent, rejected, approved).
  void _enter(_V v) {
    setState(() {
      _v = v;
      _error = null;
    });
    Telemetry.event('hf_onb_step_view', {'step': v.name});
  }

  void _goto(_V v, {String? notice}) {
    if (!mounted) return;
    setState(() {
      _v = v;
      _error = null;
      _notice = notice;
    });
    Telemetry.event('hf_onb_step_view', {'step': v.name});
    _saveDraft();
  }

  void _saveDraft() {
    switch (_v) {
      case _V.categories:
      case _V.social:
      case _V.aadhaar:
      case _V.prep:
      case _V.profile:
      case _V.option:
        unawaited(IntroOnbDraftStore.save(
          _uid,
          IntroOnbDraft(
            step: _v.name,
            categories: _cats,
            lang: _lang,
            topic: _topic,
            callOption: _option,
            name: _name,
            about: _about,
            rate: _rate,
            retakeN: _retakeN,
            socialAsked: _socialAsked,
          ),
        ));
      default:
        break;
    }
  }

  bool get _canPop {
    switch (_v) {
      case _V.loading:
      case _V.gate:
      case _V.loadError:
      case _V.categories:
      case _V.sent:
      case _V.rejected:
      case _V.approved:
        return true;
      default:
        return false;
    }
  }

  void _back() {
    if (_busy) return;
    switch (_v) {
      case _V.social:
        _goto(_V.categories);
      case _V.aadhaar:
        _goto(_V.social);
      case _V.prep:
        _goto(_V.social);
      case _V.profile:
        _goto(_V.prep);
      case _V.option:
        _goto(_V.profile);
      case _V.rules:
        _goto(_V.option);
      default:
        _leave();
    }
  }

  void _leave() {
    if (!mounted) return;
    if (context.canPop()) {
      context.pop();
    } else {
      context.go('/reels');
    }
  }

  Future<OnbMe?> _refreshMe() async {
    try {
      final m = await _repo.me();
      if (!mounted) return _me;
      setState(() {
        _me = m;
        if (_video == null && m.video != null && m.video!.status == 'draft') _video = m.video;
      });
      return m;
    } on ApiException {
      return _me;
    }
  }

  // ----------------------------------------------------------------------------------------------------------- categories

  void _toggle(OnbCategory c) {
    if (c.id == kWomenToWomenId && !_cats.contains(c.id) && _womenBlocked) {
      setState(() => _notice = 'Your Aadhaar does not show Female, so Women-to-Women is not open for you.');
      return;
    }
    setState(() {
      _notice = null;
      _cats = _cats.contains(c.id) ? [for (final x in _cats) if (x != c.id) x] : [..._cats, c.id];
      _fixTopic();
    });
    _saveDraft();
  }

  void _afterCategories() {
    Telemetry.event('hf_onb_categories', {'n': _cats.length, 'has_sensitive': _hasSensitive});
    if (_socialAsked) {
      _afterSocial();
    } else {
      _goto(_V.social);
    }
  }

  void _afterSocial() {
    _socialAsked = true;
    _goto(_needsAadhaar ? _V.aadhaar : _V.prep);
  }

  Future<void> _onAadhaarVerified() async {
    await _refreshMe();
    if (!mounted) return;
    if (_dropWomenIfBlocked()) {
      _fixTopic();
      if (_cats.isEmpty) {
        _goto(_V.categories, notice: 'Your Aadhaar does not show Female, so Women-to-Women is not open for you. Please pick another category.');
      } else {
        _goto(_V.prep, notice: 'Your Aadhaar does not show Female, so we unticked Women-to-Women. You can carry on with your other categories.');
      }
      return;
    }
    _goto(_V.prep);
  }

  // --------------------------------------------------------------------------------------------------------------- record

  Future<void> _openRecorder() async {
    final cfg = _config;
    if (cfg == null) return;
    Telemetry.event('hf_onb_step_view', {'step': 'record'});
    _saveDraft();
    final r = await Navigator.of(context).push<IntroRecorderResult>(
      MaterialPageRoute<IntroRecorderResult>(
        fullscreenDialog: true,
        builder: (_) => IntroRecorderScreen(
          repo: _repo,
          lang: _lang,
          topic: _topic,
          hints: hintFor(_topic, _lang).say,
          minSeconds: cfg.minSeconds,
          maxSeconds: cfg.maxSeconds,
          initialRetakes: _retakeN,
        ),
      ),
    );
    if (!mounted || r == null) return;
    _video = r.video;
    _posterBytes = r.poster;
    _retakeN = r.retakes;
    _goto(_V.profile);
  }

  // --------------------------------------------------------------------------------------------------------------- profile

  void _profileChanged(String name, String about, int? rate) {
    _name = name;
    _about = about;
    _rate = rate;
    _saveDraft();
  }

  Future<void> _openPhoto() async {
    if (_me?.host == null && !_live) {
      if (_name.trim().length < 2 || _about.trim().isEmpty) {
        setState(() => _error = 'Type your name and one line about you first, then add your photo.');
        return;
      }
      try {
        await _repo.saveProfile(live: false, name: _name.trim(), about: _about.trim(), rate: _rate ?? 20);
      } on ApiException catch (e) {
        if (mounted) setState(() => _error = e.userMessage);
        return;
      }
      await _refreshMe();
    }
    if (!mounted) return;
    setState(() => _error = null);
    await context.push<void>('/inf/photo');
    await _refreshMe();
  }

  Future<void> _saveProfileThenNext(String name, String about, int rate) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await _repo.saveProfile(live: _live, name: name, about: about, rate: rate);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.userMessage;
      });
      return;
    }
    _name = name;
    _about = about;
    _rate = rate;
    await _refreshMe();
    if (!mounted) return;
    setState(() => _busy = false);
    _goto(_V.option);
  }

  // ---------------------------------------------------------------------------------------------------------------- option

  Future<void> _openSlots() async {
    await Navigator.of(context).push<void>(MaterialPageRoute<void>(builder: (_) => const RealAvailabilityScreen()));
  }

  // ---------------------------------------------------------------------------------------------------------------- submit

  Future<void> _submit() async {
    if (_busy) return;
    final video = _video;
    if (video == null) {
      _goto(_V.prep, notice: 'Please record your intro video first.');
      return;
    }
    // [HF-INFLUENCER-GATE-1] Ask the server what is still missing first; the list is shown instead of sending a half-ready application.
    await Services.instance.refreshMe();
    if (!mounted) return;
    final stillMissing = <String>[
      for (final m in (Services.instance.me?.applicationMissing ?? const <String>[]))
        if (m != 'intro_video') m, // the video was just checked above (_video != null)
    ];
    if (stillMissing.isNotEmpty) {
      _showMissing(stillMissing);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    await _repo.setCallOption(_option);
    final cats = _orderedCats;
    final sensitive = _hasSensitive;
    try {
      final app = await _repo.submit(categories: cats, lang: _lang, videoId: video.id, callOption: _option, topic: _topic);
      Telemetry.event('hf_onb_submitted', {'n_categories': cats.length, 'has_sensitive': sensitive, 'call_option': _option, 'lang': _lang});
      await IntroOnbDraftStore.clear(_uid);
      unawaited(Services.instance.refreshMe());
      if (!mounted) return;
      setState(() {
        _busy = false;
        _app = app;
      });
      _enter(_V.sent);
    } on ApiException catch (e) {
      Telemetry.event('hf_onb_submit_refused', {'reason': e.code.isEmpty ? 'unknown' : e.code});
      await _refreshMe();
      if (!mounted) return;
      setState(() => _busy = false);
      _mapSubmitError(e);
    }
  }

  static String _missingText(String key) {
    switch (key) {
      case 'name':
        return 'your name';
      case 'description':
        return 'one line about you';
      case 'photo':
        return 'your photo';
      case 'rate':
        return 'your rate';
      default:
        return key;
    }
  }

  /// [HF-INFLUENCER-GATE-1] Plain words for the server's `missing` codes.
  static String _gateText(String code) {
    switch (code) {
      case 'profile_photo':
        return 'Add your photo';
      case 'cover_photo':
        return 'Add a cover photo';
      case 'whatsapp':
        return 'Verify your WhatsApp';
      case 'social_or_aadhaar':
        return 'Verify a social media account with enough followers, or verify Aadhaar';
      case 'aadhaar':
        return 'Verify Aadhaar';
      case 'intro_video':
        return 'Record your intro video';
      default:
        return code;
    }
  }

  /// Shows the missing items and opens the step that fixes the first one (photos and WhatsApp: the profile step; Aadhaar / social:
  /// the Aadhaar step; video: the get-ready step).
  void _showMissing(List<String> missing) {
    final text = 'Please finish these first:\n${missing.map((m) => '- ${_gateText(m)}').join('\n')}';
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text), duration: const Duration(seconds: 6)));
    if (missing.any((m) => m == 'social_or_aadhaar' || m == 'aadhaar')) {
      _goto(_V.aadhaar, notice: text);
    } else if (missing.contains('intro_video')) {
      _video = null;
      _goto(_V.prep, notice: text);
    } else {
      _goto(_V.profile);
      setState(() {
        _busy = false;
        _error = text;
      });
    }
  }

  void _mapSubmitError(ApiException e) {
    switch (e.code) {
      case 'application_incomplete':
        final raw = e.extra['missing'];
        final missing = raw is List ? [for (final m in raw) m.toString()] : <String>[];
        if (missing.isEmpty) {
          setState(() => _error = e.userMessage);
        } else {
          _showMissing(missing);
        }
      case 'aadhaar_required':
        _goto(_V.aadhaar, notice: 'We need your Aadhaar check before we can send this.');
      case 'women_to_women_requires_female':
        _cats = [for (final c in _cats) if (c != kWomenToWomenId) c];
        _fixTopic();
        _goto(_V.categories, notice: 'Women-to-Women is only for women, and your Aadhaar does not show Female. We unticked it. Pick your categories again.');
      case 'incomplete':
        final raw = e.extra['missing'];
        final missing = raw is List ? [for (final m in raw) m.toString()] : <String>[];
        if (missing.contains('whatsapp') && missing.length == 1) {
          setState(() => _error = 'Your WhatsApp number is not verified. Log out and log in with your WhatsApp number, then try again.');
        } else {
          final names = [for (final m in missing) if (m != 'whatsapp') _missingText(m)];
          _goto(_V.profile);
          setState(() => _error = names.isEmpty ? 'Please check your profile and try again.' : 'Please fill in: ${names.join(', ')}.');
        }
      case 'already_submitted':
        _enter(_V.sent);
      case 'video_not_found':
      case 'video_not_available':
        _video = null;
        _goto(_V.prep, notice: 'We could not use your video. Please record it again.');
      case 'invalid_field':
        final field = e.extra['field']?.toString();
        if (field == 'categories') {
          _goto(_V.categories, notice: 'Please check your categories and try again.');
        } else if (field == 'lang' || field == 'topic' || field == 'intro_video_id') {
          _goto(_V.prep, notice: 'Please check the language and your video, then try again.');
        } else {
          setState(() => _error = e.userMessage);
        }
      default:
        setState(() => _error = e.userMessage);
    }
  }

  void _fixAndSendAgain() {
    final app = _app;
    final cfg = _config;
    if (app != null && cfg != null) {
      final known = cfg.categories.map((c) => c.id).toSet();
      _cats = [for (final c in app.categories) if (known.contains(c.id)) c.id];
      if (app.lang != null) _lang = app.lang!;
      final opt = app.callOption;
      if (opt == 'A' || opt == 'B') _option = opt!;
      _fixTopic();
    }
    _socialAsked = false;
    _goto(_V.categories);
  }

  // ----------------------------------------------------------------------------------------------------------------- build

  Widget _plain(Widget child) => Scaffold(backgroundColor: C.page, body: SafeArea(child: child));

  Widget _message({required String title, required String body, required String button, required VoidCallback onTap}) {
    return _plain(
      Padding(
        padding: const EdgeInsets.all(24),
        child: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          OnbHero(title: title, subtitle: body, titleSize: 26),
          const SizedBox(height: 24),
          OnbPrimaryButton(label: button, onTap: onTap),
          OnbLinkButton(label: 'Go back', onTap: _leave),
        ]),
      ),
    );
  }

  Widget _page() {
    final cfg = _config;
    switch (_v) {
      case _V.loading:
        return _plain(const Center(child: CircularProgressIndicator(color: IO.pink)));
      case _V.gate:
        return _message(
          title: 'Log in to become an influencer',
          body: 'We need your account to save your video and profile.',
          button: 'Log in',
          onTap: () => unawaited(requireAccount(context, () => unawaited(_load()), reason: 'Log in to become an influencer')),
        );
      case _V.loadError:
        return _message(title: 'Could not open this', body: _loadError ?? ApiException.genericText, button: 'Try again', onTap: () => unawaited(_load()));
      case _V.categories:
        return OnbCategoriesStep(
          config: cfg!,
          selected: _cats,
          womenBlocked: _womenBlocked,
          notice: _notice,
          onToggle: _toggle,
          onNext: _afterCategories,
          onBack: _leave,
        );
      case _V.social:
        return OnbSocialStep(me: _me, onRefresh: _refreshMe, onNext: _afterSocial, onBack: _back);
      case _V.aadhaar:
        return OnbAadhaarStep(
          reason: _aadhaarReason,
          womenPicked: _womenPicked,
          whatsappVerified: _me?.requirements.whatsappVerified ?? false,
          onVerified: () => unawaited(_onAadhaarVerified()),
          onBack: _back,
        );
      case _V.prep:
        return OnbPrepStep(
          langs: cfg!.langs,
          categories: [for (final id in _orderedCats) if (cfg.byId(id) != null) cfg.byId(id)!],
          lang: _lang,
          topic: _topic,
          onLang: (v) {
            setState(() => _lang = v);
            _saveDraft();
          },
          onTopic: (v) {
            setState(() => _topic = v);
            _saveDraft();
          },
          onReady: () => unawaited(_openRecorder()),
          onBack: _back,
          notice: _notice,
          onKeep: _video == null ? null : () => _goto(_V.profile),
        );
      case _V.profile:
        return OnbProfileStep(
          name: _name,
          about: _about,
          rate: _rate,
          photoUrl: _me?.host?.photoUrl,
          locked: _live,
          busy: _busy,
          error: _error,
          onPhoto: () => unawaited(_openPhoto()),
          onChanged: _profileChanged,
          onNext: (n, a, r) => unawaited(_saveProfileThenNext(n, a, r)),
          onBack: _back,
        );
      case _V.option:
        return OnbOptionStep(
          selected: _option,
          busy: _busy,
          error: _error,
          onPick: (v) {
            setState(() => _option = v);
            _saveDraft();
          },
          onSlots: () => unawaited(_openSlots()),
          // [HF-CALL-SAFETY-APP] With call recording on, "Next" opens step 7 "Our call rules"; agreeing there sends the application.
          primaryLabel: CallFlags.callRecording ? 'Next' : 'Send for approval',
          onSubmit: () {
            if (CallFlags.callRecording) {
              _goto(_V.rules);
            } else {
              unawaited(_submit());
            }
          },
          onBack: _back,
        );
      case _V.rules:
        return OnbRulesStep(onBack: _back, onAgreed: () => unawaited(_submit()), busy: _busy, error: _error);
      case _V.sent:
        return OnbSentScreen(
          onHome: () => context.go('/reels'),
          posterBytes: _posterBytes,
          posterUrl: _video?.posterUrl ?? _me?.video?.posterUrl,
        );
      case _V.rejected:
        return OnbRejectedScreen(
          reasons: _app?.rejectReasons ?? const <OnbReason>[],
          note: _app?.rejectNote,
          onFix: _fixAndSendAgain,
          onHome: () => context.go('/reels'),
        );
      case _V.approved:
        return OnbApprovedScreen(onDashboard: () => context.go('/inf/home'));
    }
  }

  @override
  Widget build(BuildContext context) {
    return PopScope<Object?>(
      canPop: _canPop,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _back();
      },
      child: KeyedSubtree(key: ValueKey<_V>(_v), child: _page()),
    );
  }
}
