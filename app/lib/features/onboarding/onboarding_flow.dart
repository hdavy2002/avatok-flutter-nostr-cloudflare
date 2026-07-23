import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/account_restore.dart';
import '../../core/admin_tools.dart';
import '../../core/analytics.dart';
import '../../core/app_registry.dart';
import '../../core/apps.dart';
import '../../core/ava_log.dart';
import '../../core/feature_flags.dart';
import '../../core/guest_session.dart';
import '../../core/onboarding_store.dart';
import '../../core/prefs_sync.dart';
import '../../core/profile_store.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../identity/identity.dart';
import '../ava_ai/ava_ai_setup.dart';
import '../avadial/avadial_channel.dart';
import '../avatok/contacts.dart';

/// The sign-up flow shown after Clerk auth on a fresh account. Starts by asking
/// what kind of account this is (Single / Parent / Enterprise) — that choice
/// unlocks the matching management tools in the sidebar.
class OnboardingFlow extends StatefulWidget {
  final VoidCallback onComplete;
  const OnboardingFlow({super.key, required this.onComplete});
  @override
  State<OnboardingFlow> createState() => _OnboardingFlowState();
}

class _OnboardingFlowState extends State<OnboardingFlow> {
  // Cloudflare-native pivot: the 'keys' step is GONE — signing in IS the
  // account; there is no user-facing key to save or recover.
  // Phase 1 (creator marketplace): the account-type step is flag-gated. When
  // kAccountTypeStepEnabled is false the flow starts at notifications and every
  // signup is AccountKind.personal. Step indices in analytics re-index with the
  // list, so onboarding_step_viewed/completed stay consistent.
  // 'add_ai' offers the BYO Gemini key flow (skippable). Both 'account_kind'
  // and 'add_ai' are flag-gated; step indices in analytics re-index with the
  // list so onboarding_step_viewed/completed stay consistent.
  // SUPER-SIMPLE onboarding (2026-06-19 redesign): the old 7–9 step flow drove
  // users away. After social sign-in the only in-flow steps are Terms then
  // Notifications. Welcome + login are separate stages in RootFlow (main.dart),
  // so the end-to-end experience is just: Welcome → Login → Terms → Notifications.
  // @handle is NO LONGER collected here — it's set in Profile, or just-in-time
  // when the user first enters AvaTok. The retired steps (account_kind, profile,
  // verify_identity, drive_backup, contacts, add_ai, apps) keep their builders in
  // this file but are no longer routed; apps default to the standard set in
  // _finish(), and contacts permission is now requested on demand at "add
  // contact" (not as an onboarding wall).
  // AVA-ONBOARD-2 → RETIRED 2026-07-16 (owner decision, PLAN-2026-07-16
  // receptionist/guardian doc): AvaTOK will no longer ask to become the Android
  // default dialer/SMS app — spam can't be filtered well enough as a default
  // handler, and carrier conditional call forwarding to the Vobiz voicemail line
  // is now the only voicemail path. [ONBOARD-STREAMLINE-1 2026-07-23] the
  // 'phone_roles' step and ALL its builders (_phoneRoles/_phoneResult/
  // _phonePreview/_makePhoneApp/_requestRoleAwait) are now DELETED, not just
  // unrouted — AvaTOK no longer requests ROLE_DIALER/ROLE_SMS anywhere.
  // [ONBOARD-STREAMLINE-1] (owner decision 2026-07-23): the scattered runtime
  // pop-ups are GONE. Onboarding is now 'terms' -> 'permissions' on every
  // platform. The 'notifications' ("Stay in the loop") page, the
  // 'voicemail_forwarding' ("Your Ava Voicemail box") page and the
  // 'phone_roles' ("Make AvaTOK your phone") page are all REMOVED — AvaTOK no
  // longer asks to become the default dialer/SMS app, and the single
  // consolidated 'permissions' page (see [_permissions]) requests every OS
  // permission the app actually needs up front, each with a plain-English
  // reason. Do NOT re-add 'phone_roles', 'notifications' or
  // 'voicemail_forwarding' without an explicit owner request.
  static List<String> _composeSteps() {
    return <String>['terms', 'permissions'];
  }
  static final List<String> _stepNames = _composeSteps();
  static final int _steps = _stepNames.length;
  int _step = 0;

  // ---- verification step (age / gender / phone / email) ----
  String? _ageGroup;
  String? _gender;

  final _idStore = IdentityStore();
  final _onb = OnboardingStore();
  final _profileStore = ProfileStore();
  final _kindStore = AccountKindStore();
  Identity? _id;

  // ---- account-type step (Single / Parent / Enterprise) ----
  // Defaults to personal when the step is disabled (kAccountTypeStepEnabled).
  AccountKind? _selectedKind = kAccountTypeStepEnabled ? null : AccountKind.personal;

  bool _agreedTerms = false;

  // ---- consolidated permissions step (ONBOARD-STREAMLINE-1) ----
  // Live grant status per row, keyed by the row id in [_permRows]. Probed once
  // in [_bootstrap] and refreshed after each request so the page reflects
  // anything already granted (re-onboarding, or enabled in system Settings).
  final Map<String, bool> _permGranted = <String, bool>{};
  bool _permBusy = false; // a request sequence is running

