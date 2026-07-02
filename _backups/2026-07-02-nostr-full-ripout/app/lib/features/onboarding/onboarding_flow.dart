import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/account_restore.dart';
import '../../core/admin_tools.dart';
import '../../core/verification_api.dart';
import '../../core/analytics.dart';
import '../../core/app_registry.dart';
import '../../core/apps.dart';
import '../../core/feature_flags.dart';
import '../../core/guest_session.dart';
import '../../core/onboarding_store.dart';
import '../../core/prefs_sync.dart';
import '../../core/profile_store.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../identity/identity.dart';
import '../ava_ai/ava_ai_setup.dart';
import '../avatok/contacts.dart';
import 'verify_identity_step.dart';

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
  static List<String> _composeSteps() => <String>['terms', 'notifications'];
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
  // Account-keyed: this account already verified a phone (reinstall / new device).
  // When true the verify_identity step auto-advances so we never re-send an OTP.
  bool _phoneAlreadyVerified = false;

  Future<void> _bootstrap() async {
    var id = await _idStore.load();
    id ??= await _idStore.createAndStore();
    if (mounted) setState(() => _id = id);
    // Skip phone OTP if this account already verified one (no wasted SMS on reinstall).
    VerificationApi.isPhoneVerified().then((v) {
      if (v && mounted) setState(() => _phoneAlreadyVerified = true);
    });
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
    // Attach this person's whole onboarding journey to their npub.
    Analytics.identify(id.npub);
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
      final res = await Directory.checkHandle(_handleCtrl.text, npub: _id?.npub);
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
      npub: id.npub, name: name, firstName: first, lastName: last, email: email,
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
      Analytics.identify(id.npub, properties: {
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
    return Scaffold(
      body: ZinePaper(
        child: SafeArea(
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 12, 24, 4),
                child: Row(mainAxisAlignment: MainAxisAlignment.end, children: [
                  ZineStepPips(total: _steps, active: _step + 1),
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
      case 'terms': return _terms();
      case 'profile': return _profileStep();
      case 'verify_identity': return _verifyStep();
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

  // ---- Step: verify identity (age / gender / OPTIONAL phone OTP) ----
  // Phone verification is skippable (2026-06-19). Auto-advances if the account
  // already verified a phone (reinstall / new device) so we never re-send an OTP.
  Widget _verifyStep() {
    if (_phoneAlreadyVerified) {
      WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted) _next(); });
      return const Center(child: CircularProgressIndicator());
    }
    return VerifyIdentityStep(
      onComplete: (data) {
        _ageGroup = data.ageGroup;
        _gender = data.gender;
        if (data.phone.isNotEmpty) _profileStore.setPhone(data.phone);
        _next();
      },
    );
  }

  // ---- Step 1: account type — required, drives the sidebar tools ----
  Widget _accountType() {
    return Column(
      children: [
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(24, 12, 24, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ZineIconBadge(
                    icon: PhosphorIcons.crownSimple(PhosphorIconsStyle.fill),
                    color: Zine.blue, size: 44),
                const SizedBox(height: 16),
                ZineMarkTitle(
                    pre: 'How will you ', mark: 'use', post: ' AvaTOK?',
                    fontSize: 28, textAlign: TextAlign.left),
                const SizedBox(height: 8),
                Text(
                    'This sets up your account. Parent and Business accounts unlock extra '
                    'management tools in the sidebar. You can change this later in Settings.',
                    style: ZineText.sub(size: 14.5)),
                const SizedBox(height: 22),
                _kindCard(
                  kind: AccountKind.personal,
                  icon: PhosphorIcons.user(PhosphorIconsStyle.bold),
                  color: Zine.blue,
                  title: 'Just me',
                  sub: 'A personal account with all the standard AvaVerse apps.',
                ),
                const SizedBox(height: 14),
                _kindCard(
                  kind: AccountKind.parent,
                  icon: PhosphorIcons.usersThree(PhosphorIconsStyle.bold),
                  color: Zine.lilac,
                  title: 'Parent / family',
                  sub: 'Create and manage accounts for your kids — app controls, '
                      'contact approvals, screen time and safety alerts.',
                ),
                const SizedBox(height: 14),
                _kindCard(
                  kind: AccountKind.enterprise,
                  icon: PhosphorIcons.buildings(PhosphorIconsStyle.bold),
                  color: Zine.mint,
                  title: 'Business / enterprise',
                  sub: 'Provision accounts for your team — employees, teams & roles, '
                      'app grants, billing and an audit log.',
                ),
              ],
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 8, 24, 20),
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
      color: selected ? Zine.lime : Zine.card,
      radius: BorderRadius.circular(Zine.rSm),
      boxShadow: selected ? Zine.shadowSm : Zine.shadowXs,
      padding: const EdgeInsets.all(14),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        ZineIconBadge(icon: icon, color: color, size: 42),
        const SizedBox(width: 14),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ZineText.cardTitle(size: 18)),
            const SizedBox(height: 4),
            Text(sub, style: ZineText.sub(size: 12.5)),
          ]),
        ),
        const SizedBox(width: 8),
        PhosphorIcon(
          selected
              ? PhosphorIcons.checkCircle(PhosphorIconsStyle.fill)
              : PhosphorIcons.circle(PhosphorIconsStyle.bold),
          color: selected ? Zine.ink : Zine.inkMute,
          size: 22,
        ),
      ]),
    );
  }

  // ---- Step 4: profile (handle + display name) — required ----
  Widget _profileStep() {
    return Column(
      children: [
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(24, 12, 24, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ZineIconBadge(
                    icon: PhosphorIcons.user(PhosphorIconsStyle.bold),
                    color: Zine.lime, size: 44),
                const SizedBox(height: 16),
                ZineMarkTitle(
                    pre: 'Your ', mark: 'name',
                    fontSize: 30, textAlign: TextAlign.left),
                const SizedBox(height: 8),
                Text('This is how you’ll appear to people you message. You can set a private AvaTOK number later in Settings.',
                    style: ZineText.sub(size: 14.5)),
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
          padding: const EdgeInsets.fromLTRB(24, 8, 24, 20),
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
      return ZineSticker(
        _handleMsg!,
        kind: _handleAvail == true ? ZineStickerKind.ok : ZineStickerKind.no,
        icon: _handleAvail == true
            ? PhosphorIcons.checkCircle(PhosphorIconsStyle.fill)
            : PhosphorIcons.xCircle(PhosphorIconsStyle.fill),
      );
    }
    if (_handleAvail == true) {
      return ZineSticker(
        '@${_handleCtrl.text.trim().toLowerCase()} is available',
        kind: ZineStickerKind.ok,
        icon: PhosphorIcons.checkCircle(PhosphorIconsStyle.fill),
      );
    }
    return ZineSticker(
      '3–20 letters, numbers or _',
      kind: ZineStickerKind.hint,
      icon: PhosphorIcons.pencilSimple(PhosphorIconsStyle.fill),
    );
  }

  Widget? _handleTrailing() {
    if (_checkingHandle) {
      return const SizedBox(width: 18, height: 18,
          child: CircularProgressIndicator(strokeWidth: 2.4, color: Zine.blueInk));
    }
    if (_handleAvail == true) {
      return PhosphorIcon(PhosphorIcons.checkCircle(PhosphorIconsStyle.fill),
          size: 20, color: Zine.mintInk);
    }
    if (_handleAvail == false) {
      return PhosphorIcon(PhosphorIcons.xCircle(PhosphorIconsStyle.fill),
          size: 20, color: Zine.coral);
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
        Text(label.toUpperCase(), style: ZineText.kicker()),
        const SizedBox(height: 9),
      ],
      Container(
        decoration: BoxDecoration(
          color: Zine.card,
          borderRadius: BorderRadius.circular(Zine.rField),
          border: Zine.border,
          boxShadow: error ? Zine.shadowError : Zine.shadowSm,
        ),
        clipBehavior: Clip.antiAlias,
        child: Row(children: [
          if (hasLead)
            Container(
              width: 50,
              constraints: const BoxConstraints(minHeight: 56),
              decoration: const BoxDecoration(
                color: Zine.lime,
                border: Border(right: BorderSide(color: Zine.ink, width: Zine.bw)),
              ),
              alignment: Alignment.center,
              child: leadText != null
                  ? Text(leadText,
                      style: const TextStyle(
                          fontFamily: ZineText.display, fontWeight: FontWeight.w600,
                          fontSize: 24, color: Zine.ink))
                  : Icon(leadIcon, size: 22, color: Zine.ink),
            ),
          Expanded(
            child: TextField(
              controller: controller,
              onChanged: onChanged,
              inputFormatters: inputFormatters,
              textCapitalization: textCapitalization,
              cursorColor: Zine.blueInk,
              style: ZineText.input(),
              decoration: InputDecoration(
                hintText: hint,
                hintStyle: ZineText.input()
                    .copyWith(color: Zine.placeholder, fontWeight: FontWeight.w700),
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
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
      child: Column(
        children: [
          const Spacer(flex: 2),
          ZineCrest(
            child: PhosphorIcon(
                _notifEnabled
                    ? PhosphorIcons.bellRinging(PhosphorIconsStyle.fill)
                    : PhosphorIcons.bell(PhosphorIconsStyle.bold),
                size: 46, color: Zine.ink),
          ),
          const SizedBox(height: 18),
          const ZineMarkTitle(pre: 'Stay in the ', mark: 'loop', fontSize: 32),
          const SizedBox(height: 12),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 300),
            child: Text(
                'Get notified when creators you follow post, when you earn a payout, or when someone tips your work.',
                textAlign: TextAlign.center, style: ZineText.sub(size: 14.5)),
          ),
          const SizedBox(height: 28),
          _featureRow(PhosphorIcons.heart(PhosphorIconsStyle.bold), Zine.coral, 'New followers & tips'),
          const SizedBox(height: 12),
          _featureRow(PhosphorIcons.wallet(PhosphorIconsStyle.bold), Zine.mint, 'Payouts & wallet activity'),
          const SizedBox(height: 12),
          _featureRow(PhosphorIcons.chatCircle(PhosphorIconsStyle.bold), Zine.blue, 'Replies & mentions'),
          const Spacer(flex: 3),
          if (_notifEnabled)
            _primary('Keep going', _next)
          else ...[
            _primary('Turn on notifications', () async {
              await Permission.notification.request();
              setState(() => _notifEnabled = true);
            }, icon: PhosphorIcons.bell(PhosphorIconsStyle.bold)),
            const SizedBox(height: 14),
            ZineLink('not now', fontSize: 14, onTap: _next),
          ],
        ],
      ),
    );
  }

  // ---- Step 2: terms ----
  Widget _terms() {
    const para = 'AvaTOK is your account for the whole AvaVerse — calls, chat, '
        'social, marketplace and storage in one place. Your account, profile and '
        'settings stay in sync on every device you sign in to.';
    return Column(
      children: [
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(24, 12, 24, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ZineMarkTitle(
                    pre: 'Terms & ', mark: 'Conditions',
                    fontSize: 30, textAlign: TextAlign.left),
                const SizedBox(height: 6),
                Text('PLEASE REVIEW BEFORE CONTINUING', style: ZineText.kicker()),
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
          padding: const EdgeInsets.fromLTRB(24, 14, 24, 20),
          decoration: const BoxDecoration(
            color: Zine.paper2,
            border: Border(top: BorderSide(color: Zine.ink, width: Zine.bw)),
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
                      color: _agreedTerms ? Zine.lime : Zine.card,
                      borderRadius: BorderRadius.circular(8),
                      border: Zine.border,
                      boxShadow: _agreedTerms ? Zine.shadowXs : null,
                    ),
                    child: _agreedTerms
                        ? PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold),
                            size: 15, color: Zine.ink)
                        : null,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text('I have read and agree to the Terms & Conditions',
                        style: ZineText.value(size: 14)),
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
          Text(title, style: ZineText.cardTitle(size: 17)),
          const SizedBox(height: 6),
          Text(body, style: ZineText.sub(size: 13.5)),
        ]),
      );

  // ---- Step 5: contacts ----
  Widget _contacts() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
      child: Column(children: [
        const Spacer(flex: 2),
        SizedBox(
          width: 74, height: 46,
          child: Stack(alignment: Alignment.center, children: [
            Positioned(left: 0, child: _dot(Zine.blue)),
            Positioned(right: 0, child: _dot(Zine.lilac)),
            _dot(Zine.coral, big: true),
          ]),
        ),
        const SizedBox(height: 22),
        const ZineMarkTitle(pre: 'Find people you ', mark: 'know', fontSize: 28),
        const SizedBox(height: 12),
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 300),
          child: Text(
              'Upload your contacts to instantly connect with friends already creating on AvaTOK. We never store your contacts.',
              textAlign: TextAlign.center, style: ZineText.sub(size: 14.5)),
        ),
        const Spacer(flex: 3),
        _primary('Find my people', () async {
          await Permission.contacts.request();
          // TODO: read + upload contacts in background once granted.
          _next();
        }, icon: PhosphorIcons.uploadSimple(PhosphorIconsStyle.bold)),
        const SizedBox(height: 14),
        ZineLink('skip for now', fontSize: 14, onTap: _next),
      ]),
    );
  }

  Widget _dot(Color c, {bool big = false}) => Container(
        width: big ? 30 : 24, height: big ? 30 : 24,
        decoration: BoxDecoration(
          color: c,
          shape: BoxShape.circle,
          border: Border.all(color: Zine.ink, width: 2),
        ),
      );

  // ---- Step 6: app selection (standard-tier apps only) ----
  late final List<AppDef> _offeredApps =
      kApps.where((a) => AppRegistry.isStandard(a.key)).toList();

  Widget _appsSetup() {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 12, 24, 4),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            ZineMarkTitle(
                pre: 'Set up your ', mark: 'apps',
                fontSize: 28, textAlign: TextAlign.left),
            const SizedBox(height: 6),
            Text('Toggle the AvaVerse apps you want. Change these anytime.',
                style: ZineText.sub(size: 14)),
          ]),
        ),
        Expanded(
          child: ListView.separated(
            padding: const EdgeInsets.fromLTRB(24, 12, 24, 8),
            itemCount: _offeredApps.length,
            separatorBuilder: (_, __) => const SizedBox(height: 12),
            itemBuilder: (c, i) {
              final a = _offeredApps[i];
              final on = _enabled.contains(a.key);
              return ZineCard(
                radius: Zine.rSm,
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                boxShadow: on ? Zine.shadowSm : Zine.shadowXs,
                child: Row(children: [
                  ZineIconBadge(icon: a.icon, color: Zine.accents[i % Zine.accents.length], size: 40),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(a.name, style: ZineText.cardTitle(size: 16)),
                      const SizedBox(height: 2),
                      Text(a.tagline, maxLines: 1, overflow: TextOverflow.ellipsis,
                          style: ZineText.sub(size: 12)),
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
            padding: const EdgeInsets.fromLTRB(24, 4, 24, 20),
            child: _primary("Let's go", _finish)),
      ],
    );
  }

  // ---- shared bits ----
  Widget _featureRow(IconData icon, Color accent, String label) => ZineCard(
        radius: Zine.rSm,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        boxShadow: Zine.shadowXs,
        child: Row(children: [
          ZineIconBadge(icon: icon, color: accent),
          const SizedBox(width: 14),
          Expanded(child: Text(label, style: ZineText.value(size: 15))),
        ]),
      );

  Widget _primary(String text, VoidCallback? onTap, {IconData? icon, bool loading = false}) =>
      ZineButton(
        label: text,
        onPressed: onTap,
        fullWidth: true,
        fontSize: 21,
        loading: loading,
        icon: icon ?? PhosphorIcons.arrowRight(PhosphorIconsStyle.bold),
        trailingIcon: icon == null,
      );
}
