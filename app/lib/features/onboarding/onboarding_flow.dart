import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../core/account_restore.dart';
import '../../core/admin_tools.dart';
import '../../core/analytics.dart';
import '../../core/apps.dart';
import '../../core/onboarding_store.dart';
import '../../core/prefs_sync.dart';
import '../../core/profile_store.dart';
import '../../core/theme.dart';
import '../../identity/identity.dart';
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
  static const _steps = 7;
  static const _stepNames = [
    'account_kind', 'notifications', 'terms', 'profile', 'verify_identity', 'contacts', 'apps'
  ];
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
  AccountKind? _selectedKind;

  bool _notifEnabled = false;
  bool _agreedTerms = false;
  late Set<String> _enabled = kApps.where((a) => a.defaultOn).map((a) => a.key).toSet();

  // ---- profile step (handle + display name) ----
  final _handleCtrl = TextEditingController();
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
    _handleCtrl.dispose();
    _nameCtrl.dispose();
    super.dispose();
  }

  Future<void> _bootstrap() async {
    var id = await _idStore.load();
    id ??= await _idStore.createAndStore();
    if (mounted) setState(() => _id = id);
    // Attach this person's whole onboarding journey to their npub.
    Analytics.identify(id.npub);
    Analytics.capture('onboarding_started', const {});
    Analytics.capture('onboarding_step_viewed', {'step_index': 0, 'step_name': _stepNames[0]});
  }

  void _onHandleChanged(String v) {
    _handleDebounce?.cancel();
    setState(() { _handleAvail = null; _handleMsg = null; _checkingHandle = v.trim().isNotEmpty; });
    if (v.trim().isEmpty) { setState(() => _checkingHandle = false); return; }
    _handleDebounce = Timer(const Duration(milliseconds: 400), () async {
      final res = await Directory.checkHandle(_handleCtrl.text, npub: _id?.npub);
      if (!mounted) return;
      setState(() { _checkingHandle = false; _handleAvail = res.ok; _handleMsg = res.message; });
    });
  }

  bool get _profileReady =>
      _nameCtrl.text.trim().isNotEmpty && _handleAvail == true && !_checkingHandle && !_savingProfile;

  Future<void> _saveProfileAndNext() async {
    final id = _id;
    if (id == null || !_profileReady) return;
    setState(() => _savingProfile = true);
    final handle = _handleCtrl.text.trim().toLowerCase().replaceAll('@', '');
    final name = _nameCtrl.text.trim();
    // Persist locally first (merge with any phone captured earlier).
    final existing = await _profileStore.load();
    await _profileStore.save(existing.copyWith(displayName: name, handle: handle));
    // Publish to the directory so the handle + name are immediately searchable.
    // (No key backup anymore — the Clerk sign-in IS the account credential.)
    final r = await Directory.registerProfile(
      npub: id.npub, handle: handle, name: name,
      accountKind: _selectedKind?.wire,
    );
    if (!mounted) return;
    setState(() => _savingProfile = false);
    if (r.ok) { _next(); return; }
    if (r.status == 409) {
      setState(() { _handleAvail = false; _handleMsg = 'That handle was just taken — pick another'; });
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Could not save your handle — check your connection and try again')));
    }
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
      backgroundColor: Colors.white,
      body: SafeArea(
        child: Column(
          children: [
            const SizedBox(height: 12),
            _dots(),
            Expanded(child: _body()),
          ],
        ),
      ),
    );
  }

  Widget _dots() => Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: List.generate(_steps, (i) {
          final on = i == _step;
          return AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            margin: const EdgeInsets.symmetric(horizontal: 3),
            width: on ? 22 : 7, height: 7,
            decoration: BoxDecoration(
                color: on ? AvaColors.brand : AvaColors.line,
                borderRadius: BorderRadius.circular(4)),
          );
        }),
      );

  Widget _body() {
    switch (_step) {
      case 0: return _accountType();
      case 1: return _notifications();
      case 2: return _terms();
      case 3: return _profileStep();
      case 4: return _verifyStep();
      case 5: return _contacts();
      default: return _appsSetup();
    }
  }

  // ---- Step 6: verify identity (age / gender / phone OTP / email OTP) ----
  Widget _verifyStep() => VerifyIdentityStep(
        onComplete: (data) {
          _ageGroup = data.ageGroup;
          _gender = data.gender;
          if (data.phone.isNotEmpty) _profileStore.setPhone(data.phone);
          _next();
        },
      );

  // ---- Step 1: account type — required, drives the sidebar tools ----
  Widget _accountType() {
    return Column(
      children: [
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(28, 12, 28, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _iconTileSmall(Icons.workspace_premium_outlined, AvaColors.brand50, AvaColors.brand),
                const SizedBox(height: 16),
                Text('How will you use AvaTOK?',
                    style: Theme.of(context).textTheme.displayLarge?.copyWith(fontSize: 28)),
                const SizedBox(height: 6),
                const Text(
                    'This sets up your account. Parent and Business accounts unlock extra '
                    'management tools in the sidebar. You can change this later in Settings.',
                    style: TextStyle(color: AvaColors.sub, fontSize: 14, height: 1.5)),
                const SizedBox(height: 22),
                _kindCard(
                  kind: AccountKind.personal,
                  icon: Icons.person_outline,
                  color: AvaColors.brand,
                  title: 'Just me',
                  sub: 'A personal account with all the standard AvaVerse apps.',
                ),
                const SizedBox(height: 12),
                _kindCard(
                  kind: AccountKind.parent,
                  icon: Icons.family_restroom,
                  color: const Color(0xFF7C5CFC),
                  title: 'Parent / family',
                  sub: 'Create and manage accounts for your kids — app controls, '
                      'contact approvals, screen time and safety alerts.',
                ),
                const SizedBox(height: 12),
                _kindCard(
                  kind: AccountKind.enterprise,
                  icon: Icons.apartment,
                  color: const Color(0xFF0A66C2),
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
          child: _primary('Continue', _selectedKind != null ? _next : null),
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
    return GestureDetector(
      onTap: () {
        setState(() => _selectedKind = kind);
        Analytics.capture('onboarding_account_kind_selected', {'account_kind': kind.wire});
      },
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: selected ? color.withValues(alpha: 0.06) : AvaColors.soft,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: selected ? color : Colors.transparent,
            width: 1.6,
          ),
        ),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Container(
            width: 42, height: 42,
            decoration: BoxDecoration(
                color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(12)),
            child: Icon(icon, color: color, size: 22),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
              const SizedBox(height: 4),
              Text(sub, style: const TextStyle(color: AvaColors.sub, fontSize: 12.5, height: 1.4)),
            ]),
          ),
          const SizedBox(width: 8),
          Icon(
            selected ? Icons.radio_button_checked : Icons.radio_button_unchecked,
            color: selected ? color : AvaColors.line,
            size: 22,
          ),
        ]),
      ),
    );
  }

  // ---- Step 4: profile (handle + display name) — required ----
  Widget _profileStep() {
    return Column(
      children: [
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(28, 12, 28, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _iconTileSmall(Icons.alternate_email, AvaColors.brand50, AvaColors.brand),
                const SizedBox(height: 16),
                Text('Claim your handle', style: Theme.of(context).textTheme.displayLarge?.copyWith(fontSize: 30)),
                const SizedBox(height: 6),
                const Text('Your @handle is how people find and tag you. Names repeat — a handle is uniquely yours.',
                    style: TextStyle(color: AvaColors.sub, fontSize: 14, height: 1.5)),
                const SizedBox(height: 24),
                const Text('Display name', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13)),
                const SizedBox(height: 8),
                _field(
                  controller: _nameCtrl,
                  hint: 'e.g. Jordan Rivers',
                  icon: Icons.person_outline,
                  onChanged: (_) => setState(() {}),
                  textCapitalization: TextCapitalization.words,
                ),
                const SizedBox(height: 18),
                const Text('Handle', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13)),
                const SizedBox(height: 8),
                _field(
                  controller: _handleCtrl,
                  hint: 'yourname',
                  icon: Icons.alternate_email,
                  onChanged: _onHandleChanged,
                  inputFormatters: [
                    FilteringTextInputFormatter.allow(RegExp(r'[a-zA-Z0-9_]')),
                    LengthLimitingTextInputFormatter(20),
                  ],
                  trailing: _handleTrailing(),
                ),
                const SizedBox(height: 8),
                if (_handleMsg != null)
                  Text(_handleMsg!, style: TextStyle(
                      color: _handleAvail == true ? AvaColors.success : AvaColors.danger, fontSize: 12.5))
                else if (_handleAvail == true)
                  Text('@${_handleCtrl.text.trim().toLowerCase()} is available',
                      style: const TextStyle(color: AvaColors.success, fontSize: 12.5))
                else
                  const Text('3–20 characters: letters, numbers or _, starting with a letter.',
                      style: TextStyle(color: AvaColors.sub, fontSize: 12.5)),
              ],
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 8, 24, 20),
          child: _primary(
            _savingProfile ? 'Saving…' : 'Continue',
            _profileReady ? _saveProfileAndNext : null,
          ),
        ),
      ],
    );
  }

  Widget? _handleTrailing() {
    if (_checkingHandle) {
      return const SizedBox(width: 18, height: 18,
          child: CircularProgressIndicator(strokeWidth: 2, color: AvaColors.sub));
    }
    if (_handleAvail == true) return const Icon(Icons.check_circle, size: 20, color: AvaColors.success);
    if (_handleAvail == false) return const Icon(Icons.cancel, size: 20, color: AvaColors.danger);
    return null;
  }

  Widget _field({
    required TextEditingController controller,
    required String hint,
    required IconData icon,
    required ValueChanged<String> onChanged,
    Widget? trailing,
    List<TextInputFormatter>? inputFormatters,
    TextCapitalization textCapitalization = TextCapitalization.none,
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14),
      decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(14)),
      child: Row(children: [
        Icon(icon, size: 18, color: const Color(0xFF9AA1AC)),
        const SizedBox(width: 8),
        Expanded(
          child: TextField(
            controller: controller,
            onChanged: onChanged,
            inputFormatters: inputFormatters,
            textCapitalization: textCapitalization,
            decoration: InputDecoration(
                hintText: hint, border: InputBorder.none, isDense: true,
                contentPadding: const EdgeInsets.symmetric(vertical: 14),
                hintStyle: const TextStyle(color: Color(0xFF9AA1AC))),
          ),
        ),
        if (trailing != null) ...[const SizedBox(width: 8), trailing],
      ]),
    );
  }

  // ---- Step 1: notifications ----
  Widget _notifications() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(28, 8, 28, 24),
      child: Column(
        children: [
          const Spacer(flex: 2),
          _iconTile(Icons.notifications_none_rounded, badge: _notifEnabled),
          const SizedBox(height: 22),
          Text('Stay in the loop', style: Theme.of(context).textTheme.displayLarge?.copyWith(fontSize: 32)),
          const SizedBox(height: 12),
          const Text('Get notified when creators you follow post, when you earn a payout, or when someone tips your work.',
              textAlign: TextAlign.center, style: TextStyle(color: AvaColors.sub, fontSize: 14, height: 1.5)),
          const SizedBox(height: 28),
          _featureRow(Icons.favorite_border, 'New followers & tips'),
          const SizedBox(height: 12),
          _featureRow(Icons.account_balance_wallet_outlined, 'Payouts & wallet activity'),
          const SizedBox(height: 12),
          _featureRow(Icons.chat_bubble_outline, 'Replies & mentions'),
          const Spacer(flex: 3),
          if (_notifEnabled)
            _primary('Continue', _next)
          else ...[
            _primary('Allow Notifications', () async {
              await Permission.notification.request();
              setState(() => _notifEnabled = true);
            }, icon: Icons.notifications_none_rounded),
            const SizedBox(height: 8),
            TextButton(onPressed: _next, child: const Text('Not now',
                style: TextStyle(color: AvaColors.sub, fontWeight: FontWeight.w600))),
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
            padding: const EdgeInsets.fromLTRB(28, 12, 28, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Terms & Conditions', style: Theme.of(context).textTheme.displayLarge?.copyWith(fontSize: 30)),
                const SizedBox(height: 4),
                const Text('Please review before continuing', style: TextStyle(color: AvaColors.sub)),
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
          padding: const EdgeInsets.fromLTRB(28, 8, 28, 20),
          decoration: const BoxDecoration(border: Border(top: BorderSide(color: AvaColors.line))),
          child: Column(
            children: [
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                activeColor: AvaColors.brand,
                value: _agreedTerms,
                onChanged: (v) => setState(() => _agreedTerms = v ?? false),
                title: const Text('I have read and agree to the Terms & Conditions', style: TextStyle(fontSize: 14)),
              ),
              _primary('Continue', _agreedTerms ? _next : null),
            ],
          ),
        ),
      ],
    );
  }

  Widget _termSection(String title, String body) => Padding(
        padding: const EdgeInsets.only(bottom: 18),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
          const SizedBox(height: 6),
          Text(body, style: const TextStyle(color: AvaColors.sub, fontSize: 13.5, height: 1.5)),
        ]),
      );

  // ---- Step 5: contacts ----
  Widget _contacts() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(28, 8, 28, 24),
      child: Column(children: [
        const Spacer(flex: 2),
        Container(
          width: 70, height: 44,
          child: Stack(alignment: Alignment.center, children: [
            Positioned(left: 0, child: _dot(const Color(0xFF4F8DFD))),
            Positioned(right: 0, child: _dot(const Color(0xFFC98BF5))),
            _dot(const Color(0xFFFF6F6F), big: true),
          ]),
        ),
        const SizedBox(height: 22),
        Text('Find people you know', style: Theme.of(context).textTheme.displayLarge?.copyWith(fontSize: 28)),
        const SizedBox(height: 12),
        const Text('Upload your contacts to instantly connect with friends already creating on AvaTOK. We never store your contacts.',
            textAlign: TextAlign.center, style: TextStyle(color: AvaColors.sub, fontSize: 14, height: 1.5)),
        const Spacer(flex: 3),
        _primary('Upload Contacts', () async {
          await Permission.contacts.request();
          // TODO: read + upload contacts in background once granted.
          _next();
        }, icon: Icons.upload),
        const SizedBox(height: 8),
        TextButton(onPressed: _next, child: const Text('Skip for now',
            style: TextStyle(color: AvaColors.sub, fontWeight: FontWeight.w600))),
      ]),
    );
  }

  Widget _dot(Color c, {bool big = false}) => Container(
        width: big ? 30 : 24, height: big ? 30 : 24,
        decoration: BoxDecoration(color: c, shape: BoxShape.circle));

  // ---- Step 6: app selection ----
  Widget _appsSetup() {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(28, 12, 28, 4),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Set up your apps', style: Theme.of(context).textTheme.displayLarge?.copyWith(fontSize: 28)),
            const SizedBox(height: 4),
            const Text('Toggle the AvaVerse apps you want. Change these anytime.',
                style: TextStyle(color: AvaColors.sub, fontSize: 14)),
          ]),
        ),
        Expanded(
          child: ListView.separated(
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 8),
            itemCount: kApps.length,
            separatorBuilder: (_, __) => const Divider(height: 1, color: AvaColors.line),
            itemBuilder: (c, i) {
              final a = kApps[i];
              final on = _enabled.contains(a.key);
              return ListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                leading: Container(
                  width: 40, height: 40,
                  decoration: BoxDecoration(color: a.color, borderRadius: BorderRadius.circular(12)),
                  child: Icon(a.icon, color: Colors.white, size: 20)),
                title: Text(a.name, style: const TextStyle(fontWeight: FontWeight.w700)),
                subtitle: Text(a.tagline, style: const TextStyle(color: AvaColors.sub, fontSize: 12)),
                trailing: Switch(
                  value: on, activeColor: Colors.white, activeTrackColor: AvaColors.brand,
                  onChanged: (v) => setState(() => v ? _enabled.add(a.key) : _enabled.remove(a.key)),
                ),
              );
            },
          ),
        ),
        Padding(padding: const EdgeInsets.fromLTRB(20, 4, 20, 20), child: _primary('Done', _finish)),
      ],
    );
  }

  // ---- shared bits ----
  Widget _iconTile(IconData icon, {bool badge = false}) => Stack(clipBehavior: Clip.none, children: [
        Container(width: 96, height: 96,
            decoration: BoxDecoration(color: AvaColors.brand50, borderRadius: BorderRadius.circular(26)),
            child: Icon(icon, color: AvaColors.brand, size: 46)),
        if (badge) Positioned(right: -4, top: -4, child: Container(
            width: 26, height: 26,
            decoration: BoxDecoration(color: AvaColors.success, shape: BoxShape.circle,
                border: Border.all(color: Colors.white, width: 2)),
            child: const Icon(Icons.check, color: Colors.white, size: 15))),
      ]);

  Widget _iconTileSmall(IconData icon, Color bg, Color fg) => Container(
      width: 56, height: 56, decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(16)),
      child: Icon(icon, color: fg, size: 26));

  Widget _featureRow(IconData icon, String label) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
        decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(16)),
        child: Row(children: [
          Icon(icon, color: AvaColors.brand, size: 22),
          const SizedBox(width: 14),
          Text(label, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
        ]),
      );

  Widget _primary(String text, VoidCallback? onTap, {IconData? icon}) => SizedBox(
        width: double.infinity,
        child: FilledButton.icon(
          onPressed: onTap,
          icon: icon != null ? Icon(icon, size: 20) : const SizedBox.shrink(),
          label: Text(text),
        ),
      );
}
