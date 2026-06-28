import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../auth/clerk_client.dart';
import '../core/account_storage.dart';
import '../core/admin_tools.dart';
import '../core/analytics.dart';
import '../core/app_registry.dart';
import '../core/apps.dart';
import '../core/profile_store.dart';
import '../core/ui/zine.dart';
import '../core/ui/zine_widgets.dart';
import '../identity/identity.dart';
import '../features/avaapps/avaapps_screen.dart';
import '../features/ava_companion/companion_home.dart';
import '../features/avachat/voice_call/ai_voice_agent_screen.dart';
import '../features/avalive/avalive_discovery.dart';
import '../features/affiliate/affiliate_home.dart';
import '../features/team/team_home.dart';
import '../features/avavoice/avavoice_home.dart';
import '../features/avavision/avavision_home.dart';
import '../features/avatok/ava_number.dart';
import '../features/avatok/chat_list.dart';
import '../features/avaphone/ava_phone_screen.dart';
import '../features/avatok/invite_screen.dart';
import '../features/avatok/number_settings_screen.dart';
import '../features/ava_backup/backup_service.dart';
import '../features/booking/avabooking_screen.dart';
import '../features/calendar/avacalendar_screen.dart';
import '../features/library/avalibrary_screen.dart';
import '../features/library/avastorage_screen.dart';
import '../features/identity/identity_screen.dart';
import '../features/profile/profile_screen.dart';
import '../features/profile/profile_setup_screen.dart';
import '../features/inbox/inbox_screen.dart';
import '../features/verse/verse_screen.dart';
import '../features/payout/payout_screen.dart';
import '../features/subscribe/subscribe_screen.dart';
import '../features/wallet/wallet_screen.dart';
import '../features/settings/settings_screen.dart';
import 'coming_soon.dart';
import 'focus_mode.dart';

/// The signed-in app shell. Opens on AvaTOK (messaging) as the home surface;
/// other apps are pushed on top and pop back here.
class AvaShell extends StatefulWidget {
  final ClerkClient clerk;
  final VoidCallback onSignOut;
  const AvaShell({super.key, required this.clerk, required this.onSignOut});
  @override
  State<AvaShell> createState() => _AvaShellState();
}

class _AvaShellState extends State<AvaShell> {
  final _idStore = IdentityStore();