  // Standard-tier apps only (Phase 1): a signup ends with exactly the standard
  // apps — hidden-tier apps stay registered but are not offered or enabled.
  late Set<String> _enabled = kApps
      .where((a) => a.defaultOn && AppRegistry.isStandard(a.key))
      .map((a) => a.key)
      .toSet();

  // ---- profile step (first + last name; handles retired) ----
  final _lastCtrl = TextEditingController();
  final _handleCtrl = TextEditingController(); // DEPRECATED — handles retired
  final _nameCtrl = TextEditingController();
  Timer? _handleDebounce;
  // null = not yet checked; true/false = available or not. _handleMsg explains a false.
  bool? _handleAvail;
  bool _checkingHandle = false;
  String? _handleMsg;
  bool _savingProfile = false;

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  @override
  void dispose() {
    _handleDebounce?.cancel();
    _lastCtrl.dispose();
    _handleCtrl.dispose();
    _nameCtrl.dispose();
    super.dispose();
  }

  String? _guestHandle; // reserved pre-signup on the handle-claim screen (L0)
  // [AVA-IDGATE-1] _phoneAlreadyVerified removed — no phone verification exists.

  Future<void> _bootstrap() async {
    var id = await _idStore.load();
    id ??= await _idStore.createAndStore();
    if (mounted) setState(() => _id = id);
    // [ONBOARD-STREAMLINE-1] Probe every permission the consolidated page asks
    // for, so a row already granted (re-onboarding, or enabled in system
    // Settings) renders as "On" and is skipped by the "Allow all" sequence.
    // PushService.init still defers the notification ask until onboarding is
    // done (see the ordering contract there) — this page OWNS that single ask.
    unawaited(_refreshPermissionStatus());
    // [AVA-IDGATE-1] The isPhoneVerified() probe is gone with phone verification.
    // Handle-first onboarding: prefill the handle the visitor already reserved.
    final gh = await GuestSession.reservedHandle();
    if (gh != null && gh.isNotEmpty && mounted) {
      setState(() {
        _guestHandle = gh;
        _handleCtrl.text = gh;
        _handleAvail = true;
        _handleMsg = 'Reserved for you ✓';
      });
    }
    // Attach this person's whole onboarding journey to their uid.
    Analytics.identify(id.uid);
    Analytics.capture('onboarding_started', const {});
    Analytics.capture('onboarding_step_viewed', {'step_index': 0, 'step_name': _stepNames[0]});
  }

  void _onHandleChanged(String v) {
    _handleDebounce?.cancel();
    // Their own guest reservation always counts as available.
    if (_guestHandle != null && v.trim().toLowerCase().replaceAll('@', '') == _guestHandle) {
      setState(() { _checkingHandle = false; _handleAvail = true; _handleMsg = 'Reserved for you ✓'; });
      return;
    }
    setState(() { _handleAvail = null; _handleMsg = null; _checkingHandle = v.trim().isNotEmpty; });
    if (v.trim().isEmpty) { setState(() => _checkingHandle = false); return; }
    _handleDebounce = Timer(const Duration(milliseconds: 400), () async {
      final res = await Directory.checkHandle(_handleCtrl.text, uid: _id?.uid);
      if (!mounted) return;
      setState(() { _checkingHandle = false; _handleAvail = res.ok; _handleMsg = res.message; });
    });
  }

  bool get _profileReady =>
      _nameCtrl.text.trim().isNotEmpty && !_savingProfile;

  Future<void> _saveProfileAndNext() async {
    final id = _id;
    if (id == null || !_profileReady) return;
    setState(() => _savingProfile = true);
    // Handles are retired — collect first + last name. Display name = both joined.
    final first = _nameCtrl.text.trim();
    final last = _lastCtrl.text.trim();
    final name = [first, last].where((s) => s.isNotEmpty).join(' ').trim();
    // Personal email (from the verified sign-in) — stored so the QR contact card
    // and email discovery are complete from day one.
    final email = Analytics.currentEmail ?? '';
    // Persist locally first (merge with any phone/email captured earlier).
    final existing = await _profileStore.load();
    await _profileStore.save(existing.copyWith(displayName: name, email: email));
    // Merge any L0 guest reservation so it re-keys to this Clerk account.
    await GuestSession.upgradeIfAny();
    // Publish to the directory so the name + email are immediately searchable.
    final r = await Directory.registerProfile(
      uid: id.uid, name: name, firstName: first, lastName: last, email: email,
      accountKind: _selectedKind?.wire,
    );
    if (!mounted) return;
    setState(() => _savingProfile = false);
    if (r.ok) { _next(); return; }
    ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Could not save your profile — check your connection and try again')));
  }

  void _next() {
    Analytics.capture('onboarding_step_completed', {'step_index': _step, 'step_name': _stepNames[_step]});
    if (_step < _steps - 1) {
      setState(() => _step++);
      Analytics.capture('onboarding_step_viewed', {'step_index': _step, 'step_name': _stepNames[_step]});
    } else {
      _finish();
    }
  }

