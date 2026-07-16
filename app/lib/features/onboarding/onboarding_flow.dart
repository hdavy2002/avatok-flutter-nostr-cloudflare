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
import '../../core/disk_cache.dart';
import '../../core/feature_flags.dart';
import '../../core/guest_session.dart';
import '../../core/onboarding_store.dart';
import '../../core/prefs_sync.dart';
import '../../core/profile_store.dart';
import '../../core/remote_config.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../identity/identity.dart';
import '../ava_ai/ava_ai_setup.dart';
import '../avadial/avadial_channel.dart';
import '../avadial/device_contacts.dart';
import '../avadial/pstn_forwarding_intro.dart';
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
  // is now the only voicemail path. The 'phone_roles' step is never added to the
  // flow anymore, so onboarding is byte-for-byte 'terms' → 'notifications' on
  // every platform. Its builders (_phoneRoles/_phoneResult/_phonePreview etc.)
  // are left in this file, unrouted, same pattern as the other retired steps
  // (account_kind, profile, verify_identity, drive_backup, contacts, add_ai,
  // apps) — do not re-add 'phone_roles' without an explicit owner request.
  // [AVA-RCPT-CONSENT-1] SAME DAY (owner decision): carrier voicemail
  // forwarding ships ON BY DEFAULT for every user, via informed consent
  // rather than silently. 'voicemail_forwarding' is that consent step for
  // NEW signups — see pstn_forwarding_intro.dart. Gated identically to the
  // rest of the AvaDial telecom surface (Android + avaDialer + pstnVoicemail,
  // same flags pstn_forwarding_setup.dart's Settings row uses) so onboarding
  // stays 'terms' -> 'notifications' only when the feature is dark. Existing
  // users who never went through onboarding are offered the same intro once,
  // post-login, from shell_v2.dart's startup wiring.
  static List<String> _composeSteps() {
    final steps = <String>['terms', 'notifications'];
    if (Platform.isAndroid && RemoteConfig.pstnVoicemail && RemoteConfig.avaDialer) {
      steps.add('voicemail_forwarding');
    }
    return steps;
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

  bool _notifEnabled = false;
  bool _agreedTerms = false;

  // ---- phone-roles step (AVA-ONBOARD-2) ----
  bool _phoneBusy = false;      // a role/permission request sequence is running
  bool _phoneResolved = false;  // sequence finished → show the per-capability result
  bool _phoneShownLogged = false; // onboarding_phone_step_shown fired once
  bool _showPhonePreview = false; // after roles, when the dialer role was granted
  bool? _dialerGranted;
  bool? _smsGranted;     // null when the SMS layer (avaSms) is off → row hidden
  bool? _contactsGranted;
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
    // AVA-ONBOARD-1: the onboarding "notifications" step OWNS the single OS
    // notification-permission ask (PushService.init defers it until onboarding is
    // done — see the ordering contract there). If the permission is somehow
    // already granted (re-onboarding, or the user enabled it in system Settings),
    // render the step as already-on so we never show a redundant second prompt.
    try {
      if (await Permission.notification.isGranted && mounted) {
        setState(() => _notifEnabled = true);
      }
    } catch (_) {/* status probe is best-effort — never block onboarding */}
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
      // AVA-ONBOARD-2: dedicated shown-event for the optional phone step (once).
      if (_stepNames[_step] == 'phone_roles' && !_phoneShownLogged) {
        _phoneShownLogged = true;
        Analytics.capture('onboarding_phone_step_shown', const {});
      }
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
      case 'notifications': return _notifications();
      case 'phone_roles': return _phoneRoles();
      case 'voicemail_forwarding': return _voicemailForwardingStep();
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

  // ---- Step 1: notifications ----
  Widget _notifications() {
    // RESPUI-2: was a fixed Column with Spacer()s sized for a tall screen —
    // on short screens / high textScale the CTA at the bottom got pushed off
    // or the layout overflowed. Now a scrollable column with fixed gaps, so
    // it compresses naturally and the button is always reachable by scrolling.
    final hPad = ZineBreakpoints.pagePadding(context);
    return SingleChildScrollView(
      padding: EdgeInsets.fromLTRB(hPad, 8, hPad, 24),
      child: Column(
        children: [
          const SizedBox(height: 12),
          Container(
            width: 116, height: 116,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: AD.card,
              border: Border.all(color: AD.borderControl, width: 1),
              boxShadow: AD.overlayShadow,
            ),
            child: Center(
              child: PhosphorIcon(
                  _notifEnabled
                      ? PhosphorIcons.bellRinging(PhosphorIconsStyle.fill)
                      : PhosphorIcons.bell(PhosphorIconsStyle.bold),
                  size: 46, color: AD.textPrimary),
            ),
          ),
          const SizedBox(height: 18),
          Text.rich(
            TextSpan(children: [
              const TextSpan(text: 'Stay in the '),
              TextSpan(text: 'loop', style: const TextStyle(color: AD.primaryBadge)),
            ]),
            textAlign: TextAlign.center,
            style: ADText.appTitle().copyWith(
                fontSize: ZineBreakpoints.heroTextSize(context, regular: 32), height: 1.08),
          ),
          const SizedBox(height: 12),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 300),
            child: Text(
                'Get notified when creators you follow post, when you earn a payout, or when someone tips your work.',
                textAlign: TextAlign.center, style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 14.5)),
          ),
          const SizedBox(height: 28),
          _featureRow(PhosphorIcons.heart(PhosphorIconsStyle.bold), AD.danger, 'New followers & tips'),
          const SizedBox(height: 12),
          _featureRow(PhosphorIcons.wallet(PhosphorIconsStyle.bold), AD.online, 'Payouts & wallet activity'),
          const SizedBox(height: 12),
          _featureRow(PhosphorIcons.chatCircle(PhosphorIconsStyle.bold), AD.iconSearch, 'Replies & mentions'),
          const SizedBox(height: 32),
          if (_notifEnabled)
            _primary('Keep going', _next)
          else ...[
            _primary('Turn on notifications', () async {
              await Permission.notification.request();
              if (Platform.isAndroid) {
                try { await Permission.ignoreBatteryOptimizations.request(); } catch (_) {}
              }
              setState(() => _notifEnabled = true);
            }, icon: PhosphorIcons.bell(PhosphorIconsStyle.bold)),
            const SizedBox(height: 14),
            ZineLink('not now', fontSize: 14, onTap: _next, underline: AD.iconSearch),
          ],
        ],
      ),
    );
  }

  // ---- Step: voicemail forwarding consent (AVA-RCPT-CONSENT-1) — OPTIONAL ----
  // Embeds the SAME explainer/CTA body the existing-user re-offer route uses
  // (pstn_forwarding_intro.dart) — do not re-implement the dial sequence or
  // the "3 circumstances" copy here. onFinished == _next: Continue (after the
  // three carrier codes are dialed) and "Not now" both just advance the flow,
  // exactly like every other skippable onboarding step in this file.
  Widget _voicemailForwardingStep() => PstnForwardingIntroBody(onFinished: _next);

  // ---- Step: make AvaTOK your phone (AVA-ONBOARD-2) — OPTIONAL ----
  // Only reachable on Android with shellV2 + avaDialer on (see _composeSteps).
  // Pitches AvaTOK as the default dialer + Messages app + AI contact book. The
  // primary button sequentially requests ROLE_DIALER, then ROLE_SMS (if avaSms),
  // then contacts permission — each independent; the user proceeds either way.
  // 'not now' skips all. All work goes through AvaDialChannel / DeviceContacts —
  // the SAME native path the AvaDial in-app banners use, so the banners remain the
  // retry route for anyone who declines here.
  Widget _phoneRoles() {
    if (_showPhonePreview) return _phonePreview();
    if (_phoneResolved) return _phoneResult();
    final hPad = ZineBreakpoints.pagePadding(context);
    return SingleChildScrollView(
      padding: EdgeInsets.fromLTRB(hPad, 8, hPad, 24),
      child: Column(
        children: [
          const SizedBox(height: 12),
          Container(
            width: 116, height: 116,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: AD.card,
              border: Border.all(color: AD.borderControl, width: 1),
              boxShadow: AD.overlayShadow,
            ),
            child: Center(
              child: PhosphorIcon(PhosphorIcons.deviceMobile(PhosphorIconsStyle.fill),
                  size: 46, color: AD.textPrimary),
            ),
          ),
          const SizedBox(height: 18),
          Text.rich(
            TextSpan(children: [
              const TextSpan(text: 'Make AvaTOK your '),
              TextSpan(text: 'phone', style: const TextStyle(color: AD.primaryBadge)),
            ]),
            textAlign: TextAlign.center,
            style: ADText.appTitle().copyWith(
                fontSize: ZineBreakpoints.heroTextSize(context, regular: 32), height: 1.08),
          ),
          const SizedBox(height: 12),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 320),
            child: Text(
                'Set AvaTOK as your default dialer and your Messages app — send & '
                'receive SMS with AI spam filtering — plus an AI-powered contact book.',
                textAlign: TextAlign.center, style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 14.5)),
          ),
          const SizedBox(height: 28),
          _featureRow(PhosphorIcons.phone(PhosphorIconsStyle.bold), AD.iconSearch,
              'A smarter dialer with spam protection'),
          const SizedBox(height: 12),
          _featureRow(PhosphorIcons.chatCircle(PhosphorIconsStyle.bold), AD.iconVideo,
              'SMS with an AI spam filter'),
          const SizedBox(height: 12),
          _featureRow(PhosphorIcons.addressBook(PhosphorIconsStyle.bold), AD.online,
              'An AI-powered contact book'),
          const SizedBox(height: 12),
          _featureRow(PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold), AD.danger,
              'Community-powered caller ID'),
          const SizedBox(height: 32),
          _primary('Make AvaTOK my phone app', _makePhoneApp,
              icon: PhosphorIcons.deviceMobile(PhosphorIconsStyle.bold), loading: _phoneBusy),
          const SizedBox(height: 14),
          ZineLink('not now', fontSize: 14, onTap: _phoneBusy ? null : _skipPhoneRoles, underline: AD.iconSearch),
        ],
      ),
    );
  }

  // Compact per-capability result — shown after the request sequence. The user
  // continues regardless of what they granted.
  Widget _phoneResult() {
    final hPad = ZineBreakpoints.pagePadding(context);
    final dialerOk = _dialerGranted == true;
    return SingleChildScrollView(
      padding: EdgeInsets.fromLTRB(hPad, 8, hPad, 24),
      child: Column(
        children: [
          const SizedBox(height: 12),
          Container(
            width: 116, height: 116,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: AD.card,
              border: Border.all(color: AD.borderControl, width: 1),
              boxShadow: AD.overlayShadow,
            ),
            child: Center(
              child: PhosphorIcon(PhosphorIcons.checkCircle(PhosphorIconsStyle.fill),
                  size: 46, color: AD.textPrimary),
            ),
          ),
          const SizedBox(height: 18),
          Text.rich(
            TextSpan(children: [
              const TextSpan(text: 'All '),
              TextSpan(text: 'set', style: const TextStyle(color: AD.primaryBadge)),
            ]),
            textAlign: TextAlign.center,
            style: ADText.appTitle().copyWith(
                fontSize: ZineBreakpoints.heroTextSize(context, regular: 32), height: 1.08),
          ),
          const SizedBox(height: 20),
          _resultRow(PhosphorIcons.phone(PhosphorIconsStyle.bold), AD.iconSearch,
              'Default dialer', _dialerGranted),
          if (_smsGranted != null) ...[
            const SizedBox(height: 12),
            _resultRow(PhosphorIcons.chatCircle(PhosphorIconsStyle.bold), AD.iconVideo,
                'Messages (SMS)', _smsGranted),
          ],
          const SizedBox(height: 12),
          _resultRow(PhosphorIcons.addressBook(PhosphorIconsStyle.bold), AD.online,
              'Contacts', _contactsGranted),
          const SizedBox(height: 28),
          _primary('Continue', () {
            // If the dialer role landed, show the one-screen preview; otherwise
            // advance straight on (the AvaDial banners remain the retry path).
            if (dialerOk) {
              setState(() => _showPhonePreview = true);
            } else {
              _next();
            }
          }),
        ],
      ),
    );
  }

  Widget _resultRow(IconData icon, Color accent, String label, bool? granted) => AdCard(
        radius: Zine.rSm,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Row(children: [
          ZineIconBadge(icon: icon, color: accent),
          const SizedBox(width: 14),
          Expanded(child: Text(label, style: ADText.rowName().copyWith(fontSize: 15))),
          AdSticker(
            granted == true ? 'On' : 'Not now',
            kind: granted == true ? AdStickerKind.ok : AdStickerKind.no,
            icon: granted == true
                ? PhosphorIcons.checkCircle(PhosphorIconsStyle.fill)
                : PhosphorIcons.circle(PhosphorIconsStyle.bold),
          ),
        ]),
      );

  // One-screen "Your new phone experience" preview — static Zine cards pointing at
  // the Dialpad / call screen / Messages (no screenshots). Only shown when the
  // dialer role was granted. A single Continue finishes the step.
  Widget _phonePreview() {
    final hPad = ZineBreakpoints.pagePadding(context);
    return SingleChildScrollView(
      padding: EdgeInsets.fromLTRB(hPad, 8, hPad, 24),
      child: Column(
        children: [
          const SizedBox(height: 12),
          Text.rich(
            TextSpan(children: [
              const TextSpan(text: 'Your new '),
              TextSpan(text: 'phone', style: const TextStyle(color: AD.primaryBadge)),
            ]),
            textAlign: TextAlign.center,
            style: ADText.appTitle().copyWith(
                fontSize: ZineBreakpoints.heroTextSize(context, regular: 30), height: 1.08),
          ),
          const SizedBox(height: 10),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 300),
            child: Text('AvaTOK now handles your calls and texts. Here’s where to find things.',
                textAlign: TextAlign.center, style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 14)),
          ),
          const SizedBox(height: 24),
          _previewCard(PhosphorIcons.phone(PhosphorIconsStyle.bold), AD.iconSearch,
              'Dialpad', 'Call anyone — spam numbers are flagged before they reach you.'),
          const SizedBox(height: 12),
          _previewCard(PhosphorIcons.phoneCall(PhosphorIconsStyle.bold), AD.online,
              'Call screen', 'A clean full-screen call with a friend or spam label up top.'),
          const SizedBox(height: 12),
          _previewCard(PhosphorIcons.chatCircle(PhosphorIconsStyle.bold), AD.iconVideo,
              'Messages', 'Your SMS, sorted by AI into Inbox and Spam.'),
          const SizedBox(height: 28),
          _primary('Continue', _next),
        ],
      ),
    );
  }

  Widget _previewCard(IconData icon, Color accent, String title, String sub) => AdCard(
        radius: Zine.rSm,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          ZineIconBadge(icon: icon, color: accent, size: 42),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: ADText.threadName().copyWith(fontSize: 16)),
              const SizedBox(height: 3),
              Text(sub, style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 12.5)),
            ]),
          ),
        ]),
      );

  Future<void> _skipPhoneRoles() async {
    Analytics.capture('onboarding_phone_roles_result',
        const {'dialer': false, 'sms': false, 'contacts': false, 'skipped': true});
    await _markPhoneRolesOffered();
    _next();
  }

  Future<void> _makePhoneApp() async {
    if (_phoneBusy) return;
    setState(() => _phoneBusy = true);
    // 1) Default dialer role.
    final dialer = await _requestRoleAwait(
      AvaDialChannel.I.requestDialerRole,
      (r) => r.role.contains('DIALER'),
      AvaDialChannel.I.isDialerRoleHeld,
    );
    // 2) Default SMS role — only when the SMS layer is enabled (independent role).
    bool? sms;
    if (RemoteConfig.avaSms) {
      sms = await _requestRoleAwait(
        AvaDialChannel.I.requestSmsRole,
        (r) => r.role.contains('SMS'),
        AvaDialChannel.I.isSmsRoleHeld,
      );
    }
    // 3) Contacts permission — reuse the AvaDial device-contacts helper.
    final contacts = await DeviceContacts.I.ensurePermission();
    if (!mounted) return;
    setState(() {
      _dialerGranted = dialer;
      _smsGranted = sms;
      _contactsGranted = contacts;
      _phoneResolved = true;
      _phoneBusy = false;
    });
    Analytics.capture('onboarding_phone_roles_result', {
      // Analytics maps are non-nullable; null (role flow unavailable) → false.
      'dialer': dialer == true,
      'sms': sms == true,
      'contacts': contacts,
    });
    await _markPhoneRolesOffered();
  }

  /// Request a native role and resolve to whether it ended up held. [request]
  /// returns `true` (already held), `null` (a system prompt showed — the verdict
  /// arrives on [AvaDialChannel.roleResults]) or `false` (platform absent/error).
  /// We await the matching stream verdict, then fall back to a direct held-state
  /// read on timeout so a missed event never leaves the result wrong.
  Future<bool> _requestRoleAwait(
    Future<bool?> Function() request,
    bool Function(AvaRoleResult) matches,
    Future<bool> Function() heldCheck,
  ) async {
    final immediate = await request();
    if (immediate == true) return true;
    // `false` == platform absent / channel error: no system prompt was shown, so
    // there is no verdict coming — read the live held state and return at once
    // (never wait on a stream event that can't arrive).
    if (immediate == false) return await heldCheck();
    // `null` == a system prompt showed → the verdict lands on roleResults. Await
    // it, falling back to a direct held-state read if no event arrives in time.
    try {
      final r = await AvaDialChannel.I.roleResults
          .firstWhere(matches)
          .timeout(const Duration(seconds: 60));
      return r.granted;
    } catch (_) {
      return await heldCheck();
    }
  }

  /// Persist that the phone-roles offer was made for this account so the step is a
  /// one-time thing; the AvaDial in-app banners are the ongoing retry path.
  Future<void> _markPhoneRolesOffered() async {
    try { await DiskCache.write('phone_roles_offered', '1'); } catch (_) {/* best-effort */}
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
  Widget _featureRow(IconData icon, Color accent, String label) => AdCard(
        radius: Zine.rSm,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Row(children: [
          ZineIconBadge(icon: icon, color: accent),
          const SizedBox(width: 14),
          Expanded(child: Text(label, style: ADText.rowName().copyWith(fontSize: 15))),
        ]),
      );

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