  Identity? _id;
  bool? _profileComplete; // null = checking, false = show gate, true = enter app
  // Compulsory AvaTOK number (owner decision 2026-06-27): a complete profile with
  // NO number must choose one before entering the app — applies to new users at
  // onboarding AND existing users without a number on next open.
  bool _needsNumber = false;
  String? _authEmail; // email the user signed in with (Clerk) → shown locked in profile

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final id = await _idStore.load();
    // The signed-in email (from Clerk) — used to prefill + lock the profile's
    // email field and satisfy its required-email validation.
    try { _authEmail = (await widget.clerk.currentUser())?.email; } catch (_) {/* offline */}
    // Warm the per-account focus-mode value so any sidebar drawer paints the
    // correct menu without a default-then-correct flicker.
    await FocusMode.load();
    // Mandatory-profile gate (pic5): every entry into the shell — new users after
    // onboarding AND existing users on next open — must have a complete profile
    // (photo, first+last name, valid email, valid phone) before using the app.
    final store = ProfileStore();
    var complete = (await store.load()).isComplete;
    // Email-OTP recovery on a NEW phone: if the local profile is incomplete (a
    // fresh install), ask the server for this account's saved profile and
    // hydrate it so a returning user skips onboarding. Phone is re-added later
    // via the soft nudge (owner request 2026-06-27).
    if (!complete) {
      try { complete = await store.restoreFromServer(); } catch (_) {/* offline → setup screen */}
    }
    // Compulsory AvaTOK number — now picked BEFORE the profile (owner decision
    // 2026-06-27) so the chosen number can be shown (locked) in the profile's
    // phone field. Computed regardless of profile completeness. Fail-open when
    // offline so a network error never traps a user.
    var needsNumber = false;
    try {
      final me = await AvaNumber.me();
      needsNumber = me.featureOn && !me.hasNumber;
    } catch (_) { needsNumber = false; }
    if (mounted) setState(() { _id = id; _profileComplete = complete; _needsNumber = needsNumber; });
    // Funnel signal: did the user hit the compulsory number gate?
    if (needsNumber) Analytics.capture('number_gate_shown', const {});
    // Daily auto-backup (best-effort, throttled): encrypt local SQLite → R2
    // (premium) or the user's own Google Drive (free). Makes the device + backup
    // the durable copy so the InboxDO can shed old history.
    BackupService.I.maybeAutoBackup();
  }

  /// Switch apps from within the home app (AvaTOK): return to the home surface,
  /// then open the requested destination on top.
  void _switchFromChild(String dest) {
    Navigator.of(context).popUntil((r) => r.isFirst);
    if (dest == 'explore') return; // marketplace de-emphasised this release
    WidgetsBinding.instance.addPostFrameCallback((_) => _openDest(dest));
  }

  void _openDest(String dest) {
    // Where users go after signing in / which features they use most.
    Analytics.capture('feature_opened', {'dest': dest});
    switch (dest) {
      case 'explore':
        return; // marketplace de-emphasised for the free messaging release
      case 'settings':
        // Reload on return — the preview switcher may have changed the account kind.
        _push(SettingsScreen(clerk: widget.clerk, onSignOut: widget.onSignOut, identity: _id))
            .then((_) => _load());
        return;
      case 'avatok':
        _push(ChatListScreen(clerk: widget.clerk, onSignOut: widget.onSignOut, onSwitchApp: _switchFromChild));
        return;
      case 'avaphone':
      case 'phone':
      case 'dialer':
        _push(const AvaPhoneScreen()); // PSTN-style dialer over AvaTOK-to-AvaTOK calling
        return;
      case 'avalive':
        _push(const AvaLiveDiscovery());
        return;
      case 'avavoice':
        _push(const AvaVoiceHome());
        return;
      case 'avavision':
        _push(const AvaVisionHome());
        return;
      case 'avaaffiliate':
      case 'affiliate':
        _push(const AffiliateHomeScreen());
        return;
      case 'verse':
        _push(const VerseScreen());
        return;
      case 'inbox':
      case 'avainbox':
        _push(const InboxScreen());
        return;
      case 'library':
      case 'avalibrary':
        _push(const AvaLibraryScreen());
        return;
      case 'avaapps':
      case 'apps':
        _push(const AvaAppsScreen());
        return;
      case 'avachat':
        _push(const CompanionHome()); // talk privately with Ava
        return;
      case 'aivoice':
        _push(const AiVoiceAgentScreen()); // hands-free Gemini Live call
        return;
      case 'avastorage':
      case 'storage':
        _push(const AvaStorageScreen());
        return;
      case 'profile':
        // The "View profile" row opens the proper profile editor directly
        // (photo + crop, name, email/OTP, password, about-you for AvaBrain).
        // The trust-ladder hub now lives under 'identity' in ACCOUNT & SETTINGS.
        _push(const ProfileScreen());
        return;
      case 'wallet':
      case 'avawallet':
        _push(const WalletScreen());
        return;
      case 'calendar':
      case 'avacalendar':
        _push(const AvaCalendarScreen());
        return;
      case 'booking':
      case 'avabooking':
        _push(const AvaBookingScreen());
        return;
      case 'payout':
      case 'avapayout':
        _push(const PayoutScreen());
        return;
      case 'identity':
      case 'avaidentity':
        _push(const IdentityScreen());
        return;
      case 'invite':
        _push(const InviteScreen());
        return;
      case 'team':
        _push(const TeamHomeScreen());
        return;
      case 'subscribe':
        _push(const SubscribeScreen());
        return;
      case 'billing':
        _push(ComingSoon(
            title: dest[0].toUpperCase() + dest.substring(1),
            subtitle: 'Coming soon',
            icon: PhosphorIcons.lightning(PhosphorIconsStyle.fill),
            color: Zine.blue));
        return;
      default:
        // Parent/Enterprise management tools (dummy → coming soon for now).
        final tool = adminToolByKey(dest);
        if (tool != null) {
          _push(ComingSoon(title: tool.name, subtitle: tool.tagline, icon: tool.icon, color: tool.color));
          return;
        }
        // App registry (standard or hidden) → branded ComingSoon until its
        // phase ships; legacy kApps keys fall through to the same screen.
        if (AppRegistry.byId(dest) != null) {
          _push(ComingSoon.forApp(dest));
          return;
        }
        final a = appByKey(dest);
        _push(ComingSoon(title: a.name, subtitle: a.tagline, icon: a.icon, color: a.color));
    }
  }

  /// One-time onboarding offer: if the account has no AvaTOK number yet and can
  /// still generate one (free accounts get one; paid unlimited), invite the user
  /// to pick it now. Skippable — they can always do it later in Settings → Your
  /// number. The offer is shown once per account (scoped flag).
  Future<void> _maybeOfferNumber() async {
    const ss = FlutterSecureStorage();
    const flag = 'onboarding_number_offered_v1';
    try { if (await readScoped(ss, flag) == '1') return; } catch (_) {}
    MyNumber me;
    try { me = await AvaNumber.me(); } catch (_) { return; } // offline → try again next open
    if (!mounted) return;
    // Mark offered now (one-time), regardless of choice — never nag again.
    try { await ss.write(key: scopedKey(flag), value: '1'); } catch (_) {}
    if (!me.featureOn || me.hasNumber || !me.canGenerate) return;
    final go = await showModalBottomSheet<bool>(
      context: context,
      backgroundColor: Zine.paper,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            ZineIconBadge(icon: PhosphorIcons.hash(PhosphorIconsStyle.bold), color: Zine.lime, size: 36),
            const SizedBox(width: 12),
            Expanded(child: Text('Get your AvaTOK number', style: ZineText.cardTitle(size: 18))),
          ]),
          const SizedBox(height: 12),
          Text('Pick a free number that represents you on AvaTOK so you can stay in '
              'touch without giving out your real phone — your real number always '
              'stays private. Free accounts get one number; you can choose it now.',
              style: ZineText.sub(size: 13.5)),
          const SizedBox(height: 18),
          ZineButton(label: 'Choose my number', variant: ZineButtonVariant.blue,
              fullWidth: true, fontSize: 16, trailingIcon: false,
              icon: PhosphorIcons.hash(PhosphorIconsStyle.bold),
              onPressed: () => Navigator.pop(ctx, true)),
          const SizedBox(height: 8),
          Center(child: TextButton(onPressed: () => Navigator.pop(ctx, false),
              child: Text('Maybe later', style: ZineText.link(size: 14, color: Zine.inkSoft)))),
        ]),
      )),
    );
    if (go == true && mounted) await _push(const NumberSettingsScreen());
  }

  Future<void> _push(Widget w) => Navigator.push(context, MaterialPageRoute(builder: (_) => w));

  @override
  Widget build(BuildContext context) {
    // Mandatory-profile gate (pic5): block the entire app until the profile is
    // complete. A brief loader while we read the local profile; then either the
    // non-skippable setup screen or the real shell.
    if (_profileComplete == null) {
      return const Scaffold(
        backgroundColor: Zine.paper,
        body: Center(child: CircularProgressIndicator(color: Zine.blueInk)),
      );
    }
    // Compulsory AvaTOK number gate FIRST (owner decision 2026-06-27): the user
    // picks their number before completing the profile, so the profile can show
    // that number (locked) in the phone field. Same gate for new users at
    // onboarding and existing users who never registered a number.
    if (_needsNumber) {
      return NumberSettingsScreen(
        gate: true,
        onSignOut: widget.onSignOut,
        onAssigned: () => setState(() => _needsNumber = false),
      );
    }
    if (_profileComplete == false) {
      return ProfileSetupScreen(
        identity: _id,
        email: _authEmail,
        onSignOut: widget.onSignOut,
        // Re-run the gate after the profile is saved (show the loader meanwhile,
        // no flash to the chat list).
        onDone: () { setState(() { _profileComplete = null; }); _load(); },
      );
    }
    // Messaging-first landing (owner decision 2026-06-18, free release): the app
    // opens directly on AvaTOK (ChatListScreen), where users see their chats &
    // contacts. ChatListScreen carries its own sidebar drawer + bottom nav, so
    // it IS the home surface. Other apps push on top via _switchFromChild and
    // pop back here. (Marketplace/ExploreHome de-emphasised for this release.)
    return ChatListScreen(
      clerk: widget.clerk,
      onSignOut: widget.onSignOut,
      onSwitchApp: _switchFromChild,
    );
  }
}