  Future<void> _finish() async {
    final kind = _selectedKind ?? AccountKind.personal;
    await _kindStore.set(kind);
    await _onb.setEnabledApps(_enabled);
    await _onb.setDone();
    PrefsSync.push(); // back up the new user's prefs to the cross-device vault
    final id = _id;
    if (id != null) {
      // Person properties so every chart can break down by account type, age, gender.
      Analytics.identify(id.uid, properties: {
        'account_kind': kind.wire,
        if (_ageGroup != null) 'age_group': _ageGroup!,
        if (_gender != null) 'gender': _gender!,
      });
    }
    Analytics.capture('onboarding_completed', {
      'account_kind': kind.wire,
      'apps_enabled': _enabled.toList(),
    });
    widget.onComplete();
  }

  @override
  Widget build(BuildContext context) {
    // RESPUI-2: resize for the keyboard so steps with text fields (profile)
    // never hide the input or the "Keep going" button beneath it.
    // RESPUI-3: horizontal gutter keys off ZineBreakpoints (tighter on <360dp).
    final hPad = ZineBreakpoints.pagePadding(context);
    return Scaffold(
      resizeToAvoidBottomInset: true,
      body: Container(
        color: AD.bg,
        child: SafeArea(
          child: Column(
            children: [
              Padding(
                padding: EdgeInsets.fromLTRB(hPad, 12, hPad, 4),
                child: Row(mainAxisAlignment: MainAxisAlignment.end, children: [
                  Row(mainAxisSize: MainAxisSize.min, children: [
                    for (var i = 1; i <= _steps; i++) ...[
                      Container(width: 9, height: 9, decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: i == _step + 1 ? AD.primaryBadge : AD.card,
                        border: Border.all(color: AD.borderControl, width: 1))),
                      const SizedBox(width: 7),
                    ],
                    const SizedBox(width: 4),
                    Text('STEP ${_step + 1} / $_steps', style: ADText.sectionLabel()),
                  ]),
                ]),
              ),
              Expanded(child: _body()),
            ],
          ),
        ),
      ),
    );
  }

  Widget _body() {
    // Dispatch by step NAME, not index — the list shrinks when the
    // account-type step is flag-disabled.
    switch (_stepNames[_step]) {
      case 'account_kind': return _accountType();
      case 'permissions': return _permissions();
      case 'terms': return _terms();
      case 'profile': return _profileStep();
      case 'contacts': return _contacts();
      case 'add_ai': return _addAiStep();
      default: return _appsSetup();
    }
  }

  // ---- Step: add AI (BYO Gemini key) — fully skippable ----
  Widget _addAiStep() => AvaAiSetupBody(
        onSaved: () {
          Analytics.capture('onboarding_ai_connected', const {});
          _next();
        },
        onSkip: () {
          Analytics.capture('onboarding_ai_skipped', const {});
          _next();
        },
      );

  // [AVA-IDGATE-1] _verifyStep() REMOVED (2026-07-10).
  //
  // Onboarding no longer contains a phone OTP step OR a liveness step. Signup is
  // Clerk and nothing else. The liveness check now happens JUST IN TIME — the first
  // time the user tries to do something PUBLIC (post, listing, comment, go live, DM
  // a stranger, post in a group, upload). See features/identity/public_action_gate.dart.
  //
  // Two reasons, and the second matters more:
  //   1. Nobody abandons signup over a camera they never see.
  //   2. A camera check weeks before an offence, during a signup the user has
  //      forgotten, deters nobody. The check immediately before the first public
  //      post is the deterrent. Friction belongs at the moment of intent.
  //
  // NOTE: 'verify_identity' was already absent from _composeSteps() before this
  // change — the step was unreachable dead code that still triggered an
  // isPhoneVerified() network call on every boot.

  // ---- Step 1: account type — required, drives the sidebar tools ----
  Widget _accountType() {
    // RESPUI (onboarding pass): hardcoded 24px gutter → ZineBreakpoints,
    // matching the pattern already used by _terms()/_notifications() in this
    // same file (tighter gutter on <360dp phones).
    final hPad = ZineBreakpoints.pagePadding(context);
    return Column(
      children: [
        Expanded(
          child: SingleChildScrollView(
            padding: EdgeInsets.fromLTRB(hPad, 12, hPad, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ZineIconBadge(
                    icon: PhosphorIcons.crownSimple(PhosphorIconsStyle.fill),
                    color: AD.iconSearch, size: 44),
                const SizedBox(height: 16),
                Text.rich(
                  TextSpan(children: [
                    const TextSpan(text: 'How will you '),
                    TextSpan(text: 'use', style: const TextStyle(color: AD.primaryBadge)),
                    const TextSpan(text: ' AvaTOK?'),
                  ]),
                  textAlign: TextAlign.left,
                  style: ADText.appTitle().copyWith(
                      fontSize: ZineBreakpoints.heroTextSize(context, regular: 28), height: 1.08),
                ),
                const SizedBox(height: 8),
                Text(
                    'This sets up your account. Parent and Business accounts unlock extra '
                    'management tools in the sidebar. You can change this later in Settings.',
                    style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 14.5)),
                const SizedBox(height: 22),
                _kindCard(
                  kind: AccountKind.personal,
                  icon: PhosphorIcons.user(PhosphorIconsStyle.bold),
                  color: AD.iconSearch,
                  title: 'Just me',
                  sub: 'A personal account with all the standard AvaVerse apps.',
                ),
                const SizedBox(height: 14),
                _kindCard(
                  kind: AccountKind.parent,
                  icon: PhosphorIcons.usersThree(PhosphorIconsStyle.bold),
                  color: AD.iconVideo,
                  title: 'Parent / family',
                  sub: 'Create and manage accounts for your kids — app controls, '
                      'contact approvals, screen time and safety alerts.',
                ),
                const SizedBox(height: 14),
                _kindCard(
                  kind: AccountKind.enterprise,
                  icon: PhosphorIcons.buildings(PhosphorIconsStyle.bold),
                  color: AD.online,
                  title: 'Business / enterprise',
                  sub: 'Provision accounts for your team — employees, teams & roles, '
                      'app grants, billing and an audit log.',
                ),
              ],
            ),
          ),
        ),
        Padding(
          padding: EdgeInsets.fromLTRB(hPad, 8, hPad, 20),
          child: _primary("Keep going", _selectedKind != null ? _next : null),
        ),
      ],
    );
  }

  Widget _kindCard({
    required AccountKind kind,
    required IconData icon,
    required Color color,
    required String title,
    required String sub,
  }) {
    final selected = _selectedKind == kind;
    return ZinePressable(
      onTap: () {
        setState(() => _selectedKind = kind);
        Analytics.capture('onboarding_account_kind_selected', {'account_kind': kind.wire});
      },
      color: selected ? AD.primaryBadge : AD.card,
      pressedColor: AD.primaryBadge,
      borderColor: selected ? AD.primaryBadge : AD.borderControl,
      borderWidth: 1,
      radius: BorderRadius.circular(Zine.rSm),
      boxShadow: const [],
      padding: const EdgeInsets.all(14),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        ZineIconBadge(icon: icon, color: color, size: 42),
        const SizedBox(width: 14),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ADText.threadName(c: selected ? Colors.white : AD.textPrimary).copyWith(fontSize: 18)),
            const SizedBox(height: 4),
            Text(sub, style: ADText.preview(c: selected ? Colors.white : AD.textSecondary).copyWith(fontSize: 12.5)),
          ]),
        ),
        const SizedBox(width: 8),
        PhosphorIcon(
          selected
              ? PhosphorIcons.checkCircle(PhosphorIconsStyle.fill)
              : PhosphorIcons.circle(PhosphorIconsStyle.bold),
          color: selected ? Colors.white : AD.textTertiary,
          size: 22,
        ),
      ]),
    );
  }

  // ---- Step 4: profile (handle + display name) — required ----
  Widget _profileStep() {
    // RESPUI (onboarding pass): match the ZineBreakpoints gutter/hero-size
    // pattern already used by _terms()/_notifications() in this file.
    final hPad = ZineBreakpoints.pagePadding(context);
    return Column(
      children: [
        Expanded(
          child: SingleChildScrollView(
            padding: EdgeInsets.fromLTRB(hPad, 12, hPad, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ZineIconBadge(
                    icon: PhosphorIcons.user(PhosphorIconsStyle.bold),
                    color: AD.primaryBadge, size: 44),
                const SizedBox(height: 16),
                Text.rich(
                  TextSpan(children: [
                    const TextSpan(text: 'Your '),
                    TextSpan(text: 'name', style: const TextStyle(color: AD.primaryBadge)),
                  ]),
                  textAlign: TextAlign.left,
                  style: ADText.appTitle().copyWith(
                      fontSize: ZineBreakpoints.heroTextSize(context, regular: 30), height: 1.08),
                ),
                const SizedBox(height: 8),
                Text('This is how you’ll appear to people you message. You can set a private AvaTOK number later in Settings.',
                    style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 14.5)),
                const SizedBox(height: 24),
                _field(
                  controller: _nameCtrl,
                  label: 'first name',
                  hint: 'e.g. Jordan',
                  leadIcon: PhosphorIcons.user(PhosphorIconsStyle.bold),
                  onChanged: (_) => setState(() {}),
                  textCapitalization: TextCapitalization.words,
                ),
                const SizedBox(height: 18),
                _field(
                  controller: _lastCtrl,
                  label: 'last name',
                  hint: 'e.g. Rivers',
                  leadIcon: PhosphorIcons.user(PhosphorIconsStyle.bold),
                  onChanged: (_) => setState(() {}),
                  textCapitalization: TextCapitalization.words,
                ),
              ],
            ),
          ),
        ),
        Padding(
          padding: EdgeInsets.fromLTRB(hPad, 8, hPad, 20),
          child: _primary(
            'Keep going',
            _profileReady ? _saveProfileAndNext : null,
            loading: _savingProfile,
          ),
        ),
      ],
    );
  }

  Widget _handleStatus() {
    if (_handleMsg != null) {
      return AdSticker(
        _handleMsg!,
        kind: _handleAvail == true ? AdStickerKind.ok : AdStickerKind.no,
        icon: _handleAvail == true
            ? PhosphorIcons.checkCircle(PhosphorIconsStyle.fill)
            : PhosphorIcons.xCircle(PhosphorIconsStyle.fill),
      );
    }
    if (_handleAvail == true) {
      return AdSticker(
        '@${_handleCtrl.text.trim().toLowerCase()} is available',
        kind: AdStickerKind.ok,
        icon: PhosphorIcons.checkCircle(PhosphorIconsStyle.fill),
      );
    }
    return AdSticker(
      '3–20 letters, numbers or _',
      kind: AdStickerKind.hint,
      icon: PhosphorIcons.pencilSimple(PhosphorIconsStyle.fill),
    );
  }

  Widget? _handleTrailing() {
    if (_checkingHandle) {
      return const SizedBox(width: 18, height: 18,
          child: CircularProgressIndicator(strokeWidth: 2.4, color: AD.iconSearch));
    }
    if (_handleAvail == true) {
      return PhosphorIcon(PhosphorIcons.checkCircle(PhosphorIconsStyle.fill),
          size: 20, color: AD.online);
    }
    if (_handleAvail == false) {
      return PhosphorIcon(PhosphorIcons.xCircle(PhosphorIconsStyle.fill),
          size: 20, color: AD.danger);
    }
    return null;
  }

  /// Zine-styled field that still supports inputFormatters (which the shared
  /// ZineField doesn't expose) — same chrome: ink border, 18px radius, hard
  /// shadow, lime lead cell, Nunito label, Nunito 800 input.
  Widget _field({
    required TextEditingController controller,
    required String hint,
    required ValueChanged<String> onChanged,
    String? label,
    String? leadText,
    IconData? leadIcon,
    Widget? trailing,
    bool error = false,
    List<TextInputFormatter>? inputFormatters,
    TextCapitalization textCapitalization = TextCapitalization.none,
  }) {
    final hasLead = leadText != null || leadIcon != null;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (label != null) ...[
        Text(label.toUpperCase(), style: ADText.sectionLabel(c: AD.textSecondary)),
        const SizedBox(height: 9),
      ],
      Container(
        decoration: BoxDecoration(
          color: AD.inputField,
          borderRadius: BorderRadius.circular(AD.rInput),
          border: Border.all(color: error ? AD.danger : AD.borderControl, width: 1),
        ),
        clipBehavior: Clip.antiAlias,
        child: Row(children: [
          if (hasLead)
            Container(
              width: 50,
              constraints: const BoxConstraints(minHeight: 56),
              decoration: const BoxDecoration(
                border: Border(right: BorderSide(color: Color(0x22000000), width: 1)),
              ),
              alignment: Alignment.center,
              child: leadText != null
                  ? Text(leadText,
                      style: const TextStyle(
                          fontFamily: ADText.family, fontWeight: FontWeight.w800,
                          fontSize: 20, color: AD.textOnInput))
                  : Icon(leadIcon, size: 20, color: AD.textOnInput),
            ),
          Expanded(
            child: TextField(
              controller: controller,
              onChanged: onChanged,
              inputFormatters: inputFormatters,
              textCapitalization: textCapitalization,
              // RESPUI-2: keep the focused field clear of the keyboard on short screens.
              scrollPadding: const EdgeInsets.all(80),
              cursorColor: AD.iconSearch,
              style: const TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w700,
                  fontSize: 15, color: AD.textOnInput),
              decoration: InputDecoration(
                hintText: hint,
                hintStyle: const TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w600,
                    fontSize: 15, color: AD.placeholderOnWhite),
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                filled: false,
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 16),
              ),
            ),
          ),
          if (trailing != null)
            Padding(
              padding: const EdgeInsets.only(right: 14),
              child: trailing,
            ),
        ]),
      ),
    ]);
  }

  // ---- Step: consolidated permissions (ONBOARD-STREAMLINE-1) ----
  // ONE page that asks up front for every OS permission AvaTOK actually needs,
  // each with a short plain-English reason — replacing the scattered runtime
  // pop-ups (notifications, "show calls on lock screen", contacts wall, …).
  // "Allow all" walks the list in order; a row already granted is skipped and
  // shows "On". Tapping a single row requests just that one. Nothing here asks
  // to become the default dialer/SMS app — that flow was removed.
  //
  // The "lock screen" row maps to the Android full-screen-intent grant (so an
  // incoming call rings full-screen while locked), NOT any dialer role. It is
  // launched via AvaDialChannel, whose method channel tolerates the platform
  // side being absent, so it stays a safe no-op off-Android / on older builds.
  List<_PermSpec> get _permRows => <_PermSpec>[
        _PermSpec('contacts', PhosphorIcons.addressBook(PhosphorIconsStyle.bold), AD.iconSearch,
            'Contacts', 'Find people you know who are already on AvaTOK and show real '
                'names on calls. We never upload your contacts.'),
        _PermSpec('notifications', PhosphorIcons.bell(PhosphorIconsStyle.bold), AD.primaryBadge,
            'Notifications', 'So you know when you get a call, a message, a new '
                'follower or a payout.'),
        if (Platform.isAndroid)
          _PermSpec('lockscreen', PhosphorIcons.lockKey(PhosphorIconsStyle.bold), AD.iconVideo,
              'Show calls on lock screen', 'So an incoming call rings full-screen '
                  'even when your phone is locked.'),
        _PermSpec('microphone', PhosphorIcons.microphone(PhosphorIconsStyle.bold), AD.danger,
            'Microphone', 'For voice and video calls and for recording voice notes.'),
        _PermSpec('camera', PhosphorIcons.camera(PhosphorIconsStyle.bold), AD.online,
            'Camera', 'For video calls and taking your profile photo.'),
        if (Platform.isAndroid)
          _PermSpec('phone_state', PhosphorIcons.phone(PhosphorIconsStyle.bold), AD.iconSearch,
              'Phone status', 'So AvaTOK can pause a call when a normal mobile call '
                  'comes in. AvaTOK is not your default phone app.'),
        if (Platform.isAndroid)
          _PermSpec('battery', PhosphorIcons.batteryCharging(PhosphorIconsStyle.bold), AD.primaryBadge,
              'Background activity', 'So your calls still ring when AvaTOK is running '
                  'in the background.'),
        _PermSpec('photos', PhosphorIcons.image(PhosphorIconsStyle.bold), AD.iconVideo,
            'Photos & media', 'To share photos and videos and to set your avatar.'),
      ];

  /// Best-effort status probe for one row (never requests a permission).
  Future<bool> _probeOne(String id) async {
    try {
      switch (id) {
        case 'contacts': return await Permission.contacts.isGranted;
        case 'notifications': return await Permission.notification.isGranted;
        case 'microphone': return await Permission.microphone.isGranted;
        case 'camera': return await Permission.camera.isGranted;
        case 'phone_state': return await Permission.phone.isGranted;
        case 'battery': return await Permission.ignoreBatteryOptimizations.isGranted;
        case 'photos': return await Permission.photos.isGranted;
        case 'lockscreen':
          if (!Platform.isAndroid) return true;
          return await AvaDialChannel.I.canUseFullScreenIntent();
      }
    } catch (_) {/* status probe is best-effort — never block onboarding */}
    return false;
  }

  /// Request one row's permission. Returns whether it ended up granted.
  Future<bool> _requestOne(String id) async {
    try {
      switch (id) {
        case 'contacts': return (await Permission.contacts.request()).isGranted;
        case 'notifications': return (await Permission.notification.request()).isGranted;
        case 'microphone': return (await Permission.microphone.request()).isGranted;
        case 'camera': return (await Permission.camera.request()).isGranted;
        case 'phone_state': return (await Permission.phone.request()).isGranted;
        case 'battery': return (await Permission.ignoreBatteryOptimizations.request()).isGranted;
        case 'photos': return (await Permission.photos.request()).isGranted;
        case 'lockscreen':
          if (!Platform.isAndroid) return true;
          // Full-screen-intent is a settings toggle, not a runtime dialog: if the
          // OS already honours it we're done, otherwise open the settings page and
          // re-read. We can only launch the page — never force the grant.
          if (await AvaDialChannel.I.canUseFullScreenIntent()) return true;
          await AvaDialChannel.I.requestFullScreenIntent();
          return await AvaDialChannel.I.canUseFullScreenIntent();
      }
    } catch (e) {
      AvaLog.I.warn('onboarding', 'permission request $id failed: $e');
    }
    return false;
  }

  /// Probe every row once so already-granted permissions render as "On" and are
  /// skipped by "Allow all".
  Future<void> _refreshPermissionStatus() async {
    for (final r in _permRows) {
      if (await _probeOne(r.id)) _permGranted[r.id] = true;
    }
    if (mounted) setState(() {});
  }

  /// Request every not-yet-granted permission in order.
  Future<void> _requestAllPermissions() async {
    if (_permBusy) return;
    setState(() => _permBusy = true);
    final sw = Stopwatch()..start();
    final rows = _permRows;
    for (final r in rows) {
      if (_permGranted[r.id] == true) continue;
      final ok = await _requestOne(r.id);
      if (ok) _permGranted[r.id] = true;
      if (mounted) setState(() {});
    }
    sw.stop();
    final granted = rows.where((r) => _permGranted[r.id] == true).length;
    if (mounted) setState(() => _permBusy = false);
    Analytics.uiInteraction('onboarding_permissions_request', sw.elapsedMilliseconds,
        phase: 'interactive',
        extra: {'granted': granted, 'total': rows.length});
    AvaLog.I.log('onboarding', 'permissions granted $granted/${rows.length}');
  }

  Future<void> _requestRow(_PermSpec r) async {
    if (_permBusy || _permGranted[r.id] == true) return;
    final ok = await _requestOne(r.id);
    if (ok) _permGranted[r.id] = true;
    if (mounted) setState(() {});
    Analytics.capture('onboarding_permission_row_tapped', {'id': r.id, 'granted': ok});
  }

  Widget _permissionRow(_PermSpec r) {
    final on = _permGranted[r.id] == true;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: (on || _permBusy) ? null : () => _requestRow(r),
      child: AdCard(
        radius: Zine.rSm,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          ZineIconBadge(icon: r.icon, color: r.color, size: 42),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(r.title, style: ADText.threadName().copyWith(fontSize: 15.5)),
              const SizedBox(height: 3),
              Text(r.reason, style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 12.5)),
            ]),
          ),
          const SizedBox(width: 10),
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: AdSticker(
              on ? 'On' : 'Allow',
              kind: on ? AdStickerKind.ok : AdStickerKind.hint,
              icon: on
                  ? PhosphorIcons.checkCircle(PhosphorIconsStyle.fill)
                  : PhosphorIcons.plusCircle(PhosphorIconsStyle.bold),
            ),
          ),
        ]),
      ),
    );
  }

  Widget _permissions() {
    final hPad = ZineBreakpoints.pagePadding(context);
    final rows = _permRows;
    final allGranted = rows.every((r) => _permGranted[r.id] == true);
    return Column(
      children: [
        Expanded(
          child: SingleChildScrollView(
            padding: EdgeInsets.fromLTRB(hPad, 12, hPad, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ZineIconBadge(
                    icon: PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill),
                    color: AD.online, size: 44),
                const SizedBox(height: 16),
                Text.rich(
                  TextSpan(children: [
                    const TextSpan(text: 'A few '),
                    TextSpan(text: 'permissions', style: const TextStyle(color: AD.primaryBadge)),
                  ]),
                  textAlign: TextAlign.left,
                  style: ADText.appTitle().copyWith(
                      fontSize: ZineBreakpoints.heroTextSize(context, regular: 28), height: 1.08),
                ),
                const SizedBox(height: 8),
                Text(
                    'AvaTOK asks for everything it needs once, here — with a reason for '
                    'each. You can change any of these later in Settings.',
                    style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 14.5)),
                const SizedBox(height: 20),
                for (final r in rows) ...[
                  _permissionRow(r),
                  const SizedBox(height: 12),
                ],
              ],
            ),
          ),
        ),
        Padding(
          padding: EdgeInsets.fromLTRB(hPad, 8, hPad, 20),
          child: allGranted
              ? _primary('Continue', _next)
              : Column(mainAxisSize: MainAxisSize.min, children: [
                  _primary('Allow all', _requestAllPermissions,
                      loading: _permBusy,
                      icon: PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold)),
                  const SizedBox(height: 12),
                  ZineLink('Continue', fontSize: 14,
                      onTap: _permBusy ? null : _next, underline: AD.iconSearch),
                ]),
        ),
      ],
    );
  }

  // ---- Step 2: terms ----
  Widget _terms() {
    const para = 'AvaTOK is your account for the whole AvaVerse — calls, chat, '
        'social, marketplace and storage in one place. Your account, profile and '
        'settings stay in sync on every device you sign in to.';
    final hPad = ZineBreakpoints.pagePadding(context);
    return Column(
      children: [
        Expanded(
          child: SingleChildScrollView(
            padding: EdgeInsets.fromLTRB(hPad, 12, hPad, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text.rich(
                  TextSpan(children: [
                    const TextSpan(text: 'Terms & '),
                    TextSpan(text: 'Conditions', style: const TextStyle(color: AD.primaryBadge)),
                  ]),
                  textAlign: TextAlign.left,
                  style: ADText.appTitle().copyWith(
                      fontSize: ZineBreakpoints.heroTextSize(context, regular: 30), height: 1.08),
                ),
                const SizedBox(height: 6),
                Text('PLEASE REVIEW BEFORE CONTINUING', style: ADText.sectionLabel(c: AD.textTertiary)),
                const SizedBox(height: 20),
                _termSection('1. Your Account', '$para $para'),
                _termSection('2. Content & Ownership', '$para $para'),
                _termSection('3. Payments & Payouts', para),
                _termSection('4. Backups', 'You can request a backup of your account data, delivered by email. '
                    'Media files (images and videos) are not included in account backups.'),
              ],
            ),
          ),
        ),
        Container(
          padding: EdgeInsets.fromLTRB(hPad, 14, hPad, 20),
          decoration: const BoxDecoration(
            color: AD.headerFooter,
            border: Border(top: BorderSide(color: AD.borderHairline, width: 1)),
          ),
          child: Column(
            children: [
              GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () => setState(() => _agreedTerms = !_agreedTerms),
                child: Row(children: [
                  Container(
                    width: 26, height: 26,
                    decoration: BoxDecoration(
                      color: _agreedTerms ? AD.primaryBadge : AD.card,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: _agreedTerms ? AD.primaryBadge : AD.borderControl, width: 1),
                    ),
                    child: _agreedTerms
                        ? PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold),
                            size: 15, color: Colors.white)
                        : null,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text('I have read and agree to the Terms & Conditions',
                        style: ADText.rowName().copyWith(fontSize: 14)),
                  ),
                ]),
              ),
              const SizedBox(height: 14),
              _primary('Keep going', _agreedTerms ? _next : null),
            ],
          ),
        ),
      ],
    );
  }

  Widget _termSection(String title, String body) => Padding(
        padding: const EdgeInsets.only(bottom: 18),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: ADText.threadName().copyWith(fontSize: 17)),
          const SizedBox(height: 6),
          Text(body, style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 13.5)),
        ]),
      );

  // ---- Step 5: contacts ----
  Widget _contacts() {
    // RESPUI-2: same Spacer-overflow fix as _notifications() — scrollable
    // column instead of fixed Spacers so this never clips on short screens.
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
      child: Column(children: [
        const SizedBox(height: 12),
        SizedBox(
          width: 74, height: 46,
          child: Stack(alignment: Alignment.center, children: [
            Positioned(left: 0, child: _dot(AD.iconSearch)),
            Positioned(right: 0, child: _dot(AD.iconVideo)),
            _dot(AD.danger, big: true),
          ]),
        ),
        const SizedBox(height: 22),
        Text.rich(
          TextSpan(children: [
            const TextSpan(text: 'Find people you '),
            TextSpan(text: 'know', style: const TextStyle(color: AD.primaryBadge)),
          ]),
          textAlign: TextAlign.center,
          style: ADText.appTitle().copyWith(fontSize: 28, height: 1.08),
        ),
        const SizedBox(height: 12),
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 300),
          child: Text(
              'Upload your contacts to instantly connect with friends already creating on AvaTOK. We never store your contacts.',
              textAlign: TextAlign.center, style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 14.5)),
        ),
        const SizedBox(height: 32),
        _primary('Find my people', () async {
          await Permission.contacts.request();
          // TODO: read + upload contacts in background once granted.
          _next();
        }, icon: PhosphorIcons.uploadSimple(PhosphorIconsStyle.bold)),
        const SizedBox(height: 14),
        ZineLink('skip for now', fontSize: 14, onTap: _next, underline: AD.iconSearch),
      ]),
    );
  }

  Widget _dot(Color c, {bool big = false}) => Container(
        width: big ? 30 : 24, height: big ? 30 : 24,
        decoration: BoxDecoration(
          color: c,
          shape: BoxShape.circle,
          border: Border.all(color: AD.borderControl, width: 2),
        ),
      );

  // ---- Step 6: app selection (standard-tier apps only) ----
  late final List<AppDef> _offeredApps =
      kApps.where((a) => AppRegistry.isStandard(a.key)).toList();

  Widget _appsSetup() {
    // RESPUI (onboarding pass): match the ZineBreakpoints gutter/hero-size
    // pattern already used by _terms()/_notifications() in this file.
    final hPad = ZineBreakpoints.pagePadding(context);
    return Column(
      children: [
        Padding(
          padding: EdgeInsets.fromLTRB(hPad, 12, hPad, 4),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text.rich(
              TextSpan(children: [
                const TextSpan(text: 'Set up your '),
                TextSpan(text: 'apps', style: const TextStyle(color: AD.primaryBadge)),
              ]),
              textAlign: TextAlign.left,
              style: ADText.appTitle().copyWith(
                  fontSize: ZineBreakpoints.heroTextSize(context, regular: 28), height: 1.08),
            ),
            const SizedBox(height: 6),
            Text('Toggle the AvaVerse apps you want. Change these anytime.',
                style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 14)),
          ]),
        ),
        Expanded(
          child: ListView.separated(
            padding: EdgeInsets.fromLTRB(hPad, 12, hPad, 8),
            itemCount: _offeredApps.length,
            separatorBuilder: (_, __) => const SizedBox(height: 12),
            itemBuilder: (c, i) {
              final a = _offeredApps[i];
              final on = _enabled.contains(a.key);
              const adAccents = [AD.iconSearch, AD.primaryBadge, AD.danger, AD.iconVideo, AD.online];
              return AdCard(
                radius: Zine.rSm,
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                child: Row(children: [
                  ZineIconBadge(icon: a.icon, color: adAccents[i % adAccents.length], size: 40),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(a.name, style: ADText.threadName().copyWith(fontSize: 16)),
                      const SizedBox(height: 2),
                      Text(a.tagline, maxLines: 1, overflow: TextOverflow.ellipsis,
                          style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 12)),
                    ]),
                  ),
                  const SizedBox(width: 8),
                  ZineToggle(
                    value: on,
                    onChanged: (v) => setState(() => v ? _enabled.add(a.key) : _enabled.remove(a.key)),
                  ),
                ]),
              );
            },
          ),
        ),
        Padding(
            padding: EdgeInsets.fromLTRB(hPad, 4, hPad, 20),
            child: _primary("Let's go", _finish)),
      ],
    );
  }

  // ---- shared bits ----
  Widget _primary(String text, VoidCallback? onTap, {IconData? icon, bool loading = false}) =>
      AdButton(
        label: text,
        onPressed: onTap,
        fullWidth: true,
        fontSize: 21,
        loading: loading,
        icon: icon ?? PhosphorIcons.arrowRight(PhosphorIconsStyle.bold),
        trailingIcon: icon == null,
      );
}

/// [ONBOARD-STREAMLINE-1] One row on the consolidated permissions page: a
/// permission id (see [_OnboardingFlowState._requestOne]/[_probeOne]), the
/// icon/colour to draw, and the short plain-English reason shown to the user.
class _PermSpec {
  final String id;
  final IconData icon;
  final Color color;
  final String title;
  final String reason;
  const _PermSpec(this.id, this.icon, this.color, this.title, this.reason);
}
